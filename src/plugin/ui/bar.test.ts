import { describe, it, expect } from 'vitest';
import { ANSI } from './ansi';
import { DEFAULT_BAR_WIDTH, getBarColor, renderBar, renderBarPlain, renderPercent, renderPercentPlain } from './bar';

describe('renderBar', () => {
  describe('default width', () => {
    it('renders a 10-char bar by default', () => {
      expect(renderBar(0.5)).toHaveLength(DEFAULT_BAR_WIDTH);
      expect(renderBar(0.5)).toBe('█████░░░░░');
    });

    it('renders an empty bar for fraction 0', () => {
      expect(renderBar(0)).toBe('░░░░░░░░░░');
    });

    it('renders a full bar for fraction 1', () => {
      expect(renderBar(1)).toBe('██████████');
    });

    it('rounds fill proportionally', () => {
      expect(renderBar(0.44)).toBe('████░░░░░░'); // round(4.4) = 4
      expect(renderBar(0.45)).toBe('█████░░░░░'); // round(4.5) = 5
      expect(renderBar(0.92)).toBe('█████████░'); // round(9.2) = 9
    });

    it('rounds 0.999 up to a full bar at the edge', () => {
      expect(renderBar(0.999)).toBe('██████████');
    });

    it('rounds tiny fractions down to an empty bar', () => {
      expect(renderBar(0.04)).toBe('░░░░░░░░░░'); // round(0.4) = 0
    });

    it('clamps out-of-range fractions', () => {
      expect(renderBar(1.5)).toBe('██████████');
      expect(renderBar(-0.5)).toBe('░░░░░░░░░░');
    });
  });

  describe('custom width', () => {
    it('honors the requested width', () => {
      expect(renderBar(0.5, 20)).toBe('██████████' + '░░░░░░░░░░');
      expect(renderBar(0.6, 5)).toBe('███░░');
    });

    it('falls back to the default width for width <= 0', () => {
      expect(renderBar(0.5, 0)).toHaveLength(DEFAULT_BAR_WIDTH);
      expect(renderBar(0.5, -3)).toHaveLength(DEFAULT_BAR_WIDTH);
    });

    it('falls back to the default width for non-finite width', () => {
      expect(renderBar(0.5, Number.NaN)).toHaveLength(DEFAULT_BAR_WIDTH);
      expect(renderBar(0.5, Number.POSITIVE_INFINITY)).toHaveLength(DEFAULT_BAR_WIDTH);
    });

    it('clamps absurdly large finite widths instead of throwing (P3 review fix)', () => {
      expect(() => renderBar(0.5, 1e10)).not.toThrow();
      expect(renderBar(0.5, 1e10)).toHaveLength(200);
      expect(renderBar(0, 1e10)).toHaveLength(200); // defined fraction → uncolored path
      expect(renderBar(1)).toHaveLength(DEFAULT_BAR_WIDTH); // unaffected default
    });
  });

  describe('undefined handling', () => {
    it('renders an all-dim placeholder bar for undefined', () => {
      expect(renderBar(undefined)).toBe(`${ANSI.dim}░░░░░░░░░░${ANSI.reset}`);
    });

    it('renders an all-dim placeholder bar for non-finite values (fail-open)', () => {
      expect(renderBar(Number.NaN, 4)).toBe(`${ANSI.dim}░░░░${ANSI.reset}`);
      expect(renderBar(Number.POSITIVE_INFINITY, 3)).toBe(`${ANSI.dim}░░░${ANSI.reset}`);
    });

    it('respects custom width for the placeholder bar', () => {
      expect(renderBar(undefined, 5)).toBe(`${ANSI.dim}░░░░░${ANSI.reset}`);
    });
  });
});

describe('renderBarPlain', () => {
  it('matches renderBar for known fractions (no ANSI anywhere)', () => {
    expect(renderBarPlain(0.5)).toBe(renderBar(0.5));
    expect(renderBarPlain(0.5)).toBe('█████░░░░░');
    expect(renderBarPlain(0)).toBe('░░░░░░░░░░');
    expect(renderBarPlain(1, 5)).toBe('█████');
    expect(renderBarPlain(0.999)).not.toContain('\x1b');
  });

  it('renders a bare placeholder bar for undefined — no dim codes', () => {
    const plain = renderBarPlain(undefined);
    expect(plain).toBe('░░░░░░░░░░');
    expect(plain).not.toContain(ANSI.dim);
    expect(plain).not.toContain(ANSI.reset);
  });
});

describe('renderPercentPlain', () => {
  it('renders bare percents and bare n/a', () => {
    expect(renderPercentPlain(0.45)).toBe('45%');
    expect(renderPercentPlain(undefined)).toBe('n/a');
    expect(renderPercentPlain(Number.NaN)).toBe('n/a');
    expect(renderPercentPlain(undefined)).not.toContain('\x1b');
  });

  it('agrees with the ANSI variant on known values', () => {
    for (const value of [0, 0.2, 0.5, 0.666, 1]) {
      expect(renderPercentPlain(value as number)).toBe(renderPercent(value as number));
    }
  });
});

describe('getBarColor', () => {
  it('returns green at exactly 50% and above', () => {
    expect(getBarColor(0.5)).toBe(ANSI.green);
    expect(getBarColor(0.75)).toBe(ANSI.green);
    expect(getBarColor(1)).toBe(ANSI.green);
  });

  it('returns yellow just below 50% down to exactly 20%', () => {
    expect(getBarColor(0.49)).toBe(ANSI.yellow);
    expect(getBarColor(0.2)).toBe(ANSI.yellow);
  });

  it('returns red strictly below 20%', () => {
    expect(getBarColor(0.19)).toBe(ANSI.red);
    expect(getBarColor(0)).toBe(ANSI.red);
  });

  it('returns dim for undefined and non-finite fractions', () => {
    expect(getBarColor(undefined)).toBe(ANSI.dim);
    expect(getBarColor(Number.NaN)).toBe(ANSI.dim);
  });

  it('clamps out-of-range fractions into thresholds', () => {
    expect(getBarColor(1.5)).toBe(ANSI.green);
    expect(getBarColor(-0.1)).toBe(ANSI.red);
  });
});

describe('renderPercent', () => {
  it('renders rounded percent for known fractions', () => {
    expect(renderPercent(0)).toBe('0%');
    expect(renderPercent(0.45)).toBe('45%');
    expect(renderPercent(0.666)).toBe('67%');
    expect(renderPercent(1)).toBe('100%');
  });

  it('renders a dim n/a for undefined — never "0%"', () => {
    const label = renderPercent(undefined);
    expect(label).not.toBe('0%');
    expect(label).toContain('n/a');
    expect(label).toContain(ANSI.dim);
    expect(label).toContain(ANSI.reset);
  });

  it('renders a dim n/a for non-finite values', () => {
    expect(renderPercent(Number.NaN)).toContain('n/a');
    expect(renderPercent(Number.POSITIVE_INFINITY)).toContain('n/a');
  });

  it('keeps known percentages uncolored so text stays readable without color', () => {
    expect(renderPercent(0.2)).not.toContain(ANSI.green);
    expect(renderPercent(0.2)).not.toContain(ANSI.reset);
  });

  it('clamps out-of-range fractions', () => {
    expect(renderPercent(1.5)).toBe('100%');
    expect(renderPercent(-0.5)).toBe('0%');
  });
});
