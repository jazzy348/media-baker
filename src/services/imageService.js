const fs = require("fs/promises");
const path = require("path");
const { createId } = require("../utils/mediaParsers");

class ImageService {
  constructor(config, imageProcessor, cachedImages) {
    this.imageProcessor = imageProcessor;
    this.cachedImages = cachedImages;
    this.cacheDir = path.join(config.metadata.cachePath, "images");
    this.dimensions = new Map();
    this.inFlight = new Map();
  }

  async fileFor(mediaFile, maxDimension = null) {
    if (!maxDimension) {
      return mediaFile.filePath;
    }

    const limit = Math.max(1, Math.min(Number.parseInt(maxDimension, 10) || 1024, 1024));
    const stat = await fs.stat(mediaFile.filePath);
    const sourceKey = `${mediaFile.filePath}:${stat.mtimeMs}:${stat.size}`;
    const dimensions = await this.imageDimensions(mediaFile.filePath, sourceKey);
    if (dimensions.width <= limit && dimensions.height <= limit) {
      return mediaFile.filePath;
    }

    const outputPath = path.join(this.cacheDir, `${mediaFile.id}-${createId(sourceKey)}-${limit}.webp`);
    try {
      await fs.access(outputPath);
      return outputPath;
    } catch (err) {
      if (err.code !== "ENOENT") {
        throw err;
      }
    }

    if (!this.inFlight.has(outputPath)) {
      this.inFlight.set(outputPath, this.createDerivative(mediaFile.filePath, outputPath, limit)
        .finally(() => this.inFlight.delete(outputPath)));
    }
    await this.inFlight.get(outputPath);
    return outputPath;
  }

  async collageFor(libraryKey, folderPath, mediaFiles) {
    const sources = mediaFiles.slice(0, 4);
    if (sources.length === 0) {
      throw new Error("Image folder is empty");
    }

    const sourceKey = [libraryKey, folderPath, ...sources.map((item) =>
      `${item.filePath}:${item.mtimeMs || item.addedAtMs || 0}`
    )].join("|");
    const outputDir = path.join(this.cacheDir, "collages");
    const outputPath = path.join(outputDir, `${createId(sourceKey)}.webp`);
    try {
      await fs.access(outputPath);
      return outputPath;
    } catch (err) {
      if (err.code !== "ENOENT") {
        throw err;
      }
    }

    if (!this.inFlight.has(outputPath)) {
      this.inFlight.set(outputPath, (async () => {
        await fs.mkdir(outputDir, { recursive: true });
        try {
          await this.imageProcessor.createImageCollage(sources.map((item) => item.filePath), outputPath);
        } catch (err) {
          await fs.rm(outputPath, { force: true });
          throw err;
        }
      })().finally(() => this.inFlight.delete(outputPath)));
    }
    await this.inFlight.get(outputPath);
    return outputPath;
  }

  async imageDimensions(filePath, sourceKey) {
    if (this.dimensions.has(sourceKey)) {
      return this.dimensions.get(sourceKey);
    }
    const dimensions = await this.imageProcessor.metadata(filePath);
    this.dimensions.set(sourceKey, dimensions);
    return dimensions;
  }

  async createDerivative(inputPath, outputPath, limit) {
    try {
      await this.cachedImages.cacheFile(inputPath, path.dirname(outputPath), path.basename(outputPath), limit);
    } catch (err) {
      await fs.rm(outputPath, { force: true });
      throw err;
    }
  }
}

module.exports = { ImageService };
