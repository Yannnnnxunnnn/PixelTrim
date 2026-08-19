import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { AppError } from "./errors.ts";

const execFileAsync = promisify(execFile);

/** Where a usable encoder was discovered. */
export type EncoderSource = "env" | "path" | "homebrew";

/** A located MozJPEG command-line encoder. */
export interface MozjpegEncoder {
  readonly executablePath: string;
  readonly source: EncoderSource;
  /** Version banner reported by the encoder, when it could be read. */
  readonly version: string | null;
}

export interface EncodeRequest {
  readonly encoder: MozjpegEncoder;
  readonly inputPath: string;
  readonly outputPath: string;
  /** JPEG quality, 1-100. */
  readonly quality: number;
}

/** MozJPEG's `djpeg` decoder, used to compare images pixel by pixel. */
export interface MozjpegDecoder {
  readonly executablePath: string;
}

export interface DecodeRequest {
  readonly decoder: MozjpegDecoder;
  readonly inputPath: string;
  /** Destination for the grayscale PGM. */
  readonly outputPath: string;
}

/**
 * Candidate command names, most specific first. Distributions that install
 * MozJPEG alongside libjpeg rename the binary to avoid a clash.
 */
const COMMAND_CANDIDATES = ["mozcjpeg", "cjpeg-mozjpeg", "cjpeg"] as const;

/** Decoder names, matched to the encoder names above. */
const DECODER_CANDIDATES = ["mozdjpeg", "djpeg-mozjpeg", "djpeg"] as const;

/** `brew` can hang on network calls, so it is never waited on for long. */
const BREW_TIMEOUT_MS = 3000;

const INSTALL_HINT = [
  "Install MozJPEG and make its `cjpeg` encoder available, for example:",
  "  brew install mozjpeg",
  "Homebrew keeps mozjpeg keg-only, so point PixelTrim at the binary:",
  "  export MOZJPEG_PATH=\"$(brew --prefix mozjpeg)/bin/cjpeg\"",
  "See README.md for other installation options.",
].join("\n");

/**
 * Finds a MozJPEG encoder, preferring an explicit `MOZJPEG_PATH`, then `PATH`,
 * then a keg-only Homebrew installation.
 *
 * @throws AppError when no usable encoder exists.
 */
export async function locateEncoder(): Promise<MozjpegEncoder> {
  const configuredPath = process.env["MOZJPEG_PATH"]?.trim();
  if (configuredPath) {
    if (!(await isExecutableFile(configuredPath))) {
      throw new AppError(
        `MOZJPEG_PATH is set to "${configuredPath}", but that is not an executable file.`,
        INSTALL_HINT,
      );
    }
    return describeEncoder(configuredPath, "env");
  }

  for (const command of COMMAND_CANDIDATES) {
    const found = await findOnPath(command);
    if (found === null) {
      continue;
    }
    const encoder = await describeEncoder(found, "path");
    if (isMozjpeg(encoder, command)) {
      return encoder;
    }
  }

  const brewPath = await findHomebrewEncoder();
  if (brewPath !== null) {
    return describeEncoder(brewPath, "homebrew");
  }

  throw new AppError("MozJPEG was not found on this system.", INSTALL_HINT);
}

/**
 * Finds the `djpeg` decoder that belongs with an encoder. It normally sits in
 * the same directory, so that is checked before `DJPEG_PATH` candidates on PATH.
 *
 * @throws AppError when no decoder is available.
 */
export async function locateDecoder(encoder: MozjpegEncoder): Promise<MozjpegDecoder> {
  const configuredPath = process.env["DJPEG_PATH"]?.trim();
  if (configuredPath) {
    if (!(await isExecutableFile(configuredPath))) {
      throw new AppError(
        `DJPEG_PATH is set to "${configuredPath}", but that is not an executable file.`,
      );
    }
    return { executablePath: configuredPath };
  }

  const encoderDirectory = path.dirname(encoder.executablePath);
  for (const command of DECODER_CANDIDATES) {
    const sibling = path.join(encoderDirectory, command);
    if (await isExecutableFile(sibling)) {
      return { executablePath: sibling };
    }
  }

  for (const command of DECODER_CANDIDATES) {
    const found = await findOnPath(command);
    if (found !== null) {
      return { executablePath: found };
    }
  }

  throw new AppError(
    "MozJPEG's `djpeg` decoder was not found, so image quality cannot be measured.",
    "It normally ships alongside `cjpeg`. Set DJPEG_PATH to its location, or run without --auto.",
  );
}

/**
 * Decodes a JPEG to a grayscale PGM. Only the luma channel is needed, because
 * that is what the SSIM comparison uses.
 *
 * @throws AppError when the decoder cannot be run or fails.
 */
export async function decodeToGrayscale(request: DecodeRequest): Promise<void> {
  const { decoder, inputPath, outputPath } = request;
  const args = ["-grayscale", "-outfile", outputPath, inputPath];

  const result = await runTool(decoder.executablePath, args);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || `exit code ${result.code ?? "unknown"}`;
    throw new AppError(`MozJPEG failed to decode the image for comparison: ${detail}`);
  }
}

/**
 * Encodes one JPEG with MozJPEG. Arguments are passed as an array so no shell
 * is involved and file names cannot be interpreted as commands.
 *
 * @throws AppError when the encoder cannot be run or exits with a failure.
 */
export async function encodeJpeg(request: EncodeRequest): Promise<void> {
  const { encoder, inputPath, outputPath, quality } = request;
  const args = [
    "-quality",
    String(quality),
    "-optimize",
    "-progressive",
    "-outfile",
    outputPath,
    inputPath,
  ];

  const result = await runTool(encoder.executablePath, args);

  if (result.code !== 0) {
    const detail = result.stderr.trim() || `exit code ${result.code ?? "unknown"}`;
    throw new AppError(`MozJPEG failed to compress the image: ${detail}`);
  }
}

interface ToolRun {
  readonly code: number | null;
  readonly stderr: string;
}

function runTool(executablePath: string, args: readonly string[]): Promise<ToolRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(executablePath, [...args], {
      stdio: ["ignore", "ignore", "pipe"],
    });

    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      reject(new AppError(describeSpawnError(executablePath, error), INSTALL_HINT));
    });

    child.on("close", (code) => {
      resolve({ code, stderr });
    });
  });
}

function describeSpawnError(executablePath: string, error: NodeJS.ErrnoException): string {
  switch (error.code) {
    case "ENOENT":
      return `The MozJPEG executable "${executablePath}" no longer exists.`;
    case "EACCES":
      return `No permission to run the MozJPEG executable "${executablePath}".`;
    default:
      return `Could not run the MozJPEG executable "${executablePath}": ${error.message}`;
  }
}

async function describeEncoder(
  executablePath: string,
  source: EncoderSource,
): Promise<MozjpegEncoder> {
  return { executablePath, source, version: await readVersion(executablePath) };
}

/**
 * Reads the encoder's version banner. Returns `null` when the build does not
 * support `-version`, which older encoders do not.
 */
async function readVersion(executablePath: string): Promise<string | null> {
  try {
    const { stdout, stderr } = await execFileAsync(executablePath, ["-version"]);
    const banner = `${stdout}${stderr}`.trim();
    return banner.length ? banner.split("\n")[0]!.trim() : null;
  } catch {
    return null;
  }
}

/**
 * A bare `cjpeg` on PATH is often libjpeg-turbo's encoder, which cannot read
 * JPEG input at all, so it is only accepted when it identifies as MozJPEG.
 * Unknown banners are accepted rather than rejected, and any failure surfaces
 * later as a normal compression error.
 */
function isMozjpeg(encoder: MozjpegEncoder, command: string): boolean {
  if (command !== "cjpeg") {
    return true;
  }
  if (encoder.version === null) {
    return true;
  }
  return /mozjpeg/i.test(encoder.version) || !/libjpeg/i.test(encoder.version);
}

async function findOnPath(command: string): Promise<string | null> {
  const searchPath = process.env["PATH"] ?? "";
  for (const directory of searchPath.split(path.delimiter)) {
    if (!directory) {
      continue;
    }
    const candidate = path.join(directory, command);
    if (await isExecutableFile(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Handles the keg-only Homebrew layout, where `cjpeg` is not put on PATH.
 *
 * The standard prefixes are checked directly first because asking `brew` itself
 * is slow and can fail entirely when it cannot reach its API servers.
 */
async function findHomebrewEncoder(): Promise<string | null> {
  const prefixes = [process.env["HOMEBREW_PREFIX"], "/opt/homebrew", "/usr/local"];
  for (const prefix of prefixes) {
    if (prefix === undefined || !prefix) {
      continue;
    }
    const candidate = path.join(prefix, "opt", "mozjpeg", "bin", "cjpeg");
    if (await isExecutableFile(candidate)) {
      return candidate;
    }
  }
  return askBrewForEncoder();
}

/** Last resort for non-standard Homebrew prefixes. */
async function askBrewForEncoder(): Promise<string | null> {
  const brew = await findOnPath("brew");
  if (brew === null) {
    return null;
  }
  try {
    const { stdout } = await execFileAsync(brew, ["--prefix", "mozjpeg"], {
      timeout: BREW_TIMEOUT_MS,
    });
    const candidate = path.join(stdout.trim(), "bin", "cjpeg");
    return (await isExecutableFile(candidate)) ? candidate : null;
  } catch {
    return null;
  }
}

async function isExecutableFile(candidate: string): Promise<boolean> {
  try {
    const stats = await stat(candidate);
    if (!stats.isFile()) {
      return false;
    }
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
