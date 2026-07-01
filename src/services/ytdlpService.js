const { execFile, spawn } = require("child_process");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const logger = require("../utils/logger");

const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const VALIDATION_TTL_MS = 60 * 1000;
const LIBRARY_KEY = "yt-dlp";

class YtDlpService {
  constructor(config) {
    this.rootConfig = config;
    this.config = config.ytdlp;
    this.downloads = new Map();
    this.validation = null;
    this.validationAt = 0;
    this.updateTimer = null;
    this.lastUpdateAt = null;
    this.lastUpdateError = null;
    this.onDownloadComplete = null;
  }

  setCompletionHandler(handler) {
    this.onDownloadComplete = handler;
  }

  start() {
    this.stop();
    syncYtDlpLibrary(this.rootConfig);
    if (!this.config.enabled) {
      return;
    }

    this.ensureReady()
      .then(() => this.updateIfNeeded())
      .catch((err) => {
        logger.info(`[yt-dlp] startup check failed message="${err.message}"`);
      });

    this.updateTimer = setInterval(() => {
      this.updateIfNeeded().catch((err) => {
        logger.info(`[yt-dlp] scheduled update failed message="${err.message}"`);
      });
    }, UPDATE_INTERVAL_MS);
    if (typeof this.updateTimer.unref === "function") {
      this.updateTimer.unref();
    }
  }

  stop() {
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
      this.updateTimer = null;
    }
  }

  restart() {
    this.validation = null;
    this.validationAt = 0;
    syncYtDlpLibrary(this.rootConfig);
    this.start();
  }

  async validate() {
    const now = Date.now();
    if (this.validation && now - this.validationAt < VALIDATION_TTL_MS) {
      return this.validation;
    }

    const result = await execOutput(this.config.binaryPath, ["--version"], { timeout: 3000 })
      .then((stdout) => ({
        enabled: this.config.enabled,
        ok: true,
        path: this.config.binaryPath,
        version: String(stdout || "").trim().split(/\r?\n/)[0] || "unknown",
        downloadPath: this.config.downloadPath,
        libraryKey: LIBRARY_KEY
      }))
      .catch((err) => ({
        enabled: this.config.enabled,
        ok: false,
        path: this.config.binaryPath,
        error: err.message,
        downloadPath: this.config.downloadPath,
        libraryKey: LIBRARY_KEY
      }));

    this.validation = result;
    this.validationAt = Date.now();
    return result;
  }

  async ensureReady() {
    if (!this.config.enabled) {
      throw httpError(400, "YT-DLP support is disabled.");
    }

    const validation = await this.validate();
    if (!validation.ok) {
      throw httpError(503, `YT-DLP is not available at "${validation.path}".`);
    }

    await fs.mkdir(this.config.downloadPath, { recursive: true });
    return validation;
  }

  async updateIfNeeded() {
    if (!this.config.enabled || this.lastUpdateAt && Date.now() - this.lastUpdateAt < UPDATE_INTERVAL_MS) {
      return this.status();
    }

    const validation = await this.validate();
    if (!validation.ok) {
      return this.status();
    }

    if (await installedByApt(this.config.binaryPath)) {
      logger.info(`[yt-dlp] self-update skipped package-manager=true path="${this.config.binaryPath}"`);
      this.lastUpdateAt = Date.now();
      this.lastUpdateError = null;
      return this.status();
    }

    try {
      logger.info(`[yt-dlp] self-update starting path="${this.config.binaryPath}"`);
      await execOutput(this.config.binaryPath, ["-U"], { timeout: 120000 });
      this.lastUpdateAt = Date.now();
      this.lastUpdateError = null;
      this.validation = null;
      logger.info("[yt-dlp] self-update complete");
    } catch (err) {
      this.lastUpdateAt = Date.now();
      this.lastUpdateError = err.message;
      logger.info(`[yt-dlp] self-update failed message="${err.message}"`);
    }

    return this.status();
  }

  status() {
    return {
      enabled: this.config.enabled,
      libraryKey: LIBRARY_KEY,
      downloadPath: this.config.downloadPath,
      binaryPath: this.config.binaryPath,
      lastUpdateAt: this.lastUpdateAt ? new Date(this.lastUpdateAt).toISOString() : null,
      lastUpdateError: this.lastUpdateError,
      downloads: [...this.downloads.values()].map(publicDownload)
    };
  }

  async startDownload(url, userId = "global") {
    await this.ensureReady();
    const inputUrl = String(url || "").trim();
    if (!/^https?:\/\//i.test(inputUrl)) {
      throw httpError(400, "A valid http(s) URL is required.");
    }

    const id = crypto.randomBytes(8).toString("hex");
    const record = {
      id,
      url: inputUrl,
      userId,
      status: "starting",
      percent: 0,
      speed: null,
      eta: null,
      filename: null,
      outputPath: null,
      message: "Starting download...",
      error: null,
      startedAt: new Date().toISOString(),
      finishedAt: null
    };
    this.downloads.set(id, record);

    const args = downloadArgs(this.config.downloadPath, inputUrl, this.config.allowPlaylists);
    logger.info(`[yt-dlp] download starting id=${id} url="${inputUrl}" output="${this.config.downloadPath}"`);
    logger.full(`[yt-dlp] command ${this.config.binaryPath} ${args.map(quoteArg).join(" ")}`);

    const child = spawn(this.config.binaryPath, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    record.status = "downloading";
    record.processId = child.pid || null;

    const onData = (chunk) => {
      updateProgress(record, chunk.toString());
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (err) => {
      finishDownload(record, "failed", err.message);
      logger.error(`[yt-dlp] download spawn failed id=${id} message="${err.message}"`, err);
    });
    child.on("close", (code) => {
      if (record.status === "failed") {
        return;
      }
      if (code === 0) {
        markDownloadIndexing(record);
        logger.info(`[yt-dlp] download complete id=${id}; indexing library`);
        Promise.resolve()
          .then(() => this.onDownloadComplete && this.onDownloadComplete(record))
          .then(() => {
            finishDownload(record, "complete", null);
            logger.info(`[yt-dlp] post-download index complete id=${id}`);
          })
          .catch((err) => {
            finishDownload(record, "failed", `Download completed, but indexing failed: ${err.message}`);
            logger.error(`[yt-dlp] post-download reindex failed id=${id} message="${err.message}"`, err);
          });
        return;
      }
      finishDownload(record, "failed", `yt-dlp exited with code ${code}`);
      logger.error(`[yt-dlp] download failed id=${id} code=${code}`);
    });

    return publicDownload(record);
  }
}

function syncYtDlpLibrary(config) {
  const withoutVirtual = (config.libraries || []).filter((library) => library.key !== LIBRARY_KEY);
  if (!config.ytdlp || !config.ytdlp.enabled) {
    config.libraries = withoutVirtual;
    return null;
  }

  const library = ytDlpLibrary(config.ytdlp);
  config.libraries = [...withoutVirtual, library];
  return library;
}

function ytDlpLibrary(settings) {
  return {
    key: LIBRARY_KEY,
    title: settings.libraryTitle || "YT-DLP",
    type: "movies",
    rawType: "yt-dlp",
    threeD: false,
    path: settings.downloadPath,
    managed: true,
    noMetadata: true,
    noSubtitles: true,
    localThumbnails: true
  };
}

function downloadArgs(downloadPath, url, allowPlaylists) {
  return [
    "--newline",
    "--progress",
    "-f",
    "bv*[vcodec^=avc1]+ba[acodec^=mp4a]/b[vcodec^=avc1][acodec^=mp4a]/bv*+ba/b",
    "-P",
    downloadPath,
    "-o",
    "%(title).200B [%(id)s].%(ext)s",
    ...(allowPlaylists ? [] : ["--no-playlist"]),
    url
  ];
}

function updateProgress(record, output) {
  const lines = String(output || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const destination = line.match(/\[download\]\s+Destination:\s+(.+)$/i)
      || line.match(/\[Merger\]\s+Merging formats into\s+"(.+)"$/i);
    if (destination) {
      record.outputPath = destination[1];
      record.filename = path.basename(destination[1]);
    }

    const percent = line.match(/\[download\]\s+(\d+(?:\.\d+)?)%/i);
    if (percent) {
      record.percent = Number.parseFloat(percent[1]);
      record.message = line;
      const speed = line.match(/\bat\s+(.+?)\s+ETA\b/i);
      const eta = line.match(/\bETA\s+([^\s]+)/i);
      record.speed = speed ? speed[1] : record.speed;
      record.eta = eta ? eta[1] : record.eta;
      continue;
    }

    if (/^\[(download|ExtractAudio|Merger|Fixup|ffmpeg)\]/i.test(line)) {
      record.message = line;
    }
  }
}

function finishDownload(record, status, error) {
  record.status = status;
  record.finishedAt = new Date().toISOString();
  record.percent = status === "complete" ? 100 : record.percent;
  record.error = error;
  record.message = error || (status === "complete" ? "Download complete." : record.message);
}

function markDownloadIndexing(record) {
  record.status = "indexing";
  record.percent = 100;
  record.speed = null;
  record.eta = null;
  record.message = "Download complete. Adding file to the library...";
}

function publicDownload(record) {
  const { processId, ...publicRecord } = record;
  return publicRecord;
}

async function installedByApt(binaryPath) {
  if (process.platform !== "linux") {
    return false;
  }

  try {
    const resolved = path.isAbsolute(binaryPath)
      ? binaryPath
      : String(await execOutput("sh", ["-lc", `command -v ${quoteShell(binaryPath)}`], { timeout: 3000 })).trim();
    if (!resolved) {
      return false;
    }
    await execOutput("dpkg-query", ["-S", resolved], { timeout: 3000 });
    return true;
  } catch (err) {
    return false;
  }
}

function execOutput(binaryPath, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(binaryPath, args, {
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
      timeout: options.timeout || 0
    }, (err, stdout, stderr) => {
      if (err) {
        err.message = stderr ? `${err.message}: ${stderr}` : err.message;
        reject(err);
        return;
      }
      resolve(stdout);
    });
  });
}

function quoteArg(value) {
  const text = String(value || "");
  return /\s/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
}

function quoteShell(value) {
  return `'${String(value || "").replace(/'/g, "'\\''")}'`;
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

module.exports = {
  LIBRARY_KEY,
  YtDlpService,
  syncYtDlpLibrary
};
