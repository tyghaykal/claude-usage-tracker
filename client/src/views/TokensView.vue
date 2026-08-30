<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api } from '../api';
import { useConfirmDialog } from '../composables/useConfirmDialog';
import { useToast } from '../composables/useToast';
import { formatDateTime } from '../format';
import type { ApiTokenView } from '../types';

const { confirm } = useConfirmDialog();
const { notify } = useToast();
const tokens = ref<ApiTokenView[]>([]);
const label = ref('');
const error = ref('');
/** Held only in memory, and only until the page is left. */
const freshToken = ref('');
/** Which token `freshToken` belongs to, so revoking/deleting it hides the card. */
const freshTokenId = ref('');

const endpoint = `${window.location.origin}/api/usage`;

const setupMode = ref<'global' | 'local'>('global');
/** Must match the repo/directory name claude-usage-reporter reports as `project`. */
const projectName = ref('');

/** `usage-config` runs through a shell — only a space forces quoting the key. */
function projectKeyArg(key: string): string {
  const name = projectName.value || '<project>';
  const arg = `usageProject:${name}:${key}`;
  return arg.includes(' ') ? `"${arg}"` : arg;
}

async function load() {
  tokens.value = (await api<{ tokens: ApiTokenView[] }>('/tokens')).tokens;
}
onMounted(load);

async function create() {
  error.value = '';
  try {
    const res = await api<{ token: string; apiToken: ApiTokenView }>('/tokens', {
      method: 'POST',
      body: { label: label.value },
    });
    freshToken.value = res.token;
    freshTokenId.value = res.apiToken.id;
    label.value = '';
    await load();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not create a token';
  }
}

function clearFreshToken(id: string) {
  if (id !== freshTokenId.value) return;
  freshToken.value = '';
  freshTokenId.value = '';
}

async function revoke(token: ApiTokenView) {
  const ok = await confirm(`Revoke ${token.tokenPrefix}…? Any machine using it stops reporting.`, {
    danger: true,
    confirmLabel: 'Revoke',
  });
  if (!ok) return;
  await api(`/tokens/${token.id}/revoke`, { method: 'POST' });
  clearFreshToken(token.id);
  await load();
}

async function remove(token: ApiTokenView) {
  if (!(await confirm(`Delete ${token.tokenPrefix}… permanently?`, { danger: true }))) return;
  await api(`/tokens/${token.id}`, { method: 'DELETE' });
  clearFreshToken(token.id);
  await load();
}

async function copy(text: string) {
  try {
    if (!navigator.clipboard) throw new Error('Clipboard unavailable');
    await navigator.clipboard.writeText(text);
    notify('Copied to clipboard');
  } catch {
    notify('Could not copy — clipboard access is unavailable', 'error');
  }
}
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
        <div class="flex items-center justify-between gap-2">
          <p class="text-sm text-emerald-900 dark:text-emerald-300">
            Then, on the machine you want to report from:
          </p>
          <div class="flex gap-1 text-xs">
            <button
              type="button"
              class="rounded-md px-2 py-1"
              :class="setupMode === 'global' ? 'bg-emerald-900 text-white dark:bg-emerald-300 dark:text-emerald-950' : 'text-emerald-900 hover:bg-emerald-100 dark:text-emerald-300 dark:hover:bg-emerald-900'"
              @click="setupMode = 'global'"
            >
              Global (all projects)
            </button>
            <button
              type="button"
              class="rounded-md px-2 py-1"
              :class="setupMode === 'local' ? 'bg-emerald-900 text-white dark:bg-emerald-300 dark:text-emerald-950' : 'text-emerald-900 hover:bg-emerald-100 dark:text-emerald-300 dark:hover:bg-emerald-900'"
              @click="setupMode = 'local'"
            >
              This project only
            </button>
          </div>
        </div>

        <pre
          v-if="setupMode === 'global'"
          class="mt-1 overflow-x-auto rounded bg-white p-3 text-xs dark:bg-slate-950"
        >/claude-usage-reporter:usage-config set usageEndpoint {{ endpoint }}
/claude-usage-reporter:usage-config set usageAuthType Header
/claude-usage-reporter:usage-config set usageHeaderValue {{ freshToken }}</pre>
        <template v-else>
          <div class="mt-1">
            <label class="label" for="setup-project">Project (repo/directory name)</label>
            <input
              id="setup-project"
              v-model="projectName"
              class="input"
              placeholder="client"
            />
          </div>
          <pre class="mt-2 overflow-x-auto rounded bg-white p-3 text-xs dark:bg-slate-950"
            >/claude-usage-reporter:usage-config set {{ projectKeyArg('usageEndpoint') }} {{ endpoint }}
/claude-usage-reporter:usage-config set {{ projectKeyArg('usageAuthType') }} Header
/claude-usage-reporter:usage-config set {{ projectKeyArg('usageHeaderValue') }} {{ freshToken }}</pre>
          <p class="mt-1 text-xs text-emerald-900 dark:text-emerald-300">
            Requires claude-usage-reporter v0.2.0 or later — run
            <code class="rounded bg-white px-1 dark:bg-slate-950">/plugin</code> to check for an
            update. The key only needs quoting when
            <code class="rounded bg-white px-1 dark:bg-slate-950">&lt;project&gt;</code> contains a
            space — the shell would otherwise split it into extra arguments.
            It must match your project's real name exactly — case, spaces, everything. Run
            <code class="rounded bg-white px-1 dark:bg-slate-950">/claude-usage-reporter:usage-config</code>
            with no arguments from inside that project; the terminal report's
            <code class="rounded bg-white px-1 dark:bg-slate-950">[project-name] ...</code> line shows
            the exact string to use.
          </p>
        </template>
      </div>

      <button class="btn-secondary" @click="clearFreshToken(freshTokenId)">Done</button>
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
