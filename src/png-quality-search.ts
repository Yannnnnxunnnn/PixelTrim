import { stat } from "node:fs/promises";
import path from "node:path";

import {
  decodePngPlanes,
  encodePngAtQuality,
  encodePngLossless,
  type PngPlanes,
} from "./oxipng.ts";
import {
  searchLowestQuality,
  type QualityBounds,
  type QualitySearchResult,
} from "./quality-search-core.ts";
import { meanSsim } from "./utils/ssim.ts";

export interface PngQualitySearchRequest extends QualityBounds {
  readonly inputPath: string;
  /** Scratch directory for candidate encodes, owned by the caller. */
  readonly workDir: string;
}

/**
 * Picks the PNG quality for one image automatically. Palette quantization is
 * searched the same way as JPEG and WebP. If lossless oxipng is smaller than
 * the chosen lossy file, that lossless encode is kept instead.
 */
export async function findBestPngQuality(
  request: PngQualitySearchRequest,
): Promise<QualitySearchResult> {
  const reference = await decodePngPlanes(request.inputPath);

  const lossy = await searchLowestQuality(request, async (quality) => {
    const encodedPath = path.join(request.workDir, `q${quality}.png`);
    await encodePngAtQuality({
      inputPath: request.inputPath,
      outputPath: encodedPath,
      quality,
    });

    const ssim = similarity(reference, await decodePngPlanes(encodedPath));
    const { size } = await stat(encodedPath);

    return { quality, ssim, encodedPath, encodedSize: size };
  });

  const losslessPath = path.join(request.workDir, "lossless.png");
  await encodePngLossless({ inputPath: request.inputPath, outputPath: losslessPath });
  const { size: losslessSize } = await stat(losslessPath);

  if (losslessSize <= lossy.encodedSize) {
    return {
      quality: 100,
      ssim: 1,
      encodedPath: losslessPath,
      encodedSize: losslessSize,
      attempts: lossy.attempts,
      metThreshold: true,
    };
  }

  return lossy;
}

/**
 * Similarity of a candidate to its source, as the score of its weakest plane, so
 * that `--min-ssim` holds for brightness and colour alike.
 */
function similarity(reference: PngPlanes, candidate: PngPlanes): number {
  return Math.min(
    meanSsim(reference.luma, candidate.luma),
    meanSsim(reference.blueChroma, candidate.blueChroma),
    meanSsim(reference.redChroma, candidate.redChroma),
  );
}
