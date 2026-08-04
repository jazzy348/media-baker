const express = require("express");
const path = require("path");
const { httpError, isClientAbort } = require("../utils/httpErrors");

const PLAYBACK_QUERY_PARAMETERS = ["audio", "subtitle", "audioChannels", "quality", "3d", "t"];

module.exports = function createOpenMovieRoutes({ mediaIndex, metadata, openMovie, playbackTokens }) {
  const router = express.Router();

  router.get("/movies", async (req, res, next) => {
    try {
      res.json(await openMovie.movieCatalogue(req.allowedLibraryKeys));
    } catch (err) {
      next(err);
    }
  });

  router.get("/tv", async (req, res, next) => {
    try {
      res.json(await openMovie.tvCatalogue(req.allowedLibraryKeys));
    } catch (err) {
      next(err);
    }
  });

  router.get("/:kind(movies|episodes)/:id/poster", async (req, res, next) => {
    try {
      const resolved = await resolveOpenMovieItem(openMovie, req);
      const posterPath = req.params.kind === "movies"
        ? await moviePoster(metadata, resolved)
        : await episodePoster(mediaIndex, metadata, resolved, req.query.art === "show");
      const filePath = posterPath || path.resolve(__dirname, "..", "..", "public", "icons", "media-baker-512.png");
      res.set("Cache-Control", "private, max-age=86400");
      res.type(imageContentType(filePath));
      res.sendFile(filePath, (err) => {
        if (err && !isClientAbort(err)) next(httpError(err.statusCode || 404, "Poster not found"));
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/episodes/:id/season-poster", async (req, res, next) => {
    try {
      const resolved = await resolveOpenMovieItem(openMovie, req, "episode");
      const posterPath = await seasonPoster(mediaIndex, metadata, resolved);
      const filePath = posterPath || path.resolve(__dirname, "..", "..", "public", "icons", "media-baker-512.png");
      res.set("Cache-Control", "private, max-age=86400");
      res.type(imageContentType(filePath));
      res.sendFile(filePath, (err) => {
        if (err && !isClientAbort(err)) next(httpError(err.statusCode || 404, "Season poster not found"));
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/:kind(movies|episodes)/:id/play", async (req, res, next) => {
    try {
      requireCopyStreamPermission(req);
      const resolved = await resolveOpenMovieItem(openMovie, req);
      const params = new URLSearchParams({
        playbackToken: playbackTokens.createCopyStreamToken(
          resolved.library.key,
          resolved.item.id,
          req.user.id
        )
      });
      for (const name of PLAYBACK_QUERY_PARAMETERS) {
        if (typeof req.query[name] === "string" && req.query[name]) params.set(name, req.query[name]);
      }
      res.redirect(
        307,
        `/api/streams/${encodeURIComponent(resolved.library.key)}/${encodeURIComponent(resolved.item.id)}/master.m3u8?${params}`
      );
    } catch (err) {
      next(err);
    }
  });

  return router;
};

async function resolveOpenMovieItem(openMovie, req, requestedKind = null) {
  const kind = requestedKind || (req.params.kind === "episodes" ? "episode" : "movie");
  const resolved = await openMovie.resolve(kind, req.params.id, req.allowedLibraryKeys);
  if (!resolved) throw httpError(404, `${kind === "movie" ? "Movie" : "Episode"} not found`);
  return resolved;
}

async function moviePoster(metadata, resolved) {
  if (!metadata) return null;
  const record = await metadata.getForMedia(resolved.library.key, resolved.item);
  return record && record.available && record.posterFilename
    ? metadata.ensurePosterFile(record.posterFilename)
    : null;
}

async function episodePoster(mediaIndex, metadata, resolved, showArtwork) {
  if (!metadata) return null;
  if (!showArtwork) {
    const thumbnail = await metadata.ensureThumbnailForMedia(resolved.library.key, resolved.item);
    if (thumbnail && thumbnail.available && thumbnail.filePath) return thumbnail.filePath;
  }

  if (showArtwork && resolved.item.showId) {
    const showRecord = await metadata.getCachedForMedia(resolved.library.key, resolved.item.showId);
    if (showRecord && showRecord.available && showRecord.posterFilename) {
      const showPoster = await metadata.ensurePosterFile(showRecord.posterFilename);
      if (showPoster) return showPoster;
    }
  }

  return seasonPoster(mediaIndex, metadata, resolved);
}

async function seasonPoster(mediaIndex, metadata, resolved) {
  if (!metadata) return null;
  const show = resolved.item.showId
    ? await mediaIndex.getShow(resolved.item.showId, resolved.library.key)
    : null;
  const showEpisodes = show
    ? (show.seasons || []).flatMap((season) => season.episodes || [])
    : [];
  const poster = await metadata.ensureSeasonPosterForMedia(resolved.library.key, resolved.item, showEpisodes);
  return poster && poster.available ? poster.filePath : null;
}

function requireCopyStreamPermission(req) {
  const permissions = req.user && req.user.permissions || {};
  if (!req.user || (!permissions.isAdmin && !permissions.canCopyStreamUrls)) {
    throw httpError(403, "Copy stream URL access required");
  }
}

function imageContentType(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case ".webp": return "image/webp";
    case ".png": return "image/png";
    case ".gif": return "image/gif";
    default: return "image/jpeg";
  }
}
