/** Lowest quality any search will consider, however lenient the threshold is. */
export const AUTO_MIN_QUALITY = 40;

export interface QualityBounds {
  /** Highest quality to try, which is also the fallback if nothing qualifies. */
  readonly maxQuality: number;
  /** Lowest acceptable structural similarity, 0-1. */
  readonly minSsim: number;
}

/** One encoded candidate and how closely it matches its source. */
export interface QualityCandidate {
  readonly quality: number;
  readonly ssim: number;
  /** Path of the encode, inside the scratch directory owned by the caller. */
  readonly encodedPath: string;
  readonly encodedSize: number;
}

export interface QualitySearchResult extends QualityCandidate {
  /** How many quality levels were encoded and measured. */
  readonly attempts: number;
  /** False when even `maxQuality` could not reach the threshold. */
  readonly metThreshold: boolean;
}

/** Encodes the source at `quality` and measures the result against it. */
export type EvaluateQuality = (quality: number) => Promise<QualityCandidate>;

/**
 * Finds the lowest quality whose output still matches the source closely enough,
 * by binary searching quality levels.
 *
 * This is the automatic equivalent of trying `--quality` by hand: fewer bytes are
 * spent on images that tolerate it, without dropping below the quality floor.
 * Encoding and measuring are left to `evaluate`, so each format shares the search
 * while keeping its own encoder.
 */
export async function searchLowestQuality(
  bounds: QualityBounds,
  evaluate: EvaluateQuality,
): Promise<QualitySearchResult> {
  let low = Math.min(AUTO_MIN_QUALITY, bounds.maxQuality);
  let high = bounds.maxQuality;
  let best: QualityCandidate | null = null;
  let fallback: QualityCandidate | null = null;
  let attempts = 0;

  while (low <= high) {
    const quality = Math.floor((low + high) / 2);
    const candidate = await evaluate(quality);
    attempts += 1;

    if (candidate.ssim >= bounds.minSsim) {
      best = candidate;
      high = quality - 1;
    } else {
      if (fallback === null || candidate.quality > fallback.quality) {
        fallback = candidate;
      }
      low = quality + 1;
    }
  }

  if (best !== null) {
    return { ...best, attempts, metThreshold: true };
  }

  // Nothing reached the threshold, so keep the highest quality that was tried.
  const highest =
    fallback?.quality === bounds.maxQuality ? fallback : await evaluate(bounds.maxQuality);

  return {
    ...highest,
    attempts: highest === fallback ? attempts : attempts + 1,
    metThreshold: false,
  };
}
