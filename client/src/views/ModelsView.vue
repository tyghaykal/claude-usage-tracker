<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { api } from '../api';
import { useConfirmDialog } from '../composables/useConfirmDialog';
import { formatDateTime, formatRate } from '../format';
import { useAuthStore } from '../stores/auth';
import type {
  AiProviderView,
  AiSearchResponse,
  ModelPricingView,
  ModelsListResponse,
  ProviderPricingView,
} from '../types';

const auth = useAuthStore();
const { confirm } = useConfirmDialog();

const tab = ref<'pricing' | 'providers'>('pricing');

const models = ref<ModelPricingView[]>([]);
const catalog = ref<string[]>([]);
const providers = ref<AiProviderView[]>([]);
const error = ref('');
const notice = ref('');

/** Providers seen on ingested logs, and whether pricing is disabled for each. */
const logProviders = ref<ProviderPricingView[]>([]);
const logProviderBusy = ref<string | null>(null);
const logProviderError = ref('');

async function loadLogProviders() {
  const data = await api<{ providers: ProviderPricingView[] }>('/provider-pricing');
  logProviders.value = data.providers;
}

async function toggleLogProviderPricing(p: ProviderPricingView) {
  logProviderError.value = '';
  logProviderBusy.value = p.provider;
  try {
    await api(`/provider-pricing/${encodeURIComponent(p.provider)}`, {
      method: 'PATCH',
      body: { pricingDisabled: !p.pricingDisabled },
    });
    await loadLogProviders();
  } catch (err) {
    logProviderError.value = err instanceof Error ? err.message : 'Could not update provider';
  } finally {
    logProviderBusy.value = null;
  }
}

const blank = () => ({
  modelId: '',
  inputPerMTok: 0,
  cacheWritePerMTok: 0,
  cacheReadPerMTok: 0,
  outputPerMTok: 0,
  currency: 'USD',
  source: 'manual' as 'manual' | 'ai',
});

const form = reactive(blank());
const editingId = ref<string | null>(null);

/** FR-11 preview state — held here, never persisted until the admin saves. */
const search = reactive({ providerId: '', busy: false, result: null as AiSearchResponse | null });

const refreshBusy = ref(false);

async function refreshFromOpenRouter() {
  error.value = '';
  notice.value = '';
  refreshBusy.value = true;
  try {
    const res = await api<{ checked: number; updated: number; unmatched: number }>(
      '/models/refresh-openrouter',
      { method: 'POST' },
    );
    notice.value =
      `Updated ${res.updated} of ${res.checked} model(s) from OpenRouter.` +
      (res.unmatched ? ` ${res.unmatched} had no unambiguous OpenRouter match.` : '');
    await load();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not refresh pricing from OpenRouter';
  } finally {
    refreshBusy.value = false;
  }
}

async function load() {
  const data = await api<ModelsListResponse>('/models');
  models.value = data.models;
  catalog.value = data.catalog ?? [];
  if (auth.isAdmin) {
    providers.value = (
      await api<{ providers: AiProviderView[] }>('/ai-providers').catch(() => ({ providers: [] }))
    ).providers;
    search.providerId = providers.value[0]?.id ?? '';
  }
  await loadLogProviders();
}
onMounted(load);

function reset() {
  Object.assign(form, blank());
  editingId.value = null;
  search.result = null;
}

function isUnpriced(model: ModelPricingView): boolean {
  return (
    model.inputPerMTok === 0 &&
    model.cacheWritePerMTok === 0 &&
    model.cacheReadPerMTok === 0 &&
    model.outputPerMTok === 0
  );
}

function edit(model: ModelPricingView) {
  Object.assign(form, {
    modelId: model.modelId,
    inputPerMTok: model.inputPerMTok,
    cacheWritePerMTok: model.cacheWritePerMTok,
    cacheReadPerMTok: model.cacheReadPerMTok,
    outputPerMTok: model.outputPerMTok,
    currency: model.currency,
    source: model.source,
  });
  editingId.value = model.id;
  search.result = null;
}

async function save() {
  error.value = '';
  notice.value = '';
  const { modelId, ...rates } = form;
  try {
    if (editingId.value) {
      await api(`/models/${editingId.value}`, { method: 'PATCH', body: rates });
      notice.value = `Updated pricing for ${modelId}.`;
    } else {
      // Boot-seeded catalog rows already exist at zero rates; saving rates for
      // one of those names is an update, not a create (which would 409).
      const existing = models.value.find((row) => row.modelId === modelId);
      if (existing) {
        await api(`/models/${existing.id}`, { method: 'PATCH', body: rates });
        notice.value = `Updated pricing for ${modelId}.`;
      } else {
        await api('/models', { method: 'POST', body: form });
        notice.value = `Saved pricing for ${modelId}.`;
      }
    }
    reset();
    await load();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not save pricing';
  }
}

async function remove(model: ModelPricingView) {
  if (!(await confirm(`Delete pricing for ${model.modelId}?`, { danger: true }))) return;
  await api(`/models/${model.id}`, { method: 'DELETE' });
  await load();
}

/**
 * Runs the AI lookup and fills the form with what came back. Nothing is stored
 * until the admin presses Save — this only pre-fills the same fields they
 * would otherwise have typed by hand.
 */
async function runAiSearch(refresh = false) {
  if (!form.modelId || !search.providerId) {
    error.value = 'Enter a model id and pick a provider first.';
    return;
  }
  search.busy = true;
  error.value = '';
  try {
    search.result = await api<AiSearchResponse>('/models/ai-search', {
      method: 'POST',
      body: { modelId: form.modelId, providerId: search.providerId, refresh },
    });
    Object.assign(form, search.result.suggested, { source: 'ai' });
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'AI lookup failed';
  } finally {
    search.busy = false;
  }
}
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 class="text-xl font-semibold">Model pricing</h1>
        <p v-if="tab === 'pricing'" class="text-sm text-stone-500 dark:text-stone-400">
          Default names come from the Amanai chat catalog (prefix stripped so they match
          what the plugin reports). Pick one below or type a custom id such as
          <code class="rounded bg-stone-100 px-1 dark:bg-stone-800">9r/claude-sonnet-5</code>. Saving new rates never
          rewrites past records; use <strong>Recalculate</strong> on the usage log for that.
        </p>
        <p v-else class="text-sm text-stone-500 dark:text-stone-400">
          Providers reported by the plugin's <code class="rounded bg-stone-100 px-1 dark:bg-stone-800">provider</code>
          field. Disabling pricing here skips the cost estimate for new prompts from that
          provider — token counts are still recorded exactly.
        </p>
      </div>
      <button
        v-if="tab === 'pricing' && auth.isAdmin"
        class="btn-secondary shrink-0"
        :disabled="refreshBusy"
        @click="refreshFromOpenRouter"
      >
        {{ refreshBusy ? 'Updating…' : 'Update all from OpenRouter' }}
      </button>
    </div>

    <div class="flex gap-4 border-b border-stone-200 dark:border-stone-700">
      <button
        class="-mb-px border-b-2 px-1 py-2 text-sm font-medium"
        :class="tab === 'pricing' ? 'border-blue-600 text-blue-700 dark:text-blue-400' : 'border-transparent text-stone-500 dark:text-stone-400'"
        @click="tab = 'pricing'"
      >
        Pricing
      </button>
      <button
        class="-mb-px border-b-2 px-1 py-2 text-sm font-medium"
        :class="tab === 'providers' ? 'border-blue-600 text-blue-700 dark:text-blue-400' : 'border-transparent text-stone-500 dark:text-stone-400'"
        @click="tab = 'providers'"
      >
        Providers
      </button>
    </div>

    <template v-if="tab === 'pricing'">
    <p v-if="error" class="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">{{ error }}</p>
    <p v-if="notice" class="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
      {{ notice }}
    </p>

    <form v-if="auth.isAdmin" class="card space-y-4" @submit.prevent="save">
      <h2 class="text-sm font-semibold">
        {{ editingId ? 'Edit pricing' : 'Add pricing' }}
      </h2>

      <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
        <div class="lg:col-span-2">
          <label class="label" for="modelId">Model id</label>
          <input
            id="modelId"
            v-model="form.modelId"
            class="input"
            required
            list="model-catalog"
            :disabled="editingId !== null"
            placeholder="claude-sonnet-5"
          />
          <datalist id="model-catalog">
            <option v-for="id in catalog" :key="id" :value="id" />
          </datalist>
        </div>
        <div>
          <label class="label" for="input">Input /MTok</label>
          <input id="input" v-model.number="form.inputPerMTok" class="input" type="number" step="any" min="0" required />
        </div>
        <div>
          <label class="label" for="cacheRead">Cache read /MTok</label>
          <input id="cacheRead" v-model.number="form.cacheReadPerMTok" class="input" type="number" step="any" min="0" required />
        </div>
        <div>
          <label class="label" for="cacheWrite">Cache write /MTok</label>
          <input id="cacheWrite" v-model.number="form.cacheWritePerMTok" class="input" type="number" step="any" min="0" required />
        </div>
        <div>
          <label class="label" for="output">Output /MTok</label>
          <input id="output" v-model.number="form.outputPerMTok" class="input" type="number" step="any" min="0" required />
        </div>
        <div>
          <label class="label" for="currency">Currency</label>
          <input id="currency" v-model="form.currency" class="input" required />
        </div>
      </div>

      <!-- FR-11: admin-only AI assist, sitting alongside manual entry. -->
      <div v-if="auth.isAdmin" class="rounded-md border border-stone-200 bg-stone-50 p-3 dark:border-stone-700 dark:bg-stone-700">
        <div class="flex flex-wrap items-end gap-3">
          <div class="min-w-48">
            <label class="label" for="provider">Look up pricing with AI</label>
            <select id="provider" v-model="search.providerId" class="input">
              <option value="">Select a provider…</option>
              <option v-for="p in providers" :key="p.id" :value="p.id">{{ p.label }}</option>
            </select>
          </div>
          <button
            class="btn-secondary"
            type="button"
            :disabled="search.busy || !search.providerId"
            @click="runAiSearch(false)"
          >
            {{ search.busy ? 'Searching…' : 'Search' }}
          </button>
          <button
            v-if="search.result"
            class="btn-secondary"
            type="button"
            :disabled="search.busy"
            @click="runAiSearch(true)"
          >
            Re-check (skip cache)
          </button>
          <RouterLink
            v-if="providers.length === 0"
            :to="{ name: 'ai-providers' }"
            class="text-sm text-blue-700 underline dark:text-blue-400"
          >
            Add a provider first
          </RouterLink>
        </div>

        <div v-if="search.result" class="mt-3 space-y-2">
          <p class="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-300">
            {{ search.result.disclaimer }}
            <span v-if="search.result.fromCache"> (cached result)</span>
          </p>
          <p v-if="search.result.suggested.notes" class="text-sm text-stone-600 dark:text-stone-400">
            Model notes: {{ search.result.suggested.notes }}
          </p>
          <p class="text-sm text-stone-600 dark:text-stone-400">
            The fields above are pre-filled with this suggestion. Review, edit if needed, then
            save — nothing has been stored yet.
          </p>
          <details class="text-xs text-stone-500 dark:text-stone-400">
            <summary class="cursor-pointer">Raw provider reply</summary>
            <pre class="mt-1 overflow-auto rounded bg-white p-2 dark:bg-stone-950">{{ search.result.raw }}</pre>
          </details>
        </div>
      </div>

      <div class="flex gap-2">
        <button class="btn-primary" type="submit">
          {{ editingId ? 'Save changes' : 'Save pricing' }}
        </button>
        <button v-if="editingId || search.result" class="btn-secondary" type="button" @click="reset">
          Cancel
        </button>
      </div>
    </form>

    <div class="card overflow-x-auto p-0">
      <table class="min-w-full divide-y divide-stone-200 dark:divide-stone-700">
        <thead class="bg-stone-50 dark:bg-stone-700">
          <tr>
            <th class="th">Model</th>
            <th class="th text-right">Input</th>
            <th class="th text-right">Cache read</th>
            <th class="th text-right">Cache write</th>
            <th class="th text-right">Output</th>
            <th class="th">Source</th>
            <th class="th">Updated</th>
            <th v-if="auth.isAdmin" class="th"></th>
          </tr>
        </thead>
        <tbody class="divide-y divide-stone-100 dark:divide-stone-700">
          <tr v-if="models.length === 0">
            <td class="td text-center text-stone-500 dark:text-stone-400" :colspan="auth.isAdmin ? 8 : 7">
              No pricing configured. Prompts still record exact token counts; only the cost
              estimate is left blank.
            </td>
          </tr>
          <tr v-for="m in models" :key="m.id">
            <td class="td font-medium">{{ m.modelId }}</td>
            <td class="td text-right">{{ isUnpriced(m) ? '—' : formatRate(m.inputPerMTok, m.currency) }}</td>
            <td class="td text-right">{{ isUnpriced(m) ? '—' : formatRate(m.cacheReadPerMTok, m.currency) }}</td>
            <td class="td text-right">{{ isUnpriced(m) ? '—' : formatRate(m.cacheWritePerMTok, m.currency) }}</td>
            <td class="td text-right">{{ isUnpriced(m) ? '—' : formatRate(m.outputPerMTok, m.currency) }}</td>
            <td class="td">
              <span
                class="badge"
                :class="m.source === 'ai' ? 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300' : 'bg-stone-100 text-stone-700 dark:bg-stone-700 dark:text-stone-300'"
              >
                {{ m.source }}
              </span>
            </td>
            <td class="td whitespace-nowrap">{{ formatDateTime(m.updatedAt) }}</td>
            <td v-if="auth.isAdmin" class="td text-right">
              <button class="btn-secondary mr-1" @click="edit(m)">Edit</button>
              <button class="btn-danger" @click="remove(m)">Delete</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    </template>

    <template v-else>
      <p v-if="logProviderError" class="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
        {{ logProviderError }}
      </p>

      <div class="card overflow-x-auto p-0">
        <table class="min-w-full divide-y divide-stone-200 dark:divide-stone-700">
          <thead class="bg-stone-50 dark:bg-stone-700">
            <tr>
              <th class="th">Provider</th>
              <th class="th">Pricing</th>
              <th v-if="auth.isAdmin" class="th"></th>
            </tr>
          </thead>
          <tbody class="divide-y divide-stone-100 dark:divide-stone-700">
            <tr v-if="logProviders.length === 0">
              <td class="td text-center text-stone-500 dark:text-stone-400" :colspan="auth.isAdmin ? 3 : 2">
                No providers reported yet — logs ingested without a <code>provider</code> field
                don't appear here.
              </td>
            </tr>
            <tr v-for="p in logProviders" :key="p.provider">
              <td class="td font-medium">{{ p.provider }}</td>
              <td class="td">
                <span
                  class="badge"
                  :class="p.pricingDisabled ? 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300' : 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'"
                >
                  {{ p.pricingDisabled ? 'pricing disabled' : 'pricing enabled' }}
                </span>
              </td>
              <td v-if="auth.isAdmin" class="td text-right">
                <button
                  class="btn-secondary"
                  :disabled="logProviderBusy === p.provider"
                  @click="toggleLogProviderPricing(p)"
                >
                  {{
                    logProviderBusy === p.provider
                      ? 'Saving…'
                      : p.pricingDisabled
                        ? 'Enable pricing'
                        : 'Disable pricing'
                  }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>
