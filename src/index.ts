import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";

import { compressImage, ensureOutputDirectory, reductionPercentage } from "./compressor.ts";
import { AppError, describeError } from "./errors.ts";
import { resolveInput } from "./input-handler.ts";
import type {
  CompressionResult,
  CompressionSummary,
  ImageFile,
  QualityChoice,
  QualitySetting,
} from "./models.ts";
import {
  locateDecoder,
  locateEncoder,
  type MozjpegDecoder,
  type MozjpegEncoder,
} from "./mozjpeg.ts";
import { describeWebpEncoder, type WebpEncoder } from "./sharp-webp.ts";
import { formatBytes, formatPercentage, formatSignedBytes } from "./utils/file-size.ts";

const DEFAULT_QUALITY = 85;
const DEFAULT_MIN_SSIM = 0.955;
const MIN_QUALITY = 1;
const MAX_QUALITY = 100;
const LABEL_WIDTH = 12;
const HEADER_WIDTH = 9;
const DIVIDER = "=".repeat(40);

interface CliArguments {
  readonly input: string;
  readonly quality: QualitySetting;
  readonly outputDir: string | null;
  readonly skipIfLarger: boolean;
}

/** MozJPEG's encoder, together with the decoder an automatic search needs. */
interface JpegEngine {
  readonly encoder: MozjpegEncoder;
  readonly decoder: MozjpegDecoder | null;
}

/** The engines a run needs. Each is null when no input file uses that format. */
interface Engines {
  readonly jpeg: JpegEngine | null;
  readonly webp: WebpEncoder | null;
}

const USAGE = `PixelTrim - JPEG compression with MozJPEG, WebP compression with sharp

Usage:
  npm run start -- <file-or-directory> [options]

Each image keeps its format: .jpg and .jpeg are re-encoded with MozJPEG, .webp
with sharp's WebP encoder.

By default the quality is chosen per image: the lowest value that still looks
like the original, up to ${DEFAULT_QUALITY}. Pass --quality to use a fixed value instead.

Options:
  --quality <1-100>   Use this exact quality instead of choosing one. With
                      --auto it is the upper bound of the search.
  --no-auto           Use a fixed quality (${DEFAULT_QUALITY} unless --quality says otherwise)
  --min-ssim <0-1>    Similarity the automatic search must keep (default: ${DEFAULT_MIN_SSIM})
  --output <dir>      Output directory (default: <input>_compressed)
  --allow-larger      Write the re-encoded file even when it is bigger than the
                      original. By default the original is kept instead.
  --help              Show this help

Examples:
  npm run start -- photo.jpg
  npm run start -- banner.webp
  npm run start -- ./photos/ --min-ssim 0.99
  npm run start -- photo.jpg --quality 75
  npm run start -- ./photos/ --auto --quality 90 --output ./compressed/`;

async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseCliArguments(argv);
  if (parsed === null) {
    console.log(USAGE);
    return 0;
  }

  const input = await resolveInput(parsed.input);
  const engines = await locateEngines(input.files, parsed.quality.mode === "auto");
  const outputDir =
    parsed.outputDir === null ? input.defaultOutputDir : path.resolve(parsed.outputDir);
  await ensureOutputDirectory(outputDir);

  printHeader(engines, parsed.quality, outputDir, input.files);

  const results: CompressionResult[] = [];
  for (const file of input.files) {
    const result = await compressImage(file, {
      encoder: engines.jpeg?.encoder ?? null,
      decoder: engines.jpeg?.decoder ?? null,
      quality: parsed.quality,
      outputDir,
      skipIfLarger: parsed.skipIfLarger,
    });
    results.push(result);
    printResult(result);
  }

  printSummary(summarize(results));

  return results.some((result) => !result.success) ? 1 : 0;
}

/**
 * Prepares only the engines the input actually needs, so a run of WebP images
 * does not require MozJPEG to be installed, and vice versa.
 */
async function locateEngines(files: readonly ImageFile[], auto: boolean): Promise<Engines> {
  const hasJpeg = files.some((file) => file.format === "jpeg");
  const hasWebp = files.some((file) => file.format === "webp");

  return {
    jpeg: hasJpeg ? await locateJpegEngine(auto) : null,
    webp: hasWebp ? describeWebpEncoder() : null,
  };
}

async function locateJpegEngine(auto: boolean): Promise<JpegEngine> {
  const encoder = await locateEncoder();
  return { encoder, decoder: auto ? await locateDecoder(encoder) : null };
}

function parseCliArguments(argv: readonly string[]): CliArguments | null {
  const { values, positionals } = parseCommandLine(argv);

  if (values.help === true) {
    return null;
  }
  if (!positionals.length) {
    throw new AppError("No input given.", `\n${USAGE}`);
  }
  if (positionals.length > 1) {
    throw new AppError(
      `Expected a single input, but got ${positionals.length}: ${positionals.join(", ")}`,
    );
  }

  return {
    input: positionals[0]!,
    quality: resolveQualitySetting(values),
    outputDir: values.output ?? null,
    skipIfLarger: values["allow-larger"] !== true,
  };
}

type CliValues = ReturnType<typeof parseCommandLine>["values"];

/**
 * Quality is chosen automatically unless a fixed value is asked for, either with
 * `--no-auto` or by naming a `--quality` without also passing `--auto`.
 */
function resolveQualitySetting(values: CliValues): QualitySetting {
  const explicitAuto = values.auto === true;
  const noAuto = values["no-auto"] === true;

  if (explicitAuto && noAuto) {
    throw new AppError("--auto and --no-auto cannot be used together.");
  }

  const quality = parseQuality(values.quality);
  const fixed = noAuto || (values.quality !== undefined && !explicitAuto);

  if (fixed) {
    if (values["min-ssim"] !== undefined) {
      throw new AppError(
        "--min-ssim only applies when the quality is chosen automatically.",
        "Drop --min-ssim, or add --auto to search for a quality up to the value given by --quality.",
      );
    }
    return { mode: "fixed", quality };
  }

  return { mode: "auto", maxQuality: quality, minSsim: parseMinSsim(values["min-ssim"]) };
}

function parseCommandLine(argv: readonly string[]): ReturnType<typeof parseArgs<typeof config>> {
  const config = {
    args: [...argv],
    allowPositionals: true,
    options: {
      quality: { type: "string" },
      auto: { type: "boolean" },
      "no-auto": { type: "boolean" },
      "min-ssim": { type: "string" },
      output: { type: "string" },
      "allow-larger": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  } as const;

  try {
    return parseArgs(config);
  } catch (error) {
    throw new AppError(describeError(error), `\n${USAGE}`);
  }
}

function parseQuality(raw: string | undefined): number {
  if (raw === undefined) {
    return DEFAULT_QUALITY;
  }
  if (!/^\d+$/.test(raw.trim())) {
    throw new AppError(`Invalid --quality value "${raw}". Expected a whole number from 1 to 100.`);
  }

  const quality = Number(raw.trim());
  if (quality < MIN_QUALITY || quality > MAX_QUALITY) {
    throw new AppError(
      `Invalid --quality value "${raw}". Quality must be between ${MIN_QUALITY} and ${MAX_QUALITY}.`,
    );
  }
  return quality;
}

function parseMinSsim(raw: string | undefined): number {
  if (raw === undefined) {
    return DEFAULT_MIN_SSIM;
  }

  const value = Number(raw.trim());
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new AppError(
      `Invalid --min-ssim value "${raw}". Expected a number above 0 and up to 1, such as 0.99.`,
    );
  }
  return value;
}

function summarize(results: readonly CompressionResult[]): CompressionSummary {
  const successes = results.filter((result) => result.success);
  const totalOriginalSize = successes.reduce((total, result) => total + result.originalSize, 0);
  const totalCompressedSize = successes.reduce((total, result) => total + result.compressedSize, 0);

  return {
    processed: results.length,
    successful: successes.length,
    failed: results.length - successes.length,
    keptOriginal: successes.filter((result) => result.keptOriginal).length,
    totalOriginalSize,
    totalCompressedSize,
    totalBytesSaved: totalOriginalSize - totalCompressedSize,
    totalReductionPercentage: reductionPercentage(totalOriginalSize, totalCompressedSize),
  };
}

function printHeader(
  engines: Engines,
  quality: QualitySetting,
  outputDir: string,
  files: readonly ImageFile[],
): void {
  if (engines.jpeg !== null) {
    console.log(`${field("JPEG:")}${describeJpegEngine(engines.jpeg.encoder)}`);
  }
  if (engines.webp !== null) {
    console.log(`${field("WebP:")}${describeWebpEngine(engines.webp)}`);
  }
  console.log(`${field("Quality:")}${describeQualitySetting(quality)}`);
  console.log(`${field("Output:")}${outputDir}`);
  console.log("");
  console.log(`Processing ${describeImageCount(files)}...`);
  console.log("");
}

function describeJpegEngine(encoder: MozjpegEncoder): string {
  const version = encoder.version === null ? "" : ` (${encoder.version})`;
  return `${encoder.executablePath}${version}`;
}

function describeWebpEngine(encoder: WebpEncoder): string {
  const version = encoder.version === null ? "" : ` ${encoder.version}`;
  const libwebp = encoder.libwebpVersion === null ? "" : ` (libwebp ${encoder.libwebpVersion})`;
  return `sharp${version}${libwebp}`;
}

/** `3 images`, or `3 images (2 JPEG, 1 WebP)` when a run mixes formats. */
function describeImageCount(files: readonly ImageFile[]): string {
  const noun = files.length === 1 ? "image" : "images";
  const jpeg = files.filter((file) => file.format === "jpeg").length;
  const webp = files.length - jpeg;
  const breakdown = jpeg && webp ? ` (${jpeg} JPEG, ${webp} WebP)` : "";

  return `${files.length} ${noun}${breakdown}`;
}

function describeQualitySetting(quality: QualitySetting): string {
  return quality.mode === "fixed"
    ? String(quality.quality)
    : `auto, up to ${quality.maxQuality} (SSIM >= ${quality.minSsim})`;
}

function printResult(result: CompressionResult): void {
  if (!result.success) {
    console.log(`✗ ${result.filename}`);
    console.log(`${label("Failed:")}${result.error}`);
    console.log("");
    return;
  }

  if (result.keptOriginal) {
    const added = result.encodedSize - result.originalSize;
    console.log(`= ${result.filename}  (kept the original)`);
    console.log(`${label("Original:")}${formatBytes(result.originalSize)}`);
    console.log(
      `${label("Re-encoded:")}${formatBytes(result.encodedSize)} (${formatSignedBytes(added)})`,
    );
    console.log(`${label("Reduction:")}${formatPercentage(0)}`);
    printQualityChoice(result.qualityChoice);
    console.log("");
    return;
  }

  const grew = result.bytesSaved < 0;
  console.log(`${grew ? "!" : "✓"} ${result.filename}${grew ? "  (larger than the original)" : ""}`);
  console.log(`${label("Original:")}${formatBytes(result.originalSize)}`);
  console.log(`${label("Compressed:")}${formatBytes(result.compressedSize)}`);
  console.log(
    grew
      ? `${label("Difference:")}${formatSignedBytes(-result.bytesSaved)}`
      : `${label("Saved:")}${formatBytes(result.bytesSaved)}`,
  );
  console.log(`${label("Reduction:")}${formatPercentage(result.reductionPercentage)}`);
  printQualityChoice(result.qualityChoice);
  console.log("");
}

/** Shows what the automatic search settled on, and nothing in fixed-quality runs. */
function printQualityChoice(choice: QualityChoice | null): void {
  if (choice === null) {
    return;
  }

  const ssim = `SSIM ${choice.ssim.toFixed(4)}`;
  const note = choice.metThreshold ? "" : ", below the requested similarity";
  console.log(`${label("Quality:")}${choice.quality} (${ssim}${note})`);
}

function printSummary(summary: CompressionSummary): void {
  const grew = summary.totalBytesSaved < 0;

  console.log(DIVIDER);
  console.log("Compression Summary");
  console.log(DIVIDER);
  console.log("");
  console.log(`Processed:  ${summary.processed}`);
  console.log(`Successful: ${summary.successful}`);
  console.log(`Failed:     ${summary.failed}`);
  if (summary.keptOriginal) {
    console.log(`Kept as-is: ${summary.keptOriginal} (compression would have made them larger)`);
  }
  console.log("");

  if (summary.successful) {
    console.log(`Total original size:   ${formatBytes(summary.totalOriginalSize)}`);
    console.log(`Total compressed size: ${formatBytes(summary.totalCompressedSize)}`);
    console.log(
      grew
        ? `Total difference:      ${formatSignedBytes(-summary.totalBytesSaved)}`
        : `Total saved:           ${formatBytes(summary.totalBytesSaved)}`,
    );
    console.log(`Total reduction:       ${formatPercentage(summary.totalReductionPercentage)}`);
    if (grew) {
      console.log("");
      console.log("The compressed images are larger overall than the originals.");
    }
    console.log("");
  }

  console.log(DIVIDER);
}

function label(text: string): string {
  return `  ${text.padEnd(LABEL_WIDTH, " ")}`;
}

/** Header labels are aligned without the indent the per-image labels use. */
function field(text: string): string {
  return text.padEnd(HEADER_WIDTH, " ");
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(`Error: ${describeError(error)}`);
  process.exitCode = 1;
}
