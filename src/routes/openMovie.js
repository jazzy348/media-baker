const express = require("express");
const path = require("path");
const { httpError, isClientAbort } = require("../utils/httpErrors");
const { createApiKeyAuthMiddleware } = require("../middleware/auth");
const {
  OPEN_MOVIE_OPERATIONS: OPERATIONS,
  OPEN_MOVIE_ON_DECK_PAGE_SIZE: ON_DECK_PAGE_SIZE
} = require("../services/openMovieCapabilityService");
const { safeRequestUrl } = require("../utils/safeRequestUrl");
const logger = require("../utils/logger");

module.exports = function createOpenMovieRoutes(services) {
  const {
    accountService,
    appSettings,
    mediaIndex,
    metadata,
    progress,
    openMovie,
    openMovieIdStore,
    openMovieCapabilities,
    playbackTokens,
    imageProcessor,
    openMovieArtwork,
    openMoviePosterAtlases
  } = services;
  const router = express.Router();

  router.use((req, res, next) => {
    res.set("Cache-Control", "private, no-store");
    if (!appSettings || !appSettings.isOpenMovieEnabled()) {
      logger.full(`[openmovie] rejected disabled endpoint method=${req.method} path="${safeRequestUrl(req)}"`);
      next(httpError(404, "Not found"));
      return;
    }
    next();
  });

  router.get("/auth", createApiKeyAuthMiddleware(accountService), async (req, res, next) => {
    try {
      res.json(openMovieCapabilities.bootstrap(
        req.apiKeyId,
        await openMovieIdStore.peekNextIds()
      ));
    } catch (err) {
      next(err);
    }
  });

  router.get("/access/:token", async (req, res, next) => {
    try {
      if (req.query.apiKey !== undefined || req.get("x-api-key")) throw httpError(404, "Not found");
      const capability = openMovieCapabilities.decrypt(req.params.token);
      if (!capability) throw httpError(404, "Not found");
      const principal = await accountService.resolveApiKeyPrincipal(capability.apiKeyId);
      if (!principal) throw httpError(404, "Not found");
      const access = requestAccess(principal.user);

      switch (capability.operation) {
        case OPERATIONS.MOVIES:
          {
          const offset = capabilityInteger(capability, 0, 1);
          return res.json(openMovieCapabilities.protectMovieCatalogue(
            await openMovie.movieCatalogue(access.allowedLibraryKeys, offset),
            capability.apiKeyId,
            offset
          ));
          }
        case OPERATIONS.TV:
          {
          const offset = capabilityInteger(capability, 0, 1);
          return res.json(openMovieCapabilities.protectTvCatalogue(
            await openMovie.tvCatalogue(access.allowedLibraryKeys, offset),
            capability.apiKeyId,
            offset
          ));
          }
        case OPERATIONS.ON_DECK:
          {
            const page = capabilityInteger(capability, 0, 1);
            const items = await openMovieOnDeckItems(services, access, principal.user.id);
            return res.json(openMovieCapabilities.protectOnDeckPage(
              pageItems(items, page),
              capability.apiKeyId,
              page,
              items.length
            ));
          }
        case OPERATIONS.FUTURE_URLS:
          return res.json(openMovieCapabilities.futureUrls(
            capability.apiKeyId,
            {
              movie: capabilityInteger(capability, 0),
              episode: capabilityInteger(capability, 1),
              variant: capabilityInteger(capability, 2),
              onDeckPage: capabilityInteger(capability, 3)
            },
            futureUrlCount(req.query.count)
          ));
        case OPERATIONS.MOVIE_POSTER:
          return serveItemPoster("movie", capability, access, services, req, res, next);
        case OPERATIONS.EPISODE_POSTER:
          return serveItemPoster("episode", capability, access, services, req, res, next, "episode");
        case OPERATIONS.SHOW_POSTER:
          return serveItemPoster("episode", capability, access, services, req, res, next, "show");
        case OPERATIONS.SEASON_POSTER:
          return serveItemPoster("episode", capability, access, services, req, res, next, "season");
        case OPERATIONS.POSTER_ATLAS:
          return serveAtlas(capability, access, openMoviePosterAtlases, req, res, next);
        case OPERATIONS.ON_DECK_POSTER_ATLAS:
          return serveOnDeckAtlas(capability, access, principal.user.id, services, res);
        case OPERATIONS.MOVIE_PLAYBACK:
          return redirectPlayback("movie", capability, access, principal.user, openMovie, playbackTokens, res);
        case OPERATIONS.EPISODE_PLAYBACK:
          return redirectPlayback("episode", capability, access, principal.user, openMovie, playbackTokens, res);
        case OPERATIONS.VARIANT_PLAYBACK:
          return redirectVariant(capability, access, principal.user, openMovie, playbackTokens, res);
        default:
          throw httpError(404, "Not found");
      }
    } catch (err) {
      next(err);
    }
  });

  router.use((req, res, next) => next(httpError(404, "Not found")));

  return router;
};

function requestAccess(user) {
  const permissions = user && user.permissions || {};
  return {
    allowedLibraryKeys: permissions.isAdmin ? null : permissions.libraries,
    canPlay: Boolean(permissions.isAdmin || permissions.canCopyStreamUrls)
  };
}

async function serveItemPoster(kind, capability, access, services, req, res, next, artworkKind = null) {
  const id = capabilityInteger(capability, 0);
  const resolved = await services.openMovie.resolve(kind, id, access.allowedLibraryKeys);
  if (!resolved) throw httpError(404, "Poster not found");
  const posterPath = kind === "movie"
    ? await services.openMovieArtwork.resolvedMovie(resolved)
    : await services.openMovieArtwork.resolvedEpisode(resolved, artworkKind || "episode");
  await servePoster(req, res, next, services.imageProcessor, posterPath || services.openMovieArtwork.placeholderPath);
}

async function serveAtlas(capability, access, posterAtlases, req, res, next) {
  const resolved = await posterAtlases.resolve(capabilityInteger(capability, 0), access.allowedLibraryKeys);
  if (resolved && resolved.forbidden) throw httpError(404, "Not found");
  if (!resolved) throw httpError(404, "Poster atlas not found");
  res.set({ "Cache-Control": `private, max-age=${resolved.ttlSeconds}`, ETag: resolved.etag });
  if (etagMatches(req.get("If-None-Match"), resolved.etag) || req.fresh) {
    res.status(304).end();
    return;
  }
  res.type("image/webp");
  res.sendFile(resolved.filePath, (err) => {
    if (err && !isClientAbort(err)) next(httpError(500, "Poster atlas storage failure"));
  });
}

async function serveOnDeckAtlas(capability, access, userId, services, res) {
  const page = capabilityInteger(capability, 0, 1);
  const items = pageItems(await openMovieOnDeckItems(services, access, userId), page);
  const image = await services.openMoviePosterAtlases.renderOnDeck(items, access.allowedLibraryKeys);
  res.set({
    "Cache-Control": "private, no-store, no-cache, must-revalidate, max-age=0",
    Pragma: "no-cache",
    Expires: "0",
    "Surrogate-Control": "no-store",
    "Content-Length": image.length
  });
  res.type("image/webp").end(image);
}

async function openMovieOnDeckItems(services, access, userId) {
  const cards = await services.progress.onDeck(
    services.mediaIndex,
    services.metadata,
    "",
    "",
    access.allowedLibraryKeys,
    userId
  );
  return services.openMovie.onDeckCatalogue(cards, access.allowedLibraryKeys);
}

function pageItems(items, page) {
  const offset = (page - 1) * ON_DECK_PAGE_SIZE;
  return items.slice(offset, offset + ON_DECK_PAGE_SIZE);
}

async function redirectPlayback(kind, capability, access, user, openMovie, playbackTokens, res) {
  if (!access.canPlay) throw httpError(404, "Not found");
  const resolved = await openMovie.resolve(kind, capabilityInteger(capability, 0), access.allowedLibraryKeys);
  if (!resolved) throw httpError(404, "Media not found");
  return redirectResolvedPlayback(resolved, user, playbackTokens, res);
}

async function redirectVariant(capability, access, user, openMovie, playbackTokens, res) {
  if (!access.canPlay) throw httpError(404, "Not found");
  const resolved = await openMovie.resolveVariant(capabilityInteger(capability, 0), access.allowedLibraryKeys);
  if (!resolved) throw httpError(404, "Playback variant not found");
  return redirectResolvedPlayback(resolved, user, playbackTokens, res, {
    audio: resolved.variant.audio.selector,
    subtitle: resolved.variant.subtitle ? resolved.variant.subtitle.selector : "none"
  });
}

function redirectResolvedPlayback(resolved, user, playbackTokens, res, selections = {}) {
  const params = new URLSearchParams({
    playbackToken: playbackTokens.createCopyStreamToken(resolved.library.key, resolved.item.id, user.id),
    ...selections
  });
  res.redirect(307, `/api/streams/${encodeURIComponent(resolved.library.key)}/${encodeURIComponent(resolved.item.id)}/master.m3u8?${params}`);
}

function capabilityInteger(capability, index, fallback = null) {
  const value = capability.values[index];
  if (value === undefined && fallback !== null) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) throw httpError(404, "Not found");
  return value;
}

function futureUrlCount(value) {
  if (value === undefined || value === "") return 1000;
  const count = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(count) || count < 1 || count > 5000) {
    throw httpError(400, "count must be an integer between 1 and 5000");
  }
  return count;
}

async function servePoster(req, res, next, imageProcessor, filePath) {
  const dimensions = posterDimensions(req.query);
  res.set("Cache-Control", "private, max-age=86400");
  if (dimensions) {
    if (!imageProcessor || typeof imageProcessor.resizeImageBuffer !== "function") throw httpError(503, "Image resizing is unavailable");
    const image = await imageProcessor.resizeImageBuffer(filePath, dimensions);
    res.type("image/webp").send(image);
    return;
  }
  res.type(imageContentType(filePath));
  res.sendFile(filePath, (err) => {
    if (err && !isClientAbort(err)) next(httpError(err.statusCode || 404, "Poster not found"));
  });
}

function posterDimensions(query) {
  const hasWidth = query.width !== undefined;
  const hasHeight = query.height !== undefined;
  if (!hasWidth && !hasHeight) return null;
  return {
    width: hasWidth ? positiveDimension(query.width, "width") : null,
    height: hasHeight ? positiveDimension(query.height, "height") : null
  };
}

function positiveDimension(value, name) {
  const text = typeof value === "string" ? value : "";
  if (!/^[1-9]\d*$/.test(text)) throw httpError(400, `${name} must be a positive integer`);
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed > 2048) throw httpError(400, `${name} must be no greater than 2048`);
  return parsed;
}

function imageContentType(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case ".webp": return "image/webp";
    case ".png": return "image/png";
    case ".gif": return "image/gif";
    default: return "image/jpeg";
  }
}

function etagMatches(header, etag) {
  if (!header) return false;
  return String(header).split(",").some((value) => {
    const candidate = value.trim();
    return candidate === "*" || candidate === etag || candidate === `W/${etag}`;
  });
}
