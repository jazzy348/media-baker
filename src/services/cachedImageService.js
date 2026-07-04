const fs = require("fs/promises");
const path = require("path");
const { createId } = require("../utils/mediaParsers");
const logger = require("../utils/logger");

const MAX_DIMENSION = 1024;
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif", ".tif", ".tiff", ".avif", ".heic", ".heif", ".svg"]);

class CachedImageService {
  constructor(config, ffmpeg) {
    this.config = config;
    this.ffmpeg = ffmpeg;
    this.inFlight = new Map();
    this.migrationPromise = null;
    this.markerPath = path.join(config.metadata.cachePath, "image-cache-webp-v2.json");
    this.legacyMarkerPath = path.join(config.metadata.cachePath, "image-cache-webp-v1.json");
  }

  filename(filename) {
    return `${path.parse(path.basename(filename)).name}.webp`;
  }

  async cacheBuffer(buffer, directory, filename, sourceExtension = null) {
    const outputFilename = this.filename(filename);
    const outputPath = path.join(directory, outputFilename);
    if (!this.inFlight.has(outputPath)) {
      this.inFlight.set(outputPath, this.writeBuffer(buffer, directory, outputPath, sourceExtension || path.extname(filename))
        .finally(() => this.inFlight.delete(outputPath)));
    }
    await this.inFlight.get(outputPath);
    return outputFilename;
  }

  async cacheFile(sourcePath, directory, filename) {
    const outputFilename = this.filename(filename);
    const outputPath = path.join(directory, outputFilename);
    if (!this.inFlight.has(outputPath)) {
      this.inFlight.set(outputPath, this.convert(sourcePath, outputPath)
        .finally(() => this.inFlight.delete(outputPath)));
    }
    await this.inFlight.get(outputPath);
    return outputFilename;
  }

  async migrate(metadataStore, iptvCachePath) {
    if (this.migrationPromise) {
      return this.migrationPromise;
    }
    this.migrationPromise = this.runMigration(metadataStore, iptvCachePath)
      .finally(() => {
        this.migrationPromise = null;
      });
    return this.migrationPromise;
  }

  async runMigration(metadataStore, iptvCachePath) {
    const previousMarker = await readJson(this.markerPath);
    if (previousMarker && previousMarker.completed) {
      return { skipped: true, converted: 0 };
    }
    const retryFiles = previousMarker && Array.isArray(previousMarker.failures)
      ? new Set(previousMarker.failures.map((entry) => entry.file))
      : null;

    const directories = [
      path.join(this.config.metadata.cachePath, "posters"),
      path.join(this.config.metadata.cachePath, "thumbnails"),
      path.join(this.config.metadata.cachePath, "images"),
      path.join(iptvCachePath, "icons")
    ];
    const filenameMap = new Map();
    const removals = [];
    const failures = [];
    let converted = 0;
    let reused = 0;
    logger.info("[images] cached image WebP migration starting maxDimension=1024");

    for (const directory of directories) {
      const derivativeDirectory = path.resolve(directory) === path.resolve(path.join(this.config.metadata.cachePath, "images"));
      const entries = await fs.readdir(directory, { withFileTypes: true }).catch((err) => {
        if (err.code === "ENOENT") return [];
        throw err;
      });
      for (const entry of entries) {
        if (!entry.isFile() || !IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
          continue;
        }
        const sourcePath = path.join(directory, entry.name);
        if (retryFiles && !retryFiles.has(sourcePath)) {
          continue;
        }
        if (path.extname(entry.name).toLowerCase() === ".webp") {
          reused += 1;
          continue;
        }
        const derivativeFilename = entry.name.replace(/-\d+\.[^.]+$/i, "-1024.webp");
        const outputFilename = derivativeDirectory && derivativeFilename !== entry.name
          ? derivativeFilename
          : this.filename(entry.name);
        const outputPath = path.join(directory, outputFilename);
        try {
          await this.cacheFile(sourcePath, directory, outputFilename);
        } catch (err) {
          const message = summarizeConversionError(err.message);
          failures.push({ file: sourcePath, error: message });
          logger.error(`[images] cached image migration skipped file="${sourcePath}" message="${message}"`);
          continue;
        }
        filenameMap.set(entry.name, outputFilename);
        if (sourcePath !== outputPath) {
          removals.push(sourcePath);
        }
        converted += 1;
      }
    }

    if (metadataStore && filenameMap.size > 0) {
      await metadataStore.replaceCachedImageFilenames(filenameMap);
    }
    await migrateIptvManifest(path.join(iptvCachePath, "icons"), filenameMap);
    await Promise.all(removals.map((filePath) => fs.rm(filePath, { force: true })));
    await fs.mkdir(path.dirname(this.markerPath), { recursive: true });
    await fs.writeFile(this.markerPath, JSON.stringify({
      completed: failures.length === 0,
      completedAt: new Date().toISOString(),
      converted,
      reused,
      failures
    }, null, 2));
    if (failures.length === 0) {
      await fs.rm(this.legacyMarkerPath, { force: true });
    }
    logger.info(`[images] cached image WebP migration complete converted=${converted} reused=${reused} removedOriginals=${removals.length} failed=${failures.length}`);
    return { skipped: false, converted, reused, failures: failures.length };
  }

  async writeBuffer(buffer, directory, outputPath, extension) {
    await fs.mkdir(directory, { recursive: true });
    const inputPath = path.join(directory, `.image-${createId(`${outputPath}:${Date.now()}:${Math.random()}`)}${safeExtension(extension)}`);
    try {
      await fs.writeFile(inputPath, buffer);
      await this.convert(inputPath, outputPath);
    } finally {
      await fs.rm(inputPath, { force: true });
    }
  }

  async convert(sourcePath, outputPath) {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    const samePath = path.resolve(sourcePath) === path.resolve(outputPath);
    const targetPath = samePath ? `${outputPath}.migrating.webp` : outputPath;
    const input = await conversionInput(sourcePath);
    try {
      await this.ffmpeg.resizeImage(input.filePath, targetPath, MAX_DIMENSION);
      if (samePath) {
        await fs.rm(outputPath, { force: true });
        await fs.rename(targetPath, outputPath);
      }
    } catch (err) {
      await fs.rm(targetPath, { force: true });
      throw err;
    } finally {
      if (input.temporary) {
        await fs.rm(input.filePath, { force: true });
      }
    }
  }
}

async function conversionInput(sourcePath) {
  const detectedExtension = await detectImageExtension(sourcePath);
  if (!detectedExtension || detectedExtension === path.extname(sourcePath).toLowerCase()) {
    return { filePath: sourcePath, temporary: false };
  }

  const temporaryPath = path.join(
    path.dirname(sourcePath),
    `.${path.basename(sourcePath)}-${createId(`${sourcePath}:${Date.now()}:${Math.random()}`)}${detectedExtension}`
  );
  try {
    await fs.link(sourcePath, temporaryPath);
  } catch (err) {
    await fs.copyFile(sourcePath, temporaryPath);
  }
  return { filePath: temporaryPath, temporary: true };
}

async function detectImageExtension(filePath) {
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(16);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const bytes = buffer.subarray(0, bytesRead);
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return ".jpg";
    if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return ".png";
    if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return ".webp";
    if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))) return ".gif";
    if (bytes.length >= 2 && bytes.toString("ascii", 0, 2) === "BM") return ".bmp";
    if (bytes.length >= 4 && (bytes.subarray(0, 4).equals(Buffer.from([0x49, 0x49, 0x2a, 0x00])) || bytes.subarray(0, 4).equals(Buffer.from([0x4d, 0x4d, 0x00, 0x2a])))) return ".tiff";
    if (bytes.length >= 12 && bytes.toString("ascii", 4, 8) === "ftyp") {
      const brand = bytes.toString("ascii", 8, 12);
      if (["avif", "avis"].includes(brand)) return ".avif";
      if (["heic", "heix", "hevc", "hevx", "mif1", "msf1"].includes(brand)) return ".heic";
    }
    return null;
  } finally {
    await handle.close();
  }
}

function summarizeConversionError(message) {
  const lines = String(message || "Image conversion failed")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.find((line) => /invalid data|no .* data found|cannot determine format|unsupported/i.test(line))
    || lines[0]
    || "Image conversion failed";
}

async function migrateIptvManifest(iconDirectory, filenameMap) {
  const manifestPath = path.join(iconDirectory, "icons.json");
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return;
    throw err;
  }
  let changed = false;
  for (const entry of Object.values(manifest)) {
    const replacement = entry && filenameMap.get(entry.filename);
    if (replacement && replacement !== entry.filename) {
      entry.filename = replacement;
      changed = true;
    }
  }
  if (changed) {
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  }
}

function safeExtension(extension) {
  const value = String(extension || "").toLowerCase();
  return IMAGE_EXTENSIONS.has(value) ? value : ".img";
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT" || err instanceof SyntaxError) return null;
    throw err;
  }
}

module.exports = { CachedImageService, MAX_DIMENSION };
