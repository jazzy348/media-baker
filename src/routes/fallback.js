const express = require("express");
const { httpError } = require("../utils/httpErrors");

module.exports = function createFallbackRoutes({ fallbackStream }) {
  const router = express.Router();

  router.get("/master.m3u8", serveFallback);
  router.get("/:segment", serveFallback);

  async function serveFallback(req, res, next) {
    try {
      if (!fallbackStream || !fallbackStream.ready) {
        next(httpError(503, "Fallback stream is not available"));
        return;
      }
      await fallbackStream.serve(req, res);
    } catch (err) {
      next(err);
    }
  }

  return router;
};
