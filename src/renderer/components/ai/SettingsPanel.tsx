/**
 * SettingsPanel — BYOK API key management.
 * Provider selection, key input (masked), test connection button.
 * Keys are stored encrypted via Windows DPAPI (Electron safeStorage).
 */

import React, { useState, useCallback, useEffect } from 'react';
import { useAiStore } from '../../store/ai';

export function SettingsPanel() {
  const { showSettings, provider, model } = useAiStore();
  const [apiKey, setApiKey] = useState('');
  const [masked, setMasked] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<'success' | 'error' | null>(null);
  const [selectedProvider, setSelectedProvider] = useState(provider);
  const [selectedModel, setSelectedModel] = useState(model);

  // Check if key exists on mount
  useEffect(() => {
    if (!showSettings) return;
    checkExistingKey();
  }, [showSettings]);

  async function checkExistingKey() {
    const providers = await window.palmier.ai.getProviders();
    if (providers && Array.isArray(providers)) {
      const current = providers.find((p: any) => p.id === selectedProvider);
      if (current?.hasKey) {
        setMasked('••••••••••••' + (current.lastFour || ''));
        useAiStore.setState({ isConfigured: true });
      }
    }
  }

  const handleSaveKey = useCallback(async () => {
    if (!apiKey.trim()) return;
    setTesting(true);
    setTestResult(null);

    try {
      await window.palmier.ai.setApiKey(selectedProvider, apiKey.trim());
      useAiStore.setState({
        isConfigured: true,
        provider: selectedProvider,
        model: selectedModel,
      });
      setMasked('••••••••••••' + apiKey.slice(-4));
      setApiKey('');
      setTestResult('success');
    } catch {
      setTestResult('error');
    } finally {
      setTesting(false);
    }
  }, [apiKey, selectedProvider, selectedModel]);

  const handleClose = () => {
    useAiStore.setState({ showSettings: false });
  };

  if (!showSettings) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-[380px] rounded-lg border border-surface-3 bg-surface-1 p-5 shadow-2xl animate-fade-in">
        <h2 className="text-sm font-medium text-text-primary mb-4">AI Settings</h2>

        {/* Provider */}
        <div className="mb-4">
          <label className="block text-2xs text-text-secondary mb-1.5 uppercase tracking-wide">
            Provider
          </label>
          <div className="flex gap-2">
            <ProviderButton
              label="Anthropic"
              sublabel="Claude"
              selected={selectedProvider === 'anthropic'}
              onClick={() => {
                setSelectedProvider('anthropic');
                setSelectedModel('claude-sonnet-4-20250514');
              }}
            />
            <ProviderButton
              label="OpenAI"
              sublabel="GPT-4"
              selected={selectedProvider === 'openai'}
              onClick={() => {
                setSelectedProvider('openai');
                setSelectedModel('gpt-4o');
              }}
            />
          </div>
        </div>

        {/* Model */}
        <div className="mb-4">
          <label className="block text-2xs text-text-secondary mb-1.5 uppercase tracking-wide">
            Model
          </label>
          <select
            value={selectedModel}
            onChange={(e) => setSelectedModel(e.target.value)}
            className="w-full rounded border border-surface-3 bg-surface-2 px-3 py-1.5 text-xs text-text-primary"
          >
            {selectedProvider === 'anthropic' ? (
              <>
                <option value="claude-sonnet-4-20250514">Claude Sonnet 4</option>
                <option value="claude-opus-4-20250514">Claude Opus 4</option>
                <option value="claude-haiku-4-20250514">Claude Haiku 4</option>
              </>
            ) : (
              <>
                <option value="gpt-4o">GPT-4o</option>
                <option value="gpt-4o-mini">GPT-4o mini</option>
              </>
            )}
          </select>
        </div>

        {/* API Key */}
        <div className="mb-4">
          <label className="block text-2xs text-text-secondary mb-1.5 uppercase tracking-wide">
            API Key
          </label>
          {masked && !apiKey ? (
            <div className="flex items-center gap-2">
              <span className="text-xs text-text-muted font-mono">{masked}</span>
              <button
                onClick={() => setMasked('')}
                className="text-2xs text-accent hover:text-accent-hover"
              >
                Change
              </button>
            </div>
          ) : (
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={selectedProvider === 'anthropic' ? 'sk-ant-...' : 'sk-...'}
              className="w-full rounded border border-surface-3 bg-surface-2 px-3 py-1.5 text-xs text-text-primary font-mono placeholder:text-text-muted focus:border-accent focus:outline-none"
            />
          )}
          <p className="mt-1 text-2xs text-text-muted">
            Encrypted at rest via Windows DPAPI. Never leaves your machine.
          </p>
        </div>

        {/* Test result */}
        {testResult && (
          <div className={`mb-4 rounded px-3 py-2 text-2xs ${
            testResult === 'success'
              ? 'bg-emerald-500/10 border border-emerald-500/30 text-emerald-400'
              : 'bg-red-500/10 border border-red-500/30 text-red-400'
          }`}>
            {testResult === 'success' ? 'Key saved and verified.' : 'Failed to save key. Check the key and try again.'}
          </div>
        )}

        {/* Buttons */}
        <div className="flex justify-end gap-3">
          <button
            onClick={handleClose}
            className="rounded px-3 py-1.5 text-xs text-text-secondary hover:bg-surface-3 transition"
          >
            {useAiStore.getState().isConfigured ? 'Done' : 'Cancel'}
          </button>
          {(!masked || apiKey) && (
            <button
              onClick={handleSaveKey}
              disabled={!apiKey.trim() || testing}
              className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover transition disabled:opacity-40"
            >
              {testing ? 'Saving...' : 'Save Key'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function ProviderButton({
  label,
  sublabel,
  selected,
  onClick,
}: {
  label: string;
  sublabel: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 rounded border px-3 py-2 text-left transition ${
        selected
          ? 'border-accent bg-accent/10'
          : 'border-surface-3 bg-surface-2 hover:border-surface-4'
      }`}
    >
      <span className={`block text-xs font-medium ${selected ? 'text-accent' : 'text-text-primary'}`}>
        {label}
      </span>
      <span className="block text-2xs text-text-muted">{sublabel}</span>
    </button>
  );
}
