<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { api } from '../api';
import { formatDateTime } from '../format';
import type { Role, User } from '../types';

const users = ref<User[]>([]);
const error = ref('');
const notice = ref('');

const form = reactive({ name: '', email: '', password: '', role: 'user' as Role });
const resetting = reactive({ id: '', password: '' });

async function load() {
  users.value = (await api<{ users: User[] }>('/users')).users;
}
onMounted(load);

async function create() {
  error.value = '';
  notice.value = '';
  try {
    await api('/users', { method: 'POST', body: { ...form } });
    notice.value = `Created ${form.email}. Give them the password you just set — they can change it from their profile.`;
    Object.assign(form, { name: '', email: '', password: '', role: 'user' });
    await load();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not create the user';
  }
}

async function setRole(user: User, role: Role) {
  error.value = '';
  try {
    await api(`/users/${user.id}`, { method: 'PATCH', body: { role } });
    await load();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not change the role';
  }
}

async function resetPassword() {
  error.value = '';
  notice.value = '';
  try {
    await api(`/users/${resetting.id}`, { method: 'PATCH', body: { password: resetting.password } });
    notice.value = 'Password reset. Pass it to them over a channel you trust.';
    Object.assign(resetting, { id: '', password: '' });
    await load();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not reset the password';
  }
}
</script>

<template>
  <div class="space-y-4">
    <h1 class="text-xl font-semibold">Users</h1>

    <p v-if="error" class="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">{{ error }}</p>
    <p v-if="notice" class="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
      {{ notice }}
    </p>

    <form class="card grid gap-3 sm:grid-cols-2 lg:grid-cols-5" @submit.prevent="create">
      <div>
        <label class="label" for="u-name">Name</label>
        <input id="u-name" v-model="form.name" class="input" required />
      </div>
      <div>
        <label class="label" for="u-email">Email</label>
        <input id="u-email" v-model="form.email" class="input" type="email" required />
      </div>
      <div>
        <label class="label" for="u-password">Initial password</label>
        <input
          id="u-password"
          v-model="form.password"
          class="input"
          type="text"
          minlength="8"
          required
        />
      </div>
      <div>
        <label class="label" for="u-role">Role</label>
        <select id="u-role" v-model="form.role" class="input">
          <option value="user">User</option>
          <option value="admin">Admin</option>
        </select>
      </div>
      <div class="flex items-end">
        <button class="btn-primary w-full" type="submit">Add user</button>
      </div>
    </form>

    <div class="card overflow-x-auto p-0">
      <table class="min-w-full divide-y divide-slate-200 dark:divide-slate-700">
        <thead class="bg-slate-50 dark:bg-slate-700">
          <tr>
            <th class="th">Name</th>
            <th class="th">Email</th>
            <th class="th">Role</th>
            <th class="th">Created</th>
            <th class="th"></th>
          </tr>
        </thead>
        <tbody class="divide-y divide-slate-100 dark:divide-slate-700">
          <tr v-for="u in users" :key="u.id">
            <td class="td font-medium">{{ u.name }}</td>
            <td class="td">{{ u.email }}</td>
            <td class="td">
              <select
                class="input py-1"
                :value="u.role"
                @change="setRole(u, ($event.target as HTMLSelectElement).value as Role)"
              >
                <option value="user">User</option>
                <option value="admin">Admin</option>
              </select>
            </td>
            <td class="td whitespace-nowrap">{{ formatDateTime(u.createdAt) }}</td>
            <td class="td text-right">
              <button class="btn-secondary" @click="resetting.id = u.id">Reset password</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <p class="text-xs text-slate-500 dark:text-slate-400">
      The last remaining admin cannot be demoted. If every admin is locked out, run
      <code class="rounded bg-slate-100 px-1 dark:bg-slate-800">cli reset-password</code> on the server.
    </p>

    <div
      v-if="resetting.id"
      class="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
      @click.self="resetting.id = ''"
    >
      <form class="card w-full max-w-sm space-y-3" @submit.prevent="resetPassword">
        <h2 class="text-sm font-semibold">Set a new password</h2>
        <input
          v-model="resetting.password"
          class="input"
          type="text"
          minlength="8"
          required
          placeholder="At least 8 characters"
        />
        <div class="flex gap-2">
          <button class="btn-primary" type="submit">Reset</button>
          <button class="btn-secondary" type="button" @click="resetting.id = ''">Cancel</button>
        </div>
      </form>
    </div>
  </div>
</template>
