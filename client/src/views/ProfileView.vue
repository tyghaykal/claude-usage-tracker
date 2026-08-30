<script setup lang="ts">
import { ref } from 'vue';
import { api } from '../api';
import { useAuthStore } from '../stores/auth';
import type { User } from '../types';

const auth = useAuthStore();

const name = ref(auth.user?.name ?? '');
const currentPassword = ref('');
const newPassword = ref('');
const error = ref('');
const notice = ref('');

async function save() {
  error.value = '';
  notice.value = '';
  const body: Record<string, string> = {};
  if (name.value && name.value !== auth.user?.name) body.name = name.value;
  if (newPassword.value) {
    body.currentPassword = currentPassword.value;
    body.newPassword = newPassword.value;
  }
  if (Object.keys(body).length === 0) {
    error.value = 'Change your name or set a new password first.';
    return;
  }
  try {
    const res = await api<{ user: User }>('/me', { method: 'PATCH', body });
    auth.setUser(res.user);
    currentPassword.value = '';
    newPassword.value = '';
    notice.value = 'Profile updated.';
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not update your profile';
  }
}
</script>

<template>
  <div class="max-w-lg space-y-4">
    <h1 class="text-xl font-semibold">Your profile</h1>

    <form class="card space-y-4" @submit.prevent="save">
      <div>
        <label class="label" for="email">Email</label>
        <input id="email" class="input bg-slate-50 dark:bg-slate-700" :value="auth.user?.email" disabled />
        <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">
          Email and role are managed by an admin.
        </p>
      </div>

      <div>
        <label class="label" for="name">Name</label>
        <input id="name" v-model="name" class="input" />
      </div>

      <fieldset class="space-y-3 border-t border-slate-200 pt-4 dark:border-slate-700">
        <legend class="text-sm font-semibold">Change password</legend>
        <div>
          <label class="label" for="current">Current password</label>
          <input
            id="current"
            v-model="currentPassword"
            class="input"
            type="password"
            autocomplete="current-password"
          />
        </div>
        <div>
          <label class="label" for="new">New password</label>
          <input
            id="new"
            v-model="newPassword"
            class="input"
            type="password"
            minlength="8"
            autocomplete="new-password"
          />
          <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">At least 8 characters. Leave blank to keep it.</p>
        </div>
      </fieldset>

      <p v-if="error" class="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">{{ error }}</p>
      <p v-if="notice" class="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
        {{ notice }}
      </p>

      <button class="btn-primary" type="submit">Save changes</button>
    </form>
  </div>
</template>
