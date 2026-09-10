/**
 * Coverage for update_plan (Track 2, L3): the plan is session UI state — the
 * tool normalizes it, reports it outward, and never touches the project or
 * the undo stack.
 */
import { describe, expect, it, vi } from 'vitest';
import { ToolExecutor } from './executor';
import { EditorController } from '../../shared/editor/controller';
import type { PlanStep } from '../../shared/editor/plan';

function harness() {
  const editor = new EditorController();
  const onPlanUpdate = vi.fn<(plan: PlanStep[]) => void>();
  const executor = new ToolExecutor(editor, { onPlanUpdate });
  return { editor, executor, onPlanUpdate };
}

describe('update_plan tool (L3)', () => {
  it('normalizes the plan, reports it, and returns a summary', async () => {
    const { editor, executor, onPlanUpdate } = harness();
    const before = JSON.stringify(editor.getProject());

    const result = await executor.execute('update_plan', {
      steps: [
        { step: '  Trim the intro ', status: 'completed' },
        { step: 'Add captions', status: 'in_progress' },
        { step: 'Export', status: 'pending' },
      ],
    });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      summary: '1/3 done — now: Add captions',
      count: 3,
    });
    expect(onPlanUpdate).toHaveBeenCalledWith([
      { step: 'Trim the intro', status: 'completed' },
      { step: 'Add captions', status: 'in_progress' },
      { step: 'Export', status: 'pending' },
    ]);

    // Session state only: the project and history are untouched.
    expect(JSON.stringify(editor.getProject())).toBe(before);
    expect(editor.canUndo()).toBe(false);
  });

  it('clears the plan with an empty array', async () => {
    const { executor, onPlanUpdate } = harness();

    const result = await executor.execute('update_plan', { steps: [] });

    expect(result.data).toMatchObject({ summary: 'Plan cleared.', count: 0 });
    expect(onPlanUpdate).toHaveBeenCalledWith([]);
  });

  it('demotes extra in_progress steps and rejects malformed steps at the schema', async () => {
    const { executor, onPlanUpdate } = harness();

    await executor.execute('update_plan', {
      steps: [
        { step: 'one', status: 'in_progress' },
        { step: 'two', status: 'in_progress' },
      ],
    });
    expect(onPlanUpdate).toHaveBeenCalledWith([
      { step: 'one', status: 'in_progress' },
      { step: 'two', status: 'pending' },
    ]);

    // Bad status values and empty steps fail the schema before the handler.
    expect((await executor.execute('update_plan', {
      steps: [{ step: 'x', status: 'almost' }],
    })).success).toBe(false);
    expect((await executor.execute('update_plan', {
      steps: [{ step: '', status: 'pending' }],
    })).success).toBe(false);
  });
});
