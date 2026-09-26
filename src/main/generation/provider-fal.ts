/**
 * fal.ai Generation Provider — text-to-image, image-to-video.
 *
 * Supported models (free/open tiers where available):
 * - fal-ai/flux/dev, schnell, pro (text-to-image)
 * - fal-ai/ideogram/v2, recraft/v3, stable-diffusion-v3-medium (text-to-image)
 * - fal-ai/kling-video, minimax-video, luma-dream-machine, wan (video)
 *
 * Uses the fal.ai REST API directly (no SDK dependency).
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

const FAL_API_BASE = 'https://queue.fal.run';

export class FalProvider implements GenerationProvider {
  readonly id = 'fal';
  readonly name = 'fal.ai';
  readonly supportedTypes: GenerationType[] = ['image', 'video'];
  readonly cancellationSupport = 'local-only' as const;

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
        'fal-ai/flux/dev',
        'fal-ai/flux/schnell',
        'fal-ai/flux-pro/v1.1',
        'fal-ai/ideogram/v2',
        'fal-ai/recraft/v3',
        'fal-ai/stable-diffusion-v3-medium',
      ];
    }
    if (type === 'video') {
      return [
        'fal-ai/kling-video/v1/standard/text-to-video',
        'fal-ai/minimax-video/video-01',
        'fal-ai/luma-dream-machine',
        'fal-ai/wan/v2.1/text-to-video',
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

    onProgress?.({
      id: request.id,
      status: 'pending',
      percent: 0,
      message: `Submitting to ${model}...`,
    });

    try {
      // Built before submitting: a reference that cannot be encoded must cost
      // no provider call, and the model must not fall back to a bare prompt.
      // fal reads image_url as a URL or a data URI, never a local path.
      const payload = await this.buildPayload(request, model);

      // Submit to queue
      const submitResponse = await fetch(`${FAL_API_BASE}/${model}`, {
        method: 'POST',
        headers: {
          'Authorization': `Key ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: execution?.signal,
      });

      if (!submitResponse.ok) {
        const err = await submitResponse.text();
        throw new Error(`fal.ai submit failed (${submitResponse.status}): ${err}`);
      }

      const { request_id } = await submitResponse.json();
      if (typeof request_id !== 'string' || request_id.length === 0) {
        throw new Error('fal.ai submit response did not include a request id');
      }
      execution?.onProviderRequest(request_id);

      // Poll for completion
      let result: any = null;
      let attempts = 0;
      const maxAttempts = 300; // 5 min at 1s polling

      while (attempts < maxAttempts) {
        attempts++;
        await sleep(1000, execution?.signal);

        const statusResponse = await fetch(
          `${FAL_API_BASE}/${model}/requests/${request_id}/status`,
          {
            headers: { 'Authorization': `Key ${this.apiKey}` },
            signal: execution?.signal,
          },
        );

        if (!statusResponse.ok) continue;
        const statusData = await statusResponse.json();

        if (statusData.status === 'COMPLETED') {
          // Fetch result
          const resultResponse = await fetch(
            `${FAL_API_BASE}/${model}/requests/${request_id}`,
            {
              headers: { 'Authorization': `Key ${this.apiKey}` },
              signal: execution?.signal,
            },
          );
          result = await resultResponse.json();
          break;
        }

        if (statusData.status === 'FAILED') {
          throw new Error(statusData.error || 'Generation failed');
        }

        // Progress update
        const percent = Math.min(90, Math.round((attempts / maxAttempts) * 100));
        onProgress?.({
          id: request.id,
          status: 'processing',
          percent,
          message: `Processing... (${attempts}s)`,
        });
      }

      if (!result) {
        throw new Error('Generation timed out');
      }
      if (execution?.signal.aborted) throw new Error('Generation stopped');

      // Extract URL from result
      const outputUrl = this.extractUrl(result, request.type);
      if (!outputUrl) {
        throw new Error('No output URL in generation result');
      }

      onProgress?.({ id: request.id, status: 'processing', percent: 95, message: 'Downloading...' });

      // Download to local file
      const ext = request.type === 'video' ? 'mp4' : 'png';
      const outputPath = await downloadFile(outputUrl, request.id, ext);

      return {
        id: request.id,
        status: 'completed',
        outputPath,
        remoteUrl: outputUrl,
        width: request.width,
        height: request.height,
        elapsedMs: Date.now() - startTime,
        metadata: { model, provider: 'fal' },
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

  async cancel(_providerRequestId: string): Promise<void> {
    // The REST contract used here exposes queue status/result but no cancel
    // operation. The manager therefore stops polling locally and reports the
    // provider job as continuing remotely.
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private async buildPayload(
    request: GenerationRequest,
    model: string,
  ): Promise<Record<string, unknown>> {
    const payload: Record<string, unknown> = {
      prompt: request.prompt,
    };

    if (request.width) payload.image_size = { width: request.width, height: request.height };
    if (request.negativePrompt) payload.negative_prompt = request.negativePrompt;
    if (request.referenceImagePath) {
      // Refused for a model that reads no image rather than dropped by fal.
      payload.image_url = await encodeReferenceImage(request.referenceImagePath, {
        provider: this.name,
        model,
        type: request.type,
        field: 'image_url',
      });
    }
    if (request.durationSeconds) payload.duration = request.durationSeconds;

    return payload;
  }

  private extractUrl(result: any, type: GenerationType): string | null {
    // fal.ai returns different shapes per model
    if (result.images?.[0]?.url) return result.images[0].url;
    if (result.video?.url) return result.video.url;
    if (result.output?.url) return result.output.url;
    if (result.url) return result.url;
    return null;
  }
}
