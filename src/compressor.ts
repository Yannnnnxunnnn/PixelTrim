import { copyFile, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { AppError, describeError } from "./errors.ts";
import type {
  CompressionOptions,
  CompressionResult,
  ImageFile,
  QualityChoice,
} from "./models.ts";
import { encodeJpeg, type MozjpegDecoder, type MozjpegEncoder } from "./mozjpeg.ts";
import { encodePng } from "./oxipng.ts";
import { findBestPngQuality } from "./png-quality-search.ts";
import type { QualitySearchResult } from "./quality-search-core.ts";
import { findBestQuality } from "./quality-search.ts";
import { findBestWebpQuality } from "./webp-quality-search.ts";

const MAX_NAME_ATTEMPTS = 1000;

export interface CompressRequest extends CompressionOptions {
  /** MozJPEG encoder. Needed for JPEG input only; WebP and PNG use other engines. */
  readonly encoder: MozjpegEncoder | null;
  /** MozJPEG decoder. Needed for JPEG input only, when the quality is automatic. */
  readonly decoder: MozjpegDecoder | null;
}

/**
 * Compresses exactly one image with the engine that belongs to its format, and
 * reports the outcome. Failures are returned as an unsuccessful result rather
 * than thrown, so batch runs can continue.
 */
export async function compressImage(
  file: ImageFile,
  request: CompressRequest,
): Promise<CompressionResult> {
  let originalSize = 0;
  let outputPath: string | null = null;

  try {
    originalSize = await fileSize(file.inputPath);
    outputPath = await resolveOutputPath(request.outputDir, file.relativePath);

    const encoded = await encodeToOutput(file, request, outputPath);

    const encodedSize = await fileSize(outputPath);
    const keptOriginal = request.skipIfLarger && encodedSize > originalSize;
    if (keptOriginal) {
      await copyFile(file.inputPath, outputPath);
    }

    const compressedSize = keptOriginal ? originalSize : encodedSize;

    return {
      success: true,
      filename: file.relativePath,
      inputPath: file.inputPath,
      outputPath,
      quality: encoded.quality,
      qualityChoice: encoded.qualityChoice,
      originalSize,
      compressedSize,
      encodedSize,
      keptOriginal,
      bytesSaved: originalSize - compressedSize,
      reductionPercentage: reductionPercentage(originalSize, compressedSize),
    };
  } catch (error) {
    // The encoder creates its output file before it can fail, so an aborted run
    // would otherwise leave a truncated image behind.
    if (outputPath !== null) {
      await discardPartialOutput(outputPath);
    }
    return {
      success: false,
      filename: file.relativePath,
      inputPath: file.inputPath,
      outputPath,
      originalSize,
      error: describeError(error),
    };
  }
}

interface EncodeOutcome {
  readonly quality: number;
  readonly qualityChoice: QualityChoice | null;
}

/** Writes the compressed image to `outputPath` using the engine for its format. */
async function encodeToOutput(
  file: ImageFile,
  request: CompressRequest,
  outputPath: string,
): Promise<EncodeOutcome> {
  switch (file.format) {
    case "webp":
      return encodeWebpToOutput(file, request, outputPath);
    case "png":
      return encodePngToOutput(file, request, outputPath);
    case "jpeg":
      return encodeJpegToOutput(file, request, outputPath);
  }
}

/**
 * PNG path: oxipng is always tried losslessly. Quality below 100 also tries
 * palette quantization, and automatic search measures that the same way as
 * JPEG and WebP.
 */
async function encodePngToOutput(
  file: ImageFile,
  request: CompressRequest,
  outputPath: string,
): Promise<EncodeOutcome> {
  if (request.quality.mode === "fixed") {
    const encoded = await encodePng({
      inputPath: file.inputPath,
      outputPath,
      quality: request.quality.quality,
    });
    return { quality: encoded.quality, qualityChoice: null };
  }

  const { maxQuality, minSsim } = request.quality;
  return searchQuality(outputPath, (workDir) =>
    findBestPngQuality({ inputPath: file.inputPath, maxQuality, minSsim, workDir }),
  );
}

/** JPEG path: MozJPEG encodes, and its own `djpeg` decodes for `--auto`. */
async function encodeJpegToOutput(
  file: ImageFile,
  request: CompressRequest,
  outputPath: string,
): Promise<EncodeOutcome> {
  const { encoder } = request;
  if (encoder === null) {
    throw new AppError("Compressing a JPEG needs MozJPEG, but no encoder was provided.");
  }

  if (request.quality.mode === "fixed") {
    await encodeJpeg({
      encoder,
      inputPath: file.inputPath,
      outputPath,
      quality: request.quality.quality,
    });
    return { quality: request.quality.quality, qualityChoice: null };
  }

  const { decoder } = request;
  if (decoder === null) {
    throw new AppError("Automatic quality selection needs a decoder, but none was provided.");
  }

  const { maxQuality, minSsim } = request.quality;
  return searchQuality(outputPath, (workDir) =>
    findBestQuality({ encoder, decoder, inputPath: file.inputPath, maxQuality, minSsim, workDir }),
  );
}

/** WebP path: always an automatic search, using sharp's native WebP encoder. */
async function encodeWebpToOutput(
  file: ImageFile,
  request: CompressRequest,
  outputPath: string,
): Promise<EncodeOutcome> {
  const { maxQuality, minSsim } = request.webpQuality;
  return searchQuality(outputPath, (workDir) =>
    findBestWebpQuality({ inputPath: file.inputPath, maxQuality, minSsim, workDir }),
  );
}

/**
 * Runs an automatic quality search in a scratch directory and keeps the encode it
 * settled on, so candidates never appear in the output directory.
 */
async function searchQuality(
  outputPath: string,
  search: (workDir: string) => Promise<QualitySearchResult>,
): Promise<EncodeOutcome> {
  const workDir = await mkdtemp(path.join(tmpdir(), "pixeltrim-"));
  try {
    const result = await search(workDir);

    await copyFile(result.encodedPath, outputPath);

    return {
      quality: result.quality,
      qualityChoice: {
        quality: result.quality,
        ssim: result.ssim,
        attempts: result.attempts,
        metThreshold: result.metThreshold,
      },
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/**
 * Percentage of the original size that was removed. Negative when the encoded
 * file grew.
 */
export function reductionPercentage(originalSize: number, compressedSize: number): number {
  if (originalSize === 0) {
    return 0;
  }
  return ((originalSize - compressedSize) / originalSize) * 100;
}

/**
 * Creates the output directory if needed.
 *
 * @throws AppError when the directory cannot be created.
 */
export async function ensureOutputDirectory(outputDir: string): Promise<void> {
  try {
    await mkdir(outputDir, { recursive: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") {
      throw new AppError(`No permission to create the output directory "${outputDir}".`);
    }
    if (code === "ENOTDIR" || code === "EEXIST") {
      throw new AppError(`Output path "${outputDir}" exists and is not a directory.`);
    }
    throw new AppError(
      `Could not create the output directory "${outputDir}": ${code ?? "unknown error"}`,
    );
  }
}

/**
 * Picks a free path inside the output directory, appending `-1`, `-2`, ... so an
 * existing file is never overwritten. Nested relative paths are recreated under
 * the output directory; image names stay the same as the source.
 */
async function resolveOutputPath(outputDir: string, relativePath: string): Promise<string> {
  const destDir = path.join(outputDir, path.dirname(relativePath));
  await ensureOutputDirectory(destDir);

  const filename = path.basename(relativePath);
  const extension = path.extname(filename);
  const baseName = filename.slice(0, filename.length - extension.length);

  for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt += 1) {
    const candidateName = attempt === 0 ? filename : `${baseName}-${attempt}${extension}`;
    const candidate = path.join(destDir, candidateName);
    if (!(await exists(candidate))) {
      return candidate;
    }
  }

  throw new AppError(
    `Could not find an unused output name for "${filename}" in "${destDir}" after ${MAX_NAME_ATTEMPTS} attempts.`,
  );
}

/** Removes a half-written output file. The path is always one we created. */
async function discardPartialOutput(outputPath: string): Promise<void> {
  try {
    await rm(outputPath, { force: true });
  } catch {
    // Leaving the file is not worth failing the run over.
  }
}

async function fileSize(filePath: string): Promise<number> {
  const stats = await stat(filePath);
  return stats.size;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}
