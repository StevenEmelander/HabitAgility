/**
 * Parity tests for the habit-points math. The lambda and the front-end carry
 * intentional duplicates of `pointsForEntry`; these tests pin the contract on
 * both implementations so they don't drift silently.
 *
 * If you intentionally change the scoring math, update both files AND extend
 * the cases below to cover the new behavior.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_GOAL_POINTS, DEFAULT_POINT_STEP, POINT_STEPS } from '../app/scripts/constants.js';
import {
  canEditRetrospective,
  categoryPoints,
  clampSprintText,
  decimalsForStep,
  fmtPoints,
  fmtPointsForStep,
  goalForSprint,
  habitEarned as habitEarnedFront,
  isSprintInPlanning,
  pointStep,
  quantize,
  totalPoints,
} from '../app/scripts/scoring.js';
import { pointsForEntry as pointsForEntryServer } from '../infrastructure/lambdas/sync/scoring.js';

// ── Fixtures ──────────────────────────────────────────────────────────

const sprint = {
  id: 1,
  pointStep: 0.25,
  goalPoints: 10,
  habitDefinitions: [
    { id: 'b1', categoryId: 'c1', kind: 'boolean', scoring: { points: 1 } },
    { id: 'b2', categoryId: 'c1', kind: 'boolean', scoring: { points: 0.5 } },
    { id: 'c-bounded', categoryId: 'c2', kind: 'count', scoring: { pointsPerUnit: 0.5, dailyLimit: 4 } },
    { id: 'c-unlimited', categoryId: 'c2', kind: 'count', scoring: { pointsPerUnit: 0.25, dailyLimit: 0 } },
  ],
  categories: [{ id: 'c1' }, { id: 'c2' }],
};

const sprintWithIntegerStep = {
  id: 2,
  pointStep: 1,
  goalPoints: 10,
  habitDefinitions: [
    { id: 'b1', categoryId: 'c1', kind: 'boolean', scoring: { points: 2 } },
    { id: 'c1', categoryId: 'c1', kind: 'count', scoring: { pointsPerUnit: 1, dailyLimit: 5 } },
  ],
  categories: [{ id: 'c1' }],
};

// ── habitEarned (front-end) ───────────────────────────────────────────

describe('habitEarned', () => {
  it('returns 0 for null habit or scoring', () => {
    expect(habitEarnedFront(null, true)).toBe(0);
    expect(habitEarnedFront({ kind: 'boolean' }, true)).toBe(0);
  });

  it('boolean: returns scoring.points when truthy, else 0', () => {
    const h = { kind: 'boolean', scoring: { points: 1.5 } };
    expect(habitEarnedFront(h, true)).toBe(1.5);
    expect(habitEarnedFront(h, false)).toBe(0);
    expect(habitEarnedFront(h, undefined)).toBe(0);
  });

  it('count bounded: clamps at dailyLimit', () => {
    const h = { kind: 'count', scoring: { pointsPerUnit: 0.5, dailyLimit: 4 } };
    expect(habitEarnedFront(h, 3)).toBe(1.5);
    expect(habitEarnedFront(h, 4)).toBe(2);
    expect(habitEarnedFront(h, 99)).toBe(2); // clamped
    expect(habitEarnedFront(h, -5)).toBe(0); // floored at 0
  });

  it('count unlimited (dailyLimit=0): no upper clamp', () => {
    const h = { kind: 'count', scoring: { pointsPerUnit: 0.25, dailyLimit: 0 } };
    expect(habitEarnedFront(h, 0)).toBe(0);
    expect(habitEarnedFront(h, 100)).toBe(25);
    expect(habitEarnedFront(h, -3)).toBe(0);
  });
});

// ── totalPoints / categoryPoints (front-end) ──────────────────────────

describe('totalPoints', () => {
  it('sums across categories and habits', () => {
    const entry = {
      habitValuesById: {
        b1: true,
        b2: false,
        'c-bounded': 3, // 3 * 0.5 = 1.5
        'c-unlimited': 8, // 8 * 0.25 = 2.0
      },
    };
    // 1 + 0 + 1.5 + 2.0 = 4.5
    expect(totalPoints(entry, sprint)).toBe(4.5);
  });

  it('returns 0 when sprint has no categories', () => {
    expect(totalPoints({ habitValuesById: {} }, { habitDefinitions: [] })).toBe(0);
  });

  it('treats missing habit values as 0', () => {
    expect(totalPoints({ habitValuesById: { b1: true } }, sprint)).toBe(1);
  });
});

describe('categoryPoints', () => {
  it('only sums habits in the requested category', () => {
    const entry = { habitValuesById: { b1: true, 'c-bounded': 4 } };
    expect(categoryPoints(entry, sprint, 'c1')).toBe(1); // boolean only
    expect(categoryPoints(entry, sprint, 'c2')).toBe(2); // count habits only
  });
});

// ── lambda ↔ front-end parity ─────────────────────────────────────────

describe('pointsForEntry parity (lambda mirrors front-end)', () => {
  const cases = [
    { name: 'all-zero entry', entry: {}, sprint },
    {
      name: 'all-true booleans + bounded count maxed',
      entry: { b1: true, b2: true, 'c-bounded': 4 },
      sprint,
    },
    { name: 'unlimited count over typical limit', entry: { 'c-unlimited': 50 }, sprint },
    { name: 'mixed', entry: { b1: true, 'c-bounded': 2, 'c-unlimited': 5 }, sprint },
    { name: 'integer-step sprint', entry: { b1: true, c1: 3 }, sprint: sprintWithIntegerStep },
  ];

  for (const { name, entry, sprint: s } of cases) {
    it(`${name}: server === client`, () => {
      // Server fn takes (habitValuesById, sprint). Front-end's totalPoints expects an entry shape.
      const serverPts = pointsForEntryServer(entry, s);
      const clientPts = totalPoints({ habitValuesById: entry }, s);
      expect(serverPts).toBe(clientPts);
    });
  }
});

// ── Numeric helpers ───────────────────────────────────────────────────

describe('quantize', () => {
  it('snaps to 2-decimal grid (kills 0.1+0.2 float drift)', () => {
    expect(quantize(0.1 + 0.2)).toBe(0.3);
    expect(quantize(0.1 + 0.1 + 0.1)).toBe(0.3);
    expect(quantize(1 / 3)).toBe(0.33);
    expect(quantize(undefined)).toBe(0);
    expect(quantize('1.5')).toBe(1.5);
  });
});

describe('fmtPoints', () => {
  it('strips trailing zeros', () => {
    expect(fmtPoints(1)).toBe('1');
    expect(fmtPoints(1.0)).toBe('1');
    expect(fmtPoints(0.3)).toBe('0.3');
    expect(fmtPoints(1.25)).toBe('1.25');
    expect(fmtPoints(0.1 + 0.2)).toBe('0.3');
  });
});

describe('decimalsForStep', () => {
  it.each([
    [1, 0],
    [0.5, 1],
    [0.1, 1],
    [0.25, 2],
  ])('step %d → %d decimals', (step, decimals) => {
    expect(decimalsForStep(step)).toBe(decimals);
  });
});

describe('fmtPointsForStep', () => {
  it('keeps trailing zeros to match step precision', () => {
    expect(fmtPointsForStep(1, 1)).toBe('1');
    expect(fmtPointsForStep(1, 0.5)).toBe('1.0');
    expect(fmtPointsForStep(1, 0.25)).toBe('1.00');
    expect(fmtPointsForStep(1.5, 0.25)).toBe('1.50');
    expect(fmtPointsForStep(0.1 + 0.2, 0.1)).toBe('0.3');
  });
});

// ── Sprint accessors ─────────────────────────────────────────────────

describe('pointStep', () => {
  it('falls back to default when missing or invalid', () => {
    expect(pointStep(null)).toBe(DEFAULT_POINT_STEP);
    expect(pointStep({})).toBe(DEFAULT_POINT_STEP);
    expect(pointStep({ pointStep: 999 })).toBe(DEFAULT_POINT_STEP);
  });

  it('returns each allowed step verbatim', () => {
    for (const s of POINT_STEPS) {
      expect(pointStep({ pointStep: s })).toBe(s);
    }
  });
});

describe('goalForSprint', () => {
  it('falls back to default when missing or invalid', () => {
    expect(goalForSprint(null)).toBe(DEFAULT_GOAL_POINTS);
    expect(goalForSprint({})).toBe(DEFAULT_GOAL_POINTS);
    expect(goalForSprint({ goalPoints: -1 })).toBe(DEFAULT_GOAL_POINTS);
    expect(goalForSprint({ goalPoints: Number.NaN })).toBe(DEFAULT_GOAL_POINTS);
  });

  it('returns the sprint goal when set', () => {
    expect(goalForSprint({ goalPoints: 12 })).toBe(12);
    expect(goalForSprint({ goalPoints: 0 })).toBe(0);
    expect(goalForSprint({ goalPoints: 7.5 })).toBe(7.5);
  });
});

describe('canEditRetrospective', () => {
  const today = '2026-05-18';
  it('returns true for past sprints', () => {
    expect(canEditRetrospective({ startDate: '2026-04-01', endDate: '2026-04-14' }, today)).toBe(true);
  });

  it('returns true for the current sprint', () => {
    expect(canEditRetrospective({ startDate: '2026-05-12', endDate: '2026-05-25' }, today)).toBe(true);
  });

  it('returns true when today exactly equals startDate (first day)', () => {
    expect(canEditRetrospective({ startDate: today, endDate: '2026-05-31' }, today)).toBe(true);
  });

  it('returns false for upcoming sprints (startDate in the future)', () => {
    expect(canEditRetrospective({ startDate: '2026-06-01', endDate: '2026-06-14' }, today)).toBe(false);
  });

  it('returns false for null / undefined / missing startDate', () => {
    expect(canEditRetrospective(null, today)).toBe(false);
    expect(canEditRetrospective(undefined, today)).toBe(false);
    expect(canEditRetrospective({}, today)).toBe(false);
    expect(canEditRetrospective({ startDate: null }, today)).toBe(false);
  });
});

describe('clampSprintText', () => {
  it('returns empty string for null / undefined', () => {
    expect(clampSprintText(null, 10)).toBe('');
    expect(clampSprintText(undefined, 10)).toBe('');
  });

  it('trims leading and trailing whitespace', () => {
    expect(clampSprintText('  hello  ', 80)).toBe('hello');
    expect(clampSprintText('\n\ntext\n', 80)).toBe('text');
  });

  it('slices to max length', () => {
    expect(clampSprintText('abcdefghij', 5)).toBe('abcde');
  });

  it('preserves exact-max strings untouched', () => {
    expect(clampSprintText('abcde', 5)).toBe('abcde');
  });

  it('coerces non-strings via String()', () => {
    expect(clampSprintText(42, 80)).toBe('42');
  });

  it('handles empty / whitespace-only input', () => {
    expect(clampSprintText('', 80)).toBe('');
    expect(clampSprintText('   ', 80)).toBe('');
  });
});

describe('isSprintInPlanning', () => {
  it('null / undefined → false', () => {
    expect(isSprintInPlanning(null)).toBe(false);
    expect(isSprintInPlanning(undefined)).toBe(false);
  });

  it('sprint with no startDate → true', () => {
    expect(isSprintInPlanning({ id: 1, lengthDays: 14 })).toBe(true);
    expect(isSprintInPlanning({ id: 1, startDate: null, lengthDays: 14 })).toBe(true);
    expect(isSprintInPlanning({ id: 1, startDate: '', lengthDays: 14 })).toBe(true);
  });

  it('sprint with startDate → false (started)', () => {
    expect(isSprintInPlanning({ id: 1, startDate: '2026-05-19', endDate: '2026-06-01' })).toBe(false);
  });
});
