<script setup lang="ts">
import { useConfirmDialog } from '../composables/useConfirmDialog';

const { state, settle } = useConfirmDialog();
</script>

<template>
  <div
    v-if="state.open"
    class="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
    @click.self="settle(false)"
    @keydown.escape="settle(false)"
  >
    <div class="card w-full max-w-sm space-y-4">
      <h2 class="text-sm font-semibold">{{ state.title }}</h2>
      <p class="text-sm text-slate-600 dark:text-slate-400">{{ state.message }}</p>
      <div class="flex justify-end gap-2">
        <button class="btn-secondary" @click="settle(false)">{{ state.cancelLabel }}</button>
        <button
          :class="state.danger ? 'btn-danger' : 'btn-primary'"
          @click="settle(true)"
        >
          {{ state.confirmLabel }}
        </button>
      </div>
    </div>
  </div>
</template>
