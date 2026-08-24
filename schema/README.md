# schema/ — Cloud Code endpoint response schemas (live-probed)

Purpose: zod v4 + strict TS + ESM schemas for every Cloud Code `v1internal:*` endpoint the plugin touches, captured from **real live probes** (2026-08-23) rather than spec-guessing. Other agents import these to build the weekly-limit fetch (`retrieveUserQuotaSummary`) without re-probing.

## Live probe summary (2026-08-23)

- Storage path resolved via `src/plugin/storage.ts:262` logic (`OPENCODE_CONFIG_DIR` → `XDG_CONFIG_HOME` → `~/.config/opencode/antigravity-accounts.json`): `<user-config-dir>/opencode/antigravity-accounts.json` (v4, 4 accounts)
- Token: `refreshAccessToken()` from `src/plugin/token.ts` on account 0 (`<email-redacted>`, project `<project-id>`) → access token issued (value + expiry not recorded)
- Headers: `Authorization: Bearer …`, `Content-Type: application/json`, `User-Agent: antigravity/1.22.2 windows/amd64` (from `src/constants.ts:getAntigravityHeaders`)
- Host: `https://cloudcode-pa.googleapis.com` plus verified on `daily-cloudcode-pa.googleapis.com` and `daily-cloudcode-pa.sandbox.googleapis.com`

| Endpoint | Method | URL | Body | Status | Key fields (camelCase) |
|---|---|---|---|---|---|
| `retrieveUserQuota` | POST | `/v1internal:retrieveUserQuota` | `{project:"<project-id>"}` or `{}` | 200 | `buckets[]:{tokenType:"WTUS", modelId, remainingFraction 0-1, resetTime? ISO}` 25 entries; internal tab models lack `resetTime`; **no weekly** |
| `fetchAvailableModels` | POST | `/v1internal:fetchAvailableModels` | `{project:"<project-id>"}` or `{}` | 200 | `models:Record<id, {displayName, quotaInfo:{remainingFraction, resetTime?}, model, apiProvider, ...}>` MAP, 24 models; `defaultAgentModelId`, `deprecatedModelIds`, `experimentIds` |
| `retrieveUserQuotaSummary` (**weekly**) | POST | `/v1internal:retrieveUserQuotaSummary` | `{}` or `{project:"…"}` | 200 (all 3 hosts) | `groups[]:{displayName, description, buckets[]:{bucketId:"gemini-weekly"/"gemini-5h"/"3p-weekly"/"3p-5h", window:"weekly"/"5h", remainingFraction, resetTime, displayName}}` 2 groups, weekly+5h each; also top-level `description` |
| `loadCodeAssist` | POST | `/v1internal:loadCodeAssist` | `{metadata:{ideType:"ANTIGRAVITY"}}` | 200 | `{currentTier:{id, name, ...}, allowedTiers[], cloudaicompanionProject, paidTier}` |
| `fetchUserInfo` | POST | `/v1internal:fetchUserInfo` | `{}` | 200 | `{userSettings:{}, regionCode:"IN"}` |
| invalid token | POST | `/v1internal:retrieveUserQuotaSummary` | `{}` + `Bearer ya29.invalid…` | 401 | `{error:{code:401, status:"UNAUTHENTICATED", message:"Request had invalid authentication credentials…"}}` |

## Files

```
schema/
  README.md          — this file
  common.ts          — remainingFraction 0-1, resetTime ISO, Window/BucketId enums, headers, helpers
  auth.ts            — OAuth refresh req/res + error + packed refresh string (isGcpTos)
  quota.ts           — retrieveUserQuota req/res + GeminiCliQuotaSummary
  models.ts          — fetchAvailableModels req/res (MAP of CatalogModelEntry)
  weekly-limits.ts   — retrieveUserQuotaSummary req/res (PRIMARY) + QuotaWindowSummary transform shape
```

Each file:
- `import { z } from "zod"` (zod v4), strict ESM.
- Exports `*Schema` + inferred `*` type.
- Has a **REDACTED real observed response** comment block above the schema (never full token/email).
- `weekly-limits.ts` matches the *actual* observed weekly shape; fallback spec is `HANDOFF.md §6`/`§8` if live unreachable.

## How other agents import

```ts
import { RetrieveUserQuotaSummaryResponseSchema, type RetrieveUserQuotaSummaryResponse } from "../schema/weekly-limits";
// or from the installed package (built dist, exported via package.json "./schema"):
import { FetchAvailableModelsResponseSchema } from "opencode-antigravity-auth/schema";
import { RemainingFractionSchema } from "../schema/common";
```

## How to regenerate (live probe)

The throwaway probe script (`__live_probe.ts`) is intentionally not checked in.
To re-probe, write a small script locally that:

```powershell
# 1. Ensure env has OPENCODE_ANTIGRAVITY_CLIENT_ID / SECRET (see src/constants.ts)
# 2. Write a local (git-ignored) probe script that reuses the plugin's own helpers:
#    - src/plugin/storage.ts path resolution
#    - src/plugin/token.ts:refreshAccessToken
#    - src/constants.ts:getAntigravityHeaders
#    - src/plugin/project.ts:ensureProjectContext
#    and POSTs to: retrieveUserQuota / fetchAvailableModels / retrieveUserQuotaSummary
#    (+ daily hosts) / loadCodeAssist / fetchUserInfo + a 401 error-shape check.
# 3. Run it, e.g.:  bun run __live_probe.ts   # file stays untracked
# 4. Copy redacted response shapes into the comment blocks above each schema.
# 5. Adjust zod schemas to match observed field names (camelCase, optional resetTime, etc.).
# 6. Verify:
npm run typecheck
git status # must show no secrets
```

## Design notes (weekly)

- Only `retrieveUserQuotaSummary` carries weekly buckets; the other two quota endpoints are 5h-only.
- Field names are **camelCase**: `remainingFraction` (`number` 0-1, clamped), `resetTime` (`string` ISO 8601 `2026-08-30T05:47:08Z`), `bucketId`, `window`.
- `remainingFraction` missing/NaN → `undefined` (fail-open, not 0) — see `src/plugin/quota.ts:normalizeRemainingFraction`.
- Weekly reset ~7d, 5h reset ~5h. `groups` length 2: `Gemini Models` (`gemini-weekly` + `gemini-5h`) and `Claude and GPT models` (`3p-weekly` + `3p-5h`).
- Transform target (`QuotaWindowSummary`) per `HANDOFF.md §8`: `{ byGroup: Partial<Record<"gemini"|"3p", {weekly?, fiveHour?}>>, rawBuckets, fetchedAt }`.
