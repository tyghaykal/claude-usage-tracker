import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { api, refresh, setAccessToken } from '../api';
import type { User } from '../types';

interface AuthResponse {
  accessToken: string;
  user: User;
}

export const useAuthStore = defineStore('auth', () => {
  const user = ref<User | null>(null);
  const ready = ref(false);

  const isAuthenticated = computed(() => user.value !== null);
  const isAdmin = computed(() => user.value?.role === 'admin');

  async function login(email: string, password: string): Promise<void> {
    const res = await api<AuthResponse>('/auth/login', {
      method: 'POST',
      body: { email, password },
    });
    setAccessToken(res.accessToken);
    user.value = res.user;
  }

  async function bootstrapAdmin(name: string, email: string, password: string): Promise<void> {
    await api('/auth/bootstrap-admin', { method: 'POST', body: { name, email, password } });
    await login(email, password);
  }

  async function needsBootstrap(): Promise<boolean> {
    const res = await api<{ needsBootstrap: boolean }>('/auth/bootstrap-status');
    return res.needsBootstrap;
  }

  /**
   * Called once at startup. The access token lives only in memory, so a page
   * reload always begins by trading the httpOnly refresh cookie for a new one.
   */
  async function restore(): Promise<void> {
    if (await refresh()) {
      const res = await api<{ user: User }>('/me');
      user.value = res.user;
    }
    ready.value = true;
  }

  async function logout(): Promise<void> {
    await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
    setAccessToken(null);
    user.value = null;
  }

  function setUser(next: User): void {
    user.value = next;
  }

  return {
    user,
    ready,
    isAuthenticated,
    isAdmin,
    login,
    logout,
    restore,
    setUser,
    bootstrapAdmin,
    needsBootstrap,
  };
});
