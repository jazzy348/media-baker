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

  if (library.type === "music") {
    const track = await mediaIndex.getTrackOrReindex(id, library.key);
    if (!track) {
      throw httpError(404, `${library.title} track not found`);
    }
    return track;
  }

  if (library.type === "images") {
    const image = await mediaIndex.getImage(id, library.key);
    if (!image) {
      await mediaIndex.reindexLibrary(library.key);
    }
    const resolved = image || await mediaIndex.getImage(id, library.key);
    if (!resolved) {
      throw httpError(404, `${library.title} image not found`);
    }
    return resolved;
  }

  const movie = await mediaIndex.getMovieOrReindex(id, library.key);
  if (!movie) {
    throw httpError(404, `${library.title} item not found`);
  }

  return movie;
}

module.exports = { resolveMediaFile };
