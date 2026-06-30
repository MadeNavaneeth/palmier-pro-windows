/**
 * useKeyboardShortcuts — global keyboard handler for the timeline editor.
 *
 * Shortcuts (industry-standard NLE layout):
 *   C           — Split/razor at playhead
 *   Delete/Bksp — Delete selected clips
 *   Shift+Del   — Ripple delete selected clips
 *   Ctrl+Z      — Undo
 *   Ctrl+Y      — Redo
 *   Ctrl+Shift+Z— Redo (alt)
 *   Space       — Toggle playback
 *   J           — Play reverse / decrease speed
 *   K           — Pause
 *   L           — Play forward / increase speed
 *   Left/Right  — Step 1 frame
 *   Shift+Left  — Step 10 frames back
 *   Shift+Right — Step 10 frames forward
 *   I           — Set in point (mark selection start)
 *   O           — Set out point (mark selection end)
 *   Ctrl+A      — Select all clips
 *   Escape      — Deselect all / cancel
 *   Home        — Go to start
 *   End         — Go to end of last clip
 *   +/=         — Zoom in
 *   -           — Zoom out
 *   Ctrl+0      — Fit timeline to window
 */

import { useEffect, useCallback } from 'react';
import { useTimelineStore } from '../store/timeline';

export function useKeyboardShortcuts() {
  const splitAtPlayhead = useTimelineStore((s) => s.splitAtPlayhead);
  const removeSelectedClips = useTimelineStore((s) => s.removeSelectedClips);
  const rippleDelete = useTimelineStore((s) => s.rippleDelete);
  const undo = useTimelineStore((s) => s.undo);
  const redo = useTimelineStore((s) => s.redo);
  const togglePlayback = useTimelineStore((s) => s.togglePlayback);
  const setPlaybackRate = useTimelineStore((s) => s.setPlaybackRate);
  const stepFrame = useTimelineStore((s) => s.stepFrame);
  const setPlayhead = useTimelineStore((s) => s.setPlayhead);
  const deselectAll = useTimelineStore((s) => s.deselectAll);
  const zoomIn = useTimelineStore((s) => s.zoomIn);
  const zoomOut = useTimelineStore((s) => s.zoomOut);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Don't capture when typing in an input/textarea
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
        return;
      }

      const ctrl = e.ctrlKey || e.metaKey;
      const shift = e.shiftKey;

      switch (e.key) {
        // ── Split ────────────────────────────────────────────────────────────
        case 'c':
        case 'C':
          if (!ctrl) {
            e.preventDefault();
            splitAtPlayhead();
          }
          break;

        // ── Delete ───────────────────────────────────────────────────────────
        case 'Delete':
        case 'Backspace':
          e.preventDefault();
          if (shift) {
            rippleDelete();
          } else {
            removeSelectedClips();
          }
          break;

        // ── Undo / Redo ──────────────────────────────────────────────────────
        case 'z':
        case 'Z':
          if (ctrl) {
            e.preventDefault();
            if (shift) {
              redo();
            } else {
              undo();
            }
          }
          break;

        case 'y':
        case 'Y':
          if (ctrl) {
            e.preventDefault();
            redo();
          }
          break;

        // ── Playback ─────────────────────────────────────────────────────────
        case ' ':
          e.preventDefault();
          togglePlayback();
          break;

        case 'j':
        case 'J': {
          e.preventDefault();
          const state = useTimelineStore.getState();
          const currentRate = state.playbackRate;
          if (currentRate > 0) {
            setPlaybackRate(-1);
          } else {
            setPlaybackRate(Math.max(-4, currentRate - 1));
          }
          if (!state.isPlaying) togglePlayback();
          break;
        }

        case 'k':
        case 'K':
          e.preventDefault();
          if (useTimelineStore.getState().isPlaying) {
            togglePlayback();
          }
          setPlaybackRate(1);
          break;

        case 'l':
        case 'L': {
          e.preventDefault();
          const state = useTimelineStore.getState();
          const currentRate = state.playbackRate;
          if (currentRate < 0) {
            setPlaybackRate(1);
          } else {
            setPlaybackRate(Math.min(4, currentRate + 1));
          }
          if (!state.isPlaying) togglePlayback();
          break;
        }

        // ── Frame stepping ───────────────────────────────────────────────────
        case 'ArrowLeft':
          e.preventDefault();
          stepFrame(shift ? -10 : -1);
          break;

        case 'ArrowRight':
          e.preventDefault();
          stepFrame(shift ? 10 : 1);
          break;

        // ── In/Out points (mark region) ──────────────────────────────────────
        case 'i':
        case 'I':
          if (!ctrl) {
            e.preventDefault();
            // Store in-point for future range operations
            // For now, this is a placeholder — will integrate with mark system
          }
          break;

        case 'o':
        case 'O':
          if (!ctrl) {
            e.preventDefault();
            // Store out-point for future range operations
          }
          break;

        // ── Selection ────────────────────────────────────────────────────────
        case 'a':
        case 'A':
          if (ctrl) {
            e.preventDefault();
            const clips = useTimelineStore.getState().getClips();
            const allIds = new Set(clips.map((c) => c.id));
            useTimelineStore.setState({ selectedClipIds: allIds });
          }
          break;

        case 'Escape':
          e.preventDefault();
          deselectAll();
          break;

        // ── Navigation ───────────────────────────────────────────────────────
        case 'Home':
          e.preventDefault();
          setPlayhead(0);
          break;

        case 'End': {
          e.preventDefault();
          const duration = useTimelineStore.getState().getProjectDuration();
          setPlayhead(Math.max(0, duration - 90)); // go near end
          break;
        }

        // ── Zoom ─────────────────────────────────────────────────────────────
        case '=':
        case '+':
          e.preventDefault();
          zoomIn();
          break;

        case '-':
          if (!ctrl) {
            e.preventDefault();
            zoomOut();
          }
          break;

        case '0':
          if (ctrl) {
            e.preventDefault();
            // Fit to window — needs container width, dispatch a custom approach
            useTimelineStore.getState().fitToWindow(window.innerWidth - 112); // approx track label width
          }
          break;
      }
    },
    [
      splitAtPlayhead, removeSelectedClips, rippleDelete,
      undo, redo, togglePlayback, setPlaybackRate,
      stepFrame, setPlayhead, deselectAll, zoomIn, zoomOut,
    ],
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);
}
