<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { api } from '../api';
import { formatDateTime } from '../format';
import type { AiProviderView, ModelsListResponse, ProviderTestResult } from '../types';

const providers = ref<AiProviderView[]>([]);
const catalog = ref<string[]>([]);
const error = ref('');
const notice = ref('');
const saving = ref(false);
/** Probe result from the last save, and per-row results from the Test button. */
const lastTest = ref<ProviderTestResult | null>(null);
const rowTests = ref(new Map<string, ProviderTestResult>());
const testingId = ref('');

const blank = () => ({ label: '', baseUrl: '', modelName: 'claude-sonnet-5', apiKey: '' });
const form = reactive(blank());
const editingId = ref<string | null>(null);

async function load() {
  providers.value = (await api<{ providers: AiProviderView[] }>('/ai-providers')).providers;
  catalog.value = (
    await api<ModelsListResponse>('/models').catch(() => ({ models: [], catalog: [] }))
  ).catalog ?? [];
}
onMounted(load);

function reset() {
  Object.assign(form, blank());
  editingId.value = null;
}

function edit(provider: AiProviderView) {
  // The key is never returned, so leave it blank: empty means "keep the stored one".
  Object.assign(form, {
    label: provider.label,
    baseUrl: provider.baseUrl,
    modelName: provider.modelName,
    apiKey: '',
  });
  editingId.value = provider.id;
}

async function save() {
  error.value = '';
  notice.value = '';
  lastTest.value = null;
  saving.value = true;
  try {
    if (editingId.value) {
      const body: Record<string, string> = {
        label: form.label,
        baseUrl: form.baseUrl,
        modelName: form.modelName,
      };
      if (form.apiKey) body.apiKey = form.apiKey;
      const res = await api<{ test?: ProviderTestResult }>(`/ai-providers/${editingId.value}`, {
        method: 'PATCH',
        body,
      });
      lastTest.value = res.test ?? null;
      notice.value = 'Provider updated.';
    } else {
      const res = await api<{ test: ProviderTestResult }>('/ai-providers', {
        method: 'POST',
        body: { ...form },
      });
      lastTest.value = res.test;
      notice.value = 'Provider added.';
    }
    reset();
    await load();
  } catch (err) {
    // The server refuses to store a provider it could not reach, and the
    // rejection carries the probe result — surface that, not a bare 400.
    const details = (err as { details?: { providerTest?: ProviderTestResult } }).details;
    if (details?.providerTest) lastTest.value = details.providerTest;
    error.value = err instanceof Error ? err.message : 'Could not save the provider';
  } finally {
    saving.value = false;
  }
}

async function runTest(provider: AiProviderView) {
  testingId.value = provider.id;
  try {
    const res = await api<{ test: ProviderTestResult }>(`/ai-providers/${provider.id}/test`, {
      method: 'POST',
    });
    rowTests.value = new Map(rowTests.value).set(provider.id, res.test);
  } catch (err) {
    rowTests.value = new Map(rowTests.value).set(provider.id, {
      ok: false,
      status: null,
      latencyMs: 0,
      message: err instanceof Error ? err.message : 'Test failed',
    });
  } finally {
    testingId.value = '';
  }
}

async function remove(provider: AiProviderView) {
  if (!confirm(`Delete ${provider.label}?`)) return;
  await api(`/ai-providers/${provider.id}`, { method: 'DELETE' });
  await load();
}
</script>

<template>
  <div class="space-y-4">
    <h1 class="text-xl font-semibold">AI providers</h1>
    <p class="text-sm text-slate-500 dark:text-slate-400">
      Used only by the <strong>Search</strong> button on the model pricing page. OpenAI-compatible
      and Anthropic Messages endpoints both work — the app POSTs to
      <code class="rounded bg-slate-100 px-1 dark:bg-slate-800">{baseUrl}/chat/completions</code>, then
      <code class="rounded bg-slate-100 px-1 dark:bg-slate-800">{baseUrl}/messages</code> if needed. Keys are stored
      encrypted and are never shown again, here or anywhere else.
    </p>
    <p class="text-sm text-slate-500 dark:text-slate-400">
      Saving sends one tiny <code class="rounded bg-slate-100 px-1 dark:bg-slate-800">max_tokens: 1</code> request to
      check the URL, key and model actually work together. A provider that fails the check is not
      stored — the error tells you which of the three is wrong.
    </p>

    <p v-if="error" class="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">{{ error }}</p>
    <p v-if="notice" class="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
      {{ notice }}
    </p>
    <p
      v-if="lastTest"
      class="rounded-md px-3 py-2 text-sm"
      :class="lastTest.ok ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300' : 'bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-300'"
    >
      <strong>{{ lastTest.ok ? 'Connection test passed' : 'Connection test failed' }}</strong>
      — {{ lastTest.message }}
    </p>

    <form class="card grid gap-3 sm:grid-cols-2 lg:grid-cols-5" @submit.prevent="save">
      <div>
        <label class="label" for="p-label">Label</label>
        <input id="p-label" v-model="form.label" class="input" required placeholder="OpenRouter" />
      </div>
      <div class="lg:col-span-2">
        <label class="label" for="p-url">Base URL</label>
        <input
          id="p-url"
          v-model="form.baseUrl"
          class="input"
          type="url"
          required
          placeholder="https://openrouter.ai/api/v1"
        />
      </div>
      <div>
        <label class="label" for="p-model">Model name</label>
        <input
          id="p-model"
          v-model="form.modelName"
          class="input"
          required
          list="provider-model-catalog"
          placeholder="claude-sonnet-5"
        />
        <datalist id="provider-model-catalog">
          <option v-for="id in catalog" :key="id" :value="id" />
        </datalist>
      </div>
      <div>
        <label class="label" for="p-key">API key</label>
        <input
          id="p-key"
          v-model="form.apiKey"
          class="input"
          type="password"
          :required="editingId === null"
          :placeholder="editingId ? 'Unchanged' : 'sk-…'"
        />
      </div>
      <div class="flex items-end gap-2 sm:col-span-2 lg:col-span-5">
        <button class="btn-primary" type="submit" :disabled="saving">
          {{ saving ? 'Testing connection…' : editingId ? 'Save changes' : 'Test and add provider' }}
        </button>
        <button v-if="editingId" class="btn-secondary" type="button" @click="reset">Cancel</button>
      </div>
    </form>

    <div class="card overflow-x-auto p-0">
      <table class="min-w-full divide-y divide-slate-200 dark:divide-slate-700">
        <thead class="bg-slate-50 dark:bg-slate-700">
          <tr>
            <th class="th">Label</th>
            <th class="th">Base URL</th>
            <th class="th">Model</th>
            <th class="th">Key</th>
            <th class="th">Added</th>
            <th class="th">Last check</th>
            <th class="th"></th>
          </tr>
        </thead>
        <tbody class="divide-y divide-slate-100 dark:divide-slate-700">
          <tr v-if="providers.length === 0">
            <td class="td text-center text-slate-500 dark:text-slate-400" colspan="7">
              No providers configured. Pricing can still be entered by hand.
            </td>
          </tr>
          <tr v-for="p in providers" :key="p.id">
            <td class="td font-medium">{{ p.label }}</td>
            <td class="td font-mono text-xs">{{ p.baseUrl }}</td>
            <td class="td">{{ p.modelName }}</td>
            <td class="td">
              <span class="badge bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">{{ p.hasKey ? 'set' : 'missing' }}</span>
            </td>
            <td class="td whitespace-nowrap">{{ formatDateTime(p.createdAt) }}</td>
            <td class="td">
              <span
                v-if="rowTests.get(p.id)"
                class="badge"
                :class="
                  rowTests.get(p.id)!.ok
                    ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'
                    : 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300'
                "
                :title="rowTests.get(p.id)!.message"
              >
                {{ rowTests.get(p.id)!.ok ? `ok · ${rowTests.get(p.id)!.latencyMs}ms` : 'failed' }}
              </span>
              <span v-else class="text-xs text-slate-400 dark:text-slate-500">not checked</span>
            </td>
            <td class="td text-right whitespace-nowrap">
              <button
                class="btn-secondary mr-1"
                :disabled="testingId === p.id"
                @click="runTest(p)"
              >
                {{ testingId === p.id ? 'Testing…' : 'Test' }}
              </button>
              <button class="btn-secondary mr-1" @click="edit(p)">Edit</button>
              <button class="btn-danger" @click="remove(p)">Delete</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
