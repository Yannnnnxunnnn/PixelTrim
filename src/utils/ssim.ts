import { AppError } from "../errors.ts";

/** A single-channel 8-bit image. */
export interface GrayImage {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
}

/**
 * Window size and stride for the SSIM sliding window. Eight matches the JPEG
 * block size, and a stride of four keeps windows overlapping so artifacts on
 * block boundaries are still measured.
 */
const WINDOW = 8;
const STRIDE = 4;

/** Stabilising constants from the original SSIM paper, for 8-bit data. */
const C1 = (0.01 * 255) ** 2;
const C2 = (0.03 * 255) ** 2;

/**
 * Mean structural similarity between two equally sized grayscale images, in the
 * range 0-1, where 1 means identical.
 */
export function meanSsim(reference: GrayImage, comparison: GrayImage): number {
  if (reference.width !== comparison.width || reference.height !== comparison.height) {
    throw new AppError(
      `Cannot compare images of different sizes (${reference.width}x${reference.height} and ${comparison.width}x${comparison.height}).`,
    );
  }

  const { width, height } = reference;
  if (width < WINDOW || height < WINDOW) {
    return exactMatch(reference, comparison) ? 1 : 0;
  }

  const referencePixels = reference.pixels;
  const comparisonPixels = comparison.pixels;
  const pixelsPerWindow = WINDOW * WINDOW;

  let total = 0;
  let windows = 0;

  for (let top = 0; top + WINDOW <= height; top += STRIDE) {
    for (let left = 0; left + WINDOW <= width; left += STRIDE) {
      let sumA = 0;
      let sumB = 0;
      let sumAA = 0;
      let sumBB = 0;
      let sumAB = 0;

      for (let row = 0; row < WINDOW; row += 1) {
        let index = (top + row) * width + left;
        for (let column = 0; column < WINDOW; column += 1, index += 1) {
          const a = referencePixels[index]!;
          const b = comparisonPixels[index]!;
          sumA += a;
          sumB += b;
          sumAA += a * a;
          sumBB += b * b;
          sumAB += a * b;
        }
      }

      const meanA = sumA / pixelsPerWindow;
      const meanB = sumB / pixelsPerWindow;
      const varianceA = sumAA / pixelsPerWindow - meanA * meanA;
      const varianceB = sumBB / pixelsPerWindow - meanB * meanB;
      const covariance = sumAB / pixelsPerWindow - meanA * meanB;

      const numerator = (2 * meanA * meanB + C1) * (2 * covariance + C2);
      const denominator = (meanA * meanA + meanB * meanB + C1) * (varianceA + varianceB + C2);

      total += numerator / denominator;
      windows += 1;
    }
  }

  return windows ? total / windows : 1;
}

/**
 * Parses a binary PGM (`P5`) image, which is what `djpeg -grayscale` writes.
 *
 * @throws AppError when the data is not a supported PGM.
 */
export function parsePgm(buffer: Buffer): GrayImage {
  if (buffer.length < 2 || buffer[0] !== 0x50 || buffer[1] !== 0x35) {
    throw new AppError("Decoded image is not a binary PGM file.");
  }

  const reader = createHeaderReader(buffer);
  const width = reader.nextInteger();
  const height = reader.nextInteger();
  const maxValue = reader.nextInteger();

  if (maxValue !== 255) {
    throw new AppError(`Unsupported PGM depth: expected a maximum value of 255, got ${maxValue}.`);
  }

  const start = reader.offset;
  const expected = width * height;
  if (buffer.length - start < expected) {
    throw new AppError("Decoded image data is shorter than its header claims.");
  }

  return { width, height, pixels: new Uint8Array(buffer.subarray(start, start + expected)) };
}

interface HeaderReader {
  readonly nextInteger: () => number;
  readonly offset: number;
}

/** Reads whitespace-separated header integers, skipping `#` comments. */
function createHeaderReader(buffer: Buffer): HeaderReader {
  let offset = 2;

  const isWhitespace = (byte: number): boolean =>
    byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;

  const nextInteger = (): number => {
    while (offset < buffer.length) {
      const byte = buffer[offset]!;
      if (isWhitespace(byte)) {
        offset += 1;
      } else if (byte === 0x23) {
        while (offset < buffer.length && buffer[offset] !== 0x0a) {
          offset += 1;
        }
      } else {
        break;
      }
    }

    let value = 0;
    let digits = 0;
    while (offset < buffer.length) {
      const byte = buffer[offset]!;
      if (byte < 0x30 || byte > 0x39) {
        break;
      }
      value = value * 10 + (byte - 0x30);
      digits += 1;
      offset += 1;
    }

    if (!digits) {
      throw new AppError("Malformed PGM header.");
    }

    // A single whitespace byte separates the header from the pixel data.
    if (offset < buffer.length && isWhitespace(buffer[offset]!)) {
      offset += 1;
    }
    return value;
  };

  return {
    nextInteger,
    get offset() {
      return offset;
    },
  };
}

function exactMatch(reference: GrayImage, comparison: GrayImage): boolean {
  return Buffer.compare(reference.pixels, comparison.pixels) === 0;
}
