import {
  ANTIGRAVITY_ENDPOINT_PROD,
  ANTIGRAVITY_PROVIDER_ID,
} from "../constants";
import { accessTokenExpired, formatRefreshParts, parseRefreshParts } from "./auth";
import {
  getActiveAccountManager,
  type AccountManager,
  type ManagedAccount,
} from "./accounts";
import { resolveCachedAuth } from "./cache";
import type { CloudCodeRouteState } from "./cloud-code";
import { logQuotaFetch, logQuotaStatus } from "./debug";
import {
  fetchAvailableModelsCatalog,
  type CatalogModelEntry,
} from "./model-catalog";
import { createLogger } from "./logger";
import { ensureProjectContext } from "./project";
import { initAntigravityRuntimeMetadata } from "./runtime-metadata";
import { AntigravityTokenRefreshError, refreshAccessToken } from "./token";
import { getModelFamily } from "./transform/model-resolver";
import type { PluginClient, OAuthAuthDetails } from "./types";
import type { AccountMetadataV3 } from "./storage";
import {
  emptyQuotaWindowSummary,
  fetchWeeklyLimits,
  type QuotaWindowSummary,
} from "./weekly-limits";

const FETCH_TIMEOUT_MS = 10000;
const log = createLogger("quota");

export type QuotaGroup = "claude" | "gemini-pro" | "gemini-flash";

export interface QuotaGroupSummary {
  /** Remaining fraction clamped to [0, 1], or undefined when unknown (fail-open). */
  remainingFraction: number | undefined;
  resetTime?: string;
  modelCount: number;
}

export interface QuotaSummary {
  groups: Partial<Record<QuotaGroup, QuotaGroupSummary>>;
  modelCount: number;
  error?: string;
}

// Gemini CLI quota types
export interface GeminiCliQuotaModel {
  modelId: string;
  /** Remaining fraction clamped to [0, 1], or undefined when unknown (fail-open). */
  remainingFraction: number | undefined;
  resetTime?: string;
}

export interface GeminiCliQuotaSummary {
  models: GeminiCliQuotaModel[];
  error?: string;
}

interface RetrieveUserQuotaResponse {
  buckets?: {
    remainingAmount?: string;
    remainingFraction?: number;
    resetTime?: string;
    tokenType?: string;
    modelId?: string;
  }[];
}

export type AccountQuotaStatus = "ok" | "disabled" | "error";

export interface AccountQuotaResult {
  index: number;
  email?: string;
  status: AccountQuotaStatus;
  error?: string;
  disabled?: boolean;
  quota?: QuotaSummary;
  geminiCliQuota?: GeminiCliQuotaSummary;
  /** Weekly + 5h window quotas from retrieveUserQuotaSummary (ephemeral, per-check, not persisted). */
  weeklyLimits?: QuotaWindowSummary;
  updatedAccount?: AccountMetadataV3;
}

function buildAuthFromAccount(account: AccountMetadataV3): OAuthAuthDetails {
  return {
    type: "oauth",
    refresh: formatRefreshParts({
      refreshToken: account.refreshToken,
      projectId: account.projectId,
      managedProjectId: account.managedProjectId,
      isGcpTos: account.isGcpTos,
    }),
    access: undefined,
    expires: undefined,
  };
}

/**
 * Known GCP-ToS route state per refresh token, discovered in this process via
 * `ensureProjectContext` (server-reported `usesGcpTos`). Used to pick the
 * refresh OAuth client when the stored `isGcpTos` flag is stale or absent
 * (e.g., accounts added before GCP-ToS flows existed).
 */
const ROUTE_STATE_MAX_ENTRIES = 16;
const routeStateByRefreshToken = new Map<string, CloudCodeRouteState>();

function recordRouteState(refreshToken: string | undefined, routeState: CloudCodeRouteState | undefined): void {
  if (!refreshToken || routeState?.usesGcpTos === undefined) {
    return;
  }
  routeStateByRefreshToken.set(refreshToken, routeState);
  // Rotations keep minting new refresh tokens; cap the map so it cannot grow
  // unbounded across a long-lived process. Evict the oldest entry first (Map
  // iteration is insertion-ordered).
  if (routeStateByRefreshToken.size > ROUTE_STATE_MAX_ENTRIES) {
    const oldest = routeStateByRefreshToken.keys().next().value;
    if (oldest !== undefined) {
      routeStateByRefreshToken.delete(oldest);
    }
  }
}

function getKnownRouteState(...refreshTokens: Array<string | undefined>): CloudCodeRouteState | undefined {
  for (const token of refreshTokens) {
    if (!token) {
      continue;
    }
    const state = routeStateByRefreshToken.get(token);
    if (state) {
      return state;
    }
  }
  return undefined;
}

/**
 * Resolve the effective isGcpTos flag used to pick the OAuth client for refresh.
 *
 * The CURRENT GCP-ToS route state (server-reported `usesGcpTos`, which also
 * drives getCloudCodeEndpointOrder/resolveCloudCodeBaseUrl) wins over the
 * stored account flag: the stored flag can be stale or absent, and refreshing
 * under the wrong client produces invalid_grant. Falls back to the standard
 * client only when no signal exists.
 */
function resolveRefreshIsGcpTos(stored: boolean | undefined, routeState: CloudCodeRouteState | undefined): boolean {
  const current = routeState?.usesGcpTos;
  if (current !== undefined) {
    if (stored !== undefined && stored !== current) {
      log.debug("quota-gcp-tos-flag-stale", { stored, current });
    }
    return current;
  }
  return stored ?? false;
}

/**
 * Resolve the stored isGcpTos signal when an in-memory record and a disk
 * snapshot disagree. A `false` in-memory flag is ambiguous: the packed
 * refresh format cannot distinguish "explicitly false" from "flag never
 * packed", and rotations (before refreshAccessToken carried the flag through
 * its packed output) left zeroed in-memory records whose disk flag still
 * correctly says `true`. Prefer an explicit `true` on disk over a `false`
 * in-memory flag; otherwise the in-memory value wins (it reflects newer
 * state). Server-reported route state still overrides everything, applied
 * downstream in `resolveRefreshIsGcpTos`.
 */
function resolveStoredIsGcpTos(inMemory: boolean | undefined, disk: boolean | undefined): boolean | undefined {
  if (inMemory === false && disk === true) {
    return true;
  }
  return inMemory ?? disk;
}

/**
 * Locate the AccountManager's in-memory record for a quota-check account.
 * The in-memory record can hold a newer (rotated) refresh token than the
 * passed account metadata. Matching priority: refresh token, then email.
 * When the snapshot has no email AND its token no longer matches (Google
 * rotates refresh tokens), the account cannot be identified reliably: the
 * caller's `index` is a position in a possibly-FILTERED account array (the
 * plugin.ts plugin:auth flow passes a single-account subset), NOT the manager's
 * absolute index, so an index fallback can resolve a DIFFERENT account's
 * in-memory token and refresh with the wrong account's credentials. Return null
 * so the caller falls back to the disk-snapshot path instead.
 */
function findInMemoryAccount(
  manager: AccountManager | null,
  account: AccountMetadataV3,
): ManagedAccount | null {
  if (!manager) {
    return null;
  }
  const accounts = manager.getAccounts();
  const byToken = accounts.find((acc) => acc.parts.refreshToken === account.refreshToken);
  if (byToken) {
    return byToken;
  }
  if (account.email) {
    return accounts.find((acc) => acc.email === account.email) ?? null;
  }
  return null;
}

/**
 * Build auth for a quota check from the freshest available token state:
 * the AccountManager's in-memory record (post-rotation) when one matches,
 * otherwise the existing disk-snapshot path. isGcpTos is resolved against
 * current route state so a stale/absent stored flag cannot select the wrong
 * refresh client.
 */
function buildFreshAuth(
  account: AccountMetadataV3,
  inMemoryAccount: ManagedAccount | null,
  routeState: CloudCodeRouteState | undefined,
): OAuthAuthDetails {
  if (inMemoryAccount) {
    return {
      type: "oauth",
      refresh: formatRefreshParts({
        ...inMemoryAccount.parts,
        // Prefer the disk snapshot's explicit `true` over an in-memory `false`
        // that may have been zeroed by a rotation (refreshAccessToken used to
        // drop isGcpTos from its packed output, so `parts.isGcpTos` round-trips
        // to `false`). Server-reported route state, when known, still wins —
        // see resolveRefreshIsGcpTos.
        isGcpTos: resolveRefreshIsGcpTos(
          resolveStoredIsGcpTos(inMemoryAccount.parts.isGcpTos, account.isGcpTos),
          routeState,
        ),
      }),
      access: inMemoryAccount.access,
      expires: inMemoryAccount.expires,
    };
  }
  const auth = buildAuthFromAccount(account);
  const parts = parseRefreshParts(auth.refresh);
  const isGcpTos = resolveRefreshIsGcpTos(parts.isGcpTos, routeState);
  if (parts.isGcpTos === isGcpTos) {
    return auth;
  }
  return {
    ...auth,
    refresh: formatRefreshParts({ ...parts, isGcpTos }),
  };
}

/**
 * Refresh an expired access token for a quota check, retrying ONCE against the
 * freshest in-memory account state when the first attempt throws
 * `AntigravityTokenRefreshError`. That failure usually means our auth was built
 * from a stale snapshot: Google rotates refresh tokens on every refresh, so the
 * proactive refresh queue can have rotated the token (or the route state can
 * have changed the required OAuth client) after we resolved auth from disk.
 * Non-token errors propagate immediately; the outer caller keeps its fail-open
 * behavior.
 *
 * Every successful refresh is propagated back into the AccountManager's
 * in-memory record (mirroring the refresh queue / plugin.ts handleRefreshResult
 * path) so the NEXT quota check resolves the rotated token in memory instead of
 * re-refreshing the already-rotated-away token on disk (which would 400
 * invalid_grant).
 */
async function refreshWithRetry(
  auth: OAuthAuthDetails,
  account: AccountMetadataV3,
  index: number,
  client: PluginClient,
  providerId: string,
): Promise<OAuthAuthDetails> {
  if (!accessTokenExpired(auth)) {
    return auth;
  }

  const manager = getActiveAccountManager();
  const initialInMemoryAccount = findInMemoryAccount(manager, account);

  // Keep the in-memory record in sync with the freshest rotated token. Without
  // this, the next check would match the stale in-memory record (by email) and
  // prefer it over the freshly persisted disk token, re-refreshing a token that
  // Google already rotated away -> invalid_grant again.
  const propagateToMemory = (inMemoryAccount: ManagedAccount | null, refreshed: OAuthAuthDetails): void => {
    if (manager && inMemoryAccount) {
      manager.updateFromAuth(inMemoryAccount, refreshed);
    }
  };

  try {
    const refreshed = await refreshAccessToken(auth, client, providerId);
    if (!refreshed) {
      log.error("quota-refresh-returned-empty", {
        index,
        email: account.email,
        hasCachedQuota: !!account.cachedQuota,
        hasProjectId: !!account.projectId,
        hasManagedProjectId: !!account.managedProjectId,
      });
      throw new Error("Access token refresh did not return a usable token. Check antigravity token logs for the exact failure.");
    }
    propagateToMemory(initialInMemoryAccount, refreshed);
    return refreshed;
  } catch (error) {
    if (!(error instanceof AntigravityTokenRefreshError)) {
      throw error;
    }

    log.debug("quota-refresh-retry-in-memory", {
      index,
      email: account.email,
      code: error.code,
    });

    // Re-resolve against the CURRENT in-memory state: the background refresh
    // queue may have completed a rotation since we first built auth, and the
    // server-reported route state may now be known (client-id selection).
    const inMemoryAccount = findInMemoryAccount(manager, account);
    const routeState = getKnownRouteState(
      account.refreshToken,
      inMemoryAccount?.parts.refreshToken,
    );
    const retryAuth = resolveCachedAuth(buildFreshAuth(account, inMemoryAccount, routeState));

    if (!accessTokenExpired(retryAuth)) {
      // The in-memory rotation already produced a fresh access token.
      return retryAuth;
    }

    try {
      const retried = await refreshAccessToken(retryAuth, client, providerId);
      if (!retried) {
        // The retry attempt itself produced no usable token. Surface THAT
        // failure (with the first attempt's code as context) instead of
        // re-raising the original stale-token error, which would misattribute
        // the failure to the pre-rotation state.
        const firstCode = error.code;
        throw new Error(
          `Access token refresh retry did not return a usable token` +
          (firstCode ? ` (first attempt failed with ${firstCode})` : "") +
          `. Check antigravity token logs for the exact failure.`,
        );
      }
      propagateToMemory(inMemoryAccount, retried);
      return retried;
    } catch (retryError) {
      if (retryError instanceof AntigravityTokenRefreshError) {
        log.debug("quota-refresh-retry-failed", {
          index,
          email: account.email,
          code: retryError.code,
        });
      }
      throw retryError;
    }
  }
}

function normalizeRemainingFraction(value: unknown): number | undefined {
  // Fail-open: missing or invalid input is UNKNOWN (undefined), NOT 0%.
  // Downstream treats undefined as "usable/unknown" rather than instantly
  // exhausting an account on a data glitch. Valid numbers clamp to [0, 1].
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.min(1, Math.max(0, value));
}

function parseResetTime(resetTime?: string): number | null {
  if (!resetTime) return null;
  const timestamp = Date.parse(resetTime);
  if (!Number.isFinite(timestamp)) {
    return null;
  }
  return timestamp;
}

function classifyQuotaGroup(modelName: string, displayName?: string): QuotaGroup | null {
  const combined = `${modelName} ${displayName ?? ""}`.toLowerCase();
  if (combined.includes("claude")) {
    return "claude";
  }
  const isGemini3 = combined.includes("gemini-3") || combined.includes("gemini 3");
  if (!isGemini3) {
    return null;
  }
  const family = getModelFamily(modelName);
  return family === "gemini-flash" ? "gemini-flash" : "gemini-pro";
}

function aggregateQuota(models?: Record<string, CatalogModelEntry>): QuotaSummary {
  const groups: Partial<Record<QuotaGroup, QuotaGroupSummary>> = {};
  if (!models) {
    return { groups, modelCount: 0 };
  }

  let totalCount = 0;
  for (const [modelName, entry] of Object.entries(models)) {
    const group = classifyQuotaGroup(modelName, entry.displayName);
    if (!group) {
      continue;
    }
    const quotaInfo = entry.quotaInfo;
    const remainingFraction = quotaInfo
      ? normalizeRemainingFraction(quotaInfo.remainingFraction)
      : undefined;
    const resetTime = quotaInfo?.resetTime;
    const resetTimestamp = parseResetTime(resetTime);

    totalCount += 1;

    const existing = groups[group];
    const nextCount = (existing?.modelCount ?? 0) + 1;
    const nextRemaining =
      remainingFraction === undefined
        ? existing?.remainingFraction
        : existing?.remainingFraction === undefined
          ? remainingFraction
          : Math.min(existing.remainingFraction, remainingFraction);

    let nextResetTime = existing?.resetTime;
    if (resetTimestamp !== null) {
      if (!existing?.resetTime) {
        nextResetTime = resetTime;
      } else {
        const existingTimestamp = parseResetTime(existing.resetTime);
        if (existingTimestamp === null || resetTimestamp < existingTimestamp) {
          nextResetTime = resetTime;
        }
      }
    }

    groups[group] = {
      remainingFraction: nextRemaining,
      resetTime: nextResetTime,
      modelCount: nextCount,
    };
  }

  return { groups, modelCount: totalCount };
}

async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchGeminiCliQuota(
  accessToken: string,
  projectId: string,
): Promise<RetrieveUserQuotaResponse> {
  const endpoint = ANTIGRAVITY_ENDPOINT_PROD;
  // Use Gemini CLI user-agent to get CLI quota buckets (not Antigravity buckets)
  const platform = process.platform || "darwin";
  const arch = process.arch || "arm64";
  const geminiCliUserAgent = `GeminiCLI/1.0.0/gemini-2.5-pro (${platform}; ${arch})`;

  const body = projectId ? { project: projectId } : {};
  
  try {
    const response = await fetchWithTimeout(`${endpoint}/v1internal:retrieveUserQuota`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "User-Agent": geminiCliUserAgent,
      },
      body: JSON.stringify(body),
    });

    if (response.ok) {
      const data = (await response.json()) as RetrieveUserQuotaResponse;
      return data;
    }

    // Non-OK response - return empty buckets
    return { buckets: [] };
  } catch {
    // Network error or timeout - return empty buckets
    return { buckets: [] };
  }
}

function aggregateGeminiCliQuota(response: RetrieveUserQuotaResponse): GeminiCliQuotaSummary {
  const models: GeminiCliQuotaModel[] = [];
  
  if (!response.buckets || response.buckets.length === 0) {
    return { models };
  }

  for (const bucket of response.buckets) {
    if (!bucket.modelId) {
      continue;
    }
    
    // Filter out models we don't care about for Gemini CLI quotas
    // Only show gemini-3-* and gemini-2.5-pro models (the premium ones)
    const modelId = bucket.modelId;
    const isRelevantModel = 
      modelId.startsWith("gemini-3-") || 
      modelId === "gemini-2.5-pro";
    
    if (!isRelevantModel) {
      continue;
    }
    
    models.push({
      modelId: bucket.modelId,
      remainingFraction: normalizeRemainingFraction(bucket.remainingFraction),
      resetTime: bucket.resetTime,
    });
  }

  // Sort by model ID for consistent display
  models.sort((a, b) => a.modelId.localeCompare(b.modelId));

  return { models };
}

function applyAccountUpdates(
  account: AccountMetadataV3,
  auth: OAuthAuthDetails,
  routeState: CloudCodeRouteState | undefined,
): AccountMetadataV3 | undefined {
  const parts = parseRefreshParts(auth.refresh);
  if (!parts.refreshToken) {
    return undefined;
  }

  // isGcpTos preservation: never persist `false` when the real value is
  // unknown. The managedProjectId fast path in ensureProjectContext reports no
  // route state (usesGcpTos: undefined), and an absent packed flag parses back
  // as `false`, so a naive `??` chain would clobber a stored `true` on disk
  // (and later pick the wrong refresh client). Trusted signals, in order:
  // server-reported route state (authoritative), an explicitly packed `true`,
  // then the stored flag (kept untouched). With no signal at all, leave the
  // flag undefined rather than persisting a guessed `false`.
  let isGcpTos: boolean | undefined;
  const routeFlag = routeState?.usesGcpTos;
  if (routeFlag !== undefined) {
    isGcpTos = routeFlag;
  } else if (parts.isGcpTos === true) {
    isGcpTos = true;
  } else if (account.isGcpTos !== undefined) {
    isGcpTos = account.isGcpTos;
  }

  const updated: AccountMetadataV3 = {
    ...account,
    refreshToken: parts.refreshToken,
    projectId: parts.projectId ?? account.projectId,
    managedProjectId: parts.managedProjectId ?? account.managedProjectId,
    isGcpTos,
  };

  // Include isGcpTos in the comparison so a merely re-resolved/preserved flag
  // does not mark the record as changed and trigger a spurious disk write.
  const changed =
    updated.refreshToken !== account.refreshToken ||
    updated.projectId !== account.projectId ||
    updated.managedProjectId !== account.managedProjectId ||
    updated.isGcpTos !== account.isGcpTos;

  return changed ? updated : undefined;
}

function quotaSummaryFromCachedQuota(account: AccountMetadataV3): QuotaSummary | undefined {
  const groups = account.cachedQuota;
  if (!groups || Object.keys(groups).length === 0) {
    return undefined;
  }

  let modelCount = 0;
  for (const group of Object.values(groups)) {
    modelCount += group?.modelCount ?? 0;
  }

  return {
    groups,
    modelCount,
    error: "Showing cached quota data.",
  };
}

export async function checkAccountsQuota(
  accounts: AccountMetadataV3[],
  client: PluginClient,
  providerId = ANTIGRAVITY_PROVIDER_ID,
): Promise<AccountQuotaResult[]> {
  const results: AccountQuotaResult[] = [];
  
  logQuotaFetch("start", accounts.length);
  await initAntigravityRuntimeMetadata();

  for (const [index, account] of accounts.entries()) {
    const disabled = account.enabled === false;
    const cachedQuota = quotaSummaryFromCachedQuota(account);
    log.debug("quota-check-account", {
      index,
      email: account.email,
      disabled,
      hasCachedQuota: !!cachedQuota,
      hasProjectId: !!account.projectId,
      hasManagedProjectId: !!account.managedProjectId,
      verificationRequired: !!account.verificationRequired,
      refreshTokenLength: account.refreshToken.length,
    });
    if (disabled) {
      results.push({
        index,
        email: account.email,
        status: "disabled",
        disabled: true,
        quota: cachedQuota,
      });
      continue;
    }

    // Auth resolution priority: (1) freshest in-memory token from the
    // AccountManager (the proactive refresh queue updates these in place after
    // rotation, so they can hold a newer refresh token than the disk snapshot);
    // (2) fall back to the existing disk-snapshot path only when no in-memory
    // record matches. isGcpTos is resolved against any route state already
    // discovered in this process so a stale/absent stored flag cannot select
    // the wrong refresh OAuth client.
    const inMemoryAccount = findInMemoryAccount(getActiveAccountManager(), account);
    const knownRouteState = getKnownRouteState(
      account.refreshToken,
      inMemoryAccount?.parts.refreshToken,
    );
    let auth = resolveCachedAuth(buildFreshAuth(account, inMemoryAccount, knownRouteState));

    try {
      log.debug("quota-auth-state", {
        index,
        email: account.email,
        fromInMemory: !!inMemoryAccount,
        hasAccess: !!auth.access,
        expires: auth.expires,
        accessExpired: accessTokenExpired(auth),
        isGcpTos: parseRefreshParts(auth.refresh).isGcpTos,
        usesGcpTos: knownRouteState?.usesGcpTos,
      });
      auth = await refreshWithRetry(auth, account, index, client, providerId);

      const projectContext = await ensureProjectContext(auth);
      auth = projectContext.auth;
      // Record the server-reported route state (keyed by both the stored token
      // and the current post-rotation token) so later accounts and retries can
      // derive isGcpTos from current state instead of a stale/absent flag.
      recordRouteState(account.refreshToken, projectContext.routeState);
      recordRouteState(parseRefreshParts(auth.refresh).refreshToken, projectContext.routeState);
      const updatedAccount = applyAccountUpdates(account, auth, projectContext.routeState);
      log.debug("quota-project-context", {
        index,
        email: account.email,
        effectiveProjectId: projectContext.effectiveProjectId,
        usesGcpTos: projectContext.routeState?.usesGcpTos,
        rotatedAuth: !!updatedAccount,
      });

      let quotaResult: QuotaSummary;
      let geminiCliQuotaResult: GeminiCliQuotaSummary;
      let weeklyLimits: QuotaWindowSummary;

      // Fetch Antigravity, Gemini CLI, and Weekly (retrieveUserQuotaSummary) quotas in parallel.
      // Weekly limits are ephemeral per-check (not persisted) — avoids V4→V5 migration churn;
      // see docs/HANDOFF.md §6 and src/plugin/weekly-limits.ts for caching rationale.
      const [antigravityResponse, geminiCliResponse, weeklyLimitsResult] = await Promise.all([
        fetchAvailableModelsCatalog(
          auth.access ?? "",
          projectContext.effectiveProjectId,
          projectContext.routeState,
        ).catch(() => ({ models: undefined })),
        fetchGeminiCliQuota(auth.access ?? "", projectContext.effectiveProjectId).catch(() => ({ buckets: [] })),
        fetchWeeklyLimits(auth, projectContext.effectiveProjectId, projectContext.routeState).catch((error) => {
          if (error instanceof AntigravityTokenRefreshError) throw error;
          log.debug("weekly-limits-fetch-failed-fail-open", {
            index,
            email: account.email,
            error: String(error),
          });
          return emptyQuotaWindowSummary();
        }),
      ]);
      weeklyLimits = weeklyLimitsResult;

      // Process Antigravity quota
      if (antigravityResponse.models === undefined) {
        quotaResult = {
          groups: {},
          modelCount: 0,
          error: "Failed to fetch Antigravity quota",
        };
      } else {
        quotaResult = aggregateQuota(antigravityResponse.models);
      }

      // Process Gemini CLI quota
      geminiCliQuotaResult = aggregateGeminiCliQuota(geminiCliResponse);
      if (geminiCliResponse.buckets === undefined || geminiCliResponse.buckets.length === 0) {
        geminiCliQuotaResult.error = geminiCliQuotaResult.models.length === 0 
          ? "No Gemini CLI quota available" 
          : undefined;
      }

      results.push({
        index,
        email: account.email,
        status: "ok",
        disabled,
        quota: quotaResult,
        geminiCliQuota: geminiCliQuotaResult,
        weeklyLimits,
        updatedAccount,
      });

      log.debug("quota-weekly-limits", {
        index,
        email: account.email,
        weeklyLimitsGroups: Object.keys(weeklyLimits.byGroup).join(",") || "none",
        rawBuckets: weeklyLimits.rawBuckets.length,
      });
      
      // Log quota status for each family (undefined fraction => unknown, not exhausted)
      for (const [family, groupQuota] of Object.entries(quotaResult.groups)) {
        const remainingPercent =
          groupQuota.remainingFraction === undefined
            ? undefined
            : groupQuota.remainingFraction * 100;
        logQuotaStatus(account.email, index, remainingPercent, family);
      }
    } catch (error) {
      results.push({
        index,
        email: account.email,
        status: "error",
        disabled,
        quota: cachedQuota,
        error: error instanceof Error ? error.message : String(error),
      });
      log.error("quota-check-error", {
        index,
        email: account.email,
        error: error instanceof Error ? error.stack ?? error.message : String(error),
        hasCachedQuota: !!cachedQuota,
      });
      logQuotaFetch("error", undefined, `account=${account.email ?? index} error=${error instanceof Error ? error.message : String(error)}`);
    }
  }

  logQuotaFetch("complete", accounts.length, `ok=${results.filter(r => r.status === "ok").length} errors=${results.filter(r => r.status === "error").length}`);
  return results;
}

// Test-only exports to allow direct unit testing of quota normalization logic.
export const __testExports = {
  normalizeRemainingFraction,
  aggregateGeminiCliQuota,
  clearRouteState: () => routeStateByRefreshToken.clear(),
};
