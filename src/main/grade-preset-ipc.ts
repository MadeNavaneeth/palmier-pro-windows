/**
 * IPC bridge for app-wide named color-grade presets (upstream #157).
 *
 * Presets are preferences, not timeline state: no event sender/session lookup
 * belongs here. Every handler delegates to the one process-wide repository
 * used by the Agent and MCP executor.
 */

import { ipcMain } from 'electron';
import { getGradePresetRepository } from './grade-preset-repository';

export function registerGradePresetHandlers(): void {
  const repository = getGradePresetRepository();

  ipcMain.handle('grade-presets:list', () => ({
    success: true,
    presets: repository.list(),
  }));

  ipcMain.handle('grade-presets:get', (_event, id: unknown) => {
    if (typeof id !== 'string') {
      return { success: false, error: 'Preset id must be a string.' };
    }
    const preset = repository.get(id);
    return preset
      ? { success: true, preset }
      : { success: false, error: 'Grade preset not found.' };
  });

  ipcMain.handle('grade-presets:save', (_event, label: unknown, grade: unknown, shot?: unknown) => {
    const result = repository.save(label, grade, shot);
    return result.ok
      ? { success: true, preset: result.preset, presets: result.presets }
      : { success: false, error: result.error, presets: result.presets };
  });

  ipcMain.handle('grade-presets:rename', (_event, id: unknown, label: unknown) => {
    if (typeof id !== 'string') {
      return { success: false, error: 'Preset id must be a string.' };
    }
    const result = repository.rename(id, label);
    return result.ok
      ? { success: true, preset: result.preset, presets: result.presets }
      : { success: false, error: result.error, presets: result.presets };
  });

  ipcMain.handle('grade-presets:remove', (_event, id: unknown) => {
    if (typeof id !== 'string') {
      return { success: false, error: 'Preset id must be a string.' };
    }
    const result = repository.delete(id);
    return result.ok
      ? { success: true, changed: result.changed, presets: result.presets }
      : { success: false, error: result.error, presets: result.presets };
  });
}
