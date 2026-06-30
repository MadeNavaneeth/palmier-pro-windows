/**
 * fal.ai Generation Provider — text-to-image, image-to-video.
 *
 * Supported models:
 * - fal-ai/flux/dev (text-to-image)
 * - fal-ai/flux/schnell (fast text-to-image)
 * - fal-ai/kling-video (image-to-video)
 * - fal-ai/minimax-video (text-to-video)
 *
 * Uses the fal.ai REST API directly (no SDK dependency).
 */

import type {
  GenerationProvider,
  GenerationRequest,
  GenerationResult,
  GenerationProgress,
  GenerationType,
} from './types';
import { downloadFile } from './util';

const FAL_API_BASE = 'https://queue.fal.run';

export class FalProvider implements GenerationProvider {
  readonly id = 'fal';
  readonly name = 'fal.ai';
  readonly supportedTypes: GenerationType[] = ['image', 'video'];

  private apiKey: string = '';

  isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  configure(apiKey: string): void {
    this.apiKey = apiKey;
  }

  getModels(type: GenerationType): string[] {
    if (type === 'image') {
      return ['fal-ai/flux/dev', 'fal-ai/flux/schnell', 'fal-ai/flux-pro/v1.1'];
    }
    if (type === 'video') {
      return ['fal-ai/kling-video/v1/standard/text-to-video', 'fal-ai/minimax-video/video-01'];
    }
    return [];
  }

  async generate(
    request: GenerationRequest,
    onProgress?: (progress: GenerationProgress) => void,
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
      // Submit to queue
      const submitResponse = await fetch(`${FAL_API_BASE}/${model}`, {
        method: 'POST',
        headers: {
          'Authorization': `Key ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(this.buildPayload(request)),
      });

      if (!submitResponse.ok) {
        const err = await submitResponse.text();
        throw new Error(`fal.ai submit failed (${submitResponse.status}): ${err}`);
      }

      const { request_id, status: initialStatus } = await submitResponse.json();

      // Poll for completion
      let result: any = null;
      let attempts = 0;
      const maxAttempts = 300; // 5 min at 1s polling

      while (attempts < maxAttempts) {
        attempts++;
        await sleep(1000);

        const statusResponse = await fetch(
          `${FAL_API_BASE}/${model}/requests/${request_id}/status`,
          { headers: { 'Authorization': `Key ${this.apiKey}` } },
        );

        if (!statusResponse.ok) continue;
        const statusData = await statusResponse.json();

        if (statusData.status === 'COMPLETED') {
          // Fetch result
          const resultResponse = await fetch(
            `${FAL_API_BASE}/${model}/requests/${request_id}`,
            { headers: { 'Authorization': `Key ${this.apiKey}` } },
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

  async cancel(_requestId: string): Promise<void> {
    // fal.ai doesn't have a cancel endpoint for queued jobs
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private buildPayload(request: GenerationRequest): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      prompt: request.prompt,
    };

    if (request.width) payload.image_size = { width: request.width, height: request.height };
    if (request.negativePrompt) payload.negative_prompt = request.negativePrompt;
    if (request.referenceImagePath) payload.image_url = request.referenceImagePath;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
