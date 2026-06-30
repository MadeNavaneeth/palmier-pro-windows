/**
 * Audio RMS envelope extraction (for silence detection, #175).
 *
 * Decodes a media file to mono 16 kHz PCM via FFmpeg and computes an RMS
 * amplitude per hop window. The envelope feeds the pure SilenceDetector.
 * Runs entirely on-device — no AI/transcription dependency.
 */

import { spawn } from 'child_process';
import { ipcMain } from 'electron';
import {
  detectSilentRanges,
  DEFAULT_SILENCE_CONFIG,
  type SilenceConfig,
  type SilentRange,
} from '../../shared/audio/silence-detector';

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
    async (_event, filePath: string, config?: Partial<SilenceConfig>) => {
      try {
        const merged: SilenceConfig = { ...DEFAULT_SILENCE_CONFIG, ...(config || {}) };
        const ranges = await detectSilenceForFile(filePath, merged);
        return { success: true, ranges };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    },
  );
}
