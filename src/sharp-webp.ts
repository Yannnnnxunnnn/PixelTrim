import sharp, { type OutputInfo, type Sharp } from "sharp";

import { AppError, describeError } from "./errors.ts";
import type { GrayImage } from "./utils/ssim.ts";

/** The WebP encoder sharp provides, described for the run header. */
export interface WebpEncoder {
  /** Version of the sharp package doing the encoding. */
  readonly version: string | null;
  /** Version of the libwebp build sharp is linked against. */
  readonly libwebpVersion: string | null;
}

export interface WebpEncodeRequest {
  readonly inputPath: string;
  readonly outputPath: string;
  /** WebP quality, 1-100. */
  readonly quality: number;
}

/**
 * Encoder effort, 0-6. The highest setting spends more time searching for a
 * smaller file, which is worth it for a tool whose whole purpose is size.
 */
const WEBP_EFFORT = 6;

/** Transparent areas carry arbitrary colour, so they are flattened before comparing. */
const FLATTEN_BACKGROUND = { r: 255, g: 255, b: 255 };

/**
 * Describes the WebP engine. Unlike MozJPEG there is nothing to locate: sharp
 * bundles its own libwebp, so this cannot fail.
 */
export function describeWebpEncoder(): WebpEncoder {
  return {
    version: sharp.versions.sharp ?? null,
    libwebpVersion: sharp.versions.webp ?? null,
  };
}

/**
 * Re-encodes one WebP with sharp's native WebP encoder, keeping every frame of
 * an animation.
 *
 * @throws AppError when sharp cannot read the input or write the output.
 */
export async function encodeWebp(request: WebpEncodeRequest): Promise<void> {
  const { inputPath, outputPath, quality } = request;

  try {
    await readWebp(inputPath).webp({ quality, effort: WEBP_EFFORT }).toFile(outputPath);
  } catch (error) {
    throw new AppError(`Sharp failed to compress the WebP image: ${describeError(error)}`);
  }
}

/**
 * The planes a similarity comparison works on: brightness, and both colour
 * channels. WebP discards colour detail well before brightness detail, so
 * comparing luma alone would miss the blotchy colour that low quality causes.
 */
export interface WebpPlanes {
  readonly luma: GrayImage;
  /** Blue-difference chroma, Cb. */
  readonly blueChroma: GrayImage;
  /** Red-difference chroma, Cr. */
  readonly redChroma: GrayImage;
}

/**
 * Decodes a WebP into its luma and chroma planes. Animation frames are stacked
 * vertically, so they are all measured.
 *
 * @throws AppError when sharp cannot decode the image.
 */
export async function decodeWebpPlanes(inputPath: string): Promise<WebpPlanes> {
  const { data, info } = await decodeRgbBuffer(inputPath);

  if (info.channels !== 3) {
    throw new AppError(
      `Expected three colour channels from sharp, but the image decoded to ${info.channels}.`,
    );
  }

  const width = info.width;
  // Frames of an animation are stacked, so the height that matches the buffer is
  // derived from it rather than taken from the reported page height.
  const height = Math.floor(data.length / (width * 3));
  if (width < 1 || height < 1) {
    throw new AppError("Sharp decoded the image to an empty pixel buffer.");
  }

  return splitPlanes(data, width, height);
}

/** Separates interleaved RGB into the three BT.601 planes, in one pass. */
function splitPlanes(rgb: Buffer, width: number, height: number): WebpPlanes {
  const count = width * height;
  const luma = new Uint8Array(count);
  const blueChroma = new Uint8Array(count);
  const redChroma = new Uint8Array(count);

  for (let index = 0; index < count; index += 1) {
    const offset = index * 3;
    const red = rgb[offset]!;
    const green = rgb[offset + 1]!;
    const blue = rgb[offset + 2]!;

    luma[index] = (0.299 * red + 0.587 * green + 0.114 * blue + 0.5) | 0;
    blueChroma[index] = (128 - 0.168736 * red - 0.331264 * green + 0.5 * blue + 0.5) | 0;
    redChroma[index] = (128 + 0.5 * red - 0.418688 * green - 0.081312 * blue + 0.5) | 0;
  }

  return {
    luma: { width, height, pixels: luma },
    blueChroma: { width, height, pixels: blueChroma },
    redChroma: { width, height, pixels: redChroma },
  };
}

async function decodeRgbBuffer(inputPath: string): Promise<{ data: Buffer; info: OutputInfo }> {
  try {
    return await readWebp(inputPath)
      // Flattening folds any alpha differences into the colour planes, so
      // transparency is compared without needing a fourth plane.
      .flatten({ background: FLATTEN_BACKGROUND })
      .toColourspace("srgb")
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
  } catch (error) {
    throw new AppError(`Sharp failed to decode the WebP image: ${describeError(error)}`);
  }
}

function readWebp(inputPath: string): Sharp {
  return sharp(inputPath, { animated: true });
}
