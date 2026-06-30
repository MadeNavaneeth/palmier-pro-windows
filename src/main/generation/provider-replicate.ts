/**
 * Replicate Generation Provider — runs open-source models via API.
 *
 * Supported:
 * - stability-ai/sdxl (text-to-image)
 * - stability-ai/stable-video-diffusion (image-to-video)
 * - meta/musicgen (text-to-audio)
 *
 * Uses the Replicate HTTP API directly.
 */

import type {
  GenerationProvider,
  GenerationRequest,
  GenerationResult,
  GenerationProgress,
  GenerationType,
} from './types';
import { downloadFile } from './util';

const REPLICATE_API = 'https://api.replicate.com/v1';

export class ReplicateProvider implements GenerationProvider {
  readonly id = 'replicate';
  readonly name = 'Replicate';
  readonly supportedTypes: GenerationType[] = ['image', 'video', 'audio'];

  private apiKey: string = '';

  isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  configure(apiKey: string): void {
    this.apiKey = apiKey;
  }

  getModels(type: GenerationType): string[] {
    if (type === 'image') {
      return [
        'stability-ai/sdxl:latest',
        'black-forest-labs/flux-schnell',
      ];
    }
    if (type === 'video') {
      return [
        'stability-ai/stable-video-diffusion:latest',
        'minimax/video-01',
      ];
    }
    if (type === 'audio') {
      return [
        'meta/musicgen:latest',
        'suno-ai/bark:latest',
      ];
    }
    return [];
  }

  async generate(
    request: GenerationRequest,
    onProgress?: (progress: GenerationProgress) => void,
  ): Promise<GenerationResult> {
    const startTime = Date.now();
    const model = (request.extra?.model as string) || this.getModels(request.type)[0];

    onProgress?.({ id: request.id, status: 'pending', percent: 0, message: 'Submitting...' });

    try {
      // Create prediction
      const createResponse = await fetch(`${REPLICATE_API}/predictions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          input: this.buildInput(request),
        }),
      });

      if (!createResponse.ok) {
        const err = await createResponse.text();
        throw new Error(`Replicate create failed (${createResponse.status}): ${err}`);
      }

      const prediction = await createResponse.json();
      let predictionId = prediction.id;

      // Poll for completion
      let result: any = null;
      let attempts = 0;
      const maxAttempts = 600; // 10 min

      while (attempts < maxAttempts) {
        attempts++;
        await sleep(1000);

        const pollResponse = await fetch(`${REPLICATE_API}/predictions/${predictionId}`, {
          headers: { 'Authorization': `Bearer ${this.apiKey}` },
        });

        if (!pollResponse.ok) continue;
        const pollData = await pollResponse.json();

        if (pollData.status === 'succeeded') {
          result = pollData;
          break;
        }
        if (pollData.status === 'failed' || pollData.status === 'canceled') {
          throw new Error(pollData.error || `Prediction ${pollData.status}`);
        }

        const percent = Math.min(90, Math.round((attempts / 60) * 100));
        onProgress?.({
          id: request.id,
          status: 'processing',
          percent,
          message: `${pollData.status}... (${attempts}s)`,
        });
      }

      if (!result) throw new Error('Generation timed out');

      // Extract output URL
      const outputUrl = this.extractOutput(result);
      if (!outputUrl) throw new Error('No output in prediction result');

      onProgress?.({ id: request.id, status: 'processing', percent: 95, message: 'Downloading...' });

      const ext = request.type === 'audio' ? 'wav' : request.type === 'video' ? 'mp4' : 'png';
      const outputPath = await downloadFile(outputUrl, request.id, ext);

      return {
        id: request.id,
        status: 'completed',
        outputPath,
        remoteUrl: outputUrl,
        elapsedMs: Date.now() - startTime,
        metadata: { model, provider: 'replicate', predictionId },
      };
    } catch (err: any) {
      return {
        id: request.id,
        status: 'failed',
        error: err.message,
        elapsedMs: Date.now() - startTime,
      };
    }
  }

  async cancel(requestId: string): Promise<void> {
    try {
      await fetch(`${REPLICATE_API}/predictions/${requestId}/cancel`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${this.apiKey}` },
      });
    } catch { /* best effort */ }
  }

  private buildInput(request: GenerationRequest): Record<string, unknown> {
    const input: Record<string, unknown> = { prompt: request.prompt };
    if (request.width) input.width = request.width;
    if (request.height) input.height = request.height;
    if (request.negativePrompt) input.negative_prompt = request.negativePrompt;
    if (request.durationSeconds) input.duration = request.durationSeconds;
    if (request.referenceImagePath) input.image = request.referenceImagePath;
    return input;
  }

  private extractOutput(result: any): string | null {
    const output = result.output;
    if (typeof output === 'string') return output;
    if (Array.isArray(output) && output.length > 0) return output[0];
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
