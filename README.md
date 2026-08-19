# PixelTrim

A command-line tool that compresses JPEG and WebP images locally. Each file stays in the format it came in as.

## Formats

| Input | Engine | Output |
| --- | --- | --- |
| `.jpg`, `.jpeg` | [MozJPEG](https://github.com/mozilla/mozjpeg) (`cjpeg`) | JPEG |
| `.webp` | [sharp](https://sharp.pixelplumbing.com/)'s native WebP encoder | WebP |

JPEG needs MozJPEG installed. WebP only needs `npm install`. Mixed directories are fine.

## Requirements

- Node.js 22.6 or newer
- MozJPEG's `cjpeg` — **only for JPEG** (see below)

WebP needs nothing extra: sharp is installed by `npm install`.

## Installing MozJPEG

MozJPEG is **not** installed by `npm install`. Skip this section if you only compress WebP.

> **`cjpeg` from libjpeg or libjpeg-turbo is not a substitute.** PixelTrim checks the encoder and refuses a plain libjpeg-turbo build.

### macOS

```bash
brew install mozjpeg
```

Homebrew keeps `cjpeg` off your `PATH`. PixelTrim finds it automatically. To set the path yourself:

```bash
export MOZJPEG_PATH="$(brew --prefix mozjpeg)/bin/cjpeg"
```

### Linux

| Distribution | Command |
| --- | --- |
| Arch | `yay -S mozjpeg` (AUR) |
| Any, with conda | `conda install -c conda-forge mozjpeg` |
| Debian, Ubuntu, Fedora, others | build from source (below) |

### Windows

Use WSL and follow the Linux instructions, or build from source and point `MOZJPEG_PATH` at `cjpeg.exe`.

### Building from source

Needs `cmake` and, for SIMD, `nasm`.

```bash
git clone --depth 1 https://github.com/mozilla/mozjpeg.git
cd mozjpeg
cmake -B build -DCMAKE_BUILD_TYPE=Release -DPNG_SUPPORTED=0
cmake --build build -j
export MOZJPEG_PATH="$PWD/build/cjpeg"
```

Add `-DWITH_SIMD=0` if NASM is unavailable.

### Checking the installation

```bash
npm run start -- test-images/photo1.jpg
```

The `JPEG:` line names the encoder that was found.

## Setup

```bash
npm install
```

## Usage

```bash
npm run start -- <file-or-directory> [options]
```

By default, quality is chosen per image so the result stays visually close to the original. Pass `--quality` for a fixed value.

| Option | Description |
| --- | --- |
| `--quality <1-100>` | Fixed quality, or the upper bound of automatic search (default `85`) |
| `--no-auto` | Use a fixed quality (`85` unless `--quality` says otherwise) |
| `--min-ssim <0-1>` | How similar automatic search must stay to the original, default `0.955` |
| `--output <dir>` | Output directory. Created if it does not exist. |
| `--allow-larger` | Write the re-encoded file even when it is bigger than the original |
| `--help`, `-h` | Show usage |

### Examples

```bash
npm run start -- photo.jpg                                   # quality chosen per image
npm run start -- banner.webp                                 # -> banner_compressed/
npm run start -- ./photos/                                   # -> photos_compressed/
npm run start -- ./photos/ --min-ssim 0.99                    # be fussier about quality
npm run start -- photo.jpg --quality 75                       # fixed quality 75
npm run start -- ./photos/ --no-auto --output ./out/          # fixed quality 85
npm run start -- ./photos/ --allow-larger                     # keep every re-encode
```

A run never writes a file bigger than the source unless you pass `--allow-larger`. Otherwise the original is copied instead.

### Single file

```
photo.jpg    ->  photo_compressed/photo.jpg
banner.webp  ->  banner_compressed/banner.webp
```

### Directory

Only `.jpg`, `.jpeg` and `.webp` files directly inside the directory are processed. Subdirectories are not visited.

```
photos/                    photos_compressed/
├── photo1.jpg      ->     ├── photo1.jpg
├── photo2.jpg             ├── photo2.jpg
├── photo3.jpeg            ├── photo3.jpeg
├── banner.webp            └── banner.webp
├── document.png    (ignored)
└── text.txt        (ignored)
```

Output is always a directory. Originals are never overwritten. If a name already exists in the output folder, the new file is written as `photo-1.jpg`, then `photo-2.jpg`, and so on. When `--output` is omitted, the default is `<input-name>_compressed/` next to the input.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run start -- <input>` | Run the CLI |
| `npm run typecheck` | Type-check with strict TypeScript |
| `npm run build` | Emit JavaScript to `dist/` |
