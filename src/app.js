const express = require("express");
const path = require("path");
const config = require("./config");
const { createIndexStore } = require("./services/indexStores");
const { MediaIndex } = require("./services/mediaIndex");
const { FFmpegService } = require("./services/ffmpegService");
const { HlsService } = require("./services/hlsService");
const { ImageService } = require("./services/imageService");
const { CachedImageService } = require("./services/cachedImageService");
const { FallbackStreamService } = require("./services/fallbackStreamService");
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
const { IptvService } = require("./services/iptvService");
const { UpdateService } = require("./services/updateService");
const { BackupService } = require("./services/backupService");
const { createAuthMiddleware, createStreamAuthMiddleware } = require("./middleware/auth");
const createAuthRoutes = require("./routes/auth");
const createAdminRoutes = require("./routes/admin");
const createHealthRoutes = require("./routes/health");
const createCatalogRoutes = require("./routes/catalog");
const createProgressRoutes = require("./routes/progress");
const createLibraryRoutes = require("./routes/libraries");
const createStreamRoutes = require("./routes/streams");
const createYtDlpRoutes = require("./routes/ytdlp");
const createIptvRoutes = require("./routes/iptv");
const createFallbackRoutes = require("./routes/fallback");
const createDocsRoutes = require("./routes/docs");
const logger = require("./utils/logger");

async function createApp() {
  const app = express();

  app.use(express.json());
  app.use(express.static(path.resolve(__dirname, "..", "public")));

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
  const cachedImages = new CachedImageService(config, ffmpeg);
  const progressStore = new PlaybackProgressStore(config);
  const progress = new PlaybackProgressService(config, progressStore);
  const hls = new HlsService(config, ffmpeg, progress);
  const images = new ImageService(config, ffmpeg, cachedImages);
  const fallbackStream = new FallbackStreamService(config, ffmpeg);
  try {
    await fallbackStream.prepare();
  } catch (err) {
    logger.error(`[fallback] prepare failed message="${err.message}"`, err);
  }
  const metadataStore = new MetadataStore(config);
  const metadata = new MetadataService(config, metadataStore, ffmpeg, cachedImages);
  const subtitles = new SubtitleService(config);
  const indexScanScheduler = new IndexScanScheduler(config, mediaIndex, metadata);
  const hardware = new HardwareService();
  const playbackSecret = await loadOrCreatePlaybackSecret(config.auth.playbackSecretPath);
  const playbackTokens = new PlaybackTokenService(playbackSecret, config.hls.ttlSeconds);
  const ytdlp = new YtDlpService(config);
  const iptv = new IptvService(config, ffmpeg, cachedImages);
  const updates = new UpdateService(config);
  const backups = new BackupService(config, appSettings);
  ytdlp.setCompletionHandler(async () => {
    await mediaIndex.reindexLibrary(config.ytdlp.libraryKey || "yt-dlp");
  });

  app.locals.services = {
    config,
    indexStore,
    mediaIndex,
    ffmpeg,
    hls,
    images,
    cachedImages,
    fallbackStream,
    metadataStore,
    metadata,
    progressStore,
    progress,
    subtitles,
    indexScanScheduler,
    libraryService,
    accountService,
    appSettings,
    hardware,
    playbackTokens,
    ytdlp,
    iptv,
    updates,
    backups
  };
  const imageMigration = cachedImages.migrate(metadataStore, config.iptv.cachePath);
  backups.setReadiness(imageMigration);
  imageMigration.catch((err) => {
    logger.error(`[images] cached image migration failed message="${err.message}"`, err);
  });
  imageMigration.catch(() => {}).finally(() => metadata.startBackgroundPreload(mediaIndex));
  indexScanScheduler.start();
  ytdlp.start();
  imageMigration.catch(() => {}).finally(() => iptv.start());
  updates.start();
  backups.start();

  app.use("/api/streams", createStreamAuthMiddleware(playbackTokens), createStreamRoutes(app.locals.services));
  app.use("/api/auth", createAuthRoutes(app.locals.services));
  app.use("/api/docs", createDocsRoutes());
  app.get(/^\/(?:search|history|live-tv)(?:\/)?$/, serveWebApp);
  app.get(/^\/libraries\/[^/]+(?:\/(?:shows\/[^/]+(?:\/seasons\/[^/]+)?|artists\/[^/]+(?:\/albums\/[^/]+)?))?\/?$/, serveWebApp);
  app.use(createAuthMiddleware(accountService, libraryService));

  app.use("/api/admin", createAdminRoutes(app.locals.services));
  app.use("/api/health", createHealthRoutes(app.locals.services));
  app.use("/api/catalog", createCatalogRoutes(app.locals.services));
  app.use("/api/progress", createProgressRoutes(app.locals.services));
  app.use("/api/libraries", createLibraryRoutes(app.locals.services));
  app.use("/api/ytdlp", createYtDlpRoutes(app.locals.services));
  app.use("/api/iptv", createIptvRoutes(app.locals.services));
  app.use("/api/fallback", createFallbackRoutes(app.locals.services));

  app.use(async (req, res, next) => {
    if (shouldServeFallbackStream(req, fallbackStream)) {
      logger.full(`[fallback] serving fallback playlist for missing path method=${req.method} path="${req.originalUrl}"`);
      try {
        await fallbackStream.serve(req, res, 404);
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
      logger.full(`[fallback] serving fallback stream for error status=${err.status || 500} path="${safeUrl(req)}"`);
      try {
        await fallbackStream.serve(req, res, err.status || 500);
      } catch (fallbackErr) {
        next(fallbackErr);
      }
      return;
    }

    logger.error(`[error] ${req.method} ${safeUrl(req)} status=${err.status || 500} message="${err.message || "Internal server error"}"`, err);

    const status = err.status || 500;
    res.status(status).json({
      error: err.message || "Internal server error"
    });
  });

  return app;
}

function serveWebApp(req, res, next) {
  if (!isBrowserRequest(req)) {
    next();
    return;
  }
  res.sendFile(path.resolve(__dirname, "..", "public", "index.html"));
}

function shouldServeFallbackStream(req, fallbackStream) {
  return (req.method === "GET" || req.method === "HEAD")
    && fallbackStream
    && fallbackStream.ready
    && !isBrowserRequest(req);
}

function isBrowserRequest(req) {
  const userAgent = req.get("user-agent") || "";
  const accept = req.get("accept") || "";
  return /\bMozilla\/\d/i.test(userAgent)
    || accept.includes("text/html");
}

function safeUrl(req) {
  const url = new URL(req.originalUrl, "http://localhost");
  for (const key of ["secret", "shareToken", "authToken", "apiKey", "playbackSecret", "playbackToken"]) {
    if (url.searchParams.has(key)) {
      url.searchParams.set(key, "[redacted]");
    }
  }

  return `${url.pathname}${url.search}`;
}

module.exports = { createApp };
