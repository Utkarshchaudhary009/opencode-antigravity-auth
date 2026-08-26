import { describe, it, expect } from "vitest";
import { buildUsageOptions, formatQuotaPercent } from "./tui";
import type { AccountStorageV4 } from "./plugin/storage";

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

const NOW = 1_800_000_000_000;

function storageWith(accounts: Array<Record<string, unknown>>): AccountStorageV4 {
  return {
    version: 4,
    accounts: accounts as unknown as AccountStorageV4["accounts"],
    activeIndex: 0,
    activeIndexByFamily: {} as AccountStorageV4["activeIndexByFamily"],
  };
}

describe("buildUsageOptions", () => {
  it('fails open with a "no accounts" row for null or empty storage', () => {
    for (const storage of [null, storageWith([])]) {
      const rows = buildUsageOptions(storage, NOW);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.title).toBe("No accounts found");
      expect(rows[0]?.category).toBe("Window Limits");
      expect(rows[0]?.value).toBe("info:none");
    }
  });

  it("renders one compact gauge line per account, labeled and non-selectable", () => {
    const rows = buildUsageOptions(
      storageWith([
        { email: "alice@example.com", refreshToken: "r", quotaSummary: { fetchedAt: NOW, byGroup: { gemini: { weekly: { remainingFraction: 0.45 } } } } },
        { refreshToken: "r" },
      ]),
      NOW,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]?.title).toBe("1. alice@example.com — Gemini Models  Wk █████░░░░░ 45% · 5h ░░░░░░░░░░ n/a");
    expect(rows[0]?.category).toBe("Window Limits");
    expect(rows[0]?.value).toBe("info:wl:gemini:0");
    // Second account lacks quotaSummary → fail-open placeholder, never 0%.
    expect(rows[1]?.title).toBe("2. Account 2 — — no quota yet —");
    expect(JSON.stringify(rows)).not.toContain("0%");
  });

  it("skips sparse account slots without crashing", () => {
    const storage = storageWith([{ email: "a@x.com", refreshToken: "r" }]);
    (storage.accounts as unknown[])[1] = undefined;
    const rows = buildUsageOptions(storage, NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toContain("1. a@x.com");
  });
});