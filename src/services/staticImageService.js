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

  async createLabelledPoster(inputPath, outputPath, label) {
    const width = 600;
    const height = 900;
    return this.run(async () => {
      const mark = await sharp(inputPath)
        .autoOrient()
        .resize(280, 280, { fit: "contain", withoutEnlargement: true, fastShrinkOnLoad: true })
        .png()
        .toBuffer();
      const overlay = labelledPosterOverlay(label, width, height);
      await this.writeAtomic(outputPath, (temporaryPath) => sharp({
        create: {
          width,
          height,
          channels: 3,
          background: "#0b1118"
        }
      })
        .composite([
          { input: mark, left: 160, top: 150 },
          { input: overlay, left: 0, top: 0 }
        ])
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

function labelledPosterOverlay(value, width, height) {
  const lines = wrapPosterLabel(value, 18, 5);
  const longestLine = Math.max(...lines.map((line) => [...line].length), 1);
  const fontSize = Math.max(28, Math.min(44, Math.floor(500 / (longestLine * 0.68))));
  const lineHeight = Math.round(fontSize * 1.28);
  const blockHeight = lineHeight * lines.length;
  const firstBaseline = 625 + Math.max(0, Math.floor((210 - blockHeight) / 2)) + fontSize;
  const text = lines.map((line, index) => (
    `<text x="${width / 2}" y="${firstBaseline + index * lineHeight}" text-anchor="middle">${escapeXml(line)}</text>`
  )).join("");
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`
    + `<style>text{fill:#f4f8fb;font-family:Arial,sans-serif;font-size:${fontSize}px;font-weight:700;letter-spacing:0}</style>`
    + text
    + "</svg>"
  );
}

function wrapPosterLabel(value, maximumCharacters, maximumLines) {
  const words = String(value || "Unknown show").trim().split(/\s+/).filter(Boolean);
  const lines = [];
  for (const word of words.length > 0 ? words : ["Unknown", "show"]) {
    const chunks = splitLabelWord(word, maximumCharacters);
    for (const chunk of chunks) {
      const current = lines[lines.length - 1];
      if (current && `${current} ${chunk}`.length <= maximumCharacters) {
        lines[lines.length - 1] = `${current} ${chunk}`;
      } else {
        lines.push(chunk);
      }
    }
  }
  if (lines.length <= maximumLines) return lines;
  const visible = lines.slice(0, maximumLines);
  visible[maximumLines - 1] = `${visible[maximumLines - 1].slice(0, maximumCharacters - 3).trimEnd()}...`;
  return visible;
}

function splitLabelWord(value, maximumCharacters) {
  const characters = [...String(value || "")];
  const chunks = [];
  for (let offset = 0; offset < characters.length; offset += maximumCharacters) {
    chunks.push(characters.slice(offset, offset + maximumCharacters).join(""));
  }
  return chunks.length > 0 ? chunks : [""];
}

function escapeXml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

module.exports = { StaticImageService };
