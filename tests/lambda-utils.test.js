/**
 * Tests for `infrastructure/lambdas/sync/utils.js` — pure helpers only
 * (no AWS SDK imports in utils.js, so this loads cleanly from tests/).
 */

import { describe, expect, it } from 'vitest';
import {
  addDays,
  clampText,
  clampToToday,
  daysBetweenInclusive,
  isValidDateKey,
  isValidSprintId,
  parseSprintIdParam,
  quantize,
  safeJsonParseObject,
  todayKey,
} from '../infrastructure/lambdas/sync/utils.js';

describe('addDays', () => {
  it('adds positive days', () => {
    expect(addDays('2026-05-01', 1)).toBe('2026-05-02');
    expect(addDays('2026-05-01', 30)).toBe('2026-05-31');
  });
  it('handles month boundary', () => {
    expect(addDays('2026-05-31', 1)).toBe('2026-06-01');
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
  });
  it('handles year boundary', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
  it('handles negative days', () => {
    expect(addDays('2026-05-01', -1)).toBe('2026-04-30');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
  });
  it('zero days is a no-op', () => {
    expect(addDays('2026-05-19', 0)).toBe('2026-05-19');
  });
});

describe('daysBetweenInclusive', () => {
  it('same day = 1', () => {
    expect(daysBetweenInclusive('2026-05-19', '2026-05-19')).toBe(1);
  });
  it('one-day diff = 2', () => {
    expect(daysBetweenInclusive('2026-05-19', '2026-05-20')).toBe(2);
  });
  it('14-day sprint', () => {
    expect(daysBetweenInclusive('2026-05-19', '2026-06-01')).toBe(14);
  });
  it('handles month-boundary crossings', () => {
    expect(daysBetweenInclusive('2026-01-15', '2026-02-15')).toBe(32);
  });
});

describe('clampToToday', () => {
  it('passes through dates ≤ today', () => {
    expect(clampToToday('1999-01-01')).toBe('1999-01-01');
  });
  it('clamps future dates to today', () => {
    const t = todayKey();
    const future = addDays(t, 30);
    expect(clampToToday(future)).toBe(t);
  });
  it('today passes through unchanged', () => {
    const t = todayKey();
    expect(clampToToday(t)).toBe(t);
  });
});

describe('quantize', () => {
  it('rounds to 2 decimals', () => {
    expect(quantize(1.235)).toBe(1.24);
    expect(quantize(1.234)).toBe(1.23);
  });
  it('eliminates JS float drift', () => {
    expect(quantize(0.1 + 0.2)).toBe(0.3);
  });
  it('coerces non-numbers to 0', () => {
    expect(quantize(null)).toBe(0);
    expect(quantize('hello')).toBe(0);
    expect(quantize(undefined)).toBe(0);
  });
  it('preserves zero and negative', () => {
    expect(quantize(0)).toBe(0);
    expect(quantize(-1.5)).toBe(-1.5);
  });
});

describe('clampText', () => {
  it('returns empty string for null / undefined', () => {
    expect(clampText(null, 10)).toBe('');
    expect(clampText(undefined, 10)).toBe('');
  });
  it('trims whitespace and slices to max', () => {
    expect(clampText('  hello  ', 80)).toBe('hello');
    expect(clampText('abcdefghij', 5)).toBe('abcde');
  });
  it('preserves exact-max length untouched', () => {
    expect(clampText('abcde', 5)).toBe('abcde');
  });
  it('coerces non-strings via String()', () => {
    expect(clampText(42, 80)).toBe('42');
    expect(clampText(true, 80)).toBe('true');
  });
});

describe('safeJsonParseObject', () => {
  it('returns {} for empty / undefined / null input', () => {
    expect(safeJsonParseObject('')).toEqual({});
    expect(safeJsonParseObject(undefined)).toEqual({});
    expect(safeJsonParseObject(null)).toEqual({});
  });
  it('returns {} for invalid JSON', () => {
    expect(safeJsonParseObject('not json')).toEqual({});
    expect(safeJsonParseObject('{bad')).toEqual({});
  });
  it('returns {} for valid non-object JSON', () => {
    expect(safeJsonParseObject('"string"')).toEqual({});
    expect(safeJsonParseObject('42')).toEqual({});
    expect(safeJsonParseObject('[]')).toEqual({});
    expect(safeJsonParseObject('null')).toEqual({});
  });
  it('parses object JSON', () => {
    expect(safeJsonParseObject('{"a":1}')).toEqual({ a: 1 });
    expect(safeJsonParseObject('{"nested":{"x":2}}')).toEqual({ nested: { x: 2 } });
  });
});

describe('isValidDateKey', () => {
  it('accepts YYYY-MM-DD', () => {
    expect(isValidDateKey('2026-05-19')).toBe(true);
    expect(isValidDateKey('1999-01-01')).toBe(true);
    expect(isValidDateKey('2099-12-31')).toBe(true);
  });
  it('rejects malformed strings', () => {
    expect(isValidDateKey('2026-5-19')).toBe(false);
    expect(isValidDateKey('26-05-19')).toBe(false);
    expect(isValidDateKey('2026/05/19')).toBe(false);
    expect(isValidDateKey('not-a-date')).toBe(false);
    expect(isValidDateKey('')).toBe(false);
  });
  it('rejects non-strings', () => {
    expect(isValidDateKey(null)).toBe(false);
    expect(isValidDateKey(undefined)).toBe(false);
    expect(isValidDateKey(20260519)).toBe(false);
    expect(isValidDateKey({})).toBe(false);
  });
});

describe('isValidSprintId', () => {
  it('accepts positive integers', () => {
    expect(isValidSprintId(1)).toBe(true);
    expect(isValidSprintId(100)).toBe(true);
    expect(isValidSprintId(99999)).toBe(true);
  });
  it('rejects 0, negative, non-integers', () => {
    expect(isValidSprintId(0)).toBe(false);
    expect(isValidSprintId(-1)).toBe(false);
    expect(isValidSprintId(1.5)).toBe(false);
    expect(isValidSprintId(Number.NaN)).toBe(false);
  });
  it('rejects non-numbers', () => {
    expect(isValidSprintId('1')).toBe(false);
    expect(isValidSprintId(null)).toBe(false);
    expect(isValidSprintId(undefined)).toBe(false);
  });
});

describe('parseSprintIdParam', () => {
  it('parses valid numeric strings', () => {
    expect(parseSprintIdParam('1')).toBe(1);
    expect(parseSprintIdParam('42')).toBe(42);
  });
  it('returns null for non-numeric / invalid', () => {
    expect(parseSprintIdParam('abc')).toBe(null);
    expect(parseSprintIdParam('')).toBe(null);
    expect(parseSprintIdParam('0')).toBe(null);
    expect(parseSprintIdParam('-1')).toBe(null);
    expect(parseSprintIdParam('1.5')).toBe(null);
  });
});

describe('todayKey', () => {
  it('returns a valid YYYY-MM-DD string', () => {
    const t = todayKey();
    expect(isValidDateKey(t)).toBe(true);
  });
  it('is idempotent within a single tick', () => {
    expect(todayKey()).toBe(todayKey());
  });
});
