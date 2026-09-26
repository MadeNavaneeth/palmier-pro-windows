/**
 * Generation types — shared interfaces for the
 * multi-provider AI generation adapter system.
 */

export type GenerationType = 'image' | 'video' | 'audio';
export type GenerationStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';
export type GenerationCancellationSupport = 'remote' | 'local-only';

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
  /** Backend credit charge, if reported by the provider (upstream #570). */
  costCredits?: number;
  /** Provider-specific metadata */
  metadata?: Record<string, unknown>;
}

export interface GenerationProgress {
  id: string;
  status: GenerationStatus;
  percent: number;
  message?: string;
}

export interface GenerationExecutionContext {
  /** Publish the provider's own queued/job id as soon as submission returns it. */
  onProviderRequest(providerRequestId: string): void;
  /** Aborted when the user cancels or the local timeout wins. */
  signal: AbortSignal;
}

/**
 * Provider adapter interface — each provider implements this.
 */
export interface GenerationProvider {
  readonly id: string;
  readonly name: string;
  readonly supportedTypes: GenerationType[];
  /**
   * Whether cancel() can stop provider-owned work. Omitted means remote for
   * compatibility with third-party/fake adapters that predate this field.
   */
  readonly cancellationSupport?: GenerationCancellationSupport;

  /** Check if the provider is configured (has API key) */
  isConfigured(): boolean;

  /** Configure with API key */
  configure(apiKey: string): void;

  /** Submit a generation request */
  generate(
    request: GenerationRequest,
    onProgress?: (progress: GenerationProgress) => void,
    execution?: GenerationExecutionContext,
  ): Promise<GenerationResult>;

  /** Cancel provider work using the provider's own request identifier. */
  cancel(providerRequestId: string): Promise<void>;

  /** List available models for this provider */
  getModels(type: GenerationType): string[];
}
