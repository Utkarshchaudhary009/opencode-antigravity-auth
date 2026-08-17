import { describe, expect, it } from "vitest";

import { __testExports } from "./quota";

const { normalizeRemainingFraction, aggregateGeminiCliQuota } = __testExports;

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