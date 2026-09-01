import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";

import { losslessCompressPng, pngQuantize } from "@napi-rs/image";
import sharp, { type OutputInfo, type Sharp } from "sharp";

import { AppError, describeError } from "./errors.ts";
import type { GrayImage } from "./utils/ssim.ts";

const require = createRequire(import.meta.url);

/** Quality 100 is lossless oxipng; 1-99 is palette quantization then oxipng. */
const LOSSLESS_QUALITY = 100;

/**
 * pngquant speed, 1-10. Lower is slower and usually smaller, which is worth it
 * for a tool whose whole purpose is size.
 */
const PNG_QUANT_SPEED = 2;

/** Transparent areas carry arbitrary colour, so they are flattened before comparing. */
const FLATTEN_BACKGROUND = { r: 255, g: 255, b: 255 };

/** The oxipng engine @napi-rs/image provides, described for the run header. */
export interface PngEncoder {
  /** Version of the `@napi-rs/image` package that bundles oxipng. */
  readonly version: string | null;
}

export interface PngEncodeRequest {
  readonly inputPath: string;
  readonly outputPath: string;
  /** PNG quality, 1-100. 100 is lossless oxipng. */
  readonly quality: number;
}

/**
 * The planes a similarity comparison works on: brightness, and both colour
 * channels. Palette quantization discards colour detail first, so comparing
 * luma alone would miss banding that low quality causes.
 */
export interface PngPlanes {
  readonly luma: GrayImage;
  readonly blueChroma: GrayImage;
  readonly redChroma: GrayImage;
}

/**
 * Describes the PNG engine. Unlike MozJPEG there is nothing to locate: oxipng
 * is bundled by `@napi-rs/image`, so this cannot fail.
 */
export function describePngEncoder(): PngEncoder {
  return { version: readPackageVersion() };
}

/**
 * Compresses one PNG. Quality 100 is lossless oxipng. Lower qualities also try
 * palette quantization and keep whichever encoding is smaller, so a run never
 * does worse than lossless.
 *
 * @throws AppError when the PNG cannot be read or written.
 */
export async function encodePng(request: PngEncodeRequest): Promise<{ quality: number }> {
  const lossless = await compressLossless(request.inputPath);

  if (request.quality >= LOSSLESS_QUALITY) {
    await writeFile(request.outputPath, lossless);
    return { quality: LOSSLESS_QUALITY };
  }

  const lossy = await compressLossy(request.inputPath, request.quality);
  if (lossy !== null && lossy.length < lossless.length) {
    await writeFile(request.outputPath, lossy);
    return { quality: request.quality };
  }

  await writeFile(request.outputPath, lossless);
  return { quality: LOSSLESS_QUALITY };
}

/**
 * Encodes one PNG at `quality` for automatic search. Unlike {@link encodePng},
 * this does not substitute a smaller lossless file, so each quality level can
 * be measured on its own.
 *
 * @throws AppError when the PNG cannot be read or written.
 */
export async function encodePngAtQuality(request: PngEncodeRequest): Promise<void> {
  if (request.quality >= LOSSLESS_QUALITY) {
    await writeFile(request.outputPath, await compressLossless(request.inputPath));
    return;
  }

  const lossy = await compressLossy(request.inputPath, request.quality);
  if (lossy !== null) {
    await writeFile(request.outputPath, lossy);
    return;
  }

  await writeFile(request.outputPath, await compressLossless(request.inputPath));
}

/**
 * Lossless oxipng of one PNG. Used to keep automatic search from doing worse
 * than a lossless pass.
 *
 * @throws AppError when oxipng cannot read the input or write the output.
 */
export async function encodePngLossless(request: Omit<PngEncodeRequest, "quality">): Promise<void> {
  await writeFile(request.outputPath, await compressLossless(request.inputPath));
}

/**
 * Decodes a PNG into its luma and chroma planes.
 *
 * @throws AppError when sharp cannot decode the image.
 */
export async function decodePngPlanes(inputPath: string): Promise<PngPlanes> {
  const { data, info } = await decodeRgbBuffer(inputPath);

  if (info.channels !== 3) {
    throw new AppError(
      `Expected three colour channels from sharp, but the image decoded to ${info.channels}.`,
    );
  }

  const width = info.width;
  const height = Math.floor(data.length / (width * 3));
  if (width < 1 || height < 1) {
    throw new AppError("Sharp decoded the image to an empty pixel buffer.");
  }

  return splitPlanes(data, width, height);
}

async function compressLossless(inputPath: string): Promise<Buffer> {
  try {
    const input = await readFile(inputPath);
    return await losslessCompressPng(input, { force: true });
  } catch (error) {
    throw new AppError(`Oxipng failed to compress the PNG image: ${describeError(error)}`);
  }
}

/**
 * Palette-quantizes the PNG, then oxipng recompresses it. Returns `null` when
 * quantization cannot produce a file, so the caller can keep the lossless pass.
 */
async function compressLossy(inputPath: string, quality: number): Promise<Buffer | null> {
  try {
    const input = await readFile(inputPath);
    return await pngQuantize(input, {
      minQuality: 0,
      maxQuality: quality,
      speed: PNG_QUANT_SPEED,
    });
  } catch {
    return null;
  }
}

function splitPlanes(rgb: Buffer, width: number, height: number): PngPlanes {
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
    return await readPng(inputPath)
      .flatten({ background: FLATTEN_BACKGROUND })
      .toColourspace("srgb")
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
  } catch (error) {
    throw new AppError(`Sharp failed to decode the PNG image: ${describeError(error)}`);
  }
}

function readPng(inputPath: string): Sharp {
  return sharp(inputPath, { animated: true });
}

function readPackageVersion(): string | null {
  try {
    const pkg = require("@napi-rs/image/package.json") as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}
