import { useEffect, useRef, useState } from 'react';
import { asMirroredProject } from '../../shared/ui/detached-panels';
import { useAiStore } from '../store/ai';
import { useUiStore } from '../store/ui';
import { useTimelineStore } from '../store/timeline';

/**
 * Mirror the main-process detached-panel set into the UI store (upstream #286).
 *
 * Main-window only: the main process owns which panels live in their own
 * window, so this reads the set once on boot and then follows every
 * `panels:detached-changed` broadcast — including a detached window closed
 * from its own chrome, which needs no other signal to restore the panel in
 * the workspace.
 */
export function useDetachedPanels(): void {
  const setDetachedPanels = useUiStore((state) => state.setDetachedPanels);
  const detached = useUiStore((state) => state.detached);
  const previousDetached = useRef(detached);

  useEffect(() => {
    let cancelled = false;
    void window.palmier.panels
      .listDetached()
      .then((list) => {
        if (!cancelled) setDetachedPanels(list);
      })
      .catch(() => {
        if (!cancelled) setDetachedPanels([]);
      });
    const off = window.palmier.on('panels:detached-changed', (payload: unknown) => {
      setDetachedPanels(payload);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [setDetachedPanels]);

  // Re-adopt on return: the remounting chat pulls the session again, so turns
  // taken while detached show up in the workspace.
  useEffect(() => {
    const wasDetached = previousDetached.current.includes('agent');
    previousDetached.current = detached;
    if (wasDetached && !detached.includes('agent')) {
      void useAiStore.getState().refreshSession();
    }
  }, [detached]);
}

export type DetachedChatStatus = 'loading' | 'live' | 'unavailable';

/**
 * Adopt the main-process chat session into a detached chat window.
 *
 * Project mirror first, session second, both narrowed: the sync mirror must
 * mount after the project is adopted (see useDetachedProject), and the chat
 * body must mount after the session is adopted, or the window flashes a blank
 * chat. A failed pull reports unavailable so the window can offer a retry.
 */
export function useDetachedChatSession(): { status: DetachedChatStatus; retry: () => void } {
  const [status, setStatus] = useState<DetachedChatStatus>('loading');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const projectResponse: unknown = await window.palmier.editor.getState();
        const project = asMirroredProject(projectResponse);
        if (project === null) {
          if (!cancelled) setStatus('unavailable');
          return;
        }
        try {
          useTimelineStore.getState().controller.loadProject(project);
        } catch {
          if (!cancelled) setStatus('unavailable');
          return;
        }
        const adopted = await useAiStore.getState().refreshSession();
        if (!cancelled) setStatus(adopted ? 'live' : 'unavailable');
      } catch {
        if (!cancelled) setStatus('unavailable');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  return { status, retry: () => setAttempt((count) => count + 1) };
}

export type DetachedProjectStatus = 'loading' | 'live' | 'unavailable';

/**
 * Pull the main-process project into a detached window and report readiness.
 *
 * A detached window's own session never loads a project, so `isLoaded` stays
 * false here forever; "loaded" for this window means "mirrored the main
 * project". The pull is narrowed, and it runs before the editor-sync mirror
 * mounts — otherwise that mirror's initial push would overwrite the
 * main-process project with this window's empty default.
 */
export function useDetachedProject(): DetachedProjectStatus {
  const [status, setStatus] = useState<DetachedProjectStatus>('loading');

  useEffect(() => {
    let cancelled = false;
    window.palmier.editor
      .getState()
      .then((response: unknown) => {
        if (cancelled) return;
        const project = asMirroredProject(response);
        if (project === null) {
          setStatus('unavailable');
          return;
        }
        try {
          // Adopt before the sync mirror mounts (see above); `loadProject`
          // validates by throwing on anything stranger than checked above.
          useTimelineStore.getState().controller.loadProject(project);
          if (!cancelled) setStatus('live');
        } catch {
          if (!cancelled) setStatus('unavailable');
        }
      })
      .catch(() => {
        if (!cancelled) setStatus('unavailable');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return status;
}
