/**
 * Pure gauge-card helpers for the accounts dialog (Design 2 — Gauge Bar Cards,
 * Layer 2): compact per-account window-limit rows plus the keybinding→action
 * mapping for the gauge keyboard layer.
 *
 * No I/O and no ANSI: output is plain text so it is safe inside OpenCode's
 * DialogSelect (which renders strings verbatim) and trivially unit-testable.
 */

import type { QuotaGroupKey, WindowBucket } from "../weekly-limits";
import { DEFAULT_BAR_WIDTH, renderBarPlain, renderPercentPlain } from "./bar";
import type { KeyAction } from "./ansi";

/** Group display labels per docs/HANDOFF.md (`groupDisplayNameToKey`). */
export const GROUP_LABELS: Record<QuotaGroupKey, string> = {
  gemini: "Gemini Models",
  "3p": "Claude & GPT",
};

/** Ordered window keys — the ONLY taxonomy rendered here (never legacy claude/gemini-pro/gemini-flash). */
export const GROUP_KEYS: readonly QuotaGroupKey[] = ["gemini", "3p"];

/** Weekly fraction below which a cell is flagged LOW. */
export const LOW_THRESHOLD = 0.2;

export type GaugeWindowBucket = WindowBucket;

/** Structural subset of `QuotaWindowSummary` (schema/weekly-limits.ts) — stored accounts pass straight in. */
export interface GaugeWindowSummary {
  byGroup?: Partial<Record<QuotaGroupKey, { weekly?: GaugeWindowBucket; fiveHour?: GaugeWindowBucket }>>;
  fetchedAt?: number;
}

export interface GaugeAccountInput {
  quotaSummary?: GaugeWindowSummary;
}

/**
 * Runtime-safe adapter for stored accounts: `quotaSummary` only exists after
 * the storage migration lands, so older shapes read as "no data" (fail-open)
 * instead of failing the weak-type check or crashing.
 */
export function toGaugeAccount(account: unknown): GaugeAccountInput {
  if (!account || typeof account !== "object") return {};
  const summary = (account as { quotaSummary?: unknown }).quotaSummary;
  return {
    quotaSummary: summary && typeof summary === "object" ? (summary as GaugeWindowSummary) : undefined,
  };
}

export interface GaugeCardOption {
  title: string;
  value: string;
  category: "Window Limits";
  description?: string;
}

/** Semantic action for the gauge keyboard layer. */
export type GaugeAction = "refresh-account" | "account-prev" | "account-next";

/**
 * Map a parsed key action onto a gauge-screen action.
 * `[R]` → refresh · `[←]` → previous account · `[→]` → next account.
 * Anything else (up/down/enter/esc/unknown) maps to null.
 *
 * SDK LIMITATION (verified against @opencode-ai/plugin dist/tui.d.ts):
 * OpenCode's hosted `api.ui.DialogSelect` exposes only onMove/onFilter/
 * onSelect — it has NO raw-key hook, so these keybinds are unreachable
 * there. The plugin-owned `select()` surface (src/plugin/ui/select.ts)
 * dispatches them via its `onAction` hook; the accounts dialog additionally
 * exposes equivalent selectable menu entries (see src/tui.ts) so the same
 * actions stay reachable without raw-key capture.
 */
export function mapAccountsKeybind(action: KeyAction): GaugeAction | null {
  switch (action) {
    case "refresh":
      return "refresh-account";
    case "left":
      return "account-prev";
    case "right":
      return "account-next";
    default:
      return null;
  }
}

function isKnownFraction(fraction: number | undefined): fraction is number {
  return typeof fraction === "number" && Number.isFinite(fraction);
}

/**
 * Single source of truth for the LOW flag: a fraction qualifies only when it
 * is known (finite) AND strictly below LOW_THRESHOLD. Shared by the roster
 * lines, detail card, and micro variant so thresholds never drift.
 */
export function isLowFraction(fraction: number | undefined): boolean {
  return isKnownFraction(fraction) && fraction < LOW_THRESHOLD;
}

export function formatWaitShort(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${totalSeconds}s`;
}

export function formatResetSuffix(resetTime: string | undefined, now: number): string {
  if (!resetTime) return "";
  const ms = Date.parse(resetTime) - now;
  if (!Number.isFinite(ms)) return "";
  if (ms <= 0) return " resetting";
  return ` resets ${formatWaitShort(ms)}`;
}

export function formatAge(fetchedAt: number, now: number): string {
  return `${formatWaitShort(Math.max(0, now - fetchedAt))} ago`;
}

/** Compact single-window cell: `Wk █████░░░░░ 45% resets 3d 2h LOW`. */
function formatWindowCell(label: string, bucket: GaugeWindowBucket | undefined, now: number): string {
  const fraction: number | undefined = bucket?.remainingFraction;
  const low = isLowFraction(fraction) ? " LOW" : "";
  const bar = renderBarPlain(fraction, DEFAULT_BAR_WIDTH);
  return `${label} ${bar} ${renderPercentPlain(fraction)}${low}${formatResetSuffix(bucket?.resetTime, now)}`;
}

/**
 * One compact per-group gauge line: weekly + 5-hour cells separated by `·`.
 */
export function formatGroupGaugeLine(
  group: { weekly?: GaugeWindowBucket; fiveHour?: GaugeWindowBucket },
  now: number,
): string {
  return `${formatWindowCell("Wk", group.weekly, now)} · ${formatWindowCell("5h", group.fiveHour, now)}`;
}

function noQuotaOption(reason: string): GaugeCardOption[] {
  return [
    {
      title: "— no quota yet —",
      value: `wl:none:${reason}`,
      category: "Window Limits",
      description: "Run Check quotas to fetch weekly / 5-hour limits.",
    },
  ];
}

/**
 * Wrap-around account switch target for `[←]`/`[→]`.
 * Returns the current index unchanged when there is nothing to move to.
 */
export function nextAccountIndex(activeIndex: number, count: number, direction: 1 | -1): number {
  if (!Number.isFinite(activeIndex) || !Number.isFinite(count) || count <= 0) return 0;
  const clamped = Math.max(0, Math.min(count - 1, Math.trunc(activeIndex)));
  if (count === 1) return clamped;
  return (((clamped + direction) % count) + count) % count;
}

/**
 * Non-selectable "Window Limits" rows for one account:
 * - missing summary/fetchedAt → dim placeholder row (fail-open, never `0%`)
 * - otherwise one compact gauge line per reported group (gemini | 3p only)
 * Callers prefix `value` with their non-selectable idiom (e.g. `info:`).
 */
export function buildWindowLimitOptions(account: GaugeAccountInput | undefined, now: number): GaugeCardOption[] {
  const summary = account?.quotaSummary;
  if (!summary || typeof summary.fetchedAt !== "number" || !Number.isFinite(summary.fetchedAt)) {
    return noQuotaOption("missing");
  }

  const byGroup = summary.byGroup;
  if (!byGroup || typeof byGroup !== "object") {
    return noQuotaOption("empty");
  }

  const options: GaugeCardOption[] = [];
  for (const key of GROUP_KEYS) {
    const group = byGroup[key];
    if (!group || typeof group !== "object") continue;
    options.push({
      title: `${GROUP_LABELS[key]}  ${formatGroupGaugeLine(group, now)}`,
      value: `wl:${key}`,
      category: "Window Limits",
      description: `Updated ${formatAge(summary.fetchedAt, now)}`,
    });
  }

  if (options.length === 0) {
    return noQuotaOption("nobuckets");
  }
  return options;
}
