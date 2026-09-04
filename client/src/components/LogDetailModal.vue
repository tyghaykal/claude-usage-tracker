<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { api } from '../api';
import {
  AMANAI_IDR_PER_CREDIT,
  costBreakdown,
  formatCost,
  formatDateTime,
  formatRate,
  formatTokens,
} from '../format';
import { useAuthStore } from '../stores/auth';
import type { ProjectHistory, UsageLogDetail } from '../types';

const props = defineProps<{ log: UsageLogDetail }>();
const emit = defineEmits<{ close: []; recalculated: [log: UsageLogDetail] }>();

const auth = useAuthStore();

const recalcBusy = ref(false);
const recalcError = ref('');

const currentProject = ref(props.log.project);
const history = ref<ProjectHistory['history']>([]);
const renaming = ref(false);
const newName = ref('');
const renameBusy = ref(false);
const renameError = ref('');

const currentProvider = ref(props.log.provider);
const editingProvider = ref(false);
const providerInput = ref('');
const providerBusy = ref(false);
const providerError = ref('');

function startEditProvider() {
  providerInput.value = currentProvider.value ?? '';
  providerError.value = '';
  editingProvider.value = true;
}

async function saveProvider() {
  const value = providerInput.value.trim();
  if (!value) {
    providerError.value = 'Provider is required';
    return;
  }
  providerBusy.value = true;
  providerError.value = '';
  try {
    const res = await api<{ log: UsageLogDetail }>(`/usage-logs/${props.log.id}/provider`, {
      method: 'PATCH',
      body: { provider: value },
    });
    currentProvider.value = res.log.provider;
    editingProvider.value = false;
    emit('recalculated', res.log);
  } catch (err) {
    providerError.value = err instanceof Error ? err.message : 'Could not save provider';
  } finally {
    providerBusy.value = false;
  }
}

async function loadHistory() {
  const res = await api<{ project: ProjectHistory }>(
    `/projects/${encodeURIComponent(currentProject.value)}`,
  );
  history.value = res.project.history;
}

function startRename() {
  newName.value = currentProject.value;
  renameError.value = '';
  renaming.value = true;
}

async function confirmRename() {
  const name = newName.value.trim();
  if (!name || name === currentProject.value) {
    renaming.value = false;
    return;
  }
  renameBusy.value = true;
  renameError.value = '';
  try {
    const res = await api<{ project: ProjectHistory }>('/projects/rename', {
      method: 'POST',
      body: { name: currentProject.value, newName: name },
    });
    currentProject.value = res.project.name;
    history.value = res.project.history;
    renaming.value = false;
    // Refetch rather than patch `project` in locally: the rename may also
    // have synced this log's `projectLabel` server-side (when it was just
    // mirroring the old name), and the header prefers that label — a
    // hand-built object would show the label as stale even though the
    // rename fully succeeded.
    const { log } = await api<{ log: UsageLogDetail }>(`/usage-logs/${props.log.id}`);
    emit('recalculated', log);
  } catch (err) {
    renameError.value = err instanceof Error ? err.message : 'Rename failed';
  } finally {
    renameBusy.value = false;
  }
}

watch(
  () => props.log.project,
  (project) => {
    currentProject.value = project;
  },
);
watch(
  () => props.log.provider,
  (provider) => {
    currentProvider.value = provider;
  },
);
onMounted(loadHistory);

async function recalculate() {
  recalcBusy.value = true;
  recalcError.value = '';
  try {
    const res = await api<{ updated: number; skipped: number }>('/usage-logs/recalculate-cost', {
      method: 'POST',
      body: { ids: [props.log.id] },
    });
    if (res.updated === 0) {
      recalcError.value = 'No pricing is configured for this model yet.';
      return;
    }
    const { log } = await api<{ log: UsageLogDetail }>(`/usage-logs/${props.log.id}`);
    emit('recalculated', log);
  } catch (err) {
    recalcError.value = err instanceof Error ? err.message : 'Recalculation failed';
  } finally {
    recalcBusy.value = false;
  }
}

const breakdown = computed(() =>
  props.log.pricingSnapshot
    ? costBreakdown(props.log.tokens, props.log.pricingSnapshot)
    : null,
);

const costSumFormula = computed(() => {
  const rows = breakdown.value;
  if (!rows) return '';
  return rows.lines.map((line) => formatCost(line.cost, rows.currency)).join(' + ');
});

const showRawPayload = ref(false);
const rawPayloadJson = computed(() =>
  props.log.rawPayload ? JSON.stringify(props.log.rawPayload, null, 2) : null,
);
</script>

<template>
  <div
    class="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-stone-900/40 p-4"
    @click.self="emit('close')"
  >
    <div class="card my-8 w-full max-w-4xl space-y-5">
      <div class="flex items-start justify-between gap-4">
        <div>
          <div v-if="renaming" class="flex items-center gap-2">
            <input
              v-model="newName"
              class="input"
              :disabled="renameBusy"
              @keyup.enter="confirmRename"
              @keyup.escape="renaming = false"
            />
            <button class="btn-primary" :disabled="renameBusy" @click="confirmRename">
              {{ renameBusy ? 'Saving…' : 'Save' }}
            </button>
            <button class="btn-secondary" :disabled="renameBusy" @click="renaming = false">
              Cancel
            </button>
          </div>
          <div v-else class="flex items-center gap-2">
            <h2 class="text-lg font-semibold" :title="log.projectLabel ? currentProject : undefined">
              {{ log.projectLabel || currentProject }}
            </h2>
            <button v-if="auth.isAdmin" class="text-xs text-blue-600 hover:underline dark:text-blue-400" @click="startRename">
              Rename
            </button>
          </div>
          <p v-if="renameError" class="mt-1 text-xs text-red-700 dark:text-red-400">{{ renameError }}</p>
          <p class="text-sm text-stone-500 dark:text-stone-400">{{ formatDateTime(log.promptDatetime) }}</p>
          <p v-if="history.length === 1" class="mt-1 text-xs text-stone-500 dark:text-stone-400">
            Renamed: {{ history[0]!.from }} → {{ history[0]!.to }}
          </p>
          <details v-else-if="history.length > 1" class="mt-1 text-xs text-stone-500 dark:text-stone-400">
            <summary class="cursor-pointer">Renamed {{ history.length }} times</summary>
            <ul class="mt-1 space-y-0.5">
              <li v-for="(entry, i) in history" :key="i">
                {{ entry.from }} → {{ entry.to }}
                <span class="text-stone-400 dark:text-stone-500">({{ formatDateTime(entry.changedAt) }})</span>
              </li>
            </ul>
          </details>
        </div>
        <div class="flex shrink-0 gap-2">
          <button
            class="flex h-9 w-9 items-center justify-center rounded-md border border-stone-300 bg-white text-base hover:bg-stone-100 dark:border-stone-600 dark:bg-stone-900 dark:hover:bg-stone-700"
            title="Show raw ingestion payload"
            @click="showRawPayload = !showRawPayload"
          >
            🐛
          </button>
          <button class="btn-secondary" @click="emit('close')">Close</button>
        </div>
      </div>

      <dl class="grid grid-cols-2 gap-4 text-sm sm:grid-cols-3">
        <div>
          <dt class="text-xs uppercase tracking-wide text-stone-500 dark:text-stone-400">Model</dt>
          <dd class="mt-0.5">{{ log.model ?? '— not reported —' }}</dd>
        </div>
        <div>
          <dt class="text-xs uppercase tracking-wide text-stone-500 dark:text-stone-400">Provider</dt>
          <dd v-if="editingProvider" class="mt-0.5 flex items-center gap-1">
            <input
              v-model="providerInput"
              class="input h-7 py-0 text-sm"
              :disabled="providerBusy"
              placeholder="claude-session"
              @keyup.enter="saveProvider"
              @keyup.escape="editingProvider = false"
            />
            <button class="btn-primary px-2 py-1 text-xs" :disabled="providerBusy" @click="saveProvider">
              {{ providerBusy ? '…' : 'Save' }}
            </button>
            <button class="btn-secondary px-2 py-1 text-xs" :disabled="providerBusy" @click="editingProvider = false">
              Cancel
            </button>
          </dd>
          <dd v-else class="mt-0.5 flex items-center gap-2">
            {{ currentProvider ?? '— not reported —' }}
            <button v-if="auth.isAdmin" class="text-xs text-blue-600 hover:underline dark:text-blue-400" @click="startEditProvider">
              {{ currentProvider ? 'Edit' : 'Add' }}
            </button>
          </dd>
          <p v-if="providerError" class="mt-1 text-xs text-red-700 dark:text-red-400">{{ providerError }}</p>
        </div>
        <div>
          <dt class="text-xs uppercase tracking-wide text-stone-500 dark:text-stone-400">Session</dt>
          <dd class="mt-0.5 font-mono text-xs">{{ log.sessionId }}</dd>
        </div>
        <div>
          <dt class="text-xs uppercase tracking-wide text-stone-500 dark:text-stone-400">Received</dt>
          <dd class="mt-0.5">{{ formatDateTime(log.receivedAt) }}</dd>
        </div>
        <div>
          <dt class="text-xs uppercase tracking-wide text-stone-500 dark:text-stone-400">Plugin user label</dt>
          <dd class="mt-0.5">{{ log.userLabel ?? '—' }}</dd>
        </div>
        <div>
          <dt class="text-xs uppercase tracking-wide text-stone-500 dark:text-stone-400">Estimated cost</dt>
          <dd class="mt-0.5 font-medium">
            {{ formatCost(log.estimatedCostUsd, log.currency ?? 'USD') }}
          </dd>
        </div>
        <div v-if="log.amanaiCredits !== null">
          <dt class="text-xs uppercase tracking-wide text-stone-500 dark:text-stone-400">Amanai credits</dt>
          <dd class="mt-0.5 font-medium">{{ formatTokens(log.amanaiCredits) }}</dd>
        </div>
        <div v-if="log.amanaiCredits !== null">
          <dt class="text-xs uppercase tracking-wide text-stone-500 dark:text-stone-400">Amanai (IDR)</dt>
          <dd class="mt-0.5 font-medium">
            {{ formatCost(log.amanaiCredits * AMANAI_IDR_PER_CREDIT, 'IDR') }}
          </dd>
        </div>
        <div>
          <dt class="text-xs uppercase tracking-wide text-stone-500 dark:text-stone-400">Recalculated</dt>
          <dd class="mt-0.5">{{ formatDateTime(log.recalculatedAt) }}</dd>
        </div>
      </dl>

      <section>
        <h3 class="mb-2 text-sm font-semibold">Tokens</h3>
        <div class="grid grid-cols-2 gap-2 sm:grid-cols-5">
          <div
            v-for="[label, value] in [
              ['Input', log.tokens.input],
              ['Cache read', log.tokens.cache_read],
              ['Cache write', log.tokens.cache_write],
              ['Output', log.tokens.output],
              ['Total', log.tokens.total],
            ] as [string, number][]"
            :key="label"
            class="rounded-md bg-stone-50 px-3 py-2 dark:bg-stone-700"
          >
            <div class="text-xs text-stone-500 dark:text-stone-400">{{ label }}</div>
            <div class="text-sm font-medium">{{ formatTokens(value) }}</div>
          </div>
        </div>
      </section>

      <section>
        <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h3 class="text-sm font-semibold">
            Cost breakdown
            <span v-if="log.pricingOutdated" class="badge ml-2 bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300">
              newer pricing available
            </span>
          </h3>
          <button class="btn-secondary" :disabled="recalcBusy" @click="recalculate">
            {{ recalcBusy ? 'Updating…' : 'Update pricing' }}
          </button>
        </div>
        <p v-if="recalcError" class="mb-2 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {{ recalcError }}
        </p>
        <template v-if="breakdown">
          <p class="mb-2 text-xs text-stone-500 dark:text-stone-400">
            Each line divides (tokens × rate) by 1,000,000, since rates are priced per million
            tokens. The prompt total is the sum of those four lines — the combined token count is
            not priced on its own.
          </p>
          <div class="overflow-x-auto rounded-md border border-stone-200 dark:border-stone-700">
            <table class="min-w-full divide-y divide-stone-200 text-sm dark:divide-stone-700">
              <thead class="bg-stone-50 dark:bg-stone-700">
                <tr>
                  <th class="th">Component</th>
                  <th class="th text-right">Tokens</th>
                  <th class="th text-right">Rate</th>
                  <th class="th">Calculation</th>
                  <th class="th text-right">Cost</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-stone-100 dark:divide-stone-700">
                <tr v-for="line in breakdown.lines" :key="line.key">
                  <td class="td">{{ line.label }}</td>
                  <td class="td text-right tabular-nums">{{ formatTokens(line.tokens) }}</td>
                  <td class="td text-right tabular-nums">
                    {{ formatRate(line.ratePerMTok, breakdown.currency) }}
                  </td>
                  <td class="td whitespace-nowrap font-mono text-xs text-stone-600 dark:text-stone-400">
                    ({{ formatTokens(line.tokens) }} tok × {{ formatRate(line.ratePerMTok, breakdown.currency) }}) / 1,000,000
                  </td>
                  <td class="td text-right tabular-nums font-medium">
                    {{ formatCost(line.cost, breakdown.currency) }}
                  </td>
                </tr>
              </tbody>
              <tfoot>
                <tr class="bg-stone-50 font-medium dark:bg-stone-700">
                  <td class="td">Estimated total</td>
                  <td class="td text-right tabular-nums">{{ formatTokens(log.tokens.total) }}</td>
                  <td class="td"></td>
                  <td class="td font-mono text-xs text-stone-600 dark:text-stone-400">{{ costSumFormula }}</td>
                  <td class="td text-right tabular-nums">
                    {{ formatCost(breakdown.total, breakdown.currency) }}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </template>
        <p v-else class="rounded-md bg-stone-50 px-3 py-2 text-sm text-stone-600 dark:bg-stone-700 dark:text-stone-400">
          No pricing was configured for this model when the prompt arrived, so no cost was
          estimated. Token counts above are still exact.
        </p>
      </section>

      <section>
        <h3 class="mb-2 text-sm font-semibold">Prompt</h3>
        <pre
          class="max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-stone-50 p-3 text-sm dark:bg-stone-700"
        >{{ log.prompt || '— the plugin sent no prompt text (usagePromptMode: none) —' }}</pre>
      </section>

      <section v-if="showRawPayload">
        <h3 class="mb-2 text-sm font-semibold">Raw ingestion payload</h3>
        <pre
          v-if="rawPayloadJson"
          class="max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-stone-50 p-3 text-xs dark:bg-stone-700"
        >{{ rawPayloadJson }}</pre>
        <p v-else class="rounded-md bg-stone-50 px-3 py-2 text-sm text-stone-600 dark:bg-stone-700 dark:text-stone-400">
          Not recorded — this prompt was ingested before raw-payload storage was added.
        </p>
      </section>
    </div>
  </div>
</template>
