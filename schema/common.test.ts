import { describe, expect, it } from "vitest";
import {
  RemainingFractionSchema,
  normalizeRemainingFraction,
  parseResetTime,
} from "./common";

describe("RemainingFractionSchema", () => {
  it("passes valid fractions through unchanged", () => {
    expect(RemainingFractionSchema.parse(0)).toBe(0);
    expect(RemainingFractionSchema.parse(0.42)).toBe(0.42);
    expect(RemainingFractionSchema.parse(1)).toBe(1);
  });

  it("clamps out-of-range values instead of rejecting the response (fail-open)", () => {
    expect(RemainingFractionSchema.parse(-0.5)).toBe(0);
    expect(RemainingFractionSchema.parse(3.7)).toBe(1);
  });

  it("yields undefined for invalid input instead of failing (fail-open)", () => {
    expect(RemainingFractionSchema.parse(Number.NaN)).toBeUndefined();
    expect(RemainingFractionSchema.parse("0.5")).toBeUndefined();
    expect(RemainingFractionSchema.parse(null)).toBeUndefined();
    expect(RemainingFractionSchema.parse(undefined)).toBeUndefined();
  });
});

describe("normalizeRemainingFraction", () => {
  it("returns undefined for missing/invalid input", () => {
    expect(normalizeRemainingFraction(undefined)).toBeUndefined();
    expect(normalizeRemainingFraction(null)).toBeUndefined();
    expect(normalizeRemainingFraction(Number.NaN)).toBeUndefined();
    expect(normalizeRemainingFraction(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(normalizeRemainingFraction("0.5")).toBeUndefined();
  });

  it("clamps valid numbers to [0, 1]", () => {
    expect(normalizeRemainingFraction(-0.5)).toBe(0);
    expect(normalizeRemainingFraction(0)).toBe(0);
    expect(normalizeRemainingFraction(0.42)).toBe(0.42);
    expect(normalizeRemainingFraction(1)).toBe(1);
    expect(normalizeRemainingFraction(3.7)).toBe(1);
  });
});

describe("parseResetTime", () => {
  it("parses RFC3339 UTC strings to epoch ms", () => {
    expect(parseResetTime("2026-08-30T05:47:08Z")).toBe(Date.parse("2026-08-30T05:47:08Z"));
  });

  it("returns null for missing/invalid input", () => {
    expect(parseResetTime(undefined)).toBeNull();
    expect(parseResetTime("")).toBeNull();
    expect(parseResetTime("not-a-date")).toBeNull();
  });
});
