const express = require("express");
const path = require("path");
const { httpError, isClientAbort } = require("../utils/httpErrors");

module.exports = function createYtDlpRoutes({ ytdlp, ytdlpRelay, playbackTokens }) {
  const router = express.Router();

  router.use((req, res, next) => {
    if (req.authMode === "share") {
      next(httpError(403, "YT-DLP downloads require a user account."));
      return;
    }
    next();
  });

  router.get("/", async (req, res, next) => {
    try {
      const validation = ytdlp.config.enabled ? await ytdlp.validate() : null;
      res.json({
        ...ytdlp.status(),
        available: validation ? validation.ok : false,
        validation
      });
    } catch (err) {
      next(err);
    }
  });

  router.post("/downloads", async (req, res, next) => {
    try {
      const download = await ytdlp.startDownload(
        req.body && req.body.url,
        req.user && req.user.id || "global",
        {
          live: req.body && req.body.mode === "record",
          subscribeChannel: req.body && req.body.mode === "channel-subscribe"
        }
      );
      res.status(202).json({ download });
    } catch (err) {
      next(err);
    }
  });

  router.get("/downloads", (req, res) => {
    res.json({ downloads: ytdlp.status().downloads });
  });

  router.post("/inspect", async (req, res, next) => {
    try {
      res.json({ media: await ytdlp.inspect(req.body && req.body.url) });
    } catch (err) {
      next(err);
    }
  });

  router.post("/relays", async (req, res, next) => {
    try {
      const inspection = await ytdlp.inspect(req.body && req.body.url);
      if (!inspection.isLive) {
        throw httpError(400, "This URL is not currently a live stream.");
      }
      const relay = await ytdlpRelay.startRelay(
        inspection.url,
        req.user && req.user.id || "global",
        inspection.title
      );
      res.status(202).json({ relay });
    } catch (err) {
      next(err);
    }
  });

  router.post("/relays/:id/copy-token", (req, res, next) => {
    try {
      requireCopyPermission(req);
      const relay = ytdlpRelay.assertAccess(req.params.id, req.user);
      const playbackToken = playbackTokens.createRelayToken(relay.id, req.user.id);
      res.json({
        playbackToken,
        url: relayPlaybackUrl(req, relay.id, playbackToken)
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/relays/:id/master.m3u8", async (req, res, next) => {
    try {
      ytdlpRelay.assertAccess(req.params.id, req.user);
      const playlist = await ytdlpRelay.playlist(req.params.id);
      res.type("application/vnd.apple.mpegurl");
      res.set("Cache-Control", "no-store");
      res.send(rewriteRelayPlaylist(playlist, req.params.id, req.authParamName, req.authToken));
    } catch (err) {
      next(err);
    }
  });

  router.get("/relays/:id/:filename", async (req, res, next) => {
    try {
      ytdlpRelay.assertAccess(req.params.id, req.user);
      const filePath = await ytdlpRelay.streamFile(req.params.id, req.params.filename);
      if (!filePath) {
        next(httpError(404, "Live relay segment not found."));
        return;
      }
      res.type("video/mp2t");
      res.sendFile(filePath, (err) => {
        if (err && !isClientAbort(err)) {
          next(httpError(err.statusCode || 404, "Live relay segment not found."));
        }
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
};

function rewriteRelayPlaylist(playlist, relayId, authParamName, authToken) {
  return String(playlist || "").split(/\r?\n/).map((line) => {
    if (!line.trim() || line.startsWith("#")) return line;
    const filename = path.posix.basename(line.trim());
    return `/api/ytdlp/relays/${encodeURIComponent(relayId)}/${encodeURIComponent(filename)}?${encodeURIComponent(authParamName)}=${encodeURIComponent(authToken)}`;
  }).join("\n");
}

function requireCopyPermission(req) {
  const permissions = req.user && req.user.permissions || {};
  if (!permissions.isAdmin && !permissions.canCopyStreamUrls) {
    throw httpError(403, "Your account cannot copy playback URLs.");
  }
}

function relayPlaybackUrl(req, relayId, playbackToken) {
  const proto = String(req.get("x-forwarded-proto") || req.protocol || "http").split(",")[0].trim();
  const host = req.get("x-forwarded-host") || req.get("host");
  const url = new URL(`/api/relay-streams/${encodeURIComponent(relayId)}/master.m3u8`, `${proto}://${host}`);
  url.searchParams.set("playbackToken", playbackToken);
  return url.toString();
}
