const fs = require("fs/promises");
const path = require("path");
const logger = require("../utils/logger");

const SEGMENT_PREFIX = "__stream_error_";

class FallbackStreamService {
  constructor(config, ffmpeg) {
    this.config = config.fallbackStream;
    this.ffmpeg = ffmpeg;
    this.ready = false;
    this.playlistPath = path.join(this.config.cachePath, "fallback.m3u8");
    this.manifestPath = path.join(this.config.cachePath, "fallback.json");
  }

  async prepare() {
    if (!this.config.enabled) {
      this.ready = false;
      logger.info("[fallback] fallback stream disabled");
      return;
    }

    if (!await fileExists(this.config.sourcePath)) {
      this.ready = false;
      logger.info(`[fallback] source missing; fallback stream disabled source="${this.config.sourcePath}"`);
      return;
    }

    await fs.mkdir(this.config.cachePath, { recursive: true });
    const sourceStat = await fs.stat(this.config.sourcePath);
    if (await this.isCurrent(sourceStat)) {
      this.ready = true;
      logger.info(`[fallback] using cached fallback HLS playlist="${this.playlistPath}"`);
      return;
    }

    logger.info(`[fallback] generating fallback HLS source="${this.config.sourcePath}" cache="${this.config.cachePath}"`);
    await fs.rm(this.config.cachePath, { recursive: true, force: true });
    await fs.mkdir(this.config.cachePath, { recursive: true });

    const args = [
      "-hide_banner",
      "-y",
      "-i",
      this.config.sourcePath,
      "-map",
      "0:v:0",
      "-map",
      "0:a:0?",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "23",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-f",
      "hls",
      "-hls_time",
      String(this.config.segmentSeconds),
      "-hls_list_size",
      "0",
      "-hls_flags",
      "independent_segments",
      "-hls_segment_filename",
      path.join(this.config.cachePath, "segment_%05d.ts"),
      this.playlistPath
    ];

    await this.ffmpeg.exec(this.ffmpeg.ffmpegPath, args);
    await fs.writeFile(this.manifestPath, JSON.stringify({
      sourcePath: this.config.sourcePath,
      size: sourceStat.size,
      mtimeMs: sourceStat.mtimeMs,
      segmentSeconds: this.config.segmentSeconds,
      generatedAt: new Date().toISOString()
    }, null, 2));
    this.ready = true;
    logger.info(`[fallback] generated fallback HLS playlist="${this.playlistPath}"`);
  }

  async isCurrent(sourceStat) {
    try {
      const manifest = JSON.parse(await fs.readFile(this.manifestPath, "utf8"));
      await fs.access(this.playlistPath);
      return manifest.sourcePath === this.config.sourcePath
        && manifest.size === sourceStat.size
        && manifest.mtimeMs === sourceStat.mtimeMs
        && manifest.segmentSeconds === this.config.segmentSeconds;
    } catch (err) {
      if (err.code === "ENOENT") {
        return false;
      }

      throw err;
    }
  }

  async serve(req, res, statusCode = 200) {
    if (!this.ready) {
      res.status(statusCode).json({ error: "Fallback stream is not available" });
      return;
    }

    const segment = this.segmentFilename(req);
    if (segment) {
      await this.serveSegment(segment, res);
      return;
    }

    const playlist = await fs.readFile(this.playlistPath, "utf8");
    res.status(200);
    res.type("application/vnd.apple.mpegurl");
    res.set("Cache-Control", "no-store");
    res.send(this.rewritePlaylist(playlist, req.path));
  }

  async serveSegment(segment, res) {
    const filePath = path.join(this.config.cachePath, segment);
    try {
      await fs.access(filePath);
    } catch (err) {
      if (err.code === "ENOENT") {
        res.status(404).json({ error: "Fallback segment not found" });
        return;
      }

      throw err;
    }

    res.status(200);
    res.type("video/mp2t");
    res.set("Cache-Control", "public, max-age=3600");
    res.sendFile(filePath);
  }

  rewritePlaylist(playlist, requestPath) {
    const basePath = path.posix.dirname(requestPath.replace(/\\/g, "/"));
    const prefix = basePath === "/" ? "" : basePath;

    return playlist
      .split(/\r?\n/)
      .map((line) => {
        if (!line.trim() || line.startsWith("#")) {
          return line;
        }

        const segment = path.posix.basename(line.trim());
        const disguised = segment.replace(/^segment_/, SEGMENT_PREFIX);
        return `${prefix}/${disguised}`;
      })
      .join("\n");
  }

  segmentFilename(req) {
    const basename = path.posix.basename(req.path.replace(/\\/g, "/"));
    const match = basename.match(new RegExp(`^${SEGMENT_PREFIX}(\\d{5})\\.ts$`));
    return match ? `segment_${match[1]}.ts` : null;
  }
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (err) {
    if (err.code === "ENOENT") {
      return false;
    }

    throw err;
  }
}

module.exports = { FallbackStreamService };
