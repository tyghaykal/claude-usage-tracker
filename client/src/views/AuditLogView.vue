<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { api } from '../api';
import { formatDateTime } from '../format';
import type { AuditLogEntry } from '../types';

const rows = ref<AuditLogEntry[]>([]);
const page = ref(1);
const totalPages = ref(1);
const loading = ref(false);
const error = ref('');

const actionLabels: Record<string, string> = {
  'user.created': 'User created',
  'user.deleted': 'User deleted',
  'user.role_changed': 'Role changed',
  'user.email_changed': 'Email changed',
  'user.password_reset': 'Password reset by admin',
  'user.password_changed': 'Password changed',
};

const actionColors: Record<string, string> = {
  'user.created': 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  'user.deleted': 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
  'user.role_changed': 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  'user.email_changed': 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  'user.password_reset': 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300',
  'user.password_changed': 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300',
};

/** Turns an entry's free-form `meta` into one readable line instead of raw JSON. */
function describe(row: AuditLogEntry): string {
  const meta = row.meta;
  if (!meta) return '—';
  if ((row.action === 'user.role_changed' || row.action === 'user.email_changed') && meta.from && meta.to) {
    return `${meta.from} → ${meta.to}`;
  }
  if (row.action === 'user.created' && meta.role) {
    return meta.bootstrap ? `role: ${meta.role} (bootstrap)` : `role: ${meta.role}`;
  }
  return Object.entries(meta)
    .map(([key, value]) => `${key}: ${value}`)
    .join(', ');
}

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const res = await api<{ logs: AuditLogEntry[]; totalPages: number }>(
      `/audit-logs?page=${page.value}`,
    );
    rows.value = res.logs;
    totalPages.value = res.totalPages;
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not load the audit log';
  } finally {
    loading.value = false;
  }
}

onMounted(load);
watch(page, load);
</script>

<template>
  <div class="space-y-4">
    <h1 class="text-xl font-semibold">Audit log</h1>

    <p v-if="error" class="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">{{ error }}</p>

    <div class="card overflow-x-auto p-0">
      <table class="min-w-full divide-y divide-slate-200 dark:divide-slate-700">
        <thead class="bg-slate-50 dark:bg-slate-700">
          <tr>
            <th class="th">When</th>
            <th class="th">Action</th>
            <th class="th">By</th>
            <th class="th">Target</th>
            <th class="th">Details</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-slate-100 dark:divide-slate-700">
          <tr v-if="loading">
            <td class="td text-center text-slate-500 dark:text-slate-400" colspan="5">Loading…</td>
          </tr>
          <tr v-else-if="rows.length === 0">
            <td class="td text-center text-slate-500 dark:text-slate-400" colspan="5">No activity recorded yet.</td>
          </tr>
          <tr v-for="row in rows" v-else :key="row.id">
            <td class="td whitespace-nowrap">{{ formatDateTime(row.createdAt) }}</td>
            <td class="td">
              <span class="badge" :class="actionColors[row.action] ?? 'bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-300'">
                {{ actionLabels[row.action] ?? row.action }}
              </span>
            </td>
            <td class="td">{{ row.actorName }}</td>
            <td class="td">{{ row.targetName }}<span v-if="row.targetEmail" class="text-slate-500 dark:text-slate-400"> ({{ row.targetEmail }})</span></td>
            <td class="td text-slate-500 dark:text-slate-400">{{ describe(row) }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="flex items-center justify-between">
      <button class="btn-secondary" :disabled="page <= 1" @click="page -= 1">Previous</button>
      <span class="text-sm text-slate-600 dark:text-slate-400">Page {{ page }} of {{ totalPages || 1 }}</span>
      <button class="btn-secondary" :disabled="page >= totalPages" @click="page += 1">Next</button>
    </div>
  </div>
</template>
