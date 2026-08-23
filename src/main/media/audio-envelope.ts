/**
 * Audio RMS envelope extraction (for silence detection, #175).
 *
 * Decodes a media file to mono 16 kHz PCM via FFmpeg and computes an RMS
 * amplitude per hop window. The envelope feeds the pure SilenceDetector.
 * Runs entirely on-device — no AI/transcription dependency.
 */

import { spawn, execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
import { ipcMain } from 'electron';
import {
  detectSilentRanges,
  resolveSilenceConfig,
  DEFAULT_SILENCE_CONFIG,
  SILENCE_LIMITS,
  type SilenceConfig,
  type SilentRange,
} from '../../shared/audio/silence-detector';
import { loadSilenceSettings, saveSilenceSettings } from './silence-settings';
import { bucketPeaks } from '../../shared/audio/waveform';

const SAMPLE_RATE = 16000;
const DEFAULT_HOP_MS = 20;

export interface RmsEnvelope {
  envelope: number[]; // RMS per hop, normalized [0, 1]
  hopSeconds: number;
}

/**
 * Extract an RMS envelope by streaming mono 16 kHz signed-16-bit PCM from FFmpeg.
 */
export function extractRmsEnvelope(filePath: string, hopMs = DEFAULT_HOP_MS): Promise<RmsEnvelope> {
  const hopSamples = Math.max(1, Math.round((SAMPLE_RATE * hopMs) / 1000));
  const hopSeconds = hopSamples / SAMPLE_RATE;

  return new Promise((resolve, reject) => {
    const proc = spawn(
      'ffmpeg',
      ['-i', filePath, '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', '-v', 'quiet', 'pipe:1'],
      { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
    );

    const envelope: number[] = [];
    let leftover: Buffer = Buffer.alloc(0);
    // Accumulator state across chunks for the current hop window.
    let sumSquares = 0;
    let countInHop = 0;

    proc.stdout.on('data', (chunk: Buffer) => {
      const buf = leftover.length ? Buffer.concat([leftover, chunk]) : chunk;
      const usable = buf.length - (buf.length % 2); // whole 16-bit samples
      for (let i = 0; i < usable; i += 2) {
        const sample = buf.readInt16LE(i) / 32768; // normalize to [-1, 1]
        sumSquares += sample * sample;
        countInHop++;
        if (countInHop >= hopSamples) {
          envelope.push(Math.sqrt(sumSquares / countInHop));
          sumSquares = 0;
          countInHop = 0;
        }
      }
      leftover = buf.subarray(usable);
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`FFmpeg envelope extraction failed (code ${code})`));
        return;
      }
      // Flush a partial final hop.
      if (countInHop > 0) {
        envelope.push(Math.sqrt(sumSquares / countInHop));
      }
      resolve({ envelope, hopSeconds });
    });

    proc.on('error', reject);

    // Hard cap so a pathological file can't run forever.
    setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error('Audio envelope extraction timed out'));
    }, 120000);
  });
}

/**
 * Extract the envelope and detect silent ranges in one call.
 * Returns silent spans in SOURCE seconds.
 */
export async function detectSilenceForFile(
  filePath: string,
  config: SilenceConfig = DEFAULT_SILENCE_CONFIG,
): Promise<SilentRange[]> {
  const { envelope, hopSeconds } = await extractRmsEnvelope(filePath);
  return detectSilentRanges(envelope, hopSeconds, config);
}

export function registerAudioHandlers(): void {
  ipcMain.handle(
    'audio:detect-silence',
    async (_event, filePath: unknown, config?: Partial<SilenceConfig>) => {
      // Validated here rather than trusted: a non-string path would otherwise
      // reach FFmpeg's argument list, and a partial config used to be spread
      // over the built-in defaults, so an out-of-range threshold produced an
      // envelope scan that reported the whole clip silent.
      if (typeof filePath !== 'string' || filePath.length === 0) {
        return { success: false, error: 'No media file supplied.' };
      }
      try {
        const resolved = resolveSilenceConfig(loadSilenceSettings(), config);
        const ranges = await detectSilenceForFile(filePath, resolved);
        return { success: true, ranges };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    },
  );

  // ─── Saved controls (upstream PR #426) ──────────────────────────────────────
  ipcMain.handle('audio:get-silence-settings', () => ({
    success: true,
    settings: loadSilenceSettings(),
    limits: SILENCE_LIMITS,
    defaults: DEFAULT_SILENCE_CONFIG,
  }));

  // ─── Waveform peaks for timeline audio rendering (R1 lane states) ──────────
  ipcMain.handle('audio:waveform', async (_event, filePath: unknown, buckets?: unknown) => {
    if (typeof filePath !== 'string' || filePath.length === 0) {
      return { success: false, error: 'No media file supplied.' };
    }
    const count = Math.min(512, Math.max(8, Math.floor(Number(buckets)) || 128));
    try {
      const { envelope } = await extractRmsEnvelope(filePath);
      return { success: true, peaks: bucketPeaks(envelope, count) };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // ─── Volume analysis for normalization (R5) ────────────────────────────────
  ipcMain.handle('audio:volume-analysis', async (_event, filePath: unknown) => {
    if (typeof filePath !== 'string' || filePath.length === 0) {
      return { success: false, error: 'No media file supplied.' };
    }
    try {
      const { stderr } = await execFileAsync(
        'ffmpeg',
        ['-i', filePath, '-af', 'volumedetect', '-f', 'null', '-'],
      );
      // volumedetect writes its summary to stderr
      const output = typeof stderr === 'string' ? stderr : '';
      const maxMatch = output.match(/max_volume:\s*(-?[\d.]+)\s*dB/);
      const meanMatch = output.match(/mean_volume:\s*(-?[\d.]+)\s*dB/);
      if (!maxMatch) {
        return { success: false, error: 'No audio stream detected.' };
      }
      return {
        success: true,
        maxVolumeDb: parseFloat(maxMatch[1]),
        meanVolumeDb: meanMatch ? parseFloat(meanMatch[1]) : null,
      };
    } catch (err: any) {
      const message = err?.message ?? 'Volume analysis failed.';
      return { success: false, error: message };
    }
  });

  ipcMain.handle('audio:set-silence-settings', (_event, update?: Partial<SilenceConfig>) => ({
    success: true,
    settings: saveSilenceSettings(update),
  }));
}
