# Claude Usage Tracker

A self-hosted receiver and dashboard for the
[claude-usage-reporter](https://github.com/tyghaykal/claude-usage-reporter) Claude Code plugin.

Point every developer's `usageEndpoint` at one server, and their prompt/token usage lands in a
shared database instead of scattered terminal output — with filtering, per-prompt detail, cost
estimation and charts on top.

MEVN stack (MongoDB, Express, Vue 3, Node), TypeScript throughout, `docker compose up` to run.

---

## What it does

| | |
|---|---|
| **Ingests** | The plugin's exact payload — project, timestamp, prompt text, session id, model, and the input / cache-read / cache-write / output token breakdown. |
| **Authenticates** | Per-user API tokens, issued in the UI, sent as `X-API-Key`. Revocable individually; issuing a new one never invalidates the others. |
| **Prices** | Per-model rates you configure, applied at ingestion. The rates used are **stored on each record**, so a later price change never silently restates history. |
| **Shows** | A filterable log (project / developer / model / date range), a per-prompt detail view, and a dashboard with usage over time, by model, by project and by developer. |
| **Recalculates** | Reprice selected records — or everything matching a filter — against current rates, on demand and only on demand. |
| **Assists** | Optional: ask an AI provider you configure for a model's list price, review the suggestion, then save it. Manual entry always works too. |

### What it deliberately does not do

- **No self-service password reset.** Admin recovery is CLI-only, by design (see [Recovering a locked-out admin](#recovering-a-locked-out-admin)). Regular users ask an admin.
- **No automatic repricing.** Editing a model's price never rewrites past records. See [Pricing and history](#pricing-and-history).
- **No prompt redaction server-side.** The plugin already offers `usagePromptMode` (`full` / `truncate:N` / `none`) client-side. Configure it there, before the data leaves the machine.

> **A note on what you are storing.** By default this receives the **full text of every prompt**
> your developers type. That is the point of the tool, but it makes the database sensitive. Decide
> deliberately whether to ask your team to set `usagePromptMode truncate:200` or `none`, and treat
> the Mongo volume accordingly.

---

## Quick start (Docker)

```bash
git clone <this repo> && cd ai-usage
cp env.example .env

# Fill in the three secrets:
node -e "const c=require('crypto');for(const k of ['JWT_SECRET','JWT_REFRESH_SECRET'])console.log(k+'='+c.randomBytes(32).toString('base64url'));console.log('SETTINGS_ENCRYPTION_KEY='+c.randomBytes(32).toString('hex'))"

docker compose up -d --build
```

Open <http://localhost:8888> (or your `WEB_PORT`). The first visit shows a **one-time setup form** that
creates the admin account, then closes permanently.

### Applying changes

> **`docker compose up -d` alone will not pick up code changes.** The production
> images copy the source in at build time, so a restart re-runs the *old* build.

| You want | Run | Effect |
|---|---|---|
| Apply code changes to the running stack | `npm run docker:up`<br>(`docker compose up -d --build`) | Rebuilds the changed images and restarts. Always correct, ~1 min. |
| Iterate on code, changes live immediately | `npm run docker:dev` | Bind-mounts the source; the API restarts on save and the browser hot-reloads. No rebuild. |
| Just restart (config/env change only) | `docker compose up -d` | Picks up `.env` changes. **Not** code changes. |

`npm run docker:dev` runs the base compose file plus `docker-compose.dev.yml`, which swaps both
containers to watch mode — `tsx watch` for the API, the Vite dev server for the UI — with your
working tree mounted in. Same URL as production (`http://localhost:8888`), and the API is also
published directly on `:4000` for `curl`. Ctrl-C to stop; it is a foreground command so you can see
both logs.

That overlay is for development only: it installs dev dependencies, runs as root, and serves
unminified assets. Deploy with the base file alone.

### Creating the admin

Prefer the terminal? Create the admin before anyone opens a browser:

```bash
docker compose exec api node server/dist/cli/index.js create-admin \
  --email you@example.com --name "Your Name" --password 'a-long-password'
```

Either route works; the guard is a live count of admin accounts, so whichever happens first closes
the other.

### Connecting a developer's Claude Code

1. Sign in, go to **API tokens**, create one, and copy it — it is shown exactly once.
2. On the machine that should report:

```
/claude-usage-reporter:usage-config set usageEndpoint https://your-host/api/usage
/claude-usage-reporter:usage-config set usageAuthType Header
/claude-usage-reporter:usage-config set usageHeaderValue <the token you copied>
```

The **API tokens** page prints these three lines with your host and token already filled in.

`usageAuthType Header` uses the plugin's default header name, `X-API-Key` — leave
`usageHeaderName` alone. Bearer / Basic / Key-Pair are not supported in v0.1.

---

## Local development

If you already run the stack in Docker, `npm run docker:dev` gives you the same live-reload loop
without installing anything locally — see [Applying changes](#applying-changes).

To run it directly on the host instead, you need Node 20+ and a MongoDB on `localhost:27017`.

```bash
npm install
cp env.example .env    # then set MONGO_URI, and uncomment the dev block

npm run dev:server     # http://localhost:4000
npm run dev:client     # http://localhost:5173, proxies /api to :4000
```

```bash
npm test               # server (228 tests) + client (28 tests)
npm run coverage       # server coverage, enforced at 100%
npm run typecheck      # both workspaces
npm run build          # both workspaces
```

### Layout

```
server/   Express + Mongoose + zod. Routes are thin; logic lives in
          cache.ts, crypto.ts, pricing.ts and services/aiPricing.ts.
  src/cli/  Admin bootstrap and password reset, straight to Mongo.
  tests/    Vitest + supertest + mongodb-memory-server.
client/   Vue 3 + Pinia + Vue Router + Tailwind + Chart.js.
docs/     FRD and the API reference.
```

---

## How it works

### Roles

| Role | Can |
|---|---|
| `user` | See all logs and the dashboard, manage their own profile and API tokens, add and edit model pricing, recalculate costs. |
| `admin` | All of the above, plus manage users and their roles, reset anyone's password, and configure AI providers. |

Logs and the dashboard are visible to **every** signed-in user — shared visibility is the point of
the tool. Only user management and AI-provider settings are admin-gated.

### Pricing and history

Every ingested record stores the **rates that produced its cost**, not a pointer to a pricing row:

```jsonc
{
  "estimatedCostUsd": 0.009975,
  "pricingSnapshot": {
    "inputPerMTok": 3, "cacheReadPerMTok": 0.3,
    "cacheWritePerMTok": 3.75, "outputPerMTok": 15, "currency": "USD"
  }
}
```

So editing a model's price affects only *future* prompts. When current rates differ from what a
record stored, the log list flags it **pricing outdated** — and you can reprice, explicitly, from
that same screen: selected rows, or everything matching the current filter.

A prompt for a model you have not priced is stored with `estimatedCostUsd: null`. Its **token
counts are still exact**; only the cost is unknown. Add pricing later and recalculate to fill it in.

Model ids are matched **exactly, as opaque strings**, so aggregator-prefixed ids work with no
special handling:

```
claude-sonnet-5          9r/claude-sonnet-5
amanai/claude-sonnet-5   9r/some-combo-name
```

### amanai credits (automatic)

Any prompt whose `model` starts with `amanai/` (e.g. `amanai/deepseek-v4-flash`) gets an exact
`amanaiCredits` figure computed **deterministically at ingestion**, from amanai's own published
per-model multiplier (https://ai.amanai.dev/docs/models/) — no API key, no per-user setup, no
network call:

```jsonc
{
  "amanaiCredits": 9210
}
```

amanai's documented formula is `credits = (input - cache)×m_in + cache×m_cache + output×m_out`.
Every model amanai publishes uses the same fixed ratios (`m_out = 5×m_in`, `m_cache =
0.25×m_in`), so only `m_in` is stored per model — see `AMANAI_MULTIPLIERS` in
`server/src/defaultModels.ts`.

- **Automatic, no configuration.** Any recognised `amanai/` model gets a credit figure; an
  unrecognised amanai model (amanai has published no multiplier for it) leaves `amanaiCredits`
  as `null`, same as any other model with no matching pricing.
- **Recalculates like cost does.** Recalculating a log's cost also recomputes `amanaiCredits`
  from the current multiplier table.
- **Rupiah-based.** amanai's own credit packs price 1,000,000,000 credits at Rp 150,000 — the
  dashboard's log detail view shows the Rupiah equivalent alongside the raw credit figure.

Whatever string arrives in the payload's `model` field is what you enter on the pricing page.

### AI-assisted pricing lookup (optional)

Rather than typing four rates by hand, an admin can configure a provider under **AI providers**
(label, base URL, model name, API key) and press **Search** on the pricing page.

The result is a **preview**. Nothing is written until you press Save — and Save is the same
endpoint manual entry uses, just pre-filled. Results are cached 24h per (provider, model) so
reopening the panel doesn't re-spend an API call; **Re-check** bypasses the cache.

The connector speaks generic HTTP: OpenAI-compatible `POST {baseUrl}/chat/completions` first, then
Anthropic Messages `POST {baseUrl}/messages` if that path is missing or the body is not an OpenAI
envelope. The endpoint is yours to choose and unknown at build time. **Accuracy caveat, stated plainly:**
unless the provider you point at does live web browsing, you are getting the model's *recalled*
pricing, which can be stale or wrong. That is exactly why the preview step is mandatory rather than
decorative. Verify against the vendor's pricing page before saving.

**Adding a provider tests it first.** Saving sends one `max_tokens: 1` request to the endpoint you
gave, and a provider that fails is not stored — so a typo'd URL, a wrong key or a model name that
provider doesn't have fails right there, with a message naming which of the three is wrong, instead
of surfacing later as a broken pricing lookup. A **Test** button on each row re-checks a stored
provider (useful after a key rotation, or when a provider goes down). A rate-limited check (HTTP
429) counts as reachable and saves.

API keys are encrypted at rest with `SETTINGS_ENCRYPTION_KEY` (AES-256-GCM) and are never returned
by any endpoint — the UI only ever learns whether a key is set.

### Caching

One in-process TTL cache backs three things: model-pricing lookups on the ingestion path
(invalidated on any pricing write), dashboard aggregates (60s), and AI pricing suggestions (24h).
No Redis.

This is deliberately **single-replica**. Scale the `api` service horizontally and replicas stop
seeing each other's invalidations — swap `server/src/cache.ts` for a shared store at that point.
Every call site already goes through `get` / `set` / `invalidate`.

---

## Operations

### CLI

```bash
npm run docker:cli -- <command>          # docker, production images
docker compose exec api npm run cli -- <command>   # docker, `docker:dev` mode
npm run cli -- <command>                 # no docker

create-admin   --email <e> --name <n> --password <p>   # only while no admin exists
reset-password --email <e> --password <p>              # any account, any time
list-users                                             # who exists, and their role
generate-key                                           # a fresh SETTINGS_ENCRYPTION_KEY
```

The CLI talks to Mongo directly, so it works even when the API is unhealthy.

The two Docker forms differ because the production image ships compiled JS with no `tsx`, while
`docker:dev` mounts the TypeScript sources and has `tsx` available.

### Recovering a locked-out admin

There is no "forgot password" link anywhere in the UI — that is the design, not an omission. With
shell access to the server:

```bash
docker compose exec api node server/dist/cli/index.js reset-password \
  --email you@example.com --password 'a-new-long-password'
```

The last remaining admin also cannot be demoted through the API, so the UI alone cannot leave you
without one.

### Backups

Everything lives in the `mongo-data` volume.

```bash
docker compose exec -T mongo mongodump --archive --db=ai-usage > backup-$(date +%F).archive
docker compose exec -T mongo mongorestore --archive --drop < backup-2026-08-28.archive
```

Back up `.env` separately and just as carefully: lose `SETTINGS_ENCRYPTION_KEY` and stored provider
API keys become undecryptable (re-enter them); lose the JWT secrets and everyone is signed out.

### Production checklist

- [ ] Terminate TLS in front of `web`, then set `COOKIE_SECURE=true` and `CORS_ORIGIN=https://…`.
- [ ] All three secrets random and unique — never the values from `env.example`.
- [ ] Don't publish the `mongo` port; it has no authentication in this compose file.
- [ ] Decide your team's `usagePromptMode` before onboarding people.
- [ ] Set up backups of the `mongo-data` volume.

---

## Documentation

- [`docs/v0.1/FRD.md`](docs/v0.1/FRD.md) — requirements, data model, and the decisions taken with
  their rationale.
- [`docs/v0.1/API.md`](docs/v0.1/API.md) — every endpoint, with request and response shapes.

## License

MIT — see [LICENSE](LICENSE).
