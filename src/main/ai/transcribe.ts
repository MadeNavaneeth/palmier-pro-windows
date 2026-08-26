/**
 * Audio transcription over OpenAI-compatible /audio/transcriptions
 * (#39 groundwork: the caption pipeline's engine, riding the BYOK
 * infrastructure from #17/#140 — OpenAI and Groq both serve whisper models
 * on this exact contract).
 *
 * Requests word-level timestamps so planCaptions can snap cues to real word
 * boundaries (#91). Pure transport: endpoint + key are injected by the
 * caller, keeping this module free of Electron and unit-testable.
 */

import { promises as fs } from 'fs';
import path from 'path';
import type { WordTiming } from '../../shared/captions/planner';

export interface TranscribeRuntime {
  baseUrl: string;
  apiKey: string;
}

export interface TranscribeOptions {
  /** Whisper-family model id. Default "whisper-1" (Groq: "whisper-large-v3"). */
  model?: string;
  /** ISO-639-1 hint, e.g. "en". Omit for auto-detect. */
  language?: string;
}

export interface TranscriptionResult {
  text: string;
  words: WordTiming[];
  /** Segment-level timings when the endpoint provides them (fallback cues). */
  segments: Array<{ startSec: number; endSec: number; text: string }>;
  model: string;
}

interface VerboseJsonResponse {
  text?: string;
  words?: Array<{ word?: string; start?: number; end?: number }>;
  segments?: Array<{ start?: number; end?: number; text?: string }>;
}

const ACCEPTED_AUDIO_EXT = new Set([
  '.mp3', '.mp4', '.m4a', '.wav', '.webm', '.ogg', '.flac',
]);

export async function transcribeAudio(
  runtime: TranscribeRuntime,
  filePath: string,
  options: TranscribeOptions = {},
): Promise<TranscriptionResult> {
  const model = options.model ?? 'whisper-1';
  const ext = path.extname(filePath).toLowerCase();
  if (!ACCEPTED_AUDIO_EXT.has(ext)) {
    throw new Error(`Unsupported audio container "${ext}" for transcription.`);
  }

  const fileBuffer = await fs.readFile(filePath);
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(fileBuffer)]), path.basename(filePath));
  form.append('model', model);
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'word');
  form.append('timestamp_granularities[]', 'segment');
  if (options.language) form.append('language', options.language);

  const base = runtime.baseUrl.replace(/\/+$/, '');
  const response = await fetch(`${base}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${runtime.apiKey}` },
    body: form,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `Transcription failed (${response.status}): ${body.slice(0, 300) || response.statusText}`,
    );
  }

  const payload = await response.json() as VerboseJsonResponse;
  const words = (payload.words ?? [])
    .map((w) => ({
      word: (w.word ?? '').trim(),
      startSec: Number(w.start),
      endSec: Number(w.end),
    }))
    .filter((w) => w.word.length > 0 && Number.isFinite(w.startSec) && Number.isFinite(w.endSec))
    .sort((a, b) => a.startSec - b.startSec);

  const segments = (payload.segments ?? []).map((s) => ({
    startSec: Number(s.start ?? 0),
    endSec: Number(s.end ?? 0),
    text: (s.text ?? '').trim(),
  }));

  return {
    text: payload.text ?? '',
    words,
    segments,
    model,
  };
}
