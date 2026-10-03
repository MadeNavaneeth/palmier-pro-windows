/**
 * A push this window refused is a real loss, and it used to be a silent one.
 *
 * The defect these pin: when a local write was outstanding, an inbound main push
 * was discarded outright and main's reply had already reported it landed. So an
 * agent turn could finish with its transcript reading "done" while the edit was
 * in neither the window nor the session, with no notice anywhere. Sequencing
 * the two instead of dropping one is a separate and still-open decision; what
 * is pinned here is only that the loss is now REPORTED — never that it stopped
 * happening, which is what the "still discards" test below is for.
 *
 * The over-warning half matters as much as the reporting half: this notice
 * shares a channel with media errors and the GPU notice, so a rule that fires
 * on an echo, a no-op, or a cursor move would spend the one channel the user
 * has for "something went wrong" on nothing. Those cases are pinned silent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorController } from '../../shared/editor/controller';
import { createEmptyProject, type Project } from '../../shared/types/project';
import { useProjectStore } from '../store/project';
import { useTimelineStore } from '../store/timeline';
import { droppedSyncNotice } from '../components/DroppedSyncNotice';
import { createEditorSync, type EditorSync } from './useEditorSync';

/** Same value as useEditorSync. */
const PUSH_DEBOUNCE_MS = 300;

interface Mounted {
  sync: EditorSync;
  pushes: string[];
  apply: (payload: unknown, metadata?: unknown) => void;
}

/** One session's acceptance counter, exactly like main's per-session sequence. */
let sessionSequence = 0;

function mount(): Mounted {
  const pushes: string[] = [];
  const listeners: Array<(payload: unknown, metadata?: unknown) => void> = [];
  const sync = createEditorSync({
    controller: useTimelineStore.getState().controller,
    pullSessionState: async () => ({ project: null, filePath: null }),
    pushSnapshot: async (payload, _filePath) => {
      pushes.push(payload);
      return { success: true, sequence: ++sessionSequence };
    },
    onApply: (listener) => {
      listeners.push(listener);
      return () => {
        listeners.splice(listeners.indexOf(listener), 1);
      };
    },
    reportSessionPath: async () => ({ success: true }),
  });
  return {
    sync,
    pushes,
    apply: (payload, metadata) => {
      for (const listener of [...listeners]) listener(payload, metadata);
    },
  };
}

function controller(): EditorController {
  return useTimelineStore.getState().controller;
}

/**
 * A real edit, which is what leaves a local write outstanding.
 *
 * The blend mode is a parameter because a SECOND call with the same value is a
 * no-op: the controller returns without publishing, so nothing arms the
 * debounce and the next inbound push is adopted instead of refused. That is
 * worth knowing, and worth not tripping over while testing refusals.
 */
function edit(blendMode: 'multiply' | 'screen' = 'multiply'): void {
  expect(controller().setClipBlendMode(controller().getClips()[0].id, blendMode)).toBe(true);
}

/**
 * The line the user is shown, or null when there is nothing to show.
 *
 * Derived from the record rather than read off a channel, because that is how
 * `DroppedSyncNotice` gets it: a test that read a string some other component
 * had set would pass while the notice rendered nothing.
 */
function notice(): string | null {
  const open = conflict();
  return open ? droppedSyncNotice(open) : null;
}

function conflict() {
  return useProjectStore.getState().droppedSync;
}

function savedProject(): Project {
  const staged = new EditorController(createEmptyProject('Reported'));
  staged.addClip({ assetId: 'asset-1', trackId: 'v1', startFrame: 30, durationFrames: 90 });
  return staged.getProject();
}

/** Main's payload for a real agent edit: one clip moved, everything else the same. */
function agentEdit(baseline: Project, startFrame: number): string {
  const agent = new EditorController(baseline);
  agent.moveClip(agent.getClips()[0].id, startFrame);
  return JSON.stringify(agent.getProject());
}

let baseline: Project;

beforeEach(() => {
  vi.useFakeTimers();
  sessionSequence = 0;
  baseline = savedProject();
  controller().loadProject(baseline);
  useProjectStore.setState({
    name: 'Reported',
    filePath: 'C:\\projects\\reported.vproj',
    isLoaded: true,
    hasUnsavedChanges: false,
    droppedSync: null,
  });
});

afterEach(() => {
  vi.useRealTimers();
  useProjectStore.setState({ droppedSync: null });
});

describe('a refused push is reported', () => {
  it('records the conflict and shows the user why their agent edit is missing', async () => {
    const window = mount();
    await window.sync.ready;
    window.pushes.length = 0;

    // The user is mid-edit, so a local write is outstanding...
    edit();
    // ...and the agent's edit lands inside that window.
    window.apply(agentEdit(baseline, 300), { source: 'main', kind: 'edit' });

    // Recorded: main's own verdict, plus a count so a multi-tool turn's worth
    // of losses is not reported as one.
    expect(conflict()).toEqual({ kind: 'edit', dropped: 1 });

    // And said in the app's existing notice words: what was lost, the cause,
    // and the only recovery that exists (the agent can produce it again).
    expect(notice()).toBe(
      'An agent change was not applied — you were editing when it arrived, so it '
      + 'was discarded. Ask the agent to try again.',
    );
    // The things it must not say. A "sync failed" frame would blame a delivery
    // that in fact succeeded, and a "recoverable" claim would promise a copy
    // that does not exist: the payload is deliberately not kept.
    expect(notice()).not.toMatch(/failed/i);
    expect(notice()).not.toMatch(/recover|saved|undo/i);

    window.sync.dispose();
  });

  it('counts a whole agent turn rather than reporting it as one change', async () => {
    const window = mount();
    await window.sync.ready;
    window.pushes.length = 0;

    edit();
    // Main collapses a multi-tool turn into one push per 30ms window, so a turn
    // that ran to completion while the user kept typing produces several.
    window.apply(agentEdit(baseline, 300), { source: 'main', kind: 'edit' });
    window.apply(agentEdit(baseline, 400), { source: 'main', kind: 'edit' });
    window.apply(agentEdit(baseline, 500), { source: 'main', kind: 'edit' });

    expect(conflict()).toEqual({ kind: 'edit', dropped: 3 });
    expect(notice()).toContain('3 agent changes were not applied');

    window.sync.dispose();
  });

  it('reports an untagged push as the edit it might be', async () => {
    const window = mount();
    await window.sync.ready;
    window.pushes.length = 0;

    // No tag at all: the same conservative default the adoption path applies
    // when it takes an untagged push as one undoable step.
    edit();
    window.apply(agentEdit(baseline, 300), undefined);

    expect(conflict()).toEqual({ kind: 'edit', dropped: 1 });
    expect(notice()).toContain('An agent change was not applied');

    window.sync.dispose();
  });

  it('STILL DISCARDS the push, so this cannot quietly become a rebase', async () => {
    const window = mount();
    await window.sync.ready;
    window.pushes.length = 0;

    edit();
    window.apply(agentEdit(baseline, 300), { source: 'main', kind: 'edit' });

    // The agent's clip position is in neither the window...
    expect(controller().getClips()[0].startFrame).toBe(30);
    // ...nor the session, and the local edit is the one that reached main.
    await vi.advanceTimersByTimeAsync(PUSH_DEBOUNCE_MS);
    expect(JSON.parse(window.pushes[0]).timeline.clips[0].startFrame).toBe(30);
    // One undoable step, the user's own: the refusal published no history.
    expect(controller().canUndo()).toBe(true);
    expect(controller().undo()).toBe(true);
    expect(controller().getClips()[0].blendMode).toBeUndefined();

    window.sync.dispose();
  });
});

describe('the ordinary cases stay silent', () => {
  it('says nothing for a playhead push main has not heard about', async () => {
    const window = mount();
    await window.sync.ready;
    window.pushes.length = 0;

    // The agent moved the cursor into the same window. A cursor is not work:
    // nothing the user authored is missing, and the next push re-establishes
    // where it went. Warning about it would spend the warning on nothing.
    //
    // Silence is the whole assertion here, and deliberately the only one: this
    // test is about not crying wolf, so it must keep passing even if the
    // refusal stops being recorded at all. That a refused cursor move IS
    // recorded is a separate claim, pinned in the "a refused push is reported"
    // block.
    edit();
    const parked = new EditorController(controller().getProject());
    parked.setPlayhead(120);
    window.apply(JSON.stringify(parked.getProject()), { source: 'main', kind: 'playhead' });

    expect(notice()).toBeNull();
    // And the refusal itself is unchanged, which is the pre-existing contract.
    expect(controller().getPlayhead()).toBe(0);

    window.sync.dispose();
  });

  it('records a refused cursor move without saying anything about it', async () => {
    const window = mount();
    await window.sync.ready;
    window.pushes.length = 0;

    edit();
    const parked = new EditorController(controller().getProject());
    parked.setPlayhead(120);
    window.apply(JSON.stringify(parked.getProject()), { source: 'main', kind: 'playhead' });

    // It happened, so it is on the record — which is what keeps a later edit's
    // count from inheriting a cursor move as if it were lost work.
    expect(conflict()).toEqual({ kind: 'playhead', dropped: 1 });
    expect(notice()).toBeNull();

    window.sync.dispose();
  });

  it('says nothing for the window\'s own echo arriving mid-debounce', async () => {
    const window = mount();
    await window.sync.ready;
    const own = window.pushes[window.pushes.length - 1];

    edit();
    // Main echoes back exactly what this window just sent. Main demonstrably
    // holds it, so refusing it costs nothing and there is no loss to report —
    // the same answer the echo guard gives when no local write is outstanding.
    window.apply(own, { source: 'renderer', sequence: 99 });

    expect(notice()).toBeNull();
    expect(conflict()).toBeNull();

    window.sync.dispose();
  });

  it('says nothing for a payload identical to what main already holds', async () => {
    const window = mount();
    await window.sync.ready;
    const confirmed = window.pushes[window.pushes.length - 1];

    edit();
    // Same project, different spelling: a no-op push is not a change, so it is
    // not a loss. The comparison is by value, not by bytes.
    window.apply(JSON.stringify(JSON.parse(confirmed)), { source: 'main', kind: 'edit' });

    expect(notice()).toBeNull();
    expect(conflict()).toBeNull();

    window.sync.dispose();
  });

  it('stops counting once the user dismisses it, and starts clean next time', async () => {
    const window = mount();
    await window.sync.ready;
    window.pushes.length = 0;

    edit();
    window.apply(agentEdit(baseline, 300), { source: 'main', kind: 'edit' });
    expect(notice()).toContain('An agent change');

    // What the notice's own click does. Without this, a conflict the user has
    // read and dismissed would still be counting, and the next one would
    // claim more losses than have happened.
    useProjectStore.getState().clearDroppedSync();
    expect(notice()).toBeNull();

    await vi.advanceTimersByTimeAsync(PUSH_DEBOUNCE_MS);
    edit('screen');
    window.apply(agentEdit(baseline, 400), { source: 'main', kind: 'edit' });

    // One, not two: the second conflict is a new event, not the tail of the
    // first.
    expect(conflict()).toEqual({ kind: 'edit', dropped: 1 });
    window.sync.dispose();
  });
});

describe('the notice has a bounded life', () => {
  it('is retired once this window takes another editor\'s state again', async () => {
    const window = mount();
    await window.sync.ready;
    window.pushes.length = 0;

    edit();
    window.apply(agentEdit(baseline, 300), { source: 'main', kind: 'edit' });
    expect(notice()).toContain('An agent change was not applied');

    // The local write lands — which is NOT what retires it, because that write
    // is the cause and it lands about 200ms later.
    await vi.advanceTimersByTimeAsync(PUSH_DEBOUNCE_MS);
    expect(notice()).toContain('An agent change was not applied');

    // Taking another editor's state is what proves the window is back in step.
    window.apply(agentEdit(baseline, 700), { source: 'main', kind: 'edit' });
    expect(conflict()).toBeNull();
    expect(notice()).toBeNull();

    window.sync.dispose();
  });

  it('does not follow the user into a different document', async () => {
    const window = mount();
    await window.sync.ready;
    window.pushes.length = 0;

    edit();
    window.apply(agentEdit(baseline, 300), { source: 'main', kind: 'edit' });
    expect(conflict()).not.toBeNull();

    useProjectStore.getState().createNew();

    expect(conflict()).toBeNull();
    expect(notice()).toBeNull();
    window.sync.dispose();
  });
});

describe('droppedSyncNotice', () => {
  it('is null for a dropped cursor move, whatever the count', () => {
    expect(droppedSyncNotice({ kind: 'playhead', dropped: 1 })).toBeNull();
    expect(droppedSyncNotice({ kind: 'playhead', dropped: 9 })).toBeNull();
  });

  it('agrees with the count the record keeps', () => {
    expect(droppedSyncNotice({ kind: 'edit', dropped: 1 })).toContain('An agent change');
    expect(droppedSyncNotice({ kind: 'edit', dropped: 2 })).toContain('2 agent changes');
  });
});
