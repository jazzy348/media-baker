const { execFile, spawn } = require("child_process");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const logger = require("../utils/logger");
const {
  cookieArgsForUrl,
  cookieCount,
  cookieFilePath,
  isYoutubeUrl,
  sanitiseYoutubeCookies
} = require("../utils/ytdlpCookies");
const { ytdlpRuntimeArgs } = require("../utils/ytdlpRuntime");

const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const VALIDATION_TTL_MS = 60 * 1000;
const INDEX_REFRESH_DELAY_MS = 750;
const LIBRARY_KEY = "yt-dlp";
const MIN_SUBSCRIPTION_INTERVAL_SECONDS = 60 * 60;
const MAX_DIAGNOSTIC_LINES = 30;
const MAX_DIAGNOSTIC_LENGTH = 1600;

class YtDlpService {
  constructor(config, ffmpeg, appSettings = null) {
    this.rootConfig = config;
    this.config = config.ytdlp;
    this.ffmpeg = ffmpeg;
    this.appSettings = appSettings;
    this.downloads = new Map();
    this.validation = null;
    this.validationAt = 0;
    this.updateTimer = null;
    this.lastUpdateAt = null;
    this.lastUpdateError = null;
    this.lastUpdateMessage = null;
    this.updatePromise = null;
    this.subscriptionTimer = null;
    this.subscriptionCheckPromise = null;
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
      .then(async () => {
        await this.updateIfNeeded();
        this.scheduleSubscriptionChecks();
      })
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
    if (this.subscriptionTimer) {
      clearTimeout(this.subscriptionTimer);
      this.subscriptionTimer = null;
    }
  }

  shutdown() {
    this.stop();
    for (const record of this.downloads.values()) {
      if (!record.child) continue;
      record.cancelled = true;
      record.child.kill("SIGTERM");
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

    return this.runUpdate();
  }

  async forceUpdate() {
    await this.ensureReady();
    return this.runUpdate(true);
  }

  runUpdate(force = false) {
    if (this.updatePromise) return this.updatePromise;
    this.updatePromise = this.performUpdate(force).finally(() => {
      this.updatePromise = null;
    });
    return this.updatePromise;
  }

  async performUpdate(force = false) {
    const validation = await this.validate();
    if (!validation.ok) {
      return this.status();
    }

    if (await installedByApt(this.config.binaryPath)) {
      logger.info(`[yt-dlp] self-update skipped package-manager=true path="${this.config.binaryPath}"`);
      this.lastUpdateAt = Date.now();
      this.lastUpdateError = null;
      this.lastUpdateMessage = "YT-DLP is managed by the operating system package manager.";
      return this.status();
    }

    try {
      logger.info(`[yt-dlp] self-update starting path="${this.config.binaryPath}" forced=${force}`);
      await execOutput(this.config.binaryPath, ["-U"], { timeout: 120000 });
      this.lastUpdateAt = Date.now();
      this.lastUpdateError = null;
      this.lastUpdateMessage = "YT-DLP is up to date.";
      this.validation = null;
      logger.info("[yt-dlp] self-update complete");
    } catch (err) {
      this.lastUpdateAt = Date.now();
      this.lastUpdateError = err.message;
      this.lastUpdateMessage = null;
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
      lastUpdateMessage: this.lastUpdateMessage,
      updating: Boolean(this.updatePromise),
      checkingSubscriptions: Boolean(this.subscriptionCheckPromise),
      subscriptionCheckIntervalSeconds: this.subscriptionIntervalSeconds(),
      subscriptions: this.subscriptions().map(publicSubscription),
      downloads: [...this.downloads.values()].map(publicDownload)
    };
  }

  subscriptions() {
    return Array.isArray(this.config.subscriptions) ? this.config.subscriptions : [];
  }

  subscriptionIntervalSeconds() {
    return Math.max(
      MIN_SUBSCRIPTION_INTERVAL_SECONDS,
      Number(this.config.subscriptionCheckIntervalSeconds) || 24 * 60 * 60
    );
  }

  async addSubscription(url, userId = "system") {
    const subscription = await this.createSubscription(url);
    this.startSubscriptionDownload(subscription, userId);
    return publicSubscription(subscription);
  }

  startSubscriptionDownload(subscription, userId) {
    const active = [...this.downloads.values()].find((download) =>
      download.subscriptionId === subscription.id && !["complete", "failed"].includes(download.status)
    );
    if (active) return active;

    const record = createDownloadRecord(subscription.url, userId, {
      title: subscription.title,
      playlistTitle: subscription.title,
      isPlaylist: true,
      subscriptionId: subscription.id,
      message: `Downloading existing videos from ${subscription.title}...`
    });
    this.downloads.set(record.id, record);
    this.downloadSubscription(record, subscription).catch(() => {});
    return record;
  }

  async createSubscription(url, options = {}) {
    await this.ensureReady();
    const inputUrl = validInputUrl(url);
    if (!isYoutubeUrl(inputUrl)) {
      throw httpError(400, "Only YouTube channel subscriptions are supported.");
    }

    const authenticationArgs = await cookieArgsForUrl(this.rootConfig, inputUrl);
    const channel = await inspectYoutubeChannel(this.config.binaryPath, inputUrl, authenticationArgs);
    const existing = this.subscriptions().find((entry) => entry.channelId === channel.channelId);
    if (existing && options.reuseExisting) {
      const archivePath = this.subscriptionArchivePath(existing);
      await fs.mkdir(path.dirname(archivePath), { recursive: true });
      await fs.appendFile(archivePath, "", "utf8");
      existing.backfillComplete = false;
      existing.lastAttemptAt = new Date().toISOString();
      existing.lastError = null;
      await this.persistSubscriptions(this.subscriptions());
      logger.info(`[yt-dlp] channel backfill requested id=${existing.id} channel="${logValue(existing.title)}"`);
      return existing;
    }
    if (existing) {
      throw httpError(409, `"${channel.title}" is already subscribed.`);
    }

    const id = crypto.randomBytes(8).toString("hex");
    const folderName = uniqueSubscriptionFolderName(channel.title, channel.channelId, this.subscriptions());
    const subscription = {
      id,
      url: channel.url,
      channelId: channel.channelId,
      title: channel.title,
      folderName,
      createdAt: new Date().toISOString(),
      lastAttemptAt: new Date().toISOString(),
      lastCheckedAt: null,
      lastDownloadedAt: null,
      lastError: null,
      backfillComplete: false
    };

    await fs.mkdir(path.join(this.config.downloadPath, folderName), { recursive: true });
    const archivePath = this.subscriptionArchivePath(subscription);
    await fs.mkdir(path.dirname(archivePath), { recursive: true });
    await fs.writeFile(archivePath, "", { flag: "wx" });
    await this.persistSubscriptions([...this.subscriptions(), subscription]);
    logger.info(`[yt-dlp] channel subscribed id=${id} channel="${logValue(channel.title)}"`);
    this.scheduleSubscriptionChecks();
    return subscription;
  }

  async removeSubscription(id) {
    const subscription = this.subscriptions().find((entry) => entry.id === String(id));
    if (!subscription) {
      throw httpError(404, "YT-DLP channel subscription not found.");
    }

    for (const record of this.downloads.values()) {
      if (record.subscriptionId === subscription.id && !["complete", "failed"].includes(record.status)) {
        record.cancelled = true;
        record.child?.kill();
      }
    }
    await this.persistSubscriptions(this.subscriptions().filter((entry) => entry.id !== subscription.id));
    await fs.rm(this.subscriptionArchivePath(subscription), { force: true }).catch(() => {});
    logger.info(`[yt-dlp] channel subscription removed id=${subscription.id} channel="${logValue(subscription.title)}"`);
    this.scheduleSubscriptionChecks();
    return publicSubscription(subscription);
  }

  async persistSubscriptions(subscriptions) {
    if (!this.appSettings) {
      throw new Error("YT-DLP subscriptions require the app settings service.");
    }
    await this.appSettings.save({ ytdlp: { subscriptions } });
  }

  subscriptionArchivePath(subscription) {
    const cacheRoot = path.dirname(this.rootConfig.hls.cachePath);
    return path.join(cacheRoot, "yt-dlp-subscriptions", `${subscription.id}.txt`);
  }

  async seedSubscriptionArchive(subscription, authenticationArgs) {
    const archivePath = this.subscriptionArchivePath(subscription);
    await fs.mkdir(path.dirname(archivePath), { recursive: true });
    logger.info(`[yt-dlp] establishing channel baseline id=${subscription.id} channel="${logValue(subscription.title)}"`);
    await execOutput(this.config.binaryPath, [
      "--simulate",
      ...ytdlpRuntimeArgs(),
      "--force-write-archive",
      "--download-archive", archivePath,
      "--playlist-end", "1",
      "--yes-playlist",
      "--no-warnings",
      ...authenticationArgs,
      subscription.url
    ], { timeout: 120000, maxBuffer: 20 * 1024 * 1024 });
    await fs.appendFile(archivePath, "", "utf8");
  }

  scheduleSubscriptionChecks() {
    if (this.subscriptionTimer) {
      clearTimeout(this.subscriptionTimer);
      this.subscriptionTimer = null;
    }
    if (!this.config.enabled || this.subscriptions().length === 0 || this.subscriptionCheckPromise) {
      return;
    }

    const intervalMs = this.subscriptionIntervalSeconds() * 1000;
    const nextDueAt = Math.min(...this.subscriptions().map((subscription) => {
      const previous = Date.parse(subscription.lastAttemptAt || subscription.createdAt || 0);
      return (Number.isFinite(previous) ? previous : 0) + intervalMs;
    }));
    const delayMs = Math.max(1000, Math.min(0x7fffffff, nextDueAt - Date.now()));
    this.subscriptionTimer = setTimeout(() => {
      this.subscriptionTimer = null;
      this.runDueSubscriptionChecks().catch((err) => {
        logger.error(`[yt-dlp] channel subscription check failed message="${err.message}"`, err);
      });
    }, delayMs);
    this.subscriptionTimer.unref?.();
  }

  runDueSubscriptionChecks() {
    if (this.subscriptionCheckPromise) return this.subscriptionCheckPromise;
    this.subscriptionCheckPromise = this.performDueSubscriptionChecks().finally(() => {
      this.subscriptionCheckPromise = null;
      this.scheduleSubscriptionChecks();
    });
    return this.subscriptionCheckPromise;
  }

  async performDueSubscriptionChecks() {
    await this.ensureReady();
    const intervalMs = this.subscriptionIntervalSeconds() * 1000;
    const due = this.subscriptions().filter((subscription) => {
      const previous = Date.parse(subscription.lastAttemptAt || subscription.createdAt || 0);
      return !Number.isFinite(previous) || Date.now() - previous >= intervalMs;
    });
    for (const subscription of due) {
      if (!this.subscriptions().some((entry) => entry.id === subscription.id)) continue;
      await this.checkSubscription(subscription);
    }
  }

  async checkSubscription(subscription) {
    const current = this.subscriptions().find((entry) => entry.id === subscription.id);
    if (!current) return;
    const active = [...this.downloads.values()].some((download) =>
      download.subscriptionId === current.id && !["complete", "failed"].includes(download.status)
    );
    const now = new Date().toISOString();
    current.lastAttemptAt = now;
    await this.persistSubscriptions(this.subscriptions());
    if (active) {
      logger.info(`[yt-dlp] channel check skipped id=${current.id} reason=download-active`);
      return;
    }

    const record = createDownloadRecord(current.url, "system", {
      title: current.title,
      playlistTitle: current.title,
      isPlaylist: true,
      subscriptionId: current.id,
      message: `Checking ${current.title} for new videos...`
    });
    this.downloads.set(record.id, record);
    logger.info(`[yt-dlp] checking channel id=${current.id} channel="${logValue(current.title)}"`);
    try {
      if (!await fileExists(this.subscriptionArchivePath(current))) {
        if (current.backfillComplete === false) {
          const archivePath = this.subscriptionArchivePath(current);
          await fs.mkdir(path.dirname(archivePath), { recursive: true });
          await fs.writeFile(archivePath, "");
        } else {
          const authenticationArgs = await cookieArgsForUrl(this.rootConfig, current.url);
          await this.seedSubscriptionArchive(current, authenticationArgs);
        }
        const latest = this.subscriptions().find((entry) => entry.id === current.id);
        if (!latest) return;
        if (latest.backfillComplete !== false) {
          latest.lastCheckedAt = new Date().toISOString();
          latest.lastError = null;
          await this.persistSubscriptions(this.subscriptions());
          record.completeMessage = "Channel baseline restored. No historical videos were downloaded.";
          finishDownload(record, "complete", null);
          logger.info(`[yt-dlp] channel baseline restored id=${current.id}; historical videos skipped`);
          return;
        }
      }
      await this.downloadSubscription(record, current);
    } catch (err) {
      // downloadSubscription records the failure for the subscription and download.
    }
  }

  async downloadSubscription(record, subscription) {
    try {
      await this.prepareDownload(record, subscription.url, {
        subscription,
        stopAtExisting: subscription.backfillComplete !== false
      });
      const latest = this.subscriptions().find((entry) => entry.id === subscription.id);
      if (!latest) return;
      latest.lastCheckedAt = new Date().toISOString();
      latest.lastError = null;
      latest.backfillComplete = true;
      if (record.outputPaths.length > 0) {
        latest.lastDownloadedAt = latest.lastCheckedAt;
      }
      await this.persistSubscriptions(this.subscriptions());
      logger.info(`[yt-dlp] channel check complete id=${subscription.id} downloaded=${record.outputPaths.length}`);
    } catch (err) {
      if (record.status !== "failed") {
        finishDownload(record, "failed", err.message);
      }
      const latest = this.subscriptions().find((entry) => entry.id === subscription.id);
      if (latest) {
        latest.lastError = err.message;
        await this.persistSubscriptions(this.subscriptions());
      }
      logger.error(`[yt-dlp] channel check failed id=${subscription.id} message="${logValue(err.message)}"`);
      throw err;
    }
  }

  async cookieStatus() {
    const filePath = cookieFilePath(this.rootConfig);
    try {
      const [stat, contents] = await Promise.all([
        fs.stat(filePath),
        fs.readFile(filePath, "utf8")
      ]);
      return {
        configured: stat.isFile() && stat.size > 0,
        cookieCount: cookieCount(contents),
        updatedAt: stat.mtime.toISOString()
      };
    } catch (err) {
      if (err.code === "ENOENT") {
        return { configured: false, cookieCount: 0, updatedAt: null };
      }
      throw err;
    }
  }

  async saveCookies(contents) {
    const cleaned = sanitiseYoutubeCookies(contents);
    const filePath = cookieFilePath(this.rootConfig);
    const tempPath = `${filePath}.${crypto.randomBytes(8).toString("hex")}.tmp`;
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    try {
      await fs.writeFile(tempPath, cleaned, { encoding: "utf8", mode: 0o600 });
      await fs.chmod(tempPath, 0o600).catch(() => {});
      await replaceCookieFile(tempPath, filePath);
      logger.info(`[yt-dlp] YouTube cookies updated entries=${cookieCount(cleaned)}`);
      return this.cookieStatus();
    } finally {
      await fs.rm(tempPath, { force: true }).catch(() => {});
    }
  }

  async removeCookies() {
    await fs.rm(cookieFilePath(this.rootConfig), { force: true });
    logger.info("[yt-dlp] YouTube cookies removed");
    return this.cookieStatus();
  }

  async inspect(url) {
    await this.ensureReady();
    const inputUrl = validInputUrl(url);
    if (isYoutubeChannelUrl(inputUrl)) {
      const channel = await inspectYoutubeChannel(
        this.config.binaryPath,
        inputUrl,
        await cookieArgsForUrl(this.rootConfig, inputUrl)
      );
      return {
        url: channel.url,
        title: channel.title,
        isLive: false,
        liveStatus: "not_live",
        extractor: "youtube:channel",
        isChannel: true,
        channelId: channel.channelId
      };
    }
    const inspection = await inspectMedia(
      this.config.binaryPath,
      inputUrl,
      await cookieArgsForUrl(this.rootConfig, inputUrl)
    );
    return {
      url: inputUrl,
      title: inspection.title,
      isLive: inspection.isLive,
      liveStatus: inspection.liveStatus,
      extractor: inspection.extractor,
      isChannel: false
    };
  }

  async startDownload(url, userId = "global", options = {}) {
    await this.ensureReady();
    const inputUrl = validInputUrl(url);

    if (!options.live && isYoutubeChannelUrl(inputUrl)) {
      if (options.subscribeChannel) {
        const subscription = await this.createSubscription(inputUrl, {
          reuseExisting: true
        });
        return publicDownload(this.startSubscriptionDownload(subscription, userId));
      }
      return this.startOneTimeChannelDownload(inputUrl, userId);
    }

    const record = createDownloadRecord(inputUrl, userId, {
      isLive: Boolean(options.live),
      liveStatus: options.live ? "is_live" : "not_live"
    });
    this.downloads.set(record.id, record);

    this.prepareDownload(record, inputUrl).catch((err) => {
      if (record.status !== "failed") finishDownload(record, "failed", err.message);
      logger.error(`[yt-dlp] download setup failed id=${record.id} message="${err.message}"`, err);
    });

    return publicDownload(record);
  }

  async startOneTimeChannelDownload(inputUrl, userId) {
    const authenticationArgs = await cookieArgsForUrl(this.rootConfig, inputUrl);
    const channel = await inspectYoutubeChannel(this.config.binaryPath, inputUrl, authenticationArgs);
    const existing = this.subscriptions().find((subscription) => subscription.channelId === channel.channelId);
    const folderName = existing && existing.folderName || safeFolderName(channel.title) || safeFolderName(channel.channelId) || "YouTube Channel";
    const record = createDownloadRecord(channel.url, userId, {
      title: channel.title,
      playlistTitle: channel.title,
      isPlaylist: true,
      message: `Downloading all videos from ${channel.title}...`
    });
    this.downloads.set(record.id, record);
    this.prepareDownload(record, channel.url, { channelFolderName: folderName }).catch((err) => {
      if (record.status !== "failed") finishDownload(record, "failed", err.message);
      logger.error(`[yt-dlp] channel download setup failed id=${record.id} message="${err.message}"`, err);
    });
    return publicDownload(record);
  }

  async prepareDownload(record, inputUrl, options = {}) {
    const subscription = options.subscription || null;
    const channelFolderName = String(options.channelFolderName || "").trim();
    const allowPlaylist = Boolean(subscription || channelFolderName) || this.config.allowPlaylists || isExplicitPlaylistUrl(inputUrl);
    const authenticationArgs = await cookieArgsForUrl(this.rootConfig, inputUrl);
    logger.full(`[yt-dlp] authentication id=${record.id} provider=${isYoutubeUrl(inputUrl) ? "youtube" : "other"} cookies=${authenticationArgs.length > 0}`);
    if (!subscription && !channelFolderName) {
      try {
        const inspection = await inspectDownload(this.config.binaryPath, inputUrl, allowPlaylist, authenticationArgs);
        applyInspection(record, inspection);
      } catch (err) {
        logger.info(`[yt-dlp] playlist inspection failed id=${record.id} message="${err.message}"; continuing`);
        record.isPlaylist = isExplicitPlaylistUrl(inputUrl);
      }
    }

    const args = downloadArgs(
      this.config.downloadPath,
      inputUrl,
      allowPlaylist,
      record.isPlaylist,
      record.isLive,
      authenticationArgs,
      subscription
        ? {
            archivePath: this.subscriptionArchivePath(subscription),
            folderName: subscription.folderName,
            stopAtExisting: options.stopAtExisting !== false
          }
        : channelFolderName
          ? { folderName: channelFolderName }
          : null
    );
    logger.info(`[yt-dlp] download starting id=${record.id} playlist=${record.isPlaylist} live=${record.isLive} items=${record.items.length} url="${inputUrl}" output="${this.config.downloadPath}"`);
    logger.full(`[yt-dlp] command ${this.config.binaryPath} ${args.map(quoteArg).join(" ")}`);

    const child = spawn(this.config.binaryPath, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    record.status = "downloading";
    record.message = record.isPlaylist ? "Starting playlist download..." : "Starting download...";
    record.processId = child.pid || null;
    record.child = child;

    return new Promise((resolve, reject) => {
      let settled = false;
      const stdout = createLineBuffer((lines) => this.handleProgress(record, lines));
      const stderr = createLineBuffer((lines) => {
        this.handleProgress(record, lines);
        rememberDownloadDiagnostics(record, lines);
      });
      child.stdout.on("data", stdout.push);
      child.stderr.on("data", stderr.push);
      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        finishDownload(record, "failed", err.message);
        logger.error(`[yt-dlp] download spawn failed id=${record.id} message="${err.message}"`, err);
        reject(err);
      });
      child.on("close", async (code) => {
        if (settled) return;
        settled = true;
        record.child = null;
        stdout.flush();
        stderr.flush();
        if (record.cancelled) {
          const error = new Error("YT-DLP channel subscription was removed.");
          finishDownload(record, "failed", error.message);
          reject(error);
          return;
        }
        if (code !== 0) {
          const error = new Error(ytdlpFailureMessage(record, code));
          finishDownload(record, "failed", error.message);
          logger.error(`[yt-dlp] download failed id=${record.id} code=${code} message="${logValue(error.message)}"`);
          reject(error);
          return;
        }
        try {
          await this.finishSuccessfulDownload(record);
          finishDownload(record, "complete", null);
          logger.info(`[yt-dlp] post-download index complete id=${record.id}`);
          resolve(record);
        } catch (err) {
          const message = `Download completed, but indexing failed: ${err.message}`;
          finishDownload(record, "failed", message);
          logger.error(`[yt-dlp] post-download reindex failed id=${record.id} message="${err.message}"`, err);
          reject(new Error(message));
        }
      });
    });
  }

  async finishSuccessfulDownload(record) {
    if (record.isLive && record.outputPaths.length > 0) {
      record.status = "processing";
      record.speed = null;
      record.eta = null;
      record.message = "Normalising live recording audio and timestamps...";
      const normalisedPaths = [];
      for (const outputPath of record.outputPaths) {
        normalisedPaths.push(await this.normaliseLiveRecording(outputPath));
      }
      record.outputPaths = normalisedPaths;
      record.outputPath = normalisedPaths.at(-1) || record.outputPath;
      record.filename = record.outputPath ? path.basename(record.outputPath) : record.filename;
    }

    if (record.outputPaths.length === 0) {
      record.completeMessage = "No new videos found.";
      return;
    }
    markDownloadIndexing(record);
    logger.info(`[yt-dlp] download complete id=${record.id}; indexing library`);
    await this.flushIndexRefresh(record);
  }

  async normaliseLiveRecording(filePath) {
    const probe = await this.ffmpeg.probe(filePath, {
      analyzeduration: "10M",
      probesize: "10M"
    });
    const streams = Array.isArray(probe && probe.streams) ? probe.streams : [];
    if (!streams.some((stream) => stream.codec_type === "audio")) {
      return filePath;
    }

    const extension = path.extname(filePath) || ".mkv";
    const outputExtension = extension.toLowerCase() === ".webm" ? ".mkv" : extension;
    const finalPath = outputExtension === extension
      ? filePath
      : `${filePath.slice(0, -extension.length)}${outputExtension}`;
    const tempPath = `${finalPath}.media-baker-live.tmp${outputExtension}`;
    const args = [
      "-hide_banner", "-loglevel", "warning", "-y",
      "-fflags", "+genpts+discardcorrupt",
      "-i", filePath,
      "-map", "0:v:0?", "-map", "0:a:0?", "-map_metadata", "0",
      "-c:v", "copy",
      "-c:a", "aac", "-b:a", "192k",
      "-af", "aresample=48000:async=1000:first_pts=0",
      "-ar", "48000",
      "-avoid_negative_ts", "make_zero"
    ];
    if ([".mp4", ".m4v", ".mov"].includes(outputExtension.toLowerCase())) {
      args.push("-movflags", "+faststart");
    }
    args.push(tempPath);

    logger.info(`[yt-dlp] normalising live recording file="${filePath}" audioRate=48000`);
    logger.full(`[yt-dlp] ffmpeg command ${this.ffmpeg.ffmpegPath} ${args.map(quoteArg).join(" ")}`);
    try {
      await this.ffmpeg.exec(this.ffmpeg.ffmpegPath, args);
      await replaceLiveFile(filePath, tempPath, finalPath);
      return finalPath;
    } catch (err) {
      await fs.rm(tempPath, { force: true }).catch(() => {});
      throw err;
    }
  }

  handleProgress(record, lines) {
    const completedFiles = record.outputPaths.length;
    updateProgress(record, lines);
    if (!record.isLive && record.outputPaths.length > completedFiles) {
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
    localThumbnails: true,
    trackProgress: settings.trackProgress !== false
  };
}

const ITEM_MARKER = "__MEDIA_BAKER_ITEM__";
const FILE_MARKER = "__MEDIA_BAKER_FILE__";

function createDownloadRecord(url, userId, overrides = {}) {
  return {
    id: crypto.randomBytes(8).toString("hex"),
    url,
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
    isLive: false,
    liveStatus: "not_live",
    items: [],
    activeItemId: null,
    message: "Reading media information...",
    error: null,
    diagnostics: [],
    startedAt: new Date().toISOString(),
    finishedAt: null,
    ...overrides
  };
}

async function inspectDownload(binaryPath, url, allowPlaylist, authenticationArgs) {
  const stdout = await execOutput(binaryPath, [
    "--flat-playlist",
    "--dump-single-json",
    "--no-warnings",
    ...ytdlpRuntimeArgs(),
    allowPlaylist ? "--yes-playlist" : "--no-playlist",
    ...authenticationArgs,
    url
  ], { timeout: 120000, maxBuffer: 20 * 1024 * 1024 });
  const data = JSON.parse(stdout);
  const hasEntries = Array.isArray(data.entries);
  const entries = hasEntries ? data.entries.filter(Boolean) : [];
  const isPlaylist = hasEntries || data._type === "playlist";
  return {
    isPlaylist,
    title: data.title || data.playlist_title || data.id || null,
    isLive: Boolean(data.is_live) || data.live_status === "is_live",
    liveStatus: data.live_status || (data.is_live ? "is_live" : "not_live"),
    extractor: data.extractor_key || data.extractor || null,
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

async function inspectMedia(binaryPath, url, authenticationArgs) {
  const stdout = await execOutput(binaryPath, [
    "--dump-single-json",
    "--skip-download",
    "--no-warnings",
    ...ytdlpRuntimeArgs(),
    "--no-playlist",
    ...authenticationArgs,
    url
  ], { timeout: 120000, maxBuffer: 20 * 1024 * 1024 });
  const data = JSON.parse(stdout);
  return {
    title: data.title || data.fulltitle || data.id || null,
    isLive: Boolean(data.is_live) || data.live_status === "is_live",
    liveStatus: data.live_status || (data.is_live ? "is_live" : "not_live"),
    extractor: data.extractor_key || data.extractor || null
  };
}

async function inspectYoutubeChannel(binaryPath, url, authenticationArgs) {
  const stdout = await execOutput(binaryPath, [
    "--flat-playlist",
    "--playlist-end", "1",
    "--dump-single-json",
    "--no-warnings",
    ...ytdlpRuntimeArgs(),
    "--yes-playlist",
    ...authenticationArgs,
    url
  ], { timeout: 120000, maxBuffer: 20 * 1024 * 1024 });
  const data = JSON.parse(stdout);
  const extractor = String(data.extractor_key || data.extractor || "").toLowerCase();
  const channelId = String(data.channel_id || data.uploader_id || "").trim();
  const title = String(data.channel || data.uploader || data.playlist_title || data.title || "").trim();
  const channelUrl = String(data.channel_url || data.uploader_url || data.webpage_url || url).trim();
  if (!extractor.includes("youtube") || !channelId || !title) {
    throw httpError(400, "The URL did not resolve to a YouTube channel.");
  }
  return {
    channelId,
    title,
    url: youtubeVideosUrl(channelUrl)
  };
}

function applyInspection(record, inspection) {
  record.isPlaylist = Boolean(inspection.isPlaylist);
  record.playlistTitle = record.isPlaylist ? inspection.title : null;
  record.title = inspection.title;
  record.isLive = Boolean(inspection.isLive);
  record.liveStatus = inspection.liveStatus;
  record.items = record.isPlaylist ? inspection.entries : [];
  record.message = record.isPlaylist
    ? `Found ${record.items.length} playlist item${record.items.length === 1 ? "" : "s"}.`
    : "Media information loaded.";
}

function downloadArgs(downloadPath, url, allowPlaylist, isPlaylist, isLive, authenticationArgs, channelDownload = null) {
  const outputTemplate = channelDownload
    ? `${channelDownload.folderName}/%(upload_date>%Y-%m-%d)s - %(title).180B [%(id)s].%(ext)s`
    : isPlaylist
      ? "%(playlist).150B/%(playlist_index)03d - %(title).180B [%(id)s].%(ext)s"
      : "%(title).200B [%(id)s].%(ext)s";
  const args = [
    "--newline",
    "--progress",
    ...ytdlpRuntimeArgs(),
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
    outputTemplate
  ];
  if (channelDownload && channelDownload.archivePath) {
    args.push("--download-archive", channelDownload.archivePath);
    if (channelDownload.stopAtExisting) {
      args.push("--break-on-existing", "--break-per-input");
    }
  }
  if (isLive) {
    args.push(
      "--hls-use-mpegts",
      "--retries", "infinite",
      "--fragment-retries", "infinite",
      "--retry-sleep", "fragment:exp=1:20"
    );
  }
  args.push(...authenticationArgs);
  args.push(url);
  return args;
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

function isYoutubeChannelUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (host !== "youtube.com" && host !== "music.youtube.com" && !host.endsWith(".youtube.com")) {
      return false;
    }
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length === 0) return false;
    const first = parts[0].toLowerCase();
    const channelTabs = new Set(["videos", "featured", "shorts", "streams", "playlists"]);
    if (first.startsWith("@") && first.length > 1) {
      return parts.length === 1 || parts.length === 2 && channelTabs.has(parts[1].toLowerCase());
    }
    if (!["channel", "c", "user"].includes(first) || parts.length < 2) return false;
    return parts.length === 2 || parts.length === 3 && channelTabs.has(parts[2].toLowerCase());
  } catch (err) {
    return false;
  }
}

function validInputUrl(value) {
  const supplied = String(value || "").trim();
  const markdownLink = supplied.match(/^\[[^\]]*\]\((https?:\/\/[^\s)]+)\)$/i);
  const inputUrl = markdownLink ? markdownLink[1] : supplied.replace(/^<(https?:\/\/[^>]+)>$/i, "$1");
  let parsed;
  try {
    parsed = new URL(inputUrl);
  } catch (err) {
    throw httpError(400, "A valid http(s) URL is required.");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw httpError(400, "A valid http(s) URL is required.");
  }
  return parsed.toString();
}

function youtubeVideosUrl(value) {
  const parsed = new URL(value);
  parsed.search = "";
  parsed.hash = "";
  parsed.pathname = parsed.pathname.replace(/\/(?:videos|featured|shorts|streams|playlists)\/?$/i, "").replace(/\/$/, "");
  parsed.pathname = `${parsed.pathname}/videos`;
  return parsed.toString();
}

function uniqueSubscriptionFolderName(title, channelId, subscriptions) {
  const base = safeFolderName(title) || safeFolderName(channelId) || "YouTube Channel";
  const used = new Set(subscriptions.map((subscription) => String(subscription.folderName || "").toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  const suffix = safeFolderName(channelId).slice(-12) || crypto.randomBytes(4).toString("hex");
  return `${base} [${suffix}]`.slice(0, 150);
}

function safeFolderName(value) {
  return String(value || "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 120);
}

async function fileExists(filePath) {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch (err) {
    if (err.code === "ENOENT") return false;
    throw err;
  }
}

function rememberDownloadDiagnostics(record, output) {
  const lines = String(output || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^\[download\]\s+\d+(?:\.\d+)?%/i.test(line));
  if (lines.length === 0) return;
  record.diagnostics.push(...lines);
  if (record.diagnostics.length > MAX_DIAGNOSTIC_LINES) {
    record.diagnostics.splice(0, record.diagnostics.length - MAX_DIAGNOSTIC_LINES);
  }
}

function ytdlpFailureMessage(record, code) {
  const diagnostics = uniqueDiagnostics(record.diagnostics);
  const errors = diagnostics.filter((line) => /^error\s*:/i.test(line));
  const warnings = diagnostics.filter((line) => /^warning\s*:/i.test(line));
  const useful = diagnostics.filter((line) => (
    !/^warning\s*:/i.test(line)
    && /(?:error|unavailable|private|sign in|confirm|format|forbidden|unsupported|unable|failed|http\s+\d{3})/i.test(line)
  ));
  const primary = errors.length > 0 ? errors : useful.length > 0 ? useful : diagnostics;
  const sections = [];
  if (primary.length > 0) {
    sections.push(primary.slice(-4).join(" | "));
  }
  if (warnings.length > 0) {
    sections.push(`Warnings: ${warnings.slice(-2).map(stripDiagnosticLevel).join(" | ")}`);
  }
  const detail = sections.join(" | ").replace(/\s+/g, " ").trim().slice(0, MAX_DIAGNOSTIC_LENGTH);
  return detail ? `yt-dlp exited with code ${code}: ${detail}` : `yt-dlp exited with code ${code}`;
}

function uniqueDiagnostics(lines) {
  const seen = new Set();
  return lines.reduce((result, line) => {
    const normalized = String(line || "").replace(/\s+/g, " ").trim();
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) return result;
    seen.add(key);
    result.push(normalized);
    return result;
  }, []);
}

function stripDiagnosticLevel(line) {
  return String(line || "").replace(/^warning\s*:\s*/i, "");
}

function logValue(value) {
  return String(value || "").replace(/[\r\n]+/g, " ").replace(/"/g, "'");
}

async function replaceFile(filePath, tempPath) {
  const backupPath = `${filePath}.media-baker-live-backup`;
  await fs.rm(backupPath, { force: true });
  await fs.rename(filePath, backupPath);
  try {
    await fs.rename(tempPath, filePath);
    await fs.rm(backupPath, { force: true });
  } catch (err) {
    await fs.rename(backupPath, filePath).catch(() => {});
    throw err;
  }
}

async function replaceLiveFile(inputPath, tempPath, outputPath) {
  if (inputPath === outputPath) {
    await replaceFile(inputPath, tempPath);
    return;
  }
  try {
    await fs.stat(outputPath);
    throw new Error(`Cannot normalise live recording because "${outputPath}" already exists.`);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  await fs.rename(tempPath, outputPath);
  await fs.rm(inputPath, { force: true });
}

async function replaceCookieFile(tempPath, filePath) {
  try {
    await fs.rename(tempPath, filePath);
  } catch (err) {
    if (!["EEXIST", "EPERM"].includes(err.code)) throw err;
    await fs.rm(filePath, { force: true });
    await fs.rename(tempPath, filePath);
  }
}

function finishDownload(record, status, error) {
  record.status = status;
  record.finishedAt = new Date().toISOString();
  record.percent = status === "complete" ? 100 : record.percent;
  record.error = error;
  record.message = error || (status === "complete" ? record.completeMessage || "Download complete." : record.message);
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
  const {
    processId,
    diagnostics,
    child,
    cancelled,
    completeMessage,
    ...publicRecord
  } = record;
  return publicRecord;
}

function publicSubscription(subscription) {
  return {
    id: subscription.id,
    url: subscription.url,
    channelId: subscription.channelId,
    title: subscription.title,
    folderName: subscription.folderName,
    createdAt: subscription.createdAt,
    lastAttemptAt: subscription.lastAttemptAt,
    lastCheckedAt: subscription.lastCheckedAt,
    lastDownloadedAt: subscription.lastDownloadedAt,
    lastError: subscription.lastError,
    backfillComplete: subscription.backfillComplete !== false
  };
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
