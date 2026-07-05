const express = require("express");
const path = require("path");
const { httpError, isClientAbort } = require("../utils/httpErrors");
const { resolveMediaFile } = require("../services/mediaResolver");
const logger = require("../utils/logger");

module.exports = function createStreamRoutes({ mediaIndex, hls, images, playbackTokens, progress }, options = {}) {
  const router = express.Router();
  const streamSurface = options.surface === "web" ? "web" : "copy";

  router.get("/:mediaType/:id/image", async (req, res, next) => {
    try {
      if (!isStreamToken(req.playbackTokenPayload, req.params.mediaType, req.params.id, streamSurface)
        || !canUseWebStream(req, req.params.mediaType, streamSurface)) {
        return next(httpError(401, "Unauthorized"));
      }
      const library = mediaIndex.libraryForKey(req.params.mediaType);
      if (!library || library.type !== "images") {
        return next(httpError(404, "Image not found"));
      }
      const mediaFile = await resolveMediaFile(mediaIndex, req.params.mediaType, req.params.id);
      const filePath = await images.fileFor(mediaFile, 1024);
      res.set("Cache-Control", "private, max-age=86400");
      res.type(path.extname(filePath));
      res.sendFile(filePath, (err) => {
        if (err && !isClientAbort(err)) {
          next(httpError(err.statusCode || 404, "Image not found"));
        }
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/hls/:cacheKey/:filename", async (req, res, next) => {
    try {
      if (!isHlsToken(req.playbackTokenPayload, req.params.cacheKey, streamSurface)
        || !canUseWebStream(req, req.playbackTokenPayload.mediaType, streamSurface)) {
        return next(httpError(401, "Unauthorized"));
      }

      const filePath = hls.getCachedFilePath(req.params.cacheKey, req.params.filename);
      if (!filePath) {
        return next(httpError(400, "Invalid HLS path"));
      }

      if (path.extname(req.params.filename).toLowerCase() === ".m3u8") {
        const playlist = await hls.getPlaylist(req.params.cacheKey);
        res.type(contentTypeFor(req.params.filename));
        res.send(rewritePlaylistUrls(
          playlist,
          `/api/${streamSurface === "web" ? "web-streams" : "streams"}/hls/${req.params.cacheKey}`,
          req.playbackToken,
          streamAuthQuery(req, streamSurface)
        ));
        return;
      }

      const segment = await hls.waitForCachedFile(req.params.cacheKey, req.params.filename);
      if (segment && segment.status === "pending") {
        logger.full(`[hls] segment pending cacheKey=${req.params.cacheKey} filename=${req.params.filename} reason=${segment.reason}`);
        res.set("Retry-After", "2");
        res.status(503).json({ error: "HLS segment is still being generated" });
        return;
      }

      if (!segment || segment.status !== "ready") {
        logger.full(`[hls] segment missing cacheKey=${req.params.cacheKey} filename=${req.params.filename} reason=${segment && segment.reason || "unknown"}`);
        return next(httpError(404, "HLS file not found"));
      }

      res.type(contentTypeFor(req.params.filename));
      res.sendFile(segment.filePath, (err) => {
        if (err) {
          if (isClientAbort(err)) {
            return;
          }
          next(httpError(err.statusCode || 404, "HLS file not found"));
          return;
        }

        const progressLibrary = mediaIndex.libraryForKey(req.playbackTokenPayload.mediaType);
        if (progress
          && progressLibrary
          && progressLibrary.trackProgress !== false
          && req.playbackTokenPayload.mediaType
          && req.playbackTokenPayload.mediaId) {
          hls.segmentProgress(req.params.cacheKey, req.params.filename)
            .then((segmentProgress) => segmentProgress && progress.recordSegmentDelivery(
              req.playbackTokenPayload.userId || "global",
              req.playbackTokenPayload.mediaType,
              req.playbackTokenPayload.mediaId,
              req.params.cacheKey,
              req.playbackTokenPayload.jti,
              segmentProgress
            ))
            .catch((progressErr) => logger.error(`[progress] segment delivery update failed message="${progressErr.message}"`, progressErr));
        }
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/:mediaType/:id/master.m3u8", async (req, res, next) => {
    try {
      if (!isStreamToken(req.playbackTokenPayload, req.params.mediaType, req.params.id, streamSurface)
        || !canUseWebStream(req, req.params.mediaType, streamSurface)) {
        return next(httpError(401, "Unauthorized"));
      }

      logger.info(`[stream] request mediaType=${req.params.mediaType} id=${req.params.id} audio=${req.query.audio || "default"} subtitle=${req.query.subtitle || "auto"} audioChannels=${req.query.audioChannels || req.query.audioMode || req.query.channelMode || "preserve"} quality=${req.query.quality || "original"} url="${safeUrl(req)}"`);
      const mediaFile = await resolveMediaFile(mediaIndex, req.params.mediaType, req.params.id);
      logger.info(`[stream] resolved file id=${req.params.id} title="${mediaFile.title || mediaFile.showName || mediaFile.filename}" file="${mediaFile.filePath}"`);
      const stream = await hls.prepare(mediaFile, {
        audio: req.query.audio,
        subtitle: req.query.subtitle,
        audioChannels: req.query.audioChannels || req.query.audioMode || req.query.channelMode,
        quality: req.query.quality
      });
      logger.info(`[stream] serving playlist cacheKey=${stream.cacheKey} playlist="${stream.playlistPath}"`);
      const playlist = await hls.getPlaylist(stream.cacheKey);
      const hlsToken = streamSurface === "web"
        ? playbackTokens.createWebHlsToken(stream.cacheKey, req.params.mediaType, req.params.id, req.playbackTokenPayload.userId || "global")
        : playbackTokens.createCopyHlsToken(stream.cacheKey, req.params.mediaType, req.params.id, req.playbackTokenPayload.userId || "global");
      res.type(contentTypeFor("master.m3u8"));
      res.send(rewritePlaylistUrls(
        playlist,
        `/api/${streamSurface === "web" ? "web-streams" : "streams"}/hls/${stream.cacheKey}`,
        hlsToken,
        streamAuthQuery(req, streamSurface)
      ));
    } catch (err) {
      next(err);
    }
  });

  return router;
};

function safeUrl(req) {
  const url = new URL(req.originalUrl, "http://localhost");
  for (const key of ["secret", "authToken", "apiKey", "shareToken", "playbackSecret", "playbackToken"]) {
    if (url.searchParams.has(key)) {
      url.searchParams.set(key, "[redacted]");
    }
  }

  return `${url.pathname}${url.search}`;
}

function rewritePlaylistUrls(playlist, baseUrl, secret, authQuery = null) {
  return playlist
    .split(/\r?\n/)
    .map((line) => {
      if (!line.trim() || line.startsWith("#")) {
        return line;
      }

      const url = line.startsWith("http://") || line.startsWith("https://") || line.startsWith("/")
        ? line
        : `${baseUrl}/${line}`;
      const separator = url.includes("?") ? "&" : "?";
      const playbackUrl = `${url}${separator}playbackToken=${encodeURIComponent(secret)}`;
      if (!authQuery) return playbackUrl;
      return `${playbackUrl}&${encodeURIComponent(authQuery.name)}=${encodeURIComponent(authQuery.value)}`;
    })
    .join("\n");
}

function isStreamToken(payload, mediaType, mediaId, surface) {
  return payload
    && payload.scope === `${surface}-stream`
    && payload.mediaType === mediaType
    && payload.mediaId === mediaId;
}

function isHlsToken(payload, cacheKey, surface) {
  return payload
    && payload.scope === `${surface}-hls`
    && payload.cacheKey === cacheKey;
}

function canUseWebStream(req, mediaType, surface) {
  if (surface !== "web") return true;
  if (!req.authMode || !mediaType) return false;
  if (req.user && req.playbackTokenPayload.userId !== req.user.id) return false;
  if (req.allowedLibraryKey) return req.allowedLibraryKey === mediaType;
  if (Array.isArray(req.allowedLibraryKeys)) return req.allowedLibraryKeys.includes(mediaType);
  return true;
}

function streamAuthQuery(req, surface) {
  if (surface !== "web" || req.authFromCookie || !req.authParamName || !req.authToken) return null;
  return { name: req.authParamName, value: req.authToken };
}

function contentTypeFor(filename) {
  const extension = path.extname(filename).toLowerCase();
  if (extension === ".m3u8") {
    return "application/vnd.apple.mpegurl";
  }
  if (extension === ".ts") {
    return "video/mp2t";
  }

  return "application/octet-stream";
}
