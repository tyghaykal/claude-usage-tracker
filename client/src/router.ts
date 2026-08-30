import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import { useAuthStore } from './stores/auth';

const routes: RouteRecordRaw[] = [
  { path: '/setup', name: 'setup', component: () => import('./views/SetupView.vue') },
  { path: '/login', name: 'login', component: () => import('./views/LoginView.vue') },
  {
    path: '/',
    name: 'dashboard',
    component: () => import('./views/DashboardView.vue'),
    meta: { auth: true },
  },
  {
    path: '/logs',
    name: 'logs',
    component: () => import('./views/LogsView.vue'),
    meta: { auth: true },
  },
  {
    path: '/models',
    name: 'models',
    component: () => import('./views/ModelsView.vue'),
    meta: { auth: true },
  },
  {
    path: '/tokens',
    name: 'tokens',
    component: () => import('./views/TokensView.vue'),
    meta: { auth: true },
  },
  {
    path: '/profile',
    name: 'profile',
    component: () => import('./views/ProfileView.vue'),
    meta: { auth: true },
  },
  {
    path: '/users',
    name: 'users',
    component: () => import('./views/UsersView.vue'),
    meta: { auth: true, admin: true },
  },
  {
    path: '/ai-providers',
    name: 'ai-providers',
    component: () => import('./views/AiProvidersView.vue'),
    meta: { auth: true, admin: true },
  },
  { path: '/privacy', name: 'privacy', component: () => import('./views/PrivacyView.vue') },
  { path: '/changelog', name: 'changelog', component: () => import('./views/ChangelogView.vue') },
  { path: '/:pathMatch(.*)*', redirect: '/' },
];

export const router = createRouter({ history: createWebHistory(), routes });

router.beforeEach(async (to) => {
  const auth = useAuthStore();
  if (!auth.ready) await auth.restore();

  if (to.meta.auth && !auth.isAuthenticated) {
    // No account at all yet? Send them to first-run setup, not to a login form
    // they cannot possibly satisfy.
    const needsBootstrap = await auth.needsBootstrap().catch(() => false);
    return needsBootstrap ? { name: 'setup' } : { name: 'login', query: { next: to.fullPath } };
  }
  if (to.meta.admin && !auth.isAdmin) return { name: 'dashboard' };
  if ((to.name === 'login' || to.name === 'setup') && auth.isAuthenticated) {
    return { name: 'dashboard' };
  }
  return true;
});
