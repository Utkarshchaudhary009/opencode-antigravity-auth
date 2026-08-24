/**
 * Weekly Limits fetcher — Cloud Code v1internal:retrieveUserQuotaSummary
 *
 * Endpoint: POST https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary
 * Body: {} or {"project": projectId}
 * Headers: Authorization Bearer + User-Agent antigravity/1.22.2 windows/amd64
 *
 * Response groups → byGroup aggregation uses helpers from schema/weekly-limits.ts.
 * Fail-open on non-ok/network → empty summary; auth errors (401/403) throw AntigravityTokenRefreshError.
 *
 * Caching choice: ephemeral per-check (returned as AccountQuotaResult.weeklyLimits, not persisted).
 * This avoids storage migration (V4→V5) churn and keeps quota fresh per verification; a future
 * persistent cache (AccountMetadataV3.cachedWeeklyLimits) can be added without breaking callers.
 */
import { getAntigravityHeaders, getRandomizedHeaders } from "../constants.ts";
import { getCloudCodeEndpointOrder, type CloudCodeRouteState } from "./cloud-code.ts";
import { createLogger } from "./logger.ts";
import { AntigravityTokenRefreshError } from "./token.ts";
import type { OAuthAuthDetails } from "./types.ts";
import { z } from "zod";
import {
  RetrieveUserQuotaSummaryResponseSchema,
  groupDisplayNameToKey,
  inferWindowFromBucketId,
  type QuotaWindowSummary,
  type QuotaGroupKey,
  type RawBucket,
  type WindowBucket,
} from "../../schema/weekly-limits.ts";
import {
  normalizeRemainingFraction,
  parseResetTime,
} from "../../schema/common.ts";

// Lenient schema for parsing — allows out-of-range fractions and invalid resetTimes
// so that normalization (clamping / fail-open) can handle them instead of failing zod.
// This avoids strict RemainingFractionSchema (0-1) and ResetTimeSchema rejecting buckets.
// bucketId is unknown here: normalization skips only the unusable bucket instead of
// the lenient parse rejecting the whole response over a single malformed bucket.
const LenientWeeklyBucketSchema = z
  .object({
    bucketId: z.unknown().optional(),
    displayName: z.string().optional(),
    window: z.string().optional(),
    resetTime: z.string().optional(),
    remainingFraction: z.unknown().optional(),
    description: z.string().optional(),
  })
  .passthrough();

const LenientGroupSchema = z
  .object({
    displayName: z.string().optional(),
    description: z.string().optional(),
    buckets: z.array(LenientWeeklyBucketSchema),
  })
  .passthrough();

const LenientResponseSchema = z
  .object({
    groups: z.array(LenientGroupSchema).optional(),
    description: z.string().optional(),
    buckets: z.array(LenientWeeklyBucketSchema).optional(),
  })
  .passthrough();

const FETCH_TIMEOUT_MS = 10_000;
const log = createLogger("weekly-limits");

export type { QuotaWindowSummary, RawBucket, WindowBucket, QuotaGroupKey };

/**
 * Ephemeral empty summary — used for fail-open and as initial value.
 * fetchedAt is Date.now() at call time.
 */
export function emptyQuotaWindowSummary(): QuotaWindowSummary {
  return {
    byGroup: {},
    rawBuckets: [],
    fetchedAt: Date.now(),
  };
}

function getAccessToken(auth: OAuthAuthDetails | string): string {
  if (typeof auth === "string") return auth.trim();
  if (auth && typeof auth === "object" && "access" in auth) {
    const token = (auth as OAuthAuthDetails).access;
    return typeof token === "string" ? token.trim() : "";
  }
  return "";
}

/**
 * Abort signal that stays active until the caller finishes reading the body —
 * a server can send headers then stall, so the timeout must cover response
 * consumption too. Call `done()` once the body has been read (or skipped).
 */
async function openRequest(url: string, init: RequestInit): Promise<{ response: Response; done: () => void }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    return { response, done: () => clearTimeout(timeout) };
  } catch (error) {
    clearTimeout(timeout);
    throw error;
  }
}

function buildHeaders(accessToken: string): Record<string, string> {
  // Use randomized headers (antigravity UA) + Bearer + JSON
  // getRandomizedHeaders("antigravity") yields { "User-Agent": "antigravity/1.22.2 windows/amd64" }
  const randomized = getRandomizedHeaders("antigravity");
  const fallback = getAntigravityHeaders();
  return {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "User-Agent": randomized["User-Agent"] ?? fallback["User-Agent"],
    ...(randomized["X-Goog-Api-Client"] ? { "X-Goog-Api-Client": randomized["X-Goog-Api-Client"] } : {}),
    ...(randomized["Client-Metadata"] ? { "Client-Metadata": randomized["Client-Metadata"] } : {}),
  };
}

function normalizeResponse(
  data: z.infer<typeof LenientResponseSchema>,
): QuotaWindowSummary {
  const byGroup: QuotaWindowSummary["byGroup"] = {};
  const rawBuckets: RawBucket[] = [];
  const groups = data.groups ?? [];

  const processBuckets = (
    buckets: typeof groups extends (infer U)[] ? U extends { buckets: infer B } ? B : never : never,
    displayName?: string,
  ) => {
    const groupKey = groupDisplayNameToKey(displayName);
    for (const bucket of buckets as Array<{
      bucketId: string;
      window?: string;
      remainingFraction?: number;
      resetTime?: string;
    }>) {
      const bucketId = typeof bucket.bucketId === "string" ? bucket.bucketId : "";
      if (!bucketId) continue;

      const rawWindow = typeof bucket.window === "string" ? bucket.window : undefined;
      const inferredWindow = rawWindow ?? inferWindowFromBucketId(bucketId);
      const normalizedFraction = normalizeRemainingFraction(bucket.remainingFraction);
      let normalizedResetTime: string | undefined;
      if (typeof bucket.resetTime === "string") {
        const ts = parseResetTime(bucket.resetTime);
        if (ts !== null) normalizedResetTime = bucket.resetTime;
        // invalid resetTime → undefined (fail-open)
      }

      // Raw bucket: always record, window is inferred or raw or "" (fail-open keeps raw for debug)
      const raw: RawBucket = {
        bucketId,
        window: inferredWindow ?? rawWindow ?? "",
        remainingFraction: normalizedFraction,
        resetTime: normalizedResetTime,
      };
      rawBuckets.push(raw);

      // Aggregation into byGroup — need both group and window
      let targetGroup: QuotaGroupKey | undefined = groupKey;
      if (!targetGroup) {
        const lower = bucketId.toLowerCase();
        if (lower.includes("gemini")) targetGroup = "gemini";
        else if (lower.includes("3p") || lower.includes("claude") || lower.includes("gpt")) targetGroup = "3p";
      }
      if (!targetGroup) {
        log.debug("weekly-limits-unknown-group", { bucketId, displayName });
        continue;
      }
      if (inferredWindow !== "weekly" && inferredWindow !== "5h") {
        log.debug("weekly-limits-unknown-window", { bucketId, window: rawWindow });
        continue;
      }

      const windows = byGroup[targetGroup] ?? {};
      const wb: WindowBucket = {};
      if (normalizedFraction !== undefined) wb.remainingFraction = normalizedFraction;
      if (normalizedResetTime !== undefined) wb.resetTime = normalizedResetTime;

      if (inferredWindow === "weekly") {
        windows.weekly = wb;
      } else if (inferredWindow === "5h") {
        windows.fiveHour = wb;
      }
      byGroup[targetGroup] = windows;
    }
  };

  if (groups.length > 0) {
    for (const group of groups) {
      processBuckets(group.buckets as unknown as [], group.displayName);
    }
  }

  // Fallback shape: top-level buckets[] without groups (spec draft)
  if (rawBuckets.length === 0 && data.buckets && data.buckets.length > 0) {
    processBuckets(data.buckets as unknown as [], undefined);
  }

  return {
    byGroup,
    rawBuckets,
    fetchedAt: Date.now(),
  };
}

/**
 * Fetch weekly + 5h window quotas via retrieveUserQuotaSummary.
 *
 * @param auth - OAuth auth containing Bearer access token (or raw token string)
 * @param projectId - optional project id to include in body; omit for {}
 * @param routeState - optional Cloud Code route state for host fallback order
 */
export async function fetchWeeklyLimits(
  auth: OAuthAuthDetails | string,
  projectId?: string,
  routeState?: CloudCodeRouteState,
): Promise<QuotaWindowSummary> {
  const accessToken = getAccessToken(auth);
  if (!accessToken) {
    throw new AntigravityTokenRefreshError({
      message: "Missing access token for weekly limits fetch",
      status: 401,
      statusText: "Missing token",
    });
  }

  const body = projectId?.trim() ? { project: projectId.trim() } : {};
  const headers = buildHeaders(accessToken);
  const endpoints = getCloudCodeEndpointOrder(routeState);

  for (const endpoint of endpoints) {
    const url = `${endpoint}/v1internal:retrieveUserQuotaSummary`;
    let done: (() => void) | undefined;
    try {
      const opened = await openRequest(
        url,
        {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        },
      );
      done = opened.done;
      const response = opened.response;

      if (response.status === 401 || response.status === 403) {
        const text = await response.text().catch(() => "");
        const snippet = text.trim().slice(0, 200);
        throw new AntigravityTokenRefreshError({
          message: `retrieveUserQuotaSummary auth failed (${response.status} ${response.statusText})${snippet ? `: ${snippet}` : ""}`,
          status: response.status,
          statusText: response.statusText,
        });
      }

      if (!response.ok) {
        log.debug("weekly-limits-non-ok", { endpoint, status: response.status });
        continue; // try next host, fail-open if all fail
      }

      let json: unknown;
      try {
        json = await response.json();
      } catch {
        log.debug("weekly-limits-json-parse-failed", { endpoint });
        continue;
      }

      // First try strict schema for telemetry; fall back to lenient for actual normalization
      // so that out-of-range fractions / invalid resetTimes are clamped/fail-open per bucket
      // rather than failing the entire response (required for clamping tests).
      const strictParsed = RetrieveUserQuotaSummaryResponseSchema.safeParse(json);
      if (!strictParsed.success) {
        log.debug("weekly-limits-zod-strict-parse-failed", {
          endpoint,
          error: strictParsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        });
      }
      const lenientParsed = LenientResponseSchema.safeParse(json);
      if (!lenientParsed.success) {
        log.debug("weekly-limits-zod-parse-failed", {
          endpoint,
          error: lenientParsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        });
        continue; // try next host; fail-open only after the loop is exhausted
      }

      const summary = normalizeResponse(lenientParsed.data);
      log.debug("weekly-limits-fetched", {
        endpoint,
        groups: Object.keys(summary.byGroup).join(",") || "none",
        rawCount: summary.rawBuckets.length,
      });
      return summary;
    } catch (error) {
      if (error instanceof AntigravityTokenRefreshError) {
        throw error;
      }
      const err = error as Error & { name?: string };
      if (err?.name === "AbortError") {
        log.debug("weekly-limits-timeout", { endpoint });
        continue;
      }
      // Network or other — try next endpoint, fail-open if exhausted
      log.debug("weekly-limits-network-error", { endpoint, error: String(error) });
      continue;
    } finally {
      // Timer stays live through body reads above; stop it once this attempt ends.
      done?.();
    }
  }

  // All endpoints failed or non-ok → fail-open empty
  log.debug("weekly-limits-all-hosts-failed", { endpoints: endpoints.join(",") });
  return emptyQuotaWindowSummary();
}
