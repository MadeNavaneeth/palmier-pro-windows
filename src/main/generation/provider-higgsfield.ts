/**
 * Higgs Field Generation Provider — video generation.
 *
 * Higgs Field specializes in high-quality video generation.
 * Uses their REST API for text-to-video and image-to-video.
 */

import type {
  GenerationProvider,
  GenerationRequest,
  GenerationResult,
  GenerationProgress,
  GenerationType,
} from './types';
import { downloadFile } from './util';

const HIGGSFIELD_API = 'https://api.higgsfield.ai/v1';

export class HiggsFieldProvider implements GenerationProvider {
  readonly id = 'higgsfield';
  readonly name = 'Higgs Field';
  readonly supportedTypes: GenerationType[] = ['video'];

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
  ): Promise<GenerationResult> {
    const startTime = Date.now();
    const model = (request.extra?.model as string) || 'diffuse-v1';

    onProgress?.({ id: request.id, status: 'pending', percent: 0, message: 'Submitting...' });

    try {
      // Submit generation
      const submitResponse = await fetch(`${HIGGSFIELD_API}/generations`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          prompt: request.prompt,
          duration: request.durationSeconds || 5,
          width: request.width || 1280,
          height: request.height || 720,
          first_frame_image: request.referenceImagePath || undefined,
        }),
      });

      if (!submitResponse.ok) {
        const err = await submitResponse.text();
        throw new Error(`Higgs Field submit failed (${submitResponse.status}): ${err}`);
      }

      const { id: generationId } = await submitResponse.json();

      // Poll for completion
      let attempts = 0;
      const maxAttempts = 300;

      while (attempts < maxAttempts) {
        attempts++;
        await new Promise((r) => setTimeout(r, 2000));

        const statusResponse = await fetch(`${HIGGSFIELD_API}/generations/${generationId}`, {
          headers: { 'Authorization': `Bearer ${this.apiKey}` },
        });

        if (!statusResponse.ok) continue;
        const data = await statusResponse.json();

        if (data.status === 'completed' && data.video_url) {
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

  async cancel(_requestId: string): Promise<void> {
    // Higgs Field cancel not yet supported
  }
}
