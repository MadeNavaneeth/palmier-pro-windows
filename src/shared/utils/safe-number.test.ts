import { describe, it, expect } from 'vitest';
import {
  MAX_FRAME,
  isFiniteNumber,
  safeInt,
  clampNumber,
  clampFrame,
  asValidFrame,
  clampDimension,
} from './safe-number';

describe('safe-number', () => {
  it('isFiniteNumber rejects NaN/Infinity/non-numbers', () => {
    expect(isFiniteNumber(5)).toBe(true);
    expect(isFiniteNumber(0)).toBe(true);
    expect(isFiniteNumber(NaN)).toBe(false);
    expect(isFiniteNumber(Infinity)).toBe(false);
    expect(isFiniteNumber(-Infinity)).toBe(false);
    expect(isFiniteNumber('5')).toBe(false);
    expect(isFiniteNumber(null)).toBe(false);
    expect(isFiniteNumber(undefined)).toBe(false);
  });

  it('safeInt truncates and falls back on bad input', () => {
    expect(safeInt(5.9)).toBe(5);
    expect(safeInt(-3.2)).toBe(-3);
    expect(safeInt(NaN)).toBe(0);
    expect(safeInt(Infinity)).toBe(0);
    expect(safeInt(1e19)).toBe(0); // beyond MAX_SAFE_INTEGER → fallback
    expect(safeInt(NaN, -1)).toBe(-1);
  });

  it('clampNumber clamps in the float domain', () => {
    expect(clampNumber(5, 0, 10)).toBe(5);
    expect(clampNumber(-5, 0, 10)).toBe(0);
    expect(clampNumber(50, 0, 10)).toBe(10);
    expect(clampNumber(NaN, 0, 10)).toBe(0);
    expect(clampNumber(Infinity, 0, 10)).toBe(10);
  });

  it('clampFrame is the canonical overflow guard (upstream #200)', () => {
    // The exact repro from the upstream crash report: startFrame = 1e19
    expect(clampFrame(1e19)).toBe(MAX_FRAME);
    expect(clampFrame(Infinity)).toBe(MAX_FRAME);
    expect(clampFrame(-Infinity)).toBe(0);
    expect(clampFrame(NaN)).toBe(0);
    expect(clampFrame(-100)).toBe(0);
    expect(clampFrame(42.7)).toBe(42);
    expect(clampFrame(100, 50)).toBe(100);
    expect(clampFrame(10, 50)).toBe(50); // below min
  });

  it('asValidFrame rejects rather than clamps', () => {
    expect(asValidFrame(100)).toBe(100);
    expect(asValidFrame(0)).toBe(0);
    expect(asValidFrame(1e19)).toBeNull();
    expect(asValidFrame(Infinity)).toBeNull();
    expect(asValidFrame(NaN)).toBeNull();
    expect(asValidFrame(-1)).toBeNull();
    expect(asValidFrame(42.9)).toBe(42);
  });

  it('clampDimension bounds GPU texture sizes', () => {
    expect(clampDimension(1920)).toBe(1920);
    expect(clampDimension(0)).toBe(1);
    expect(clampDimension(-5)).toBe(1);
    expect(clampDimension(1e9)).toBe(16384);
    expect(clampDimension(NaN)).toBe(1);
    expect(clampDimension(Infinity)).toBe(16384);
  });
});
