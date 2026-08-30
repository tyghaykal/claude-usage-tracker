<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';

const auth = useAuthStore();
const router = useRouter();

const name = ref('');
const email = ref('');
const password = ref('');
const error = ref('');
const busy = ref(false);
const checked = ref(false);

// FR-1: this screen exists only while there is no admin. If one already
// exists, the endpoint behind it is closed anyway — so don't even show the form.
onMounted(async () => {
  if (!(await auth.needsBootstrap().catch(() => false))) {
    await router.replace({ name: 'login' });
    return;
  }
  checked.value = true;
});

async function submit() {
  busy.value = true;
  error.value = '';
  try {
    await auth.bootstrapAdmin(name.value, email.value, password.value);
    await router.push({ name: 'dashboard' });
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not create the admin account';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div v-if="checked" class="flex min-h-full items-center justify-center px-4 py-12">
    <form class="card w-full max-w-sm space-y-4" @submit.prevent="submit">
      <div>
        <h1 class="text-lg font-semibold">Create the admin account</h1>
        <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">
          First run. This form closes permanently once an admin exists.
        </p>
      </div>

      <div>
        <label class="label" for="name">Name</label>
        <input id="name" v-model="name" class="input" required />
      </div>

      <div>
        <label class="label" for="email">Email</label>
        <input id="email" v-model="email" class="input" type="email" required />
      </div>

      <div>
        <label class="label" for="password">Password</label>
        <input
          id="password"
          v-model="password"
          class="input"
          type="password"
          required
          minlength="8"
          autocomplete="new-password"
        />
        <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">At least 8 characters.</p>
      </div>

      <p v-if="error" class="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">{{ error }}</p>

      <button class="btn-primary w-full" type="submit" :disabled="busy">
        {{ busy ? 'Creating…' : 'Create admin account' }}
      </button>
    </form>
  </div>
</template>
