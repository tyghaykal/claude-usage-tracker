<script setup lang="ts">
import {
  ArcElement,
  BarElement,
  CategoryScale,
  Chart,
  Legend,
  LineElement,
  LinearScale,
  PointElement,
  Tooltip,
} from 'chart.js';
import { computed, onMounted, ref, watch, watchEffect } from 'vue';
import { Bar, Doughnut, Line } from 'vue-chartjs';
import { api, dayToIso, toQuery } from '../api';
import UsageFilters, { type FilterModel } from '../components/UsageFilters.vue';
import { useRealtime } from '../composables/useRealtime';
import { useTheme } from '../composables/useTheme';
import { formatCost, formatTokens } from '../format';
import type { DashboardSummary, UserDirectoryEntry } from '../types';

Chart.register(
  CategoryScale,
  LinearScale,
  BarElement,
  LineElement,
  PointElement,
  ArcElement,
  Tooltip,
  Legend,
);

const { theme } = useTheme();
// Chart.js defaults are read once per chart instance, so flip them before the
// `:key="theme"` below forces every chart to remount on a theme change.
watchEffect(() => {
  Chart.defaults.color = theme.value === 'dark' ? '#cbd5e1' : '#334155';
  Chart.defaults.borderColor = theme.value === 'dark' ? '#334155' : '#e2e8f0';
});

const filters = ref<FilterModel>({ project: '', userId: '', model: '', dateFrom: '', dateTo: '' });
const summary = ref<DashboardSummary | null>(null);
const loading = ref(true);
const error = ref('');
const userNames = ref(new Map<string, string>());

const PALETTE = ['#0f172a', '#2563eb', '#059669', '#d97706', '#dc2626', '#7c3aed', '#0891b2'];
const chartOptions = { responsive: true, maintainAspectRatio: false };

async function load() {
  loading.value = true;
  error.value = '';
  try {
    summary.value = await api<DashboardSummary>(
      `/dashboard/summary${toQuery({
        project: filters.value.project || undefined,
        userId: filters.value.userId || undefined,
        model: filters.value.model || undefined,
        dateFrom: dayToIso(filters.value.dateFrom),
        dateTo: dayToIso(filters.value.dateTo, true),
      })}`,
    );
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not load the dashboard';
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  await load();
  const list = await api<{ users: UserDirectoryEntry[] }>('/me/directory');
  userNames.value = new Map(list.users.map((u) => [u.id, u.name]));
});
watch(filters, () => void load());
// New usage rows or a recalculation elsewhere update this page without a manual refresh.
useRealtime(() => void load());

const tiles = computed(() => {
  const t = summary.value?.totals;
  return [
    { label: 'Prompts', value: formatTokens(t?.prompts ?? 0) },
    { label: 'Total tokens', value: formatTokens(t?.totalTokens ?? 0) },
    { label: 'Estimated cost', value: formatCost(t?.estimatedCostUsd ?? 0) },
    { label: 'Output tokens', value: formatTokens(t?.outputTokens ?? 0) },
  ];
});

const overTime = computed(() => ({
  labels: summary.value?.byDay.map((d) => d.key ?? '—') ?? [],
  datasets: [
    {
      label: 'Total tokens',
      data: summary.value?.byDay.map((d) => d.totalTokens) ?? [],
      borderColor: PALETTE[1],
      backgroundColor: 'rgba(37, 99, 235, 0.12)',
      fill: true,
      tension: 0.3,
    },
  ],
}));

const costOverTime = computed(() => ({
  labels: summary.value?.byDay.map((d) => d.key ?? '—') ?? [],
  datasets: [
    {
      label: 'Estimated cost',
      data: summary.value?.byDay.map((d) => d.estimatedCostUsd) ?? [],
      backgroundColor: PALETTE[2],
    },
  ],
}));

const byModel = computed(() => {
  const rows = summary.value?.byModel ?? [];
  return {
    labels: rows.map((r) => r.key ?? 'unreported'),
    datasets: [
      {
        data: rows.map((r) => r.totalTokens),
        backgroundColor: rows.map((_, i) => PALETTE[i % PALETTE.length]),
      },
    ],
  };
});

const byProject = computed(() => {
  const rows = (summary.value?.byProject ?? []).slice(0, 10);
  return {
    labels: rows.map((r) => r.label || r.key || '—'),
    datasets: [
      {
        label: 'Total tokens',
        data: rows.map((r) => r.totalTokens),
        backgroundColor: PALETTE[0],
      },
    ],
  };
});

const topUsers = computed(() => (summary.value?.byUser ?? []).slice(0, 10));
const hasData = computed(() => (summary.value?.totals.prompts ?? 0) > 0);
</script>

<template>
  <div class="space-y-4">
    <h1 class="text-xl font-semibold">Dashboard</h1>

    <UsageFilters v-model="filters" />

    <p v-if="error" class="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">{{ error }}</p>
    <p v-else-if="loading" class="card text-sm text-slate-500 dark:text-slate-400">Loading…</p>

    <template v-else>
      <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div v-for="tile in tiles" :key="tile.label" class="card">
          <div class="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">{{ tile.label }}</div>
          <div class="mt-1 text-2xl font-semibold">{{ tile.value }}</div>
        </div>
      </div>

      <div v-if="!hasData" class="card text-sm text-slate-600 dark:text-slate-400">
        <p class="font-medium">No usage recorded yet.</p>
        <p class="mt-1">
          Create an API token, then point the plugin at this server with
          <code class="rounded bg-slate-100 px-1 dark:bg-slate-700">/claude-usage-reporter:usage-config set usageEndpoint …</code>
        </p>
      </div>

      <template v-else>
        <div class="grid gap-4 lg:grid-cols-2">
          <div class="card">
            <h2 class="mb-3 text-sm font-semibold">Tokens over time</h2>
            <div class="h-64"><Line :key="theme" :data="overTime" :options="chartOptions" /></div>
          </div>
          <div class="card">
            <h2 class="mb-3 text-sm font-semibold">Estimated cost over time</h2>
            <div class="h-64"><Bar :key="theme" :data="costOverTime" :options="chartOptions" /></div>
          </div>
          <div class="card">
            <h2 class="mb-3 text-sm font-semibold">Tokens by model</h2>
            <div class="h-64"><Doughnut :key="theme" :data="byModel" :options="chartOptions" /></div>
          </div>
          <div class="card">
            <h2 class="mb-3 text-sm font-semibold">Top projects</h2>
            <div class="h-64"><Bar :key="theme" :data="byProject" :options="chartOptions" /></div>
          </div>
        </div>

        <div class="card overflow-x-auto p-0">
          <h2 class="px-5 pt-5 text-sm font-semibold">Top developers</h2>
          <table class="mt-3 min-w-full divide-y divide-slate-200 dark:divide-slate-700">
            <thead class="bg-slate-50 dark:bg-slate-700">
              <tr>
                <th class="th">Developer</th>
                <th class="th text-right">Prompts</th>
                <th class="th text-right">Total tokens</th>
                <th class="th text-right">Estimated cost</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100 dark:divide-slate-700">
              <tr v-for="row in topUsers" :key="row.key ?? 'unknown'">
                <td class="td">{{ userNames.get(row.key ?? '') ?? (row.key ?? '—').slice(-6) }}</td>
                <td class="td text-right">{{ formatTokens(row.prompts) }}</td>
                <td class="td text-right">{{ formatTokens(row.totalTokens) }}</td>
                <td class="td text-right">{{ formatCost(row.estimatedCostUsd) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </template>
  </div>
</template>
