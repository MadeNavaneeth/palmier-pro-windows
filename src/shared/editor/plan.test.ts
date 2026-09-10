import { describe, expect, it } from 'vitest';
import {
  PLAN_MAX_STEPS,
  PLAN_STEP_MAX_CHARS,
  normalizePlan,
  planSummary,
} from './plan';

describe('normalizePlan (L3)', () => {
  it('keeps well-formed steps and defaults unknown statuses to pending', () => {
    expect(normalizePlan([
      { step: '  Trim the intro  ', status: 'completed' },
      { step: 'Add captions', status: 'in_progress' },
      { step: 'Export', status: 'whatever' },
    ])).toEqual([
      { step: 'Trim the intro', status: 'completed' },
      { step: 'Add captions', status: 'in_progress' },
      { step: 'Export', status: 'pending' },
    ]);
  });

  it('drops unusable entries and caps the list', () => {
    expect(normalizePlan([null, 7, { status: 'pending' }, { step: '   ' }])).toEqual([]);

    const many = Array.from({ length: PLAN_MAX_STEPS + 5 }, (_, index) => ({
      step: `step ${index}`,
      status: 'pending',
    }));
    expect(normalizePlan(many)).toHaveLength(PLAN_MAX_STEPS);
  });

  it('truncates an over-long step and collapses whitespace', () => {
    const [entry] = normalizePlan([{ step: 'a\n\n  lot   of\tspace' }]);
    expect(entry.step).toBe('a lot of space');

    const [long] = normalizePlan([{ step: 'x'.repeat(PLAN_STEP_MAX_CHARS + 20) }]);
    expect(long.step).toHaveLength(PLAN_STEP_MAX_CHARS);
  });

  it('allows at most one in_progress step', () => {
    const steps = normalizePlan([
      { step: 'one', status: 'in_progress' },
      { step: 'two', status: 'in_progress' },
    ]);
    expect(steps[0].status).toBe('in_progress');
    expect(steps[1].status).toBe('pending');
  });

  it('returns an empty plan for junk input', () => {
    expect(normalizePlan(undefined)).toEqual([]);
    expect(normalizePlan('nope')).toEqual([]);
    expect(normalizePlan({})).toEqual([]);
  });
});

describe('planSummary (L3)', () => {
  it('summarizes progress and the active step', () => {
    expect(planSummary([])).toBe('Plan cleared.');
    expect(planSummary([
      { step: 'a', status: 'completed' },
      { step: 'b', status: 'in_progress' },
      { step: 'c', status: 'pending' },
    ])).toBe('1/3 done — now: b');
    expect(planSummary([{ step: 'a', status: 'completed' }])).toBe('1/1 done');
  });
});
