<script setup lang="ts"></script>

<template>
  <div class="mx-auto max-w-3xl space-y-6 px-4 py-10">
    <div>
      <h1 class="text-xl font-semibold">Changelog</h1>
      <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">Notable changes to Claude Usage Tracker.</p>
    </div>

    <section class="card space-y-3">
      <h2 class="font-semibold text-slate-900 dark:text-slate-100">v0.1.0 <span class="font-normal text-slate-400 dark:text-slate-500">— current</span></h2>
      <p class="text-sm text-slate-600 dark:text-slate-400">Initial release.</p>
      <ul class="list-disc space-y-1.5 pl-5 text-sm text-slate-600 dark:text-slate-400">
        <li>Usage ingestion from the <code class="rounded bg-slate-100 px-1 dark:bg-slate-700">claude-usage-reporter</code> plugin via per-user, revocable API tokens.</li>
        <li>Filterable usage log (project, developer, model, date range) with a per-prompt detail view.</li>
        <li>Dashboard with usage over time, by model, and by project.</li>
        <li>Per-model pricing, snapshotted on each record at ingestion time; on-demand bulk recalculation against current rates.</li>
        <li>Optional admin-only AI-assisted price lookup, with a manual review step before anything is saved.</li>
        <li>Admin user management and CLI-based password recovery (no self-service reset, by design).</li>
        <li>Privacy &amp; data handling page.</li>
      </ul>
    </section>
  </div>
</template>
