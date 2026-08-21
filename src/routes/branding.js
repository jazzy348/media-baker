const express = require("express");

module.exports = function createBrandingRoutes({ branding }) {
  const router = express.Router();

  router.get("/manifest.webmanifest", (req, res) => {
    res.set("Cache-Control", "no-cache, must-revalidate");
    res.type("application/manifest+json").send(branding.manifest());
  });

  router.get("/app-icon/:size.png", (req, res, next) => {
    const filePath = branding.currentAsset(req.params.size);
    if (!filePath) {
      res.sendStatus(404);
      return;
    }
    res.set("Cache-Control", "no-cache, must-revalidate");
    sendPng(res, filePath, next);
  });

  router.get("/app-icons/:iconId/:revision/:filename", (req, res, next) => {
    const size = iconSize(req.params.iconId, req.params.filename);
    const filePath = size && branding.asset(req.params.iconId, req.params.revision, size);
    if (!filePath) {
      res.sendStatus(404);
      return;
    }
    res.set("Cache-Control", "public, max-age=31536000, immutable");
    sendPng(res, filePath, next);
  });

  return router;
};

function sendPng(res, filePath, next) {
  res.type("image/png").sendFile(filePath, (err) => {
    if (err && !res.headersSent) next(err);
  });
}

function iconSize(iconId, filename) {
  const match = String(filename || "").match(new RegExp(`^media-baker-${escapeRegExp(iconId)}-(\\d+)\\.png$`));
  return match ? match[1] : null;
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
