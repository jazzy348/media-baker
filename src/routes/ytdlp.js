const express = require("express");
const { httpError } = require("../utils/httpErrors");

module.exports = function createYtDlpRoutes({ ytdlp }) {
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
      const download = await ytdlp.startDownload(req.body && req.body.url, req.user && req.user.id || "global");
      res.status(202).json({ download });
    } catch (err) {
      next(err);
    }
  });

  router.get("/downloads", (req, res) => {
    res.json({ downloads: ytdlp.status().downloads });
  });

  return router;
};
