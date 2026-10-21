/**
 * Formats that can be compressed. Each one has its own encoder, and the output
 * keeps the format of its input.
 */
export type ImageFormat = "jpeg" | "png" | "webp";

/** An image file selected for compression. */
export interface ImageFile {
  /** Absolute path to the source image. */
  readonly inputPath: string;
  /**
   * Path relative to the input root, using the platform separator.
   * For a single file this is the basename, e.g. `photo.jpeg`.
   */
  readonly relativePath: string;
  /** Decides which encoder handles the file. */
  readonly format: ImageFormat;
}

/** How the user's input argument was interpreted. */
export type InputKind = "file" | "directory";

/** The validated result of inspecting the input argument. */
export interface ResolvedInput {
  readonly kind: InputKind;
  readonly files: readonly ImageFile[];
  /** Output directory to use when `--output` is not given. */
  readonly defaultOutputDir: string;
}

/**
 * How the encoder quality is chosen: either a fixed value, or the lowest value
 * that still looks like the source.
 */
export interface AutoQualitySetting {
  readonly mode: "auto";
  readonly maxQuality: number;
  readonly minSsim: number;
}

export type QualitySetting = { readonly mode: "fixed"; readonly quality: number } | AutoQualitySetting;

/** Encoder settings for a single compression run. */
export interface CompressionOptions {
  /** Quality for JPEG and PNG, either fixed or automatic. */
  readonly quality: QualitySetting;
  /** Quality for WebP, which is always chosen automatically. */
  readonly webpQuality: AutoQualitySetting;
  readonly outputDir: string;
  /**
   * When true (the CLI default), an encoded file that is larger than its source
   * is discarded and the original is copied to the output directory instead.
   * `--allow-larger` turns this off.
   */
  readonly skipIfLarger: boolean;
}

interface CompressionResultBase {
  readonly filename: string;
  readonly inputPath: string;
  readonly originalSize: number;
}

/** What the automatic quality search settled on. */
export interface QualityChoice {
  readonly quality: number;
  /** Structural similarity of the chosen encode against the source, 0-1. */
  readonly ssim: number;
  /** How many quality levels were encoded and measured. */
  readonly attempts: number;
  /** False when even the highest allowed quality missed the SSIM threshold. */
  readonly metThreshold: boolean;
}

export interface CompressionSuccess extends CompressionResultBase {
  readonly success: true;
  readonly outputPath: string;
  /** Quality actually used by the encoder. */
  readonly quality: number;
  /** Present only when the quality was chosen automatically. */
  readonly qualityChoice: QualityChoice | null;
  /** Size of the file that now sits in the output directory. */
  readonly compressedSize: number;
  /** Size the encoder produced. Differs from `compressedSize` when the original was kept. */
  readonly encodedSize: number;
  /** True when the encoded file was larger, so the original was copied instead. */
  readonly keptOriginal: boolean;
  /** Negative when the encoded file ended up larger than the original. */
  readonly bytesSaved: number;
  /** Negative when the encoded file ended up larger than the original. */
  readonly reductionPercentage: number;
}

export interface CompressionFailure extends CompressionResultBase {
  readonly success: false;
  /** Path the image would have been written to, for diagnostics. */
  readonly outputPath: string | null;
  readonly error: string;
}

export type CompressionResult = CompressionSuccess | CompressionFailure;

/** Aggregated statistics across every processed image. */
export interface CompressionSummary {
  readonly processed: number;
  readonly successful: number;
  readonly failed: number;
  /** Images whose original was kept because re-encoding made them larger. */
  readonly keptOriginal: number;
  readonly totalOriginalSize: number;
  readonly totalCompressedSize: number;
  readonly totalBytesSaved: number;
  readonly totalReductionPercentage: number;
}
