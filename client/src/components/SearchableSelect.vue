<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { onClickOutside } from '../composables/onClickOutside';

/**
 * A combobox: click opens a dropdown of `options`, typing filters it, and the
 * value can only become one of `options` (or empty) — unlike a plain
 * <input list> + <datalist>, free text is not accepted as a final value.
 */
defineOptions({ inheritAttrs: false });

export interface SearchableSelectOption {
  value: string;
  label: string;
}

const props = defineProps<{
  modelValue: string;
  /** A plain string is shorthand for `{ value: s, label: s }`. */
  options: (string | SearchableSelectOption)[];
  placeholder?: string;
  /** Shown as the first, always-present option. */
  anyLabel?: string;
  /** Forwarded to the inner <input> so a <label for="…"> targets it. */
  id?: string;
}>();
const emit = defineEmits<{ 'update:modelValue': [string] }>();

const open = ref(false);
const query = ref('');
const root = ref<HTMLElement | null>(null);
const inputEl = ref<HTMLInputElement | null>(null);

const normalized = computed<SearchableSelectOption[]>(() =>
  props.options.map((o) => (typeof o === 'string' ? { value: o, label: o } : o)),
);

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return normalized.value;
  return normalized.value.filter((o) => o.label.toLowerCase().includes(q));
});

function displayValue(): string {
  return normalized.value.find((o) => o.value === props.modelValue)?.label ?? props.modelValue;
}

function openDropdown() {
  open.value = true;
  query.value = '';
}

function choose(value: string) {
  emit('update:modelValue', value);
  query.value = '';
  open.value = false;
}

function onInput(event: Event) {
  query.value = (event.target as HTMLInputElement).value;
  open.value = true;
}

async function onFocus() {
  openDropdown();
  await nextTick();
  inputEl.value?.select();
}

onClickOutside(root, () => {
  open.value = false;
  query.value = '';
});
</script>

<template>
  <div ref="root" class="relative">
    <input
      :id="id"
      ref="inputEl"
      v-bind="$attrs"
      class="input pr-7"
      :value="open ? query : displayValue()"
      :placeholder="modelValue ? undefined : (placeholder ?? 'Any')"
      autocomplete="off"
      @focus="onFocus"
      @input="onInput"
      @keydown.escape="open = false"
    />
    <svg
      class="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-400 dark:text-stone-500"
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
    >
      <path
        fill-rule="evenodd"
        d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
        clip-rule="evenodd"
      />
    </svg>

    <ul
      v-if="open"
      class="absolute z-10 mt-1 max-h-56 w-full overflow-auto rounded-md border border-stone-200 bg-white py-1 text-sm shadow-lg dark:border-stone-800 dark:bg-stone-900"
    >
      <li
        class="cursor-pointer px-3 py-1.5 hover:bg-stone-100 dark:hover:bg-stone-800"
        :class="{ 'font-medium text-stone-900 dark:text-stone-100': modelValue === '' }"
        @mousedown.prevent="choose('')"
      >
        {{ anyLabel ?? 'Any' }}
      </li>
      <li v-if="filtered.length === 0" class="px-3 py-1.5 text-stone-400 dark:text-stone-500">No matches</li>
      <li
        v-for="opt in filtered"
        :key="opt.value"
        class="cursor-pointer px-3 py-1.5 hover:bg-stone-100 dark:hover:bg-stone-800"
        :class="{ 'font-medium text-stone-900 dark:text-stone-100': modelValue === opt.value }"
        @mousedown.prevent="choose(opt.value)"
      >
        {{ opt.label }}
      </li>
    </ul>
  </div>
</template>
