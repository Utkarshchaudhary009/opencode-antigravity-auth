import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { AccountManager } from "./accounts";
import type { AccountStorageV4 } from "./storage";

type GetGraceRetryDelayMs = (
  accountManager: AccountManager,
  family: string,
  model: string | null | undefined,
  graceMs: number,
  currentRetryMs?: number | null,
  headerStyle?: string,
  accountIndex?: number,
) => number | null;

type GetRateLimitBackoff = (
  accountIndex: number,
  quotaKey: string,
  serverRetryAfterMs: number | null,
  maxBackoffMs?: number,
) => { attempt: number; delayMs: number; isDuplicate: boolean };

type ResetRateLimitState = (accountIndex: number, quotaKey: string) => void;

type ShouldUseGraceRetryOnFirstRateLimit = (switchOnFirstRateLimit: boolean, accountCount: number) => boolean;

let getGraceRetryDelayMs: GetGraceRetryDelayMs | undefined;
let getRateLimitBackoff: GetRateLimitBackoff | undefined;
let resetRateLimitState: ResetRateLimitState | undefined;
let shouldUseGraceRetryOnFirstRateLimit: ShouldUseGraceRetryOnFirstRateLimit | undefined;

describe("GraceRetry (optimistic same-account retry in 429 path)", () => {
  // Importing ../plugin pulls the full module graph (bridge, quota, rotation...),
  // which can exceed the 10s default hook timeout on slow machines.
  beforeAll(async () => {
    vi.mock("@opencode-ai/plugin", () => ({
      tool: vi.fn(),
    }));

    const { __testExports } = await import("../plugin");
    getGraceRetryDelayMs = (__testExports as {
      getGraceRetryDelayMs?: GetGraceRetryDelayMs;
    }).getGraceRetryDelayMs;
    getRateLimitBackoff = (__testExports as {
      getRateLimitBackoff?: GetRateLimitBackoff;
    }).getRateLimitBackoff;
    resetRateLimitState = (__testExports as {
      resetRateLimitState?: ResetRateLimitState;
    }).resetRateLimitState;
    shouldUseGraceRetryOnFirstRateLimit = (__testExports as {
      shouldUseGraceRetryOnFirstRateLimit?: ShouldUseGraceRetryOnFirstRateLimit;
    }).shouldUseGraceRetryOnFirstRateLimit;

    if (!getGraceRetryDelayMs) throw new Error("getGraceRetryDelayMs not found in __testExports");
    if (!getRateLimitBackoff) throw new Error("getRateLimitBackoff not found in __testExports");
    if (!resetRateLimitState) throw new Error("resetRateLimitState not found in __testExports");
    if (!shouldUseGraceRetryOnFirstRateLimit) {
      throw new Error("shouldUseGraceRetryOnFirstRateLimit not found in __testExports");
    }
  }, 60_000);

  // Teardown must run after EVERY test, even when an assertion throws mid-test.
  // Leaving fake timers installed would poison later tests in this file.
  afterEach(() => {
    vi.useRealTimers();
    resetRateLimitState?.(0, "gemini-antigravity");
  });

  it("returns a small same-account delay when minWaitMs is inside the 2s optimistic window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);

    const stored: AccountStorageV4 = {
      version: 4,
      accounts: [
        { refreshToken: "r1", projectId: "p1", addedAt: 1, lastUsed: 0, rateLimitResetTimes: { "gemini-antigravity": 11_000, "gemini-cli": 11_000 } },
      ],
      activeIndex: 0,
    };

    const manager = new AccountManager(undefined, stored);

    // minWait = 1000ms (in (0, 2000]) -> retry same account after 1000 + 100ms.
    expect(getGraceRetryDelayMs!(manager, "gemini", undefined, 0)).toBe(1100);
    // With grace the margin is included: minWait = 2500ms -> outside window, no optimistic retry.
    expect(getGraceRetryDelayMs!(manager, "gemini", undefined, 1500)).toBeNull();

    // The CURRENT 429's retry delay is preferred over (possibly stale) account state.
    // Eligibility uses the RAW retry time (1000ms inside the 2s window); the
    // returned delay = retry + grace margin.
    expect(getGraceRetryDelayMs!(manager, "gemini", undefined, 0, 1000)).toBe(1000);
    // currentRetryMs=1000 + default grace 1500 -> now ELIGIBLE (raw 1000ms <= 2s
    // window, grace is not part of eligibility); returned delay = 2500ms.
    expect(getGraceRetryDelayMs!(manager, "gemini", undefined, 1500, 1000)).toBe(2500);
    // Beyond the 2s window -> no grace retry.
    expect(getGraceRetryDelayMs!(manager, "gemini", undefined, 0, 30_000)).toBeNull();

  });

  it("returns null when an account is already usable (minWaitMs === 0)", () => {
    const stored: AccountStorageV4 = {
      version: 4,
      accounts: [
        { refreshToken: "r1", projectId: "p1", addedAt: 1, lastUsed: 0 },
      ],
      activeIndex: 0,
    };

    const manager = new AccountManager(undefined, stored);
    expect(getGraceRetryDelayMs!(manager, "gemini", undefined, 1500)).toBeNull();
    // A current 429 with no retry info falls back to the state-based computation.
    expect(getGraceRetryDelayMs!(manager, "gemini", undefined, 1500, null)).toBeNull();
    expect(getGraceRetryDelayMs!(manager, "gemini", undefined, 1500, 0)).toBeNull();
  });

  it("returns null when the min-wait exceeds the 2s optimistic window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);

    const stored: AccountStorageV4 = {
      version: 4,
      accounts: [
        { refreshToken: "r1", projectId: "p1", addedAt: 1, lastUsed: 0, rateLimitResetTimes: { "gemini-antigravity": 30_000, "gemini-cli": 30_000 } },
      ],
      activeIndex: 0,
    };

    const manager = new AccountManager(undefined, stored);
    expect(getGraceRetryDelayMs!(manager, "gemini", undefined, 0)).toBeNull();
    expect(getGraceRetryDelayMs!(manager, "gemini", undefined, 1500)).toBeNull();
    // Current-429 retry info beyond the optimistic window -> no grace retry.
    expect(getGraceRetryDelayMs!(manager, "gemini", undefined, 0, 30_000)).toBeNull();
    expect(getGraceRetryDelayMs!(manager, "gemini", undefined, 1500, 30_000)).toBeNull();

  });

  it("restricts the fallback min-wait to the headerStyle that got 429'd (no cross-pool false eligibility)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);

    const stored: AccountStorageV4 = {
      version: 4,
      accounts: [
        {
          refreshToken: "r1",
          projectId: "p1",
          addedAt: 1,
          lastUsed: 0,
          // The antigravity pool reset is far out, but gemini-cli recovers in 1s.
          rateLimitResetTimes: { "gemini-antigravity": 60_000, "gemini-cli": 11_000 },
        },
      ],
      activeIndex: 0,
    };

    const manager = new AccountManager(undefined, stored);

    // Non-strict (no headerStyle): min over BOTH pools = 1000ms -> falsely eligible.
    expect(getGraceRetryDelayMs!(manager, "gemini", undefined, 0)).toBe(1100);
    // Restricting to the affected antigravity pool: 50s wait -> not eligible.
    expect(getGraceRetryDelayMs!(manager, "gemini", undefined, 0, null, "antigravity")).toBeNull();
    // Restricting to the gemini-cli pool: 1s wait -> eligible.
    expect(getGraceRetryDelayMs!(manager, "gemini", undefined, 0, null, "gemini-cli")).toBe(1100);

  });

  it("repeated 429s with small retry info eventually escalate instead of looping on the same account forever", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);

    const quotaKey = "gemini-antigravity";

    // 429 #1 with small retry info (1s): first event, not a duplicate, so the
    // grace branch may optimistically retry the SAME account.
    const first = getRateLimitBackoff!(0, quotaKey, 1000);
    expect(first?.attempt).toBe(1);
    expect(first?.isDuplicate).toBe(false);

    // 429 #2 arrives within the 2s dedup window (the grace delay is < 2s).
    // Dedup pins attempt at 1 and flags isDuplicate=true. Without the
    // `!isDuplicate` gate on the grace branch this is the infinite-loop spot:
    // attempt stayed 1, the grace branch kept firing, and
    // markRateLimitedWithReason / rotation never ran.
    vi.setSystemTime(11_000);
    const second = getRateLimitBackoff!(0, quotaKey, 1000);
    expect(second?.attempt).toBe(1);
    expect(second?.isDuplicate).toBe(true);

    // Even though the small retry info is still grace-eligible in isolation,
    // the branch is now gated on `!isDuplicate`, so a duplicate skips it and
    // falls through to the normal rate-limit path (markRateLimited -> rotation).
    // Show the delay is still eligible, proving the gate — not eligibility —
    // is what breaks the loop.
    const stored: AccountStorageV4 = {
      version: 4,
      accounts: [
        { refreshToken: "r1", projectId: "p1", addedAt: 1, lastUsed: 0, rateLimitResetTimes: { "gemini-antigravity": 11_000, "gemini-cli": 11_000 } },
      ],
      activeIndex: 0,
    };
    const manager = new AccountManager(undefined, stored);
    expect(getGraceRetryDelayMs!(manager, "gemini", undefined, 0, 1000)).toBe(1000);

    // 429 #3 after the 2s dedup window has elapsed: the counter escalates to
    // attempt 2, which drives the normal rate-limit path (account rotation).
    vi.setSystemTime(13_000);
    const third = getRateLimitBackoff!(0, quotaKey, 1000);
    expect(third?.isDuplicate).toBe(false);
    expect(third?.attempt).toBe(2);

  });

  it("gates the same-account grace retry behind switch_on_first_rate_limit (finding: switch must win)", () => {
    // With switch_on_first_rate_limit enabled and a pool large enough to
    // switch (accountCount > 1), the first 429 must switch accounts, not
    // optimistically retry the SAME account.
    expect(shouldUseGraceRetryOnFirstRateLimit!(true, 2)).toBe(false);
    expect(shouldUseGraceRetryOnFirstRateLimit!(true, 5)).toBe(false);
    // Single account: the switch is a no-op, so the grace retry stays available.
    expect(shouldUseGraceRetryOnFirstRateLimit!(true, 1)).toBe(true);
    // Switching disabled: grace retry always available.
    expect(shouldUseGraceRetryOnFirstRateLimit!(false, 1)).toBe(true);
    expect(shouldUseGraceRetryOnFirstRateLimit!(false, 5)).toBe(true);
  });

  it("treats a current-429 retry delay of 0 as real info instead of falling back to stale account state", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);

    const stored: AccountStorageV4 = {
      version: 4,
      accounts: [
        {
          refreshToken: "r1",
          projectId: "p1",
          addedAt: 1,
          lastUsed: 0,
          // A PRIOR failure left this pool recovering in 1s. A current 429 with
          // retry delay 0 must NOT fall through to this stale state (which
          // would produce an unrelated optimistic retry of 1100ms).
          rateLimitResetTimes: { "gemini-antigravity": 11_000, "gemini-cli": 11_000 },
        },
      ],
      activeIndex: 0,
    };

    const manager = new AccountManager(undefined, stored);
    // A real server "retry after 0ms" is outside the >0 optimistic window -> null.
    expect(getGraceRetryDelayMs!(manager, "gemini", undefined, 0, 0)).toBeNull();
    // Sanity: a 1s current retry IS eligible and returns retry + grace.
    expect(getGraceRetryDelayMs!(manager, "gemini", undefined, 0, 1000)).toBe(1000);

  });

  it("restricts the no-retry-info fallback to the 429'd account (not another pool account's deadline)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);

    const stored: AccountStorageV4 = {
      version: 4,
      accounts: [
        {
          refreshToken: "r1",
          projectId: "p1",
          addedAt: 1,
          lastUsed: 0,
          // Account 0's OWN antigravity reset is far out (50s wait).
          rateLimitResetTimes: { "gemini-antigravity": 60_000, "gemini-cli": 60_000 },
        },
        {
          refreshToken: "r2",
          projectId: "p2",
          addedAt: 2,
          lastUsed: 0,
          // Account 1 recovers in 1s — this is what makes the pool-wide
          // min-wait falsely optimistic for account 0.
          rateLimitResetTimes: { "gemini-antigravity": 11_000, "gemini-cli": 11_000 },
        },
      ],
      activeIndex: 0,
    };

    const manager = new AccountManager(undefined, stored);

    // Pool-wide (no accountIndex): min over all accounts = 1s -> falsely eligible.
    expect(getGraceRetryDelayMs!(manager, "gemini", undefined, 0, null, "antigravity")).toBe(1100);
    // Restricted to the account that actually got 429'd (index 0): 50s wait -> no grace retry.
    expect(getGraceRetryDelayMs!(manager, "gemini", undefined, 0, null, "antigravity", 0)).toBeNull();
    // The other account, taken alone, would legitimately be eligible.
    expect(getGraceRetryDelayMs!(manager, "gemini", undefined, 0, null, "antigravity", 1)).toBe(1100);

  });
});
