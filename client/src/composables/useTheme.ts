import { ref, watchEffect } from 'vue';

type Theme = 'light' | 'dark';

/** Light is the default; dark is opt-in and only sticks once a viewer picks it. */
function preferredTheme(): Theme {
  return localStorage.getItem('theme') === 'dark' ? 'dark' : 'light';
}

/** Module-level ref: shared across every caller, no store plumbing needed. */
const theme = ref<Theme>(preferredTheme());

watchEffect(() => {
  document.documentElement.classList.toggle('dark', theme.value === 'dark');
  localStorage.setItem('theme', theme.value);
});

export function useTheme() {
  function toggle() {
    theme.value = theme.value === 'dark' ? 'light' : 'dark';
  }
  return { theme, toggle };
}
