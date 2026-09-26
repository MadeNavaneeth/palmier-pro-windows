/**
 * Main-process named-preset repository tests (upstream #157). The injected
 * backend keeps these tests Electron-free while exercising the same narrowing
 * and collision rules as the desktop store.
 */

import { describe, expect, it } from 'vitest';
import {
  GradePresetRepository,
  InMemoryGradePresetBackend,
} from './grade-preset-repository';

function repository(): { repo: GradePresetRepository; backend: InMemoryGradePresetBackend } {
  const backend = new InMemoryGradePresetBackend();
  let next = 0;
  return {
    backend,
    repo: new GradePresetRepository(backend, () => `user-${next++}`),
  };
}

describe('GradePresetRepository (#157)', () => {
  it('saves, lists, and gets a narrowed named look', () => {
    const { repo } = repository();
    const result = repo.save(
      '  Golden Hour  ',
      { brightness: 0.1, invertColors: true },
      { rotation: 15, scaleX: 1.25, crop: { left: 0.1, right: 0, top: 0, bottom: 0 } },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preset).toMatchObject({ id: 'user-0', label: 'Golden Hour' });
    expect(result.preset.grade).toMatchObject({ brightness: 0.1, invertColors: true });
    expect(result.preset.shot).toEqual({ rotation: 15, scaleX: 1.25, crop: { left: 0.1, right: 0, top: 0, bottom: 0 } });
    expect(repo.list()).toEqual([result.preset]);
    expect(repo.get('user-0')).toEqual(result.preset);
  });

  it('rejects duplicate names case-insensitively without overwriting', () => {
    const { repo } = repository();
    const first = repo.save('Golden', { brightness: 0.1 });
    expect(first.ok).toBe(true);

    const duplicate = repo.save('  golden ', { brightness: 0.9 });
    expect(duplicate).toMatchObject({ ok: false });
    expect(repo.list()).toHaveLength(1);
    expect(repo.get('user-0')?.grade.brightness).toBe(0.1);
  });

  it('renames safely and refuses a collision with another preset', () => {
    const { repo } = repository();
    repo.save('First', { brightness: 0.1 });
    repo.save('Second', { contrast: 1.2 });

    const collision = repo.rename('user-1', 'first');
    expect(collision).toMatchObject({ ok: false });
    expect(repo.get('user-1')?.label).toBe('Second');

    const renamed = repo.rename('user-1', '  Renamed  ');
    expect(renamed).toMatchObject({ ok: true });
    expect(repo.get('user-1')?.label).toBe('Renamed');
  });

  it('enforces the cap and makes deletion idempotent', () => {
    const { repo } = repository();
    for (let index = 0; index < 50; index += 1) {
      expect(repo.save(`Look ${index}`, { brightness: 0.1 }, { rotation: index }).ok).toBe(true);
    }
    expect(repo.save('One too many', { brightness: 0.1 }, { rotation: 1 })).toMatchObject({ ok: false });
    expect(repo.list()).toHaveLength(50);

    expect(repo.delete('user-0')).toEqual({ ok: true, changed: true, presets: repo.list() });
    expect(repo.save('Now there is room', { brightness: 0.1 })).toMatchObject({ ok: true });
    expect(repo.delete('user-999')).toEqual({ ok: true, changed: false, presets: repo.list() });
  });

  it('narrows a hostile shot without discarding a valid grade', () => {
    const { repo, backend } = repository();
    backend.set('presets', [{
      id: 'user-shot',
      label: 'Shot',
      grade: { brightness: 0.2 },
      shot: { scaleX: Number.POSITIVE_INFINITY, rotation: 'bad', crop: 42 },
    }]);

    expect(repo.get('user-shot')).toEqual({
      id: 'user-shot',
      label: 'Shot',
      grade: { brightness: 0.2 },
      shot: { scaleX: 1, rotation: 0, crop: { left: 0, right: 0, top: 0, bottom: 0 } },
    });
  });

  it('narrows a hostile backend payload before exposing it', () => {
    const { repo, backend } = repository();
    backend.set('presets', [{
      id: 'user-hostile',
      label: 'Hostile',
      grade: { brightness: 99, invertColors: 'yes', curves: 'bad', blurRadius: 1000 },
    }]);

    expect(repo.list()).toEqual([]);
    expect(repo.get('user-hostile')).toBeNull();
  });
});
