# opencode-antigravity-auth — Developer Handoff Document

> Compiled Aug 16, 2026. Covers: architecture, live API catalog, quota system,
> implemented changes, pending work, model propagation, feature ideas, ecosystem,
> config reference, and security notes.

---

## Table of Contents

1. [Project Identity](#1-project-identity)
2. [Architecture](#2-architecture)
3. [Auth Flow](#3-auth-flow)
4. [Live API Endpoint Catalog](#4-live-api-endpoint-catalog)
5. [Discoverable Models (24 live)](#5-discoverable-models-24-live)
6. [Quota System Deep-Dive](#6-quota-system-deep-dive)
7. [Changes Implemented This Session](#7-changes-implemented-this-session)
8. [Weekly Summary — Design Spec (Pending)](#8-weekly-summary--design-spec-pending)
9. [Model Propagation Pipeline](#9-model-propagation-pipeline)
10. [Feature Ideas from API Probes](#10-feature-ideas-from-api-probes)
11. [Ecosystem & Related Repos](#11-ecosystem--related-repos)
12. [Known Issues & Failure Modes](#12-known-issues--failure-modes)
13. [Config Reference (antigravity.json)](#13-config-reference-antigravityjson)
14. [Security Notes](#14-security-notes)

---

## 1. Project Identity

| Field | Value |
|-------|-------|
| Name | `opencode-antigravity-auth` |
| Version | 1.6.0 |
| Fork of | NoeFabris/opencode-antigravity-auth (archived Jun 2026, ~11k stars) |
| This fork | Utkarshchaudhary009/opencode-antigravity-auth |
| Branch | `main` (clean, 8 commits) |
| License | MIT |
| Runtime | Node >= 20, ESM, Bun-adjacent |
| Entry | `./dist/index.js` (also `./server`, `./tui`) |
| Test framework | vitest (`vitest.config.ts`) |
| Build | `npx tsc -p tsconfig.build.json` |

**Key deps:** `@opencode-ai/plugin ^1.14.19`, `google-auth-library ^10.3.0`,
`xdg-basedir ^5.1.0`, `zod ^4.0.0`.

**Dropped from upstream:** `@openauthjs/openauth`, `proper-lockfile`.
**Added:** `google-auth-library`, `./tui` export, `./server` export, bridge/ module.

**8 commits (topics):** plugin rework; auth-flow refactor + rate-limit fallback;
Antigravity IDE server bridge; bridge model resolution; headless bridge defaults +
Windows setup hardening; sponsor callout; TUI-plugin docs; stock-OpenCode compatibility.

---

## 2. Architecture

This is an **OpenCode custom-provider plugin** (not MCP). It registers:

```
{ event, tool: { google_search }, auth: { provider: "google", loader } }
```

The `auth.loader` returns a **custom `fetch`** that intercepts requests to
`generativelanguage.googleapis.com` and rewrites them to Google's internal
Cloud Code endpoints (`cloudcode-pa.googleapis.com/v1internal:*`) with a
Bearer OAuth token.

### Key source modules

| Module | Path | Purpose |
|--------|------|---------|
| Plugin entry | `src/plugin.ts` | Main plugin export, 429 handling, quota refresh triggers, request proxy |
| Accounts | `src/plugin/accounts.ts` | AccountManager, rate-limit state, health scores, rotation, selection |
| Quota | `src/plugin/quota.ts` | Quota probes (fetchAvailableModels quotaInfo, retrieveUserQuota), aggregation |
| Model catalog | `src/plugin/model-catalog.ts` | Runtime model discovery via fetchAvailableModels, 5-min cache |
| Model resolver | `src/plugin/transform/model-resolver.ts` | Tier suffixes, aliases, thinkingLevel, quota routing |
| Static models | `src/plugin/config/models.ts` | 11 hardcoded fallback model entries |
| Config schema | `src/plugin/config/schema.ts` | Zod schema for antigravity.json options |
| Config updater | `src/plugin/config/updater.ts` | Writes model defs into opencode.json |
| Storage | `src/plugin/storage.ts` | Accounts file persistence (v4 schema), migrations |
| Rotation | `src/plugin/rotation.ts` | Health scores, LRU+health hybrid, token buckets |
| Refresh queue | `src/plugin/refresh-queue.ts` | Proactive token refresh 30min before expiry |
| OAuth | `src/plugin/server.ts` | Local OAuth callback server (random port, PKCE) |
| Verification | `src/plugin/verification.ts` | gemini-3-flash ping probe, VALIDATION_REQUIRED handling |
| TUI | `src/tui.ts` | /ag-accounts dialog, quota display, load-balancer settings |
| Bridge | `src/bridge/` | Antigravity IDE server bridge (headless mode) |
| CLI helper | `src/cli/account.ts` | Standalone add/list/clear subcommands |
| Constants | `src/constants.ts` | Endpoints, UA strings, headers, client ID env vars |
| Debug | `src/plugin/debug.ts` | Structured logger, TUI panel, file rotation (25 files) |

### File locations at runtime

| File | Path |
|------|------|
| Plugin config | `~/.config/opencode/antigravity.json` |
| Accounts + tokens | `~/.config/opencode/antigravity-accounts.json` |
| OpenCode config | `~/.config/opencode/opencode.json` |
| Debug logs | `~/.config/opencode/antigravity-logs/antigravity-debug-<ts>.log` |
| Override dir | `OPENCODE_CONFIG_DIR` env var |

---

## 3. Auth Flow

- **OAuth 2.0 authorization-code + PKCE (S256)**, `access_type=offline`.
- Client ID/secret sourced from env: `OPENCODE_ANTIGRAVITY_CLIENT_ID`,
  `OPENCODE_ANTIGRAVITY_CLIENT_SECRET` (not hardcoded in this fork).
- Scopes: `cloud-platform`, `userinfo.email`, `userinfo.profile`, `cclog`,
  `experimentsandconfigs`, `openid`.
- Local callback server on `http://localhost:<random-port>/oauth-callback`
  (bind `127.0.0.1`; `0.0.0.0` for WSL/SSH/remote; `OPENCODE_ANTIGRAVITY_OAUTH_BIND` override).
- Manual URL-paste fallback for headless/container environments.
- Tokens stored as **plaintext JSON** in `antigravity-accounts.json` (no OS keychain).
- Access tokens auto-refreshed via `oauth2.googleapis.com/token` ~60s before expiry;
  `ProactiveRefreshQueue` (`src/plugin/refresh-queue.ts`) refreshes 30min before expiry
  on a 5-min check interval.

---

## 4. Live API Endpoint Catalog

All tested 2026-08-16 with Bearer token (scopes: cloud-platform, userinfo.email/profile,
cclog, experimentsandconfigs, openid). Host: `cloudcode-pa.googleapis.com` unless noted.

### Working endpoints (200)

| Endpoint | Method | Body | What it returns |
|----------|--------|------|-----------------|
| `v1internal:fetchAvailableModels` | POST | `{"project":"<pid>"}` | **24 models** as a MAP (keyed by model ID), each with `displayName`, `quotaInfo{remainingFraction, resetTime}`, `model`, `apiProvider`, `modelProvider`, optional `supportsThinking/maxTokens`. Also: `defaultAgentModelId`, `tieredModelIds`, `deprecatedModelIds`, `experimentIds` (54). |
| `v1internal:retrieveUserQuota` | POST | `{"project":"<pid>"}` | `buckets[]` — 24 entries, each `{tokenType:"WTUS", modelId, remainingFraction, resetTime?}`. Tab/preview IDs lack `resetTime`. |
| `v1internal:retrieveUserQuotaSummary` | POST | `{}` | **Weekly + 5h windows.** See [Section 6](#6-quota-system-deep-dive) for exact shape. Works on prod/daily/daily-sandbox hosts. |
| `v1internal:loadCodeAssist` | POST | `{"metadata":{"ideType":"ANTIGRAVITY"}}` | `{currentTier:{id, name, description, privacyNotice, upgradeSubscriptionUri, upgradeSubscriptionType:"GOOGLE_ONE"}, allowedTiers:[...]}`. Note: body `{"project":"<pid>"}` returns 400. |
| `v1internal:fetchUserInfo` | POST | `{}` | `{userSettings: {}, regionCode: "IN"}` |
| `v1internal:listExperiments` | POST | `{}` | **88 experimentIds** + **342 flags** (see feature ideas below) |
| `v1internal:fetchAdminControls` | POST | `{"project":"<pid>"}` | `{}` (empty for free tier) |
| `v1internal:fetchCodeCustomizationState` | POST | `{"project":"<pid>"}` | `{state: "DISABLED"}` |
| `v1internal:checkUrlDenylist` | POST | `{"url":"https://example.com"}` | `{}` (empty = not denied). Note: field is singular `url` (string), not `urls`. |

### Failed endpoints

| Endpoint | Status | Reason |
|----------|--------|--------|
| `v1internal:listModelConfigs` | 400 | INVALID_ARGUMENT on every body variant tried — proto shape unknown |
| `v1internal:countTokens` | 400 | INVALID_ARGUMENT `{model, contents}` — different proto shape needed |
| `v1internal:onboardUser` | 400 | Proto shape unknown; likely mutating — unsafe to probe further |
| `v1internal:listAgents` | 404 | Route does not exist on prod |
| `v1internal:listCloudAICompanionProjects` | 404 | Route does not exist on prod |
| `v1internal:getCodeAssistGlobalUserSetting` | 404 | Route does not exist on prod |
| `v1internal:listRemoteRepositories` | 404 | Route does not exist on prod |
| `generativelanguage.googleapis.com/v1beta/models` (GET, Bearer) | 403 | `ACCESS_TOKEN_SCOPE_INSUFFICIENT` — public Gemini API needs API key or GCP OAuth with different scopes |
| `v1internal:streamGenerateContent` | — | Skipped (quota spend) |

### Full v1internal verb catalog (from binary analysis + community RE)

**Generation:** `generateContent`, `streamGenerateContent`, `countTokens`,
`fetchAvailableModels`, `retrieveUserQuota`, `completeCode`, `generateCode`,
`streamGenerateChat`, `generateChat`, `tabChat`, `internalAtomicAgenticChat`,
`transformCode`, `migrateDatabaseCode`, `rewriteUri`, `searchSnippets`

**User/project:** `loadCodeAssist`, `onboardUser`, `onboardUserBackgroundTasks`,
`fetchUserInfo`, `setUserSettings`, `listAgents`, `listCloudAICompanionProjects`,
`listRemoteRepositories`

**Config/experiments:** `listModelConfigs`, `listExperiments`,
`getCodeAssistGlobalUserSetting`, `setCodeAssistGlobalUserSetting`,
`fetchAdminControls`, `fetchCodeCustomizationState`, `checkUrlDenylist`

**Telemetry:** `recordClientEvent`, `recordCodeAssistMetrics`,
`recordSmartchoicesFeedback`, `recordTrajectoryAnalytics`, `logClientError`

### Hosts (fallback chains)

| Host | Status |
|------|--------|
| `cloudcode-pa.googleapis.com` (prod) | Active |
| `daily-cloudcode-pa.googleapis.com` (staging) | Active |
| `daily-cloudcode-pa.sandbox.googleapis.com` (sandbox) | Active |
| `autopush-cloudcode-pa.sandbox.googleapis.com` | Unavailable |

The fork's current fallback order is **prod -> daily -> daily-sandbox -> autopush**.
Antigravity-Manager uses **sandbox -> daily -> prod** (deliberately dodges prod 429s).

---

## 5. Discoverable Models (24 live)

From `fetchAvailableModels` as of 2026-08-16:

| Model ID | Category | Notes |
|----------|----------|-------|
| `gemini-2.5-pro` | Gemini | |
| `gemini-2.5-flash` | Gemini | |
| `gemini-2.5-flash-lite` | Gemini | |
| `gemini-2.5-flash-thinking` | Gemini | |
| `gemini-3-flash` | Gemini | |
| `gemini-3-flash-agent` | Gemini | |
| `gemini-3.1-pro-high` | Gemini | Tier variant |
| `gemini-3.1-pro-low` | Gemini | Tier variant |
| `gemini-3.1-flash-lite` | Gemini | |
| `gemini-3.1-flash-image` | Gemini | |
| `gemini-3.5-flash-low` | Gemini | Tier variant |
| `gemini-3.5-flash-extra-low` | Gemini | Tier variant |
| `gemini-3.6-flash-high` | Gemini | **Default agent model** |
| `gemini-3.6-flash-medium` | Gemini | Tier variant |
| `gemini-3.6-flash-low` | Gemini | Tier variant |
| `gemini-3.6-flash-tiered` | Gemini | Tier variant |
| `gemini-pro-agent` | Gemini | Replaces deprecated gemini-3.1-pro-high |
| `claude-opus-4-6-thinking` | Claude (3P) | |
| `claude-sonnet-4-6` | Claude (3P) | |
| `gpt-oss-120b-medium` | GPT (3P) | |
| `chat_20706` | Internal | Tab/preview, no resetTime |
| `chat_23310` | Internal | Tab/preview, no resetTime |
| `tab_flash_lite_preview` | Internal | Preview |
| `tab_jump_flash_lite_preview` | Internal | Preview |

**Metadata per model:** `displayName`, `quotaInfo{remainingFraction, resetTime}`,
`model` (internal), `apiProvider`, `modelProvider`, optional `supportsThinking`,
`maxTokens`, `maxOutputTokens`.

**Static fallback catalog** (`src/plugin/config/models.ts`): only 11 hardcoded entries.
The live endpoint returns 24 — the static catalog should become a cold-start fallback
only (see [Section 9](#9-model-propagation-pipeline)).

---

## 6. Quota System Deep-Dive

### Dual quota pools

The plugin manages **two independent quota pools**:

1. **Antigravity pool** — via `fetchAvailableModels` quotaInfo per model (remainingFraction,
   resetTime), UA `antigravity/<ver> <plat>/<arch>`.
2. **Gemini CLI pool** — via `retrieveUserQuota` buckets, UA `GeminiCLI/1.0.0/gemini-2.5-pro
   (<plat>; <arch>)`, filtered to `gemini-3-*`/`gemini-2.5-pro`.

**Rate-limit decision:** Gemini models are limited only when **BOTH** pools are limited
(min-wait of the two). Claude uses only the Antigravity pool.

### retrieveUserQuotaSummary — confirmed live shape

```json
{
  "groups": [
    {
      "displayName": "Gemini Models",
      "description": "Models within this group: Gemini Flash, Gemini Pro",
      "buckets": [
        {
          "bucketId": "gemini-weekly",
          "displayName": "Weekly Limit Remaining",
          "window": "weekly",
          "resetTime": "2026-08-16T13:44:12Z",
          "description": "You have used some of your weekly limit...",
          "remainingFraction": 0.9907209
        },
        {
          "bucketId": "gemini-5h",
          "displayName": "Five Hour Limit Remaining",
          "window": "5h",
          "resetTime": "2026-08-16T11:45:11Z",
          "remainingFraction": 1
        }
      ]
    },
    {
      "displayName": "Claude and GPT models",
      "description": "Models within this group: Claude Opus, Claude Sonnet, GPT-OSS",
      "buckets": [
        {
          "bucketId": "3p-weekly",
          "displayName": "Weekly Limit Remaining",
          "window": "weekly",
          "resetTime": "2026-08-18T09:53:30Z",
          "remainingFraction": 0.55250067
        },
        {
          "bucketId": "3p-5h",
          "displayName": "Five Hour Limit Remaining",
          "window": "5h",
          "resetTime": "...",
          "remainingFraction": 1
        }
      ]
    }
  ],
  "description": "Within each group, models share a weekly limit and a 5-hour limit..."
}
```

**Key facts:**
- Fields are **camelCase** (bucketId, displayName, remainingFraction, resetTime).
- Two groups: Gemini (gemini-weekly + gemini-5h) and Claude/GPT (3p-weekly + 3p-5h).
- Weekly buckets exist **ONLY** in this endpoint (not in fetchAvailableModels or
  retrieveUserQuota, which only carry 5h-style quotaInfo).
- Served by all three hosts (prod/daily/sandbox) — prod is sufficient.
- Free accounts show all buckets; paid tier differences are unknown (not tested).

### Quota fetch code paths (current)

| Function | File:Line | What it fetches |
|----------|-----------|-----------------|
| `fetchAvailableModelsCatalog` | `model-catalog.ts:224-256` | Models + quotaInfo from `v1internal:fetchAvailableModels` |
| `fetchGeminiCliQuota` | `quota.ts (fetchGeminiCliQuota)` | Buckets from `v1internal:retrieveUserQuota` |
| `fetchWeeklyLimits` | `weekly-limits.ts:fetchWeeklyLimits` | Weekly+5h windows from `v1internal:retrieveUserQuotaSummary` (10s timeout covering body reads, Bearer+UA `antigravity/1.22.2`, zod `RetrieveUserQuotaSummaryResponseSchema`, `byGroup` via `inferWindowFromBucketId`/`groupDisplayNameToKey`, fail-open empty on non-ok/network/malformed; 401/403 → `AntigravityTokenRefreshError` which callers fail open on) |
| `checkAccountsQuota` | `quota.ts (checkAccountsQuota)` | Orchestrates 3 probes in `Promise.all` per account (`fetchAvailableModelsCatalog` + `fetchGeminiCliQuota` + `fetchWeeklyLimits` fail-open via `emptyQuotaWindowSummary`); returns `AccountQuotaResult` with optional `weeklyLimits?: QuotaWindowSummary` (ephemeral per-check, not persisted — see `weekly-limits.ts` caching note) |
| `triggerAsyncQuotaRefreshForAccount` | `plugin.ts:126-170` | Fire-and-forget post-success refresh, gated by interval |

### Rate-limit state machine

- **State:** `rateLimitResetTimes` per-account, keyed by `QuotaKey`
  (`"claude"`, `"gemini-antigravity"`, `"gemini-cli"`, or `"<base>:<model>"`).
- **Decision:** `isRateLimitedForQuotaKey(account, key, graceMs)` checks
  `nowMs() < resetTime + graceMs`.
- **Gemini dual gate:** limited only when BOTH `gemini-antigravity` AND `gemini-cli`
  keys are limited; min-wait = min of the two.
- **Pruning:** `clearExpiredRateLimits(account, graceMs)` deletes keys where
  `now >= resetTime + graceMs`.
- **Persistence:** `antigravity-accounts.json` v4 schema, atomic rename (0600),
  debounced merge saves (1s), NO real file lock (proper-lockfile was dropped).

### 429 parsing

| Source | File:Line | What it extracts |
|--------|-----------|------------------|
| `retryAfterMsFromResponse` | `plugin.ts:266-284` | Retry-After header; returns `number \| null` (null = no info) |
| `extractRateLimitBodyInfo` | `plugin.ts:336-406` | `google.rpc.ErrorInfo.reason`, `RetryInfo.retryDelay` (Go durations), `metadata.quotaResetDelay/TimeStamp`, "reset after X" regex |
| `parseRateLimitReason` | `accounts.ts:46-95` | 529/503 -> MODEL_CAPACITY, 500 -> SERVER_ERROR, plus heuristics |

**Backoff ladders:**

| Reason | Ladder |
|--------|--------|
| QUOTA_EXHAUSTED | 60s, 300s, 30min, 2h (by consecutiveFailures) |
| RATE_LIMIT_EXCEEDED | 30s |
| MODEL_CAPACITY | 45s +/- 15s jitter |
| SERVER_ERROR | 20s |
| UNKNOWN | 60s |

**In-flight retries:** 1s -> 8s x +/-10% jitter, fingerprint regen after 3 capacity
retries. Dedup window: 2s (`RATE_LIMIT_DEDUP_WINDOW_MS`). State resets after 120s quiet.

---

## 7. Changes Implemented This Session

All changes are in the working tree (uncommitted). 8 modified tracked files +
2 untracked files (`bun.lock`, `src/tui.test.ts`). Tests: 935+ passed (3 pre-existing environmental failures
in token.test.ts x2, version.test.ts x1). dist/ rebuilt.

### Change 1: Grace-to-deadline margin

**Problem:** Plugin races the reset boundary and immediately re-429s because
`getMinWaitTimeForSoftQuota` and `isRateLimitedForQuotaKey` use raw reset times
with no margin.

**Solution:** New config option `grace_to_deadline_ms` (default 1500, max 10000).
Threaded as `graceMs` through all rate-limit check + min-wait functions.
An account is only considered usable once `now` passes `resetTime + graceMs`.

**Files:**
- `src/plugin/config/schema.ts` — zod option + DEFAULT_CONFIG
- `script/build-schema.ts` — option description
- `src/plugin/accounts.ts` — `graceMs` parameter added to: `isRateLimitedForQuotaKey`,
  `isRateLimitedForFamily`, `isRateLimitedForHeaderStyle`, `clearExpiredRateLimits`,
  `getNextForFamily`, `selectAccountForFamily`, `getMinWaitTimeForFamily`,
  `getMinWaitTimeForSoftQuota`, `shouldTryOptimisticReset`
- `src/plugin.ts` — reads `config.grace_to_deadline_ms` and passes to all call sites

### Change 2: GraceRetry (dead code activated)

**Problem:** `shouldTryOptimisticReset` existed (accounts.ts:820-823) but had
**no caller** in production — only tests (kept as a test-only helper). The live
429 path used a 1s first-retry delay regardless of how close the account was to
recovering.

**Solution:** New helper `isOptimisticResetEligible(minWaitMs)` (accounts.ts ~L126)
and `getGraceRetryDelayMs(accountManager, family, model, graceMs, currentRetryMs?,
headerStyle?)` (accounts.ts ~L162-179). Wired into the 429 path (plugin.ts ~L1581):
when the CURRENT 429's retry time is within the 2s optimistic window, retries the
SAME account immediately with `currentRetryMs + graceMs` delay instead of the full
backoff ladder. Bounded by `maxCacheFirstWaitMs`.

**Reviewer findings fixed:**
- MED-1: state fallback was dead code because retryAfterMsFromResponse returned 60s
  default instead of null. Fixed: returns `null` when no actual retry info; grace path
  passes `hasRetryInfo ? serverRetryMs : null`.
- MED-2: feature was inert at defaults (eligibility = retry+grace <= 2000; with
  grace=1500, only <=500ms retries qualified). Fixed: eligibility uses raw
  `currentRetryMs <= 2000` without adding grace; returned delay = `currentRetryMs + graceMs`.
- LOW-1: cache_first contract bypassed. Fixed: grace path only when
  `graceRetryDelayMs <= maxCacheFirstWaitMs`.
- LOW-2: unbounded config. Fixed: `.max(10_000)` on `grace_to_deadline_ms`.

### Change 3: Fail-open normalizeRemainingFraction

**Problem:** `normalizeRemainingFraction` (quota.ts) mapped missing/NaN/negative
to **0 (exhausted)**, causing false lockouts on the Gemini CLI path when quota data
was missing or a fetch failed.

**Solution:** Returns `undefined` for missing/invalid input (fail-open); valid values
clamp to [0,1]. Return type changed to `number | undefined`. Updated callers:
- `quota.ts` — aggregation paths propagate undefined
- `debug.ts` — `logQuotaStatus` accepts `number | undefined`, logs `UNKNOWN` for undefined
- `tui.ts` — renders undefined as `n/a` via `formatQuotaPercent`/`formatPct`

**Tests:** 19/19 quota tests pass; updated assertions from missing->0 to missing->undefined.

---

## 8. Weekly Summary — Design Spec (Pending)

Implementation was designed but deferred pending endpoint verification (now confirmed).

### Part 1: Data fetch (`src/plugin/quota.ts`)

New types:

```typescript
interface WindowBucket {
  remainingFraction?: number;
  resetTime?: string;
}

interface QuotaWindowSummary {
  byGroup: Partial<Record<QuotaGroup, {
    weekly?: WindowBucket;
    fiveHour?: WindowBucket;
  }>>;
  rawBuckets: {
    bucketId: string;
    window: string;
    remainingFraction?: number;
    resetTime?: string;
  }[];
  fetchedAt: number;
}
```

New function `fetchUserQuotaSummary(accessToken, projectId?)`:
- `POST ${ANTIGRAVITY_ENDPOINT_PROD}/v1internal:retrieveUserQuotaSummary`
- Body: `{}`
- Headers: Bearer, UA from `getAntigravityHeaders()`, Content-Type JSON
- Timeout: 10s via `fetchWithTimeout`
- Error handling: non-OK/network -> `undefined` (fail-open, no throw)
- Parser: read `groups[].buckets[]` (primary shape); one fallback: `buckets[]`
  at top level. Per bucket: normalize via `normalizeRemainingFraction` + `parseResetTime`.
- Group -> family mapping: "Gemini Models" -> `gemini-pro` AND `gemini-flash`;
  "Claude and GPT" -> `claude`. Note: mapping is COARSER than per-model — summary
  has 2 groups, plugin has 3 families.
- Window: read `bucket.window` (canonical); fallback: infer from `bucketId`
  containing "weekly"/"5h".
- Wire into `checkAccountsQuota` (L367-374) as 3rd arm:
  `Promise.all([fetchAvailableModelsCatalog, fetchGeminiCliQuota, fetchUserQuotaSummary])`

### Part 2: Storage

- Add `quotaSummary?: QuotaWindowSummary` to `ManagedAccount` (beside `cachedQuota`).
- Persist via `toMetadata`.
- New `AccountStorageV5`, `migrateV4ToV5` (`...acc, quotaSummary: undefined`).
- `mergeAccountStorage`: keep newer quotaSummary by comparing `fetchedAt`.
- Refresh: reuse existing trigger (`triggerAsyncQuotaRefreshForAccount`) and manual
  "Check quotas"; gate on `quota_summary_enabled` config.

### Part 3: TUI display

After per-family Antigravity lines in the quota dialog, add a **"Window Limits"** section:

```
  W  99% . resets 3d 2h  |  5h  100% . resets 4h 10m     Gemini
  W  55% . resets 1d 18h |  5h  100% . resets 4h 50m     Claude & GPT
```

Using existing `formatQuotaPercent` + `formatReset`; undefined -> `n/a`.

Status tags: add `low-weekly` when any weekly < 20%; `weekly Xd` when weekly
resetTime is in the future.

### Part 4: Enforcement (follow-up, not in initial scope)

- Soft-quota gate: skip account when weekly/5h `remainingFraction <=
  (100 - soft_quota_threshold_percent) / 100`. Fail-open: missing -> usable.
- Long-pole waits: in `getMinWaitTimeForSoftQuota`, include weekly `resetTime +
  grace - now` in the Math.min.
- Immediate-429 path stays untouched — the live `rateLimitResetTimes` machinery
  remains source of truth.

### Part 5: Config

New option: `quota_summary_enabled` (boolean, default true). Gate the fetch call.

---

## 9. Model Propagation Pipeline

### Current flow (3 stages)

1. **Static catalog** (`src/plugin/config/models.ts:40-114`): 11 hardcoded entries
   (5 antigravity-*, 6 gemini-* CLI models). Each: name, limit {context, output},
   modalities, optional variants (thinkingLevel for Gemini 3; thinkingConfig for Claude).

2. **Runtime discovery** (`src/plugin/model-catalog.ts:262-321`): `provider.models()`
   hook -> `getRuntimeAntigravityModels(auth, provider)` -> POST
   `fetchAvailableModels` (24 live models, 5-min cache). Skips disabled/deprecated,
   normalizes IDs to `antigravity-` prefix, templates each entry off existing
   provider.models (config/fallback) for api/npm/headers/cost. Merge:
   `{...fallback, ...discovered}` — discovered wins on ID collision, adds new IDs.

3. **Config write** (`src/tui.ts:1073-1089` -> `updateOpencodeConfig()`,
   `src/plugin/config/updater.ts:110-179`): writes **only the static catalog** to
   `provider.google.models` in opencode.json. **Discovered models never reach
   opencode.json** — so "Configure models" overwrites dynamic models with hardcoded ones.

### opencode.json model entry format

```json
{
  "provider": {
    "google": {
      "models": {
        "antigravity-gemini-3-pro": {
          "name": "Gemini 3 Pro",
          "limit": { "context": 1048576, "output": 65536 },
          "modalities": { "input": ["text", "image"], "output": ["text"] },
          "variants": { ... }
        }
      }
    }
  }
}
```

Full OpenCode model fields (from `src/plugin/types.ts:59-78`): `id`, `providerID`,
`name`, `family`, `api {id, url, npm}`, `capabilities`, `cost`, `limit {context,
input, output}`, `status`, `headers`, `options`, `release_date`, `variants`.
Config-file overrides use a subset: `name`, `options`, `variants`, `contextWindow`.

### OpenCode plugin system support

- `provider.models()` hook: returns `Record<string, ProviderModel>` merged at startup.
  **Works** because `google` is a models.dev catalog provider.
- **Regression #25630** (open): hook only fires for providers in models.dev catalog;
  custom non-catalog providers silently skipped. `google` is unaffected currently but fragile.
- **PR #42660** (open, Aug 2026): native dynamic discovery for `@ai-sdk/openai-compatible`
  only — not the google/antigravity path.
- OpenCode does **not** auto-discover from the google provider; it relies on
  models.dev catalog + opencode.json + plugin hooks.

### Recommendation

1. Make `updateOpencodeConfig()` dynamic: fetch via `fetchAvailableModelsCatalog`
   (24 live models) and serialize `buildDiscoveredModels()` output instead of the
   static `OPENCODE_MODEL_DEFINITIONS`. Synthesize variants from tier support.
2. Keep the static catalog as **cold-start fallback only** (offline, unauthenticated,
   fetchAvailableModels failure). Removing it entirely breaks: model picker before
   login, offline use, Claude templates (Claude isn't in models.dev google catalog).
3. Publish discovered models through **both channels**: `provider.models()` hook
   (runtime) AND config write (persistence) — the config write currently defeats
   dynamic discovery.
4. Map `quotaInfo` into per-model UI/status (recommended, disabled) — it's the one
   piece of live data opencode.json can't express.
5. Watch #25630 — if the hook regresses, switch to `config()` injection.

---

## 10. Feature Ideas from API Probes

### From listExperiments (342 flags)

| Feature | Implementation |
|---------|---------------|
| Feature flag dashboard | Show enabled/disabled experiments in TUI, especially model launch gates and CLI config values |
| Dynamic behavior tuning | Read `cli_max_attempts` (10), `cli_request_timeout_seconds` (300), `max-tokens-per-step` (16384), `prompt_complexity` threshold (90) at startup instead of hardcoding |
| Preview model indicator | Highlight when preview models are available (`GeminiCLIPreviewAvailable__enable_preview: true`) |
| Upcoming feature tracking | Monitor `enable-deepagent`, `enable-agent-team`, `enable-profiles`, `enable-plugins`, `enable-conversation-forking` — announce when they go true |

**Key flag values (live):**
- `CliComplexityBasedRouting__enabled: true` (threshold 90)
- `cli_max_attempts: 10`, `cli_request_timeout_seconds: 300`, `cli_total_request_timeout_seconds: 600`
- `max-tokens-per-step: 16384`, `max-conversation-save-count: 500`
- `enable-tasks: true`, `enable-customization-skills: true`, `enable-markdown-agents: true`
- `DuetAiLocalRag__enable_local_rag: true`, `Chat__enable_full_codebase_awareness_chat: true`
- `customization-token-budget: 20000`
- `cascade-conversation-history-config: {enabled: true, max_conversations: 20}`
- Model launch: `gemini_3_pro_launched: true`, `gemini_3_1_pro_preview_launched: true`,
  `gemini_3_1_flash_preview_launched: true`

### From other endpoints

| Endpoint | Feature |
|----------|---------|
| `fetchUserInfo` (regionCode) | Region badge in account status ("Region: IN") |
| `loadCodeAssist` (currentTier) | **Tier badge** ("Free" vs "Google One AI Pro") in account tags; upgrade prompt when quota is low |
| `fetchAdminControls` | Surface enterprise admin restrictions (blocked models, content policies) as warnings — prevents wasted quota |
| `fetchCodeCustomizationState` | Show customization status; when ENABLED, unlock code-style personalization UI |
| `checkUrlDenylist` | Pre-check URLs before including as context; warn if denied instead of silently failing |
| `retrieveUserQuotaSummary` | Live weekly/5h quota dashboard (the critical one — design spec in Section 8) |

---

## 11. Ecosystem & Related Repos

### Successors / active forks

| Repo | Stars | npm | Notes |
|------|-------|-----|-------|
| luckdevx/opencode-antigravity | low | `opencode-antigravity` v1.6.2 | Newest npm publish (2026-08-07); de-facto successor |
| cortexkit/antigravity-auth | 13 | `@cortexkit/opencode-antigravity-auth` v2.1.0 | Also targets "Pi" |
| BenjaMolina/opencode-antigravity-guard | low | `@benjamolina/...-guard` v1.1.9 | "Strict reset-time quota locking" |
| mrhisyammm/opencode-antigravity-auth | 5 | — | ESM fix + Gemini 3.5 support |

### Siblings (other auth plugins)

| Repo | Stars | Notes |
|------|-------|-------|
| jenslys/opencode-gemini-auth | 1,726 | Gemini auth plugin (similar architecture) |
| izzzzzi/opencode-gemini-business | 5 | Multi-account Gemini Business pool |
| ericc-ch/opencode-google-auth | 0 | — |
| fares111111122/fares-antigravity-oauth | 2 | "Anti-ban protection" |

### Pooling / quota infrastructure

| Repo | Stars | Notes |
|------|-------|-------|
| **lbjlaq/Antigravity-Manager** | **30,380** | Tauri/Rust multi-account pool, 429-driven rotation, JA3 spoofing, React dashboard. The most complete pooling implementation. |
| aqua5230/usage | 289 | Quota/burn-rate tray app; `agy_quota_probe.py` documents `retrieveUserQuotaSummary` |
| firdyfirdy/antigravity-auth | 9 | Python port with multi-account + automatic quota routing |
| vahapogut/antigravity-add-model | low | Injects external models into Antigravity Electron via v1internal RE |

### Comparison: this fork vs Antigravity-Manager

| Aspect | This fork (OpenCode plugin) | Antigravity-Manager (Tauri/Rust) |
|--------|----------------------------|----------------------------------|
| Quota endpoints | fetchAvailableModels + retrieveUserQuota | fetchAvailableModels + **retrieveUserQuotaSummary** (weekly/5h) |
| Host fallback | prod -> daily -> sandbox | **sandbox -> daily -> prod** (dodge prod 429s) |
| Missing data | normalizeRemainingFraction missing -> **undefined** (fixed this session) | Models lacking quotaInfo **dropped entirely** |
| Rate-limit state | In-memory + JSON file, **no real lock**, debounced saves | In-memory DashMap + DB, circuit breaker, 3600s expiry |
| Rotation | Health scores (70, +1/-10/-20) + LRU hybrid + stickiness + **token buckets (50, 6/min)** | **P2C: pick 2 random from top-5**; capability -> tier -> quota sorting |
| TLS fingerprint | **UA spoofing only** (no TLS) | request **Chrome123 JA3 emulation** on egress; pure TLS for quota/OAuth |
| 429 grace | **+1500ms grace-to-deadline** (implemented this session) + **GraceRetry <=2s** | **+1500ms grace + GraceRetry <=2s** + in-place retry |
| Presentation | In-TUI slash-command dialog (`/ag-accounts`) | Standalone desktop app + **API proxy** (OpenAI/Anthropic/Gemini formats) |
| Scope | Works inside OpenCode agent TUI | Works with **any client** (Claude Code, SDKs, etc.) |

---

## 12. Known Issues & Failure Modes

### From upstream NoeFabris repo issues

| Issue | Description | Root cause |
|-------|-------------|------------|
| #263 | All-accounts-rate-limited false positive | `MODEL_CAPACITY_EXHAUSTED` misread as account quota; locks all accounts |
| #297 | Infinite account cycling (489MB logs) | antigravity vs gemini-cli pool key disagreement; 60s retryAfter ignored |
| #362 | 403 verify-your-account | `VALIDATION_REQUIRED`; device flagging by Google |
| #538 | Stale rate-limit state until restart | Plugin loaded from cached node_modules; needs request-time reload |
| #542 | Watcher misses rate-limit | Timing gap between markRateLimited -> saveToDisk -> read |
| #549 | "All N accounts rate-limited, resets in 167h" hard-fail to TUI | Thrown after max_rate_limit_wait_seconds (10s) |
| #589 | Stale block/verification flags | Refresh keeps stale flags; duplicates |
| #591 | G1 credit exhaustion unclassified | `INSUFFICIENT_G1_CREDITS_BALANCE` mapped to UNKNOWN |

### This fork's status on those issues

| Issue | Status in this fork |
|-------|---------------------|
| #263 (capacity misread) | Partially mitigated: fail-open normalizeRemainingFraction prevents false exhaustion from missing data |
| #297 (infinite cycling) | Partially mitigated: grace-to-deadline + GraceRetry reduce thrashing |
| #362 (403 verify) | Handled: verification.ts ping probe + TUI dialog |
| #538 (stale state) | Still present: proper-lockfile was dropped; no real file lock |
| #591 (G1 credits) | **NOT handled:** `INSUFFICIENT_G1_CREDITS_BALANCE` has 0 hits in this fork; falls to UNKNOWN 60s loop |

### Security leak vector

`loadCodeAssist.upgradeSubscriptionUri` embeds the **percent-encoded email**
(`%40`-encoded `@`). Any logging/redaction must handle encoded emails. The fork's
redaction does not currently catch this.

---

## 13. Config Reference (antigravity.json)

All options from `src/plugin/config/schema.ts` with defaults:

### General
| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `quiet_mode` | boolean | false | Suppress non-error toasts |
| `toast_scope` | "root_only" \| "all" | "root_only" | Toast visibility scope |
| `debug` | boolean | false | Enable debug logging |
| `debug_tui` | boolean | false | Enable TUI debug panel |
| `log_dir` | string? | auto | Override log directory |
| `app_dir` | string? | auto | Override app directory (Windows) |

### Session & Recovery
| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `keep_thinking` | boolean | false | Preserve thinking tokens in context |
| `session_recovery` | boolean | true | Enable session recovery on errors |
| `auto_resume` | boolean | false | Auto-resume interrupted sessions |
| `resume_text` | string | "continue" | Text sent on auto-resume |
| `signature_cache` | object | `{enabled:true, memory_ttl:3600, disk_ttl:172800, write_interval:60}` | Response signature cache config |
| `empty_response_max_attempts` | number | 4 | Max retries for empty responses |
| `empty_response_retry_delay_ms` | number | 2000 | Delay between empty response retries |
| `tool_id_recovery` | boolean | true | Recover from tool ID mismatches |
| `claude_tool_hardening` | boolean | true | Harden Claude tool calls |
| `claude_prompt_auto_caching` | boolean | false | Auto-cache Claude prompts |

### Token Refresh
| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `proactive_token_refresh` | boolean | true | Enable proactive token refresh |
| `proactive_refresh_buffer_seconds` | number | 1800 | Refresh buffer before expiry (30min) |
| `proactive_refresh_check_interval_seconds` | number | 300 | Check interval (5min) |

### Rate Limiting & Backoff
| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `max_rate_limit_wait_seconds` | number | 300 | Max wait before hard-failing to TUI |
| `grace_to_deadline_ms` | number | 1500 | Grace margin on reset boundaries (0-10000) |
| `failure_ttl_seconds` | number | 3600 | Failed account cooldown |
| `default_retry_after_seconds` | number | 60 | Default retry delay when no server info |
| `max_backoff_seconds` | number | 60 | Max backoff for UNKNOWN reasons |
| `request_jitter_max_ms` | number | 0 | Jitter on outgoing requests (0-5000) |

### Account Selection
| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `account_selection_strategy` | "hybrid" \| "sticky" \| "round-robin" | "hybrid" | Selection strategy |
| `pid_offset_enabled` | boolean | false | PID-based offset for multi-instance |
| `switch_on_first_rate_limit` | boolean | true | Switch account on first 429 |
| `scheduling_mode` | "cache_first" \| "balance" \| "performance_first" | "cache_first" | Load-balancing mode |
| `max_cache_first_wait_seconds` | number | 60 | Max wait for cache-first same-account retry |

### Health Scores
| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `health_score.initial` | number | 70 | Initial health score |
| `health_score.success_reward` | number | 1 | Score increase per success |
| `health_score.rate_limit_penalty` | number | -10 | Score decrease per rate-limit |
| `health_score.failure_penalty` | number | -20 | Score decrease per failure |
| `health_score.recovery_rate_per_hour` | number | 2 | Passive recovery per hour |
| `health_score.min_usable` | number | 50 | Minimum score for selection |
| `health_score.max_score` | number | 100 | Maximum score |

### Token Buckets (client-side 429 prevention)
| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `token_bucket.max_tokens` | number | 50 | Bucket capacity |
| `token_bucket.regeneration_rate_per_minute` | number | 6 | Tokens regenerated per minute |
| `token_bucket.initial_tokens` | number | 50 | Initial token count |

### Quota
| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `soft_quota_threshold_percent` | number | 90 | Preemptive switching threshold (1-100) |
| `quota_refresh_interval_minutes` | number | 15 | Background refresh interval (0=disabled) |
| `soft_quota_cache_ttl_minutes` | "auto" \| number | "auto" | Cache TTL; "auto" = max(2x interval, 10) |
| `quota_fallback` | boolean | false | **Deprecated/ignored** |
| `cli_first` | boolean | false | Prefer Gemini CLI pool routing |

### Other
| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `auto_update` | boolean | true | Check for plugin updates on session start |

---

## 14. Security Notes

1. **Tokens stored as plaintext JSON** in `antigravity-accounts.json` — no OS keychain.
   Anyone with file access has full account access.
2. **OAuth client ID/secret** sourced from env vars (`OPENCODE_ANTIGRAVITY_CLIENT_ID`,
   `OPENCODE_ANTIGRAVITY_CLIENT_SECRET`); this fork does NOT hardcode them in constants.ts
   (upstream NoeFabris did).
3. **loadCodeAssist.upgradeSubscriptionUri** embeds the percent-encoded email —
   any redaction layer must handle `%40`-encoded emails.
4. **Google ToS warning:** using these internal `v1internal:*` endpoints via a
   third-party plugin violates Google's Terms of Service. Account bans have been
   reported. The README warns about this.
5. **3rd-party Gemini-CLI token proxying** was banned by Google in Feb 2026.
   The plugin's OAuth-based approach (direct auth + request rewrite) is the
   remaining viable path.
6. **No file locking** on `antigravity-accounts.json` (proper-lockfile was dropped
   in this fork). Concurrent writes from multiple OpenCode instances can corrupt
   the file. Consider re-adding file locking or serializing through an async queue.

---

## Appendix: Git Diff Summary (b214863..HEAD, PR #2)

```
 src/plugin/accounts.test.ts | 90 ++++++++++++++++++++++++++++++++++++++++++++-
 src/plugin/accounts.ts      | 81 +++++++++++++++++++++++++++++-----------
 src/plugin/quota.test.ts    | 64 ++++++++++++++++++++++++++++++++
 src/plugin/quota.ts         | 77 +++++++++++++++++++++++++++-----------
 src/plugin/token.ts         |  7 ++++
 5 files changed, 276 insertions(+), 43 deletions(-)
```

**Test results:** 935 passed / 3 failed (pre-existing) / 3 skipped / 25 todo.
**Build:** `tsc -p tsconfig.build.json` — dist/ regenerated.
**Committed:** b214863..HEAD (git log).
