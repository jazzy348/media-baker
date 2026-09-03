const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const logger = require("../utils/logger");
const { httpError } = require("../utils/httpErrors");
const { DEINTERLACE_MODES } = require("../utils/deinterlace");
const { syncYtDlpLibrary } = require("../services/ytdlpService");

module.exports = function createAdminRoutes({ accountService, appSettings, backups, branding, config, ffmpeg, fallbackStream, hardware, progress, playbackSync, mediaIndex, metadata, indexScanScheduler, playbackTokens, ytdlp, ytdlpRelay, iptv, updates, optimizer, skipDetection, tasks, watchTogether }) {
  const router = express.Router();

  router.use((req, res, next) => {
    if (!canViewAdmin(req)) {
      next(httpError(403, "Admin access required"));
      return;
    }
    next();
  });

  router.get("/accounts", requirePermission("canManageUsers"), async (req, res, next) => {
    try {
      const allowedLibraryKeys = Array.isArray(req.allowedLibraryKeys) ? new Set(req.allowedLibraryKeys) : null;
      res.json({
        accounts: await accountService.list(),
        libraries: config.libraries
          .filter((library) => !allowedLibraryKeys || allowedLibraryKeys.has(library.key))
          .map((library) => ({ key: library.key, title: library.title })),
        features: {
          iptv: Boolean(config.iptv && config.iptv.enabled)
        }
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/playback-sync/accounts", requireAdmin, async (req, res, next) => {
    try {
      res.json({ accounts: await playbackSync.accounts() });
    } catch (err) {
      next(err);
    }
  });

  router.get("/playback-sync/catalog", requireAdmin, async (req, res, next) => {
    try {
      res.json(await playbackSync.catalog(req.query.offset, req.query.limit));
    } catch (err) {
      next(err);
    }
  });

  router.post("/playback-sync/import", requireAdmin, async (req, res, next) => {
    try {
      const records = Array.isArray(req.body && req.body.records) ? req.body.records : [];
      if (records.length === 0 || records.length > 500) {
        next(httpError(400, "Import requires between 1 and 500 playback records"));
        return;
      }
      res.json(await playbackSync.import(req.body && req.body.userId, records));
    } catch (err) {
      next(err);
    }
  });

  router.post("/accounts", requirePermission("canManageUsers"), async (req, res, next) => {
    try {
      res.status(201).json({ account: await accountService.create(req.body || {}) });
    } catch (err) {
      next(err);
    }
  });

  router.put("/accounts/:id", requirePermission("canManageUsers"), async (req, res, next) => {
    try {
      res.json({ account: await accountService.update(req.params.id, req.body || {}) });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/accounts/:id", requirePermission("canManageUsers"), async (req, res, next) => {
    try {
      if (req.user && req.user.id === req.params.id) {
        next(httpError(400, "You cannot remove your own account"));
        return;
      }
      const removed = await accountService.remove(req.params.id);
      if (!removed) {
        next(httpError(404, "Account not found"));
        return;
      }
      await progress.removeUserHistory(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.get("/api-keys", requirePermission("canManageApiKeys"), async (req, res, next) => {
    try {
      res.json({
        accounts: await accountService.list(),
        apiKeys: await accountService.listApiKeys(req.query.userId || null)
      });
    } catch (err) {
      next(err);
    }
  });

  router.post("/api-keys", requirePermission("canManageApiKeys"), async (req, res, next) => {
    try {
      const userId = req.body && req.body.userId;
      if (!userId) {
        next(httpError(400, "User is required"));
        return;
      }
      const result = await accountService.createApiKey(userId, req.body || {});
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  });

  router.delete("/api-keys/:id", requirePermission("canManageApiKeys"), async (req, res, next) => {
    try {
      const removed = await accountService.revokeApiKey(req.params.id);
      if (!removed) {
        next(httpError(404, "API key not found"));
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.get("/library-views", requirePermission("canManageApiKeys"), async (req, res, next) => {
    try {
      const libraries = librariesAvailableToRequest(config, req);
      const allowedLibraryKeys = new Set(libraries.map((library) => library.key));
      const links = (await accountService.listLibraryViews())
        .filter((link) => !Array.isArray(req.allowedLibraryKeys) || link.libraryKeys.every((key) => allowedLibraryKeys.has(key)))
        .map((link) => libraryViewWithUrl(req, link));
      res.json({
        libraries: libraries.map((library) => ({ key: library.key, title: library.title, type: library.type })),
        links
      });
    } catch (err) {
      next(err);
    }
  });

  router.post("/library-views", requirePermission("canManageApiKeys"), async (req, res, next) => {
    try {
      const body = req.body || {};
      const allowedLibraryKeys = new Set(librariesAvailableToRequest(config, req).map((library) => library.key));
      const selectedLibraryKeys = Array.isArray(body.libraryKeys) ? body.libraryKeys.map(String) : [];
      if (selectedLibraryKeys.some((key) => !allowedLibraryKeys.has(key))) {
        next(httpError(403, "Library access required"));
        return;
      }
      const link = await accountService.createLibraryView(body);
      res.status(201).json({ link: libraryViewWithUrl(req, link) });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/library-views/:id", requirePermission("canManageApiKeys"), async (req, res, next) => {
    try {
      const visibleLink = (await accountService.listLibraryViews()).find((link) => link.id === req.params.id);
      const allowedLibraryKeys = new Set(librariesAvailableToRequest(config, req).map((library) => library.key));
      if (!visibleLink || Array.isArray(req.allowedLibraryKeys) && visibleLink.libraryKeys.some((key) => !allowedLibraryKeys.has(key))) {
        next(httpError(404, "Library view not found"));
        return;
      }
      const revoked = await accountService.revokeLibraryView(req.params.id);
      if (!revoked) {
        next(httpError(404, "Library view not found"));
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.get("/hardware", requirePermission("canViewHardware"), (req, res) => {
    res.json(hardware.sample());
  });

  router.get("/logs", requirePermission("canViewLogs"), (req, res) => {
    res.json({ entries: logger.recent(req.query.limit) });
  });

  router.get("/tasks", requirePermission("canViewTasks"), async (req, res, next) => {
    try {
      res.json(await tasks.snapshot());
    } catch (err) {
      next(err);
    }
  });

  router.get("/tasks/:taskId/queue", requirePermission("canViewTasks"), async (req, res, next) => {
    try {
      res.json(await tasks.queue(req.params.taskId, req.query.offset, req.query.limit));
    } catch (err) {
      next(err);
    }
  });

  router.get("/settings", requirePermission("canManageSettings"), async (req, res, next) => {
    try {
      res.json({
        settings: await appSettings.getPublic(),
        branding: branding.status()
      });
    } catch (err) {
      next(err);
    }
  });

  router.put("/settings", requirePermission("canManageSettings"), async (req, res, next) => {
    try {
      const requestedSettings = req.body && req.body.settings || req.body || {};
      if (requestedSettings.branding && requestedSettings.branding.icon !== undefined) {
        await branding.ensureSelection(requestedSettings.branding.icon);
      }
      const previousOpenMovieEnabled = appSettings.isOpenMovieEnabled();
      const previousYtDlp = JSON.stringify(config.ytdlp || {});
      const previousIptv = JSON.stringify(config.iptv || {});
      const previousUpdates = JSON.stringify(config.updates || {});
      await appSettings.save(requestedSettings);
      const settings = await appSettings.getPublic();
      await branding.activate(settings.branding.icon);
      if (previousOpenMovieEnabled !== appSettings.isOpenMovieEnabled()) {
        logger.info(`[openmovie] endpoints ${appSettings.isOpenMovieEnabled() ? "enabled" : "disabled"}`);
      }
      syncYtDlpLibrary(config);
      const ytdlpChanged = previousYtDlp !== JSON.stringify(config.ytdlp || {});
      const iptvChanged = previousIptv !== JSON.stringify(config.iptv || {});
      const updatesChanged = previousUpdates !== JSON.stringify(config.updates || {});
      if (ytdlpChanged) {
        await mediaIndex.syncLibrariesFromConfig();
      }
      logger.configure(config.logging);
      if (ffmpeg && typeof ffmpeg.reloadConfig === "function") {
        ffmpeg.reloadConfig(config.ffmpeg);
      }
      if (indexScanScheduler && typeof indexScanScheduler.restart === "function") {
        indexScanScheduler.restart();
      }
      if (fallbackStream) {
        try {
          await fallbackStream.prepare();
        } catch (fallbackErr) {
          logger.error(`[fallback] prepare failed after settings update message="${fallbackErr.message}"`, fallbackErr);
        }
      }
      if (playbackTokens) {
        playbackTokens.ttlSeconds = config.hls.ttlSeconds;
      }
      if (ytdlpChanged && ytdlp && typeof ytdlp.restart === "function") {
        ytdlp.restart();
      }
      if (ytdlpChanged && ytdlpRelay && typeof ytdlpRelay.restart === "function") {
        ytdlpRelay.restart();
      }
      if (iptvChanged && iptv && typeof iptv.restart === "function") {
        iptv.restart();
      }
      if (updatesChanged && updates && typeof updates.restart === "function") {
        updates.restart();
      }
      if (optimizer && typeof optimizer.restart === "function") {
        optimizer.restart();
      }
      if (skipDetection && typeof skipDetection.restart === "function") {
        skipDetection.restart();
      }
      if (ytdlpChanged && indexScanScheduler && typeof indexScanScheduler.run === "function") {
        indexScanScheduler.run("settings-update").catch((scanErr) => {
          logger.error(`[index-scan] settings update scan failed message="${scanErr.message}"`, scanErr);
        });
      }
      res.json({
        settings,
        branding: branding.status()
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/ytdlp", requirePermission("canManageSettings"), async (req, res, next) => {
    try {
      res.json({ status: await ytdlpAdminStatus(ytdlp) });
    } catch (err) {
      next(err);
    }
  });

  router.post("/ytdlp/update", requirePermission("canManageSettings"), async (req, res, next) => {
    try {
      await ytdlp.forceUpdate();
      res.json({ status: await ytdlpAdminStatus(ytdlp) });
    } catch (err) {
      next(err);
    }
  });

  router.put("/ytdlp/cookies", requirePermission("canManageSettings"), async (req, res, next) => {
    try {
      const cookies = await ytdlp.saveCookies(req.body && req.body.contents);
      res.json({ cookies });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/ytdlp/cookies", requirePermission("canManageSettings"), async (req, res, next) => {
    try {
      res.json({ cookies: await ytdlp.removeCookies() });
    } catch (err) {
      next(err);
    }
  });

  router.post("/ytdlp/subscriptions", requirePermission("canManageSettings"), async (req, res, next) => {
    try {
      const subscription = await ytdlp.addSubscription(
        req.body && req.body.url,
        req.user && req.user.id || "system"
      );
      res.status(201).json({ subscription, status: await ytdlpAdminStatus(ytdlp) });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/ytdlp/subscriptions/:id", requirePermission("canManageSettings"), async (req, res, next) => {
    try {
      const subscription = await ytdlp.removeSubscription(req.params.id);
      res.json({ subscription, status: await ytdlpAdminStatus(ytdlp) });
    } catch (err) {
      next(err);
    }
  });

  router.get("/optimizer", requirePermission("canManageOptimizer"), (req, res) => {
    res.json(optimizer.status());
  });

  router.put("/optimizer", requirePermission("canManageOptimizer"), async (req, res, next) => {
    try {
      const settings = await appSettings.save({
        optimizer: {
          enabled: Boolean(req.body && req.body.enabled),
          scanIntervalSeconds: Number.parseInt(req.body && req.body.scanIntervalSeconds, 10) || 60,
          parallelJobs: Number.parseInt(req.body && req.body.parallelJobs, 10) || 1,
          libraries: req.body && req.body.libraries || {}
        }
      });
      if (optimizer && typeof optimizer.restart === "function") {
        optimizer.restart();
      }
      res.json({
        settings: settings.optimizer,
        status: optimizer.status()
      });
    } catch (err) {
      next(err);
    }
  });

  router.post("/optimizer/libraries/:libraryKey/full-scan", requirePermission("canManageOptimizer"), (req, res, next) => {
    try {
      const library = config.libraries.find((entry) => entry.key === req.params.libraryKey);
      if (!library || (library.type !== "tv" && library.type !== "movies")) {
        const err = new Error("Optimiser library not found");
        err.status = 404;
        throw err;
      }
      res.json(optimizer.startFullScan(library.key));
    } catch (err) {
      next(err);
    }
  });

  router.delete("/optimizer/failures", requirePermission("canManageOptimizer"), async (req, res, next) => {
    try {
      res.json(await optimizer.clearFailures());
    } catch (err) {
      next(err);
    }
  });

  router.get("/skip-detection", requirePermission("canManageSettings"), async (req, res, next) => {
    try {
      res.json(await skipDetection.getStatus());
    } catch (err) {
      next(err);
    }
  });

  router.get("/skip-detection/markers", requirePermission("canManageSettings"), async (req, res, next) => {
    try {
      res.json({ items: await skipDetection.markerReviews(req.query.limit) });
    } catch (err) {
      next(err);
    }
  });

  router.post("/skip-detection/retry-failures", requirePermission("canManageSettings"), async (req, res, next) => {
    try {
      res.status(202).json(await skipDetection.retryFailures());
    } catch (err) {
      next(err);
    }
  });

  router.post("/skip-detection/reanalyse", requirePermission("canManageSettings"), async (req, res, next) => {
    try {
      const mediaType = req.body && req.body.mediaType ? String(req.body.mediaType) : null;
      const groupId = req.body && req.body.groupId ? String(req.body.groupId) : null;
      if (mediaType && !config.libraries.some((library) => library.key === mediaType && library.type === "tv")) {
        next(httpError(400, "TV library not found"));
        return;
      }
      res.status(202).json(await skipDetection.reanalyse({
        mediaType,
        groupId,
        includeFingerprints: Boolean(req.body && req.body.includeFingerprints)
      }));
    } catch (err) {
      next(err);
    }
  });

  router.get("/updates/status", requireAdmin, async (req, res, next) => {
    try {
      res.json(await updates.status());
    } catch (err) {
      next(err);
    }
  });

  router.post("/updates/check", requireAdmin, async (req, res, next) => {
    try {
      res.json(await updates.status({ force: true }));
    } catch (err) {
      next(err);
    }
  });

  router.post("/updates/install", requireAdmin, async (req, res, next) => {
    try {
      res.status(202).json(await updates.installLatest());
    } catch (err) {
      next(err);
    }
  });

  router.post("/settings/iptv/refresh", requirePermission("canManageSettings"), async (req, res, next) => {
    try {
      if (!config.iptv.enabled) {
        next(httpError(400, "IPTV is not enabled"));
        return;
      }
      res.json({ status: await iptv.refresh() });
    } catch (err) {
      next(err);
    }
  });

  router.get("/settings/iptv/channel-matches", requirePermission("canManageSettings"), (req, res) => {
    res.json(iptv.matchingData());
  });

  router.put("/settings/iptv/channel-matches/:channelId", requirePermission("canManageSettings"), async (req, res, next) => {
    try {
      const data = iptv.matchingData();
      const channel = data.channels.find((entry) => entry.id === req.params.channelId);
      const guideChannelId = req.body && req.body.guideChannelId
        ? String(req.body.guideChannelId).trim()
        : null;
      const deinterlaceMode = String(req.body && req.body.deinterlaceMode || "default").trim().toLowerCase();
      if (!channel) {
        next(httpError(404, "IPTV channel not found"));
        return;
      }
      if (guideChannelId && !data.guideChannels.some((entry) => entry.id === guideChannelId)) {
        next(httpError(400, "EPG channel not found"));
        return;
      }
      if (deinterlaceMode !== "default" && !DEINTERLACE_MODES.has(deinterlaceMode)) {
        next(httpError(400, "Invalid deinterlace mode"));
        return;
      }

      const previousMode = (config.iptv.channelDeinterlaceModes || {})[channel.id] || "default";
      await saveIptvChannelSettings(appSettings, channel.id, guideChannelId, deinterlaceMode);
      if (previousMode !== deinterlaceMode) {
        iptv.resetChannel(channel.id);
      }
      res.json({ ok: true, data: iptv.applyConfiguredChannelMappings() });
    } catch (err) {
      next(err);
    }
  });

  router.get("/duplicates", requirePermission("canManageMetadata"), async (req, res, next) => {
    try {
      res.json(await findDuplicateFiles(mediaIndex, metadata, req.query.limit));
    } catch (err) {
      next(err);
    }
  });

  router.get("/history", requirePermission("canViewUserHistory"), async (req, res, next) => {
    try {
      const { accounts, accountsById } = await loadHistorySubjects(accountService);
      const userId = String(req.query.userId || "").trim() || null;
      if (userId && !accountsById.has(userId)) {
        next(httpError(400, "Unknown history user"));
        return;
      }
      const timespan = String(req.query.timespan || "7d").trim().toLowerCase();
      const range = historyRange(timespan, req.query.from, req.query.to);
      if (!range) {
        next(httpError(400, "Invalid history timespan"));
        return;
      }
      const limit = Math.max(1, Math.min(Number.parseInt(req.query.limit, 10) || 100, 250));
      const offset = Math.max(0, Number.parseInt(req.query.offset, 10) || 0);
      const page = await progress.adminHistory(
        mediaIndex,
        metadata,
        req.authToken,
        req.authParamName,
        { userId, since: range.since, before: range.before, limit, offset }
      );
      res.json({
        ...page,
        items: page.items.map((item) => {
          const account = accountsById.get(item.userId);
          return {
            ...item,
            user: {
              id: item.userId,
              username: account ? account.username : item.userId
            }
          };
        }),
        users: accounts.map((account) => ({ id: account.id, username: account.username })),
        filters: {
          userId,
          timespan,
          from: range.since,
          to: range.before,
          limit,
          offset
        }
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/currently-playing", requirePermission("canViewUserHistory"), async (req, res, next) => {
    try {
      const { accountsById } = await loadHistorySubjects(accountService);
      const items = await progress.currentlyPlaying(mediaIndex, metadata, req.authToken, req.authParamName);
      res.json({
        items: items.map((item) => {
          const account = accountsById.get(item.userId);
          return {
            ...item,
            user: {
              id: item.userId,
              username: account ? account.username : item.userId
            }
          };
        })
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/watch-together", requirePermission("canViewUserHistory"), (req, res) => {
    res.json({ rooms: watchTogether.activeRooms() });
  });

  router.delete("/watch-together/:roomId", requireAdmin, async (req, res, next) => {
    try {
      await watchTogether.adminClose(req.params.roomId, req.user && req.user.username);
      res.json({ closed: true });
    } catch (err) {
      next(err);
    }
  });

  router.get("/folders", requirePermission("canManageLibraries"), async (req, res, next) => {
    try {
      res.json(await listFolders(req.query.path));
    } catch (err) {
      next(err);
    }
  });

  router.get("/backups", requirePermission("canManageBackups"), async (req, res, next) => {
    try {
      res.json(await backups.status());
    } catch (err) {
      next(err);
    }
  });

  router.put("/backups/settings", requirePermission("canManageBackups"), async (req, res, next) => {
    try {
      const settings = await backups.saveSettings(req.body && req.body.settings || req.body || {});
      res.json({ settings, backups: await backups.list(settings.directory) });
    } catch (err) {
      next(err);
    }
  });

  router.post("/backups", requirePermission("canManageBackups"), async (req, res, next) => {
    try {
      res.status(202).json(backups.startCreate("manual"));
    } catch (err) {
      next(err);
    }
  });

  router.post("/backups/:filename/restore", requirePermission("canManageBackups"), async (req, res, next) => {
    try {
      if (!req.body || req.body.confirm !== true) {
        next(httpError(400, "Restore confirmation is required"));
        return;
      }
      const result = await backups.restore(req.params.filename);
      res.json({ restore: result, restarting: true });
      setTimeout(() => process.exit(0), 1500).unref();
    } catch (err) {
      next(err);
    }
  });

  router.get("/backup-folders", requirePermission("canManageBackups"), async (req, res, next) => {
    try {
      res.json(await listFolders(req.query.path));
    } catch (err) {
      next(err);
    }
  });

  router.post("/reindex", requirePermission("canReindex"), async (req, res, next) => {
    try {
      const status = indexScanScheduler
        ? startBackgroundAdminReindex(indexScanScheduler)
        : startBackgroundStandaloneReindex(mediaIndex, metadata);
      res.status(202).json({
        ok: true,
        generatedAt: mediaIndex.index.generatedAt,
        indexScan: status
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
};

async function listFolders(requestedPath) {
  const attemptedPath = path.resolve(String(requestedPath || process.cwd()));
  const defaultRoot = path.parse(process.cwd()).root;
  let stat;
  try {
    stat = await fs.stat(attemptedPath);
  } catch (err) {
    if (!["ENOENT", "EACCES", "EPERM"].includes(err.code)) {
      throw err;
    }
    return {
      path: "",
      attemptedPath,
      parent: null,
      roots: await listRoots(defaultRoot),
      directories: [],
      error: err.code === "ENOENT" ? "Folder not found" : "Folder access denied"
    };
  }
  if (!stat.isDirectory()) {
    return {
      path: "",
      attemptedPath,
      parent: null,
      roots: await listRoots(defaultRoot),
      directories: [],
      error: "Path is not a folder"
    };
  }

  const currentPath = attemptedPath;

  const entries = await fs.readdir(currentPath, { withFileTypes: true }).catch((err) => {
    if (err.code === "EACCES" || err.code === "EPERM") {
      throw httpError(403, "Folder access denied");
    }
    throw err;
  });
  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      path: path.join(currentPath, entry.name)
    }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  const root = path.parse(currentPath).root;

  return {
    path: currentPath,
    attemptedPath: currentPath,
    parent: currentPath === root ? null : path.dirname(currentPath),
    roots: await listRoots(root),
    directories
  };
}

async function listRoots(defaultRoot) {
  if (process.platform !== "win32") {
    return [{ name: defaultRoot, path: defaultRoot }];
  }

  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
  const candidates = await Promise.all(letters.map(async (letter) => {
    const drive = `${letter}:\\`;
    try {
      await fs.access(drive);
      return { name: drive, path: drive };
    } catch (err) {
      return null;
    }
  }));
  return candidates.filter(Boolean);
}

function startBackgroundAdminReindex(indexScanScheduler) {
  indexScanScheduler.run("manual").catch((err) => {
    logger.error(`[index-scan] manual scan failed message="${err.message}"`, err);
  });
  return indexScanScheduler.getStatus();
}

function startBackgroundStandaloneReindex(mediaIndex, metadata) {
  mediaIndex.reindex()
    .then(() => {
      if (metadata) {
        metadata.startBackgroundPreload(mediaIndex, { retryMissing: true });
      }
    })
    .catch((err) => {
      logger.error(`[index-scan] manual scan failed message="${err.message}"`, err);
    });
  return {
    enabled: false,
    intervalSeconds: null,
    running: true,
    lastStartedAt: null,
    lastFinishedAt: null,
    lastError: null
  };
}

async function findDuplicateFiles(mediaIndex, metadata, limit) {
  const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 200, 1000));
  const files = indexedMediaFiles(await mediaIndex.snapshot());
  if (!metadata || !metadata.getCachedForMediaItems || files.length === 0) {
    return { scanned: files.length, matched: 0, groups: [] };
  }

  const cachedByKey = await metadata.getCachedForMediaItems(files.map((item) => ({
    mediaType: item.mediaType,
    id: item.id
  })));
  const groups = new Map();
  let matched = 0;

  for (const item of files) {
    const cached = cachedByKey.get(`${item.mediaType}:${item.id}`);
    if (!cached || !cached.available || !cached.provider || !cached.providerId) {
      continue;
    }

    matched += 1;
    const key = duplicateKey(item, cached);
    const group = groups.get(key) || {
      key,
      kind: item.libraryType,
      provider: cached.provider,
      providerId: cached.providerId,
      title: cached.title || item.title,
      subtitle: duplicateSubtitle(item),
      items: []
    };
    group.items.push({
      id: item.id,
      mediaType: item.mediaType,
      libraryTitle: item.libraryTitle,
      libraryType: item.libraryType,
      title: item.title,
      metadataTitle: cached.title || null,
      subtitle: mediaSubtitle(item),
      filename: item.filename,
      filePath: item.filePath,
      addedAtMs: item.addedAtMs || null,
      mtimeMs: item.mtimeMs || null
    });
    groups.set(key, group);
  }

  const duplicates = [...groups.values()]
    .filter((group) => group.items.length > 1)
    .map((group) => ({
      ...group,
      count: group.items.length,
      items: group.items.sort((a, b) => a.libraryTitle.localeCompare(b.libraryTitle) || a.filePath.localeCompare(b.filePath))
    }))
    .sort((a, b) => b.count - a.count || a.title.localeCompare(b.title))
    .slice(0, safeLimit);

  return {
    scanned: files.length,
    matched,
    duplicateGroups: duplicates.length,
    groups: duplicates
  };
}

function indexedMediaFiles(index) {
  return (index.libraries || []).flatMap((library) => {
    const collection = index[library.key];
    if (library.type === "music" || library.type === "images") {
      return [];
    }
    if (library.type === "movies") {
      return (collection && collection.items || []).map((movie) => ({
        ...movie,
        mediaType: library.key,
        libraryTitle: library.title,
        libraryType: library.type,
        title: movie.title || movie.filename
      }));
    }

    const looseItems = (collection && collection.items || []).map((movie) => ({
      ...movie,
      mediaType: library.key,
      libraryTitle: library.title,
      libraryType: "movies",
      title: movie.title || movie.filename
    }));
    const episodes = (collection && collection.shows || []).flatMap((show) => show.seasons.flatMap((season) => (
      season.episodes.map((episode) => ({
        ...episode,
        mediaType: library.key,
        libraryTitle: library.title,
        libraryType: library.type,
        title: episode.title || episode.filename,
        showName: episode.showName || show.name,
        season: episode.season || season.season
      }))
    )));
    return [...looseItems, ...episodes];
  });
}

function duplicateKey(item, metadataRecord) {
  if (item.libraryType === "tv") {
    return [
      item.libraryType,
      metadataRecord.provider,
      metadataRecord.providerId,
      `s${Number(item.season) || 0}`,
      `e${Number(item.episode) || 0}`
    ].join(":");
  }

  return [item.libraryType, metadataRecord.provider, metadataRecord.providerId].join(":");
}

function duplicateSubtitle(item) {
  return item.libraryType === "tv"
    ? `${item.showName || "Show"} S${pad(item.season)}E${pad(item.episode)}`
    : null;
}

function mediaSubtitle(item) {
  if (item.libraryType === "tv") {
    return `${item.showName || "Show"} S${pad(item.season)}E${pad(item.episode)}`;
  }

  return item.year ? String(item.year) : item.folder || item.filename;
}

function pad(value) {
  return String(value || 0).padStart(2, "0");
}

function historyRange(timespan, from, to) {
  if (timespan === "custom") {
    const since = validHistoryTime(from);
    const before = validHistoryTime(to);
    return since && before && since < before ? { since, before } : null;
  }
  if (timespan === "all") {
    return { since: null, before: null };
  }
  const milliseconds = {
    "24h": 24 * 60 * 60 * 1000,
    "7d": 7 * 24 * 60 * 60 * 1000
  }[timespan];
  return milliseconds
    ? { since: new Date(Date.now() - milliseconds).toISOString(), before: null }
    : null;
}

function validHistoryTime(value) {
  const time = Date.parse(String(value || ""));
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function librariesAvailableToRequest(config, req) {
  const allowedLibraryKeys = Array.isArray(req.allowedLibraryKeys) ? new Set(req.allowedLibraryKeys) : null;
  return (config.libraries || []).filter((library) => !allowedLibraryKeys || allowedLibraryKeys.has(library.key));
}

function libraryViewWithUrl(req, link) {
  const { token, ...publicLink } = link;
  return {
    ...publicLink,
    url: token && !link.revokedAt && !link.expired ? libraryViewUrl(req, token) : null
  };
}

function libraryViewUrl(req, token) {
  const proto = String(req.get("x-forwarded-proto") || req.protocol || "http").split(",")[0].trim();
  const host = req.get("x-forwarded-host") || req.get("host");
  const url = new URL("/", `${proto}://${host}`);
  url.searchParams.set("viewToken", token);
  return url.toString();
}

async function loadHistorySubjects(accountService) {
  const accounts = await accountService.list();
  return {
    accounts,
    accountsById: new Map(accounts.map((account) => [account.id, account]))
  };
}

async function ytdlpAdminStatus(ytdlp) {
  const validation = ytdlp.config.enabled ? await ytdlp.validate() : null;
  return {
    ...ytdlp.status(),
    available: Boolean(validation && validation.ok),
    validation,
    cookies: await ytdlp.cookieStatus()
  };
}

function requirePermission(permission) {
  return (req, res, next) => {
    if (hasPermission(req, permission)) {
      next();
      return;
    }
    next(httpError(403, "Permission denied"));
  };
}

function requireAdmin(req, res, next) {
  if (req.authMode === "admin" && req.user && req.user.permissions && req.user.permissions.isAdmin) {
    next();
    return;
  }
  next(httpError(403, "Admin access required"));
}

function canViewAdmin(req) {
  return req.authMode === "admin"
    || Boolean(req.user && req.user.permissions && req.user.permissions.canViewAdmin);
}

async function saveIptvChannelSettings(appSettings, channelId, guideChannelId, deinterlaceMode) {
  const settings = await appSettings.get();
  const channelMappings = { ...(settings.iptv.channelMappings || {}) };
  const channelDeinterlaceModes = { ...(settings.iptv.channelDeinterlaceModes || {}) };
  if (guideChannelId) {
    channelMappings[channelId] = guideChannelId;
  } else {
    delete channelMappings[channelId];
  }
  if (deinterlaceMode === "default") {
    delete channelDeinterlaceModes[channelId];
  } else {
    channelDeinterlaceModes[channelId] = deinterlaceMode;
  }
  settings.iptv.channelMappings = channelMappings;
  settings.iptv.channelDeinterlaceModes = channelDeinterlaceModes;
  await appSettings.save(settings);
}

function hasPermission(req, permission) {
  const permissions = req.user && req.user.permissions || {};
  return req.authMode === "admin" || Boolean(permissions[permission]);
}
