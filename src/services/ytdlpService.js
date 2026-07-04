const { execFile, spawn } = require("child_process");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const logger = require("../utils/logger");

const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const VALIDATION_TTL_MS = 60 * 1000;
const INDEX_REFRESH_DELAY_MS = 750;
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
    this.indexRefreshTimer = null;
    this.indexRefreshPromise = Promise.resolve();
    this.indexDirty = false;
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
    if (this.indexRefreshTimer) {
      clearTimeout(this.indexRefreshTimer);
      this.indexRefreshTimer = null;
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
      outputPaths: [],
      fileCount: 0,
      title: null,
      playlistTitle: null,
      isPlaylist: false,
      items: [],
      activeItemId: null,
      message: "Reading media information...",
      error: null,
      startedAt: new Date().toISOString(),
      finishedAt: null
    };
    this.downloads.set(id, record);

    this.prepareDownload(record, inputUrl).catch((err) => {
      finishDownload(record, "failed", err.message);
      logger.error(`[yt-dlp] download setup failed id=${id} message="${err.message}"`, err);
    });

    return publicDownload(record);
  }

  async prepareDownload(record, inputUrl) {
    const allowPlaylist = this.config.allowPlaylists || isExplicitPlaylistUrl(inputUrl);
    let inspection = null;
    try {
      inspection = await inspectDownload(this.config.binaryPath, inputUrl, allowPlaylist);
      applyInspection(record, inspection);
    } catch (err) {
      logger.info(`[yt-dlp] playlist inspection failed id=${record.id} message="${err.message}"; continuing`);
      record.isPlaylist = isExplicitPlaylistUrl(inputUrl);
    }

    const args = downloadArgs(this.config.downloadPath, inputUrl, allowPlaylist, record.isPlaylist);
    logger.info(`[yt-dlp] download starting id=${record.id} playlist=${record.isPlaylist} items=${record.items.length} url="${inputUrl}" output="${this.config.downloadPath}"`);
    logger.full(`[yt-dlp] command ${this.config.binaryPath} ${args.map(quoteArg).join(" ")}`);

    const child = spawn(this.config.binaryPath, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    record.status = "downloading";
    record.message = record.isPlaylist ? "Starting playlist download..." : "Starting download...";
    record.processId = child.pid || null;

    const stdout = createLineBuffer((lines) => this.handleProgress(record, lines));
    const stderr = createLineBuffer((lines) => this.handleProgress(record, lines));
    child.stdout.on("data", stdout.push);
    child.stderr.on("data", stderr.push);
    child.on("error", (err) => {
      finishDownload(record, "failed", err.message);
      logger.error(`[yt-dlp] download spawn failed id=${record.id} message="${err.message}"`, err);
    });
    child.on("close", (code) => {
      stdout.flush();
      stderr.flush();
      if (record.status === "failed") return;
      if (code === 0) {
        markDownloadIndexing(record);
        logger.info(`[yt-dlp] download complete id=${record.id}; indexing library`);
        this.flushIndexRefresh(record)
          .then(() => {
            finishDownload(record, "complete", null);
            logger.info(`[yt-dlp] post-download index complete id=${record.id}`);
          })
          .catch((err) => {
            finishDownload(record, "failed", `Download completed, but indexing failed: ${err.message}`);
            logger.error(`[yt-dlp] post-download reindex failed id=${record.id} message="${err.message}"`, err);
          });
        return;
      }
      finishDownload(record, "failed", `yt-dlp exited with code ${code}`);
      logger.error(`[yt-dlp] download failed id=${record.id} code=${code}`);
    });
  }

  handleProgress(record, lines) {
    const completedFiles = record.outputPaths.length;
    updateProgress(record, lines);
    if (record.outputPaths.length > completedFiles) {
      this.scheduleIndexRefresh(record);
    }
  }

  scheduleIndexRefresh(record) {
    if (!this.onDownloadComplete) return;
    this.indexDirty = true;
    if (this.indexRefreshTimer) clearTimeout(this.indexRefreshTimer);
    this.indexRefreshTimer = setTimeout(() => {
      this.indexRefreshTimer = null;
      this.runIndexRefresh(record).catch((err) => {
        logger.error(`[yt-dlp] incremental reindex failed id=${record.id} message="${err.message}"`, err);
      });
    }, INDEX_REFRESH_DELAY_MS);
    this.indexRefreshTimer.unref?.();
  }

  runIndexRefresh(record) {
    if (!this.indexDirty || !this.onDownloadComplete) {
      return this.indexRefreshPromise;
    }
    this.indexDirty = false;
    this.indexRefreshPromise = this.indexRefreshPromise
      .catch(() => {})
      .then(() => this.onDownloadComplete(record));
    return this.indexRefreshPromise;
  }

  async flushIndexRefresh(record) {
    if (this.indexRefreshTimer) {
      clearTimeout(this.indexRefreshTimer);
      this.indexRefreshTimer = null;
    }
    this.indexDirty = true;
    while (this.indexDirty) {
      await this.runIndexRefresh(record);
      await this.indexRefreshPromise;
    }
  }
}

function createLineBuffer(onLines) {
  let pending = "";
  return {
    push(chunk) {
      pending += chunk.toString();
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() || "";
      if (lines.length > 0) {
        onLines(lines.join("\n"));
      }
    },
    flush() {
      if (pending) {
        onLines(pending);
        pending = "";
      }
    }
  };
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

const ITEM_MARKER = "__MEDIA_BAKER_ITEM__";
const FILE_MARKER = "__MEDIA_BAKER_FILE__";

async function inspectDownload(binaryPath, url, allowPlaylist) {
  const stdout = await execOutput(binaryPath, [
    "--flat-playlist",
    "--dump-single-json",
    "--no-warnings",
    allowPlaylist ? "--yes-playlist" : "--no-playlist",
    url
  ], { timeout: 120000, maxBuffer: 20 * 1024 * 1024 });
  const data = JSON.parse(stdout);
  const hasEntries = Array.isArray(data.entries);
  const entries = hasEntries ? data.entries.filter(Boolean) : [];
  const isPlaylist = hasEntries || data._type === "playlist";
  return {
    isPlaylist,
    title: data.title || data.playlist_title || data.id || null,
    entries: entries.map((entry, index) => ({
      id: String(entry.id || entry.url || index + 1),
      index: Number(entry.playlist_index) || index + 1,
      title: entry.title || `Item ${index + 1}`,
      status: "queued",
      percent: 0,
      speed: null,
      eta: null,
      filename: null,
      outputPath: null,
      message: "Waiting...",
      error: null
    }))
  };
}

function applyInspection(record, inspection) {
  record.isPlaylist = Boolean(inspection.isPlaylist);
  record.playlistTitle = record.isPlaylist ? inspection.title : null;
  record.title = inspection.title;
  record.items = record.isPlaylist ? inspection.entries : [];
  record.message = record.isPlaylist
    ? `Found ${record.items.length} playlist item${record.items.length === 1 ? "" : "s"}.`
    : "Media information loaded.";
}

function downloadArgs(downloadPath, url, allowPlaylist, isPlaylist) {
  const outputTemplate = isPlaylist
    ? "%(playlist).150B/%(playlist_index)03d - %(title).180B [%(id)s].%(ext)s"
    : "%(title).200B [%(id)s].%(ext)s";
  return [
    "--newline",
    "--progress",
    allowPlaylist ? "--yes-playlist" : "--no-playlist",
    "--print",
    `before_dl:${ITEM_MARKER}%(id)s\t%(playlist_index|0)s\t%(title)s`,
    "--print",
    `after_move:${FILE_MARKER}%(id)s\t%(filepath)s`,
    "-f",
    "bv*[vcodec^=avc1]+ba[acodec^=mp4a]/b[vcodec^=avc1][acodec^=mp4a]/bv*+ba/b",
    "-P",
    downloadPath,
    "-o",
    outputTemplate,
    url
  ];
}

function updateProgress(record, output) {
  const lines = String(output || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    if (line.startsWith(ITEM_MARKER)) {
      const [id, indexValue, ...titleParts] = line.slice(ITEM_MARKER.length).split("\t");
      const item = ensureDownloadItem(record, {
        id,
        index: Number(indexValue) || record.items.length + 1,
        title: titleParts.join("\t") || `Item ${record.items.length + 1}`
      });
      record.activeItemId = item.id;
      item.status = "downloading";
      item.message = "Starting download...";
      record.message = `Downloading ${item.title}`;
      recalculateDownloadProgress(record);
      continue;
    }

    if (line.startsWith(FILE_MARKER)) {
      const [id, ...pathParts] = line.slice(FILE_MARKER.length).split("\t");
      const outputPath = pathParts.join("\t").trim();
      if (outputPath && !record.outputPaths.includes(outputPath)) {
        record.outputPaths.push(outputPath);
        record.fileCount = record.outputPaths.length;
      }
      record.outputPath = outputPath || record.outputPath;
      const item = findDownloadItem(record, id) || activeDownloadItem(record);
      if (item) {
        item.status = "complete";
        item.percent = 100;
        item.outputPath = outputPath || item.outputPath;
        item.filename = outputPath ? path.basename(outputPath) : item.filename;
        item.speed = null;
        item.eta = null;
        item.message = "Download complete.";
      } else {
        record.filename = outputPath ? path.basename(outputPath) : record.filename;
      }
      recalculateDownloadProgress(record);
      continue;
    }

    const destination = line.match(/\[download\]\s+Destination:\s+(.+)$/i)
      || line.match(/\[(?:Merger|ffmpeg)\].*?(?:Merging|Remuxing|Converting).*?"(.+)"$/i);
    if (destination) {
      record.outputPath = destination[1];
      const item = activeDownloadItem(record);
      if (item) {
        item.outputPath = destination[1];
        item.filename = path.basename(destination[1]);
        if (/^\[(?:Merger|ffmpeg)\].*(?:Merging|Remuxing|Converting)/i.test(line)) {
          item.status = "merging";
          item.message = "Merging video and audio...";
          item.speed = null;
          item.eta = null;
          record.message = `Merging ${item.title}`;
        }
      } else {
        record.filename = path.basename(destination[1]);
      }
    }

    const percent = line.match(/\[download\]\s+(\d+(?:\.\d+)?)%/i);
    if (percent) {
      const item = activeDownloadItem(record);
      const percentValue = Number.parseFloat(percent[1]);
      record.message = line;
      const speed = line.match(/\bat\s+(.+?)\s+ETA\b/i);
      const eta = line.match(/\bETA\s+([^\s]+)/i);
      record.speed = speed ? speed[1] : record.speed;
      record.eta = eta ? eta[1] : record.eta;
      if (item) {
        item.status = percentValue >= 100 ? "processing" : "downloading";
        item.percent = percentValue;
        item.message = percentValue >= 100 ? "Download complete. Processing media..." : line;
        item.speed = speed ? speed[1] : item.speed;
        item.eta = eta ? eta[1] : item.eta;
        recalculateDownloadProgress(record);
      } else {
        record.percent = percentValue;
      }
      continue;
    }

    if (/^\[(?:Merger|ffmpeg|Fixup|ExtractAudio)\]/i.test(line)) {
      const item = activeDownloadItem(record);
      if (item && !["complete", "failed"].includes(item.status)) {
        item.status = /merg|remux|convert/i.test(line) ? "merging" : "processing";
        item.message = item.status === "merging" ? "Merging video and audio..." : "Processing media...";
        item.speed = null;
        item.eta = null;
        record.message = `${item.message.replace(/\.\.\.$/, "")} ${item.title}`;
      }
      continue;
    }

    if (/^\[(download|ExtractAudio|Merger|Fixup|ffmpeg)\]/i.test(line)) {
      record.message = line;
    }
  }
}

function ensureDownloadItem(record, value) {
  let item = findDownloadItem(record, value.id);
  if (item) return item;
  item = {
    id: String(value.id || record.items.length + 1),
    index: Number(value.index) || record.items.length + 1,
    title: value.title || `Item ${record.items.length + 1}`,
    status: "queued",
    percent: 0,
    speed: null,
    eta: null,
    filename: null,
    outputPath: null,
    message: "Waiting...",
    error: null
  };
  record.items.push(item);
  return item;
}

function findDownloadItem(record, id) {
  return record.items.find((item) => item.id === String(id || "")) || null;
}

function activeDownloadItem(record) {
  return findDownloadItem(record, record.activeItemId);
}

function recalculateDownloadProgress(record) {
  if (record.items.length === 0) return;
  const progress = record.items.reduce((total, item) => {
    if (["complete", "skipped"].includes(item.status)) return total + 1;
    return total + Math.max(0, Math.min(100, Number(item.percent) || 0)) / 100;
  }, 0);
  record.percent = Math.round(progress / record.items.length * 1000) / 10;
}

function isExplicitPlaylistUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    return (host === "youtube.com" || host === "music.youtube.com" || host === "youtu.be" || host.endsWith(".youtube.com"))
      && Boolean(url.searchParams.get("list"));
  } catch (err) {
    return false;
  }
}

function finishDownload(record, status, error) {
  record.status = status;
  record.finishedAt = new Date().toISOString();
  record.percent = status === "complete" ? 100 : record.percent;
  record.error = error;
  record.message = error || (status === "complete" ? "Download complete." : record.message);
  if (status === "complete") {
    record.items.forEach((item) => {
      if (item.status === "queued") {
        item.status = "skipped";
        item.message = "Skipped by the provider.";
      }
    });
    recalculateDownloadProgress(record);
  } else if (status === "failed") {
    const item = activeDownloadItem(record);
    if (item && !["complete", "skipped"].includes(item.status)) {
      item.status = "failed";
      item.error = error;
      item.message = error;
    }
  }
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
      maxBuffer: options.maxBuffer || 2 * 1024 * 1024,
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
