/**
 * SettingsPanel — BYOK provider configuration.
 *
 * Covers upstream #17 (configurable API base URL) and #140 (OpenAI-compatible
 * providers): a preset list for the common endpoints, an editable base URL for
 * anything else, a free-text model field, and the masked key input.
 *
 * Keys are stored encrypted via Windows DPAPI (Electron safeStorage). The base
 * URL is validated here for immediate feedback and again in the main process,
 * which is the boundary that actually matters.
 */

import React, { useState, useCallback, useEffect } from 'react';
import { AlertTriangle, Check, Loader2 } from 'lucide-react';
import { useAiStore } from '../../store/ai';
import {
  PROVIDER_PRESETS,
  presetById,
  validateBaseUrl,
  validateProviderConfig,
} from '../../../shared/ai/provider-config';

interface ProviderInfo {
  id: string;
  name: string;
  requiresApiKey: boolean;
  hint?: string;
  hasKey: boolean;
  lastFour: string;
  baseUrl: string;
  model: string;
}

type SaveState =
  | { status: 'idle' }
  | { status: 'saving' }
  | { status: 'saved' }
  | { status: 'error'; message: string };

export function SettingsPanel() {
  const showSettings = useAiStore((state) => state.showSettings);
  const providerId = useAiStore((state) => state.providerId);

  const [selectedId, setSelectedId] = useState(providerId);
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [storedKeySuffix, setStoredKeySuffix] = useState('');
  const [replacingKey, setReplacingKey] = useState(false);
  const [save, setSave] = useState<SaveState>({ status: 'idle' });

  const preset = presetById(selectedId);

  // Load the persisted configuration for the selected provider whenever the
  // panel opens or the selection changes.
  useEffect(() => {
    if (!showSettings) return;
    let cancelled = false;

    void (async () => {
      try {
        const providers = (await window.palmier.ai.getProviders()) as ProviderInfo[] | undefined;
        if (cancelled || !Array.isArray(providers)) return;
        const current = providers.find((entry) => entry.id === selectedId);
        setBaseUrl(current?.baseUrl ?? preset?.baseUrl ?? '');
        setModel(current?.model ?? preset?.defaultModel ?? '');
        setStoredKeySuffix(current?.hasKey ? current.lastFour : '');
        setReplacingKey(false);
        setApiKey('');
        setSave({ status: 'idle' });
      } catch (err) {
        if (!cancelled) {
          setSave({ status: 'error', message: 'Could not read the saved AI settings.' });
          console.error('Failed to load AI providers:', err);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [showSettings, selectedId, preset?.baseUrl, preset?.defaultModel]);

  const urlCheck = preset?.kind === 'openai-compatible' || baseUrl.trim().length > 0
    ? validateBaseUrl(baseUrl)
    : null;
  const urlError = urlCheck && !urlCheck.ok ? urlCheck.reason : null;
  const isLoopback = urlCheck?.ok ? urlCheck.isLoopback : false;
  const needsKey = (preset?.requiresApiKey ?? true) && !storedKeySuffix && !apiKey.trim();

  const handleSave = useCallback(async () => {
    if (!preset) return;
    setSave({ status: 'saving' });

    const validated = validateProviderConfig({
      kind: preset.kind,
      baseUrl: baseUrl.trim() || undefined,
      model,
    });
    if (!validated.ok) {
      setSave({ status: 'error', message: validated.reason });
      return;
    }

    try {
      const configResult = await window.palmier.ai.setProviderConfig(selectedId, {
        kind: validated.config.kind,
        baseUrl: validated.config.baseUrl,
        model: validated.config.model,
      });
      if (configResult && configResult.success === false) {
        setSave({ status: 'error', message: configResult.error || 'Could not save the endpoint.' });
        return;
      }

      // Only touch the stored key when the user actually typed one; saving an
      // endpoint change must not clear a working credential.
      if (apiKey.trim()) {
        const keyResult = await window.palmier.ai.setApiKey(selectedId, apiKey.trim());
        if (keyResult && keyResult.success === false) {
          setSave({ status: 'error', message: keyResult.error || 'Could not save the API key.' });
          return;
        }
        setStoredKeySuffix(apiKey.trim().slice(-4));
        setApiKey('');
        setReplacingKey(false);
      }

      useAiStore.setState({
        isConfigured: true,
        providerId: selectedId,
        model: validated.config.model,
      });
      setSave({ status: 'saved' });
    } catch (err) {
      setSave({
        status: 'error',
        message: err instanceof Error ? err.message : 'Could not save AI settings.',
      });
    }
  }, [preset, selectedId, baseUrl, model, apiKey]);

  if (!showSettings) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="ai-settings-title"
        className="flex max-h-full w-[440px] flex-col overflow-hidden rounded-lg border border-surface-3 bg-surface-1 shadow-2xl"
      >
        <h2
          id="ai-settings-title"
          className="shrink-0 border-b border-white/10 px-5 py-3.5 text-sm font-medium text-text-primary"
        >
          AI Settings
        </h2>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <Field label="Provider" htmlFor="ai-provider">
            <select
              id="ai-provider"
              value={selectedId}
              onChange={(event) => setSelectedId(event.target.value)}
              className="w-full rounded border border-surface-3 bg-surface-2 px-3 py-1.5 text-xs text-text-primary focus:border-accent focus:outline-none"
            >
              {PROVIDER_PRESETS.map((entry) => (
                <option key={entry.id} value={entry.id} className="bg-surface-2">
                  {entry.label}
                </option>
              ))}
            </select>
            {preset?.hint && <Hint>{preset.hint}</Hint>}
          </Field>

          <Field
            label={preset?.kind === 'anthropic' ? 'API base URL (optional)' : 'API base URL'}
            htmlFor="ai-base-url"
          >
            <input
              id="ai-base-url"
              type="url"
              inputMode="url"
              spellCheck={false}
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder={
                preset?.kind === 'anthropic'
                  ? 'Leave blank for the default Anthropic API'
                  : 'https://host/v1'
              }
              aria-invalid={Boolean(urlError)}
              aria-describedby={urlError ? 'ai-base-url-error' : undefined}
              className={`w-full rounded border bg-surface-2 px-3 py-1.5 font-mono text-xs text-text-primary placeholder:text-text-muted focus:outline-none ${
                urlError ? 'border-red-500/60' : 'border-surface-3 focus:border-accent'
              }`}
            />
            {urlError ? (
              <p id="ai-base-url-error" className="mt-1 text-[10px] text-red-400">
                {urlError}
              </p>
            ) : (
              <Hint>
                {isLoopback
                  ? 'Local endpoint. Requests stay on this machine.'
                  : 'Requests include your prompt and the project timeline structure.'}
              </Hint>
            )}
          </Field>

          <Field label="Model" htmlFor="ai-model">
            <input
              id="ai-model"
              type="text"
              spellCheck={false}
              value={model}
              onChange={(event) => setModel(event.target.value)}
              placeholder={preset?.defaultModel || 'model-name'}
              className="w-full rounded border border-surface-3 bg-surface-2 px-3 py-1.5 font-mono text-xs text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
            />
            <Hint>Any model id the endpoint accepts.</Hint>
          </Field>

          <Field
            label={preset?.requiresApiKey ? 'API key' : 'API key (optional)'}
            htmlFor="ai-api-key"
          >
            {storedKeySuffix && !replacingKey ? (
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs text-text-muted">
                  {'\u2022'.repeat(12)}
                  {storedKeySuffix}
                </span>
                <button
                  onClick={() => setReplacingKey(true)}
                  className="text-[10px] text-accent hover:text-accent-hover"
                >
                  Change
                </button>
              </div>
            ) : (
              <input
                id="ai-api-key"
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder={preset?.kind === 'anthropic' ? 'sk-ant-...' : 'sk-...'}
                className="w-full rounded border border-surface-3 bg-surface-2 px-3 py-1.5 font-mono text-xs text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
              />
            )}
            <Hint>
              {preset?.requiresApiKey
                ? 'Encrypted at rest via Windows DPAPI. Sent only to the endpoint above.'
                : 'Local runtimes usually ignore this. Leave it blank unless yours needs one.'}
            </Hint>
          </Field>

          {!isLoopback && !urlError && (
            <div className="flex gap-2 rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[10px] text-amber-300">
              <AlertTriangle size={13} className="mt-px shrink-0" aria-hidden="true" />
              <span>
                This endpoint is on the internet. Your prompts and the project&apos;s timeline
                structure are sent to it when you use the assistant.
              </span>
            </div>
          )}

          <GenerationProvidersSection />

          {save.status === 'error' && (
            <p role="alert" className="rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-[10px] text-red-400">
              {save.message}
            </p>
          )}
          {save.status === 'saved' && (
            <p className="flex items-center gap-1.5 rounded border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-[10px] text-emerald-400">
              <Check size={12} aria-hidden="true" />
              Settings saved.
            </p>
          )}
        </div>

        <div className="flex shrink-0 justify-end gap-3 border-t border-white/10 px-5 py-3">
          <button
            onClick={() => useAiStore.setState({ showSettings: false })}
            className="rounded px-3 py-1.5 text-xs text-text-secondary transition hover:bg-surface-3"
          >
            {useAiStore.getState().isConfigured ? 'Done' : 'Cancel'}
          </button>
          <button
            onClick={() => void handleSave()}
            disabled={
              save.status === 'saving' || Boolean(urlError) || !model.trim() || needsKey
            }
            className="flex items-center gap-1.5 rounded bg-accent px-3 py-1.5 text-xs font-medium text-surface-0 transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            {save.status === 'saving' && (
              <Loader2 size={12} className="animate-spin" aria-hidden="true" />
            )}
            {save.status === 'saving' ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label
        htmlFor={htmlFor}
        className="mb-1.5 block text-[10px] uppercase tracking-wide text-text-secondary"
      >
        {label}
      </label>
      {children}
    </div>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return <p className="mt-1 text-[10px] text-text-muted">{children}</p>;
}

// ─── Media generation providers (upstream PR #406 family) ───────────────────

interface GenerationProviderInfo {
  id: string;
  name: string;
  supportedTypes: string[];
  configured: boolean;
}

function GenerationProvidersSection() {
  const [providers, setProviders] = useState<GenerationProviderInfo[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savedId, setSavedId] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await window.palmier.generation.providers() as {
        success: boolean;
        providers?: GenerationProviderInfo[];
      };
      if (res.success && Array.isArray(res.providers)) setProviders(res.providers);
    } catch (err) {
      console.error('Failed to load generation providers:', err);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const saveKey = useCallback(async (id: string) => {
    const key = drafts[id]?.trim();
    if (!key) return;
    setError('');
    try {
      const res = await window.palmier.generation.setKey(id, key) as { success: boolean; error?: string };
      if (!res.success) {
        setError(res.error || 'Could not save the key.');
        return;
      }
      setDrafts((current) => ({ ...current, [id]: '' }));
      setSavedId(id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the key.');
    }
  }, [drafts, load]);

  return (
    <div className="border-t border-white/10 pt-3">
      <label className="mb-1.5 block text-[10px] uppercase tracking-wide text-text-secondary">
        Media generation
      </label>
      <Hint>
        Keys for generate_media — the assistant can create images, videos, and audio
        into your library. Encrypted at rest via Windows DPAPI.
      </Hint>

      {providers === null ? (
        <p className="mt-2 text-[10px] text-text-muted">Loading providers…</p>
      ) : (
        <div className="mt-1.5 space-y-1.5">
          {providers.map((provider) => (
            <div key={provider.id} className="rounded border border-surface-3 bg-surface-2 px-2 py-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-medium text-text-primary">{provider.name}</span>
                <span
                  className={`flex items-center gap-1 text-[9px] ${provider.configured ? 'text-emerald-400' : 'text-text-muted'}`}
                  title={provider.configured ? 'API key saved' : 'No API key'}
                >
                  {provider.configured && <Check size={11} aria-hidden="true" />}
                  {provider.supportedTypes.join(' · ')}
                </span>
              </div>
              <div className="mt-1 flex items-center gap-2">
                <input
                  type="password"
                  autoComplete="off"
                  value={drafts[provider.id] ?? ''}
                  onChange={(event) =>
                    setDrafts((current) => ({ ...current, [provider.id]: event.target.value }))}
                  placeholder={
                    provider.configured ? 'Replace API key' : `Paste ${provider.name} key`
                  }
                  aria-label={`${provider.name} API key`}
                  className="min-w-0 flex-1 rounded border border-surface-3 bg-surface-1 px-2 py-1 font-mono text-[10px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
                />
                <button
                  onClick={() => void saveKey(provider.id)}
                  disabled={!drafts[provider.id]?.trim()}
                  data-generation-save={provider.id}
                  className="shrink-0 rounded border border-surface-4 px-2 py-1 text-[10px] text-text-secondary transition hover:bg-surface-3 hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {savedId === provider.id ? 'Saved' : 'Save'}
                </button>
              </div>
            </div>
          ))}
          {error && (
            <p role="alert" className="rounded border border-red-500/30 bg-red-500/10 px-2 py-1.5 text-[10px] text-red-400">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
