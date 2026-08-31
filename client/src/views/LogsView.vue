<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { api, dayToIso, toQuery } from '../api';
import LogDetailModal from '../components/LogDetailModal.vue';
import UsageFilters, { type FilterModel } from '../components/UsageFilters.vue';
import { useRealtime } from '../composables/useRealtime';
import { formatCost, formatDateTime, formatTokens } from '../format';
import { useAuthStore } from '../stores/auth';
import type { UsageLogDetail, UsageLogRow, UserDirectoryEntry } from '../types';

const auth = useAuthStore();

const filters = ref<FilterModel>({ project: '', userId: '', model: '', dateFrom: '', dateTo: '' });
const page = ref(1);
const limit = ref(50);

const rows = ref<UsageLogRow[]>([]);
const total = ref(0);
const totalPages = ref(1);
const loading = ref(false);
const error = ref('');

const selected = ref(new Set<string>());
const openLog = ref<UsageLogDetail | null>(null);
const bulkMessage = ref('');
const recalcBusy = ref(false);
const userNames = ref(new Map<string, string>());

/** The filter shape the API takes, derived from the form's date-input values. */
const apiFilter = computed(() => ({
  project: filters.value.project || undefined,
  userId: filters.value.userId || undefined,
  model: filters.value.model || undefined,
  dateFrom: dayToIso(filters.value.dateFrom),
  dateTo: dayToIso(filters.value.dateTo, true),
}));

const outdatedCount = computed(() => rows.value.filter((r) => r.pricingOutdated).length);
const allSelected = computed(
  () => rows.value.length > 0 && rows.value.every((r) => selected.value.has(r.id)),
);

/** Only the selected rows visible on this page — a cross-page selection can't
 *  be checked for a shared project without another round trip, so this is a
 *  best-effort read of what's on screen. */
const selectedRows = computed(() => rows.value.filter((r) => selected.value.has(r.id)));
const selectedProjectName = computed(() => {
  if (selectedRows.value.length === 0) return null;
  const projects = new Set(selectedRows.value.map((r) => r.project));
  return projects.size === 1 ? selectedRows.value[0]!.project : null;
});

const renaming = ref(false);
const renameTarget = ref('');
const renameNewName = ref('');
const renameBusy = ref(false);
const renameError = ref('');

function startRenameSelected() {
  if (!selectedProjectName.value) return;
  renameTarget.value = selectedProjectName.value;
  renameNewName.value = selectedProjectName.value;
  renameError.value = '';
  renaming.value = true;
}

async function confirmRenameSelected() {
  const newName = renameNewName.value.trim();
  if (!newName || newName === renameTarget.value) {
    renaming.value = false;
    return;
  }
  renameBusy.value = true;
  renameError.value = '';
  try {
    await api('/projects/rename', { method: 'POST', body: { name: renameTarget.value, newName } });
    renaming.value = false;
    selected.value = new Set();
    await load();
  } catch (err) {
    renameError.value = err instanceof Error ? err.message : 'Rename failed';
  } finally {
    renameBusy.value = false;
  }
}

/** Bulk-tag a `provider` — mainly for records ingested before the plugin sent
 *  this field. Same "ids or filter" scope choice as recalculate(). */
const settingProvider = ref(false);
const providerScope = ref<'selected' | 'filter'>('selected');
const providerValue = ref('');
const providerBusy = ref(false);
const providerError = ref('');

function startSetProvider(scope: 'selected' | 'filter') {
  providerScope.value = scope;
  providerValue.value = '';
  providerError.value = '';
  settingProvider.value = true;
}

async function confirmSetProvider() {
  const provider = providerValue.value.trim();
  if (!provider) {
    providerError.value = 'Provider is required';
    return;
  }
  providerBusy.value = true;
  providerError.value = '';
  try {
    const body =
      providerScope.value === 'selected'
        ? { ids: [...selected.value], provider }
        : { filter: apiFilter.value, provider };
    const res = await api<{ matched: number; updated: number }>('/usage-logs/set-provider', {
      method: 'POST',
      body,
    });
    bulkMessage.value = `Set provider on ${res.updated} of ${res.matched} record(s).`;
    settingProvider.value = false;
    selected.value = new Set();
    await load();
  } catch (err) {
    providerError.value = err instanceof Error ? err.message : 'Could not set provider';
  } finally {
    providerBusy.value = false;
  }
}

/** `silent` skips the loading flash — used for background realtime refreshes. */
async function load({ silent = false } = {}) {
  if (!silent) loading.value = true;
  error.value = '';
  try {
    const res = await api<{
      logs: UsageLogRow[];
      total: number;
      totalPages: number;
    }>(`/usage-logs${toQuery({ ...apiFilter.value, page: page.value, limit: limit.value })}`);
    rows.value = res.logs;
    total.value = res.total;
    totalPages.value = res.totalPages;
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not load usage logs';
  } finally {
    if (!silent) loading.value = false;
  }
}

onMounted(async () => {
  await load();
  const list = await api<{ users: UserDirectoryEntry[] }>('/me/directory');
  userNames.value = new Map(list.users.map((u) => [u.id, u.name]));
});

watch(filters, () => {
  page.value = 1;
  selected.value = new Set();
  void load();
});
watch(page, () => void load());
// A new prompt was ingested, or pricing was recalculated, somewhere else.
useRealtime(() => void load({ silent: true }));

function toggle(id: string) {
  const next = new Set(selected.value);
  next.has(id) ? next.delete(id) : next.add(id);
  selected.value = next;
}

function toggleAll() {
  selected.value = allSelected.value ? new Set() : new Set(rows.value.map((r) => r.id));
}

async function openDetail(id: string) {
  const res = await api<{ log: UsageLogDetail }>(`/usage-logs/${id}`);
  openLog.value = res.log;
}

/** The modal repriced itself; refresh its own state and the row behind it. */
async function onRecalculated(log: UsageLogDetail) {
  openLog.value = log;
  await load();
}

/**
 * FR-12. `scope: 'filter'` deliberately sends the filter rather than the ids on
 * screen, so it covers every matching row — not just the current page.
 */
async function recalculate(scope: 'selected' | 'filter') {
  recalcBusy.value = true;
  bulkMessage.value = '';
  try {
    const body =
      scope === 'selected' ? { ids: [...selected.value] } : { filter: apiFilter.value };
    const res = await api<{ total: number; updated: number; skipped: number }>(
      '/usage-logs/recalculate-cost',
      { method: 'POST', body },
    );
    bulkMessage.value =
      `Repriced ${res.updated} of ${res.total} record(s).` +
      (res.skipped ? ` ${res.skipped} skipped — no pricing for that model yet.` : '');
    selected.value = new Set();
    await load();
  } catch (err) {
    bulkMessage.value = err instanceof Error ? err.message : 'Recalculation failed';
  } finally {
    recalcBusy.value = false;
  }
}
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <h1 class="text-xl font-semibold">Usage logs</h1>
      <p class="text-sm text-slate-500 dark:text-slate-400">{{ formatTokens(total) }} prompt(s)</p>
    </div>

    <UsageFilters v-model="filters" />

    <div class="card space-y-3">
      <div class="flex flex-wrap items-center gap-3">
        <button
          class="btn-primary"
          :disabled="selected.size === 0 || recalcBusy"
          @click="recalculate('selected')"
        >
          Recalculate {{ selected.size }} selected
        </button>
        <button class="btn-secondary" :disabled="recalcBusy" @click="recalculate('filter')">
          Recalculate all {{ total }} matching this filter
        </button>
        <button
          v-if="auth.isAdmin"
          class="btn-secondary"
          :disabled="!selectedProjectName"
          :title="
            selected.size > 0 && !selectedProjectName
              ? 'Selected logs span more than one project'
              : ''
          "
          @click="startRenameSelected"
        >
          Rename project ({{ selected.size }} selected)
        </button>
        <button
          v-if="auth.isAdmin"
          class="btn-secondary"
          :disabled="selected.size === 0"
          @click="startSetProvider('selected')"
        >
          Set provider ({{ selected.size }} selected)
        </button>
        <button v-if="auth.isAdmin" class="btn-secondary" @click="startSetProvider('filter')">
          Set provider for all {{ total }} matching this filter
        </button>
        <span v-if="outdatedCount" class="badge bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300">
          {{ outdatedCount }} row(s) on this page use outdated pricing
        </span>
        <span v-if="bulkMessage" class="text-sm text-slate-600 dark:text-slate-400">{{ bulkMessage }}</span>
      </div>

      <div v-if="renaming" class="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3 dark:border-slate-700">
        <span class="whitespace-nowrap text-sm text-slate-600 dark:text-slate-400">
          Rename "{{ renameTarget }}" to
        </span>
        <input
          v-model="renameNewName"
          class="input w-56"
          :disabled="renameBusy"
          @keyup.enter="confirmRenameSelected"
          @keyup.escape="renaming = false"
        />
        <button class="btn-primary" :disabled="renameBusy" @click="confirmRenameSelected">
          {{ renameBusy ? 'Saving…' : 'Save' }}
        </button>
        <button class="btn-secondary" :disabled="renameBusy" @click="renaming = false">
          Cancel
        </button>
        <span v-if="renameError" class="text-sm text-red-700 dark:text-red-400">{{ renameError }}</span>
      </div>

      <div v-if="settingProvider" class="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3 dark:border-slate-700">
        <span class="whitespace-nowrap text-sm text-slate-600 dark:text-slate-400">
          Set provider on
          {{ providerScope === 'selected' ? `${selected.size} selected` : `all ${total} matching this filter` }}
          to
        </span>
        <input
          v-model="providerValue"
          class="input w-56"
          :disabled="providerBusy"
          placeholder="claude-session"
          @keyup.enter="confirmSetProvider"
          @keyup.escape="settingProvider = false"
        />
        <button class="btn-primary" :disabled="providerBusy" @click="confirmSetProvider">
          {{ providerBusy ? 'Saving…' : 'Save' }}
        </button>
        <button class="btn-secondary" :disabled="providerBusy" @click="settingProvider = false">
          Cancel
        </button>
        <span v-if="providerError" class="text-sm text-red-700 dark:text-red-400">{{ providerError }}</span>
      </div>
    </div>

    <p v-if="error" class="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">{{ error }}</p>

    <div class="card overflow-x-auto p-0">
      <table class="min-w-full divide-y divide-slate-200 dark:divide-slate-700">
        <thead class="bg-slate-50 dark:bg-slate-700">
          <tr>
            <th class="th w-8">
              <input type="checkbox" :checked="allSelected" @change="toggleAll" />
            </th>
            <th class="th">When</th>
            <th class="th">Project</th>
            <th class="th">Developer</th>
            <th class="th">Model</th>
            <th class="th">Provider</th>
            <th class="th text-right">Tokens</th>
            <th class="th text-right">Est. cost</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-slate-100 dark:divide-slate-700">
          <tr v-if="loading">
            <td class="td text-center text-slate-500 dark:text-slate-400" colspan="8">Loading…</td>
          </tr>
          <tr v-else-if="rows.length === 0">
            <td class="td text-center text-slate-500 dark:text-slate-400" colspan="8">
              No usage recorded yet for this filter.
            </td>
          </tr>
          <tr
            v-for="row in rows"
            v-else
            :key="row.id"
            class="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-700"
            @click="openDetail(row.id)"
          >
            <td class="td" @click.stop>
              <input type="checkbox" :checked="selected.has(row.id)" @change="toggle(row.id)" />
            </td>
            <td class="td whitespace-nowrap">{{ formatDateTime(row.promptDatetime) }}</td>
            <td class="td" :title="row.projectLabel ? row.project : undefined">
              {{ row.projectLabel || row.project }}
            </td>
            <td class="td">{{ userNames.get(row.userId) ?? row.userId.slice(-6) }}</td>
            <td class="td">
              {{ row.model ?? '—' }}
              <span
                v-if="row.pricingOutdated"
                class="badge ml-1 bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300"
                title="Current pricing for this model differs from the rate stored on this record"
              >
                pricing outdated
              </span>
            </td>
            <td class="td">{{ row.provider ?? '—' }}</td>
            <td class="td text-right">{{ formatTokens(row.tokens.total) }}</td>
            <td class="td text-right">
              {{ formatCost(row.estimatedCostUsd, row.currency ?? 'USD') }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="flex items-center justify-between">
      <button class="btn-secondary" :disabled="page <= 1" @click="page -= 1">Previous</button>
      <span class="text-sm text-slate-600 dark:text-slate-400">Page {{ page }} of {{ totalPages || 1 }}</span>
      <button class="btn-secondary" :disabled="page >= totalPages" @click="page += 1">Next</button>
    </div>

    <LogDetailModal
      v-if="openLog"
      :log="openLog"
      @close="openLog = null"
      @recalculated="onRecalculated"
    />
  </div>
</template>
