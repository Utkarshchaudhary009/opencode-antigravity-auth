import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AntigravityTokenRefreshError } from "./token";
import { emptyQuotaWindowSummary, fetchWeeklyLimits } from "./weekly-limits";
import type { OAuthAuthDetails } from "./types";

const hoisted = vi.hoisted(() => {
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { log };
});

vi.mock("./logger", () => ({
  createLogger: () => hoisted.log,
}));

function makeAuth(access = "ya29.test-token"): OAuthAuthDetails {
  return { type: "oauth", refresh: "refresh-token|project-123", access, expires: Date.now() + 3600000 };
}

function jsonResponse(body: unknown, status = 200, statusText = "OK"): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { "Content-Type": "application/json" },
  });
}

const FULL_RESPONSE = {
  groups: [
    {
      displayName: "Gemini Models",
      description: "Models within this group: Gemini Flash, Gemini Pro",
      buckets: [
        {
          bucketId: "gemini-weekly",
          displayName: "Weekly Limit Remaining",
          window: "weekly",
          resetTime: "2026-08-30T05:47:08Z",
          remainingFraction: 1,
        },
        {
          bucketId: "gemini-5h",
          displayName: "Five Hour Limit Remaining",
          window: "5h",
          resetTime: "2026-08-23T10:47:08Z",
          remainingFraction: 0.8,
        },
      ],
    },
    {
      displayName: "Claude and GPT models",
      description: "Models within this group: Claude Opus, Claude Sonnet, GPT-OSS",
      buckets: [
        {
          bucketId: "3p-weekly",
          displayName: "Weekly Limit Remaining",
          window: "weekly",
          resetTime: "2026-08-30T05:47:08Z",
          remainingFraction: 0.55,
        },
        {
          bucketId: "3p-5h",
          displayName: "Five Hour Limit Remaining",
          window: "5h",
          resetTime: "2026-08-23T10:47:08Z",
          remainingFraction: 0.9,
        },
      ],
    },
  ],
  description: "Within each group, models share a weekly limit and a 5-hour limit.",
};

describe("emptyQuotaWindowSummary", () => {
  it("returns empty byGroup and rawBuckets with fetchedAt", () => {
    const s = emptyQuotaWindowSummary();
    expect(s.byGroup).toEqual({});
    expect(s.rawBuckets).toEqual([]);
    expect(typeof s.fetchedAt).toBe("number");
  });
});

describe("fetchWeeklyLimits", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("success: 2 groups × 2 windows → byGroup gemini+3p each weekly/5h and 4 rawBuckets", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(FULL_RESPONSE)));
    const result = await fetchWeeklyLimits(makeAuth(), "project-123");
    expect(result.byGroup.gemini?.weekly?.remainingFraction).toBe(1);
    expect(result.byGroup.gemini?.weekly?.resetTime).toBe("2026-08-30T05:47:08Z");
    expect(result.byGroup.gemini?.fiveHour?.remainingFraction).toBe(0.8);
    expect(result.byGroup["3p"]?.weekly?.remainingFraction).toBe(0.55);
    expect(result.byGroup["3p"]?.fiveHour?.remainingFraction).toBe(0.9);
    expect(result.rawBuckets).toHaveLength(4);
    expect(result.rawBuckets.map((b) => b.bucketId).sort()).toEqual(
      ["3p-5h", "3p-weekly", "gemini-5h", "gemini-weekly"].sort(),
    );
    expect(result.fetchedAt).toBeGreaterThan(0);
    // headers used
    const fetchCalls = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(fetchCalls.length).toBeGreaterThan(0);
    const opts = fetchCalls[0]![1] as RequestInit;
    const headers = opts.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer ya29.test-token");
    expect(headers["User-Agent"]).toMatch(/^antigravity\//);
  });

  it("partial/missing: missing window inferred from bucketId, missing remainingFraction → undefined, missing resetTime → undefined", async () => {
    const partial = {
      groups: [
        {
          displayName: "Gemini Models",
          buckets: [
            { bucketId: "gemini-weekly", remainingFraction: 0.42 }, // no window, no resetTime
            { bucketId: "gemini-5h", window: "5h" }, // no fraction, no resetTime
          ],
        },
        {
          displayName: "Claude and GPT models",
          buckets: [
            { bucketId: "3p-weekly", window: "weekly", resetTime: "2026-08-30T05:47:08Z" }, // no fraction
          ],
        },
      ],
    };
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(partial)));
    const result = await fetchWeeklyLimits(makeAuth(), "project-123");
    // gemini weekly inferred, fraction 0.42, no reset
    expect(result.byGroup.gemini?.weekly?.remainingFraction).toBe(0.42);
    expect(result.byGroup.gemini?.weekly?.resetTime).toBeUndefined();
    // gemini 5h fraction undefined
    expect(result.byGroup.gemini?.fiveHour?.remainingFraction).toBeUndefined();
    expect(result.byGroup.gemini?.fiveHour?.resetTime).toBeUndefined();
    // 3p weekly fraction undefined, reset present
    expect(result.byGroup["3p"]?.weekly?.remainingFraction).toBeUndefined();
    expect(result.byGroup["3p"]?.weekly?.resetTime).toBe("2026-08-30T05:47:08Z");
    expect(result.rawBuckets).toHaveLength(3);
  });

  it("empty groups → empty byGroup and rawBuckets", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ groups: [] })));
    const result = await fetchWeeklyLimits(makeAuth());
    expect(result.byGroup).toEqual({});
    expect(result.rawBuckets).toEqual([]);
  });

  it("non-ok (500) → fail-open empty", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("server error", { status: 500, statusText: "Internal Server Error" })));
    const result = await fetchWeeklyLimits(makeAuth(), "project-123");
    expect(result.byGroup).toEqual({});
    expect(result.rawBuckets).toEqual([]);
  });

  it("network error → fail-open empty", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    const result = await fetchWeeklyLimits(makeAuth());
    expect(result.byGroup).toEqual({});
    expect(result.rawBuckets).toEqual([]);
    expect(result.fetchedAt).toBeGreaterThan(0);
  });

  it("unknown bucketId → rawBuckets kept but byGroup not populated for unknown", async () => {
    const unknown = {
      groups: [
        {
          displayName: "Unknown Models",
          buckets: [{ bucketId: "custom-unknown-bucket", window: "weekly", remainingFraction: 0.7, resetTime: "2026-08-30T05:47:08Z" }],
        },
        {
          displayName: "Gemini Models",
          buckets: [{ bucketId: "gemini-weekly", window: "weekly", remainingFraction: 0.9, resetTime: "2026-08-30T05:47:08Z" }],
        },
      ],
    };
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(unknown)));
    const result = await fetchWeeklyLimits(makeAuth());
    // Only gemini should be aggregated; unknown group skipped
    expect(result.byGroup.gemini?.weekly?.remainingFraction).toBe(0.9);
    expect(result.byGroup["3p"]).toBeUndefined();
    // raw should contain both, but unknown bucket's window is kept
    expect(result.rawBuckets).toHaveLength(2);
    expect(result.rawBuckets.some((b) => b.bucketId === "custom-unknown-bucket")).toBe(true);
    // unknown bucket raw window is "weekly" as provided, but not aggregated due to group unknown
    const unknownRaw = result.rawBuckets.find((b) => b.bucketId === "custom-unknown-bucket");
    expect(unknownRaw?.remainingFraction).toBe(0.7);
  });

  it("clamping: -0.5→0, 1.5→1, NaN/string → undefined", async () => {
    const clamping = {
      groups: [
        {
          displayName: "Gemini Models",
          buckets: [
            { bucketId: "gemini-weekly", window: "weekly", remainingFraction: -0.5, resetTime: "2026-08-30T05:47:08Z" },
            { bucketId: "gemini-5h", window: "5h", remainingFraction: 1.5, resetTime: "2026-08-23T10:47:08Z" },
          ],
        },
        {
          displayName: "Claude and GPT models",
          buckets: [
            { bucketId: "3p-weekly", window: "weekly", remainingFraction: Number.NaN, resetTime: "2026-08-30T05:47:08Z" },
            { bucketId: "3p-5h", window: "5h", remainingFraction: "0.5" as unknown as number, resetTime: "invalid-date" },
          ],
        },
      ],
    };
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(clamping)));
    const result = await fetchWeeklyLimits(makeAuth());
    expect(result.byGroup.gemini?.weekly?.remainingFraction).toBe(0);
    expect(result.byGroup.gemini?.fiveHour?.remainingFraction).toBe(1);
    expect(result.byGroup["3p"]?.weekly?.remainingFraction).toBeUndefined();
    expect(result.byGroup["3p"]?.fiveHour?.remainingFraction).toBeUndefined();
    // invalid resetTime should be undefined (fail-open)
    expect(result.byGroup["3p"]?.fiveHour?.resetTime).toBeUndefined();
    // raw should reflect clamped/undefined
    const gemWeeklyRaw = result.rawBuckets.find((b) => b.bucketId === "gemini-weekly");
    expect(gemWeeklyRaw?.remainingFraction).toBe(0);
    const gem5hRaw = result.rawBuckets.find((b) => b.bucketId === "gemini-5h");
    expect(gem5hRaw?.remainingFraction).toBe(1);
  });

  it("auth error 401 → throws AntigravityTokenRefreshError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: { code: 401, status: "UNAUTHENTICATED", message: "invalid" } }), { status: 401, statusText: "Unauthorized" })),
    );
    await expect(fetchWeeklyLimits(makeAuth("bad-token"))).rejects.toBeInstanceOf(AntigravityTokenRefreshError);
  });

  it("auth error 403 → throws AntigravityTokenRefreshError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("forbidden", { status: 403, statusText: "Forbidden" })));
    await expect(fetchWeeklyLimits(makeAuth())).rejects.toBeInstanceOf(AntigravityTokenRefreshError);
  });

  it("infers window from bucketId when window missing (gemini-5h → 5h, 3p-weekly → weekly) and group fallback from bucketId", async () => {
    const infer = {
      groups: [
        {
          // displayName missing → groupDisplayNameToKey returns undefined, fallback via bucketId
          buckets: [
            { bucketId: "gemini-5h", remainingFraction: 0.77, resetTime: "2026-08-23T10:47:08Z" },
            { bucketId: "3p-weekly", remainingFraction: 0.33, resetTime: "2026-08-30T05:47:08Z" },
          ],
        },
      ],
    };
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(infer)));
    const result = await fetchWeeklyLimits(makeAuth());
    // Should have inferred windows and groups via bucketId
    expect(result.byGroup.gemini?.fiveHour?.remainingFraction).toBe(0.77);
    expect(result.byGroup["3p"]?.weekly?.remainingFraction).toBe(0.33);
    expect(result.rawBuckets).toHaveLength(2);
    expect(result.rawBuckets.find((b) => b.bucketId === "gemini-5h")?.window).toBe("5h");
    expect(result.rawBuckets.find((b) => b.bucketId === "3p-weekly")?.window).toBe("weekly");
  });

  it("fallback top-level buckets[] without groups → still aggregated", async () => {
    const topLevel = {
      groups: [],
      buckets: [
        { bucketId: "gemini-weekly", window: "weekly", remainingFraction: 0.9, resetTime: "2026-08-30T05:47:08Z" },
        { bucketId: "3p-5h", window: "5h", remainingFraction: 1, resetTime: "2026-08-23T10:47:08Z" },
      ],
    };
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(topLevel)));
    const result = await fetchWeeklyLimits(makeAuth());
    expect(result.byGroup.gemini?.weekly?.remainingFraction).toBe(0.9);
    expect(result.byGroup["3p"]?.fiveHour?.remainingFraction).toBe(1);
    expect(result.rawBuckets).toHaveLength(2);
  });

  it("zod parse failure (malformed groups) → fail-open empty", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ groups: "not-an-array" })));
    const result = await fetchWeeklyLimits(makeAuth());
    expect(result.byGroup).toEqual({});
    expect(result.rawBuckets).toEqual([]);
  });

  it("uses project body {} when no projectId, and {project} when provided", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(FULL_RESPONSE));
    vi.stubGlobal("fetch", fetchMock);
    await fetchWeeklyLimits(makeAuth(), undefined);
    expect(JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({});
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
    await fetchWeeklyLimits(makeAuth(), "my-project-123");
    expect(JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ project: "my-project-123" });
  });

  it("timeout (AbortError) → fail-open empty after trying next host", async () => {
    const abortError = Object.assign(new Error("aborted"), { name: "AbortError" });
    vi.stubGlobal("fetch", vi.fn(async () => { throw abortError; }));
    const result = await fetchWeeklyLimits(makeAuth());
    expect(result.byGroup).toEqual({});
    expect(result.rawBuckets).toEqual([]);
  });
});
