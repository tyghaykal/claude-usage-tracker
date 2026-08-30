<script setup lang="ts">
import { ref } from 'vue';
import { ApiError, getAccessToken } from '../api';
import { useConfirmDialog } from '../composables/useConfirmDialog';
import { useToast } from '../composables/useToast';

const { confirm } = useConfirmDialog();
const { notify } = useToast();
const exporting = ref(false);
const importing = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);

function authHeaders(): Record<string, string> {
  const token = getAccessToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

async function exportBackup() {
  exporting.value = true;
  try {
    const res = await fetch('/api/backup/export', { headers: authHeaders(), credentials: 'include' });
    if (!res.ok) throw new ApiError(res.status, `Export failed (${res.status})`);

    const blob = await res.blob();
    const disposition = res.headers.get('content-disposition') ?? '';
    const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? 'ai-usage-backup.zip';

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    notify('Backup downloaded');
  } catch (err) {
    notify(err instanceof Error ? err.message : 'Could not export the backup', 'error');
  } finally {
    exporting.value = false;
  }
}

function pickFile() {
  fileInput.value?.click();
}

async function importBackup(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;

  const ok = await confirm(
    'This replaces every collection present in the zip with its contents. Data not in the file is left untouched, but anything in a replaced collection is gone. This cannot be undone.',
    { title: 'Import backup?', confirmLabel: 'Import', danger: true },
  );
  if (!ok) return;

  importing.value = true;
  try {
    const res = await fetch('/api/backup/import', {
      method: 'POST',
      credentials: 'include',
      headers: { ...authHeaders(), 'content-type': 'application/zip' },
      body: await file.arrayBuffer(),
    });
    const payload = await res.json().catch(() => null);
    if (!res.ok) throw new Error(payload?.error ?? `Import failed (${res.status})`);
    notify('Backup imported');
  } catch (err) {
    notify(err instanceof Error ? err.message : 'Could not import the backup', 'error');
  } finally {
    importing.value = false;
  }
}
</script>

<template>
  <div class="space-y-4">
    <h1 class="text-xl font-semibold">Backup</h1>

    <div class="card space-y-2">
      <h2 class="text-sm font-semibold">Export</h2>
      <p class="text-sm text-slate-600 dark:text-slate-400">
        Downloads every collection (users, tokens, pricing, usage logs, projects, AI provider configs) as one zip file.
      </p>
      <button class="btn-primary" :disabled="exporting" @click="exportBackup">
        {{ exporting ? 'Exporting…' : 'Export database' }}
      </button>
    </div>

    <div class="card space-y-2">
      <h2 class="text-sm font-semibold">Import</h2>
      <p class="text-sm text-slate-600 dark:text-slate-400">
        Upload a zip previously produced by Export. Only collections present in the file are replaced.
      </p>
      <input ref="fileInput" type="file" accept=".zip" class="hidden" @change="importBackup" />
      <button class="btn-secondary" :disabled="importing" @click="pickFile">
        {{ importing ? 'Importing…' : 'Import database' }}
      </button>
    </div>
  </div>
</template>
