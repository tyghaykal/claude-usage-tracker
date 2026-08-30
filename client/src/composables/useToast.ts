import { reactive } from 'vue';

export type ToastKind = 'success' | 'error';

export interface Toast {
  id: number;
  message: string;
  kind: ToastKind;
}

/** Module-level state: one stack, rendered once in App.vue, pushed to from anywhere. */
const toasts = reactive<Toast[]>([]);
let nextId = 0;

function dismiss(id: number) {
  const index = toasts.findIndex((t) => t.id === id);
  if (index !== -1) toasts.splice(index, 1);
}

function notify(message: string, kind: ToastKind = 'success') {
  const id = nextId++;
  toasts.push({ id, message, kind });
  setTimeout(() => dismiss(id), 2500);
}

export function useToast() {
  return { toasts, notify, dismiss };
}
