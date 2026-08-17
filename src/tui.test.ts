import { describe, it, expect } from "vitest";
import { formatQuotaPercent } from "./tui";

describe("formatQuotaPercent", () => {
  it("renders a normal fraction as a rounded percent", () => {
    expect(formatQuotaPercent(0.5)).toBe("50%");
    expect(formatQuotaPercent(0.666)).toBe("67%");
  });

  it("clamps out-of-range values to 0%-100%", () => {
    expect(formatQuotaPercent(0)).toBe("0%");
    expect(formatQuotaPercent(1)).toBe("100%");
    expect(formatQuotaPercent(1.5)).toBe("100%");
    expect(formatQuotaPercent(-0.5)).toBe("0%");
  });

  it('renders "n/a" for undefined', () => {
    expect(formatQuotaPercent(undefined)).toBe("n/a");
  });

  it('renders "n/a" for null', () => {
    expect(formatQuotaPercent(null as unknown as number)).toBe("n/a");
  });

  it('renders "n/a" for NaN', () => {
    expect(formatQuotaPercent(Number.NaN)).toBe("n/a");
  });

  it('renders "n/a" for non-finite values', () => {
    expect(formatQuotaPercent(Number.POSITIVE_INFINITY)).toBe("n/a");
    expect(formatQuotaPercent(Number.NEGATIVE_INFINITY)).toBe("n/a");
  });
});