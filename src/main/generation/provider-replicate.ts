/**
 * Replicate Generation Provider — runs open-source models via API.
 *
 * Supported (including free-tier open models):
 * - stability-ai/sdxl, flux-schnell, flux-dev, realvisxl, stable-diffusion-3 (image)
 * - stability-ai/stable-video-diffusion, minimax, luma (video)
 * - meta/musicgen, suno/bark (audio)
 *
 * Uses the Replicate HTTP API directly.
 */

import type {
  GenerationExecutionContext,
  GenerationProvider,
  GenerationRequest,
  GenerationResult,
  GenerationProgress,
  GenerationType,
} from './types';
import { downloadFile, sleep } from './util';
import { encodeReferenceImage } from './reference-image';

const REPLICATE_API = 'https://api.replicate.com/v1';

export class ReplicateProvider implements GenerationProvider {
  readonly id = 'replicate';
  readonly name = 'Replicate';
  readonly supportedTypes: GenerationType[] = ['image', 'video', 'audio'];
  readonly cancellationSupport = 'remote' as const;

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
        'black-forest-labs/flux-dev',
        'adirik/realvisxl-v3-multi-controlnet-lora',
        'stability-ai/stable-diffusion-3',
      ];
    }
    if (type === 'video') {
      return [
        'stability-ai/stable-video-diffusion:latest',
        'minimax/video-01',
        'luma/dream-machine',
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
    execution?: GenerationExecutionContext,
  ): Promise<GenerationResult> {
    const startTime = Date.now();
    const model = (request.extra?.model as string) || this.getModels(request.type)[0];

    onProgress?.({ id: request.id, status: 'pending', percent: 0, message: 'Submitting...' });

    try {
      // Built before submitting: a reference that cannot be encoded must cost
      // no provider call. Replicate reads image inputs as URLs or data URIs,
      // never as a local path.
      const input = await this.buildInput(request, model);

      // Create prediction
      const createResponse = await fetch(`${REPLICATE_API}/predictions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          input,
        }),
        signal: execution?.signal,
      });

      if (!createResponse.ok) {
        const err = await createResponse.text();
        throw new Error(`Replicate create failed (${createResponse.status}): ${err}`);
      }

      const prediction = await createResponse.json();
      const predictionId = prediction.id;
      if (typeof predictionId !== 'string' || predictionId.length === 0) {
        throw new Error('Replicate create response did not include a prediction id');
      }
      execution?.onProviderRequest(predictionId);

      // Poll for completion
      let result: any = null;
      let attempts = 0;
      const maxAttempts = 600; // 10 min

      while (attempts < maxAttempts) {
        attempts++;
        await sleep(1000, execution?.signal);

        const pollResponse = await fetch(`${REPLICATE_API}/predictions/${predictionId}`, {
          headers: { 'Authorization': `Bearer ${this.apiKey}` },
          signal: execution?.signal,
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
      if (execution?.signal.aborted) throw new Error('Generation stopped');

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

  async cancel(providerRequestId: string): Promise<void> {
    const response = await fetch(
      `${REPLICATE_API}/predictions/${encodeURIComponent(providerRequestId)}/cancel`,
      {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${this.apiKey}` },
      },
    );
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Replicate cancel failed (${response.status}): ${error}`);
    }
  }

  private async buildInput(
    request: GenerationRequest,
    model: string,
  ): Promise<Record<string, unknown>> {
    const input: Record<string, unknown> = { prompt: request.prompt };
    if (request.width) input.width = request.width;
    if (request.height) input.height = request.height;
    if (request.negativePrompt) input.negative_prompt = request.negativePrompt;
    if (request.durationSeconds) input.duration = request.durationSeconds;
    if (request.referenceImagePath) {
      // Refused for a model that reads no image rather than dropped by the
      // model, which would quietly return something unrelated.
      input.image = await encodeReferenceImage(request.referenceImagePath, {
        provider: this.name,
        model,
        type: request.type,
        field: 'input.image',
      });
    }
    return input;
  }

  private extractOutput(result: any): string | null {
    const output = result.output;
    if (typeof output === 'string') return output;
    if (Array.isArray(output) && output.length > 0) return output[0];
    return null;
  }
}
