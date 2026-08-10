const crypto = require("crypto");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const sharp = require("sharp");
const logger = require("../utils/logger");

const DEFAULT_QUALITY = 82;
const DEFAULT_MAX_CONCURRENT = Math.max(2, Math.min(4, availableProcessors()));

class StaticImageService {
  constructor(ffmpeg, options = {}) {
    this.ffmpeg = ffmpeg;
    this.maxConcurrent = positiveInteger(options.maxConcurrent) || DEFAULT_MAX_CONCURRENT;
    this.active = 0;
    this.pending = [];
    logger.info(`[images] static processor=sharp sharp=${sharp.versions.sharp} libvips=${sharp.versions.vips} maxConcurrent=${this.maxConcurrent}`);
  }

  async metadata(filePath) {
    return this.run(async () => {
      try {
        const metadata = await sharp(filePath).metadata();
        return orientedDimensions(metadata);
      } catch (err) {
        if (!supportsFfmpegFallback(err)) throw err;
        logger.full(`[images] Sharp metadata failed input="${filePath}" message="${err.message}"; falling back to FFprobe`);
        const probe = await this.ffmpeg.probe(filePath);
        const stream = (probe.streams || []).find((entry) => entry.codec_type === "video");
        return {
          width: Number.parseInt(stream && stream.width, 10) || Number.MAX_SAFE_INTEGER,
          height: Number.parseInt(stream && stream.height, 10) || Number.MAX_SAFE_INTEGER
        };
      }
    });
  }

  async resizeImage(filePath, outputPath, maxDimension) {
    const limit = positiveInteger(maxDimension) || 1024;
    return this.run(() => this.writeWebp(filePath, outputPath, {
      width: limit,
      height: limit,
      withoutEnlargement: true
    }, () => this.writeAtomic(outputPath, (temporaryPath) => this.ffmpeg.resizeImage(filePath, temporaryPath, limit))));
  }

  async resizeImageBuffer(filePath, dimensions) {
    const resize = normalizeDimensions(dimensions);
    if (!resize.width && !resize.height) {
      throw new Error("A width or height is required to resize an image");
    }

    return this.run(async () => {
      try {
        return await sharp(filePath)
          .autoOrient()
          .resize({
            ...resize,
            fit: "inside",
            withoutEnlargement: true,
            fastShrinkOnLoad: true
          })
          .webp({ quality: DEFAULT_QUALITY, effort: 4 })
          .toBuffer();
      } catch (err) {
        if (!supportsFfmpegFallback(err)) throw err;
        logger.full(`[images] Sharp memory resize failed input="${filePath}" message="${err.message}"; falling back to FFmpeg`);
        return this.ffmpeg.resizeImageBuffer(filePath, resize);
      }
    });
  }

  async createImageCollage(inputPaths, outputPath) {
    const sources = inputPaths.slice(0, 4);
    if (sources.length === 0) {
      throw new Error("At least one image is required to create a collage");
    }

    return this.run(async () => {
      try {
        const twoColumns = sources.length > 1;
        const twoRows = sources.length > 2;
        const tileWidth = twoColumns ? 512 : 1024;
        const tileHeight = twoRows ? 512 : 1024;
        const tiles = await Promise.all(sources.map(async (source, index) => ({
          input: await sharp(source)
            .autoOrient()
            .resize(tileWidth, tileHeight, { fit: "cover", fastShrinkOnLoad: true })
            .png()
            .toBuffer(),
          left: index % 2 * tileWidth,
          top: Math.floor(index / 2) * tileHeight
        })));

        await this.writeAtomic(outputPath, (temporaryPath) => sharp({
          create: {
            width: 1024,
            height: 1024,
            channels: 3,
            background: "#000000"
          }
        })
          .composite(tiles)
          .webp({ quality: DEFAULT_QUALITY, effort: 4 })
          .toFile(temporaryPath));
      } catch (err) {
        if (!supportsFfmpegFallback(err)) throw err;
        logger.full(`[images] Sharp collage failed output="${outputPath}" message="${err.message}"; falling back to FFmpeg`);
        await this.writeAtomic(outputPath, (temporaryPath) => this.ffmpeg.createImageCollage(sources, temporaryPath));
      }
    });
  }

  async createPosterAtlas(inputPaths, outputPath, placeholderPath) {
    const sources = Array.from({ length: 12 }, (_, index) => inputPaths[index] || placeholderPath);
    return this.run(async () => {
      const tiles = await Promise.all(sources.map(async (source, index) => ({
        input: await posterAtlasTile(source, placeholderPath),
        left: index % 4 * 300,
        top: Math.floor(index / 4) * 450
      })));
      await this.writeAtomic(outputPath, (temporaryPath) => sharp({
        create: {
          width: 1200,
          height: 1350,
          channels: 3,
          background: "#080d12"
        }
      })
        .composite(tiles)
        .removeAlpha()
        .toColourspace("srgb")
        .webp({ quality: 88, effort: 4 })
        .toFile(temporaryPath));
    });
  }

  async writeWebp(input, outputPath, dimensions, fallback) {
    try {
      await this.writeAtomic(outputPath, (temporaryPath) => sharp(input)
        .autoOrient()
        .resize({
          width: dimensions.width,
          height: dimensions.height,
          fit: "inside",
          withoutEnlargement: dimensions.withoutEnlargement !== false,
          fastShrinkOnLoad: true
        })
        .webp({ quality: DEFAULT_QUALITY, effort: 4 })
        .toFile(temporaryPath));
    } catch (err) {
      if (!supportsFfmpegFallback(err)) throw err;
      logger.full(`[images] Sharp resize failed output="${outputPath}" message="${err.message}"; falling back to FFmpeg`);
      await fallback();
    }
  }

  async writeAtomic(outputPath, writer) {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    const temporaryPath = path.join(
      path.dirname(outputPath),
      `.${path.basename(outputPath)}.${crypto.randomBytes(6).toString("hex")}.tmp.webp`
    );
    try {
      await writer(temporaryPath);
      await fs.rm(outputPath, { force: true });
      await fs.rename(temporaryPath, outputPath);
    } catch (err) {
      await fs.rm(temporaryPath, { force: true });
      throw err;
    }
  }

  run(task) {
    return new Promise((resolve, reject) => {
      this.pending.push({ task, resolve, reject });
      this.drain();
    });
  }

  drain() {
    while (this.active < this.maxConcurrent && this.pending.length > 0) {
      const work = this.pending.shift();
      this.active += 1;
      Promise.resolve()
        .then(work.task)
        .then(work.resolve, work.reject)
        .finally(() => {
          this.active -= 1;
          this.drain();
        });
    }
  }
}

function normalizeDimensions(dimensions) {
  return {
    width: positiveInteger(dimensions && dimensions.width),
    height: positiveInteger(dimensions && dimensions.height)
  };
}

function positiveInteger(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function orientedDimensions(metadata) {
  const width = positiveInteger(metadata && metadata.width) || Number.MAX_SAFE_INTEGER;
  const height = positiveInteger(metadata && metadata.height) || Number.MAX_SAFE_INTEGER;
  return [5, 6, 7, 8].includes(Number(metadata && metadata.orientation))
    ? { width: height, height: width }
    : { width, height };
}

function availableProcessors() {
  return typeof os.availableParallelism === "function"
    ? os.availableParallelism()
    : (os.cpus() || []).length || 2;
}

function supportsFfmpegFallback(err) {
  if (!err) return false;
  if (["ENOENT", "EACCES", "EPERM", "ENOSPC", "EROFS"].includes(err.code)) return false;
  const message = String(err.message || err);
  if (/missing|does not exist|unable to open for write|permission denied|no space left/i.test(message)) return false;
  return /unsupported|unknown image|invalid|corrupt|decode|decoder|bad header|bad seek|foreign load|heif|avif|svg/i.test(message);
}

async function posterAtlasTile(source, placeholderPath) {
  try {
    return await renderPosterAtlasTile(source);
  } catch (err) {
    if (!placeholderPath || source === placeholderPath) throw err;
    logger.full(`[images] poster atlas tile fallback input="${source}" message="${err.message}"`);
    return renderPosterAtlasTile(placeholderPath);
  }
}

function renderPosterAtlasTile(source) {
  return sharp(source)
    .autoOrient()
    .resize(292, 438, { fit: "cover", position: "centre", fastShrinkOnLoad: true })
    .removeAlpha()
    .toColourspace("srgb")
    .extend({ top: 6, bottom: 6, left: 4, right: 4, extendWith: "copy" })
    .png()
    .toBuffer();
}

module.exports = { StaticImageService };
