const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const logger = require("../utils/logger");
const { httpError } = require("../utils/httpErrors");

module.exports = function createAdminRoutes({ accountService, appSettings, config, ffmpeg, fallbackStream, hardware, progress, mediaIndex, metadata, indexScanScheduler, playbackTokens }) {
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
      res.json({ accounts: await accountService.list() });
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

  router.get("/hardware", requirePermission("canViewHardware"), (req, res) => {
    res.json(hardware.sample());
  });

  router.get("/logs", requirePermission("canViewLogs"), (req, res) => {
    res.json({ entries: logger.recent(req.query.limit) });
  });

  router.get("/settings", requirePermission("canManageSettings"), async (req, res, next) => {
    try {
      res.json({ settings: await appSettings.get() });
    } catch (err) {
      next(err);
    }
  });

  router.put("/settings", requirePermission("canManageSettings"), async (req, res, next) => {
    try {
      const settings = await appSettings.save(req.body && req.body.settings || req.body || {});
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
      res.json({ settings });
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
      const accounts = await accountService.list();
      const items = [];
      for (const account of accounts) {
        const userItems = await progress.history(mediaIndex, metadata, req.authToken, req.authParamName, null, account.id);
        items.push(...userItems.map((item) => ({
          ...item,
          user: {
            id: account.id,
            username: account.username
          }
        })));
      }
      items.sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0));
      res.json({ items });
    } catch (err) {
      next(err);
    }
  });

  router.get("/currently-playing", requirePermission("canViewUserHistory"), async (req, res, next) => {
    try {
      const accounts = await accountService.list();
      const accountsById = new Map(accounts.map((account) => [account.id, account]));
      const items = await progress.currentlyPlaying(mediaIndex, metadata, req.authToken, req.authParamName);
      res.json({
        items: items.map((item) => {
          const account = accountsById.get(item.userId);
          return {
            ...item,
            user: {
              id: item.userId,
              username: account ? account.username : item.userId || "global"
            }
          };
        })
      });
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
  const currentPath = path.resolve(String(requestedPath || process.cwd()));
  const stat = await fs.stat(currentPath).catch((err) => {
    if (err.code === "ENOENT") {
      throw httpError(404, "Folder not found");
    }
    if (err.code === "EACCES" || err.code === "EPERM") {
      throw httpError(403, "Folder access denied");
    }
    throw err;
  });
  if (!stat.isDirectory()) {
    throw httpError(400, "Path is not a folder");
  }

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
        metadata.startBackgroundPreload(mediaIndex);
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
  const files = indexedMediaFiles(mediaIndex);
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

function indexedMediaFiles(mediaIndex) {
  return (mediaIndex.index.libraries || []).flatMap((library) => {
    const collection = mediaIndex.index[library.key];
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

function requirePermission(permission) {
  return (req, res, next) => {
    if (hasPermission(req, permission)) {
      next();
      return;
    }
    next(httpError(403, "Permission denied"));
  };
}

function canViewAdmin(req) {
  return req.authMode === "admin"
    || Boolean(req.user && req.user.permissions && req.user.permissions.canViewAdmin);
}

function hasPermission(req, permission) {
  const permissions = req.user && req.user.permissions || {};
  return req.authMode === "admin" || Boolean(permissions[permission]);
}
