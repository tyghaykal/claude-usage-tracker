# Implementation notes — v0.1

Where the built system differs from, or sharpens, the FRD. Everything here was decided while
writing the code; the FRD itself is unchanged.

## Deviations from the FRD

### 1. `UsageLog.model` is stored as `modelId`

The FRD's data model names the field `model`. In Mongoose a schema path called `model` **shadows
`Document.model()`**, a real method on every document — a latent runtime footgun, and TypeScript
rejects the interface outright. The field is persisted and queried as `modelId`, matching
`ModelPricing.modelId`.

**The API is unaffected**: every request and response still uses `model`. Only the storage
attribute changed.

### 2. `sha256` for API tokens, not bcrypt

The FRD's §8 says "bcrypt for passwords, sha256 for API tokens" — worth stating why, since the
asymmetry looks wrong at a glance. API tokens are verified on **every** ingestion POST, so
verification has to be an indexed equality lookup; a deliberately slow hash would put ~100ms of
CPU on the hot path. That is safe here only because the token is 32 bytes of CSPRNG output rather
than a user-chosen password: there is no dictionary to attack, so bcrypt's work factor buys
nothing. Passwords, which *are* user-chosen, still use bcrypt.

### 3. `userId` is cast to `ObjectId` in the shared query builder

Found by a failing test rather than by inspection. `buildFilterQuery()` is used both by
`find()` (which casts hex strings to ObjectId) and by the dashboard's aggregation `$match`
(which does **not** cast, silently). The uncast form made the dashboard's developer filter match
zero rows while the identical filter on the log list worked. The builder now casts explicitly.

### 4. `touchToken()` extracted from the ingest handler

The FR-9 "best effort lastUsedAt" write is a one-line `.catch()` inside a route handler, which is
unreachable from an HTTP test — nothing can delete the token *between* auth resolving it and the
save. Extracted to an exported function so the failure path is directly testable.

## Decisions the FRD left open

| FRD §13 | Built as |
|---|---|
| 1. Ingestion auth | `Header` / `X-API-Key` only, as specified |
| 2. Logs visible to all signed-in users | Yes — `requireAuth`, no role check |
| 3. No self-service reset | Confirmed; the login screen states the CLI path explicitly instead of hiding it |
| 4. Pricing editable by any user | Yes; only `POST /api/models/ai-search` is admin-gated |
| 5. Ownership from the token | Yes; the payload's `user` is stored as `userLabel`, display-only |
| 6. Three containers | `mongo`, `api` (node), `web` (nginx + SPA) |
| 7. Generic OpenAI-compatible connector | Yes — still worth revisiting if this only ever points at Anthropic (see below) |
| 10. Recalculation open to any user | Yes, matching decision 4 |
| 11. Recalculation always explicit | Yes; no on-save sweep of any kind |

### Added beyond the FRD

- **`GET /api/usage-logs/facets`** — distinct projects and models, so the filter inputs offer real
  values instead of asking people to remember exact strings. Not in the FRD; the filter UI is
  meaningfully worse without it.
- **`GET /api/health`** — for the compose healthcheck.
- **CLI `list-users` and `generate-key`** — beyond the FRD's two commands. `generate-key` exists so
  the first-run secret in `env.example` has an obvious, correct way to be produced.
- **AI provider connectivity probe** — `POST`/`PATCH /api/ai-providers` verify the URL + key +
  model with one `max_tokens: 1` call before storing, and `POST /api/ai-providers/:id/test`
  re-checks on demand. Not in the FRD; without it a bad provider config is silent until someone
  presses Search, and the resulting 502 doesn't say which of the three fields is wrong. Two
  judgement calls worth naming: a failing probe **blocks the save** (the provider is optional and
  manual pricing always works, so refusing beats storing something broken), and **429 counts as
  reachable** (the endpoint answered; failing a correct config over a transient limit would be
  worse than saving it with a caveat).
- **`docker-compose.dev.yml`** — a development overlay that bind-mounts the source and swaps both
  containers to watch mode (`tsx watch`, Vite dev server). The FRD specifies production containers
  only, and with those a code change is invisible until someone remembers `--build`. Both
  Dockerfiles gained a `deps` stage (dependencies, no source, no compile) for the overlay to target;
  the production `build` and `runtime` stages are unchanged. `client/vite.config.ts` reads
  `VITE_HOST` / `VITE_PORT` / `VITE_API_PROXY_TARGET` / `VITE_HMR_CLIENT_PORT` so one config serves
  both the host and the container, where the dev server must bind `0.0.0.0`, proxy to the `api`
  service rather than `localhost`, and point the HMR websocket at the *published* port.
- **Last-admin demotion guard** — `PATCH /api/users/:id` refuses to demote the only remaining
  admin. The FRD doesn't mention it; without it the UI can lock every admin out of user management,
  recoverable only over SSH.

## Known limitations

- **The cache is single-replica.** Documented in the FRD (§13 decision 9) and marked with a
  `ponytail:` comment in `server/src/cache.ts`. Scaling `api` past one container needs Redis.
- **AI pricing accuracy is bounded by the provider.** With a generic OpenAI-compatible endpoint the
  suggestion is the model's *recalled* pricing. The preview-before-save step and the disclaimer in
  the response payload are the only accuracy controls. If this only ever points at Anthropic, the
  Anthropic SDK's `web_search` server tool would fetch live pricing pages instead — a contained
  change to `services/aiPricing.ts` alone.
- **Rate limiting is per-IP, in-process.** Behind nginx with `TRUST_PROXY=true` that is the real
  client IP, but it resets on restart and is not shared between replicas.
- **No pagination on `/api/models`, `/api/users`, `/api/ai-providers`.** Fine at team scale
  (tens of rows); would need it at thousands.
- **The Docker images have never been built or run here.** Docker Hub was unreachable from the
  environment this was written in, so `docker compose build` could not complete. Both compose files
  pass `docker compose config`, and the commands the dev overlay runs (`tsx watch server/src/…`,
  `vite --host 0.0.0.0 --port …` with the container env vars) were each verified directly on the
  host — but the images themselves are unverified. Build them once before relying on them.

## Test coverage

`server`: 253 tests, **100% of statements, branches, functions and lines**, enforced by a threshold
in `vitest.config.ts` — the suite fails below it. Excluded: `src/index.ts` and `src/cli/index.ts`,
the two process entry points, which only read argv/env and call into covered modules.

Tests run against a real MongoDB via `mongodb-memory-server` and the real Express app via
`supertest`, so route wiring, middleware order, validation and Mongo behaviour are all exercised
rather than mocked. The only stubbed boundary is outbound HTTP to AI providers.

`client`: 28 tests covering the fetch wrapper (including the 401-refresh-retry path) and the
display formatters. Components are not unit-tested — they are thin, and `vue-tsc` covers their
types at build time.
