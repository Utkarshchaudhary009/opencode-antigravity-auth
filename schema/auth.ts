/**
 * OAuth refresh schemas — google-auth-library → oauth2.googleapis.com/token
 *
 * Live probe (2026-08-23):
 *   - Storage path resolved via src/plugin/storage.ts logic:
 *     OPENCODE_CONFIG_DIR > XDG_CONFIG_HOME > ~/.config/opencode/antigravity-accounts.json
 *     Found: C:\Users\acerr\.config\opencode\antigravity-accounts.json (v4, 4 accounts)
 *   - Refreshed account 0 (utk***@***, project fit-map-8hv63, isGcpTos=false)
 *     via refreshAccessToken() → tok_ya29.a0A… (first 8 chars: ya29.a0A) expires 2026-08-23T06:46:38.353Z
 *     Client: OPENCODE_ANTIGRAVITY_CLIENT_ID (10710060…) / secret len 35; isGcpTos selects GCP-ToS client.
 *   - HTTP: POST https://oauth2.googleapis.com/token  Content-Type: application/x-www-form-urlencoded
 *
 * REDACTED success example (observed via token.ts log redaction):
 * // {
 * //   "access_token": "ya29.a0Ad…[redacted len=~180]",
 * //   "expires_in": 3599,
 * //   "scope": "https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email ...",
 * //   "token_type": "Bearer",
 * //   "expiry_date": 1787467598353,
 * //   "refresh_token": "1//0gGD9…[redacted]" // only when Google rotates
 * // }
 *
 * Error shape (from src/plugin/token.ts:parseOAuthErrorPayload, also observed with invalid token === 401):
 * // {
 * //   "error": "invalid_grant",
 * //   "error_description": "Token has been expired or revoked."
 * // }
 * // or nested: { "error": { "code": 401, "status": "UNAUTHENTICATED", "message": "..." } }
 */
import { z } from "zod";

export const OAuthRefreshRequestSchema = z.object({
  grant_type: z.literal("refresh_token"),
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
  refresh_token: z.string().min(1),
});
export type OAuthRefreshRequest = z.infer<typeof OAuthRefreshRequestSchema>;

export const OAuthRefreshSuccessSchema = z
  .object({
    access_token: z.string().min(1),
    expires_in: z.number().int().positive().optional(),
    expiry_date: z.number().int().positive().optional(),
    scope: z.string().optional(),
    token_type: z.string().optional(),
    refresh_token: z.string().optional(),
    id_token: z.string().optional(),
  })
  .passthrough();
export type OAuthRefreshSuccess = z.infer<typeof OAuthRefreshSuccessSchema>;

export const OAuthErrorPayloadSchema = z
  .object({
    error: z.union([
      z.string(),
      z.object({
        code: z.union([z.string(), z.number()]).optional(),
        status: z.string().optional(),
        message: z.string().optional(),
      }),
    ]).optional(),
    error_description: z.string().optional(),
  })
  .passthrough();
export type OAuthErrorPayload = z.infer<typeof OAuthErrorPayloadSchema>;

export const AntigravityTokenRefreshErrorSchema = z.object({
  name: z.literal("AntigravityTokenRefreshError"),
  message: z.string(),
  code: z.string().optional(),
  description: z.string().optional(),
  status: z.number(),
  statusText: z.string(),
});
export type AntigravityTokenRefreshError = z.infer<typeof AntigravityTokenRefreshErrorSchema>;

// Packed refresh string format used in antigravity-accounts.json and OAuthAuthDetails.refresh
// Format: "<refreshToken>|<projectId>|<managedProjectId>|<isGcpTos flag '1' if true>"
// See src/plugin/auth.ts:parseRefreshParts / formatRefreshParts
export const RefreshPartsSchema = z.object({
  refreshToken: z.string().min(1),
  projectId: z.string().optional(),
  managedProjectId: z.string().optional(),
  isGcpTos: z.boolean(),
});
export type RefreshParts = z.infer<typeof RefreshPartsSchema>;

export const OAuthAuthDetailsSchema = z.object({
  type: z.literal("oauth"),
  refresh: z.string().min(1),
  access: z.string().optional(),
  expires: z.number().optional(),
});
export type OAuthAuthDetails = z.infer<typeof OAuthAuthDetailsSchema>;

// Cloud Code unauthenticated error (observed live with dummy token):
// STATUS 401 body: { error: { code: 401, message: "Request had invalid authentication credentials...", status: "UNAUTHENTICATED" } }
export const CloudCodeAuthErrorSchema = z.object({
  error: z.object({
    code: z.number(),
    message: z.string(),
    status: z.string(),
    details: z.array(z.unknown()).optional(),
  }),
});
export type CloudCodeAuthError = z.infer<typeof CloudCodeAuthErrorSchema>;
