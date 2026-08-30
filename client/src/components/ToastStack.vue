<script setup lang="ts">
import { useToast } from '../composables/useToast';

const { toasts, dismiss } = useToast();
</script>

<template>
  <div class="pointer-events-none fixed right-4 top-4 z-[60] flex w-full max-w-xs flex-col gap-2">
    <TransitionGroup
      enter-active-class="transition duration-150 ease-out"
      enter-from-class="opacity-0 -translate-y-1"
      leave-active-class="transition duration-150 ease-in"
      leave-to-class="opacity-0"
    >
      <div
        v-for="toast in toasts"
        :key="toast.id"
        class="pointer-events-auto cursor-pointer rounded-md border px-3 py-2 text-sm shadow-md"
        :class="
          toast.kind === 'error'
            ? 'border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-300'
            : 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'
        "
        @click="dismiss(toast.id)"
      >
        {{ toast.message }}
      </div>
    </TransitionGroup>
  </div>
</template>
