const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const packageJson = require("../package.json");
const config = require("./config");
const { createIndexStore } = require("./services/indexStores");
const { MediaIndex } = require("./services/mediaIndex");
const { FFmpegService } = require("./services/ffmpegService");
const { HlsService } = require("./services/hlsService");
const { KeyframeStore } = require("./services/keyframeStore");
const { ImageService } = require("./services/imageService");
const { CachedImageService } = require("./services/cachedImageService");
const { StaticImageService } = require("./services/staticImageService");
const { BrandingService } = require("./services/brandingService");
const { FallbackStreamService } = require("./services/fallbackStreamService");
const { safeRequestUrl } = require("./utils/safeRequestUrl");
const { MetadataStore } = require("./services/metadataStore");
const { MetadataService } = require("./services/metadataService");
const { PlaybackProgressStore } = require("./services/playbackProgressStore");
const { PlaybackProgressService } = require("./services/playbackProgressService");
const { SubtitleService } = require("./services/subtitleService");
const { IndexScanScheduler } = require("./services/indexScanScheduler");
const { LibraryService } = require("./services/libraryService");
const { AccountService } = require("./services/accountService");
const { AppSettingsService } = require("./services/appSettingsService");
const { HardwareService } = require("./services/hardwareService");
const { loadOrCreatePlaybackSecret } = require("./services/playbackSecret");
const { PlaybackTokenService } = require("./services/playbackTokens");
const { YtDlpService, syncYtDlpLibrary } = require("./services/ytdlpService");
const { YtDlpRelayService } = require("./services/ytdlpRelayService");
const { IptvService } = require("./services/iptvService");
const { UpdateService } = require("./services/updateService");
const { BackupService } = require("./services/backupService");
const { OptimiserService } = require("./services/optimiserService");
const { TaskService } = require("./services/taskService");
const { SkipMarkerStore } = require("./services/skipMarkerStore");
const { SkipDetectionWorkerClient } = require("./services/skipDetectionWorkerClient");
const { OpenMovieIdStore } = require("./services/openMovieIdStore");
const { OpenMovieService } = require("./services/openMovieService");
const { OpenMovieCapabilityService } = require("./services/openMovieCapabilityService");
const { OpenMoviePosterAtlasStore } = require("./services/openMoviePosterAtlasStore");
const { OpenMoviePosterAtlasService } = require("./services/openMoviePosterAtlasService");
const { OpenMovieArtworkService } = require("./services/openMovieArtworkService");
const { createAuthMiddleware, createStreamAuthMiddleware } = require("./middleware/auth");
const createAuthRoutes = require("./routes/auth");
const createAdminRoutes = require("./routes/admin");
const createHealthRoutes = require("./routes/health");
const createCatalogRoutes = require("./routes/catalog");
const createProgressRoutes = require("./routes/progress");
const createLibraryRoutes = require("./routes/libraries");
const createStreamRoutes = require("./routes/streams");
const createYtDlpRoutes = require("./routes/ytdlp");
const createYtDlpRelayPlaybackRoutes = require("./routes/ytdlpRelayPlayback");
const createIptvRoutes = require("./routes/iptv");
const createFallbackRoutes = require("./routes/fallback");
const { createFallbackSegmentRoutes } = createFallbackRoutes;
const createDocsRoutes = require("./routes/docs");
const createAppInfoRoutes = require("./routes/appInfo");
const createBrandingRoutes = require("./routes/branding");
const createOpenMovieRoutes = require("./routes/openMovie");
const logger = require("./utils/logger");

async function createApp() {
  const app = express();
  const publicPath = path.resolve(__dirname, "..", "public");
  const webAppHtml = injectWebAppVersion(
    await fs.readFile(path.join(publicPath, "index.html"), "utf8"),
    packageJson.version
  );
  const serveWebApp = createWebAppHandler(webAppHtml);

  app.use(express.json());
  app.use("/api", (req, res, next) => {
    res.set("X-Media-Baker-Version", packageJson.version);
    next();
  });
  app.use("/api/app", createAppInfoRoutes({ version: packageJson.version }));

  const libraryService = new LibraryService(config);
  config.libraries = await libraryService.list();
  logger.info(`[config] libraries=${config.libraries.map((library) => `${library.key}:${library.type}:${library.path}`).join("; ")}`);
  const accountService = new AccountService(config);
  await accountService.init();
  const appSettings = new AppSettingsService(config);
  await appSettings.init();
  await appSettings.applyToConfig();
  syncYtDlpLibrary(config);
  logger.configure(config.logging);

  const indexStore = createIndexStore(config);
  const mediaIndex = new MediaIndex(config, indexStore);
  await mediaIndex.load();

  const ffmpeg = new FFmpegService(config.ffmpeg);
  await ffmpeg.validate();
  const imageProcessor = new StaticImageService(ffmpeg);
  const branding = new BrandingService({
    appSettings,
    cachePath: path.join(path.dirname(config.settingsStorePath), "branding"),
    imageProcessor,
    publicPath
  });
  await branding.init();
  app.use(createBrandingRoutes({ branding }));
  app.use(express.static(publicPath, {
    index: false,
    setHeaders(res) {
      res.setHeader("Cache-Control", "no-cache, must-revalidate");
    }
  }));
  const cachedImages = new CachedImageService(config, imageProcessor);
  const progressStore = new PlaybackProgressStore(config);
  const progress = new PlaybackProgressService(config, progressStore);
  const keyframes = new KeyframeStore(config);
  await keyframes.init();
  const hls = new HlsService(config, ffmpeg, progress, keyframes);
  const images = new ImageService(config, imageProcessor, cachedImages);
  const fallbackStream = new FallbackStreamService(config, ffmpeg);
  try {
    await fallbackStream.prepare();
  } catch (err) {
    logger.error(`[fallback] prepare failed message="${err.message}"`, err);
  }
  const metadataStore = new MetadataStore(config);
  const metadata = new MetadataService(config, metadataStore, ffmpeg, cachedImages);
  const subtitles = new SubtitleService(config);
  const openMovieIdStore = new OpenMovieIdStore(config);
  const openMovieArtwork = new OpenMovieArtworkService(
    mediaIndex,
    metadata,
    imageProcessor,
    config.metadata.cachePath
  );
  const openMoviePosterAtlasStore = new OpenMoviePosterAtlasStore(config);
  const openMoviePosterAtlases = new OpenMoviePosterAtlasService(
    openMoviePosterAtlasStore,
    imageProcessor,
    openMovieArtwork,
    openMovieIdStore
  );
  await openMoviePosterAtlases.init();
  const openMovie = new OpenMovieService(mediaIndex, openMovieIdStore, metadata, ffmpeg, subtitles, openMoviePosterAtlases);
  const openMovieCapabilities = new OpenMovieCapabilityService(appSettings.openMovieEncryptionKey());
  mediaIndex.addUpdateListener(async (libraryKey, details = {}) => {
    hls.queueKeyframeIndex(details.changedMedia);
    await keyframes.removeMany(details.removedMedia);
    mediaIndex.consumeChangedVideoMedia();
    return openMovie.sync(libraryKey);
  });
  hls.queueKeyframeIndex(mediaIndex.consumeChangedVideoMedia());
  setImmediate(() => {
    mediaIndex.videoMediaReferences()
      .then((mediaFiles) => hls.queueMissingKeyframeIndex(mediaFiles))
      .catch((error) => logger.error(`[hls] keyframe index backfill failed message="${error.message}"`, error));
  });
  await openMovie.init();
  const skipMarkerStore = new SkipMarkerStore(config);
  const skipDetection = new SkipDetectionWorkerClient(config, skipMarkerStore);
  const indexScanScheduler = new IndexScanScheduler(config, mediaIndex, metadata, skipDetection);
  const hardware = new HardwareService();
  const playbackSecret = await loadOrCreatePlaybackSecret(config.auth.playbackSecretPath);
  const playbackTokens = new PlaybackTokenService(playbackSecret, config.hls.ttlSeconds);
  const ytdlp = new YtDlpService(config, ffmpeg);
  const ytdlpRelay = new YtDlpRelayService(config, ffmpeg);
  const iptv = new IptvService(config, ffmpeg, cachedImages);
  const updates = new UpdateService(config);
  const backups = new BackupService(config, appSettings);
  const optimizer = new OptimiserService(config, ffmpeg, mediaIndex, appSettings, metadata);
  const tasks = new TaskService({
    mediaIndex,
    metadata,
    hls,
    indexScanScheduler,
    ytdlp,
    ytdlpRelay,
    iptv,
    updates,
    backups,
    optimizer,
    skipDetection
  });
  ytdlp.setCompletionHandler(async () => {
    await mediaIndex.reindexLibrary(config.ytdlp.libraryKey || "yt-dlp");
  });

  app.locals.services = {
    config,
    indexStore,
    mediaIndex,
    ffmpeg,
    hls,
    keyframes,
    images,
    imageProcessor,
    branding,
    cachedImages,
    fallbackStream,
    metadataStore,
    metadata,
    openMovieIdStore,
    openMovieArtwork,
    openMoviePosterAtlasStore,
    openMoviePosterAtlases,
    openMovie,
    openMovieCapabilities,
    progressStore,
    progress,
    subtitles,
    skipMarkerStore,
    skipDetection,
    indexScanScheduler,
    libraryService,
    accountService,
    appSettings,
    hardware,
    playbackTokens,
    ytdlp,
    ytdlpRelay,
    iptv,
    updates,
    backups,
    optimizer,
    tasks
  };
  const imageMigration = cachedImages.migrate(metadataStore, config.iptv.cachePath);
  backups.setReadiness(imageMigration);
  imageMigration.catch((err) => {
    logger.error(`[images] cached image migration failed message="${err.message}"`, err);
  });
  imageMigration.catch(() => {}).finally(() => metadata.startBackgroundPreload(mediaIndex));
  indexScanScheduler.start();
  if (mediaIndex.requiresFileStatsRefresh()
    && !(config.indexScan.enabled && config.indexScan.runOnStartup)) {
    setImmediate(() => {
      indexScanScheduler.run("file-stats").catch((err) => {
        logger.error(`[index-scan] file stats scan failed message="${err.message}"`, err);
      });
    });
  }
  ytdlp.start();
  ytdlpRelay.start();
  imageMigration.catch(() => {}).finally(() => iptv.start());
  updates.start();
  backups.start();
  optimizer.start();
  skipDetection.start();

  app.use("/api/streams", createStreamAuthMiddleware(playbackTokens), createStreamRoutes(app.locals.services));
  app.use("/api/relay-streams", createStreamAuthMiddleware(playbackTokens), createYtDlpRelayPlaybackRoutes(app.locals.services));
  app.use("/api/auth", createAuthRoutes(app.locals.services));
  app.use("/api/docs", createDocsRoutes());
  app.get(["/", "/index.html"], serveWebApp);
  app.get(/^\/(?:search|history|live-tv)(?:\/)?$/, serveWebApp);
  app.get(/^\/libraries\/[^/]+(?:\/(?:shows\/[^/]+(?:\/seasons\/[^/]+)?|artists\/[^/]+(?:\/albums\/[^/]+)?))?\/?$/, serveWebApp);
  app.use(
    "/api/web-streams",
    createAuthMiddleware(accountService, libraryService),
    createStreamAuthMiddleware(playbackTokens),
    createStreamRoutes(app.locals.services, { surface: "web" })
  );
  app.use("/api/openmovie", createOpenMovieRoutes(app.locals.services));
  app.use(createAuthMiddleware(accountService, libraryService));

  app.use("/api/admin", createAdminRoutes(app.locals.services));
  app.use("/api/health", createHealthRoutes(app.locals.services));
  app.use("/api/catalog", createCatalogRoutes(app.locals.services));
  app.use("/api/progress", createProgressRoutes(app.locals.services));
  app.use("/api/libraries", createLibraryRoutes(app.locals.services));
  app.use("/api/ytdlp", createYtDlpRoutes(app.locals.services));
  app.use("/api/iptv", createIptvRoutes(app.locals.services));
  app.use(createFallbackSegmentRoutes(app.locals.services));
  app.use("/api/fallback", createFallbackRoutes(app.locals.services));

  app.use(async (req, res, next) => {
    if (shouldServeFallbackStream(req, fallbackStream)) {
      logger.full(`[fallback] serving fallback playlist for missing path method=${req.method} path="${req.originalUrl}"`);
      try {
        await fallbackStream.serve(req, res, 404, !isWebStreamRequest(req));
      } catch (err) {
        next(err);
      }
      return;
    }

    res.status(404).json({ error: "Not found" });
  });

  app.use(async (err, req, res, next) => {
    if (res.headersSent) {
      return next(err);
    }

    if (shouldServeFallbackStream(req, fallbackStream)) {
      logger.full(`[fallback] serving fallback stream for error status=${err.status || 500} path="${safeRequestUrl(req)}"`);
      try {
        await fallbackStream.serve(req, res, err.status || 500, !isWebStreamRequest(req));
      } catch (fallbackErr) {
        next(fallbackErr);
      }
      return;
    }

    logger.error(`[error] ${req.method} ${safeRequestUrl(req)} status=${err.status || 500} message="${err.message || "Internal server error"}"`, err);

    const status = err.status || 500;
    res.status(status).json({
      error: err.message || "Internal server error"
    });
  });

  return app;
}

function createWebAppHandler(webAppHtml) {
  return function serveWebApp(req, res, next) {
    if (!isBrowserRequest(req)) {
      next();
      return;
    }
    res.set("Cache-Control", "no-store");
    res.type("html").send(webAppHtml);
  };
}

function injectWebAppVersion(html, version) {
  return String(html).replaceAll("__MEDIA_BAKER_VERSION__", encodeURIComponent(String(version)));
}

function shouldServeFallbackStream(req, fallbackStream) {
  return (req.method === "GET" || req.method === "HEAD")
    && fallbackStream
    && fallbackStream.ready
    && (isWebStreamRequest(req) || !isBrowserRequest(req));
}

function isWebStreamRequest(req) {
  return String(req.originalUrl || "").startsWith("/api/web-streams/");
}

function isBrowserRequest(req) {
  const userAgent = req.get("user-agent") || "";
  const accept = req.get("accept") || "";
  return /\bMozilla\/\d/i.test(userAgent)
    || accept.includes("text/html");
}

module.exports = { createApp };
