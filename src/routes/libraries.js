const express = require("express");
const logger = require("../utils/logger");
const { httpError } = require("../utils/httpErrors");

module.exports = function createLibraryRoutes({ config, mediaIndex, metadata, libraryService, indexScanScheduler }) {
  const router = express.Router();

  router.get("/", requireAnyPermission(["canManageLibraries", "canCreateShareLinks", "canReindex"]), async (req, res, next) => {
    try {
      res.json({
        libraries: withShareUrls(req, (await libraryService.listWithShares()).filter((library) => canAccessLibrary(req, library.key)))
      });
    } catch (err) {
      next(err);
    }
  });

  router.post("/", requirePermission("canManageLibraries"), async (req, res, next) => {
    try {
      const library = await libraryService.add(req.body || {});
      await refreshLibraryConfig(config, libraryService, mediaIndex);
      const indexScan = startBackgroundReindex(indexScanScheduler, mediaIndex, metadata, "library-add");
      res.status(201).json({ library, indexScan });
    } catch (err) {
      next(err);
    }
  });

  router.put("/order", requirePermission("canManageLibraries"), async (req, res, next) => {
    try {
      const libraries = await libraryService.reorder(req.body && req.body.keys);
      config.libraries = libraries;
      await saveIndexLibraryOrder(mediaIndex, libraries);
      res.json({ libraries: withShareUrls(req, await libraryService.listWithShares()) });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/:libraryKey", requirePermission("canManageLibraries"), async (req, res, next) => {
    try {
      const removed = await libraryService.remove(req.params.libraryKey);
      if (!removed) {
        next(httpError(404, "Library not found"));
        return;
      }

      await refreshLibraryConfig(config, libraryService, mediaIndex);
      const indexScan = startBackgroundReindex(indexScanScheduler, mediaIndex, metadata, "library-remove");
      res.json({ ok: true, indexScan });
    } catch (err) {
      next(err);
    }
  });

  router.post("/:libraryKey/shares", requirePermission("canCreateShareLinks"), async (req, res, next) => {
    try {
      assertLibraryAccess(req, req.params.libraryKey);
      const share = await libraryService.createShare(req.params.libraryKey);
      res.status(201).json({
        share: publicShareWithUrl(req, share)
      });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/:libraryKey/shares/:shareId", requirePermission("canCreateShareLinks"), async (req, res, next) => {
    try {
      assertLibraryAccess(req, req.params.libraryKey);
      const revoked = await libraryService.revokeShare(req.params.libraryKey, req.params.shareId);
      if (!revoked) {
        next(httpError(404, "Share not found"));
        return;
      }

      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.get("/:libraryKey", requireLibraryAccess, (req, res, next) => {
    const library = mediaIndex.libraryForKey(req.params.libraryKey);
    if (!library) {
      next(httpError(404, "Library not found"));
      return;
    }

    res.json(library.type === "tv"
      ? {
        generatedAt: mediaIndex.index.generatedAt,
        library,
        shows: mediaIndex.listShows(library.key),
        items: mediaIndex.collection(library.key, "tv").items || []
      }
      : {
        generatedAt: mediaIndex.index.generatedAt,
        library,
        movies: mediaIndex.listMovies(library.key)
      });
  });

  router.post("/:libraryKey/reindex", requirePermission("canReindex"), async (req, res, next) => {
    try {
      const library = mediaIndex.libraryForKey(req.params.libraryKey);
      if (!library) {
        next(httpError(404, "Library not found"));
        return;
      }
      assertLibraryAccess(req, library.key);

      const indexScan = startBackgroundLibraryReindex(mediaIndex, metadata, library.key);
      res.status(202).json({
        ok: true,
        library,
        indexScan
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/:libraryKey/:itemId", requireLibraryAccess, (req, res, next) => {
    const library = mediaIndex.libraryForKey(req.params.libraryKey);
    if (!library) {
      next(httpError(404, "Library not found"));
      return;
    }

    const item = library.type === "tv"
      ? mediaIndex.getShow(req.params.itemId, library.key) || mediaIndex.getMovie(req.params.itemId, library.key)
      : mediaIndex.getMovie(req.params.itemId, library.key);
    if (!item) {
      next(httpError(404, `${library.title} item not found`));
      return;
    }

    res.json(item);
  });

  router.get("/:libraryKey/:showId/seasons/:seasonNumber", requireLibraryAccess, (req, res, next) => {
    const library = mediaIndex.libraryForKey(req.params.libraryKey);
    if (!library || library.type !== "tv") {
      next(httpError(404, "Library not found"));
      return;
    }

    const season = mediaIndex.getSeason(req.params.showId, req.params.seasonNumber, library.key);
    if (!season) {
      next(httpError(404, `${library.title} season not found`));
      return;
    }

    res.json(season);
  });

  return router;
};

async function refreshLibraryConfig(config, libraryService, mediaIndex) {
  config.libraries = await libraryService.list();
  await mediaIndex.syncLibrariesFromConfig();
}

function startBackgroundReindex(indexScanScheduler, mediaIndex, metadata, reason) {
  if (indexScanScheduler) {
    indexScanScheduler.run(reason).catch((err) => {
      logger.error(`[index-scan] background scan failed reason=${reason} message="${err.message}"`, err);
    });
    return indexScanScheduler.getStatus();
  }

  mediaIndex.reindex()
    .then(() => {
      if (metadata) {
        metadata.startBackgroundPreload(mediaIndex);
      }
    })
    .catch((err) => {
      logger.error(`[index-scan] background reindex failed reason=${reason} message="${err.message}"`, err);
    });
  return { running: true };
}

function startBackgroundLibraryReindex(mediaIndex, metadata, libraryKey) {
  mediaIndex.reindexLibrary(libraryKey)
    .then(() => {
      if (metadata) {
        metadata.startBackgroundPreload(mediaIndex);
      }
    })
    .catch((err) => {
      logger.error(`[index-scan] background library reindex failed library=${libraryKey} message="${err.message}"`, err);
    });

  return {
    running: true,
    libraryKey
  };
}

function assertLibraryAccess(req, libraryKey) {
  if (!canAccessLibrary(req, libraryKey)) {
    throw httpError(404, "Library not found");
  }
}

async function saveIndexLibraryOrder(mediaIndex, libraries) {
  mediaIndex.index.libraries = libraries.map((library) => ({
    key: library.key,
    title: library.title,
    type: library.type,
    rawType: library.rawType,
    threeD: Boolean(library.threeD),
    path: library.path
  }));
  await mediaIndex.indexStore.save(mediaIndex.index);
}

function requireLibraryAccess(req, res, next) {
  if (!canAccessLibrary(req, req.params.libraryKey)) {
    next(httpError(404, "Library not found"));
    return;
  }
  next();
}

function requirePermission(permission) {
  return (req, res, next) => {
    const permissions = req.user && req.user.permissions || {};
    if (req.authMode === "admin" || permissions[permission]) {
      next();
      return;
    }
    next(httpError(403, "Permission denied"));
  };
}

function requireAnyPermission(permissionsList) {
  return (req, res, next) => {
    const permissions = req.user && req.user.permissions || {};
    if (req.authMode === "admin" || permissionsList.some((permission) => permissions[permission])) {
      next();
      return;
    }
    next(httpError(403, "Permission denied"));
  };
}

function canAccessLibrary(req, libraryKey) {
  if (req.allowedLibraryKey) {
    return req.allowedLibraryKey === libraryKey;
  }
  if (Array.isArray(req.allowedLibraryKeys)) {
    return req.allowedLibraryKeys.includes(libraryKey);
  }
  return true;
}

function publicShareWithUrl(req, share) {
  return {
    id: share.id,
    libraryKey: share.libraryKey,
    createdAt: share.createdAt,
    revokedAt: share.revokedAt || null,
    url: shareUrl(req, share.token)
  };
}

function withShareUrls(req, libraries) {
  return libraries.map((library) => ({
    ...library,
    shares: (library.shares || []).map((share) => ({
      ...share,
      url: share.token && !share.revokedAt ? shareUrl(req, share.token) : null
    }))
  }));
}

function shareUrl(req, token) {
  const proto = String(req.get("x-forwarded-proto") || req.protocol || "http").split(",")[0].trim();
  const host = req.get("x-forwarded-host") || req.get("host");
  const url = new URL("/", `${proto}://${host}`);
  url.searchParams.set("shareToken", token);
  return url.toString();
}
