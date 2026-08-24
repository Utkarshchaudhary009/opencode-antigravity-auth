/**
 * FetchAvailableModels — Cloud Code v1internal:fetchAvailableModels
 *
 * Live probe 2026-08-23 (Bearer ya29.a0Ad…, UA antigravity/1.22.2 windows/amd64, prod):
 *
 *   POST https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels
 *   Headers: { Authorization: Bearer ya29.a0Ad…, Content-Type: application/json, User-Agent: antigravity/1.22.2 windows/amd64 }
 *   Body: { "project": "<project-id>" }  — also succeeds with {}
 *   Status: 200 OK  (fallback chain: prod → daily → daily-sandbox → autopush, see src/plugin/cloud-code.ts)
 *
 * REDACTED observed response (24 models shown as MAP keyed by model ID; abbreviated):
 * // {
 * //   "models": {
 * //     "gemini-3.6-flash-high": {
 * //       "displayName": "Gemini 3.6 Flash (High)",
 * //       "supportsImages": true, "supportsThinking": true, "thinkingBudget": -1, "minThinkingBudget": 32,
 * //       "recommended": true, "maxTokens": 1048576, "maxOutputTokens": 65536,
 * //       "quotaInfo": { "remainingFraction": 1, "resetTime": "2026-08-23T10:47:02Z" },
 * //       "model": "MODEL_…[redacted len=21]", "apiProvider": "API_PR…[redacted]", "modelProvider": "MODEL_…[redacted]",
 * //       "supportsVideo": true, "tagTitle": "Fast", "tagDescription": "Limited time",
 * //       "supportedMimeTypes": { "image/png": true, "application/pdf": true, ... },
 * //       "modelExperiments": { "experiments": { "CASCADE_USE_EXPERIMENT_CHECKPOINTER": { "stringValue": "..." } } }
 * //     },
 * //     "claude-opus-4-6-thinking": {
 * //       "displayName": "Claude Opus 4.6 (Thinking)",
 * //       "supportsThinking": true, "thinkingBudget": 1024, "maxTokens": 250000, "maxOutputTokens": 64000,
 * //       "quotaInfo": { "remainingFraction": 1, "resetTime": "2026-08-23T10:47:02Z" },
 * //       "vertexModelId": "claude-opus-4-6@default", "model": "MODEL_PLACEHOLDER_M26"
 * //     },
 * //     "chat_20706": {
 * //       "maxTokens": 16384, "quotaInfo": { "remainingFraction": 1 }, // NOTE: no resetTime for internal tab models
 * //       "model": "MODEL_CHAT_20706", "isInternal": true
 * //     }
 * //     // ... + ~20 more (gemini-2.5-pro, gemini-3.1-pro-*, gpt-oss-120b-medium, tab_*, etc.)
 * //   },
 * //   "defaultAgentModelId": "gemini-3.6-flash-high",
 * //   "deprecatedModelIds": { "gemini-3.1-pro-high": { "newModelId": "gemini-pro-agent", "oldModelEnum": "MODEL_PLACEHOLDER_M37", "newModelEnum": "MODEL_PLACEHOLDER_M16" } },
 * //   "experimentIds": [49 numbers],
 * //   "tieredModelIds": { "flashLite": ["gemini-3.5-flash-extra-low"], "flash": ["gemini-3.6-flash-low"], "pro": ["gemini-pro-agent"] },
 * //   "commandModelIds": ["gemini-3.5-flash-low"], "tabModelIds": ["chat_20706","chat_23310"], ...
 * // }
 *
 * Field notes:
 *  - Top-level is a MAP Record<string, CatalogModelEntry>, not an array.
 *  - Per-model quotaInfo mirrors retrieveUserQuota buckets but keyed by model: { remainingFraction: 0-1, resetTime?: ISO }.
 *  - Internal/tab models lack resetTime; beta/disabled/deprecated filtered by src/plugin/model-catalog.ts.
 *  - This endpoint is the source for runtime model discovery (src/plugin/model-catalog.ts:fetchAvailableModelsCatalog) and
 *    the proposed model-propagation pipeline (HANDOFF §9).
 */
import { z } from "zod";
import { RemainingFractionSchema, ResetTimeSchema } from "./common.ts";

export const FetchAvailableModelsRequestSchema = z
  .object({
    project: z.string().optional(),
  })
  .passthrough();
export type FetchAvailableModelsRequest = z.infer<typeof FetchAvailableModelsRequestSchema>;

export const CatalogQuotaInfoSchema = z
  .object({
    remainingFraction: RemainingFractionSchema.optional(),
    resetTime: ResetTimeSchema.optional(),
  })
  .passthrough();
export type CatalogQuotaInfo = z.infer<typeof CatalogQuotaInfoSchema>;

export const CatalogModelEntrySchema = z
  .object({
    displayName: z.string().optional(),
    description: z.string().optional(),
    supportsImages: z.boolean().optional(),
    supportsThinking: z.boolean().optional(),
    thinkingBudget: z.number().optional(),
    minThinkingBudget: z.number().optional(),
    recommended: z.boolean().optional(),
    maxTokens: z.number().optional(),
    maxOutputTokens: z.number().optional(),
    beta: z.boolean().optional(),
    disabled: z.boolean().optional(),
    quotaInfo: CatalogQuotaInfoSchema.optional(),
    tagTitle: z.string().optional(),
    tagDescription: z.string().optional(),
    supportedMimeTypes: z.record(z.string(), z.boolean()).optional(),
    model: z.string().optional(),
    apiProvider: z.string().optional(),
    modelProvider: z.string().optional(),
    supportsVideo: z.boolean().optional(),
    supportsCumulativeContext: z.boolean().optional(),
    supportsEstimateTokenCounter: z.boolean().optional(),
    isInternal: z.boolean().optional(),
    promptTemplaterType: z.string().optional(),
    toolFormatterType: z.string().optional(),
    requiresLeadInGeneration: z.boolean().optional(),
    requiresNoXmlToolExamples: z.boolean().optional(),
    tabJumpPrintLineRange: z.boolean().optional(),
    addCursorToFindReplaceTarget: z.boolean().optional(),
    vertexModelId: z.string().optional(),
    requiresImageOutputOutsideFunctionResponses: z.boolean().optional(),
    modelExperiments: z
      .object({
        experiments: z.record(
          z.string(),
          z.object({ stringValue: z.string() }).passthrough(),
        ),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type CatalogModelEntry = z.infer<typeof CatalogModelEntrySchema>;

export const FetchAvailableModelsResponseSchema = z
  .object({
    // Required: a 200 response without `models` indicates schema drift or a
    // malformed payload and must fail validation, not parse as "no models".
    models: z.record(z.string(), CatalogModelEntrySchema),
    defaultAgentModelId: z.string().optional(),
    deprecatedModelIds: z
      .record(
        z.string(),
        z
          .object({
            newModelId: z.string().optional(),
            oldModelEnum: z.string().optional(),
            newModelEnum: z.string().optional(),
          })
          .passthrough(),
      )
      .optional(),
    experimentIds: z.array(z.number()).optional(),
    tieredModelIds: z
      .object({
        flashLite: z.array(z.string()).optional(),
        flash: z.array(z.string()).optional(),
        pro: z.array(z.string()).optional(),
      })
      .passthrough()
      .optional(),
    commandModelIds: z.array(z.string()).optional(),
    tabModelIds: z.array(z.string()).optional(),
    imageGenerationModelIds: z.array(z.string()).optional(),
    mqueryModelIds: z.array(z.string()).optional(),
    webSearchModelIds: z.array(z.string()).optional(),
    commitMessageModelIds: z.array(z.string()).optional(),
    audioTranscriptionModelIds: z.array(z.string()).optional(),
    agentModelSorts: z.array(z.unknown()).optional(),
  })
  .passthrough();
export type FetchAvailableModelsResponse = z.infer<typeof FetchAvailableModelsResponseSchema>;
