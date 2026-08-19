import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import {
  decodeToGrayscale,
  encodeJpeg,
  type MozjpegDecoder,
  type MozjpegEncoder,
} from "./mozjpeg.ts";
import {
  searchLowestQuality,
  type QualityBounds,
  type QualityCandidate,
  type QualitySearchResult,
} from "./quality-search-core.ts";
import { meanSsim, parsePgm, type GrayImage } from "./utils/ssim.ts";

export interface QualitySearchRequest extends QualityBounds {
  readonly encoder: MozjpegEncoder;
  readonly decoder: MozjpegDecoder;
  readonly inputPath: string;
  /** Scratch directory for candidate encodes, owned by the caller. */
  readonly workDir: string;
}

/**
 * Picks the JPEG quality for one image automatically, measuring each MozJPEG
 * candidate against the source with luma SSIM.
 */
export async function findBestQuality(
  request: QualitySearchRequest,
): Promise<QualitySearchResult> {
  const reference = await decodeReference(request);

  return searchLowestQuality(request, (quality) => evaluate(request, reference, quality));
}

async function decodeReference(request: QualitySearchRequest): Promise<GrayImage> {
  const referencePath = path.join(request.workDir, "reference.pgm");
  await decodeToGrayscale({
    decoder: request.decoder,
    inputPath: request.inputPath,
    outputPath: referencePath,
  });
  return parsePgm(await readFile(referencePath));
}

async function evaluate(
  request: QualitySearchRequest,
  reference: GrayImage,
  quality: number,
): Promise<QualityCandidate> {
  const encodedPath = path.join(request.workDir, `q${quality}.jpg`);
  await encodeJpeg({
    encoder: request.encoder,
    inputPath: request.inputPath,
    outputPath: encodedPath,
    quality,
  });

  const decodedPath = path.join(request.workDir, `q${quality}.pgm`);
  await decodeToGrayscale({
    decoder: request.decoder,
    inputPath: encodedPath,
    outputPath: decodedPath,
  });

  const ssim = meanSsim(reference, parsePgm(await readFile(decodedPath)));
  const { size } = await stat(encodedPath);

  return { quality, ssim, encodedPath, encodedSize: size };
}
