/**
 * Generation types — shared interfaces for the
 * multi-provider AI generation adapter system.
 */

export type GenerationType = 'image' | 'video' | 'audio';
export type GenerationStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface GenerationRequest {
  id: string;
  type: GenerationType;
  prompt: string;
  provider: string;
  /** Duration in seconds (video/audio) */
  durationSeconds?: number;
  /** Width in pixels (image/video) */
  width?: number;
  /** Height in pixels (image/video) */
  height?: number;
  /** Reference image/frame asset path */
  referenceImagePath?: string;
  /** Negative prompt */
  negativePrompt?: string;
  /** Provider-specific params */
  extra?: Record<string, unknown>;
}

export interface GenerationResult {
  id: string;
  status: GenerationStatus;
  /** Output file path (local, after download) */
  outputPath?: string;
  /** Remote URL before download */
  remoteUrl?: string;
  /** Duration of generated media */
  durationSeconds?: number;
  /** Dimensions */
  width?: number;
  height?: number;
  /** Error message if failed */
  error?: string;
  /** Processing time in ms */
  elapsedMs?: number;
  /** Provider-specific metadata */
  metadata?: Record<string, unknown>;
}

export interface GenerationProgress {
  id: string;
  status: GenerationStatus;
  percent: number;
  message?: string;
}

/**
 * Provider adapter interface — each provider implements this.
 */
export interface GenerationProvider {
  readonly id: string;
  readonly name: string;
  readonly supportedTypes: GenerationType[];

  /** Check if the provider is configured (has API key) */
  isConfigured(): boolean;

  /** Configure with API key */
  configure(apiKey: string): void;

  /** Submit a generation request */
  generate(
    request: GenerationRequest,
    onProgress?: (progress: GenerationProgress) => void,
  ): Promise<GenerationResult>;

  /** Cancel an in-progress generation */
  cancel(requestId: string): Promise<void>;

  /** List available models for this provider */
  getModels(type: GenerationType): string[];
}
