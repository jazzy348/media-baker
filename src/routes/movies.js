const express = require("express");
const { httpError } = require("../utils/httpErrors");

module.exports = function createMovieRoutes({ mediaIndex }, options = {}) {
  const router = express.Router();
  const collection = options.collection || "movies";
  const notFoundName = options.notFoundName || "Movie";

  router.get("/", (req, res) => {
    res.json({
      generatedAt: mediaIndex.index.generatedAt,
      movies: mediaIndex.listMovies(collection)
    });
  });

  router.post("/reindex", async (req, res, next) => {
    try {
      await mediaIndex.reindex();
      res.json({
        generatedAt: mediaIndex.index.generatedAt,
        movies: mediaIndex.listMovies(collection)
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/:movieId", (req, res, next) => {
    const movie = mediaIndex.getMovie(req.params.movieId, collection);
    if (!movie) {
      return next(httpError(404, `${notFoundName} not found`));
    }

    res.json(movie);
  });

  return router;
};
