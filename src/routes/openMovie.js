const express = require("express");
const path = require("path");
const { httpError, isClientAbort } = require("../utils/httpErrors");

const PLAYBACK_QUERY_PARAMETERS = ["audio", "subtitle", "audioChannels", "quality", "3d", "t"];

module.exports = function createOpenMovieRoutes({ openMovie, playbackTokens, imageProcessor, openMovieArtwork, openMoviePosterAtlases }) {
  const router = express.Router();

  router.get("/movies", async (req, res, next) => {
    try {
      res.json(await openMovie.movieCatalogue(req.allowedLibraryKeys, openMovieOffset(req.query.offset)));
    } catch (err) {
      next(err);
    }
  });

  router.get("/tv", async (req, res, next) => {
    try {
      res.json(await openMovie.tvCatalogue(req.allowedLibraryKeys, openMovieOffset(req.query.offset)));
    } catch (err) {
      next(err);
    }
  });

  router.get("/poster-atlases/:atlasId", async (req, res, next) => {
    try {
      const atlasId = positivePathInteger(req.params.atlasId, "atlas ID");
      const resolved = await openMoviePosterAtlases.resolve(atlasId, req.allowedLibraryKeys);
      if (resolved && resolved.forbidden) throw httpError(403, "API key cannot access this poster atlas");
      if (!resolved) throw httpError(404, "Poster atlas not found");
      const etag = resolved.etag;
      res.set({
        "Cache-Control": `private, max-age=${resolved.ttlSeconds}`,
        ETag: etag
      });
      if (etagMatches(req.get("If-None-Match"), etag) || req.fresh) {
        res.status(304).end();
        return;
      }
      res.type("image/webp");
      res.sendFile(resolved.filePath, (err) => {
        if (err && !isClientAbort(err)) next(httpError(500, "Poster atlas storage failure"));
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/:kind(movies|episodes)/:id/poster", async (req, res, next) => {
    try {
      const resolved = await resolveOpenMovieItem(openMovie, req);
      const posterPath = req.params.kind === "movies"
        ? await openMovieArtwork.resolvedMovie(resolved)
        : await openMovieArtwork.resolvedEpisode(resolved, req.query.art === "show" ? "show" : "episode");
      const filePath = posterPath || openMovieArtwork.placeholderPath;
      await servePoster(req, res, next, imageProcessor, filePath, "Poster not found");
    } catch (err) {
      next(err);
    }
  });

  router.get("/episodes/:id/season-poster", async (req, res, next) => {
    try {
      const resolved = await resolveOpenMovieItem(openMovie, req, "episode");
      const posterPath = await openMovieArtwork.resolvedEpisode(resolved, "season");
      const filePath = posterPath || openMovieArtwork.placeholderPath;
      await servePoster(req, res, next, imageProcessor, filePath, "Season poster not found");
    } catch (err) {
      next(err);
    }
  });

  router.get("/play/:variantId", async (req, res, next) => {
    try {
      requireCopyStreamPermission(req);
      const resolved = await openMovie.resolveVariant(req.params.variantId, req.allowedLibraryKeys);
      if (!resolved) throw httpError(404, "Playback variant not found");
      const params = new URLSearchParams({
        playbackToken: playbackTokens.createCopyStreamToken(
          resolved.library.key,
          resolved.item.id,
          req.user.id
        ),
        audio: resolved.variant.audio.selector,
        subtitle: resolved.variant.subtitle ? resolved.variant.subtitle.selector : "none"
      });
      res.redirect(
        307,
        `/api/streams/${encodeURIComponent(resolved.library.key)}/${encodeURIComponent(resolved.item.id)}/master.m3u8?${params}`
      );
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

async function servePoster(req, res, next, imageProcessor, filePath, notFoundMessage) {
  const dimensions = posterDimensions(req.query);
  res.set("Cache-Control", "private, max-age=86400");
  if (dimensions) {
    if (!imageProcessor || typeof imageProcessor.resizeImageBuffer !== "function") {
      throw httpError(503, "Image resizing is unavailable");
    }
    const image = await imageProcessor.resizeImageBuffer(filePath, dimensions);
    res.type("image/webp").send(image);
    return;
  }

  res.type(imageContentType(filePath));
  res.sendFile(filePath, (err) => {
    if (err && !isClientAbort(err)) next(httpError(err.statusCode || 404, notFoundMessage));
  });
}

function openMovieOffset(value) {
  if (value === undefined) return 1;
  return positiveQueryInteger(value, "offset");
}

function posterDimensions(query) {
  const hasWidth = query.width !== undefined;
  const hasHeight = query.height !== undefined;
  if (!hasWidth && !hasHeight) return null;
  return {
    width: hasWidth ? positiveQueryInteger(query.width, "width", 2048) : null,
    height: hasHeight ? positiveQueryInteger(query.height, "height", 2048) : null
  };
}

function positiveQueryInteger(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  const text = typeof value === "string" ? value : "";
  if (!/^[1-9]\d*$/.test(text)) {
    throw httpError(400, `${name} must be a positive integer`);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw httpError(400, `${name} must be no greater than ${maximum}`);
  }
  return parsed;
}

function positivePathInteger(value, name) {
  const text = String(value || "");
  if (!/^[1-9]\d*$/.test(text)) throw httpError(400, `${name} must be a positive integer`);
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) throw httpError(400, `${name} must be a positive integer`);
  return parsed;
}

function etagMatches(header, etag) {
  if (!header) return false;
  return String(header).split(",").some((value) => {
    const candidate = value.trim();
    return candidate === "*" || candidate === etag || candidate === `W/${etag}`;
  });
}
