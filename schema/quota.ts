/**
 * RetrieveUserQuota — Cloud Code v1internal:retrieveUserQuota
 *
 * Live probe 2026-08-23 (Bearer ya29.a0Ad…, UA antigravity/1.22.2 windows/amd64,
 * effectiveProjectId fit-map-8hv63, prod host):
 *
 *   POST https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota
 *   Headers: { Authorization: Bearer ya29.a0Ad…, Content-Type: application/json, User-Agent: antigravity/1.22.2 windows/amd64 }
 *   Body: { "project": "fit-map-8hv63" }   — also succeeds with {}
 *   Status: 200 OK
 *
 * REDACTED observed response (25 buckets, 5 shown + "... +20 more"):
 * // {
 * //   "buckets": [
 * //     { "tokenType": "WTUS…[redacted]", "modelId": "chat_20706", "remainingFraction": 1 },
 * //     { "tokenType": "WTUS…[redacted]", "modelId": "chat_23310", "remainingFraction": 1 },
 * //     { "resetTime": "2026-08-23T10:46:49Z", "tokenType": "WTUS…[redacted]", "modelId": "claude-opus-4-6-thinking", "remainingFraction": 1 },
 * //     { "resetTime": "2026-08-23T10:46:49Z", "tokenType": "WTUS…[redacted]", "modelId": "claude-sonnet-4-6", "remainingFraction": 1 },
 * //     { "resetTime": "2026-08-23T10:46:49Z", "tokenType": "WTUS…[redacted]", "modelId": "gemini-2.5-flash", "remainingFraction": 1 }
 * //     // ... +20 more (gemini-3-*, gpt-oss-120b-medium, etc.)
 * //   ]
 * // }
 * // Notes:
 * // - Field names are camelCase: remainingFraction (0-1), resetTime (ISO 8601 UTC), tokenType (always "WTUS"), modelId
 * // - Tab/preview IDs (chat_20706, chat_23310, tab_*) have NO resetTime
 * // - No weekly buckets here — only 5h-style per-model quota (weekly lives in retrieveUserQuotaSummary)
 * // - Also observed with GeminiCLI UA: same 200 but filtered to gemini-3-* + gemini-2.5-pro by src/plugin/quota.ts:aggregateGeminiCliQuota
 *
 * Fail-open: src/plugin/quota.ts:normalizeRemainingFraction returns undefined for missing/NaN/negative; resetTime parsed via Date.parse.
 */
import { z } from "zod";
import { RemainingFractionSchema, ResetTimeSchema } from "./common.ts";

export const RetrieveUserQuotaRequestSchema = z
  .object({
    project: z.string().optional(),
  })
  .passthrough();
export type RetrieveUserQuotaRequest = z.infer<typeof RetrieveUserQuotaRequestSchema>;

export const QuotaBucketSchema = z
  .object({
    tokenType: z.string().optional(), // observed "WTUS"
    modelId: z.string().optional(),
    remainingFraction: RemainingFractionSchema.optional(),
    remainingAmount: z.string().optional(), // alternative string form, rarely present
    resetTime: ResetTimeSchema.optional(),
  })
  .passthrough();
export type QuotaBucket = z.infer<typeof QuotaBucketSchema>;

export const RetrieveUserQuotaResponseSchema = z
  .object({
    buckets: z.array(QuotaBucketSchema).optional(),
  })
  .passthrough();
export type RetrieveUserQuotaResponse = z.infer<typeof RetrieveUserQuotaResponseSchema>;

// Processed shape after src/plugin/quota.ts:aggregateGeminiCliQuota (filtered + sorted)
export const GeminiCliQuotaModelSchema = z.object({
  modelId: z.string(),
  remainingFraction: RemainingFractionSchema.optional(),
  resetTime: ResetTimeSchema.optional(),
});
export type GeminiCliQuotaModel = z.infer<typeof GeminiCliQuotaModelSchema>;

export const GeminiCliQuotaSummarySchema = z.object({
  models: z.array(GeminiCliQuotaModelSchema),
  error: z.string().optional(),
});
export type GeminiCliQuotaSummary = z.infer<typeof GeminiCliQuotaSummarySchema>;

// Soft-quota aggregation shape from fetchAvailableModels (see models.ts) — kept here for completeness
export const QuotaGroupSchema = z.enum(["claude", "gemini-pro", "gemini-flash"]);
export type QuotaGroup = z.infer<typeof QuotaGroupSchema>;

export const QuotaGroupSummarySchema = z.object({
  remainingFraction: RemainingFractionSchema.optional(),
  resetTime: ResetTimeSchema.optional(),
  modelCount: z.number().int().nonnegative(),
});
export type QuotaGroupSummary = z.infer<typeof QuotaGroupSummarySchema>;

export const QuotaSummarySchema = z.object({
  groups: z
    .object({
      claude: QuotaGroupSummarySchema.optional(),
      "gemini-pro": QuotaGroupSummarySchema.optional(),
      "gemini-flash": QuotaGroupSummarySchema.optional(),
    })
    .partial(),
  modelCount: z.number().int().nonnegative(),
  error: z.string().optional(),
});
export type QuotaSummary = z.infer<typeof QuotaSummarySchema>;
