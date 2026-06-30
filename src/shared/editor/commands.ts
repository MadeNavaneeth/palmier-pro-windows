/**
 * EditorController command system.
 *
 * Every edit operation is a Command — named, undoable, serializable.
 * The UI, the in-app AI agent, and the MCP server all call the same commands.
 * This is the core design inherited from Palmier Pro.
 */

import type { Project, Clip, Track, Frame } from '../types/project';

// ─── Command interface ───────────────────────────────────────────────────────

export interface Command {
  readonly name: string;
  execute(project: Project): Project;
  undo(project: Project): Project;
  /** Human-readable description for undo/redo UI */
  describe(): string;
}

// ─── Command History (undo/redo stack) ───────────────────────────────────────

export class CommandHistory {
  private undoStack: Command[] = [];
  private redoStack: Command[] = [];
  private maxSize: number;

  constructor(maxSize = 200) {
    this.maxSize = maxSize;
  }

  execute(command: Command, project: Project): Project {
    const result = command.execute(project);
    this.undoStack.push(command);
    this.redoStack = []; // clear redo on new action

    // Trim if over max size
    if (this.undoStack.length > this.maxSize) {
      this.undoStack.shift();
    }

    return result;
  }

  undo(project: Project): Project | null {
    const command = this.undoStack.pop();
    if (!command) return null;
    this.redoStack.push(command);
    return command.undo(project);
  }

  redo(project: Project): Project | null {
    const command = this.redoStack.pop();
    if (!command) return null;
    this.undoStack.push(command);
    return command.execute(project);
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  lastCommandName(): string | null {
    const last = this.undoStack[this.undoStack.length - 1];
    return last ? last.name : null;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }
}

// ─── Concrete Commands ───────────────────────────────────────────────────────

export class AddClipCommand implements Command {
  readonly name = 'addClip';
  constructor(private clip: Clip) {}

  execute(project: Project): Project {
    return {
      ...project,
      timeline: {
        ...project.timeline,
        clips: [...project.timeline.clips, this.clip],
      },
      updatedAt: new Date().toISOString(),
    };
  }

  undo(project: Project): Project {
    return {
      ...project,
      timeline: {
        ...project.timeline,
        clips: project.timeline.clips.filter((c) => c.id !== this.clip.id),
      },
      updatedAt: new Date().toISOString(),
    };
  }

  describe(): string {
    return `Add clip "${this.clip.label || this.clip.id}"`;
  }
}

export class RemoveClipCommand implements Command {
  readonly name = 'removeClip';
  private removedClip: Clip | null = null;

  constructor(private clipId: string) {}

  execute(project: Project): Project {
    this.removedClip = project.timeline.clips.find((c) => c.id === this.clipId) || null;
    return {
      ...project,
      timeline: {
        ...project.timeline,
        clips: project.timeline.clips.filter((c) => c.id !== this.clipId),
      },
      updatedAt: new Date().toISOString(),
    };
  }

  undo(project: Project): Project {
    if (!this.removedClip) return project;
    return {
      ...project,
      timeline: {
        ...project.timeline,
        clips: [...project.timeline.clips, this.removedClip],
      },
      updatedAt: new Date().toISOString(),
    };
  }

  describe(): string {
    return `Remove clip "${this.clipId}"`;
  }
}

export class MoveClipCommand implements Command {
  readonly name = 'moveClip';
  private previousStartFrame: Frame = 0;
  private previousTrackId: string = '';

  constructor(
    private clipId: string,
    private newStartFrame: Frame,
    private newTrackId?: string,
  ) {}

  execute(project: Project): Project {
    const clips = project.timeline.clips.map((c) => {
      if (c.id !== this.clipId) return c;
      this.previousStartFrame = c.startFrame;
      this.previousTrackId = c.trackId;
      return {
        ...c,
        startFrame: this.newStartFrame,
        trackId: this.newTrackId || c.trackId,
      };
    });
    return { ...project, timeline: { ...project.timeline, clips }, updatedAt: new Date().toISOString() };
  }

  undo(project: Project): Project {
    const clips = project.timeline.clips.map((c) => {
      if (c.id !== this.clipId) return c;
      return { ...c, startFrame: this.previousStartFrame, trackId: this.previousTrackId };
    });
    return { ...project, timeline: { ...project.timeline, clips }, updatedAt: new Date().toISOString() };
  }

  describe(): string {
    return `Move clip to frame ${this.newStartFrame}`;
  }
}

export class TrimClipCommand implements Command {
  readonly name = 'trimClip';
  private prevIn: Frame = 0;
  private prevOut: Frame = 0;
  private prevDuration: Frame = 0;

  constructor(
    private clipId: string,
    private newInPoint: Frame,
    private newOutPoint: Frame,
  ) {}

  execute(project: Project): Project {
    const clips = project.timeline.clips.map((c) => {
      if (c.id !== this.clipId) return c;
      this.prevIn = c.inPoint;
      this.prevOut = c.outPoint;
      this.prevDuration = c.durationFrames;
      return {
        ...c,
        inPoint: this.newInPoint,
        outPoint: this.newOutPoint,
        durationFrames: this.newOutPoint - this.newInPoint,
      };
    });
    return { ...project, timeline: { ...project.timeline, clips }, updatedAt: new Date().toISOString() };
  }

  undo(project: Project): Project {
    const clips = project.timeline.clips.map((c) => {
      if (c.id !== this.clipId) return c;
      return { ...c, inPoint: this.prevIn, outPoint: this.prevOut, durationFrames: this.prevDuration };
    });
    return { ...project, timeline: { ...project.timeline, clips }, updatedAt: new Date().toISOString() };
  }

  describe(): string {
    return `Trim clip [${this.newInPoint}–${this.newOutPoint}]`;
  }
}

export class SplitClipCommand implements Command {
  readonly name = 'splitClip';
  private originalClip: Clip | null = null;
  private newClipId: string = '';

  constructor(
    private clipId: string,
    private splitFrame: Frame,
    private generateId: () => string,
  ) {}

  execute(project: Project): Project {
    const clip = project.timeline.clips.find((c) => c.id === this.clipId);
    if (!clip) return project;
    this.originalClip = { ...clip };

    const relativeFrame = this.splitFrame - clip.startFrame;
    if (relativeFrame <= 0 || relativeFrame >= clip.durationFrames) return project;

    this.newClipId = this.generateId();

    const leftClip: Clip = {
      ...clip,
      durationFrames: relativeFrame,
      outPoint: clip.inPoint + relativeFrame,
    };

    const rightClip: Clip = {
      ...clip,
      id: this.newClipId,
      startFrame: this.splitFrame,
      durationFrames: clip.durationFrames - relativeFrame,
      inPoint: clip.inPoint + relativeFrame,
    };

    const clips = project.timeline.clips
      .filter((c) => c.id !== this.clipId)
      .concat([leftClip, rightClip]);

    return { ...project, timeline: { ...project.timeline, clips }, updatedAt: new Date().toISOString() };
  }

  undo(project: Project): Project {
    if (!this.originalClip) return project;
    const clips = project.timeline.clips
      .filter((c) => c.id !== this.clipId && c.id !== this.newClipId)
      .concat([this.originalClip]);
    return { ...project, timeline: { ...project.timeline, clips }, updatedAt: new Date().toISOString() };
  }

  describe(): string {
    return `Split clip at frame ${this.splitFrame}`;
  }
}

export class AddTrackCommand implements Command {
  readonly name = 'addTrack';
  constructor(private track: Track) {}

  execute(project: Project): Project {
    return {
      ...project,
      timeline: {
        ...project.timeline,
        tracks: [...project.timeline.tracks, this.track],
      },
      updatedAt: new Date().toISOString(),
    };
  }

  undo(project: Project): Project {
    return {
      ...project,
      timeline: {
        ...project.timeline,
        tracks: project.timeline.tracks.filter((t) => t.id !== this.track.id),
      },
      updatedAt: new Date().toISOString(),
    };
  }

  describe(): string {
    return `Add track "${this.track.name}"`;
  }
}

export class SetPlayheadCommand implements Command {
  readonly name = 'setPlayhead';
  private previousFrame: Frame = 0;

  constructor(private frame: Frame) {}

  execute(project: Project): Project {
    this.previousFrame = project.timeline.playheadFrame;
    return {
      ...project,
      timeline: { ...project.timeline, playheadFrame: this.frame },
    };
  }

  undo(project: Project): Project {
    return {
      ...project,
      timeline: { ...project.timeline, playheadFrame: this.previousFrame },
    };
  }

  describe(): string {
    return `Move playhead to frame ${this.frame}`;
  }
}


export class SetBlendModeCommand implements Command {
  readonly name = 'setBlendMode';
  private previousMode: import('../types/blend-mode').BlendMode | undefined;
  private found = false;

  constructor(
    private clipId: string,
    private blendMode: import('../types/blend-mode').BlendMode,
  ) {}

  execute(project: Project): Project {
    const clips = project.timeline.clips.map((c) => {
      if (c.id !== this.clipId) return c;
      this.previousMode = c.blendMode;
      this.found = true;
      // 'normal' clears the property to keep saved projects clean.
      const next = { ...c };
      if (this.blendMode === 'normal') {
        delete next.blendMode;
      } else {
        next.blendMode = this.blendMode;
      }
      return next;
    });
    if (!this.found) return project;
    return { ...project, timeline: { ...project.timeline, clips }, updatedAt: new Date().toISOString() };
  }

  undo(project: Project): Project {
    if (!this.found) return project;
    const clips = project.timeline.clips.map((c) => {
      if (c.id !== this.clipId) return c;
      const next = { ...c };
      if (this.previousMode === undefined || this.previousMode === 'normal') {
        delete next.blendMode;
      } else {
        next.blendMode = this.previousMode;
      }
      return next;
    });
    return { ...project, timeline: { ...project.timeline, clips }, updatedAt: new Date().toISOString() };
  }

  describe(): string {
    return `Set blend mode to "${this.blendMode}"`;
  }
}


export class SetOpacityCommand implements Command {
  readonly name = 'setOpacity';
  private previousOpacity = 1;
  private found = false;

  constructor(
    private clipId: string,
    private opacity: number,
  ) {}

  execute(project: Project): Project {
    const clamped = Math.max(0, Math.min(1, this.opacity));
    const clips = project.timeline.clips.map((c) => {
      if (c.id !== this.clipId) return c;
      this.previousOpacity = c.opacity;
      this.found = true;
      return { ...c, opacity: clamped };
    });
    if (!this.found) return project;
    return { ...project, timeline: { ...project.timeline, clips }, updatedAt: new Date().toISOString() };
  }

  undo(project: Project): Project {
    if (!this.found) return project;
    const clips = project.timeline.clips.map((c) =>
      c.id === this.clipId ? { ...c, opacity: this.previousOpacity } : c,
    );
    return { ...project, timeline: { ...project.timeline, clips }, updatedAt: new Date().toISOString() };
  }

  describe(): string {
    return `Set opacity to ${Math.round(this.opacity * 100)}%`;
  }
}


/**
 * Replace the entire timeline clip array in one undoable step.
 * Used for complex multi-clip transforms (ripple, silence removal) where
 * tracking individual deltas is error-prone; snapshotting the clips array is
 * simple and correct, and the arrays are small.
 */
export class ReplaceClipsCommand implements Command {
  readonly name = 'replaceClips';
  private previousClips: Clip[] = [];
  private captured = false;

  constructor(
    private nextClips: Clip[],
    private label: string,
  ) {}

  execute(project: Project): Project {
    if (!this.captured) {
      this.previousClips = project.timeline.clips;
      this.captured = true;
    }
    return {
      ...project,
      timeline: { ...project.timeline, clips: this.nextClips },
      updatedAt: new Date().toISOString(),
    };
  }

  undo(project: Project): Project {
    return {
      ...project,
      timeline: { ...project.timeline, clips: this.previousClips },
      updatedAt: new Date().toISOString(),
    };
  }

  describe(): string {
    return this.label;
  }
}


/**
 * Replace the entire project in one undoable step. Used when the renderer
 * adopts an edit produced by the AI agent / MCP server (which runs against
 * the main-process controller), so agent edits appear as a single reversible
 * action in the UI's undo history.
 */
export class ReplaceProjectCommand implements Command {
  readonly name = 'replaceProject';
  private previousProject: Project | null = null;

  constructor(
    private nextProject: Project,
    private label: string,
  ) {}

  execute(project: Project): Project {
    if (this.previousProject === null) {
      this.previousProject = project;
    }
    return this.nextProject;
  }

  undo(_project: Project): Project {
    return this.previousProject!;
  }

  describe(): string {
    return this.label;
  }
}


/**
 * Set a clip's fade-in / fade-out lengths (frames). Either may be left
 * undefined to keep its current value. Lengths are clamped so they can't
 * exceed the clip duration.
 */
export class SetFadeCommand implements Command {
  readonly name = 'setFade';
  private prevIn: Frame | undefined;
  private prevOut: Frame | undefined;
  private found = false;

  constructor(
    private clipId: string,
    private fadeInFrames: Frame | undefined,
    private fadeOutFrames: Frame | undefined,
  ) {}

  execute(project: Project): Project {
    const clips = project.timeline.clips.map((c) => {
      if (c.id !== this.clipId) return c;
      this.prevIn = c.fadeInFrames;
      this.prevOut = c.fadeOutFrames;
      this.found = true;

      const next = { ...c };
      const max = c.durationFrames;
      if (this.fadeInFrames !== undefined) {
        const v = Math.max(0, Math.min(max, Math.round(this.fadeInFrames)));
        if (v <= 0) delete next.fadeInFrames; else next.fadeInFrames = v;
      }
      if (this.fadeOutFrames !== undefined) {
        const v = Math.max(0, Math.min(max, Math.round(this.fadeOutFrames)));
        if (v <= 0) delete next.fadeOutFrames; else next.fadeOutFrames = v;
      }
      return next;
    });
    if (!this.found) return project;
    return { ...project, timeline: { ...project.timeline, clips }, updatedAt: new Date().toISOString() };
  }

  undo(project: Project): Project {
    if (!this.found) return project;
    const clips = project.timeline.clips.map((c) => {
      if (c.id !== this.clipId) return c;
      const next = { ...c };
      if (this.prevIn === undefined) delete next.fadeInFrames; else next.fadeInFrames = this.prevIn;
      if (this.prevOut === undefined) delete next.fadeOutFrames; else next.fadeOutFrames = this.prevOut;
      return next;
    });
    return { ...project, timeline: { ...project.timeline, clips }, updatedAt: new Date().toISOString() };
  }

  describe(): string {
    return 'Set clip fades';
  }
}
