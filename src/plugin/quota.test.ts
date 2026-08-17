import { beforeEach, describe, expect, it, vi } from "vitest";

import { parseRefreshParts } from "./auth";
import { AccountManager, setActiveAccountManager } from "./accounts";
import { clearCachedAuth } from "./cache";
import { fetchAvailableModelsCatalog } from "./model-catalog";
import { ensureProjectContext } from "./project";
import { checkAccountsQuota, __testExports } from "./quota";
import { AntigravityTokenRefreshError, refreshAccessToken } from "./token";
import type { AccountMetadataV3, AccountStorageV4 } from "./storage";
import type { OAuthAuthDetails, PluginClient } from "./types";

const { normalizeRemainingFraction, aggregateGeminiCliQuota } = __testExports;

const hoisted = vi.hoisted(() => {
  const log = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return { log };
});

vi.mock("./logger", () => ({
  createLogger: () => hoisted.log,
}));

// Keep the real AntigravityTokenRefreshError (quota.ts matches with `instanceof`)
// but replace refreshAccessToken so each test controls token refresh outcomes.
vi.mock("./token", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./token")>();
  return { ...actual, refreshAccessToken: vi.fn() };
});

vi.mock("./project", () => ({
  ensureProjectContext: vi.fn(),
  invalidateProjectContextCache: vi.fn(),
}));

vi.mock("./model-catalog", () => ({
  fetchAvailableModelsCatalog: vi.fn(),
}));

vi.mock("./runtime-metadata", () => ({
  initAntigravityRuntimeMetadata: vi.fn(async () => {}),
}));

vi.mock("./debug", () => ({
  logQuotaFetch: vi.fn(),
  logQuotaStatus: vi.fn(),
}));

describe("normalizeRemainingFraction", () => {
  it("fails open: missing/invalid input returns undefined (NOT 0%)", () => {
    expect(normalizeRemainingFraction(undefined)).toBeUndefined();
    expect(normalizeRemainingFraction(null)).toBeUndefined();
    expect(normalizeRemainingFraction(Number.NaN)).toBeUndefined();
    expect(normalizeRemainingFraction(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(normalizeRemainingFraction("0.5")).toBeUndefined();
  });

  it("clamps valid values to [0, 1]", () => {
    expect(normalizeRemainingFraction(-0.5)).toBe(0);
    expect(normalizeRemainingFraction(0)).toBe(0);
    expect(normalizeRemainingFraction(0.42)).toBe(0.42);
    expect(normalizeRemainingFraction(1)).toBe(1);
    expect(normalizeRemainingFraction(3.7)).toBe(1);
  });
});

describe("aggregateGeminiCliQuota (fail-open)", () => {
  it("treats a bucket missing remainingFraction as undefined, not 0%", () => {
    const summary = aggregateGeminiCliQuota({
      buckets: [
        {
          modelId: "gemini-3-pro",
          remainingFraction: undefined,
          resetTime: "2026-01-28T15:00:00Z",
        },
        {
          modelId: "gemini-2.5-pro",
          remainingFraction: Number.NaN,
        },
      ],
    });

    expect(summary.models).toHaveLength(2);
    expect(summary.models[0]!.remainingFraction).toBeUndefined();
    expect(summary.models[1]!.remainingFraction).toBeUndefined();
  });

  it("keeps valid fractions clamped", () => {
    const summary = aggregateGeminiCliQuota({
      buckets: [{ modelId: "gemini-3-pro", remainingFraction: 0.25 }],
    });
    expect(summary.models[0]!.remainingFraction).toBe(0.25);
  });
});

// ============================================================================
// checkAccountsQuota — fresh in-memory auth resolution + refresh retry
// ============================================================================

function createClient(): PluginClient {
  return {
    auth: {
      set: vi.fn(async () => {}),
    },
  } as unknown as PluginClient;
}

function baseAccount(overrides: Partial<AccountMetadataV3> = {}): AccountMetadataV3 {
  return {
    email: "quota@example.com",
    refreshToken: "stale-token",
    projectId: "project-123",
    addedAt: 1_700_000_000_000,
    lastUsed: 0,
    ...overrides,
  };
}

/** Build a real AccountManager whose in-memory records hold `accounts`. */
function makeManager(accounts: AccountMetadataV3[]): AccountManager {
  const stored: AccountStorageV4 = {
    version: 4,
    accounts,
    activeIndex: 0,
  };
  return new AccountManager(undefined, stored);
}

function freshAuth(refresh: string, access = "fresh-access"): OAuthAuthDetails {
  return {
    type: "oauth",
    refresh,
    access,
    expires: Date.now() + 3_600_000,
  };
}

function invalidGrantError(message = "invalid_grant - refresh token revoked"): Error {
  return new AntigravityTokenRefreshError({
    message,
    code: "invalid_grant",
    status: 400,
    statusText: "Bad Request",
  });
}

describe("checkAccountsQuota auth resolution", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    setActiveAccountManager(null);
    clearCachedAuth();
    vi.mocked(ensureProjectContext).mockImplementation(async (auth) => ({
      auth,
      effectiveProjectId: "project-123",
      routeState: { usesGcpTos: false },
    }));
    vi.mocked(fetchAvailableModelsCatalog).mockResolvedValue({
      models: {
        "claude-opus-4-6": {
          displayName: "Claude Opus",
          quotaInfo: { remainingFraction: 0.5 },
        },
      },
    });
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ buckets: [] }), { status: 200 })) as unknown as typeof fetch;
  });

  it("ROTATION RACE: uses the post-rotation in-memory token instead of the stale disk snapshot", async () => {
    // The AccountManager's in-memory record already holds the rotated token
    // (written by the proactive refresh queue) while the disk snapshot passed
    // to checkAccountsQuota still carries the stale token.
    setActiveAccountManager(
      makeManager([baseAccount({ email: "quota@example.com", refreshToken: "rotated-token" })]),
    );
    vi.mocked(refreshAccessToken).mockResolvedValue(freshAuth("rotated-token|project-123", "access-1"));

    const results = await checkAccountsQuota([baseAccount()], createClient());

    expect(results).toHaveLength(1);
    // No invalid_grant error surfaces even though the snapshot token is stale.
    expect(results[0]!.status).toBe("ok");
    expect(results[0]!.error).toBeUndefined();
    // The refresh must have been attempted with the rotated in-memory token.
    const refreshArg = vi.mocked(refreshAccessToken).mock.calls[0]![0] as OAuthAuthDetails;
    expect(parseRefreshParts(refreshArg.refresh).refreshToken).toBe("rotated-token");
    // The rotated token flows back into the updated account metadata.
    expect(results[0]!.updatedAccount?.refreshToken).toBe("rotated-token");
  });

  it("RETRY: stale-snapshot invalid_grant is retried once against current in-memory state and succeeds", async () => {
    const storedAccount = baseAccount();
    const manager = makeManager([{ ...storedAccount }]);
    setActiveAccountManager(manager);

    vi.mocked(refreshAccessToken)
      .mockImplementationOnce(async (auth) => {
        // First attempt was built from the stale snapshot token.
        expect(parseRefreshParts(auth.refresh).refreshToken).toBe("stale-token");
        // Simulate the proactive refresh queue completing a rotation mid-flight:
        // the in-memory record now holds the rotated refresh token (no fresh
        // access token yet, so the retry must perform a real refresh).
        const inMemory = manager.getAccounts()[0];
        if (inMemory) {
          manager.updateFromAuth(inMemory, { type: "oauth", refresh: "rotated-token|project-123" });
        }
        throw invalidGrantError();
      })
      .mockImplementationOnce(async (auth) => {
        // Retry re-resolved against in-memory state: rotated token, no error.
        expect(parseRefreshParts(auth.refresh).refreshToken).toBe("rotated-token");
        return freshAuth("rotated-token|project-123", "access-2");
      });

    const results = await checkAccountsQuota([storedAccount], createClient());

    expect(vi.mocked(refreshAccessToken).mock.calls).toHaveLength(2);
    expect(results[0]!.status).toBe("ok");
    expect(results[0]!.error).toBeUndefined();
  });

  it("RETRY EXHAUSTED: retry also fails with invalid_grant -> error is surfaced, not silently replaced by fail-open data", async () => {
    const storedAccount = baseAccount({
      cachedQuota: { claude: { remainingFraction: 0.4, modelCount: 1 } },
    });
    setActiveAccountManager(
      makeManager([baseAccount({ email: "quota@example.com", refreshToken: "rotated-token" })]),
    );

    vi.mocked(refreshAccessToken)
      .mockRejectedValueOnce(invalidGrantError("invalid_grant - token stale"))
      .mockRejectedValueOnce(invalidGrantError("invalid_grant - still revoked"));

    const results = await checkAccountsQuota([storedAccount], createClient());

    expect(vi.mocked(refreshAccessToken).mock.calls).toHaveLength(2);
    expect(results[0]!.status).toBe("error");
    expect(results[0]!.status).not.toBe("ok");
    // The real error is surfaced, not swallowed.
    expect(results[0]!.error).toContain("invalid_grant");
    // Fail-open cached quota may be attached, but only as an error-flagged result.
    expect(results[0]!.quota?.error).toBe("Showing cached quota data.");
  });

  it("RETRY EMPTY RESULT: empty retry result surfaces the RETRY failure, not the original stale-token error", async () => {
    const storedAccount = baseAccount();
    setActiveAccountManager(
      makeManager([baseAccount({ email: "quota@example.com", refreshToken: "rotated-token" })]),
    );

    // First attempt: stale-snapshot invalid_grant. Retry resolves empty (no
    // usable token) — the surfaced error must describe the retry attempt (with
    // the first attempt's code only as context), not re-raise the original.
    vi.mocked(refreshAccessToken)
      .mockRejectedValueOnce(invalidGrantError("invalid_grant - token stale"))
      .mockResolvedValueOnce(undefined);

    const results = await checkAccountsQuota([storedAccount], createClient());

    expect(vi.mocked(refreshAccessToken).mock.calls).toHaveLength(2);
    expect(results[0]!.status).toBe("error");
    expect(results[0]!.error).toContain("retry did not return a usable token");
    expect(results[0]!.error).toContain("invalid_grant");
    expect(results[0]!.error).not.toContain("token stale");
  });

  it("FAIL-OPEN: a non-token network error propagates immediately and attaches the cached-quota fallback", async () => {
    const storedAccount = baseAccount({
      cachedQuota: { claude: { remainingFraction: 0.6, modelCount: 1 } },
    });
    setActiveAccountManager(makeManager([storedAccount]));

    vi.mocked(refreshAccessToken).mockRejectedValue(new Error("network timeout after 10s"));

    const results = await checkAccountsQuota([storedAccount], createClient());

    // Non-token errors are NOT retried.
    expect(vi.mocked(refreshAccessToken).mock.calls).toHaveLength(1);
    expect(results[0]!.status).toBe("error");
    expect(results[0]!.error).toContain("network timeout");
    expect(results[0]!.quota).toEqual({
      groups: { claude: { remainingFraction: 0.6, modelCount: 1 } },
      modelCount: 1,
      error: "Showing cached quota data.",
    });
  });

  it("GCP-TOS FLAG: undefined stored isGcpTos resolves from current route state; a disagreeing stored flag logs the staleness", async () => {
    vi.mocked(ensureProjectContext).mockImplementation(async (auth) => ({
      auth,
      effectiveProjectId: "project-123",
      routeState: { usesGcpTos: true },
    }));
    vi.mocked(refreshAccessToken).mockResolvedValue(freshAuth("gcp-token|project-123", "access-1"));

    // Phase 1: a successful check records the server-reported route state
    // (usesGcpTos=true) keyed by this refresh token.
    const gcpAccount = baseAccount({ email: "gcp@example.com", refreshToken: "gcp-token" });
    setActiveAccountManager(makeManager([{ ...gcpAccount }]));
    const phase1 = await checkAccountsQuota([gcpAccount], createClient());
    expect(phase1[0]!.status).toBe("ok");

    // Phase 2: stored isGcpTos is undefined -> the CURRENT route state picks the client.
    vi.mocked(refreshAccessToken).mockClear();
    vi.mocked(refreshAccessToken).mockResolvedValue(freshAuth("gcp-token|project-123", "access-2"));
    hoisted.log.debug.mockClear();
    setActiveAccountManager(makeManager([{ ...gcpAccount }]));
    const phase2 = await checkAccountsQuota([gcpAccount], createClient());
    expect(phase2[0]!.status).toBe("ok");
    const phase2Auth = vi.mocked(refreshAccessToken).mock.calls[0]![0] as OAuthAuthDetails;
    expect(parseRefreshParts(phase2Auth.refresh).isGcpTos).toBe(true);
    // No stored flag -> no stale-disagreement log.
    expect(hoisted.log.debug).not.toHaveBeenCalledWith("quota-gcp-tos-flag-stale", expect.anything());

    // Phase 3: a stale stored flag (false) disagrees with current route state (true)
    // -> current state wins AND the disagreement is logged.
    const staleFlagAccount = baseAccount({
      email: "gcp@example.com",
      refreshToken: "gcp-token",
      isGcpTos: false,
    });
    vi.mocked(refreshAccessToken).mockClear();
    vi.mocked(refreshAccessToken).mockResolvedValue(freshAuth("gcp-token|project-123", "access-3"));
    hoisted.log.debug.mockClear();
    setActiveAccountManager(makeManager([{ ...staleFlagAccount }]));
    const phase3 = await checkAccountsQuota([staleFlagAccount], createClient());
    expect(phase3[0]!.status).toBe("ok");
    const phase3Auth = vi.mocked(refreshAccessToken).mock.calls[0]![0] as OAuthAuthDetails;
    expect(parseRefreshParts(phase3Auth.refresh).isGcpTos).toBe(true);
    expect(hoisted.log.debug).toHaveBeenCalledWith("quota-gcp-tos-flag-stale", {
      stored: false,
      current: true,
    });
  });

  it("EMAIL-LESS FILTERED SUBSET: no index fallback — never reads another account's in-memory token", async () => {
    // Manager holds TWO accounts; the check passes ONLY the second account
    // (email-less) as a single-element array, so its array index is 0 while
    // its manager index is 1. Index matching would wrongly return account 0
    // (first@example.com) and refresh with THAT account's token.
    const second: AccountMetadataV3 = {
      email: undefined,
      refreshToken: "second-stale-token",
      projectId: "project-123",
      addedAt: 1_700_000_000_000,
      lastUsed: 0,
    };
    setActiveAccountManager(
      makeManager([
        baseAccount({ email: "first@example.com", refreshToken: "first-token" }),
        { ...second, refreshToken: "second-rotated-token" },
      ]),
    );
    vi.mocked(refreshAccessToken).mockResolvedValue(freshAuth("second-stale-token|project-123", "access-1"));

    const results = await checkAccountsQuota([second], createClient());

    // The refresh must use the disk snapshot token, NOT account 0's token.
    const refreshArg = vi.mocked(refreshAccessToken).mock.calls[0]![0] as OAuthAuthDetails;
    expect(parseRefreshParts(refreshArg.refresh).refreshToken).toBe("second-stale-token");
    expect(results[0]!.status).toBe("ok");
  });

  it("GCP-TOS RACE: zeroed in-memory false does not override a stored true when no route state is known", async () => {
    // Disk snapshot says isGcpTos: true; the in-memory record was rotated by a
    // pre-fix refresh that dropped the flag, leaving parts.isGcpTos = false.
    const stored = baseAccount({ email: "gcp@example.com", refreshToken: "gcp-stale", isGcpTos: true });
    setActiveAccountManager(
      makeManager([{ ...stored, refreshToken: "gcp-rotated", isGcpTos: false }]),
    );
    // No route state recorded for these tokens yet.
    vi.mocked(refreshAccessToken).mockResolvedValue(freshAuth("gcp-rotated|project-123", "access-1"));

    const results = await checkAccountsQuota([stored], createClient());

    const refreshArg = vi.mocked(refreshAccessToken).mock.calls[0]![0] as OAuthAuthDetails;
    expect(parseRefreshParts(refreshArg.refresh).isGcpTos).toBe(true);
    expect(results[0]!.status).toBe("ok");
  });

  it("applyAccountUpdates: without route state, a stored true flag is preserved, not clobbered by a packed false", async () => {
    const stored = baseAccount({ email: "gcp@example.com", refreshToken: "stale-token", isGcpTos: true });
    setActiveAccountManager(makeManager([{ ...stored }]));
    // managedProjectId fast path: ensureProjectContext reports no route state.
    vi.mocked(ensureProjectContext).mockImplementation(async (auth) => ({
      auth,
      effectiveProjectId: "project-123",
      routeState: { usesGcpTos: undefined },
    }));
    // Rotated auth packed WITHOUT the flag (simulates a legacy rotation).
    vi.mocked(refreshAccessToken).mockResolvedValue(freshAuth("rotated-token|project-123", "access-1"));

    const results = await checkAccountsQuota([stored], createClient());

    expect(results[0]!.status).toBe("ok");
    expect(results[0]!.updatedAccount?.refreshToken).toBe("rotated-token");
    expect(results[0]!.updatedAccount?.isGcpTos).toBe(true);
  });
});