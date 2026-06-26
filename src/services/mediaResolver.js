const { httpError } = require("../utils/httpErrors");

async function resolveMediaFile(mediaIndex, mediaType, id) {
  const library = mediaIndex.libraryForKey(mediaType);
  if (!library) {
    throw httpError(400, `Unknown mediaType: ${mediaType}`);
  }

  if (library.type === "tv") {
    const episode = await mediaIndex.getEpisodeOrReindex(id, library.key);
    if (!episode) {
      const item = await mediaIndex.getMovieOrReindex(id, library.key);
      if (item) {
        return item;
      }

      throw httpError(404, `${library.title} item not found`);
    }

    return episode;
  }

  const movie = await mediaIndex.getMovieOrReindex(id, library.key);
  if (!movie) {
    throw httpError(404, `${library.title} item not found`);
  }

  return movie;
}

module.exports = { resolveMediaFile };
