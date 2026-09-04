<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';

const auth = useAuthStore();
const router = useRouter();
const route = useRoute();

const email = ref('');
const password = ref('');
const error = ref('');
const busy = ref(false);

onMounted(async () => {
  if (await auth.needsBootstrap().catch(() => false)) await router.replace({ name: 'setup' });
});

async function submit() {
  busy.value = true;
  error.value = '';
  try {
    await auth.login(email.value, password.value);
    await router.push((route.query.next as string) || { name: 'dashboard' });
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Sign-in failed';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="flex min-h-full items-center justify-center px-4 py-12">
    <form class="card w-full max-w-sm space-y-4" @submit.prevent="submit">
      <div>
        <h1 class="text-lg font-semibold">Sign in</h1>
        <p class="mt-1 text-sm text-stone-500 dark:text-stone-400">Claude Usage Tracker</p>
      </div>

      <div>
        <label class="label" for="email">Email</label>
        <input id="email" v-model="email" class="input" type="email" required autocomplete="username" />
      </div>

      <div>
        <label class="label" for="password">Password</label>
        <input
          id="password"
          v-model="password"
          class="input"
          type="password"
          required
          autocomplete="current-password"
        />
      </div>

      <p v-if="error" class="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">{{ error }}</p>

      <button class="btn-primary w-full" type="submit" :disabled="busy">
        {{ busy ? 'Signing in…' : 'Sign in' }}
      </button>

      <!-- FR-2: there is deliberately no self-service reset link. -->
      <p class="text-center text-xs text-stone-500 dark:text-stone-400">
        Forgot your password? Ask an admin to reset it, or run
        <code class="rounded bg-stone-100 px-1 dark:bg-stone-700">cli reset-password</code> on the server.
      </p>
      <p class="flex justify-center gap-3 text-center text-xs text-stone-400 dark:text-stone-500">
        <span>v0.1.2</span>
        <RouterLink :to="{ name: 'changelog' }" class="hover:text-stone-600 dark:hover:text-stone-300">Changelog</RouterLink>
        <RouterLink :to="{ name: 'privacy' }" class="hover:text-stone-600 dark:hover:text-stone-300">Privacy &amp; data</RouterLink>
      </p>
    </form>
  </div>
</template>
