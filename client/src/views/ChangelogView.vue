<script setup lang="ts"></script>

<template>
  <div class="mx-auto max-w-3xl space-y-6 px-4 py-10">
    <div>
      <h1 class="text-xl font-semibold">Changelog</h1>
      <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">Notable changes to Claude Usage Tracker.</p>
    </div>

    <section class="card space-y-3">
      <h2 class="font-semibold text-slate-900 dark:text-slate-100">v0.2.0 <span class="font-normal text-slate-400 dark:text-slate-500">— current</span></h2>
      <ul class="list-disc space-y-1.5 pl-5 text-sm text-slate-600 dark:text-slate-400">
        <li>Admins can now delete a non-admin user from the Users page; an admin account must be demoted first.</li>
        <li>New Audit log page (admin-only) recording user creation, deletion, role changes, and password resets/changes.</li>
      </ul>
    </section>

    <section class="card space-y-3">
      <h2 class="font-semibold text-slate-900 dark:text-slate-100">v0.1.4</h2>
      <ul class="list-disc space-y-1.5 pl-5 text-sm text-slate-600 dark:text-slate-400">
        <li>Fixed a build-breaking type error in cost recalculation (<code class="rounded bg-slate-100 px-1 dark:bg-slate-700">POST /api/usage-logs/recalculate-cost</code>) introduced by a stricter pricing lookup type.</li>
      </ul>
    </section>

    <section class="card space-y-3">
      <h2 class="font-semibold text-slate-900 dark:text-slate-100">v0.1.3</h2>
      <ul class="list-disc space-y-1.5 pl-5 text-sm text-slate-600 dark:text-slate-400">
        <li>Admins can export the entire database to a zip file, and restore it later by uploading that zip back — see the new Backup page.</li>
        <li>The navigation collapses into a mobile menu on small screens, and a few narrow-viewport layout overflows were fixed.</li>
      </ul>
    </section>

    <section class="card space-y-3">
      <h2 class="font-semibold text-slate-900 dark:text-slate-100">v0.1.2</h2>
      <ul class="list-disc space-y-1.5 pl-5 text-sm text-slate-600 dark:text-slate-400">
        <li>Confirmation prompts (delete, revoke) use an in-app dialog instead of the browser's native popup.</li>
        <li>Actions like copying a token now show a toast notification in the top-right corner.</li>
        <li>Fixed: the "copy this token" card kept showing a token's value and setup commands after that token was revoked or deleted.</li>
      </ul>
    </section>

    <section class="card space-y-3">
      <h2 class="font-semibold text-slate-900 dark:text-slate-100">v0.1.1</h2>
      <ul class="list-disc space-y-1.5 pl-5 text-sm text-slate-600 dark:text-slate-400">
        <li>Light and dark themes, with a one-click toggle; light is the default.</li>
        <li>API tokens are now <code class="rounded bg-slate-100 px-1 dark:bg-slate-700">sk-…</code>-prefixed, matching common AI-provider key formats.</li>
        <li>The API tokens page shows setup commands for both a machine-wide (global) and a per-project reporter configuration (requires claude-usage-reporter v0.2.0+).</li>
        <li>The dashboard's "Top projects" chart now shows a project's configured label instead of its raw repo/directory name, when one is set.</li>
        <li>The log detail popup has a raw-payload viewer (🐛) showing the exact JSON this app received at ingestion.</li>
        <li>Docker now publishes ports on <code class="rounded bg-slate-100 px-1 dark:bg-slate-700">127.0.0.1</code> by default instead of all network interfaces; override with <code class="rounded bg-slate-100 px-1 dark:bg-slate-700">BIND_HOST</code>.</li>
        <li>Favicon added.</li>
      </ul>
    </section>

    <section class="card space-y-3">
      <h2 class="font-semibold text-slate-900 dark:text-slate-100">v0.1.0</h2>
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
