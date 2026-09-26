/**
 * `CommandHistory` transaction semantics.
 *
 * A transaction exists so a multi-command operation is grouped BY
 * CONSTRUCTION instead of by counting how many entries it pushed. These tests
 * pin the contract the controller relies on: a scope publishes one entry, a
 * scope that produced nothing publishes nothing, a nested scope joins its
 * parent rather than adding an entry, and an aborted scope leaves history
 * exactly as it was.
 */

import { describe, expect, it } from 'vitest';
import { CommandHistory, AddTrackCommand, SetPlayheadCommand, type Command } from './commands';
import { createEmptyProject, type Project, type Track } from '../types/project';

function videoTrack(id: string): Track {
  return { id, name: id, type: 'video', locked: false, visible: true, syncLocked: true, order: 0 };
}

function addTrackCommand(id: string): Command {
  return new AddTrackCommand(videoTrack(id));
}

/** A command whose undo restores the exact project it was given. */
function snapshotCommand(): Command {
  let before: Project;
  return {
    name: 'snapshot',
    execute: (project) => { before = project; return project; },
    undo: () => before,
    describe: () => 'Snapshot',
  };
}

const fresh = () => createEmptyProject();

/** Ids of the tracks a test ADDED, in order (the default v1/a1 are ignored). */
function trackIds(project: Project): string[] {
  return project.timeline.tracks
    .map((track) => track.id)
    .filter((id) => id !== 'v1' && id !== 'a1');
}

describe('CommandHistory transactions', () => {
  it('commits several commands as exactly one history entry', () => {
    const history = new CommandHistory();
    let project = fresh();

    history.beginTransaction('Batch');
    for (const id of ['t1', 't2', 't3']) project = history.execute(addTrackCommand(id), project);
    history.commitTransaction();

    expect(trackIds(project)).toEqual(['t1', 't2', 't3']);

    // One undo unwinds the whole batch, and there is nothing left after it.
    const undone = history.undo(project)!;
    expect(trackIds(undone)).toEqual([]);
    expect(history.canUndo()).toBe(false);
  });

  it('adds no history entry for a transaction that produced no command', () => {
    const history = new CommandHistory();

    history.beginTransaction('No-op');
    history.commitTransaction();

    expect(history.canUndo()).toBe(false);
    expect(history.lastCommandName()).toBeNull();
  });

  it('publishes a lone command under its own name instead of a composite', () => {
    const history = new CommandHistory();
    const project = fresh();

    history.beginTransaction('Batch');
    history.execute(new SetPlayheadCommand(42), project);
    history.commitTransaction();

    // A transaction labels a GROUPED action; it must not relabel a single
    // domain operation, or wrapping one call would change its undo label.
    expect(history.lastCommandName()).toBe('setPlayhead');
  });

  it('names a grouped entry after the transaction', () => {
    const history = new CommandHistory();
    let project = fresh();

    history.beginTransaction('Trim clips (Agent)');
    project = history.execute(new SetPlayheadCommand(10), project);
    project = history.execute(new SetPlayheadCommand(20), project);
    history.commitTransaction();

    expect(history.lastCommandName()).toBe('composite');
    expect(trackIds(history.redo(history.undo(project)!)!)).toEqual([]);
  });

  it('a nested transaction joins its parent and adds no second entry', () => {
    const history = new CommandHistory();
    let project = fresh();

    history.beginTransaction('Outer');
    project = history.execute(addTrackCommand('outer-before'), project);
    history.beginTransaction('Inner');
    project = history.execute(addTrackCommand('inner-1'), project);
    project = history.execute(addTrackCommand('inner-2'), project);
    history.commitTransaction();
    project = history.execute(addTrackCommand('outer-after'), project);
    history.commitTransaction();

    // All four commands land as ONE entry: the inner label is dropped and the
    // outer action names the step.
    expect(trackIds(project)).toEqual(['outer-before', 'inner-1', 'inner-2', 'outer-after']);
    const undone = history.undo(project)!;
    expect(trackIds(undone)).toEqual([]);
    expect(history.canUndo()).toBe(false);
  });

  it('an empty nested transaction adds nothing to its parent', () => {
    const history = new CommandHistory();
    let project = fresh();

    history.beginTransaction('Outer');
    project = history.execute(addTrackCommand('t1'), project);
    history.beginTransaction('Inner');
    history.commitTransaction();
    history.commitTransaction();

    expect(history.canUndo()).toBe(true);
    expect(trackIds(history.undo(project)!)).toEqual([]);
  });

  it('aborting a scope publishes nothing and returns its commands in order', () => {
    const history = new CommandHistory();
    let project = fresh();

    history.beginTransaction('Doomed');
    project = history.execute(addTrackCommand('t1'), project);
    project = history.execute(snapshotCommand(), project);
    project = history.execute(addTrackCommand('t2'), project);
    const discarded = history.abortTransaction();

    expect(discarded.map((command) => command.name)).toEqual(['addTrack', 'snapshot', 'addTrack']);
    expect(history.canUndo()).toBe(false);

    // The caller restores the pre-action project by undoing them in reverse.
    const restored = [...discarded].reverse().reduce(
      (state, command) => command.undo(state),
      project,
    );
    expect(trackIds(restored)).toEqual([]);
  });

  it('an aborted transaction leaves the redo stack intact', () => {
    const history = new CommandHistory();
    let project = fresh();

    project = history.execute(addTrackCommand('t1'), project);
    project = history.undo(project)!;
    expect(history.canRedo()).toBe(true);

    history.beginTransaction('Doomed');
    project = history.execute(addTrackCommand('t2'), project);
    const discarded = history.abortTransaction();
    project = [...discarded].reverse().reduce((state, command) => command.undo(state), project);

    // Nothing was committed, so the pending redo still stands.
    expect(history.canRedo()).toBe(true);
    expect(trackIds(history.redo(project)!)).toEqual(['t1']);
  });

  it('committing a transaction clears the redo stack', () => {
    const history = new CommandHistory();
    let project = fresh();

    project = history.execute(addTrackCommand('t1'), project);
    project = history.undo(project)!;
    expect(history.canRedo()).toBe(true);

    history.beginTransaction('Batch');
    project = history.execute(addTrackCommand('t2'), project);
    project = history.execute(addTrackCommand('t3'), project);
    history.commitTransaction();

    // The whole transaction is a new action, so redo is gone.
    expect(history.canRedo()).toBe(false);
    expect(trackIds(project)).toEqual(['t2', 't3']);
  });

  it('undo/redo ordering stays correct around a transaction', () => {
    const history = new CommandHistory();
    let project = fresh();

    project = history.execute(addTrackCommand('base'), project);
    history.beginTransaction('Batch');
    project = history.execute(addTrackCommand('batch-1'), project);
    project = history.execute(addTrackCommand('batch-2'), project);
    history.commitTransaction();
    // An unrelated edit AFTER the transaction must sit on top of it.
    project = history.execute(addTrackCommand('later'), project);

    expect(trackIds(project)).toEqual(['base', 'batch-1', 'batch-2', 'later']);

    project = history.undo(project)!;
    expect(trackIds(project)).toEqual(['base', 'batch-1', 'batch-2']);
    project = history.undo(project)!;
    expect(trackIds(project)).toEqual(['base']);

    project = history.redo(project)!;
    expect(trackIds(project)).toEqual(['base', 'batch-1', 'batch-2']);
    project = history.redo(project)!;
    expect(trackIds(project)).toEqual(['base', 'batch-1', 'batch-2', 'later']);
  });

  it('undo/redo ordering stays correct when a transaction is aborted', () => {
    const history = new CommandHistory();
    let project = fresh();

    project = history.execute(addTrackCommand('base'), project);
    history.beginTransaction('Doomed');
    project = history.execute(addTrackCommand('ghost-1'), project);
    project = history.execute(addTrackCommand('ghost-2'), project);
    const discarded = history.abortTransaction();
    project = [...discarded].reverse().reduce((state, command) => command.undo(state), project);

    // The aborted run left no entry at all, so undo goes straight at `base`.
    expect(trackIds(project)).toEqual(['base']);
    project = history.undo(project)!;
    expect(trackIds(project)).toEqual([]);
    project = history.redo(project)!;
    expect(trackIds(project)).toEqual(['base']);
  });

  it('ignores a commit or abort with no open scope', () => {
    const history = new CommandHistory();
    expect(() => history.commitTransaction()).not.toThrow();
    expect(history.abortTransaction()).toEqual([]);
    expect(history.canUndo()).toBe(false);
  });

  it('counts a committed batch as one entry against the size cap', () => {
    const history = new CommandHistory(3);
    let project = fresh();

    for (const id of ['solo-0', 'solo-1', 'solo-2', 'solo-3']) {
      project = history.execute(addTrackCommand(id), project);
    }
    history.beginTransaction('Batch');
    project = history.execute(addTrackCommand('batched-1'), project);
    project = history.execute(addTrackCommand('batched-2'), project);
    history.commitTransaction();

    // Four solo pushes against a cap of 3 already dropped solo-0; the batch
    // commit costs exactly ONE more slot, so the stack is [solo-2, solo-3,
    // batch] and three undos drain it — not four. The two solos that aged off
    // stay in the project, which is the cap's existing contract.
    for (let index = 0; index < 3; index++) project = history.undo(project)!;
    expect(history.canUndo()).toBe(false);
    expect(trackIds(project)).toEqual(['solo-0', 'solo-1']);
  });
});
