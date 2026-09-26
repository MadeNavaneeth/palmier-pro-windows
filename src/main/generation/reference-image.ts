/**
 * Reference image encoding for the generation adapters.
 *
 * A reference reaches an adapter as a local path — that is the published
 * contract of both entry points (`generate_media` and the `generation:start`
 * IPC shell) and the value recorded as provenance. Every provider API used here
 * takes its image input as a URL or an inline data URI, though, and rejects a
 * local path such as `C:\media\ref.png` at request validation: the control
 * would work and no pixels would ever be conditioned on the picture.
 *
 * This module is the one place a local reference becomes bytes on the wire.
 * Adapters call it while building their request, so every refusal — a model
 * that reads no image, a provider whose field cannot carry an inline value, an
 * unreadable or oversized file, bytes that are not the image they claim to be —
 * happens before a provider is contacted instead of degrading into an
 * unrelated image.
 *
 * The accepted types and the size cap are not restated here: they are imported
 * from ../ai/tools, the published contract the boundary validates against. What
 * this hop owns is the transport guard — never read an unbounded file, never
 * put a non-image on the wire, never hold the buffer past the returned string.
 */

import fs from 'fs/promises';
import path from 'path';
import { MAX_REFERENCE_IMAGE_BYTES, REFERENCE_IMAGE_EXTENSIONS } from '../ai/tools';
import type { GenerationType } from './types';

/**
 * Media type per accepted reference extension, for the data URI. The keys are
 * exactly REFERENCE_IMAGE_EXTENSIONS (asserted by a test), so a type added to
 * the published allowlist cannot be silently unencodable here.
 */
const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
};

/** The provider/model/field the reference is being encoded for. */
export interface ReferenceTarget {
  /** Provider display name, quoted in refusals. */
  provider: string;
  /** Resolved model id, quoted in refusals. */
  model: string;
  /** Media type of the generation being requested. */
  type: GenerationType;
  /** The outbound request field the encoded value lands in. */
  field: string;
  /**
   * Refusal for a provider that cannot carry an inline reference at all, even
   * for image generation. Omitted when the field accepts a data URI.
   */
  unsupported?: string;
}

function ascii(bytes: Buffer, start: number, end: number): string {
  return bytes.subarray(start, end).toString('latin1');
}

/**
 * Whether the leading bytes are the image the extension claims. A misnamed
 * file (a text file called .png) would otherwise become a plausible-looking
 * data URI the provider rejects with a schema error, or worse, accepts.
 */
function hasImageSignature(extension: string, bytes: Buffer): boolean {
  switch (extension) {
    case '.png':
      return bytes.subarray(0, 8).equals(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      );
    case '.jpg':
    case '.jpeg':
      return bytes.length > 2 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case '.gif':
      return ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a';
    case '.webp':
      return ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP';
    case '.bmp':
      return ascii(bytes, 0, 2) === 'BM';
    default:
      return false;
  }
}

function unreadable(localPath: string, err: unknown): Error {
  // Same words as the boundary check for the same fault, so one missing file
  // reads identically whichever entry point refused it.
  if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
    return new Error(`Reference image not found: ${localPath}`);
  }
  return new Error(
    `Reference image could not be read: ${localPath} (${err instanceof Error ? err.message : String(err)})`,
  );
}

/**
 * Read a validated local reference and return it as a data URI.
 *
 * Rejects — never falls back to a reference-less request — when the target
 * cannot honour one, the file cannot be read or is empty, it is over the cap,
 * or its bytes are not the type it claims. Callers turn the thrown message
 * into the generation's error, so the reason survives to the model and to the
 * Generate dialog.
 */
export async function encodeReferenceImage(
  localPath: string,
  target: ReferenceTarget,
): Promise<string> {
  if (target.unsupported) throw new Error(target.unsupported);

  if (target.type !== 'image') {
    throw new Error(
      `${target.provider} ${target.model} generates ${target.type} from text only, so a reference image sent as `
      + `${target.field} would be ignored. Drop referenceImagePath, or generate the still first with an `
      + 'image model and cut it in.',
    );
  }

  const extension = path.extname(localPath).toLowerCase();
  const mime = MIME_BY_EXTENSION[extension];
  if (!mime) {
    throw new Error(
      `Reference image cannot be encoded: "${extension || localPath}" is not one of ${REFERENCE_IMAGE_EXTENSIONS.join(', ')}.`,
    );
  }

  // Stat before reading: an oversized file is refused without ever being
  // pulled into memory.
  let size: number;
  try {
    size = (await fs.stat(localPath)).size;
  } catch (err) {
    throw unreadable(localPath, err);
  }
  if (size === 0) throw new Error(`Reference image is empty: ${localPath}`);
  if (size > MAX_REFERENCE_IMAGE_BYTES) {
    const mib = (bytes: number): string => `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
    throw new Error(
      `Reference image is ${mib(size)}; the cap is ${mib(MAX_REFERENCE_IMAGE_BYTES)}: ${localPath}`,
    );
  }

  let bytes: Buffer;
  try {
    bytes = await fs.readFile(localPath);
  } catch (err) {
    throw unreadable(localPath, err);
  }
  if (!hasImageSignature(extension, bytes)) {
    throw new Error(`Reference image is not a readable ${extension} file: ${localPath}`);
  }

  // The buffer is reachable only from the string returned here; base64 of the
  // cap is the largest allocation this hop makes, once per request.
  return `data:${mime};base64,${bytes.toString('base64')}`;
}
