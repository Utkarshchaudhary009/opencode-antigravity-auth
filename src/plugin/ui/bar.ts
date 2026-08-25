/**
 * Pure gauge-bar rendering helpers for the quota TUI (Design 2 — Gauge Bar Cards).
 *
 * No TTY, no I/O: every export is a string-in/string-out function so it can be
 * unit-tested in isolation and reused by any dialog renderer. Color is
 * supplementary only — callers must keep percent text readable without it.
 */

import { ANSI } from './ansi';

/** Default bar length (chars) per the Design 2 spec. */
export const DEFAULT_BAR_WIDTH = 10;

/**
 * Upper bound for custom bar widths. Absurdly large finite widths would make
 * `String.repeat` throw `RangeError: Invalid string length`, so anything past
 * this cap is clamped instead of crashing the renderer.
 */
export const MAX_BAR_WIDTH = 200;

const FILLED_CHAR = '█';
const EMPTY_CHAR = '░';

/** Clamp a value into [0, 1]; non-finite input collapses to null (unknown). */
function clampFraction(fraction: number | undefined): number | null {
  if (typeof fraction !== 'number' || !Number.isFinite(fraction)) return null;
  return Math.max(0, Math.min(1, fraction));
}

/** Resolve the usable bar width, falling back to the default for degenerate values. */
function resolveWidth(width: number | undefined): number {
  if (typeof width !== 'number' || !Number.isFinite(width) || width < 1) {
    return DEFAULT_BAR_WIDTH;
  }
  return Math.min(Math.floor(width), MAX_BAR_WIDTH);
}

/**
 * Render a horizontal gauge bar of `width` cells (`█` filled / `░` empty),
 * fill = `round(clamped(fraction) * width)`. Plain text only — safe for
 * surfaces that do not interpret ANSI (e.g. OpenCode DialogSelect rows).
 * `undefined`/non-finite fractions render an all-empty placeholder bar.
 */
export function renderBarPlain(fraction: number | undefined, width?: number): string {
  const w = resolveWidth(width);
  const clamped = clampFraction(fraction);
  if (clamped === null) {
    return EMPTY_CHAR.repeat(w);
  }
  const filled = Math.round(clamped * w);
  return FILLED_CHAR.repeat(filled) + EMPTY_CHAR.repeat(w - filled);
}

/**
 * ANSI variant of {@link renderBarPlain}: identical output except
 * `undefined`/non-finite fractions render an all-dim placeholder bar.
 */
export function renderBar(fraction: number | undefined, width?: number): string {
  const clamped = clampFraction(fraction);
  if (clamped === null) {
    return `${ANSI.dim}${EMPTY_CHAR.repeat(resolveWidth(width))}${ANSI.reset}`;
  }
  return renderBarPlain(fraction, width);
}

/**
 * Supplementary color for a gauge bar / label:
 * ≥50% green · 20–50% yellow · <20% red · undefined dim.
 * Never load-bearing: the percent text stays readable without color.
 */
export function getBarColor(fraction: number | undefined): string {
  const clamped = clampFraction(fraction);
  if (clamped === null) return ANSI.dim;
  if (clamped >= 0.5) return ANSI.green;
  if (clamped >= 0.2) return ANSI.yellow;
  return ANSI.red;
}

/**
 * Plain percent label: known values render as `N%`, `undefined`/non-finite
 * renders bare `n/a` (never `0%`) — for ANSI-free surfaces.
 */
export function renderPercentPlain(fraction: number | undefined): string {
  const clamped = clampFraction(fraction);
  if (clamped === null) return "n/a";
  return `${Math.round(clamped * 100)}%`;
}

/**
 * Percent label for a remaining fraction; `undefined`/non-finite renders a
 * dim `n/a` (never `0%`). Known values stay uncolored so the text survives
 * terminals without ANSI support.
 */
export function renderPercent(fraction: number | undefined): string {
  const clamped = clampFraction(fraction);
  if (clamped === null) return `${ANSI.dim}n/a${ANSI.reset}`;
  return renderPercentPlain(fraction);
}
