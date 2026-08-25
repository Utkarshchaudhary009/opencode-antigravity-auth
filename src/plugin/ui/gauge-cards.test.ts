import { describe, it, expect } from 'vitest';
import {
  LOW_THRESHOLD,
  buildWindowLimitOptions,
  formatGroupGaugeLine,
  mapAccountsKeybind,
  nextAccountIndex,
  type GaugeWindowSummary,
} from './gauge-cards';

const NOW = 1_800_000_000_000;

function iso(msFromNow: number): string {
  return new Date(NOW + msFromNow).toISOString();
}

describe('mapAccountsKeybind', () => {
  it('maps R to refresh-account', () => {
    expect(mapAccountsKeybind('refresh')).toBe('refresh-account');
  });

  it('maps arrows to account switching', () => {
    expect(mapAccountsKeybind('left')).toBe('account-prev');
    expect(mapAccountsKeybind('right')).toBe('account-next');
  });

  it('returns null for navigation and unknown keys', () => {
    expect(mapAccountsKeybind('up')).toBe(null);
    expect(mapAccountsKeybind('down')).toBe(null);
    expect(mapAccountsKeybind('enter')).toBe(null);
    expect(mapAccountsKeybind('escape')).toBe(null);
    expect(mapAccountsKeybind('escape-start')).toBe(null);
    expect(mapAccountsKeybind(null)).toBe(null);
  });
});

describe('nextAccountIndex', () => {
  it('moves forward with wrap-around', () => {
    expect(nextAccountIndex(0, 3, 1)).toBe(1);
    expect(nextAccountIndex(2, 3, 1)).toBe(0);
  });

  it('moves backward with wrap-around', () => {
    expect(nextAccountIndex(1, 3, -1)).toBe(0);
    expect(nextAccountIndex(0, 3, -1)).toBe(2);
  });

  it('stays put for a single account', () => {
    expect(nextAccountIndex(0, 1, 1)).toBe(0);
    expect(nextAccountIndex(0, 1, -1)).toBe(0);
  });

  it('clamps an out-of-range active index before moving', () => {
    expect(nextAccountIndex(9, 3, 1)).toBe(0); // clamps to last (2), then wraps forward
    expect(nextAccountIndex(-5, 3, -1)).toBe(2); // clamps to first (0), then wraps backward
  });

  it('fails open to index 0 for degenerate input', () => {
    expect(nextAccountIndex(Number.NaN, 0, 1)).toBe(0);
  });
});

describe('formatGroupGaugeLine', () => {
  it('renders both windows with bars and percents', () => {
    const line = formatGroupGaugeLine(
      { weekly: { remainingFraction: 0.45 }, fiveHour: { remainingFraction: 0.92 } },
      NOW,
    );
    expect(line).toContain('Wk █████░░░░░ 45%');
    expect(line).toContain('5h █████████░ 92%');
    expect(line).toContain(' · ');
  });

  it('renders n/a — never 0% — for missing buckets', () => {
    const line = formatGroupGaugeLine({}, NOW);
    expect(line).toContain('n/a');
    expect(line).not.toContain('0%');
  });

  it('flags LOW below the threshold only', () => {
    const low = formatGroupGaugeLine({ weekly: { remainingFraction: LOW_THRESHOLD - 0.01 } }, NOW);
    const boundary = formatGroupGaugeLine({ weekly: { remainingFraction: LOW_THRESHOLD } }, NOW);
    expect(low).toContain('LOW');
    expect(boundary).not.toContain('LOW');
  });

  it('treats a real 0% as data (empty bar + LOW), distinct from n/a', () => {
    const line = formatGroupGaugeLine({ weekly: { remainingFraction: 0 } }, NOW);
    const [weeklyCell] = line.split(' · ');
    expect(weeklyCell).toBe('Wk ░░░░░░░░░░ 0% LOW');
    expect(weeklyCell).not.toContain('n/a');
  });

  it('appends relative reset time for future resets', () => {
    const line = formatGroupGaugeLine(
      { weekly: { remainingFraction: 0.5, resetTime: iso(2 * 86400_000) } },
      NOW,
    );
    expect(line).toMatch(/Wk █████░░░░░ 50% resets 2d \d+h/);
  });

  it('marks elapsed resets as resetting and skips invalid dates', () => {
    const past = formatGroupGaugeLine({ weekly: { remainingFraction: 0.5, resetTime: iso(-1000) } }, NOW);
    expect(past).toContain('resetting');
    const invalid = formatGroupGaugeLine({ weekly: { remainingFraction: 0.5, resetTime: 'not-a-date' } }, NOW);
    expect(invalid).not.toContain('resetting');
    expect(invalid).not.toContain('resets');
  });
});

describe('buildWindowLimitOptions', () => {
  it('returns a placeholder row when the account has no summary', () => {
    const options = buildWindowLimitOptions(undefined, NOW);
    expect(options).toHaveLength(1);
    expect(options[0]?.title).toBe('— no quota yet —');
    expect(options[0]?.category).toBe('Window Limits');
    expect(JSON.stringify(options)).not.toContain('0%');
  });

  it('returns a placeholder row when fetchedAt is missing or invalid', () => {
    const missing: GaugeWindowSummary = { byGroup: {} };
    const invalid: GaugeWindowSummary = { byGroup: {}, fetchedAt: Number.NaN };
    for (const quotaSummary of [missing, invalid]) {
      const options = buildWindowLimitOptions({ quotaSummary }, NOW);
      expect(options[0]?.title).toBe('— no quota yet —');
    }
  });

  it('returns a placeholder row when no known group buckets are present', () => {
    const options = buildWindowLimitOptions({ quotaSummary: { byGroup: {}, fetchedAt: NOW } }, NOW);
    expect(options).toHaveLength(1);
    expect(options[0]?.title).toBe('— no quota yet —');
    expect(options[0]?.value).toContain('nobuckets');
  });

  it('renders one compact gauge line per reported group', () => {
    const options = buildWindowLimitOptions(
      {
        quotaSummary: {
          fetchedAt: NOW,
          byGroup: {
            gemini: { weekly: { remainingFraction: 0.45 }, fiveHour: { remainingFraction: 0.92 } },
            '3p': { weekly: { remainingFraction: 0.18 } },
          },
        },
      },
      NOW,
    );
    expect(options).toHaveLength(2);
    expect(options[0]?.title).toContain('Gemini Models');
    expect(options[0]?.title).toContain('45%');
    expect(options[0]?.title).toContain('92%');
    expect(options[1]?.title).toContain('Claude & GPT');
    expect(options[1]?.title).toContain('18%');
    expect(options[1]?.title).toContain('LOW');
    for (const option of options) {
      expect(option.category).toBe('Window Limits');
    }
  });

  it('ignores unknown group keys (window taxonomy is gemini|3p only)', () => {
    const quotaSummary = {
      fetchedAt: NOW,
      byGroup: {
        gemini: { weekly: { remainingFraction: 0.75 } },
        claude: { weekly: { remainingFraction: 0.5 } },
      },
    } as unknown as GaugeWindowSummary;
    const options = buildWindowLimitOptions({ quotaSummary }, NOW);
    expect(options).toHaveLength(1);
    expect(options[0]?.title).toContain('Gemini Models');
  });

  it('shows freshness relative to the injected now', () => {
    const options = buildWindowLimitOptions(
      {
        quotaSummary: {
          fetchedAt: NOW - 120_000,
          byGroup: { gemini: { weekly: { remainingFraction: 0.5 } } },
        },
      },
      NOW,
    );
    expect(options[0]?.description).toBe('Updated 2m ago');
  });
});
