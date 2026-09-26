/**
 * GenerateDialog - launch a media generation from the library (PR #406
 * family). Type, prompt, reference image, provider/model, duration; progress
 * streams from generation:progress and a settled run is probed into the
 * library like any other import.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import { nanoid } from 'nanoid';
import type { MediaProbeResult } from '../../main/ipc/media';
import type { MediaAsset } from '../../shared/types/project';
import { secondsToProjectFrames } from '../../shared/media/source-time';
import { useTimelineStore } from '../store/timeline';

type GenType = 'image' | 'video' | 'audio';

interface ProviderInfo {
  id: string;
  name: string;
  supportedTypes: GenType[];
  configured: boolean;
  cancellationSupport?: 'remote' | 'local-only';
  models: Record<GenType, string[]>;
}

const TYPE_LABELS: Record<GenType, string> = {
  image: 'Image',
  video: 'Video',
  audio: 'Audio',
};

/** Complete a successful provider result into the same frame-valued model as ordinary imports. */
export function generatedMediaAssetFromProbe(
  probe: MediaProbeResult,
  generatedBy: NonNullable<MediaAsset['generatedBy']>,
  projectFps: number,
): MediaAsset {
  return {
    id: nanoid(),
    ...probe,
    duration: Math.max(0, secondsToProjectFrames(probe.duration, projectFps)),
    addedAt: new Date().toISOString(),
    generatedBy: {
      provider: generatedBy.provider,
      model: generatedBy.model,
      ...(typeof generatedBy.costCredits === 'number' && Number.isFinite(generatedBy.costCredits)
        ? { costCredits: generatedBy.costCredits }
        : {}),
      ...(typeof generatedBy.referenceImagePath === 'string' && generatedBy.referenceImagePath.trim().length > 0
        ? { referenceImagePath: generatedBy.referenceImagePath }
        : {}),
    },
  };
}

/**
 * Library assets offered as a generation reference, in library order. Only an
 * image can be one, and the source path is what the provider receives — the
 * same file the asset was imported from.
 */
export function referenceImageChoices(assets: MediaAsset[]): MediaAsset[] {
  return assets.filter((asset) => asset.type === 'image');
}

/**
 * The `generation:start` payload for the dialog's current state. A reference is
 * only sent for image generation (the video/audio models read no image input),
 * and an unselected reference is omitted entirely, so a text-to-image run sends
 * exactly what it sent before the field existed.
 */
export function generationStartRequest(state: {
  type: GenType;
  prompt: string;
  providerId: string;
  modelId: string;
  durationSeconds: number;
  referenceImagePath: string;
}): Record<string, unknown> {
  const reference = state.type === 'image' ? state.referenceImagePath : '';
  return {
    type: state.type,
    prompt: state.prompt,
    provider: state.providerId || undefined,
    extra: { model: state.modelId || undefined },
    ...(state.type !== 'image' ? { durationSeconds: state.durationSeconds } : {}),
    ...(reference ? { referenceImagePath: reference } : {}),
  };
}

export function GenerateDialog({
  projectFps,
  onClose,
  onImported,
}: {
  projectFps: number;
  onClose: () => void;
  /** Called with the completed, provenance-bearing library asset. */
  onImported: (asset: MediaAsset) => void;
}) {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [type, setType] = useState<GenType>('image');
  const [prompt, setPrompt] = useState('');
  const [referenceId, setReferenceId] = useState('');
  const [providerId, setProviderId] = useState('');
  const [modelId, setModelId] = useState('');
  const [durationSeconds, setDurationSeconds] = useState(5);
  const [running, setRunning] = useState(false);
  const [requestId, setRequestId] = useState('');
  const cancelWaiters = useRef(new Map<string, () => void>());
  const [progressPercent, setProgressPercent] = useState(0);
  const [progressMessage, setProgressMessage] = useState('');
  const [error, setError] = useState('');

  // Reference candidates come from the library: an image already in the bin is
  // the one picture the user can point a generation at without a file dialog.
  const media = useTimelineStore((state) => state.project.media);
  const referenceChoices = useMemo(() => referenceImageChoices(media), [media]);
  const referencePath = referenceChoices.find((asset) => asset.id === referenceId)?.path ?? '';

  // Configured providers only — an unconfigured row cannot produce output.
  useEffect(() => {
    void window.palmier.generation.providers().then((res) => {
      const typed = res as { success: boolean; providers?: ProviderInfo[] };
      const usable = (typed.providers ?? []).filter(
        (p) => p.configured && p.supportedTypes.includes(type),
      );
      setProviders(usable);
      setLoaded(true);
    }).catch(() => setLoaded(true));
  }, [type]);

  // Default the provider whenever the usable list changes shape.
  useEffect(() => {
    if (!providers.some((p) => p.id === providerId)) setProviderId(providers[0]?.id ?? '');
  }, [providers, providerId]);

  // Reset the model when provider/type changes; default to catalog head.
  useEffect(() => {
    const provider = providers.find((p) => p.id === providerId);
    const models = provider?.models[type] ?? [];
    if (!models.includes(modelId)) setModelId(models[0] ?? '');
  }, [providerId, type, providers, modelId]);

  // Live progress for the in-flight request.
  useEffect(() => {
    if (!requestId) return;
    const unsub = window.palmier.on('generation:progress', (data: unknown) => {
      const p = data as { id?: string; percent?: number; message?: string };
      if (p.id !== requestId) return;
      setProgressPercent(p.percent ?? 0);
      if (p.message) setProgressMessage(p.message);
    });
    return unsub;
  }, [requestId]);

  const submit = useCallback(async () => {
    setError('');
    setRunning(true);
    setProgressPercent(0);
    setProgressMessage('Submitting…');

    const started = await window.palmier.generation.start(generationStartRequest({
      type,
      prompt,
      providerId,
      modelId,
      durationSeconds,
      referenceImagePath: referencePath,
    })) as { success: boolean; id?: string; error?: string };

    if (!started.success || !started.id) {
      setRunning(false);
      setProgressMessage('');
      setError(started.error ?? 'Generation failed to start.');
      return;
    }
    const startedId = started.id;
    setRequestId(startedId);

    const result = await new Promise<{
      outputPath?: string;
      costCredits?: number;
      error?: string;
      cancelled?: boolean;
    }>((resolve) => {
      let settled = false;
      let unsubProgress = () => {};
      let unsubComplete = () => {};
      const finish = (value: {
        outputPath?: string;
        costCredits?: number;
        error?: string;
        cancelled?: boolean;
      }) => {
        if (settled) return;
        settled = true;
        unsubProgress();
        unsubComplete();
        cancelWaiters.current.delete(startedId);
        resolve(value);
      };

      // A timeout is a terminal local failure, not a late provider result.
      unsubProgress = window.palmier.on('generation:progress', (data: unknown) => {
        const p = data as { id?: string; status?: string; message?: string };
        if (p.id !== startedId || p.status !== 'failed') return;
        finish({ error: p.message ?? 'Generation timed out.' });
      });
      unsubComplete = window.palmier.on('generation:complete', (data: unknown) => {
        const r = data as {
          id?: string;
          outputPath?: string;
          costCredits?: number;
          error?: string;
        };
        if (r.id !== startedId) return;
        finish(r);
      });
      cancelWaiters.current.set(startedId, () => finish({ cancelled: true }));
    });

    setRunning(false);
    setRequestId('');
    setProgressMessage('');

    if (result.cancelled) return;

    if (!result.outputPath) {
      setError(result.error ?? 'Generation produced no output.');
      return;
    }

    const probed = await window.palmier.media.probe(result.outputPath) as {
      success: boolean; info?: MediaProbeResult; error?: string;
    };
    if (!probed.success || !probed.info) {
      setError(probed.error ?? 'Generated file could not be read.');
      return;
    }
    onImported(generatedMediaAssetFromProbe(probed.info, {
      provider: providerId,
      model: modelId,
      costCredits: result.costCredits,
      referenceImagePath: referencePath,
    }, projectFps));
    onClose();
  }, [type, prompt, providerId, modelId, durationSeconds, referencePath, projectFps, onImported, onClose]);

  const cancel = useCallback(async () => {
    if (!requestId) return;
    // The dialog stops waiting immediately. The main process independently
    // suppresses any late completion, so neither path can probe/import it.
    cancelWaiters.current.get(requestId)?.();

    const provider = providers.find((p) => p.id === providerId);
    try {
      const response = await window.palmier.generation.cancel(requestId) as {
        success: boolean;
        remoteCancellation?: 'confirmed' | 'unsupported' | 'pending' | 'failed' | 'not-found';
        error?: string;
      };
      if (!response.success) {
        setError(response.error ?? 'Generation cancellation failed.');
      } else if (response.remoteCancellation === 'unsupported') {
        setError(
          `Stopped waiting, but ${provider?.name ?? 'The provider'} has no remote cancel API. `
          + 'Its job may continue and incur provider charges.',
        );
      } else if (response.remoteCancellation === 'failed') {
        setError(
          `Stopped waiting, but remote cancellation was not confirmed${response.error ? `: ${response.error}` : '.'}`,
        );
      } else if (response.remoteCancellation === 'pending') {
        setError('Stopped waiting. Remote cancellation is pending the provider job id.');
      }
    } catch {
      setError('Stopped waiting, but the provider could not be contacted to cancel remotely.');
    }
  }, [providerId, providers, requestId]);

  const remoteCancellationUnavailable = providers.find((p) => p.id === providerId)
    ?.cancellationSupport === 'local-only';

  const canSubmit = loaded
    && !running
    && prompt.trim().length > 0
    && Boolean(providerId)
    && Boolean(modelId);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="generate-title"
        className="w-[400px] rounded-lg border border-surface-3 bg-surface-1 shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
          <h2 id="generate-title" className="text-sm font-medium text-text-primary">
            AI Generate
          </h2>
          <button onClick={onClose} aria-label="Close" className="rounded p-0.5 text-text-muted hover:bg-white/10 hover:text-text-primary">
            <X size={14} />
          </button>
        </div>

        <div className="space-y-3 px-4 py-3">
          <Field label="Type">
            <div className="flex gap-1.5">
              {(Object.keys(TYPE_LABELS) as GenType[]).map((t) => (
                <button
                  key={t}
                  disabled={running}
                  onClick={() => {
                    setType(t);
                    // Only image models read a reference, so leaving the type
                    // drops the selection rather than carrying it invisibly.
                    if (t !== 'image') setReferenceId('');
                  }}
                  className={`flex-1 rounded border px-2 py-1 text-[11px] transition ${
                    type === t
                      ? 'border-accent bg-accent/10 text-accent'
                      : 'border-surface-3 bg-surface-2 text-text-secondary hover:border-surface-4'
                  }`}
                >
                  {TYPE_LABELS[t]}
                </button>
              ))}
            </div>
          </Field>

          <Field label="Prompt">
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              rows={3}
              maxLength={2000}
              placeholder="Describe what to generate…"
              className="w-full resize-none rounded border border-surface-3 bg-surface-2 px-2 py-1.5 text-[11px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
            />
          </Field>

          {type === 'image' && referenceChoices.length > 0 && (
            <Field label="Reference image">
              <select
                value={referenceId}
                onChange={(event) => setReferenceId(event.target.value)}
                className="w-full rounded border border-surface-3 bg-surface-2 px-2 py-1 text-[11px] text-text-primary focus:border-accent focus:outline-none"
              >
                <option value="">None (text-to-image)</option>
                {referenceChoices.map((asset) => (
                  <option key={asset.id} value={asset.id} className="bg-surface-2">{asset.filename}</option>
                ))}
              </select>
            </Field>
          )}

          <Field label="Provider">
            <select
              value={providerId}
              onChange={(event) => setProviderId(event.target.value)}
              className="w-full rounded border border-surface-3 bg-surface-2 px-2 py-1 text-[11px] text-text-primary focus:border-accent focus:outline-none"
            >
              {providers.length === 0 && <option value="">No configured providers</option>}
              {providers.map((p) => (
                <option key={p.id} value={p.id} className="bg-surface-2">{p.name}</option>
              ))}
            </select>
          </Field>

          {modelId && (
            <Field label="Model">
              <select
                value={modelId}
                onChange={(event) => setModelId(event.target.value)}
                className="w-full rounded border border-surface-3 bg-surface-2 px-2 py-1 font-mono text-[11px] text-text-primary focus:border-accent focus:outline-none"
              >
                {(providers.find((p) => p.id === providerId)?.models[type] ?? []).map((m) => (
                  <option key={m} value={m} className="bg-surface-2">{m}</option>
                ))}
              </select>
            </Field>
          )}

          {type !== 'image' && (
            <Field label={`Duration · ${durationSeconds}s`}>
              <input
                type="range"
                min={1}
                max={30}
                step={1}
                value={durationSeconds}
                disabled={running}
                onChange={(event) => setDurationSeconds(Number(event.target.value))}
                className="w-full accent-[var(--color-accent)]"
              />
            </Field>
          )}

          {running && (
            <div>
              <div className="mb-1 flex justify-between text-[10px] text-text-secondary">
                <span>{progressMessage || 'Generating…'}</span>
                <span>{progressPercent}%</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-surface-3">
                <div className="h-full bg-accent transition-all" style={{ width: `${progressPercent}%` }} />
              </div>
            </div>
          )}

          {error && (
            <p role="alert" className="rounded border border-red-500/30 bg-red-500/10 px-2 py-1.5 text-[10px] text-red-400">
              {error}
            </p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-white/10 px-4 py-3">
          {running ? (
            <button
              onClick={() => void cancel()}
              title={remoteCancellationUnavailable
                ? 'This provider has no remote cancel API. The provider job may continue.'
                : undefined}
              className="rounded border border-red-500/50 px-3 py-1.5 text-xs text-red-400 hover:bg-red-500/10"
            >
              {remoteCancellationUnavailable ? 'Stop Waiting' : 'Cancel Generation'}
            </button>
          ) : (
            <>
              <button
                onClick={onClose}
                className="rounded px-3 py-1.5 text-xs text-text-secondary hover:bg-surface-3"
              >
                Cancel
              </button>
              <button
                onClick={() => void submit()}
                disabled={!canSubmit}
                className="flex items-center gap-1.5 rounded bg-accent px-3 py-1.5 text-xs font-medium text-surface-0 hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
              >
                {running && <Loader2 size={12} className="animate-spin" aria-hidden="true" />}
                Generate
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-[10px] uppercase tracking-wide text-text-secondary">
        {label}
      </label>
      {children}
    </div>
  );
}
