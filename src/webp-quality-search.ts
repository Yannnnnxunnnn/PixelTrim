import { stat } from "node:fs/promises";
import path from "node:path";

import {
  searchLowestQuality,
  type QualityBounds,
  type QualitySearchResult,
} from "./quality-search-core.ts";
import { decodeWebpPlanes, encodeWebp, type WebpPlanes } from "./sharp-webp.ts";
import { meanSsim } from "./utils/ssim.ts";

export interface WebpQualitySearchRequest extends QualityBounds {
  readonly inputPath: string;
  /** Scratch directory for candidate encodes, owned by the caller. */
  readonly workDir: string;
}

/** Picks the WebP quality for one image automatically. */
export async function findBestWebpQuality(
  request: WebpQualitySearchRequest,
): Promise<QualitySearchResult> {
  const reference = await decodeWebpPlanes(request.inputPath);

  return searchLowestQuality(request, async (quality) => {
    const encodedPath = path.join(request.workDir, `q${quality}.webp`);
    await encodeWebp({ inputPath: request.inputPath, outputPath: encodedPath, quality });

    const ssim = similarity(reference, await decodeWebpPlanes(encodedPath));
    const { size } = await stat(encodedPath);

    return { quality, ssim, encodedPath, encodedSize: size };
  });
}

/**
 * Similarity of a candidate to its source, as the score of its weakest plane, so
 * that `--min-ssim` holds for brightness and colour alike.
 *
 * Averaging the planes instead would let WebP's aggressive colour quantisation
 * hide behind a well-preserved luma channel, which is exactly how flat, blotchy
 * colour survives a comparison that only looks at brightness.
 */
function similarity(reference: WebpPlanes, candidate: WebpPlanes): number {
  return Math.min(
    meanSsim(reference.luma, candidate.luma),
    meanSsim(reference.blueChroma, candidate.blueChroma),
    meanSsim(reference.redChroma, candidate.redChroma),
  );
}
