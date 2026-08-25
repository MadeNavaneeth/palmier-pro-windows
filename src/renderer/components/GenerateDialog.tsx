/**
 * GenerateDialog — launch a media generation from the library (PR #406
 * family). Type, prompt, provider/model, duration; progress streams from
 * generation:progress and a settled run is probed into the library like any
 * other import.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import type { MediaProbeResult } from '../../main/ipc/media';

type GenType = 'image' | 'video' | 'audio';

interface ProviderInfo {
  id: string;
  name: string;
  supportedTypes: GenType[];
  configured: boolean;
  models: Record<GenType, string[]>;
}

const TYPE_LABELS: Record<GenType, string> = {
  image: 'Image',
  video: 'Video',
  audio: 'Audio',
};

export function GenerateDialog({
  onClose,
  onImported,
}: {
  onClose: () => void;
  /** Called with the probed asset so the caller can import it. */
  onImported: (asset: MediaProbeResult) => void;
}) {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [type, setType] = useState<GenType>('image');
  const [prompt, setPrompt] = useState('');
  const [providerId, setProviderId] = useState('');
  const [modelId, setModelId] = useState('');
  const [durationSeconds, setDurationSeconds] = useState(5);
  const [running, setRunning] = useState(false);
  const [requestId, setRequestId] = useState('');
  const [progressPercent, setProgressPercent] = useState(0);
  const [progressMessage, setProgressMessage] = useState('');
  const [error, setError] = useState('');

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

    const started = await window.palmier.generation.start({
      type,
      prompt,
      provider: providerId || undefined,
      extra: { model: modelId || undefined },
      ...(type !== 'image' ? { durationSeconds } : {}),
    }) as { success: boolean; id?: string; error?: string };

    if (!started.success || !started.id) {
      setRunning(false);
      setProgressMessage('');
      setError(started.error ?? 'Generation failed to start.');
      return;
    }
    setRequestId(started.id);

    const result = await new Promise<{ outputPath?: string; error?: string }>((resolve) => {
      const unsub = window.palmier.on('generation:complete', (data: unknown) => {
        const r = data as { id?: string; outputPath?: string; error?: string };
        if (r.id !== started.id) return;
        unsub();
        resolve(r);
      });
    });

    setRunning(false);
    setRequestId('');
    setProgressMessage('');

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
    onImported(probed.info);
    onClose();
  }, [type, prompt, providerId, modelId, durationSeconds, onImported, onClose]);

  const cancel = useCallback(async () => {
    if (requestId) await window.palmier.generation.cancel(requestId);
  }, [requestId]);

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
                  onClick={() => setType(t)}
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
              className="rounded border border-red-500/50 px-3 py-1.5 text-xs text-red-400 hover:bg-red-500/10"
            >
              Cancel Generation
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
