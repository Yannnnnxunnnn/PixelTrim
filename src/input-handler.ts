import type { Dirent, Stats } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";

import { AppError } from "./errors.ts";
import type { ImageFile, ImageFormat, ResolvedInput } from "./models.ts";

const EXTENSIONS: Readonly<Record<ImageFormat, readonly string[]>> = {
  jpeg: [".jpg", ".jpeg"],
  png: [".png"],
  webp: [".webp"],
};

const FORMAT_NAMES: Readonly<Record<ImageFormat, string>> = {
  jpeg: "JPEG",
  png: "PNG",
  webp: "WebP",
};

/** Every supported extension, for error messages: `.jpg, .jpeg, .png and .webp`. */
const SUPPORTED_EXTENSIONS = Object.values(EXTENSIONS).flat();

/** PNG signature: 89 50 4E 47 0D 0A 1A 0A. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Bytes needed to recognise any supported format. WebP needs the most, at 12. */
const SIGNATURE_LENGTH = 12;

const OUTPUT_DIR_SUFFIX = "_compressed";

/**
 * Validates the input argument and reduces it to a list of image files, so that
 * single-file and directory input follow the same downstream path.
 *
 * @throws AppError when the input is missing, unsupported or contains no images.
 */
export async function resolveInput(inputArgument: string): Promise<ResolvedInput> {
  const inputPath = path.resolve(inputArgument);
  const stats = await statInput(inputPath, inputArgument);

  if (stats.isFile()) {
    return resolveFileInput(inputPath, inputArgument);
  }
  if (stats.isDirectory()) {
    return resolveDirectoryInput(inputPath, inputArgument);
  }
  throw new AppError(`"${inputArgument}" is neither a file nor a directory.`);
}

/**
 * The format a file name claims, by extension and case-insensitively, or `null`
 * when the extension is not one PixelTrim compresses.
 */
export function detectFormat(filename: string): ImageFormat | null {
  const extension = path.extname(filename).toLowerCase();
  for (const [format, extensions] of Object.entries(EXTENSIONS) as [
    ImageFormat,
    readonly string[],
  ][]) {
    if (extensions.includes(extension)) {
      return format;
    }
  }
  return null;
}

async function resolveFileInput(inputPath: string, inputArgument: string): Promise<ResolvedInput> {
  const format = detectFormat(inputPath);
  if (format === null) {
    throw new AppError(
      `"${inputArgument}" is not a supported image. Only ${listExtensions()} files are supported.`,
    );
  }

  const name = FORMAT_NAMES[format];
  if (!(await hasSignature(inputPath, format))) {
    throw new AppError(
      `"${inputArgument}" has a ${name} extension but does not contain ${name} data.`,
    );
  }

  const filename = path.basename(inputPath);
  const baseName = filename.slice(0, filename.length - path.extname(filename).length);

  return {
    kind: "file",
    files: [{ inputPath, relativePath: filename, format }],
    defaultOutputDir: path.join(path.dirname(inputPath), `${baseName}${OUTPUT_DIR_SUFFIX}`),
  };
}

/** Collects images in the directory and every nested subdirectory. */
async function resolveDirectoryInput(
  inputPath: string,
  inputArgument: string,
): Promise<ResolvedInput> {
  const files = (await collectImages(inputPath, "", inputArgument)).sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );

  if (!files.length) {
    throw new AppError(
      `No ${listExtensions("or")} files found in "${inputArgument}" or its subdirectories.`,
    );
  }

  return {
    kind: "directory",
    files,
    defaultOutputDir: path.join(
      path.dirname(inputPath),
      `${path.basename(inputPath)}${OUTPUT_DIR_SUFFIX}`,
    ),
  };
}

/**
 * Walks `dirPath` and every nested directory, collecting supported image files.
 * `relativeDir` is the path from the input root; empty at the top level.
 */
async function collectImages(
  dirPath: string,
  relativeDir: string,
  inputArgument: string,
): Promise<ImageFile[]> {
  const listedAs = relativeDir ? path.join(inputArgument, relativeDir) : inputArgument;
  const entries = await readDirectory(dirPath, listedAs);
  const files: ImageFile[] = [];
  const directories: Dirent[] = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      directories.push(entry);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }

    const format = detectFormat(entry.name);
    if (format === null) {
      continue;
    }

    const relativePath = relativeDir ? path.join(relativeDir, entry.name) : entry.name;
    files.push({
      inputPath: path.join(dirPath, entry.name),
      relativePath,
      format,
    });
  }

  directories.sort((left, right) => left.name.localeCompare(right.name));
  for (const directory of directories) {
    const nestedRelative = relativeDir ? path.join(relativeDir, directory.name) : directory.name;
    files.push(
      ...(await collectImages(path.join(dirPath, directory.name), nestedRelative, inputArgument)),
    );
  }

  return files;
}

async function statInput(inputPath: string, inputArgument: string): Promise<Stats> {
  try {
    return await stat(inputPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new AppError(`Input "${inputArgument}" does not exist.`);
    }
    if (code === "EACCES") {
      throw new AppError(`No permission to read "${inputArgument}".`);
    }
    throw new AppError(`Could not read "${inputArgument}": ${describeCode(code)}`);
  }
}

async function readDirectory(inputPath: string, inputArgument: string): Promise<Dirent[]> {
  try {
    return await readdir(inputPath, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EACCES") {
      throw new AppError(`No permission to list the directory "${inputArgument}".`);
    }
    throw new AppError(`Could not list the directory "${inputArgument}": ${describeCode(code)}`);
  }
}

/** Confirms the file really holds the format its extension claims. */
async function hasSignature(filePath: string, format: ImageFormat): Promise<boolean> {
  const header = await readHeader(filePath);
  switch (format) {
    case "jpeg":
      return isJpegHeader(header);
    case "png":
      return isPngHeader(header);
    case "webp":
      return isWebpHeader(header);
  }
}

/** Checks for the eight-byte PNG signature. */
function isPngHeader(header: Buffer): boolean {
  return (
    header.length >= PNG_SIGNATURE.length &&
    header.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  );
}

/** Checks for the JPEG start-of-image marker (FF D8 FF). */
function isJpegHeader(header: Buffer): boolean {
  return header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
}

/** A WebP file is a RIFF container whose form type is `WEBP`. */
function isWebpHeader(header: Buffer): boolean {
  return (
    header.length >= SIGNATURE_LENGTH &&
    header.toString("latin1", 0, 4) === "RIFF" &&
    header.toString("latin1", 8, SIGNATURE_LENGTH) === "WEBP"
  );
}

/** Reads the leading bytes, returning fewer for a file shorter than that. */
async function readHeader(filePath: string): Promise<Buffer> {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(SIGNATURE_LENGTH);
    const { bytesRead } = await handle.read(buffer, 0, SIGNATURE_LENGTH, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Renders the supported extensions as `.jpg, .jpeg, .png and .webp`. */
function listExtensions(conjunction: "and" | "or" = "and"): string {
  const last = SUPPORTED_EXTENSIONS[SUPPORTED_EXTENSIONS.length - 1];
  return `${SUPPORTED_EXTENSIONS.slice(0, -1).join(", ")} ${conjunction} ${last}`;
}

function describeCode(code: string | undefined): string {
  return code ?? "unknown error";
}
