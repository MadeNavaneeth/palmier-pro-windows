import { describe, expect, it } from 'vitest';
import { LatestRequestGate } from './latest-request';

describe('LatestRequestGate', () => {
  it('only accepts the newest request for the same consumer', () => {
    const gate = new LatestRequestGate<number>();
    const older = gate.begin(1);
    const newer = gate.begin(1);

    expect(gate.isCurrent(older)).toBe(false);
    expect(gate.isCurrent(newer)).toBe(true);
  });

  it('tracks different consumers independently', () => {
    const gate = new LatestRequestGate<number>();
    const firstWindow = gate.begin(1);
    gate.begin(2);

    expect(gate.isCurrent(firstWindow)).toBe(true);
  });

  it('invalidates work started for an older project snapshot', () => {
    const gate = new LatestRequestGate<number>();
    const request = gate.begin(1);

    gate.invalidateAll();

    expect(gate.isCurrent(request)).toBe(false);
  });
});
