<script setup lang="ts"></script>

<template>
  <div class="mx-auto max-w-3xl space-y-6 px-4 py-10">
    <div>
      <h1 class="text-xl font-semibold">Privacy &amp; data handling</h1>
      <p class="mt-1 text-sm text-stone-500 dark:text-stone-400">
        What this instance stores, where it goes, and how secrets are protected.
      </p>
    </div>

    <section class="card space-y-2">
      <h2 class="font-semibold text-stone-900 dark:text-stone-100">Self-hosted, not a shared service</h2>
      <p class="text-sm text-stone-600 dark:text-stone-400">
        This is a self-hosted deployment of Claude Usage Tracker. Your prompt logs, token counts,
        and account data are stored only in this instance's own MongoDB database. Nothing is sent
        to the project's maintainers or to any analytics or telemetry service — there is none built
        into this app.
      </p>
    </section>

    <section class="card space-y-2">
      <h2 class="font-semibold text-stone-900 dark:text-stone-100">What gets ingested</h2>
      <p class="text-sm text-stone-600 dark:text-stone-400">
        The <code class="rounded bg-stone-100 px-1 dark:bg-stone-700">claude-usage-reporter</code> plugin posts
        project, timestamp, session id, model, token counts, and (depending on that plugin's
        <code class="rounded bg-stone-100 px-1 dark:bg-stone-700">usagePromptMode</code> setting) prompt text. That
        choice is made on each developer's machine before anything leaves it — this server stores
        whatever it is sent, unmodified, and does not forward it anywhere else.
      </p>
    </section>

    <section class="card space-y-2">
      <h2 class="font-semibold text-stone-900 dark:text-stone-100">The only outbound calls this app makes</h2>
      <ul class="list-disc space-y-2 pl-5 text-sm text-stone-600 dark:text-stone-400">
        <li>
          <strong>Public pricing list</strong> — fetching OpenRouter's published model prices to
          suggest defaults. No account or usage data is included in that request.
        </li>
        <li>
          <strong>AI-assisted price lookup (optional, admin-only)</strong> — when an admin asks it
          to look up a model's list price, this app sends only that model's identifier (e.g.
          <code class="rounded bg-stone-100 px-1 dark:bg-stone-700">claude-sonnet-5</code>) to the AI provider the
          admin configured. It never includes prompt text, usage logs, or any other user data.
        </li>
      </ul>
    </section>

    <section class="card space-y-2">
      <h2 class="font-semibold text-stone-900 dark:text-stone-100">How secrets are stored</h2>
      <ul class="list-disc space-y-2 pl-5 text-sm text-stone-600 dark:text-stone-400">
        <li><strong>Passwords</strong> are hashed with bcrypt — never stored or logged in plain text.</li>
        <li>
          <strong>API ingestion tokens</strong> are shown once at creation, then kept only as a
          SHA-256 digest. If this database were exposed, the tokens themselves could not be
          recovered from it.
        </li>
        <li>
          <strong>AI provider API keys</strong> (used for the price-lookup feature above) are
          encrypted at rest with AES-256-GCM. The encryption key lives in this server's environment
          configuration, not in the database.
        </li>
      </ul>
    </section>
  </div>
</template>
