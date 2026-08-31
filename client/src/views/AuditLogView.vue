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
  'user.password_reset': 'Password reset by admin',
  'user.password_changed': 'Password changed',
};

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
            <td class="td">{{ actionLabels[row.action] ?? row.action }}</td>
            <td class="td">{{ row.actorName }}</td>
            <td class="td">{{ row.targetName }}<span v-if="row.targetEmail" class="text-slate-500 dark:text-slate-400"> ({{ row.targetEmail }})</span></td>
            <td class="td text-xs text-slate-500 dark:text-slate-400">
              <span v-if="row.meta">{{ JSON.stringify(row.meta) }}</span>
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
  </div>
</template>
