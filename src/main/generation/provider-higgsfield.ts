/**
 * Higgs Field Generation Provider — video generation.
 *
 * Higgs Field specializes in high-quality video generation.
 * Uses their REST API for text-to-video and image-to-video.
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

const HIGGSFIELD_API = 'https://api.higgsfield.ai/v1';

export class HiggsFieldProvider implements GenerationProvider {
  readonly id = 'higgsfield';
  readonly name = 'Higgs Field';
  readonly supportedTypes: GenerationType[] = ['video'];
  readonly cancellationSupport = 'local-only' as const;

  private apiKey: string = '';

  isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  configure(apiKey: string): void {
    this.apiKey = apiKey;
  }

  getModels(_type: GenerationType): string[] {
    return ['diffuse-v1', 'diffuse-v1-turbo'];
  }

  async generate(
    request: GenerationRequest,
    onProgress?: (progress: GenerationProgress) => void,
    execution?: GenerationExecutionContext,
  ): Promise<GenerationResult> {
    const startTime = Date.now();
    const model = (request.extra?.model as string) || 'diffuse-v1';

    onProgress?.({ id: request.id, status: 'pending', percent: 0, message: 'Submitting...' });

    try {
      // Built before submitting: a reference that cannot be sent must cost no
      // provider call.
      const body = await this.buildBody(request, model);

      // Submit generation
      const submitResponse = await fetch(`${HIGGSFIELD_API}/generations`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: execution?.signal,
      });

      if (!submitResponse.ok) {
        const err = await submitResponse.text();
        throw new Error(`Higgs Field submit failed (${submitResponse.status}): ${err}`);
      }

      const { id: generationId } = await submitResponse.json();
      if (typeof generationId !== 'string' || generationId.length === 0) {
        throw new Error('Higgs Field submit response did not include a generation id');
      }
      execution?.onProviderRequest(generationId);

      // Poll for completion
      let attempts = 0;
      const maxAttempts = 300;

      while (attempts < maxAttempts) {
        attempts++;
        await sleep(2000, execution?.signal);

        const statusResponse = await fetch(`${HIGGSFIELD_API}/generations/${generationId}`, {
          headers: { 'Authorization': `Bearer ${this.apiKey}` },
          signal: execution?.signal,
        });

        if (!statusResponse.ok) continue;
        const data = await statusResponse.json();

        if (data.status === 'completed' && data.video_url) {
          if (execution?.signal.aborted) throw new Error('Generation stopped');
          onProgress?.({ id: request.id, status: 'processing', percent: 95, message: 'Downloading...' });
          const outputPath = await downloadFile(data.video_url, request.id, 'mp4');

          return {
            id: request.id,
            status: 'completed',
            outputPath,
            remoteUrl: data.video_url,
            durationSeconds: request.durationSeconds,
            width: request.width,
            height: request.height,
            elapsedMs: Date.now() - startTime,
            metadata: { model, generationId, provider: 'higgsfield' },
          };
        }

        if (data.status === 'failed') {
          throw new Error(data.error || 'Generation failed');
        }

        const percent = Math.min(90, Math.round((attempts / 60) * 100));
        onProgress?.({ id: request.id, status: 'processing', percent, message: `${data.status}...` });
      }

      throw new Error('Generation timed out');
    } catch (err: any) {
      return { id: request.id, status: 'failed', error: err.message, elapsedMs: Date.now() - startTime };
    }
  }

  async cancel(_providerRequestId: string): Promise<void> {
    // The REST contract used here exposes create/status but no cancel
    // operation. Cancellation is therefore local-only and reported honestly.
  }

  private async buildBody(
    request: GenerationRequest,
    model: string,
  ): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = {
      model,
      prompt: request.prompt,
      duration: request.durationSeconds || 5,
      width: request.width || 1280,
      height: request.height || 720,
    };

    if (request.referenceImagePath) {
      // Higgs Field's first frame is fetched from a URL by the service, and
      // this adapter's endpoint has no upload step to give it one. Refusing is
      // the honest answer: sending a local path, or a data URI the service may
      // not accept, would leave a control that does nothing.
      body.first_frame_image = await encodeReferenceImage(request.referenceImagePath, {
        provider: this.name,
        model,
        type: request.type,
        field: 'first_frame_image',
        unsupported:
          `Higgs Field ${model} conditions on a first frame the service fetches from a public URL, and this `
          + `adapter's generations call uploads nothing, so ${request.referenceImagePath} cannot be sent as `
          + 'first_frame_image. Drop referenceImagePath, or generate the still with fal.ai or Replicate and cut it in.',
      });
    }

    return body;
  }
}
