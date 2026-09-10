/**
 * Agent plan state (Track 2, L3 — see docs/AGENTIC_ROADMAP.md).
 *
 * The Codex `update_plan` / Claude Code todo pattern: a stateless tool call
 * *replaces* the plan, and the plan is UI state — it never enters the project
 * model, never touches undo, and is never load-bearing for correctness. It
 * exists so a long multi-step request has a visible, checkable shape.
 *
 * Pure so both the tool path and the renderer can normalize the same payload.
 */

export type PlanStepStatus = 'pending' | 'in_progress' | 'completed';

export interface PlanStep {
  step: string;
  status: PlanStepStatus;
}

export const PLAN_MAX_STEPS = 12;
export const PLAN_STEP_MAX_CHARS = 160;

/**
 * Narrow a model-supplied plan: trim and collapse whitespace, drop empty and
 * unusable entries, cap the list, and enforce at most one `in_progress` step
 * (the first one wins; extras demote to `pending`) so the UI cannot show two
 * simultaneous work items.
 */
export function normalizePlan(input: unknown): PlanStep[] {
  if (!Array.isArray(input)) return [];
  const steps: PlanStep[] = [];
  for (const entry of input) {
    if (typeof entry !== 'object' || entry === null) continue;
    const candidate = entry as { step?: unknown; status?: unknown };
    if (typeof candidate.step !== 'string') continue;
    const step = candidate.step.trim().replace(/\s+/g, ' ');
    if (step.length === 0) continue;
    const status: PlanStepStatus =
      candidate.status === 'in_progress' || candidate.status === 'completed'
        ? candidate.status
        : 'pending';
    steps.push({ step: step.slice(0, PLAN_STEP_MAX_CHARS), status });
    if (steps.length >= PLAN_MAX_STEPS) break;
  }

  let sawInProgress = false;
  return steps.map((entry) => {
    if (entry.status !== 'in_progress') return entry;
    if (sawInProgress) return { ...entry, status: 'pending' };
    sawInProgress = true;
    return entry;
  });
}

/** One-line receipt text, e.g. `2/5 done — now: Trim the intro`. */
export function planSummary(steps: readonly PlanStep[]): string {
  if (steps.length === 0) return 'Plan cleared.';
  const done = steps.filter((entry) => entry.status === 'completed').length;
  const current = steps.find((entry) => entry.status === 'in_progress');
  return `${done}/${steps.length} done${current ? ` — now: ${current.step}` : ''}`;
}
