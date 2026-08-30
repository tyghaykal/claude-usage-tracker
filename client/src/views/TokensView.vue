<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api } from '../api';
import { formatDateTime } from '../format';
import type { ApiTokenView } from '../types';

const tokens = ref<ApiTokenView[]>([]);
const label = ref('');
const error = ref('');
/** Held only in memory, and only until the page is left. */
const freshToken = ref('');

const endpoint = `${window.location.origin}/api/usage`;

async function load() {
  tokens.value = (await api<{ tokens: ApiTokenView[] }>('/tokens')).tokens;
}
onMounted(load);

async function create() {
  error.value = '';
  try {
    const res = await api<{ token: string }>('/tokens', {
      method: 'POST',
      body: { label: label.value },
    });
    freshToken.value = res.token;
    label.value = '';
    await load();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not create a token';
  }
}

async function revoke(token: ApiTokenView) {
  if (!confirm(`Revoke ${token.tokenPrefix}…? Any machine using it stops reporting.`)) return;
  await api(`/tokens/${token.id}/revoke`, { method: 'POST' });
  await load();
}

async function remove(token: ApiTokenView) {
  if (!confirm(`Delete ${token.tokenPrefix}… permanently?`)) return;
  await api(`/tokens/${token.id}`, { method: 'DELETE' });
  await load();
}

const copy = (text: string) => void navigator.clipboard?.writeText(text);
</script>

<template>
  <div class="space-y-4">
    <h1 class="text-xl font-semibold">API tokens</h1>
    <p class="text-sm text-slate-500 dark:text-slate-400">
      One token per machine is a good default. Issuing a new token never invalidates your
      existing ones — revoking is always explicit.
    </p>

    <form class="card flex flex-wrap items-end gap-3" @submit.prevent="create">
      <div class="grow">
        <label class="label" for="label">Label</label>
        <input id="label" v-model="label" class="input" placeholder="work laptop" />
      </div>
      <button class="btn-primary" type="submit">Create token</button>
    </form>

    <p v-if="error" class="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">{{ error }}</p>

    <div v-if="freshToken" class="card space-y-3 border-emerald-300 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950">
      <h2 class="text-sm font-semibold text-emerald-900 dark:text-emerald-300">
        Copy this token now — it is never shown again
      </h2>
      <div class="flex items-center gap-2">
        <code class="grow overflow-x-auto rounded bg-white px-3 py-2 text-sm dark:bg-slate-950">{{ freshToken }}</code>
        <button class="btn-secondary" @click="copy(freshToken)">Copy</button>
      </div>

      <div>
        <p class="text-sm text-emerald-900 dark:text-emerald-300">Then, on the machine you want to report from:</p>
        <pre class="mt-1 overflow-x-auto rounded bg-white p-3 text-xs dark:bg-slate-950">/claude-usage-reporter:usage-config set usageEndpoint {{ endpoint }}
/claude-usage-reporter:usage-config set usageAuthType Header
/claude-usage-reporter:usage-config set usageHeaderValue {{ freshToken }}</pre>
      </div>

      <button class="btn-secondary" @click="freshToken = ''">Done</button>
    </div>

    <div class="card overflow-x-auto p-0">
      <table class="min-w-full divide-y divide-slate-200 dark:divide-slate-700">
        <thead class="bg-slate-50 dark:bg-slate-700">
          <tr>
            <th class="th">Label</th>
            <th class="th">Token</th>
            <th class="th">Status</th>
            <th class="th">Last used</th>
            <th class="th">Created</th>
            <th class="th"></th>
          </tr>
        </thead>
        <tbody class="divide-y divide-slate-100 dark:divide-slate-700">
          <tr v-if="tokens.length === 0">
            <td class="td text-center text-slate-500 dark:text-slate-400" colspan="6">No tokens yet.</td>
          </tr>
          <tr v-for="t in tokens" :key="t.id">
            <td class="td">{{ t.label || '—' }}</td>
            <td class="td font-mono text-xs">{{ t.tokenPrefix }}…</td>
            <td class="td">
              <span
                class="badge"
                :class="t.revoked ? 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300' : 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'"
              >
                {{ t.revoked ? 'revoked' : 'active' }}
              </span>
            </td>
            <td class="td whitespace-nowrap">{{ formatDateTime(t.lastUsedAt) }}</td>
            <td class="td whitespace-nowrap">{{ formatDateTime(t.createdAt) }}</td>
            <td class="td text-right">
              <button v-if="!t.revoked" class="btn-secondary mr-1" @click="revoke(t)">Revoke</button>
              <button class="btn-danger" @click="remove(t)">Delete</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
