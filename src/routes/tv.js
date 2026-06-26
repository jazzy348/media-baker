const express = require("express");
const { httpError } = require("../utils/httpErrors");

module.exports = function createTvRoutes({ mediaIndex }, options = {}) {
  const router = express.Router();
  const collection = options.collection || "tv";
  const notFoundName = options.notFoundName || "TV";

  router.get("/", (req, res) => {
    res.json({
      generatedAt: mediaIndex.index.generatedAt,
      shows: mediaIndex.listShows(collection)
    });
  });

  router.post("/reindex", async (req, res, next) => {
    try {
      await mediaIndex.reindex();
      res.json({
        generatedAt: mediaIndex.index.generatedAt,
        shows: mediaIndex.listShows(collection)
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/:showId", (req, res, next) => {
    const show = mediaIndex.getShow(req.params.showId, collection);
    if (!show) {
      return next(httpError(404, `${notFoundName} show not found`));
    }

    res.json(show);
  });

  router.get("/:showId/seasons/:seasonNumber", (req, res, next) => {
    const season = mediaIndex.getSeason(req.params.showId, req.params.seasonNumber, collection);
    if (!season) {
      return next(httpError(404, `${notFoundName} season not found`));
    }

    res.json(season);
  });

  return router;
};
