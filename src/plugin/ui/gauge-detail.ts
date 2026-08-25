/**
 * Single-account gauge DETAIL card (Design 2, Layer 3 — the upper layer):
 * full window-group cards for one account plus a compact table view toggle
 * and a narrow-terminal micro variant.
 *
 * Pure string builders only — no I/O. Output is plain text by default so it
 * is safe inside OpenCode's DialogSelect; pass `color: true` for terminal
 * surfaces that interpret ANSI (bars tinted via getBarColor, dim metadata).
 * Color is always supplementary: percent text stays readable without it.
 */

import { ANSI, type KeyAction } from './ansi';
import { DEFAULT_BAR_WIDTH, getBarColor, renderBarPlain, renderPercentPlain } from './bar';
import {
  GROUP_KEYS,
  GROUP_LABELS,
  formatAge,
  formatResetSuffix,
  isLowFraction,
  type GaugeWindowBucket,
  type GaugeWindowSummary,
} from './gauge-cards';

/** View mode for the detail card: `[T]` toggles between these. */
export type DetailViewMode = 'gauge' | 'table';

/** Layout variant: `micro` collapses each group into one compact line. */
export type DetailLayout = 'full' | 'micro';

/** Terminal columns at or below which the micro variant is used. */
export const MICRO_LAYOUT_MAX_COLUMNS = 60;

/** Structural subset of stored accounts — AccountMetadataV3 passes straight in. */
export interface GaugeDetailAccount {
  quotaSummary?: GaugeWindowSummary;
  cachedQuota?: Partial<
    Record<'claude' | 'gemini-pro' | 'gemini-flash', { remainingFraction?: number; resetTime?: string; modelCount?: number }>
  >;
  cachedQuotaUpdatedAt?: number;
}

export interface GaugeDetailRow {
  title: string;
  value: string;
  category: string;
  description?: string;
}

export interface GaugeDetailRenderOptions {
  /** Reference clock for ages/resets (inject for deterministic tests). */
  now: number;
  /** Render mode; defaults to the shared toggle state. */
  mode?: DetailViewMode;
  /**
   * Available terminal width; when `layout` is not forced, the layout is
   * `resolveDetailLayout(width)` — micro at ≤60 columns. Unmeasurable
   * (undefined) widths fail open to the full layout, e.g. on OpenCode's
   * DialogSelect surface where plugins cannot see terminal geometry.
   */
  width?: number;
  /** Force a layout, bypassing width detection entirely. */
  layout?: DetailLayout;
  /** Tint bars via getBarColor and dim metadata (ANSI surfaces only). */
  color?: boolean;
  /** Emit legacy cached-quota rows (skip when the host renders its own). */
  includeLegacy?: boolean;
}

/**
 * Shared display mode across detail surfaces. Kept simple (module scope)
 * because the toggle is a global viewing preference, like a theme.
 */
let detailMode: DetailViewMode = 'gauge';

export function getDetailMode(): DetailViewMode {
  return detailMode;
}

export function setDetailMode(mode: DetailViewMode): void {
  detailMode = mode === 'table' ? 'table' : 'gauge';
}

/** `[T]`: flip between gauge cards and the compact table view. */
export function toggleDetailMode(mode?: DetailViewMode): DetailViewMode {
  const next: DetailViewMode = (mode ?? getDetailMode()) === 'gauge' ? 'table' : 'gauge';
  setDetailMode(next);
  return next;
}

/**
 * Pick the layout from available terminal width. Unknown/unmeasurable
 * widths fail open to the full layout.
 */
export function resolveDetailLayout(width?: number): DetailLayout {
  if (typeof width !== 'number' || !Number.isFinite(width) || width <= 0) return 'full';
  return width <= MICRO_LAYOUT_MAX_COLUMNS ? 'micro' : 'full';
}

/**
 * Measure the current terminal width for select()-based surfaces.
 * Returns undefined when unmeasurable (e.g. non-TTY), letting callers fail
 * open to the full layout. OpenCode's DialogSelect surface cannot measure
 * here and always renders full-width rows.
 */
export function terminalWidth(): number | undefined {
  const columns = process.stdout?.columns;
  return typeof columns === 'number' && Number.isFinite(columns) && columns > 0 ? columns : undefined;
}

/**
 * Map a parsed key action onto a detail-screen action.
 * Only `[T]` is handled here; navigation keys belong to the host menu.
 */
export function mapDetailKeybind(action: KeyAction): 'toggle-mode' | null {
  return action === 'toggle-view' ? 'toggle-mode' : null;
}

function lowTag(fraction: number | undefined, color: boolean): string {
  return isLowFraction(fraction) ? (color ? ` ${ANSI.red}LOW${ANSI.reset}` : ' LOW') : '';
}

/** Tinted bar for ANSI surfaces; identical characters to the plain bar. */
function coloredBar(fraction: number | undefined): string {
  return `${getBarColor(fraction)}${renderBarPlain(fraction, DEFAULT_BAR_WIDTH)}${ANSI.reset}`;
}

function dim(text: string, color: boolean): string {
  return color ? `${ANSI.dim}${text}${ANSI.reset}` : text;
}

interface WindowRowParts {
  label: string;
  bucket: GaugeWindowBucket | undefined;
}

/** One window line: gauge mode keeps the bar, table mode drops it. */
function formatWindowRowTitle(parts: WindowRowParts, opts: GaugeDetailRenderOptions): string {
  const fraction: number | undefined = parts.bucket?.remainingFraction;
  const percent = renderPercentPlain(fraction);
  const reset = parts.bucket?.resetTime ? formatResetSuffix(parts.bucket.resetTime, opts.now) : '';
  if (opts.mode === 'table') {
    return `${parts.label}  ${percent}${lowTag(fraction, !!opts.color)}${reset}`.trimEnd();
  }
  const bar = opts.color ? coloredBar(fraction) : renderBarPlain(fraction, DEFAULT_BAR_WIDTH);
  return `${parts.label} ${bar} ${percent}${lowTag(fraction, !!opts.color)}${reset}`;
}

/** Micro layout: one compact line per group, bars dropped, resets dropped. */
function formatMicroGroupLine(
  key: keyof typeof GROUP_LABELS,
  group: { weekly?: GaugeWindowBucket; fiveHour?: GaugeWindowBucket },
): string {
  const cell = (bucket: GaugeWindowBucket | undefined): string => {
    return `${renderPercentPlain(bucket?.remainingFraction)}${isLowFraction(bucket?.remainingFraction) ? '!' : ''}`;
  };
  return `${GROUP_LABELS[key]}  Wk ${cell(group.weekly)} · 5h ${cell(group.fiveHour)}`;
}

const LEGACY_GROUPS: ReadonlyArray<readonly ['claude' | 'gemini-pro' | 'gemini-flash', string]> = [
  ['claude', 'Claude'],
  ['gemini-pro', 'Gemini Pro'],
  ['gemini-flash', 'Gemini Flash'],
];

/** Dim legacy model-quota lines BELOW the window data (never merged taxonomy). */
function buildLegacyRows(account: GaugeDetailAccount, opts: GaugeDetailRenderOptions): GaugeDetailRow[] {
  const cached = account.cachedQuota ?? {};
  const cachedUpdatedAt = account.cachedQuotaUpdatedAt;
  const hasFreshness = typeof cachedUpdatedAt === 'number' && Number.isFinite(cachedUpdatedAt);
  const present = LEGACY_GROUPS.filter(([key]) => {
    const group = cached[key];
    return !!group && typeof group === 'object';
  });
  if (present.length === 0 && !hasFreshness) return [];

  const rows: GaugeDetailRow[] = [];
  for (const [key, label] of present) {
    const group = cached[key];
    if (!group) continue;
    const percent = renderPercentPlain(group.remainingFraction);
    const reset = group.resetTime ? formatResetSuffix(group.resetTime, opts.now) : '';
    const count = typeof group.modelCount === 'number' && group.modelCount > 0 ? ` (${group.modelCount} model(s))` : '';
    rows.push({
      title: dim(`${label}: ${percent}${reset}${count}`, !!opts.color),
      value: `wld:legacy:${key}`,
      category: 'Model quota (legacy)',
    });
  }
  const first = rows[0];
  if (first && typeof cachedUpdatedAt === 'number' && Number.isFinite(cachedUpdatedAt)) {
    first.description = dim(`Updated ${formatAge(cachedUpdatedAt, opts.now)} · legacy co-display`, !!opts.color);
  }
  return rows;
}

/**
 * Ordered detail rows for one account:
 * freshness header → window groups (per-window lines, or micro one-liners)
 * → legacy cached-quota rows last. Missing summary degrades to a single
 * placeholder row while legacy data still co-displays below.
 */
export function buildGaugeDetailOptions(
  account: GaugeDetailAccount | undefined,
  overrides: GaugeDetailRenderOptions,
): GaugeDetailRow[] {
  const opts: GaugeDetailRenderOptions = {
    ...overrides,
    mode: overrides.mode ?? getDetailMode(),
    // Width-driven default (P1-3): micro variant activates automatically on
    // narrow terminals; unmeasurable width fails open to the full layout.
    layout: overrides.layout ?? resolveDetailLayout(overrides.width),
    includeLegacy: overrides.includeLegacy ?? true,
  };
  const rows: GaugeDetailRow[] = [];
  const summary: GaugeWindowSummary | undefined = account?.quotaSummary;

  if (!summary || typeof summary.fetchedAt !== 'number' || !Number.isFinite(summary.fetchedAt)) {
    rows.push({
      title: dim('— no quota yet —', !!opts.color),
      value: 'wld:none',
      category: 'Window Limits',
      description: dim('Run Refresh quota to fetch weekly / 5-hour limits.', !!opts.color),
    });
  } else {
    rows.push({
      title: `Window limits · updated ${formatAge(summary.fetchedAt, opts.now)}`,
      value: 'wld:freshness',
      category: 'Window Limits',
    });

    const byGroup = summary.byGroup;
    for (const key of GROUP_KEYS) {
      const group = byGroup && typeof byGroup === 'object' ? byGroup[key] : undefined;
      if (!group || typeof group !== 'object') continue;

      if (opts.layout === 'micro') {
        rows.push({
          title: formatMicroGroupLine(key, group),
          value: `wld:micro:${key}`,
          category: 'Window Limits',
        });
        continue;
      }

      rows.push({ title: GROUP_LABELS[key], value: `wld:head:${key}`, category: 'Window Limits' });
      if (group.weekly !== undefined) {
        rows.push({ title: formatWindowRowTitle({ label: 'Weekly ', bucket: group.weekly }, opts), value: `wld:${key}:weekly`, category: 'Window Limits' });
      }
      if (group.fiveHour !== undefined) {
        rows.push({ title: formatWindowRowTitle({ label: '5-hour ', bucket: group.fiveHour }, opts), value: `wld:${key}:fiveHour`, category: 'Window Limits' });
      }
    }
  }

  if (opts.includeLegacy !== false) {
    rows.push(...buildLegacyRows(account ?? {}, opts));
  }
  return rows;
}
