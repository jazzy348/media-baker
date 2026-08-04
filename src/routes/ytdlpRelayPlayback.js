const express = require("express");
const path = require("path");
const { httpError, isClientAbort } = require("../utils/httpErrors");

module.exports = function createYtDlpRelayPlaybackRoutes({ ytdlpRelay }) {
  const router = express.Router();

  router.use("/:id", (req, res, next) => {
    const payload = req.playbackTokenPayload;
    if (!payload || payload.scope !== "relay-hls" || payload.relayId !== req.params.id) {
      next(httpError(403, "Invalid live relay playback token."));
      return;
    }
    next();
  });

  router.get("/:id/master.m3u8", async (req, res, next) => {
    try {
      const playlist = await ytdlpRelay.playlist(req.params.id);
      res.type("application/vnd.apple.mpegurl");
      res.set("Cache-Control", "no-store");
      res.send(rewritePlaylist(playlist, req.params.id, req.playbackToken));
    } catch (err) {
      next(err);
    }
  });

  router.get("/:id/:filename", async (req, res, next) => {
    try {
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

function rewritePlaylist(playlist, relayId, playbackToken) {
  return String(playlist || "").split(/\r?\n/).map((line) => {
    if (!line.trim() || line.startsWith("#")) return line;
    const filename = path.posix.basename(line.trim());
    return `/api/relay-streams/${encodeURIComponent(relayId)}/${encodeURIComponent(filename)}?playbackToken=${encodeURIComponent(playbackToken)}`;
  }).join("\n");
}
