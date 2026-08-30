# API reference — v0.1

Base path: `/api`. All bodies are JSON.

## Authentication

Two independent schemes:

| Surface | Scheme | Used by |
|---|---|---|
| Web app | `Authorization: Bearer <accessToken>` + an httpOnly `refresh_token` cookie | The Vue UI |
| Ingestion | `X-API-Key: <token>` | The claude-usage-reporter plugin |

Access tokens are short-lived (15m default). The client trades the refresh cookie for a new one
automatically; the cookie is scoped to `/api/auth` and never leaves that path.

The JWT is only a pointer — the user is re-read from the database on every request, so a role
change or a deleted account takes effect immediately rather than at token expiry.

## Errors

```jsonc
{ "error": "Human-readable message", "details": { /* zod field errors, when validation failed */ } }
```

| Status | Meaning |
|---|---|
| 400 | Validation failed (`details` carries the field errors) |
| 401 | Missing, invalid, expired or revoked credentials |
| 403 | Authenticated, but the role is insufficient |
| 404 | No such record |
| 409 | Conflict — duplicate value, or bootstrap already completed |
| 429 | Rate limited (`/api/auth/login`, `/api/usage`) |
| 502 | An AI provider was unreachable or returned something unusable |

---

## Public

### `GET /api/health`
`200 → { "status": "ok" }`

### `GET /api/auth/bootstrap-status`
`200 → { "needsBootstrap": true }` — true while no admin account exists.

### `POST /api/auth/bootstrap-admin`
Creates the first admin. **409 once any admin exists**, forever. The guard is a live count, shared
with the CLI's `create-admin`.

```jsonc
// request
{ "name": "Ada", "email": "ada@example.com", "password": "at-least-8-chars" }
// 201
{ "user": { "id": "…", "name": "Ada", "email": "ada@example.com", "role": "admin", "createdAt": "…" } }
```

### `POST /api/auth/login`
Rate limited. Returns the same error for a wrong password and an unknown account.

```jsonc
// request
{ "email": "ada@example.com", "password": "…" }
// 200 — also sets the refresh_token cookie
{ "accessToken": "eyJ…", "user": { … } }
```

### `POST /api/auth/refresh`
Reads the refresh cookie. `200 → { accessToken, user }`, or 401.

### `POST /api/auth/logout`
`204`, clears the cookie.

---

## Ingestion

### `POST /api/usage`
**Auth:** `X-API-Key`. Rate limited (240/min per IP by default).

The payload the plugin sends, verbatim. `model` and `user` are **omitted entirely** when unset
upstream — do not assume they are present.

```jsonc
{
  "project": "my-project",
  "datetime": "2026-08-28T10:15:00.000Z",   // ISO 8601 with offset
  "prompt": "fix the login bug",             // may be "" (usagePromptMode: none)
  "session_id": "abc-123",
  "model": "claude-sonnet-5",                // optional
  "user": "label",                           // optional; display only, never trusted for ownership
  "tokens": { "input": 1234, "cache_read": 800, "cache_write": 200, "output": 450, "total": 2684 }
}
```

`204` on success. The record is attributed to the **token's owner**, not to the payload's `user`
field. Cost and the rates used are computed and stored at this moment.

---

## Session (any signed-in user)

### `GET /api/me` → `{ user }`

### `PATCH /api/me`
```jsonc
{ "name": "New Name" }
{ "currentPassword": "…", "newPassword": "…" }   // currentPassword is required
```
`200 → { user }`. 401 if the current password is wrong; 400 if the new one matches the old.

---

## API tokens (own tokens only)

Scoped to the caller — admins cannot read or revoke other people's tokens here.

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/tokens` | Never includes a plaintext token |
| `POST` | `/api/tokens` | `{ "label": "laptop" }` → **the only time the plaintext is returned** |
| `POST` | `/api/tokens/:id/revoke` | Existing tokens keep working; revocation is per-token |
| `DELETE` | `/api/tokens/:id` | `204` |

```jsonc
// POST /api/tokens → 201
{
  "token": "sk-xxxxxxxx…",    // shown once, stored only as a sha256 digest
  "apiToken": { "id": "…", "label": "laptop", "tokenPrefix": "sk-xxxxxxxx",
                "revoked": false, "lastUsedAt": null, "createdAt": "…" }
}
```

---

## Usage logs

### `GET /api/usage-logs`
Query: `project` (case-insensitive substring), `userId`, `model` (exact), `dateFrom`, `dateTo`
(ISO), `page` (default 1), `limit` (default 50, max 200). Sorted newest first.

```jsonc
{
  "logs": [{
    "id": "…", "userId": "…", "project": "my-project",
    "promptDatetime": "2026-08-28T10:15:00.000Z",
    "model": "claude-sonnet-5",
    "tokens": { "input": 1234, "cache_read": 800, "cache_write": 200, "output": 450, "total": 2684 },
    "estimatedCostUsd": 0.009975, "currency": "USD",
    "pricingOutdated": false      // current rates differ from this record's snapshot
  }],
  "page": 1, "limit": 50, "total": 128, "totalPages": 3
}
```

### `GET /api/usage-logs/facets`
`{ "projects": [...], "models": [...] }` — sorted, distinct, nulls dropped. Fills the filter inputs.

### `GET /api/usage-logs/:id`
The list row plus `prompt`, `sessionId`, `userLabel`, `receivedAt`, `apiTokenId`,
`recalculatedAt`, and `pricingSnapshot` — the actual rates used, not just the resulting figure:

```jsonc
"pricingSnapshot": {
  "modelPricingId": "…", "inputPerMTok": 3, "cacheWritePerMTok": 3.75,
  "cacheReadPerMTok": 0.3, "outputPerMTok": 15, "currency": "USD"
}
```
`null` when the model had no pricing when the prompt arrived.

### `POST /api/usage-logs/recalculate-cost`
Reprices records against **current** pricing. Takes either an explicit selection or a filter, so
"everything matching what's on screen" doesn't require paging through it.

```jsonc
{ "ids": ["…", "…"] }
{ "filter": { "project": "web", "dateFrom": "2026-08-01T00:00:00.000Z" } }
// 200
{ "total": 120, "updated": 118, "skipped": 2 }
```

`skipped` counts records whose model still has no pricing — those are left **exactly as they
were**, never blanked. Nothing recalculates on its own; editing pricing does not reach into history.

---

## Model pricing

`modelId` is opaque and matched exactly, so `9r/claude-sonnet-5` and `amanai/claude-sonnet-5` are
ordinary values.

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/models` | Sorted by `modelId` |
| `POST` | `/api/models` | 409 on a duplicate `modelId` |
| `PATCH` | `/api/models/:id` | Partial; does **not** touch historical records |
| `DELETE` | `/api/models/:id` | `204` |

```jsonc
// POST /api/models
{
  "modelId": "claude-sonnet-5",
  "inputPerMTok": 3, "cacheWritePerMTok": 3.75,
  "cacheReadPerMTok": 0.3, "outputPerMTok": 15,
  "currency": "USD",        // optional, default USD
  "source": "manual"        // optional, "manual" | "ai" — provenance only
}
```

### `POST /api/models/ai-search` — **admin only**

Asks a configured provider for a model's list price. **Returns a preview and writes nothing.** To
save, call `POST`/`PATCH /api/models` with the (possibly edited) numbers.

```jsonc
// request
{ "modelId": "claude-sonnet-5", "providerId": "…", "refresh": false }
// 200
{
  "modelId": "claude-sonnet-5", "providerId": "…",
  "suggested": { "inputPerMTok": 3, "cacheWritePerMTok": 3.75, "cacheReadPerMTok": 0.3,
                 "outputPerMTok": 15, "currency": "USD", "notes": "…" },
  "raw": "…",             // the provider's unparsed reply
  "fromCache": false,     // cached 24h per (provider, model); `refresh: true` bypasses it
  "disclaimer": "Suggested from the AI provider's knowledge, which may be stale or wrong. …"
}
```

`502` when the provider is unreachable, errors, or returns something that isn't usable pricing. The
provider's response body is never echoed back — it can contain the key that was sent to it.

---

## AI providers — **admin only**

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/ai-providers` | Returns `hasKey`, never the key |
| `POST` | `/api/ai-providers` | `{ label, baseUrl, modelName, apiKey }`; `baseUrl` must be http(s). **Probed before saving** |
| `PATCH` | `/api/ai-providers/:id` | Omit `apiKey` to keep the stored one. Re-probed only if `baseUrl`, `modelName` or `apiKey` changes |
| `POST` | `/api/ai-providers/:id/test` | Re-check a stored provider on demand |
| `DELETE` | `/api/ai-providers/:id` | `204` |

The app POSTs to `{baseUrl}/chat/completions` in the OpenAI-compatible shape first, then
`{baseUrl}/messages` in the Anthropic Messages shape if that path is missing or the body is not an
OpenAI envelope. Keys are stored AES-256-GCM encrypted under `SETTINGS_ENCRYPTION_KEY` and are never
returned by any endpoint.

### Connectivity probe

`POST` and connection-affecting `PATCH` send one `max_tokens: 1` chat completion first, so a wrong
URL, key or model name fails at configuration time rather than during a pricing lookup days later.
**A provider that fails the probe is not stored.**

```jsonc
// 201 — the probe result rides along with the created provider
{ "provider": { … },
  "test": { "ok": true, "status": 200, "latencyMs": 240,
            "message": "Reached the provider and got a reply from \"gpt-4o\" in 240ms." } }

// 400 — refused, with the probe result in `details`
{ "error": "The provider rejected the API key (HTTP 401). Check the key and that it is valid for this endpoint.",
  "details": { "providerTest": { "ok": false, "status": 401, "latencyMs": 180, "message": "…" } } }
```

The message names the likely culprit rather than the raw status: 401/403 → the key; 404 → the base
URL (and prints the exact path tried); 400/422 → the model name; 5xx → the provider itself. The
provider's response body is never echoed back — it can contain the key that was sent to it.

**HTTP 429 counts as reachable** (`ok: true`) and saves: the endpoint demonstrably answered, and
failing a correct config over a transient rate limit would be worse. The message says the key and
model could not be fully verified.

`POST /api/ai-providers/:id/test` decrypts the stored key and re-probes. It returns **200 with the
result either way** — a failing probe is a diagnostic, not a failed request:

```jsonc
{ "test": { "ok": false, "status": null, "latencyMs": 30000,
            "message": "Could not reach https://…: The operation timed out." } }
```

---

## Users — **admin only**

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/users` | Oldest first |
| `POST` | `/api/users` | `{ name, email, password, role? }`; 409 on a duplicate email |
| `PATCH` | `/api/users/:id` | Any of `name`, `role`, `password` |

Demoting the **last remaining admin** is refused with 400 — the UI alone cannot lock everyone out.

---

## Dashboard

### `GET /api/dashboard/summary`
Same filters as the log list (`project`, `userId`, `model`, `dateFrom`, `dateTo`). Cached 60s per
filter; invalidated immediately by new usage or a recalculation.

```jsonc
{
  "totals": { "prompts": 128, "totalTokens": 486_400, "inputTokens": …, "cacheReadTokens": …,
              "cacheWriteTokens": …, "outputTokens": …, "estimatedCostUsd": 1.2765 },
  "byDay":     [{ "key": "2026-08-28", …same shape as totals }],
  "byModel":   [{ "key": "claude-sonnet-5", … }],   // key is null for unreported models
  "byProject": [{ "key": "my-project", … }],
  "byUser":    [{ "key": "<userId>", … }]
}
```

Unpriced records contribute `0` to `estimatedCostUsd` rather than breaking the aggregate; their
token counts are still included in full.
