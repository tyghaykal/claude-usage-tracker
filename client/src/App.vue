<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router';
import ConfirmDialog from './components/ConfirmDialog.vue';
import ToastStack from './components/ToastStack.vue';
import { onClickOutside } from './composables/onClickOutside';
import { useTheme } from './composables/useTheme';
import { useAuthStore } from './stores/auth';

const auth = useAuthStore();
const route = useRoute();
const router = useRouter();
const { theme, toggle: toggleTheme } = useTheme();

const chromeless = computed(() => route.name === 'login' || route.name === 'setup');

const mainLinks = [
  { name: 'dashboard', label: 'Dashboard' },
  { name: 'logs', label: 'Usage logs' },
  { name: 'models', label: 'Model pricing' },
  { name: 'tokens', label: 'API tokens' },
];
// Admin-only surfaces tucked behind one "Admin" dropdown so the top bar
// doesn't grow a pill per feature.
const adminLinks = [
  { name: 'users', label: 'Users' },
  { name: 'audit-log', label: 'Audit log' },
  { name: 'ai-providers', label: 'AI providers' },
  { name: 'backup', label: 'Backup' },
];
// The mobile menu stays a single flat list — collapsing behind a toggle
// already solves its space problem, so no need for a nested dropdown there.
const links = computed(() => [...mainLinks, ...(auth.isAdmin ? adminLinks : [])]);
const isAdminRoute = computed(() => adminLinks.some((l) => l.name === route.name));

const mobileMenuOpen = ref(false);
const adminMenuOpen = ref(false);
const adminMenuEl = ref<HTMLElement | null>(null);
onClickOutside(adminMenuEl, () => {
  adminMenuOpen.value = false;
});

// A row of nav pills for every link doesn't fit a phone width — collapsed
// behind this toggle below `sm`, and closed again whenever the route changes.
watch(() => route.fullPath, () => {
  mobileMenuOpen.value = false;
  adminMenuOpen.value = false;
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
        <nav class="hidden flex-wrap items-center gap-1 sm:flex">
          <RouterLink
            v-for="link in mainLinks"
            :key="link.name"
            :to="{ name: link.name }"
            class="rounded-md px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
            active-class="bg-slate-900 text-white hover:bg-slate-700 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-slate-300"
          >
            {{ link.label }}
          </RouterLink>
          <div v-if="auth.isAdmin" ref="adminMenuEl" class="relative">
            <button
              type="button"
              class="rounded-md px-3 py-1.5 text-sm"
              :class="isAdminRoute
                ? 'bg-slate-900 text-white hover:bg-slate-700 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-slate-300'
                : 'text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800'"
              :aria-expanded="adminMenuOpen"
              @click="adminMenuOpen = !adminMenuOpen"
            >
              Admin ▾
            </button>
            <div
              v-if="adminMenuOpen"
              class="absolute left-0 top-full z-10 mt-1 w-44 rounded-md border border-slate-200 bg-white py-1 shadow-lg dark:border-slate-700 dark:bg-slate-800"
            >
              <RouterLink
                v-for="link in adminLinks"
                :key="link.name"
                :to="{ name: link.name }"
                class="block px-3 py-2 text-sm text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-700"
                active-class="bg-slate-100 text-slate-900 dark:bg-slate-700 dark:text-slate-100"
              >
                {{ link.label }}
              </RouterLink>
            </div>
          </div>
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
      <span>v0.3.0</span>
      <RouterLink :to="{ name: 'changelog' }" class="hover:text-slate-600 dark:hover:text-slate-300">Changelog</RouterLink>
      <RouterLink :to="{ name: 'privacy' }" class="hover:text-slate-600 dark:hover:text-slate-300">Privacy &amp; data</RouterLink>
    </footer>
  </div>

  <ConfirmDialog />
  <ToastStack />
</template>
