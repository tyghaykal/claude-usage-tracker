<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router';
import ConfirmDialog from './components/ConfirmDialog.vue';
import ToastStack from './components/ToastStack.vue';
import { useTheme } from './composables/useTheme';
import { useAuthStore } from './stores/auth';

const auth = useAuthStore();
const route = useRoute();
const router = useRouter();
const { theme, toggle: toggleTheme } = useTheme();

const chromeless = computed(() => route.name === 'login' || route.name === 'setup');

const links = computed(() => [
  { name: 'dashboard', label: 'Dashboard' },
  { name: 'logs', label: 'Usage logs' },
  { name: 'models', label: 'Model pricing' },
  { name: 'tokens', label: 'API tokens' },
  ...(auth.isAdmin
    ? [
        { name: 'users', label: 'Users' },
        { name: 'ai-providers', label: 'AI providers' },
        { name: 'backup', label: 'Backup' },
      ]
    : []),
]);

// A row of nav pills for every link doesn't fit a phone width — collapsed
// behind this toggle below `sm`, and closed again whenever the route changes.
const mobileMenuOpen = ref(false);
watch(() => route.fullPath, () => {
  mobileMenuOpen.value = false;
});

async function signOut() {
  await auth.logout();
  await router.push({ name: 'login' });
}
</script>

<template>
  <div v-if="chromeless" class="relative h-full">
    <button
      class="absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-md border border-slate-300 bg-white text-base hover:bg-slate-100 dark:border-slate-600 dark:bg-slate-900 dark:hover:bg-slate-700"
      title="Toggle theme"
      @click="toggleTheme"
    >
      {{ theme === 'dark' ? '☀️' : '🌙' }}
    </button>
    <RouterView />
  </div>

  <div v-else class="min-h-full">
    <header class="border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <div class="mx-auto flex max-w-7xl items-center gap-4 px-4 py-3">
        <RouterLink :to="{ name: 'dashboard' }" class="text-sm font-semibold text-slate-900 dark:text-slate-100">
          Claude Usage Tracker
        </RouterLink>
        <nav class="hidden flex-wrap gap-1 sm:flex">
          <RouterLink
            v-for="link in links"
            :key="link.name"
            :to="{ name: link.name }"
            class="rounded-md px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
            active-class="bg-slate-900 text-white hover:bg-slate-700 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-slate-300"
          >
            {{ link.label }}
          </RouterLink>
        </nav>
        <div class="ml-auto hidden items-center gap-3 sm:flex">
          <RouterLink
            :to="{ name: 'profile' }"
            class="text-sm text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100"
          >
            {{ auth.user?.name }}
            <span v-if="auth.isAdmin" class="badge ml-1 bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300">admin</span>
          </RouterLink>
          <button
            class="flex h-9 w-9 items-center justify-center rounded-md border border-slate-300 bg-white text-base hover:bg-slate-100 dark:border-slate-600 dark:bg-slate-900 dark:hover:bg-slate-700"
            title="Toggle theme"
            @click="toggleTheme"
          >
            {{ theme === 'dark' ? '☀️' : '🌙' }}
          </button>
          <button class="btn-secondary" @click="signOut">Sign out</button>
        </div>

        <button
          class="ml-auto flex h-9 w-9 items-center justify-center rounded-md border border-slate-300 bg-white text-base hover:bg-slate-100 dark:border-slate-600 dark:bg-slate-900 dark:hover:bg-slate-700 sm:hidden"
          :aria-expanded="mobileMenuOpen"
          aria-label="Toggle menu"
          @click="mobileMenuOpen = !mobileMenuOpen"
        >
          {{ mobileMenuOpen ? '✕' : '☰' }}
        </button>
      </div>

      <div v-if="mobileMenuOpen" class="border-t border-slate-200 px-4 py-3 dark:border-slate-800 sm:hidden">
        <nav class="flex flex-col gap-1">
          <RouterLink
            v-for="link in links"
            :key="link.name"
            :to="{ name: link.name }"
            class="rounded-md px-3 py-2 text-sm text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
            active-class="bg-slate-900 text-white hover:bg-slate-700 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-slate-300"
          >
            {{ link.label }}
          </RouterLink>
        </nav>
        <div class="mt-3 flex items-center justify-between border-t border-slate-200 pt-3 dark:border-slate-800">
          <RouterLink
            :to="{ name: 'profile' }"
            class="text-sm text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100"
          >
            {{ auth.user?.name }}
            <span v-if="auth.isAdmin" class="badge ml-1 bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300">admin</span>
          </RouterLink>
          <div class="flex items-center gap-2">
            <button
              class="flex h-9 w-9 items-center justify-center rounded-md border border-slate-300 bg-white text-base hover:bg-slate-100 dark:border-slate-600 dark:bg-slate-900 dark:hover:bg-slate-700"
              title="Toggle theme"
              @click="toggleTheme"
            >
              {{ theme === 'dark' ? '☀️' : '🌙' }}
            </button>
            <button class="btn-secondary" @click="signOut">Sign out</button>
          </div>
        </div>
      </div>
    </header>

    <main class="mx-auto max-w-7xl px-4 py-6">
      <RouterView />
    </main>

    <footer class="mx-auto flex max-w-7xl justify-center gap-4 px-4 pb-6 text-xs text-slate-400 dark:text-slate-500">
      <span>v0.1.3</span>
      <RouterLink :to="{ name: 'changelog' }" class="hover:text-slate-600 dark:hover:text-slate-300">Changelog</RouterLink>
      <RouterLink :to="{ name: 'privacy' }" class="hover:text-slate-600 dark:hover:text-slate-300">Privacy &amp; data</RouterLink>
    </footer>
  </div>

  <ConfirmDialog />
  <ToastStack />
</template>
