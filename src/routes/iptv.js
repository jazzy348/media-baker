const express = require("express");
const path = require("path");
const { httpError, isClientAbort } = require("../utils/httpErrors");
const logger = require("../utils/logger");
const LIVE_TV_PERMISSION_KEY = "@live-tv";

module.exports = function createIptvRoutes({ config, iptv }) {
  const router = express.Router();

  router.use((req, res, next) => {
    if (!req.user || req.authMode === "share") {
      next(httpError(403, "IPTV requires a user account"));
      return;
    }
    if (!config.iptv.enabled) {
      next(httpError(404, "IPTV is not enabled"));
      return;
    }
    const permissions = req.user.permissions || {};
    if (req.authMode !== "admin" && !(permissions.libraries || []).includes(LIVE_TV_PERMISSION_KEY)) {
      next(httpError(403, "Live TV access is required"));
      return;
    }
    next();
  });

  router.get("/", (req, res) => {
    res.json(iptv.status());
  });

  router.get("/guide", async (req, res, next) => {
    try {
      if (!iptv.status().ready) {
        await iptv.refresh();
      }
      res.json(guideResponse(iptv.guide(req.query.start, req.query.hours), req.authParamName, req.authToken));
    } catch (err) {
      next(err);
    }
  });

  router.post("/client-events", (req, res) => {
    const event = String(req.body && req.body.event || "client-event").slice(0, 80);
    const channelId = String(req.body && req.body.channelId || "unknown").slice(0, 80);
    const channelName = String(req.body && req.body.channelName || "unknown").slice(0, 160);
    const details = safeClientDetails(req.body && req.body.details);
    logger.error(`[iptv] client ${event} channelId=${channelId} channel="${channelName}" details=${details}`);
    res.json({ ok: true });
  });

  router.get("/icons/:filename", async (req, res, next) => {
    try {
      const filePath = await iptv.iconFile(req.params.filename);
      if (!filePath) {
        next(httpError(404, "IPTV channel icon not found"));
        return;
      }
      res.set("Cache-Control", "private, max-age=86400");
      res.sendFile(filePath, (err) => {
        if (err && !isClientAbort(err)) {
          next(httpError(err.statusCode || 404, "IPTV channel icon not found"));
        }
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/channels/:id/master.m3u8", async (req, res, next) => {
    try {
      const playlist = await iptv.playlist(req.params.id);
      res.type("application/vnd.apple.mpegurl");
      res.set("Cache-Control", "no-store");
      res.send(rewritePlaylist(playlist, req.params.id, req.authParamName, req.authToken));
    } catch (err) {
      next(err);
    }
  });

  router.get("/channels/:id/:filename", async (req, res, next) => {
    try {
      const filePath = await iptv.streamFile(req.params.id, req.params.filename);
      if (!filePath) {
        next(httpError(404, "IPTV segment not found"));
        return;
      }
      res.type(contentTypeFor(req.params.filename));
      res.sendFile(filePath, (err) => {
        if (err && !isClientAbort(err)) {
          next(httpError(err.statusCode || 404, "IPTV segment not found"));
        }
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
};

function guideResponse(guide, authParamName, authToken) {
  return {
    ...guide,
    channels: guide.channels.map((channel) => {
      const { logoFilename, ...output } = channel;
      return {
        ...output,
        logo: logoFilename
          ? `/api/iptv/icons/${encodeURIComponent(logoFilename)}?${encodeURIComponent(authParamName)}=${encodeURIComponent(authToken)}`
          : null
      };
    })
  };
}

function rewritePlaylist(playlist, channelId, authParamName, authToken) {
  return playlist.split(/\r?\n/).map((line) => {
    if (!line.trim() || line.startsWith("#")) {
      return line;
    }
    const filename = path.posix.basename(line.trim());
    return `/api/iptv/channels/${encodeURIComponent(channelId)}/${encodeURIComponent(filename)}?${encodeURIComponent(authParamName)}=${encodeURIComponent(authToken)}`;
  }).join("\n");
}

function contentTypeFor(filename) {
  return path.extname(filename).toLowerCase() === ".ts" ? "video/mp2t" : "application/octet-stream";
}

function safeClientDetails(value) {
  try {
    return JSON.stringify(value || {}).slice(0, 1000);
  } catch (err) {
    return "{}";
  }
}
