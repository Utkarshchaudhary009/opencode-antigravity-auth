/**
 * Shared primitives for Antigravity / Cloud Code endpoint schemas.
 * Live probe: 2026-08-23 (Windows, prod + daily hosts, Bearer antigravity/1.22.2)
 * Auth via google-auth-library (oauth2.googleapis.com/token) + cloudcode-pa.googleapis.com v1internal:*
 */
import { z } from "zod";

// Fraction in [0,1] — 1 = 100% remaining, 0 = exhausted. Undefined => unknown (fail-open).
// Fail-open policy (mirrors src/plugin/quota.ts): valid numbers clamp to [0, 1];
// invalid values (missing, NaN, non-number) become undefined instead of rejecting
// the whole response or reporting a false 0%.
export const RemainingFractionSchema: z.ZodType<number | undefined> = z
  .unknown()
  .transform((v) =>
    typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : undefined,
  );
export type RemainingFraction = number | undefined;

export const RemainingFractionOptionalSchema = RemainingFractionSchema.optional();
export type RemainingFractionOptional = z.infer<typeof RemainingFractionOptionalSchema>;

// ISO-8601 UTC datetime as returned by Cloud Code (e.g. "2026-08-23T10:47:08Z").
// Servers use RFC3339 without millis; we accept any string that Date.parse can handle.
export const ResetTimeSchema = z
  .string()
  .refine((v) => Number.isFinite(Date.parse(v)), { message: "Invalid ISO 8601 datetime" });
export type ResetTime = z.infer<typeof ResetTimeSchema>;

export const ResetTimeOptionalSchema = ResetTimeSchema.optional();
export type ResetTimeOptional = z.infer<typeof ResetTimeOptionalSchema>;

// Bucket/window identifiers observed live (camelCase).
// Weekly buckets ONLY appear in retrieveUserQuotaSummary, not in fetchAvailableModels / retrieveUserQuota.
export const BucketIdSchema = z.enum(["gemini-weekly", "gemini-5h", "3p-weekly", "3p-5h"]);
export type BucketId = z.infer<typeof BucketIdSchema>;

// Window enum — canonical field is `window` (spec) / `bucket.window`; fallback is inferred from bucketId.
export const WindowSchema = z.enum(["weekly", "5h"]);
export type Window = z.infer<typeof WindowSchema>;

// Quota group enum (logical grouping used by retrieveUserQuotaSummary)
export const QuotaGroupSchema = z.enum(["gemini", "3p"]);
export type QuotaGroup = z.infer<typeof QuotaGroupSchema>;

// Header conventions observed via src/constants.ts:getRandomizedHeaders / HANDOFF §4
// Antigravity UA: `antigravity/<version> <platform>/<arch>`  (e.g. antigravity/1.22.2 windows/amd64)
// GeminiCLI UA (for retrieveUserQuota CLI-quotas): `GeminiCLI/1.0.0/gemini-2.5-pro (<platform>; <arch>)`
export const AntigravityUserAgentSchema = z.string().regex(/^antigravity\/.+ .+\/.+$/);
export type AntigravityUserAgent = z.infer<typeof AntigravityUserAgentSchema>;

export const HeaderStyleSchema = z.enum(["antigravity", "gemini-cli"]);
export type HeaderStyle = z.infer<typeof HeaderStyleSchema>;

export const AntigravityHeadersSchema = z.object({
  Authorization: z.string().regex(/^Bearer ya29\./),
  "Content-Type": z.literal("application/json"),
  "User-Agent": z.string(),
  "X-Goog-Api-Client": z.string().optional(),
  "Client-Metadata": z.string().optional(),
});
export type AntigravityHeaders = z.infer<typeof AntigravityHeadersSchema>;

// Cloud Code host enum (fallback order is prod → daily → daily-sandbox → autopush)
export const CloudCodeHostSchema = z.enum([
  "https://cloudcode-pa.googleapis.com",
  "https://daily-cloudcode-pa.googleapis.com",
  "https://daily-cloudcode-pa.sandbox.googleapis.com",
  "https://autopush-cloudcode-pa.sandbox.googleapis.com",
]);
export type CloudCodeHost = z.infer<typeof CloudCodeHostSchema>;

// Canonical fail-open quota helpers. src/plugin/quota.ts imports these instead of
// redefining them, so behavioral fixes propagate to both the schema and runtime paths.

/** Clamp a raw remainingFraction to [0, 1]; invalid input → undefined (unknown, fail-open). */
export function normalizeRemainingFraction(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(1, Math.max(0, value));
}

/** Parse an ISO-8601 resetTime into an epoch ms timestamp; missing/invalid → null. */
export function parseResetTime(resetTime?: string): number | null {
  if (!resetTime) return null;
  const ts = Date.parse(resetTime);
  return Number.isFinite(ts) ? ts : null;
}
