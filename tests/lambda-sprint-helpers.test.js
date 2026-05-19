/**
 * Tests for `infrastructure/lambdas/sync/sprint-helpers.js` — pure helpers
 * extracted from sprints.js so they're importable from tests without the
 * AWS SDK at the test runner's resolution scope.
 */

import { describe, expect, it } from 'vitest';
import {
  findCovering,
  safeGoalPoints,
  safeLengthDays,
  safePointStep,
  sprintItemToObject,
  sprintObjectToItem,
} from '../infrastructure/lambdas/sync/sprint-helpers.js';

// ── safeLengthDays ────────────────────────────────────────────────────

describe('safeLengthDays', () => {
  it('returns the fallback for non-finite input', () => {
    expect(safeLengthDays(Number.NaN)).toBe(14);
    expect(safeLengthDays(undefined)).toBe(14);
    expect(safeLengthDays(null)).toBe(14);
    expect(safeLengthDays('hello')).toBe(14);
    expect(safeLengthDays(Number.POSITIVE_INFINITY)).toBe(14);
  });
  it('honors the fallback argument', () => {
    expect(safeLengthDays(undefined, 7)).toBe(7);
    expect(safeLengthDays('bad', 21)).toBe(21);
  });
  it('rounds non-integer numerics', () => {
    expect(safeLengthDays(14.4)).toBe(14);
    expect(safeLengthDays(14.6)).toBe(15);
  });
  it('clamps to [1, 365]', () => {
    expect(safeLengthDays(0)).toBe(1);
    expect(safeLengthDays(-100)).toBe(1);
    expect(safeLengthDays(366)).toBe(365);
    expect(safeLengthDays(10_000)).toBe(365);
  });
  it('passes through valid in-range values', () => {
    expect(safeLengthDays(1)).toBe(1);
    expect(safeLengthDays(14)).toBe(14);
    expect(safeLengthDays(365)).toBe(365);
  });
  it('parses numeric strings', () => {
    expect(safeLengthDays('21')).toBe(21);
  });
});

// ── safeGoalPoints ────────────────────────────────────────────────────

describe('safeGoalPoints', () => {
  it('returns the default (10) for non-finite input', () => {
    expect(safeGoalPoints(Number.NaN)).toBe(10);
    expect(safeGoalPoints(undefined)).toBe(10);
    expect(safeGoalPoints(null)).toBe(10);
    expect(safeGoalPoints('hello')).toBe(10);
  });
  it('honors the fallback argument', () => {
    expect(safeGoalPoints(undefined, 25)).toBe(25);
    expect(safeGoalPoints(Number.NaN, 5)).toBe(5);
  });
  it('rejects negatives and falls back', () => {
    expect(safeGoalPoints(-1)).toBe(10);
    expect(safeGoalPoints(-1, 7)).toBe(7);
  });
  it('clamps absurdly large values to 10_000', () => {
    expect(safeGoalPoints(10001)).toBe(10000);
    expect(safeGoalPoints(1e9)).toBe(10000);
  });
  it('preserves valid in-range values', () => {
    expect(safeGoalPoints(0)).toBe(0);
    expect(safeGoalPoints(10)).toBe(10);
    expect(safeGoalPoints(0.25)).toBe(0.25);
    expect(safeGoalPoints(9999.5)).toBe(9999.5);
  });
  it('parses numeric strings', () => {
    expect(safeGoalPoints('15')).toBe(15);
  });
});

// ── safePointStep ─────────────────────────────────────────────────────

describe('safePointStep', () => {
  it('accepts canonical step values', () => {
    expect(safePointStep(0.1)).toBe(0.1);
    expect(safePointStep(0.25)).toBe(0.25);
    expect(safePointStep(0.5)).toBe(0.5);
    expect(safePointStep(1)).toBe(1);
  });
  it('accepts canonical values as numeric strings', () => {
    expect(safePointStep('0.5')).toBe(0.5);
    expect(safePointStep('1')).toBe(1);
  });
  it('rejects non-canonical values', () => {
    expect(safePointStep(0.2)).toBeUndefined();
    expect(safePointStep(0.75)).toBeUndefined();
    expect(safePointStep(2)).toBeUndefined();
    expect(safePointStep(0)).toBeUndefined();
  });
  it('rejects non-finite / non-numeric input', () => {
    expect(safePointStep(Number.NaN)).toBeUndefined();
    expect(safePointStep(undefined)).toBeUndefined();
    expect(safePointStep(null)).toBeUndefined();
    expect(safePointStep('hello')).toBeUndefined();
  });
});

// ── sprintObjectToItem / sprintItemToObject round-trips ───────────────

describe('sprint item-shape round-trips', () => {
  it('round-trips a fully-populated started sprint', () => {
    const sprint = {
      id: 7,
      startDate: '2026-05-01',
      endDate: '2026-05-14',
      lengthDays: 14,
      pointStep: 0.25,
      goalPoints: 12.5,
      name: 'Spring focus',
      description: 'Build a daily writing habit.',
      retrospective: 'It worked.',
      categories: [{ id: 'c1', label: 'WRITING', sortOrder: 1, accent: '#aabbcc' }],
      habitDefinitions: [
        { id: 'h1', categoryId: 'c1', label: 'Write', kind: 'boolean', scoring: { points: 1 } },
      ],
    };
    const item = sprintObjectToItem(sprint);
    const back = sprintItemToObject(item);
    expect(back.id).toBe(sprint.id);
    expect(back.startDate).toBe(sprint.startDate);
    expect(back.endDate).toBe(sprint.endDate);
    expect(back.lengthDays).toBe(sprint.lengthDays);
    expect(back.pointStep).toBe(sprint.pointStep);
    expect(back.goalPoints).toBe(sprint.goalPoints);
    expect(back.name).toBe(sprint.name);
    expect(back.description).toBe(sprint.description);
    expect(back.retrospective).toBe(sprint.retrospective);
    expect(back.categories).toEqual(sprint.categories);
    expect(back.habitDefinitions).toEqual(sprint.habitDefinitions);
  });

  it('round-trips a planning sprint (null dates, empty metadata)', () => {
    const sprint = {
      id: 1,
      startDate: null,
      endDate: null,
      lengthDays: 14,
      goalPoints: 10,
      name: '',
      description: '',
      retrospective: '',
      categories: [],
      habitDefinitions: [],
    };
    const item = sprintObjectToItem(sprint);
    expect(item.startDate).toBeUndefined();
    expect(item.endDate).toBeUndefined();
    expect(item.name).toBeUndefined();
    expect(item.description).toBeUndefined();
    expect(item.retrospective).toBeUndefined();
    expect(item.pointStep).toBeUndefined();
    const back = sprintItemToObject(item);
    expect(back.startDate).toBe(null);
    expect(back.endDate).toBe(null);
    expect(back.lengthDays).toBe(14);
    expect(back.goalPoints).toBe(10);
    expect(back.name).toBe('');
    expect(back.description).toBe('');
    expect(back.retrospective).toBe('');
    expect(back.categories).toEqual([]);
    expect(back.habitDefinitions).toEqual([]);
  });

  it('writes pointStep only when non-null', () => {
    const item = sprintObjectToItem({ id: 1, lengthDays: 14, goalPoints: 10, pointStep: undefined });
    expect(item.pointStep).toBeUndefined();
    const item2 = sprintObjectToItem({ id: 2, lengthDays: 14, goalPoints: 10, pointStep: 0.5 });
    expect(item2.pointStep).toEqual({ N: '0.5' });
  });

  it('clamps long metadata strings on write', () => {
    const longName = 'x'.repeat(200);
    const item = sprintObjectToItem({ id: 1, lengthDays: 14, goalPoints: 10, name: longName });
    expect(item.name.S.length).toBe(80); // SPRINT_NAME_MAX
  });

  it('returns default goalPoints when missing on read', () => {
    const back = sprintItemToObject({
      dateKey: { S: '1' },
      lengthDays: { N: '14' },
      bodyJson: { S: '{}' },
    });
    expect(back.goalPoints).toBe(10); // DEFAULT_GOAL_POINTS
  });
});

// ── findCovering ──────────────────────────────────────────────────────

describe('findCovering', () => {
  const started1 = { id: 1, startDate: '2026-05-01', endDate: '2026-05-14' };
  const started2 = { id: 2, startDate: '2026-05-15', endDate: '2026-05-28' };
  const planning = { id: 3, startDate: null, endDate: null, lengthDays: 14 };
  const planningOlder = { id: 1, startDate: null, endDate: null, lengthDays: 7 };

  it('returns null when no sprints exist', () => {
    expect(findCovering([], '2026-05-10')).toBe(null);
  });

  it('returns the started sprint whose range covers the date', () => {
    expect(findCovering([started1, started2], '2026-05-10')).toBe(started1);
    expect(findCovering([started1, started2], '2026-05-20')).toBe(started2);
  });

  it('matches inclusive bounds on startDate and endDate', () => {
    expect(findCovering([started1], '2026-05-01')).toBe(started1);
    expect(findCovering([started1], '2026-05-14')).toBe(started1);
  });

  it('returns null when no started sprint covers and no planning sprint exists', () => {
    expect(findCovering([started1, started2], '2026-06-01')).toBe(null);
  });

  it('falls back to the planning sprint when no started sprint covers', () => {
    expect(findCovering([started1, planning], '2026-06-01')).toBe(planning);
    expect(findCovering([planning], '2026-05-10')).toBe(planning);
  });

  it('prefers the started sprint over a planning sprint when both could match', () => {
    expect(findCovering([started1, planning], '2026-05-10')).toBe(started1);
  });

  it('returns the lowest-id planning sprint when multiple exist', () => {
    expect(findCovering([planning, planningOlder], '2026-06-01')).toBe(planningOlder);
  });

  it('tolerates sparse / falsy entries in the array', () => {
    expect(findCovering([null, undefined, started1], '2026-05-10')).toBe(started1);
    expect(findCovering([null, undefined], '2026-05-10')).toBe(null);
  });
});
