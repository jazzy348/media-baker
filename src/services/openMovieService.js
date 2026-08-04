const logger = require("../utils/logger");

class OpenMovieService {
  constructor(mediaIndex, idStore, metadata) {
    this.mediaIndex = mediaIndex;
    this.idStore = idStore;
    this.metadata = metadata;
    this.syncOperation = Promise.resolve();
  }

  async init() {
    await this.idStore.init();
    await this.sync();
  }

  async sync(libraryKey = null) {
    const task = this.syncOperation.then(() => this.syncLibraries(libraryKey));
    this.syncOperation = task.catch(() => {});
    return task;
  }

  async movieCatalogue(allowedLibraryKeys = null) {
    await this.syncOperation;
    const libraries = this.mediaLibraries(allowedLibraryKeys).filter((library) => library.type === "movies");
    const records = await this.collectMedia(libraries);
    const ids = mappingMap(await this.idStore.mappings("movie"));
    const movies = records.movies
      .map(({ library, item }) => {
        const id = ids.get(mappingKey(library.key, item.id));
        return id ? { id, library, item } : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.id - b.id);
    const metadata = await this.cachedMetadata(movies.map(({ library, item }) => ({
      mediaType: library.key,
      id: item.id
    })));

    return movies.map(({ id, library, item }) => {
      const record = metadata.get(mappingKey(library.key, item.id));
      return {
        id,
        library: library.key,
        libraryTitle: library.title,
        title: metadataTitle(record, item.title),
        originalTitle: item.title,
        year: metadataYear(record, item.year),
        overview: metadataOverview(record),
        aliases: metadataAliases(record),
        provider: metadataValue(record, "provider"),
        providerId: metadataValue(record, "providerId"),
        posterUrl: `/api/openmovie/movies/${id}/poster`,
        playbackUrl: `/api/openmovie/movies/${id}/play`
      };
    });
  }

  async tvCatalogue(allowedLibraryKeys = null) {
    await this.syncOperation;
    const libraries = this.mediaLibraries(allowedLibraryKeys).filter((library) => library.type === "tv");
    const records = await this.collectMedia(libraries);
    const ids = mappingMap(await this.idStore.mappings("episode"));
    const metadataRefs = [];
    for (const { library, show } of records.shows) {
      metadataRefs.push({ mediaType: library.key, id: show.id });
      for (const episode of showEpisodes(show)) {
        metadataRefs.push({ mediaType: library.key, id: episode.id });
      }
    }
    const metadata = await this.cachedMetadata(metadataRefs);
    const seasonMetadataByShow = this.metadata && this.metadata.getCachedSeasonMetadataForShows
      ? await this.metadata.getCachedSeasonMetadataForShows(records.shows.map(({ library, show }) => ({
        mediaType: library.key,
        show
      })))
      : new Map();

    const shows = records.shows.map(({ library, show }) => {
      const seasonMetadata = seasonMetadataByShow.get(mappingKey(library.key, show.id)) || new Map();
      const seasons = (show.seasons || []).map((season) => {
        const episodes = (season.episodes || [])
          .map((episode) => openMovieEpisode(library, episode, ids, metadata))
          .filter(Boolean);
        const details = seasonMetadata.get(Number(season.season)) || {};
        return {
          season: numberOrNull(season.season),
          title: details.name || season.name || defaultSeasonName(season.season),
          overview: details.overview || "",
          airDate: details.airDate || null,
          year: numberOrNull(details.year),
          episodeCount: episodes.length,
          providerId: details.providerId || null,
          posterUrl: episodes.length > 0 ? `/api/openmovie/episodes/${episodes[0].id}/season-poster` : null,
          episodes
        };
      });
      const episodes = seasons.flatMap((season) => season.episodes);
      const showRecord = metadata.get(mappingKey(library.key, show.id))
        || firstAvailableMetadata(show, library, metadata);
      return {
        library: library.key,
        libraryTitle: library.title,
        title: metadataTitle(showRecord, show.name),
        originalTitle: show.name,
        year: metadataYear(showRecord, null),
        overview: metadataOverview(showRecord),
        aliases: metadataAliases(showRecord),
        provider: metadataValue(showRecord, "provider"),
        providerId: metadataValue(showRecord, "providerId"),
        posterUrl: episodes.length > 0 ? `${episodes[0].posterUrl}?art=show` : null,
        episodeCount: episodes.length,
        seasons
      };
    });
    return shows.sort((a, b) => a.title.localeCompare(b.title) || a.library.localeCompare(b.library));
  }

  async resolve(kind, id, allowedLibraryKeys = null) {
    await this.syncOperation;
    const mapping = await this.idStore.resolve(kind, id);
    if (!mapping || !canAccessLibrary(mapping.libraryKey, allowedLibraryKeys)) return null;
    const library = this.mediaIndex.libraryForKey(mapping.libraryKey);
    if (!library) return null;

    const item = kind === "episode"
      ? library.type === "tv" && await this.mediaIndex.getEpisode(mapping.mediaId, mapping.libraryKey)
      : library.type === "movies" && await this.mediaIndex.getMovie(mapping.mediaId, mapping.libraryKey);
    return item ? { id: mapping.id, library, item } : null;
  }

  async syncLibraries(libraryKey) {
    const libraries = this.mediaLibraries(null).filter((library) => !libraryKey || library.key === libraryKey);
    if (libraries.length === 0) return;
    const records = await this.collectMedia(libraries);
    await this.idStore.sync(
      records.movies.map(({ library, item }) => ({ libraryKey: library.key, mediaId: item.id })),
      records.episodes.map(({ library, item }) => ({ libraryKey: library.key, mediaId: item.id }))
    );
    logger.full(
      `[openmovie] ID registry synchronised libraries=${libraries.length} `
      + `movies=${records.movies.length} episodes=${records.episodes.length}`
    );
  }

  mediaLibraries(allowedLibraryKeys) {
    return this.mediaIndex.config.libraries.filter((library) => (
      (library.type === "movies" || library.type === "tv")
      && canAccessLibrary(library.key, allowedLibraryKeys)
    ));
  }

  async collectMedia(libraries) {
    const movies = [];
    const episodes = [];
    const shows = [];
    for (const library of libraries) {
      const collection = await this.mediaIndex.loadCollection(library.key, library.type);
      if (library.type === "movies") {
        for (const item of collection.items || []) movies.push({ library, item });
        continue;
      }
      for (const show of collection.shows || []) {
        shows.push({ library, show });
        for (const item of showEpisodes(show)) episodes.push({ library, item });
      }
    }
    return { movies, episodes, shows };
  }

  async cachedMetadata(refs) {
    if (!this.metadata || !this.metadata.getCachedForMediaItems || refs.length === 0) return new Map();
    return this.metadata.getCachedForMediaItems(uniqueMetadataRefs(refs));
  }
}

function openMovieEpisode(library, episode, ids, metadata) {
  const id = ids.get(mappingKey(library.key, episode.id));
  if (!id) return null;
  const record = metadata.get(mappingKey(library.key, episode.id));
  return {
    id,
    season: numberOrNull(episode.season),
    episode: numberOrNull(episode.episode),
    title: episode.title,
    overview: metadataOverview(record),
    provider: metadataValue(record, "provider"),
    providerId: metadataValue(record, "providerId"),
    posterUrl: `/api/openmovie/episodes/${id}/poster`,
    playbackUrl: `/api/openmovie/episodes/${id}/play`
  };
}

function defaultSeasonName(seasonNumber) {
  return Number(seasonNumber) === 0 ? "Specials" : `Season ${seasonNumber}`;
}

function showEpisodes(show) {
  return (show.seasons || [])
    .flatMap((season) => season.episodes || [])
    .sort((a, b) => (
      (Number(a.season) || 0) - (Number(b.season) || 0)
      || (Number(a.episode) || 0) - (Number(b.episode) || 0)
      || String(a.title || "").localeCompare(String(b.title || ""))
    ));
}

function mappingMap(mappings) {
  return new Map(mappings.map((mapping) => [mappingKey(mapping.libraryKey, mapping.mediaId), mapping.id]));
}

function mappingKey(libraryKey, mediaId) {
  return `${libraryKey}:${mediaId}`;
}

function canAccessLibrary(libraryKey, allowedLibraryKeys) {
  return !Array.isArray(allowedLibraryKeys) || allowedLibraryKeys.includes(libraryKey);
}

function uniqueMetadataRefs(refs) {
  return [...new Map(refs.map((ref) => [mappingKey(ref.mediaType, ref.id), ref])).values()];
}

function metadataTitle(record, fallback) {
  return record && record.available && record.title || fallback || "Untitled";
}

function metadataYear(record, fallback) {
  return numberOrNull(record && record.available && record.releaseYear) || numberOrNull(fallback);
}

function metadataOverview(record) {
  return record && record.available && record.overview || "";
}

function metadataAliases(record) {
  return record && record.available && Array.isArray(record.aliases) ? record.aliases : [];
}

function metadataValue(record, key) {
  return record && record.available && record[key] !== undefined ? record[key] : null;
}

function numberOrNull(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function firstAvailableMetadata(show, library, metadata) {
  for (const episode of showEpisodes(show)) {
    const record = metadata.get(mappingKey(library.key, episode.id));
    if (record && record.available) return record;
  }
  return null;
}

module.exports = { OpenMovieService };
