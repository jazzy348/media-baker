const express = require("express");
const { httpError } = require("../utils/httpErrors");

function createFallbackRoutes({ fallbackStream }) {
  const router = express.Router();

  router.get("/master.m3u8", serveFallback);
  router.get("/:segment", serveFallback);

  async function serveFallback(req, res, next) {
    try {
      if (!fallbackStream || !fallbackStream.ready) {
        next(httpError(503, "Fallback stream is not available"));
        return;
      }
      await fallbackStream.serve(req, res, 200, true, "/api/fallback");
    } catch (err) {
      next(err);
    }
  }

  return router;
}

function createFallbackSegmentRoutes({ fallbackStream }) {
  const router = express.Router();

  router.get(/^\/__stream_error_\d{5}\.ts$/, async (req, res, next) => {
    try {
      if (!fallbackStream || !fallbackStream.ready) {
        next(httpError(503, "Fallback stream is not available"));
        return;
      }
      await fallbackStream.serve(req, res, 200, false, "/api/fallback");
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = createFallbackRoutes;
module.exports.createFallbackSegmentRoutes = createFallbackSegmentRoutes;
