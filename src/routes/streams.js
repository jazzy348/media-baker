const express = require("express");
const { safeRequestUrl } = require("../utils/safeRequestUrl");
const path = require("path");
const { httpError, isClientAbort } = require("../utils/httpErrors");
const { resolveMediaFile } = require("../services/mediaResolver");
const { getMediaPlaybackOptions } = require("../services/mediaOptions");
const logger = require("../utils/logger");

module.exports = function createStreamRoutes({ mediaIndex, hls, images, ffmpeg, subtitles, playbackTokens, progress, skipDetection }, options = {}) {
  const router = express.Router();
  const streamSurface = ["web", "watch"].includes(options.surface) ? options.surface : "copy";

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
          `${streamBasePath(streamSurface)}/hls/${req.params.cacheKey}`,
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
      const releaseCacheRead = typeof hls.beginCacheRead === "function"
        ? hls.beginCacheRead(req.params.cacheKey)
        : () => {};
      res.once("close", releaseCacheRead);
      res.sendFile(segment.filePath, (err) => {
        releaseCacheRead();
        if (err) {
          if (isClientAbort(err)) {
            return;
          }
          next(httpError(err.statusCode || 404, "HLS file not found"));
          return;
        }

        const progressLibrary = mediaIndex.libraryForKey(req.playbackTokenPayload.mediaType);
        if (progress
          && streamSurface === "copy"
          && progressLibrary
          && req.playbackTokenPayload.mediaType
          && req.playbackTokenPayload.mediaId) {
          hls.segmentProgress(req.params.cacheKey, req.params.filename)
            .then((segmentProgress) => segmentProgress && progress.recordSegmentDelivery(
              req.playbackTokenPayload.userId || "global",
              req.playbackTokenPayload.mediaType,
              req.playbackTokenPayload.mediaId,
              req.params.cacheKey,
              req.playbackTokenPayload.jti,
              segmentProgress,
              {
                trackProgress: progressLibrary.trackProgress !== false,
                completionStartSeconds: req.playbackTokenPayload.completionStartSeconds
              }
            ))
            .catch((progressErr) => logger.error(`[progress] segment delivery update failed message="${progressErr.message}"`, progressErr));
        }
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/:mediaType/:id/audio.m3u8", async (req, res, next) => {
    try {
      if (!isStreamToken(req.playbackTokenPayload, req.params.mediaType, req.params.id, streamSurface)
        || !canUseWebStream(req, req.params.mediaType, streamSurface)
        || streamSurface === "copy") {
        return next(httpError(401, "Unauthorized"));
      }
      const mediaFile = await resolveMediaFile(mediaIndex, req.params.mediaType, req.params.id);
      const stream = await hls.prepareAudioRendition(mediaFile, {
        mediaType: req.params.mediaType,
        mediaId: req.params.id,
        audio: req.query.track,
        audioChannels: req.query.audioChannels
      });
      const playlist = await hls.getPlaylist(stream.cacheKey);
      const hlsToken = createHlsToken(
        playbackTokens,
        streamSurface,
        stream.cacheKey,
        req.playbackTokenPayload,
        req.params.mediaType,
        req.params.id
      );
      res.type(contentTypeFor("audio.m3u8"));
      res.send(rewritePlaylistUrls(
        playlist,
        `${streamBasePath(streamSurface)}/hls/${stream.cacheKey}`,
        hlsToken,
        streamAuthQuery(req, streamSurface)
      ));
    } catch (err) {
      next(err);
    }
  });

  router.get("/:mediaType/:id/subtitles.m3u8", async (req, res, next) => {
    try {
      if (!isStreamToken(req.playbackTokenPayload, req.params.mediaType, req.params.id, streamSurface)
        || !canUseWebStream(req, req.params.mediaType, streamSurface)
        || streamSurface === "copy") {
        return next(httpError(401, "Unauthorized"));
      }
      const mediaFile = await resolveMediaFile(mediaIndex, req.params.mediaType, req.params.id);
      const rendition = await hls.prepareSubtitleRendition(mediaFile, req.query.track);
      const subtitleUrl = mediaRenditionUrl(req, streamSurface, "subtitles.vtt", {
        track: req.query.track,
        playbackToken: req.playbackToken
      });
      const duration = Math.max(1, Number(rendition.duration) || 1);
      res.type(contentTypeFor("subtitles.m3u8"));
      res.send([
        "#EXTM3U",
        "#EXT-X-VERSION:6",
        "#EXT-X-PLAYLIST-TYPE:VOD",
        `#EXT-X-TARGETDURATION:${Math.ceil(duration)}`,
        "#EXT-X-MEDIA-SEQUENCE:0",
        `#EXTINF:${duration.toFixed(3)},`,
        subtitleUrl,
        "#EXT-X-ENDLIST"
      ].join("\n"));
    } catch (err) {
      next(err);
    }
  });

  router.get("/:mediaType/:id/subtitles.vtt", async (req, res, next) => {
    try {
      if (!isStreamToken(req.playbackTokenPayload, req.params.mediaType, req.params.id, streamSurface)
        || !canUseWebStream(req, req.params.mediaType, streamSurface)
        || streamSurface === "copy") {
        return next(httpError(401, "Unauthorized"));
      }
      const mediaFile = await resolveMediaFile(mediaIndex, req.params.mediaType, req.params.id);
      const rendition = await hls.prepareSubtitleRendition(mediaFile, req.query.track);
      res.type("text/vtt");
      res.sendFile(rendition.subtitlePath, (err) => {
        if (err && !isClientAbort(err)) next(httpError(err.statusCode || 404, "Subtitle not found"));
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

      logger.info(`[stream] request mediaType=${req.params.mediaType} id=${req.params.id} audio=${req.query.audio || "default"} subtitle=${req.query.subtitle || "auto"} audioChannels=${req.query.audioChannels || req.query.audioMode || req.query.channelMode || "preserve"} quality=${req.query.quality || "original"} url="${safeRequestUrl(req)}"`);
      const mediaFile = await resolveMediaFile(mediaIndex, req.params.mediaType, req.params.id);
      logger.info(`[stream] resolved file id=${req.params.id} title="${mediaFile.title || mediaFile.showName || mediaFile.filename}" file="${mediaFile.filePath}"`);
      const library = mediaIndex.libraryForKey(req.params.mediaType);
      const playbackOptions = streamSurface === "copy" ? null : await getMediaPlaybackOptions(mediaFile, ffmpeg, {
        library,
        subtitles,
        mediaType: req.params.mediaType
      });
      const selectedSubtitle = playbackOptions && playbackOptions.subtitles.find((item) => item.id === req.query.subtitle);
      const useMultitrackWeb = Boolean(playbackOptions && !playbackOptions.audioOnly && playbackOptions.audio.length > 0);
      const stream = await hls.prepare(mediaFile, {
        mediaType: req.params.mediaType,
        mediaId: req.params.id,
        audio: req.query.audio,
        subtitle: useMultitrackWeb && (!selectedSubtitle || selectedSubtitle.webSwitchable) ? "none" : req.query.subtitle,
        audioChannels: req.query.audioChannels || req.query.audioMode || req.query.channelMode,
        quality: req.query.quality,
        rendition: useMultitrackWeb ? "video" : "muxed"
      });
      logger.info(`[stream] serving playlist cacheKey=${stream.cacheKey} playlist="${stream.playlistPath}"`);
      const playlist = await hls.getPlaylist(stream.cacheKey);
      const completionStartSeconds = streamSurface === "copy"
        && library
        && library.type === "tv"
        && skipDetection
        && typeof skipDetection.completionStartSeconds === "function"
        ? await skipDetection.completionStartSeconds(req.params.mediaType, mediaFile)
        : null;
      const hlsToken = createHlsToken(
        playbackTokens,
        streamSurface,
        stream.cacheKey,
        req.playbackTokenPayload,
        req.params.mediaType,
        req.params.id,
        completionStartSeconds
      );
      res.type(contentTypeFor("master.m3u8"));
      if (useMultitrackWeb) {
        res.send(buildMultitrackMaster({
          req,
          surface: streamSurface,
          playbackOptions,
          selectedAudioId: req.query.audio,
          selectedSubtitleId: req.query.subtitle,
          includeSwitchableSubtitles: !selectedSubtitle || selectedSubtitle.id === "none" || selectedSubtitle.webSwitchable,
          audioChannels: req.query.audioChannels || req.query.audioMode || req.query.channelMode,
          videoPlaylistUrl: appendAuthQuery(
            `${streamBasePath(streamSurface)}/hls/${stream.cacheKey}/master.m3u8`,
            { playbackToken: hlsToken },
            streamAuthQuery(req, streamSurface)
          )
        }));
        return;
      }
      res.send(rewritePlaylistUrls(
        playlist,
        `${streamBasePath(streamSurface)}/hls/${stream.cacheKey}`,
        hlsToken,
        streamAuthQuery(req, streamSurface)
      ));
    } catch (err) {
      next(err);
    }
  });

  return router;
};

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

function streamBasePath(surface) {
  if (surface === "web") return "/api/web-streams";
  if (surface === "watch") return "/api/watch-streams";
  return "/api/streams";
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
  if (extension === ".vtt") {
    return "text/vtt";
  }

  return "application/octet-stream";
}

function createHlsToken(playbackTokens, surface, cacheKey, payload, mediaType, mediaId, completionStartSeconds = null) {
  if (surface === "web") {
    return playbackTokens.createWebHlsToken(cacheKey, mediaType, mediaId, payload.userId || "global");
  }
  if (surface === "watch") {
    return playbackTokens.createWatchHlsToken(cacheKey, payload.roomId, payload.participantId, mediaType, mediaId);
  }
  return playbackTokens.createCopyHlsToken(
    cacheKey,
    mediaType,
    mediaId,
    payload.userId || "global",
    completionStartSeconds
  );
}

function buildMultitrackMaster({ req, surface, playbackOptions, selectedAudioId, selectedSubtitleId, includeSwitchableSubtitles, audioChannels, videoPlaylistUrl }) {
  const selectedAudio = playbackOptions.audio.find((item) => item.id === selectedAudioId) || playbackOptions.audio[0];
  const switchableSubtitles = includeSwitchableSubtitles
    ? playbackOptions.subtitles.filter((item) => item.id !== "none" && item.webSwitchable)
    : [];
  const lines = ["#EXTM3U", "#EXT-X-VERSION:6", "#EXT-X-INDEPENDENT-SEGMENTS"];

  playbackOptions.audio.forEach((track, index) => {
    const uri = mediaRenditionUrl(req, surface, "audio.m3u8", {
      track: track.id,
      audioChannels: audioChannels || "preserve",
      playbackToken: req.playbackToken
    });
    lines.push(`#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="${hlsAttribute(track.label)}",LANGUAGE="${hlsAttribute(track.language)}",DEFAULT=${track.id === selectedAudio.id ? "YES" : "NO"},AUTOSELECT=${index === 0 || track.id === selectedAudio.id ? "YES" : "NO"},URI="${hlsAttribute(uri)}"`);
  });
  switchableSubtitles.forEach((track) => {
    const uri = mediaRenditionUrl(req, surface, "subtitles.m3u8", {
      track: track.id,
      playbackToken: req.playbackToken
    });
    lines.push(`#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subtitles",NAME="${hlsAttribute(track.label)}",LANGUAGE="${hlsAttribute(track.language)}",DEFAULT=${track.id === selectedSubtitleId ? "YES" : "NO"},AUTOSELECT=YES,FORCED=${track.forced ? "YES" : "NO"},URI="${hlsAttribute(uri)}"`);
  });
  const subtitleGroup = switchableSubtitles.length > 0 ? ',SUBTITLES="subtitles"' : "";
  lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=12000000,AUDIO="audio"${subtitleGroup}`);
  lines.push(videoPlaylistUrl);
  return lines.join("\n");
}

function mediaRenditionUrl(req, surface, filename, query) {
  const base = `${streamBasePath(surface)}/${encodeURIComponent(req.params.mediaType)}/${encodeURIComponent(req.params.id)}/${filename}`;
  return appendAuthQuery(base, query, streamAuthQuery(req, surface));
}

function appendAuthQuery(url, query, authQuery = null) {
  const params = new URLSearchParams();
  Object.entries(query || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
  });
  if (authQuery) params.set(authQuery.name, authQuery.value);
  const text = params.toString();
  return text ? `${url}?${text}` : url;
}

function hlsAttribute(value) {
  return String(value || "unknown").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
