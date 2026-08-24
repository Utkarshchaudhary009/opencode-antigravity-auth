/**
 * RetrieveUserQuotaSummary â€” Cloud Code v1internal:retrieveUserQuotaSummary (WEEKLY LIMITS)
 *
 * PRIMARY deliverable for feat/weekly-limit-fetch. Spec: HANDOFF.md Â§6 + Â§8.
 *
 * Live probe 2026-08-23 (Windows, Bearer ya29.a0Adâ€¦ redacted, account <email-redacted> / <project-id>):
 *
 *   POST https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary
 *   Headers: { Authorization: Bearer ya29.a0Adâ€¦, Content-Type: application/json, User-Agent: antigravity/1.22.2 windows/amd64 }
 *   Body: {}                        â†’ 200 OK  (also succeeds with { "project": "<project-id>" })
 *   Body: { "project": "â€¦" }        â†’ 200 OK (same shape, resetTime skews ~2-3s)
 *   Daily hosts also succeed: daily-cloudcode-pa.googleapis.com + daily-cloudcode-pa.sandbox.googleapis.com â†’ 200
 *   Invalid token â†’ 401 { error: { code: 401, status: "UNAUTHENTICATED", message: "Request had invalid authentication credentials..." } }
 *
 * Field naming is camelCase (remainingFraction, resetTime, bucketId, displayName, window) â€” NOT snake_case.
 * resetTime is RFC3339 UTC (e.g. "2026-08-30T05:47:08Z"), remainingFraction is number in [0,1].
 *
 * REDACTED real observed response (the NEW weekly endpoint â€” design spec validated live):
 * // {
 * //   "groups": [
 * //     {
 * //       "buckets": [
 * //         {
 * //           "bucketId": "gemini-weekly",
 * //           "displayName": "Weekly Limit Remaining",
 * //           "window": "weekly",
 * //           "resetTime": "2026-08-30T05:47:08Z",
 * //           "remainingFraction": 1
 * //         },
 * //         {
 * //           "bucketId": "gemini-5h",
 * //           "displayName": "Five Hour Limit Remaining",
 * //           "window": "5h",
 * //           "resetTime": "2026-08-23T10:47:08Z",
 * //           "remainingFraction": 1
 * //         }
 * //       ],
 * //       "displayName": "Gemini Models",
 * //       "description": "Models within this group: Gemini Flash, Gemini Pro"
 * //     },
 * //     {
 * //       "buckets": [
 * //         {
 * //           "bucketId": "3p-weekly",
 * //           "displayName": "Weekly Limit Remaining",
 * //           "window": "weekly",
 * //           "resetTime": "2026-08-30T05:47:08Z",
 * //           "remainingFraction": 1
 * //         },
 * //         {
 * //           "bucketId": "3p-5h",
 * //           "displayName": "Five Hour Limit Remaining",
 * //           "window": "5h",
 * //           "resetTime": "2026-08-23T10:47:08Z",
 * //           "remainingFraction": 1
 * //         }
 * //       ],
 * //       "displayName": "Claude and GPT models",
 * //       "description": "Models within this group: Claude Opus, Claude Sonnet, GPT-OSS"
 * //     }
 * //   ],
 * //   "description": "Within each group, models share a weekly limit and a 5-hour limit. Quota is consumed proportionally to the cost of the tokens. Thus, limits will last longer with shorter tasks or using more cost-effective models. The 5-hour limit smooths out aggregate demand to fairly distribute global capacity across all users, while your weekly limit is tied directly to your individual tier."
 * // }
 *
 * Comparison to old endpoints:
 * - fetchAvailableModels quotaInfo: per-model, only 5h-style remainingFraction+resetTime, NO weekly.
 * - retrieveUserQuota buckets: per-modelId, tokenType WTUS, only 5h-style, NO weekly.
 * - retrieveUserQuotaSummary: per-GROUP, two windows per group (weekly + 5h), THIS is the only weekly source.
 *
 * Scheduling: weekly resets ~7d (observed 2026-08-23 +7d = 2026-08-30), 5h resets ~5h (same day).
 * Free-tier example: all buckets 1.0 (full). Low-weekly heuristic: weekly < 0.20 â‡’ `low-weekly` tag (HANDOFF Â§8).
 */
import { z } from "zod";
import { RemainingFractionSchema, ResetTimeSchema } from "./common";

// â”€â”€ Raw API shapes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export const WeeklyBucketIdSchema = z.enum(["gemini-weekly", "gemini-5h", "3p-weekly", "3p-5h"]);
export type WeeklyBucketId = z.infer<typeof WeeklyBucketIdSchema>;

export const QuotaWindowSchema = z.enum(["weekly", "5h"]);
export type QuotaWindow = z.infer<typeof QuotaWindowSchema>;

export const WeeklyBucketSchema = z
  .object({
    // Intentionally a plain string, NOT WeeklyBucketIdSchema: the server may
    // introduce new bucket ids, and rejecting them would invalidate an otherwise
    // valid weekly summary. Unknown-bucket policy (fail-open): parse any string;
    // consumers that need strict matching can use WeeklyBucketIdSchema, and
    // inferWindowFromBucketId returns undefined for unrecognized ids.
    bucketId: z.string(),
    displayName: z.string().optional(),
    window: QuotaWindowSchema.optional(), // canonical; fallback inference from bucketId handled in parser
    resetTime: ResetTimeSchema.optional(),
    remainingFraction: RemainingFractionSchema.optional(),
    description: z.string().optional(),
  })
  .passthrough();
export type WeeklyBucket = z.infer<typeof WeeklyBucketSchema>;

export const QuotaGroupEntrySchema = z
  .object({
    displayName: z.string().optional(),
    description: z.string().optional(),
    buckets: z.array(WeeklyBucketSchema),
  })
  .passthrough();
export type QuotaGroupEntry = z.infer<typeof QuotaGroupEntrySchema>;

export const RetrieveUserQuotaSummaryRequestSchema = z
  .object({
    project: z.string().optional(),
  })
  .passthrough();
export type RetrieveUserQuotaSummaryRequest = z.infer<typeof RetrieveUserQuotaSummaryRequestSchema>;

export const RetrieveUserQuotaSummaryResponseSchema = z
  .object({
    // Observed live shape uses groups[]. Spec drafts also showed a fallback
    // top-level buckets[] without groups â€” accept either, but require at least
    // one so a drifted/empty `{}` payload fails validation instead of parsing
    // as "no quota data".
    groups: z.array(QuotaGroupEntrySchema).optional(),
    description: z.string().optional(),
    buckets: z.array(WeeklyBucketSchema).optional(),
  })
  .passthrough()
  .refine((v) => v.groups !== undefined || v.buckets !== undefined, {
    message: "response must contain groups[] or buckets[]",
  });
export type RetrieveUserQuotaSummaryResponse = z.infer<typeof RetrieveUserQuotaSummaryResponseSchema>;

// â”€â”€ Transformed / stored shapes (HANDOFF Â§8) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// These are NOT the raw response â€” they are how the plugin stores the summary
// in AccountStorageV5 (AccountMetadataV5.quotaSummary) after normalizing buckets.

export const QuotaGroupKeySchema = z.enum(["gemini", "3p"]);
export type QuotaGroupKey = z.infer<typeof QuotaGroupKeySchema>;

export const WindowBucketSchema = z.object({
  remainingFraction: RemainingFractionSchema.optional(),
  resetTime: ResetTimeSchema.optional(),
});
export type WindowBucket = z.infer<typeof WindowBucketSchema>;

export const QuotaGroupWindowsSchema = z.object({
  weekly: WindowBucketSchema.optional(),
  fiveHour: WindowBucketSchema.optional(),
});
export type QuotaGroupWindows = z.infer<typeof QuotaGroupWindowsSchema>;

// Raw bucket retained for debugging / future-proofing
export const RawBucketSchema = z.object({
  bucketId: z.string(),
  window: z.string(),
  remainingFraction: RemainingFractionSchema.optional(),
  resetTime: ResetTimeSchema.optional(),
});
export type RawBucket = z.infer<typeof RawBucketSchema>;

export const QuotaWindowSummarySchema = z.object({
  byGroup: z
    .object({
      gemini: QuotaGroupWindowsSchema.optional(),
      "3p": QuotaGroupWindowsSchema.optional(),
    })
    .partial(),
  rawBuckets: z.array(RawBucketSchema),
  fetchedAt: z.number().int().nonnegative(),
});
export type QuotaWindowSummary = z.infer<typeof QuotaWindowSummarySchema>;

// Helper: infer window from bucketId when `window` field is missing (spec fallback)
export function inferWindowFromBucketId(bucketId: string): QuotaWindow | undefined {
  const lower = bucketId.toLowerCase();
  if (lower.includes("weekly")) return "weekly";
  if (lower.includes("5h") || lower.includes("5-hour") || lower.includes("5_hour")) return "5h";
  return undefined;
}

// Helper: map displayName â†’ QuotaGroupKey (HANDOFF Â§8 mapping is coarser than per-model)
// "Gemini Models" â†’ "gemini"  ;  "Claude and GPT models" â†’ "3p"
export function groupDisplayNameToKey(displayName?: string): QuotaGroupKey | undefined {
  if (!displayName) return undefined;
  const lower = displayName.toLowerCase();
  if (lower.includes("gemini")) return "gemini";
  if (lower.includes("claude") || lower.includes("gpt") || lower.includes("3p")) return "3p";
  return undefined;
}
