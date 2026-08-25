import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { ANSI } from './ansi';
import { getBarColor } from './bar';
import {
  MICRO_LAYOUT_MAX_COLUMNS,
  buildGaugeDetailOptions,
  getDetailMode,
  mapDetailKeybind,
  resolveDetailLayout,
  setDetailMode,
  terminalWidth,
  toggleDetailMode,
  type DetailViewMode,
} from './gauge-detail';
import type { GaugeWindowSummary } from './gauge-cards';

const NOW = 1_800_000_000_000;

function iso(msFromNow: number): string {
  return new Date(NOW + msFromNow).toISOString();
}

function summary(overrides: Partial<GaugeWindowSummary> = {}): GaugeWindowSummary {
  return {
    fetchedAt: NOW - 30_000,
    byGroup: {
      gemini: { weekly: { remainingFraction: 0.45 }, fiveHour: { remainingFraction: 0.92 } },
      '3p': { weekly: { remainingFraction: 0.18, resetTime: iso(2 * 86400_000) }, fiveHour: { remainingFraction: 1 } },
    },
    ...overrides,
  };
}

const ORIGINAL_STDOUT = process.stdout;

beforeEach(() => {
  setDetailMode('gauge');
  // Deterministic terminal geometry: wide enough for the full layout so
  // default-path tests never depend on the host environment's columns.
  Object.defineProperty(process, 'stdout', { configurable: true, value: { ...ORIGINAL_STDOUT, columns: 100 } });
});

afterEach(() => {
  Object.defineProperty(process, 'stdout', { configurable: true, value: ORIGINAL_STDOUT });
  vi.useRealTimers();
});

describe('resolveDetailLayout', () => {
  it('uses micro at or below the threshold', () => {
    expect(resolveDetailLayout(MICRO_LAYOUT_MAX_COLUMNS)).toBe('micro');
    expect(resolveDetailLayout(40)).toBe('micro');
  });

  it('uses full above the threshold', () => {
    expect(resolveDetailLayout(MICRO_LAYOUT_MAX_COLUMNS + 1)).toBe('full');
    expect(resolveDetailLayout(120)).toBe('full');
  });

  it('fails open to full for unmeasurable widths', () => {
    expect(resolveDetailLayout(undefined)).toBe('full');
    expect(resolveDetailLayout(Number.NaN)).toBe('full');
    expect(resolveDetailLayout(0)).toBe('full');
    expect(resolveDetailLayout(-1)).toBe('full');
  });
});

describe('detail view toggle', () => {
  it('defaults to gauge mode', () => {
    expect(getDetailMode()).toBe('gauge');
  });

  it('flips between gauge and table', () => {
    expect(toggleDetailMode()).toBe('table');
    expect(getDetailMode()).toBe('table');
    expect(toggleDetailMode()).toBe('gauge');
  });

  it('accepts an explicit current mode and still updates the shared one', () => {
    expect(toggleDetailMode('gauge')).toBe('table');
    expect(getDetailMode()).toBe('table');
    // Shared state was flipped too — a single code path keeps [T] consistent.
    expect(toggleDetailMode('table')).toBe('gauge');
    expect(getDetailMode()).toBe('gauge');
  });

  it('ignores invalid stored modes via setDetailMode', () => {
    setDetailMode('table' as DetailViewMode);
    expect(getDetailMode()).toBe('table');
    setDetailMode(undefined as unknown as DetailViewMode);
    expect(getDetailMode()).toBe('gauge');
  });
});

describe('mapDetailKeybind', () => {
  it('maps T to toggle-mode', () => {
    expect(mapDetailKeybind('toggle-view')).toBe('toggle-mode');
  });

  it('returns null for every other key', () => {
    expect(mapDetailKeybind('refresh')).toBe(null);
    expect(mapDetailKeybind('left')).toBe(null);
    expect(mapDetailKeybind('enter')).toBe(null);
    expect(mapDetailKeybind(null)).toBe(null);
  });
});

describe('terminalWidth', () => {
  it('passes through measurable columns', () => {
    Object.defineProperty(process, 'stdout', { configurable: true, value: { columns: 55 } });
    expect(terminalWidth()).toBe(55);
  });

  it('fails open to undefined when columns are missing or invalid', () => {
    Object.defineProperty(process, 'stdout', { configurable: true, value: {} });
    expect(terminalWidth()).toBeUndefined();
    Object.defineProperty(process, 'stdout', { configurable: true, value: { columns: Number.NaN } });
    expect(terminalWidth()).toBeUndefined();
  });

  it('feeds the default layout: no width + narrow terminal → micro', () => {
    Object.defineProperty(process, 'stdout', { configurable: true, value: { columns: 40 } });
    const rows = buildGaugeDetailOptions({ quotaSummary: summary() }, { now: NOW });
    expect(rows.some((row) => row.value === 'wld:micro:gemini')).toBe(true);
  });

  it('feeds the default layout: unmeasurable terminal → full (fail-open)', () => {
    Object.defineProperty(process, 'stdout', { configurable: true, value: {} });
    const rows = buildGaugeDetailOptions({ quotaSummary: summary() }, { now: NOW });
    expect(rows.some((row) => row.value === 'wld:gemini:weekly')).toBe(true);
  });
});

describe('buildGaugeDetailOptions — width-driven layout default (P1-3)', () => {
  const account = { quotaSummary: summary() };

  it('activates the micro variant automatically at narrow widths', () => {
    const rows = buildGaugeDetailOptions(account, { now: NOW, width: MICRO_LAYOUT_MAX_COLUMNS - 10 });
    expect(rows.some((row) => row.value === 'wld:micro:gemini')).toBe(true);
    expect(rows.every((row) => row.title.includes('█'))).toBe(false);
  });

  it('keeps the full layout on wide or unmeasurable terminals', () => {
    for (const width of [MICRO_LAYOUT_MAX_COLUMNS + 1, undefined]) {
      const rows = buildGaugeDetailOptions(account, { now: NOW, width });
      expect(rows.some((row) => row.value === 'wld:gemini:weekly')).toBe(true);
      expect(rows.some((row) => row.value === 'wld:micro:gemini')).toBe(false);
    }
  });

  it('an explicit layout override still wins over width', () => {
    const rows = buildGaugeDetailOptions(account, { now: NOW, width: 40, layout: 'full' });
    expect(rows.some((row) => row.value === 'wld:micro:gemini')).toBe(false);
  });
});

describe('buildGaugeDetailOptions — gauge mode (full)', () => {
  const rows = buildGaugeDetailOptions(
    {
      quotaSummary: summary(),
      cachedQuota: { claude: { remainingFraction: 0.42, resetTime: iso(7_200_000) } },
      cachedQuotaUpdatedAt: NOW - 300_000,
    },
    { now: NOW },
  );

  it('leads with a freshness header from fetchedAt', () => {
    expect(rows[0]?.title).toBe('Window limits · updated 30s ago');
    expect(rows[0]?.category).toBe('Window Limits');
  });

  it('renders a header plus one line per window with bars and percents', () => {
    const titles = rows.map((row) => row.title);
    expect(titles).toContain('Gemini Models');
    expect(titles).toContain('Weekly  █████░░░░░ 45%');
    expect(titles).toContain('5-hour  █████████░ 92%');
    expect(titles).toContain('Claude & GPT');
    expect(titles).toContain('Weekly  ██░░░░░░░░ 18% LOW resets 2d 0h');
  });

  it('renders legacy cached-quota rows AFTER window data under their own category', () => {
    const categories = rows.map((row) => row.category);
    expect(categories.indexOf('Model quota (legacy)')).toBeGreaterThan(categories.lastIndexOf('Window Limits'));
    const legacy = rows.find((row) => row.value === 'wld:legacy:claude');
    expect(legacy?.title).toContain('Claude: 42%');
    expect(legacy?.title).toMatch(/resets 2h/);
    expect(legacy?.description).toContain('Updated 5m ago');
  });

  it('keeps taxonomies separate: legacy rows never carry window-group headers', () => {
    const legacyTitles = rows.filter((row) => row.category === 'Model quota (legacy)').map((row) => row.title);
    expect(legacyTitles.length).toBeGreaterThan(0);
    for (const title of legacyTitles) {
      expect(title).not.toContain('Gemini Models');
      expect(title).not.toContain('Claude & GPT');
    }
  });

  it('stays ANSI-free without the color flag', () => {
    for (const row of rows) {
      expect(row.title).not.toContain('\x1b');
      expect(row.description ?? '').not.toContain('\x1b');
    }
  });
});

describe('buildGaugeDetailOptions — color flag', () => {
  const account = { quotaSummary: summary() };
  const colored = buildGaugeDetailOptions(account, { now: NOW, color: true });
  const plain = buildGaugeDetailOptions(account, { now: NOW, color: false });

  it('tints bars using getBarColor thresholds while keeping percents readable', () => {
    const weekly = colored.find((row) => row.value === 'wld:gemini:weekly');
    expect(weekly?.title).toContain(`${getBarColor(0.45)}█████░░░░░${ANSI.reset}`);
    expect(weekly?.title).toContain('45%');
    const low = colored.find((row) => row.value === 'wld:3p:weekly');
    expect(low?.title).toContain(`${getBarColor(0.18)}██░░░░░░░░${ANSI.reset}`);
    expect(low?.title).toContain(`${ANSI.red}LOW${ANSI.reset}`);
  });

  it('dims placeholder metadata in color mode', () => {
    const missing = buildGaugeDetailOptions({}, { now: NOW, color: true });
    expect(missing[0]?.title).toContain(ANSI.dim);
    expect(missing[0]?.title).toContain('— no quota yet —');
  });

  it('produces identical visible characters with and without color', () => {
    const strip = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, '');
    expect(colored.map((row) => strip(row.title))).toEqual(plain.map((row) => row.title));
  });
});

describe('buildGaugeDetailOptions — table view ([T])', () => {
  const rows = buildGaugeDetailOptions({ quotaSummary: summary() }, { now: NOW, mode: 'table' });

  it('drops bars but keeps percent, LOW, and resets', () => {
    const weekly = rows.find((row) => row.value === 'wld:gemini:weekly');
    expect(weekly?.title).toBe('Weekly   45%');
    const low = rows.find((row) => row.value === 'wld:3p:weekly');
    expect(low?.title).toBe('Weekly   18% LOW resets 2d 0h');
    for (const row of rows) {
      expect(row.title).not.toContain('█');
      expect(row.title).not.toContain('░');
    }
  });

  it('is used automatically when the shared mode is toggled first', () => {
    setDetailMode('table');
    const rowsAuto = buildGaugeDetailOptions({ quotaSummary: summary() }, { now: NOW });
    expect(rowsAuto.find((row) => row.value === 'wld:gemini:fiveHour')?.title).toBe('5-hour   92%');
  });
});

describe('buildGaugeDetailOptions — micro layout', () => {
  const rows = buildGaugeDetailOptions({ quotaSummary: summary() }, { now: NOW, layout: 'micro' });

  it('collapses each group into one compact line without bars or resets', () => {
    expect(rows.map((row) => row.title)).toEqual([
      'Window limits · updated 30s ago',
      'Gemini Models  Wk 45% · 5h 92%',
      'Claude & GPT  Wk 18%! · 5h 100%',
    ]);
    for (const row of rows) {
      expect(row.title).not.toContain('█');
      expect(row.title).not.toContain('resets');
    }
  });
});

describe('buildGaugeDetailOptions — fail-open', () => {
  it('renders a placeholder (never 0%) for missing or invalid summaries', () => {
    for (const quotaSummary of [undefined, {}, { fetchedAt: Number.NaN }, { byGroup: {} }] as const) {
      const rows = buildGaugeDetailOptions({ quotaSummary }, { now: NOW });
      const windowRows = rows.filter((row) => row.category === 'Window Limits');
      expect(windowRows).toHaveLength(1);
      expect(windowRows[0]?.title).toContain('— no quota yet —');
      expect(JSON.stringify(rows)).not.toContain('0%');
    }
  });

  it('skips unknown group keys entirely', () => {
    const quotaSummary = {
      fetchedAt: NOW,
      byGroup: { claude: { weekly: { remainingFraction: 0.9 } } },
    } as unknown as GaugeWindowSummary;
    const rows = buildGaugeDetailOptions({ quotaSummary }, { now: NOW });
    expect(rows).toHaveLength(1); // freshness only — no groups rendered
  });

  it('co-displays legacy data even when the summary is missing', () => {
    const rows = buildGaugeDetailOptions(
      { cachedQuota: { 'gemini-pro': { remainingFraction: 0.67 } } },
      { now: NOW },
    );
    expect(rows[0]?.title).toContain('— no quota yet —');
    expect(rows.some((row) => row.value === 'wld:legacy:gemini-pro' && row.title.includes('Gemini Pro: 67%'))).toBe(true);
  });

  it('honors includeLegacy:false for hosts with their own legacy section', () => {
    const rows = buildGaugeDetailOptions(
      { quotaSummary: summary(), cachedQuota: { claude: { remainingFraction: 0.4 } } },
      { now: NOW, includeLegacy: false },
    );
    expect(rows.some((row) => row.category === 'Model quota (legacy)')).toBe(false);
  });

  it('renders n/a — never 0% — for windows with unknown fraction', () => {
    const rows = buildGaugeDetailOptions(
      { quotaSummary: { fetchedAt: NOW, byGroup: { gemini: { weekly: {} } } } },
      { now: NOW, layout: 'micro' },
    );
    const micro = rows.find((row) => row.value === 'wld:micro:gemini');
    expect(micro?.title).toContain('Wk n/a');
  });
});

describe('freshness uses the injected clock', () => {
  it('derives ages from Date.now() under fake timers', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const rows = buildGaugeDetailOptions({ quotaSummary: { fetchedAt: NOW - 90_000 } }, { now: Date.now() });
    // formatWaitShort renders minute-granularity as "1m" (seconds dropped).
    expect(rows[0]?.title).toBe('Window limits · updated 1m ago');
  });

  it('keeps seconds precision under one minute', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const rows = buildGaugeDetailOptions({ quotaSummary: { fetchedAt: NOW - 30_000 } }, { now: Date.now() });
    expect(rows[0]?.title).toBe('Window limits · updated 30s ago');
  });
});
