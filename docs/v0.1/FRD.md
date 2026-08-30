# FRD — Claude Usage Tracker (MEVN) — v0.1

## 0. Document control

| | |
|---|---|
| Status | Draft, pending confirmation (see §13) |
| Stack | MongoDB, Express, Vue 3, Node — all TypeScript |
| Companion plugin | [tyghaykal/claude-usage-reporter](https://github.com/tyghaykal/claude-usage-reporter) (source of the ingestion payload/auth spec below — verified against its README and `src/` on 2026-08-28) |

## 1. Purpose

Give a team a self-hosted place to point `usageEndpoint` at, so every developer's
Claude Code prompt/token usage lands in one database instead of scattered
terminal output. The app is the **receiver + admin UI** for that plugin; it does
not modify or replace the plugin.

## 2. Goals / Non-goals

**Goals (v0.1):** ingest the plugin's payload, authenticate it, store it, show it
back with filters/detail/charts, manage users and per-user API tokens, let an
admin price new models for cost estimation, run as Docker containers.

**Non-goals (v0.1):** multi-tenant orgs, email-based self-service password
reset for regular users, SSO/OAuth, alerting/budgets, editing/redacting stored
prompt text server-side (the plugin already offers `usagePromptMode` client-side
for that).

## 3. Roles

| Role | Can do |
|---|---|
| `admin` | Everything a `user` can, plus: create/manage other users, set their role, reset their password from the web UI. |
| `user` | Log in, view usage logs/dashboard, manage their own profile and their own API tokens, add/edit model pricing. |

## 4. Architecture

```mermaid
flowchart LR
    plugin[claude-usage-reporter\n(runs on each dev machine)] -- POST /api/usage\nHeader: X-API-Key --> api
    subgraph Docker Compose
      web[web\nnginx + built Vue SPA] -- /api/* proxy --> api[api\nNode/Express/TS]
      api --> mongo[(MongoDB)]
    end
    browser[Admin/User browser] --> web
```

Monorepo, three top-level packages:

```
/server   Express + TS + Mongoose. Also hosts the CLI (shares the same models).
/client   Vue 3 + TS + Vite + Pinia + Vue Router.
/docs     This FRD and future versions.
```

Two containers run app code (`api`, `web`) plus `mongo` — no separate reverse
proxy beyond the `web` nginx, no message queue, no Redis. The plugin already
POSTs from a detached process with its own retry/timeout, so the backend has no
special resilience burden.

## 5. What the plugin actually sends (verified from source, not assumed)

`POST <usageEndpoint>` — body:

```json
{
  "project": "my-project",
  "datetime": "2026-08-28T10:15:00Z",
  "prompt": "fix the login bug",
  "session_id": "abc-123",
  "model": "claude-sonnet-5",
  "user": "optional label from usageUser setting",
  "tokens": { "input": 1234, "cache_read": 800, "cache_write": 200, "output": 450, "total": 2684 }
}
```

`model` and `user` are omitted entirely when unset — don't assume presence.
Auth is one of `None | Bearer | Basic | Header | Key Pair`, chosen client-side
via `usageAuthType`. **v0.1 supports `Header`** with header name `X-API-Key`
(the plugin's own default for that setting), so a developer only has to set:

```
/claude-usage-reporter:usage-config set usageEndpoint https://our-host/api/usage
/claude-usage-reporter:usage-config set usageAuthType Header
/claude-usage-reporter:usage-config set usageHeaderValue <token issued by our app>
```

No custom header name, no Bearer/Basic/Key-Pair support in v0.1 (see §13 to
change this).

## 6. Data model

**User**
`_id, name, email (unique), passwordHash, role: 'admin'|'user', createdAt, updatedAt`

**ApiToken** — feature 8 ("roll-out tokens")
`_id, userId, label?, tokenHash (sha256, plaintext shown once at creation), tokenPrefix (for display), revoked: boolean, lastUsedAt, createdAt`

A user can hold multiple tokens (e.g. one per machine); "rolling out" a new one
never invalidates the others — revoke is explicit.

**UsageLog** — one row per ingested POST
`_id, userId (resolved from the token, not from the payload's "user" field), apiTokenId, project, promptDatetime (payload's "datetime"), receivedAt, prompt, sessionId, model?, userLabel? (payload's "user"), tokens: {input, cache_read, cache_write, output, total}, estimatedCostUsd (nullable), pricingSnapshot (nullable), recalculatedAt (nullable)`

`pricingSnapshot` is the actual rates used to produce `estimatedCostUsd` —
`{ modelPricingId, inputPerMTok, cacheWritePerMTok, cacheReadPerMTok, outputPerMTok, currency }`
— copied from `ModelPricing` at the moment the cost was computed, not a live
reference. It's what makes the persisted price auditable per-record (rather
than just a dollar figure) and is what FR-12 compares against current
`ModelPricing` to tell a stale record from a current one. Set at ingestion
(FR-9); overwritten, along with `estimatedCostUsd` and `recalculatedAt`, only
by an explicit FR-12 recalculation — never silently rewritten just because
someone edited `ModelPricing`.

Ownership for filtering ("developer/user name", FR-5) comes from `userId`
(the token holder), not the free-text `userLabel` the plugin can attach — the
latter is stored and shown in the detail popup but isn't trustworthy for
access control since it's client-supplied.

**ModelPricing** — feature 7
`_id, modelId (exact string match against payload "model"), inputPerMTok, cacheWritePerMTok, cacheReadPerMTok, outputPerMTok, currency (default USD), source: 'manual'|'ai', updatedBy, updatedAt`

Exact-match lookup, same behavior as the plugin's own `pricing.json`: unknown
model → `estimatedCostUsd: null`, token counts still stored exactly. `modelId`
is an opaque string, so aggregator-namespaced ids (`9r/claude-sonnet-5`,
`amanai/claude-sonnet-5`, `9r/some-combo-name`) work with no schema change —
whatever string a team's Claude Code setup reports as `model` (direct Anthropic
id or a proxy/aggregator's id) is what gets typed in here and matched.

**AiProviderConfig** — feature: AI-assisted pricing lookup (FR-11)
`_id, label, baseUrl, apiKeyEnc (AES-256-GCM, never returned by any API response), modelName, createdBy, createdAt`

Admin-managed, one row per provider the admin wants selectable when running an
AI pricing search (Anthropic directly, or an aggregator like the ones above).

## 7. Functional requirements

**FR-1 Admin bootstrap.** `GET /api/auth/bootstrap-status` (public) returns
whether an admin exists. While none exists: `POST /api/auth/bootstrap-admin`
(public) creates the first admin. The check is live (`count admins > 0`), so
the instant one exists, every subsequent call — HTTP or otherwise — 409s. No
separate "setup complete" flag to manage. The same guard backs
`server cli create-admin`, so admin creation works even with the HTTP route
never exposed.

**FR-2 Admin forgot-password is CLI-only.** No HTTP route exists for it, by
design. `server cli reset-password --email <e> --password <p>` (run via
`docker compose exec api ...`) sets a new password directly in Mongo. Web UI
never offers a "forgot password" link for anyone — see §13 on whether regular
users need a gentler path than "ask an admin."

**FR-3 Self-service profile.** `PATCH /api/me` lets any logged-in user change
their own `name` and/or `password` (current password required to change
password).

**FR-4 User management.** Admin-only: `POST/GET/PATCH /api/users` to create
users, list them, and change name/role. Admin sets an initial password on
creation (shown once) or can reset one later via CLI/`PATCH`.

**FR-5 Usage log list with filters.** `GET /api/usage-logs` paginated, filters:
`project` (exact/substring), `userId` (developer), `dateFrom`/`dateTo` (against
`promptDatetime`). Table columns: datetime, project, user, model, total tokens,
estimated cost. Each row has a checkbox (plus "select all matching this
filter") feeding FR-12; a row whose `pricingSnapshot` rate no longer matches
the model's current `ModelPricing` gets a small "pricing outdated" badge, so
which rows are worth recalculating is visible without opening each one.

**FR-6 Detail popup.** `GET /api/usage-logs/:id` returns the full stored
record (full prompt text, session id, token breakdown, cost, raw `userLabel`)
for a modal on row click — including the `pricingSnapshot` rates themselves,
not just the resulting dollar figure, and `recalculatedAt` if it's ever been
recomputed.

**FR-7 Model pricing.** `GET/POST/PATCH/DELETE /api/models`. New `UsageLog`
cost is computed at ingestion time from whatever pricing exists then; editing
a price later does not rewrite historical `estimatedCostUsd` (matches how the
plugin itself treats its price table — an estimate frozen at the time of the
call). Entries can arrive from manual entry or from FR-11's AI search
(`source` field records which), but every entry — AI-sourced or not — is only
ever written by this same create/update endpoint; there is no separate
persistence path for AI results.

**FR-8 API token roll-out.** `GET/POST /api/tokens`, `POST /api/tokens/:id/revoke`,
`DELETE /api/tokens/:id`. Token value is a random 32-byte secret, shown once in
plaintext at creation, stored only as a sha256 hash thereafter (GitHub-PAT
pattern). This is the value the developer pastes into
`usageHeaderValue`.

**FR-9 Ingestion endpoint.** `POST /api/usage`. Auth via `X-API-Key` header,
looked up by hashing and matching a non-revoked `ApiToken`; 401 if missing/bad/
revoked. Body validated against the exact shape in §5 (zod). On success, store
a `UsageLog` with `estimatedCostUsd` **and** its `pricingSnapshot` looked up
from current `ModelPricing` (cached, §8) — the rate is persisted per record at
the moment it's received, not just the resulting number. `204`. Rate-limited
(see §10) since this is the one endpoint reachable by anything that has a
token, unauthenticated attempts included.

**FR-10 Dashboard.** `GET /api/dashboard/summary?dateFrom=&dateTo=` returns
totals (tokens, estimated cost, prompt count) plus series for: usage over time,
breakdown by model, breakdown by project. Client renders with Chart.js
(`vue-chartjs`) — no heavier charting lib needed for line/bar/pie.

**FR-11 AI-assisted pricing search (admin-only).**

- `GET/POST/PATCH/DELETE /api/ai-providers` — manage `AiProviderConfig` rows
  (label, base URL, model name, API key — key is write-only, responses never
  echo it back, only `hasKey: true`).
- `POST /api/models/ai-search { modelId, providerId }` — calls the chosen
  provider and asks it, in a strict-JSON-only prompt, for current per-million-
  token input/output/cache-read/cache-write pricing for `modelId`. Returns a
  **preview only** — `{ suggested: {...}, raw, providerId, cachedAt }` — and
  writes nothing. The admin reviews/edits the suggested numbers in the UI, then
  submits through the normal FR-7 `POST/PATCH /api/models` — there is no
  separate "confirm" endpoint, confirming just means "now call the endpoint
  you'd use anyway, pre-filled."
- **Connector protocol**: a generic HTTP call, not an SDK. OpenAI-compatible
  `POST {baseUrl}/chat/completions` is tried first (the shape aggregators such
  as OpenRouter-style proxies speak); Anthropic Messages
  `POST {baseUrl}/messages` is the fallback when that path is missing or the
  body is not an OpenAI envelope. This is a deliberate choice: the destination
  is admin-supplied and unknown ahead of time, so it can't be a single named
  SDK. Flagged in §13 — if every admin here only ever points this at Anthropic
  directly, the Anthropic SDK (with its `web_search` server tool for genuinely
  live pricing pages, instead of relying on the model's training data) is the
  better fit and worth switching to.
- **Accuracy caveat, surfaced in the UI, not hidden**: unless the configured
  provider/model itself does live web browsing, this is the model's *recalled*
  pricing, which can be stale or wrong — hence "preview before submit" isn't
  optional UX polish, it's the only accuracy control v0.1 has. The preview
  screen states this plainly next to the suggested numbers.
- Results are cached per `(providerId, modelId)` for 24h (§8) so re-opening the
  same model's pricing panel doesn't re-spend a paid API call; a "refresh"
  action in the UI bypasses the cache.

**FR-12 Bulk cost recalculation.** `POST /api/usage-logs/recalculate-cost`,
body `{ ids: string[] }` or `{ filter: {project?, userId?, dateFrom?, dateTo?} }`
(so "recalc everything currently matching this filter" doesn't require paging
through and selecting rows one by one — see FR-5's "select all matching this
filter"). For each matching `UsageLog`, look up the model's current
`ModelPricing` and, if found, overwrite `estimatedCostUsd` + `pricingSnapshot`
+ `recalculatedAt`; if the model still has no pricing entry, leave the record
untouched. Nothing recalculates on its own — editing `ModelPricing` (FR-7)
never reaches back into history on its own; this is always an explicit,
selected action (§13). Response: `{ updated, skipped, total }`.

## 8. Non-functional requirements

- **Validation at the boundary**: every request body validated with zod before
  touching Mongoose (project rule).
- **Secrets**: bcrypt for passwords, sha256 for API tokens, both compared in
  constant time where the library provides it; secrets never logged.
  `AiProviderConfig.apiKeyEnc` is different — it must be decrypted to actually
  call the provider, so it's AES-256-GCM encrypted with a server-side
  `SETTINGS_ENCRYPTION_KEY` (env var, never in Mongo), not hashed.
- **Rate limiting**: `express-rate-limit` on `/api/usage` and `/api/auth/login`.
- **CORS**: locked to the configured web origin; no wildcard.
- **Headers**: `helmet` defaults.
- **Caching**: one in-process TTL cache module (`Map<key, {value, expiresAt}>`,
  ~20 lines, no new dependency, no Redis) backs three call sites: (1)
  `ModelPricing` lookups on the `/api/usage` ingestion hot path, invalidated
  immediately on any write to `/api/models`; (2) `/api/dashboard/summary`
  aggregation results, plain 60s TTL; (3) FR-11 AI pricing-search results, 24h
  TTL keyed by `(providerId, modelId)`. `ponytail:` single-instance/in-memory —
  fine at one `api` replica; if the container is ever scaled horizontally this
  needs a shared store (Redis) since replicas won't see each other's writes.
- **Access to logs/dashboard**: any authenticated user (either role) can see
  all logs and the dashboard — the point of the tool is shared team
  visibility. Only user management and others' password resets are
  admin-gated. (Flag in §13 if you want logs restricted to admins.)
- **TypeScript strict mode** on both `server` and `client`.

## 9. CLI

Lives in `server/src/cli`, run via `npm run cli -- <command>` (or
`docker compose exec api npm run cli -- <command>` in a running stack), talks
to Mongoose directly — no HTTP round-trip, works even if the API container is
misbehaving.

```
create-admin --email <e> --name <n> --password <p>   # only if zero admins exist
reset-password --email <e> --password <p>             # FR-2, any account
```

## 10. Deployment

`docker-compose.yml`: `mongo` (named volume), `api` (Node, port 4000
internal), `web` (multi-stage Vite build → nginx, port 80, proxies `/api/*` to
`api:4000`). Config via `.env` (`MONGO_URI`, `JWT_SECRET`, `JWT_REFRESH_SECRET`,
`CORS_ORIGIN`) — never committed, `.env.example` checked in instead.

## 11. Tech stack summary

| Layer | Choice |
|---|---|
| DB | MongoDB + Mongoose |
| API | Express + TypeScript |
| Validation | zod |
| Auth (web) | JWT access token + httpOnly refresh cookie |
| Auth (ingestion) | Per-user API token, `X-API-Key` header |
| Frontend | Vue 3 + TypeScript + Vite + Pinia + Vue Router |
| Charts | Chart.js via vue-chartjs |
| Styling | Tailwind (utility CSS, no component-runtime dependency) |
| AI pricing connector | Generic HTTP `fetch` (OpenAI, then Anthropic Messages), no SDK (FR-11) |
| Caching | Hand-rolled in-process TTL `Map`, no Redis (§8) |
| Container | Docker Compose (`mongo`, `api`, `web`) |

## 12. Out of scope for v0.1

- Bearer/Basic/Key-Pair auth support for the ingestion endpoint (Header only).
- Self-service "forgot password" for regular users (admin/CLI resets only).
- Multi-project/org boundaries — `project` is just a filter string, not an
  entity with its own permissions.
- Alerting, budgets, spend caps.

## 13. Decisions made by default — flag any you want changed

1. **Ingestion auth = Header/`X-API-Key` only** (§5, §12). Adding Bearer is a
   small change (same lookup, different header parsing) if you'd rather issue
   Bearer tokens.
2. **Logs/dashboard visible to all logged-in users**, not admin-only (§8).
3. **Regular users with a forgotten password have no self-service path** —
   today that means "ask an admin to reset it," admin does it via the user
   management UI or CLI. Only true email-based reset was ruled out (no mail
   infra requested).
4. **Model pricing is editable by any logged-in user**, not admin-gated —
   feature 7 didn't specify a role restriction; easy to gate if wrong.
5. **Ownership/filtering by user comes from the API token**, not the
   plugin's free-text `usageUser` field, since the latter is client-supplied
   and unverified.
6. **Docker = 3 containers** (mongo, api, nginx+SPA), not a combined single
   Node container serving both — standard MEVN split, still `docker compose up`
   as one command.
7. **FR-11's AI connector is a generic HTTP call** (OpenAI chat-completions,
   then Anthropic Messages), not the Anthropic SDK, because the endpoint is
   admin-supplied and unknown ahead of time (could be Anthropic directly, or an
   aggregator). If in practice this only ever points at Anthropic, say so — the
   Anthropic SDK's `web_search` server tool gets genuinely live pricing instead
   of the model's possibly stale training-data recall, which no generic HTTP
   call can do.
8. **AI provider settings + AI pricing search are admin-only**; manual pricing
   entry (FR-7) stays open to any user per decision 4 above — flag if you want
   both gated the same way.
9. **Cache is in-process, single `api` replica only** (§8) — a deliberate
   ceiling to stay Redis-free at this scale, not an oversight.
10. **FR-12 recalculation is open to any logged-in user**, matching FR-7's
    manual-pricing-edit gating (decision 4), not restricted to admins.
11. **Recalculation is always explicit** — saving a new `ModelPricing` value
    never auto-updates past `UsageLog` rows, even ones missing a price
    entirely. If you'd rather have "no pricing found" records pick up a price
    automatically the next time one's added, that's a small addition (an
    on-save sweep for `estimatedCostUsd: null` rows only, still leaving
    already-priced history alone unless explicitly recalculated).
