const express = require("express");
const { resolveMediaFile } = require("../services/mediaResolver");
const { httpError } = require("../utils/httpErrors");

module.exports = function createProgressRoutes({ mediaIndex, metadata, progress }, options = {}) {
  const router = express.Router();

  router.get("/on-deck", async (req, res, next) => {
    try {
      res.json({
        items: await progress.onDeck(mediaIndex, metadata, req.authToken, req.authParamName || "authToken", allowedLibraries(req), progressUserId(req))
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/history", async (req, res, next) => {
    try {
      res.json({
        items: await progress.history(mediaIndex, metadata, req.authToken, req.authParamName || "authToken", allowedLibraries(req), progressUserId(req))
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/:mediaType/:id", async (req, res, next) => {
    try {
      assertMediaAccess(req, req.params.mediaType);
      if (!tracksProgress(mediaIndex, req.params.mediaType)) {
        res.json(emptyProgress(req.params.mediaType, req.params.id));
        return;
      }
      res.json(await progress.get(progressUserId(req), req.params.mediaType, req.params.id));
    } catch (err) {
      next(err);
    }
  });

  router.post("/:mediaType/shows/:showId/seasons/:seasonNumber/watched", async (req, res, next) => {
    try {
      requireAuthenticatedUser(req);
      requireProgressTracking(mediaIndex, req.params.mediaType);
      const library = mediaIndex.libraryForKey(req.params.mediaType);
      if (!library || library.type !== "tv") {
        next(httpError(404, "Season not found"));
        return;
      }

      const season = await mediaIndex.getSeason(req.params.showId, req.params.seasonNumber, library.key);
      if (!season) {
        next(httpError(404, "Season not found"));
        return;
      }

      const progressById = {};
      for (const episode of season.episodes || []) {
        const record = await progress.markWatched(progressUserId(req), req.params.mediaType, episode.id, episode.durationSeconds);
        progressById[episode.id] = await progress.get(progressUserId(req), record.mediaType, record.mediaId);
      }
      res.json({
        ok: true,
        showId: req.params.showId,
        season: Number.parseInt(req.params.seasonNumber, 10),
        progress: progressById
      });
    } catch (err) {
      next(err);
    }
  });

  router.post("/:mediaType/shows/:showId/seasons/:seasonNumber/unwatched", async (req, res, next) => {
    try {
      requireAuthenticatedUser(req);
      requireProgressTracking(mediaIndex, req.params.mediaType);
      const library = mediaIndex.libraryForKey(req.params.mediaType);
      if (!library || library.type !== "tv") {
        next(httpError(404, "Season not found"));
        return;
      }

      const season = await mediaIndex.getSeason(req.params.showId, req.params.seasonNumber, library.key);
      if (!season) {
        next(httpError(404, "Season not found"));
        return;
      }

      const progressById = {};
      for (const episode of season.episodes || []) {
        const record = await progress.markUnwatched(progressUserId(req), req.params.mediaType, episode.id);
        progressById[episode.id] = await progress.get(progressUserId(req), record.mediaType, record.mediaId);
      }
      res.json({
        ok: true,
        showId: req.params.showId,
        season: Number.parseInt(req.params.seasonNumber, 10),
        progress: progressById
      });
    } catch (err) {
      next(err);
    }
  });

  router.post("/:mediaType/:id/watched", async (req, res, next) => {
    try {
      requireAuthenticatedUser(req);
      requireProgressTracking(mediaIndex, req.params.mediaType);
      const mediaFile = await resolveMediaFile(mediaIndex, req.params.mediaType, req.params.id);
      const record = await progress.markWatched(progressUserId(req), req.params.mediaType, mediaFile.id, req.body && req.body.durationSeconds);
      res.json({
        ok: true,
        progress: await progress.get(progressUserId(req), record.mediaType, record.mediaId)
      });
    } catch (err) {
      next(err);
    }
  });

  router.post("/:mediaType/:id/remove", async (req, res, next) => {
    try {
      requireAuthenticatedUser(req);
      requireProgressTracking(mediaIndex, req.params.mediaType);
      const mediaFile = await resolveMediaFile(mediaIndex, req.params.mediaType, req.params.id);
      const record = await progress.markRemoved(progressUserId(req), req.params.mediaType, mediaFile.id);
      res.json({
        ok: true,
        progress: await progress.get(progressUserId(req), record.mediaType, record.mediaId)
      });
    } catch (err) {
      next(err);
    }
  });

  router.post("/:mediaType/:id/unwatched", async (req, res, next) => {
    try {
      requireAuthenticatedUser(req);
      requireProgressTracking(mediaIndex, req.params.mediaType);
      const mediaFile = await resolveMediaFile(mediaIndex, req.params.mediaType, req.params.id);
      const record = await progress.markUnwatched(progressUserId(req), req.params.mediaType, mediaFile.id);
      res.json({
        ok: true,
        progress: await progress.get(progressUserId(req), record.mediaType, record.mediaId)
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
};

function assertMediaAccess(req, mediaType) {
  if (req.allowedLibraryKey && req.allowedLibraryKey !== mediaType) {
    throw httpError(404, "Library not found");
  }
  if (Array.isArray(req.allowedLibraryKeys) && !req.allowedLibraryKeys.includes(mediaType)) {
    throw httpError(404, "Library not found");
  }
}

function requireAuthenticatedUser(req) {
  if (!req.user) {
    throw httpError(403, "User access required");
  }
}

function tracksProgress(mediaIndex, mediaType) {
  const library = mediaIndex.libraryForKey(mediaType);
  return Boolean(library && library.trackProgress !== false);
}

function requireProgressTracking(mediaIndex, mediaType) {
  if (!tracksProgress(mediaIndex, mediaType)) {
    throw httpError(409, "Playback progress is disabled for this library");
  }
}

function emptyProgress(mediaType, mediaId) {
  return {
    mediaType,
    mediaId,
    status: "none",
    positionSeconds: 0,
    durationSeconds: 0,
    percent: 0,
    resumeSeconds: 0,
    updatedAt: null,
    watchedAt: null
  };
}

function progressUserId(req) {
  return req.user && req.user.id || "global";
}

function allowedLibraries(req) {
  if (req.allowedLibraryKey) {
    return req.allowedLibraryKey;
  }
  return Array.isArray(req.allowedLibraryKeys) ? req.allowedLibraryKeys : null;
}
