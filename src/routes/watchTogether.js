const express = require("express");
const { createAuthMiddleware, createOptionalAuthMiddleware } = require("../middleware/auth");
const { resolveMediaFile } = require("../services/mediaResolver");
const { getMediaPlaybackOptions } = require("../services/mediaOptions");
const { httpError } = require("../utils/httpErrors");

module.exports = function createWatchTogetherRoutes(services) {
  const {
    accountService, mediaIndex, ffmpeg, subtitles,
    skipDetection, watchTogether
  } = services;
  const router = express.Router();
  const authenticate = createAuthMiddleware(accountService);
  const optionalAuthenticate = createOptionalAuthMiddleware(accountService);

  router.post("/rooms", authenticate, async (req, res, next) => {
    try {
      requireCopyPermission(req);
      const mediaType = String(req.body && req.body.mediaType || "");
      const mediaId = String(req.body && req.body.mediaId || "");
      assertLibraryAccess(req, mediaType);
      const library = mediaIndex.libraryForKey(mediaType);
      if (!library || library.type === "images") throw httpError(400, "This media cannot be watched together");
      const mediaFile = await resolveMediaFile(mediaIndex, mediaType, mediaId);
      const options = await getMediaPlaybackOptions(mediaFile, ffmpeg, { library, subtitles, mediaType });
      const streamOptions = normalizeStreamOptions(req.body || {}, options);
      const markers = library.type === "tv" && skipDetection
        ? await skipDetection.getMarkers(mediaType, mediaFile)
        : [];
      const credits = markers.find((marker) => marker.type === "credits");
      const created = await watchTogether.create({
        user: req.user,
        mediaType,
        mediaFile,
        library,
        streamOptions,
        skipMarkers: markers,
        durationSeconds: Number(mediaFile.durationSeconds || mediaFile.duration) || 0,
        completionStartSeconds: credits && credits.startSeconds
      });
      res.status(201).json({
        ...created,
        inviteUrl: `${requestOrigin(req)}/watch/${encodeURIComponent(created.inviteToken)}`
      });
    } catch (err) {
      next(err);
    }
  });

  router.post("/join", optionalAuthenticate, (req, res, next) => {
    try {
      res.json(watchTogether.join(
        req.body && req.body.inviteToken,
        req.user ? { user: req.user } : null,
        req.body && req.body.name,
        req.body && req.body.clientId
      ));
    } catch (err) {
      next(err);
    }
  });

  return router;
};

function requireCopyPermission(req) {
  const permissions = req.user && req.user.permissions || {};
  if (!req.user || (!permissions.isAdmin && !permissions.canCopyStreamUrls)) {
    throw httpError(403, "Copy stream URL access required");
  }
}

function assertLibraryAccess(req, mediaType) {
  if (req.allowedLibraryKey && req.allowedLibraryKey !== mediaType) throw httpError(403, "Library access denied");
  if (Array.isArray(req.allowedLibraryKeys) && !req.allowedLibraryKeys.includes(mediaType)) throw httpError(403, "Library access denied");
}

function normalizeStreamOptions(body, options) {
  return {
    audio: selectId(options.audio, body.audio, options.audio[0] && options.audio[0].id),
    subtitle: selectId(options.subtitles, body.subtitle, "none"),
    quality: selectId(options.quality, body.quality, "original"),
    audioChannels: ["preserve", "stereo", "surround51", "stabby51"].includes(body.audioChannels)
      ? body.audioChannels
      : "preserve"
  };
}

function selectId(options, requested, fallback) {
  return options.some((option) => option.id === requested) ? requested : fallback;
}

function requestOrigin(req) {
  const protocol = req.get("x-forwarded-proto") || req.protocol;
  return `${protocol}://${req.get("host")}`;
}
