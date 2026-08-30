import { reactive } from 'vue';

interface ConfirmOptions {
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Styles the confirm button as destructive (red) instead of primary. */
  danger?: boolean;
}

interface ConfirmState extends Required<ConfirmOptions> {
  open: boolean;
  message: string;
  resolve: (value: boolean) => void;
}

/** Module-level state: one dialog, rendered once in App.vue, driven from anywhere. */
const state = reactive<ConfirmState>({
  open: false,
  title: 'Are you sure?',
  message: '',
  confirmLabel: 'Confirm',
  cancelLabel: 'Cancel',
  danger: false,
  resolve: () => {},
});

function confirm(message: string, options: ConfirmOptions = {}): Promise<boolean> {
  state.open = true;
  state.message = message;
  state.title = options.title ?? 'Are you sure?';
  state.confirmLabel = options.confirmLabel ?? (options.danger ? 'Delete' : 'Confirm');
  state.cancelLabel = options.cancelLabel ?? 'Cancel';
  state.danger = options.danger ?? false;
  return new Promise((resolve) => {
    state.resolve = resolve;
  });
}

function settle(result: boolean) {
  state.open = false;
  state.resolve(result);
}

export function useConfirmDialog() {
  return { state, confirm, settle };
}
