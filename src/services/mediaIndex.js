const fs = require("fs/promises");
const path = require("path");
const { createId, isAudioFile, isImageFile, isVideoFile, parseEpisodeFile, parseMovieFolder, parseMusicFile } = require("../utils/mediaParsers");
const logger = require("../utils/logger");

class MediaIndex {
  constructor(config, indexStore) {
    this.config = config;
    this.indexStore = indexStore;
    this.databaseBacked = indexStore.type === "mysql";
    this.index = this.emptyIndex();
    this.reindexInFlight = null;
    this.libraryReindexInFlight = new Map();
    this.libraryReindexPending = new Set();
  }

  emptyIndex() {
    const index = {
      generatedAt: null,
      libraries: this.config.libraries.map((library) => ({
        key: library.key,
        title: library.title,
        type: library.type,
        rawType: library.rawType,
        threeD: Boolean(library.threeD),
        managed: Boolean(library.managed),
        noMetadata: Boolean(library.noMetadata),
        noSubtitles: Boolean(library.noSubtitles),
        localThumbnails: Boolean(library.localThumbnails),
        path: library.path
      }))
    };

    if (!this.databaseBacked) {
      for (const library of this.config.libraries) {
        index[library.key] = emptyCollection(library.type);
      }
    }

    return index;
  }

  async load() {
    const storedIndex = await this.indexStore.load();
    if (!storedIndex) {
      await this.reindex();
      return;
    }

    this.index = storedIndex;
    if (this.hasLibraryConfigChanged()) {
      logger.info("[index] library config changed; reindexing");
      await this.reindex();
      return;
    }

    if (!this.hasIndexedFileTimestamps()) {
      logger.info("[index] file timestamps missing; reindexing");
      await this.reindex();
    }
  }

  async reindex() {
    if (this.reindexInFlight) {
      return this.reindexInFlight;
    }

    this.reindexInFlight = this.buildIndex();
    try {
      return await this.reindexInFlight;
    } finally {
      this.reindexInFlight = null;
    }
  }

  async syncLibrariesFromConfig() {
    const nextLibraries = this.emptyIndex().libraries;
    const nextKeys = new Set(nextLibraries.map((library) => library.key));
    const previousKeys = new Set((this.index.libraries || []).map((library) => library.key));

    this.index.libraries = nextLibraries;
    if (!this.databaseBacked) {
      for (const library of this.config.libraries) {
        if (!this.index[library.key]) {
          this.index[library.key] = emptyCollection(library.type);
        }
      }
      for (const key of previousKeys) {
        if (!nextKeys.has(key)) {
          delete this.index[key];
        }
      }
    }

    if (this.databaseBacked) {
      this.index.generatedAt = this.index.generatedAt || new Date().toISOString();
      await this.indexStore.saveMeta(this.index);
    } else {
      await this.indexStore.save(this.index);
    }
    return this.index;
  }

  async buildIndex() {
    const nextIndex = this.emptyIndex();
    nextIndex.generatedAt = new Date().toISOString();
    for (const library of this.config.libraries) {
      nextIndex[library.key] = await this.scanLibrary(library);
    }

    await this.indexStore.save(nextIndex);
    this.index = this.databaseBacked ? indexMeta(nextIndex) : nextIndex;
    return this.index;
  }

  async reindexLibrary(libraryKey) {
    if (this.libraryReindexInFlight.has(libraryKey)) {
      this.libraryReindexPending.add(libraryKey);
      return this.libraryReindexInFlight.get(libraryKey);
    }

    const inFlight = this.runLibraryReindexLoop(libraryKey);
    this.libraryReindexInFlight.set(libraryKey, inFlight);
    try {
      return await inFlight;
    } finally {
      this.libraryReindexInFlight.delete(libraryKey);
    }
  }

  async runLibraryReindexLoop(libraryKey) {
    do {
      this.libraryReindexPending.delete(libraryKey);
      await this.buildLibraryIndex(libraryKey);
    } while (this.libraryReindexPending.has(libraryKey));
    return this.index;
  }

  async buildLibraryIndex(libraryKey) {
    const library = this.config.libraries.find((entry) => entry.key === libraryKey);
    if (!library) {
      throw new Error(`Library not found: ${libraryKey}`);
    }

    const collection = await this.scanLibrary(library);
    this.index.libraries = this.emptyIndex().libraries;
    this.index.generatedAt = new Date().toISOString();
    if (this.databaseBacked) {
      await this.indexStore.saveLibrary(library, collection, this.index);
    } else {
      this.index[library.key] = collection;
      await this.indexStore.save(this.index);
    }
    return this.index;
  }

  async listShows(collection = "tv", loadedCollection = null) {
    return (loadedCollection || await this.loadCollection(collection, "tv")).shows.map((show) => ({
      id: show.id,
      name: show.name,
      seasons: show.seasons.map((season) => ({
        season: season.season,
        episodeCount: season.episodes.length
      }))
    }));
  }

  async getShow(showId, collection = "tv") {
    if (this.databaseBacked) {
      return this.indexStore.getShow(collection, showId);
    }
    return this.collection(collection, "tv").shows.find((show) => show.id === showId) || null;
  }

  async getSeason(showId, seasonNumber, collection = "tv") {
    if (this.databaseBacked) {
      return this.indexStore.getSeason(collection, showId, seasonNumber);
    }
    const show = await this.getShow(showId, collection);
    if (!show) {
      return null;
    }

    return show.seasons.find((season) => season.season === Number.parseInt(seasonNumber, 10)) || null;
  }

  async listMovies(collection = "movies", loadedCollection = null) {
    return (loadedCollection || await this.loadCollection(collection, "movies")).items.map(({ filePath, ...movie }) => movie);
  }

  async listImages(collection, loadedCollection = null) {
    return (loadedCollection || await this.loadCollection(collection, "images")).items.map(({ filePath, ...image }) => image);
  }

  async getMovie(movieId, collection = "movies") {
    const library = this.libraryForKey(collection);
    if (!library) {
      return null;
    }

    if (this.databaseBacked) {
      return this.indexStore.getMovie(collection, movieId);
    }
    const indexedCollection = this.index[collection] || emptyCollection(library.type);
    return indexedCollection.byId && indexedCollection.byId[movieId] || null;
  }

  async getImage(imageId, collection) {
    return this.getMovie(imageId, collection);
  }

  async getEpisode(episodeId, collection = "tv") {
    if (this.databaseBacked) {
      return this.indexStore.getEpisode(collection, episodeId);
    }
    return this.collection(collection, "tv").episodesById[episodeId] || null;
  }

  async listArtists(collection, loadedCollection = null) {
    return (loadedCollection || await this.loadCollection(collection, "music")).artists.map((artist) => ({
      id: artist.id,
      name: artist.name,
      albums: artist.albums.map((album) => ({
        id: album.id,
        name: album.name,
        year: album.year,
        trackCount: album.tracks.length
      }))
    }));
  }

  async getArtist(artistId, collection) {
    if (this.databaseBacked) {
      return this.indexStore.getArtist(collection, artistId);
    }
    return this.collection(collection, "music").artists.find((artist) => artist.id === artistId) || null;
  }

  async getAlbum(artistId, albumId, collection) {
    if (this.databaseBacked) {
      return this.indexStore.getAlbum(collection, artistId, albumId);
    }
    const artist = await this.getArtist(artistId, collection);
    return artist ? artist.albums.find((album) => album.id === albumId) || null : null;
  }

  async getTrack(trackId, collection) {
    if (this.databaseBacked) {
      return this.indexStore.getTrack(collection, trackId);
    }
    return this.collection(collection, "music").tracksById[trackId] || null;
  }

  async getTrackOrReindex(trackId, collection) {
    let track = await this.getTrack(trackId, collection);
    if (track) {
      return track;
    }
    await this.reindex();
    return this.getTrack(trackId, collection);
  }

  async nextPlayable(collection, mediaId) {
    const library = this.libraryForKey(collection);
    if (!library) {
      return null;
    }
    if (library.type === "music") {
      const track = await this.getTrack(mediaId, collection);
      const album = track && await this.getAlbum(track.artistId, track.albumId, collection);
      const index = album ? album.tracks.findIndex((entry) => entry.id === mediaId) : -1;
      return index >= 0 ? album.tracks[index + 1] || null : null;
    }
    if (library.type === "tv") {
      const episode = await this.getEpisode(mediaId, collection);
      const season = episode && await this.getSeason(episode.showId, episode.season, collection);
      const index = season ? season.episodes.findIndex((entry) => entry.id === mediaId) : -1;
      return index >= 0 ? season.episodes[index + 1] || null : null;
    }
    return null;
  }

  async getEpisodeOrReindex(episodeId, collection = "tv") {
    let episode = await this.getEpisode(episodeId, collection);
    if (episode) {
      return episode;
    }

    await this.reindex();
    return this.getEpisode(episodeId, collection);
  }

  async getMovieOrReindex(movieId, collection = "movies") {
    let movie = await this.getMovie(movieId, collection);
    if (movie) {
      return movie;
    }

    await this.reindex();
    return this.getMovie(movieId, collection);
  }

  hasLibraryConfigChanged() {
    return JSON.stringify(this.index.libraries || null) !== JSON.stringify(this.emptyIndex().libraries);
  }

  hasIndexedFileTimestamps() {
    if (this.databaseBacked) {
      return true;
    }
    for (const library of this.config.libraries) {
      const collection = this.index[library.key];
      if (!collection) {
        continue;
      }

      if (library.type === "tv") {
        if (!Array.isArray(collection.items) || !collection.byId) {
          return false;
        }
        const episodes = Object.values(collection.episodesById || {});
        const items = collection.items || [];
        if (episodes.some((episode) => !Number.isFinite(Number(episode.addedAtMs)))
          || items.some((movie) => !Number.isFinite(Number(movie.addedAtMs)))) {
          return false;
        }
        continue;
      }

      if (library.type === "music") {
        const tracks = Object.values(collection.tracksById || {});
        if (!Array.isArray(collection.artists) || !collection.tracksById
          || tracks.some((track) => !Number.isFinite(Number(track.addedAtMs)))) {
          return false;
        }
        continue;
      }

      const movies = collection.items || [];
      if (movies.some((movie) => !Number.isFinite(Number(movie.addedAtMs)))) {
        return false;
      }
    }

    return true;
  }

  libraryForKey(key) {
    return this.config.libraries.find((library) => library.key === key) || null;
  }

  collection(key, expectedType = null) {
    const library = this.libraryForKey(key);
    if (!library || expectedType && library.type !== expectedType) {
      return emptyCollection(expectedType || "movies");
    }

    return this.index[key] || emptyCollection(library.type);
  }

  async loadCollection(key, expectedType = null) {
    const library = this.libraryForKey(key);
    if (!library || expectedType && library.type !== expectedType) {
      return emptyCollection(expectedType || "movies");
    }
    if (this.databaseBacked) {
      return this.indexStore.loadCollection(key, library.type);
    }
    return this.collection(key, expectedType);
  }

  async searchCollection(key, query, metadataIds = [], limit = 240) {
    const library = this.libraryForKey(key);
    if (!library) {
      return emptyCollection("movies");
    }
    if (this.databaseBacked && String(query || "").trim()) {
      return this.indexStore.searchCollection(key, library.type, query, metadataIds, limit);
    }
    return this.loadCollection(key, library.type);
  }

  async snapshot() {
    return this.databaseBacked ? this.indexStore.loadSnapshot() : this.index;
  }

  async updateLibraryOrder() {
    this.index.libraries = this.emptyIndex().libraries;
    if (this.databaseBacked) {
      await this.indexStore.saveMeta(this.index);
    } else {
      await this.indexStore.save(this.index);
    }
    return this.index.libraries;
  }

  async counts() {
    if (this.databaseBacked) {
      return this.indexStore.getGeneratedCounts();
    }
    return Object.fromEntries(this.config.libraries.map((library) => {
      const collection = this.collection(library.key, library.type);
      const count = library.type === "tv"
        ? Object.keys(collection.episodesById || {}).length + (collection.items || []).length
        : library.type === "music"
          ? Object.keys(collection.tracksById || {}).length
          : (collection.items || []).length;
      return [library.key, count];
    }));
  }

  async scanLibrary(library) {
    if (library.type === "tv") {
      return this.scanTvLibrary(library.path);
    }
    if (library.type === "music") {
      return this.scanMusicLibrary(library.path);
    }
    if (library.type === "images") {
      return this.scanImageLibrary(library.path);
    }
    return this.scanMovieLibrary(library.path);
  }

  async scanTvLibrary(libraryPath) {
    const showsByKey = new Map();
    const items = [];
    const byId = {};
    const episodesById = {};
    const videoFiles = await this.findVideoFiles(libraryPath);
    const filesPerDir = countFilesPerDirectory(videoFiles);

    for (const filePath of videoFiles) {
      const parsed = parseEpisodeFile(filePath);
      const id = createId(filePath);
      const fileStats = await this.fileStats(filePath);
      if (!Number.isFinite(parsed.season) || !Number.isFinite(parsed.episode)) {
        const movie = await this.movieItem(libraryPath, filePath, filesPerDir.get(path.dirname(filePath)) || 0, fileStats);
        items.push(movie);
        byId[movie.id] = movie;
        continue;
      }

      const showName = showNameForEpisode(libraryPath, filePath, parsed);
      const showId = createId(showName);
      const seasonNumber = parsed.season || this.parseSeasonFolder(path.basename(path.dirname(filePath)));
      const episode = {
        id,
        showId,
        showName,
        season: seasonNumber,
        episode: parsed.episode,
        title: parsed.title,
        filename: path.basename(filePath),
        filePath,
        addedAtMs: fileStats.addedAtMs,
        mtimeMs: fileStats.mtimeMs
      };
      episodesById[id] = episode;
      addEpisodeToShow(showsByKey, libraryPath, filePath, episode);
    }

    return {
      shows: [...showsByKey.values()].map((show) => ({
        ...show,
        seasons: mergeDuplicateSeasons(show.seasons).sort((a, b) => a.season - b.season)
      })).sort((a, b) => a.name.localeCompare(b.name)),
      items: items.sort((a, b) => a.title.localeCompare(b.title) || (a.year || 0) - (b.year || 0)),
      byId,
      episodesById
    };
  }

  async scanMovieLibrary(libraryPath) {
    const items = [];
    const byId = {};
    const videoFiles = await this.findVideoFiles(libraryPath);
    const filesPerDir = countFilesPerDirectory(videoFiles);

    for (const filePath of videoFiles) {
      const parsed = parseMovieFile(libraryPath, filePath, filesPerDir.get(path.dirname(filePath)) || 0);
      const id = createId(filePath);
      const fileStats = await this.fileStats(filePath);
      const movie = movieItemFromParsed(filePath, libraryPath, parsed, fileStats);

      items.push(movie);
      byId[id] = movie;
    }

    return {
      items: items.sort((a, b) => a.title.localeCompare(b.title) || (a.year || 0) - (b.year || 0)),
      byId
    };
  }

  async scanMusicLibrary(libraryPath) {
    const artistsById = new Map();
    const tracksById = {};
    const audioFiles = await this.findMediaFiles(libraryPath, isAudioFile);

    for (const filePath of audioFiles) {
      const parsed = parseMusicFile(libraryPath, filePath);
      const stats = await this.fileStats(filePath);
      const artistId = createId(`artist:${parsed.artist}`);
      const albumId = createId(`album:${parsed.artist}:${parsed.album}:${parsed.year || ""}`);
      const track = {
        id: createId(filePath),
        artistId,
        artistName: parsed.artist,
        albumId,
        albumName: parsed.album,
        year: parsed.year,
        disc: parsed.disc,
        track: parsed.track,
        title: parsed.title,
        filename: path.basename(filePath),
        filePath,
        addedAtMs: stats.addedAtMs,
        mtimeMs: stats.mtimeMs
      };
      tracksById[track.id] = track;

      let artist = artistsById.get(artistId);
      if (!artist) {
        artist = { id: artistId, name: parsed.artist, path: artistPath(libraryPath, filePath), albums: [] };
        artistsById.set(artistId, artist);
      }
      let album = artist.albums.find((entry) => entry.id === albumId);
      if (!album) {
        album = { id: albumId, name: parsed.album, year: parsed.year, path: path.dirname(filePath), tracks: [] };
        artist.albums.push(album);
      }
      album.tracks.push(track);
    }

    const artists = [...artistsById.values()]
      .map((artist) => ({
        ...artist,
        albums: artist.albums
          .map((album) => ({ ...album, tracks: album.tracks.sort(sortTracks) }))
          .sort((a, b) => (a.year || 0) - (b.year || 0) || a.name.localeCompare(b.name))
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { artists, tracksById };
  }

  async scanImageLibrary(libraryPath) {
    const items = [];
    const byId = {};
    const imageFiles = await this.findMediaFiles(libraryPath, isImageFile);
    for (const filePath of imageFiles) {
      const stats = await this.fileStats(filePath);
      const relativePath = path.relative(libraryPath, filePath);
      const image = {
        id: createId(filePath),
        title: path.basename(filePath, path.extname(filePath)),
        filename: path.basename(filePath),
        folder: path.dirname(relativePath) === "." ? "" : path.dirname(relativePath),
        relativePath,
        filePath,
        addedAtMs: stats.addedAtMs,
        mtimeMs: stats.mtimeMs
      };
      items.push(image);
      byId[image.id] = image;
    }
    return {
      items: items.sort((a, b) => a.title.localeCompare(b.title) || a.relativePath.localeCompare(b.relativePath)),
      byId
    };
  }

  async findVideoFiles(dirPath) {
    return this.findMediaFiles(dirPath, isVideoFile);
  }

  async findMediaFiles(dirPath, predicate) {
    const result = [];
    for (const entry of await this.safeReadDir(dirPath)) {
      const entryPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        result.push(...await this.findMediaFiles(entryPath, predicate));
        continue;
      }

      if (entry.isFile() && predicate(entryPath)) {
        result.push(entryPath);
      }
    }

    return result.sort((a, b) => a.localeCompare(b));
  }

  async safeReadDir(dirPath) {
    try {
      return await fs.readdir(dirPath, { withFileTypes: true });
    } catch (err) {
      if (err.code === "ENOENT") {
        return [];
      }

      throw err;
    }
  }

  async fileStats(filePath) {
    const stat = await fs.stat(filePath);
    const addedAtMs = Math.max(
      stat.birthtimeMs || 0,
      stat.ctimeMs || 0,
      stat.mtimeMs || 0
    );

    return {
      addedAtMs,
      mtimeMs: stat.mtimeMs || addedAtMs
    };
  }

  parseSeasonFolder(folderName) {
    const match = folderName.match(/season\s+(\d+)/i);
    return match ? Number.parseInt(match[1], 10) : 0;
  }

  async movieItem(libraryPath, filePath, siblingVideoCount, fileStats = null) {
    const parsed = parseMovieFile(libraryPath, filePath, siblingVideoCount);
    return movieItemFromParsed(filePath, libraryPath, parsed, fileStats || await this.fileStats(filePath));
  }
}

function movieItemFromParsed(filePath, libraryPath, parsed, fileStats) {
  return {
    id: createId(filePath),
    title: parsed.title,
    year: parsed.year,
    filename: path.basename(filePath),
    folder: movieFolderName(libraryPath, filePath),
    filePath,
    addedAtMs: fileStats.addedAtMs,
    mtimeMs: fileStats.mtimeMs
  };
}

function showNameForEpisode(libraryPath, filePath, parsed) {
  if (parsed.matchType === "animeNumber") {
    const directoryName = nearestShowDirectory(libraryPath, filePath);
    if (directoryName) {
      return directoryName;
    }
  }

  return parsed.showName || nearestShowDirectory(libraryPath, filePath) || path.basename(filePath, path.extname(filePath));
}

function nearestShowDirectory(libraryPath, filePath) {
  const relativeParts = path.relative(libraryPath, path.dirname(filePath))
    .split(path.sep)
    .filter(Boolean);
  const filteredParts = relativeParts.filter((part) => !isSeasonFolder(part) && !isMetadataFolder(part));
  return filteredParts.length > 0 ? filteredParts[filteredParts.length - 1] : null;
}

function addEpisodeToShow(showsByKey, libraryPath, filePath, episode) {
  let show = showsByKey.get(episode.showId);
  if (!show) {
    show = {
      id: episode.showId,
      name: episode.showName,
      path: showPathForEpisode(libraryPath, filePath),
      seasons: []
    };
    showsByKey.set(episode.showId, show);
  }

  let season = show.seasons.find((entry) => entry.season === episode.season);
  if (!season) {
    season = {
      season: episode.season || 0,
      name: seasonNameForEpisode(filePath, episode.season),
      episodes: []
    };
    show.seasons.push(season);
  }

  season.episodes.push(episode);
  season.episodes.sort(sortEpisodes);
}

function showPathForEpisode(libraryPath, filePath) {
  const relativeParts = path.relative(libraryPath, path.dirname(filePath))
    .split(path.sep)
    .filter(Boolean);
  const showPartIndex = relativeParts.findIndex((part) => !isSeasonFolder(part) && !isMetadataFolder(part));
  return showPartIndex >= 0
    ? path.join(libraryPath, ...relativeParts.slice(0, showPartIndex + 1))
    : path.dirname(filePath);
}

function seasonNameForEpisode(filePath, season) {
  const parent = path.basename(path.dirname(filePath));
  return isSeasonFolder(parent) ? parent : `Season ${season || 0}`;
}

function isSeasonFolder(value) {
  return /^(season|series)\s*\d+$/i.test(String(value || ""))
    || /^\d+(?:st|nd|rd|th)?\s+(?:season|series|gig)$/i.test(String(value || ""));
}

function isMetadataFolder(value) {
  return /^(subs?|subtitle|subtitles|extras?|samples?)$/i.test(String(value || ""));
}

function sortEpisodes(a, b) {
  return (a.season || 0) - (b.season || 0) || (a.episode || 0) - (b.episode || 0) || a.filename.localeCompare(b.filename);
}

function movieFolderName(libraryPath, filePath) {
  const relativeDir = path.relative(libraryPath, path.dirname(filePath));
  return relativeDir && relativeDir !== "." ? relativeDir : path.basename(filePath, path.extname(filePath));
}

function parseMovieFile(libraryPath, filePath, siblingVideoCount) {
  const relativeDir = path.relative(libraryPath, path.dirname(filePath));
  if (relativeDir && relativeDir !== "." && siblingVideoCount === 1) {
    return parseMovieFolder(path.basename(path.dirname(filePath)));
  }

  return parseMovieFolder(path.basename(filePath, path.extname(filePath)));
}

function countFilesPerDirectory(filePaths) {
  const counts = new Map();
  for (const filePath of filePaths) {
    const dirPath = path.dirname(filePath);
    counts.set(dirPath, (counts.get(dirPath) || 0) + 1);
  }

  return counts;
}

function mergeDuplicateSeasons(seasons) {
  const bySeason = new Map();

  for (const season of seasons) {
    const seasonNumber = season.season || 0;
    const existing = bySeason.get(seasonNumber);
    if (!existing) {
      bySeason.set(seasonNumber, {
        season: seasonNumber,
        name: season.name,
        episodes: [...season.episodes]
      });
      continue;
    }

    existing.name = preferredSeasonName(existing.name, season.name);
    existing.episodes.push(...season.episodes);
    existing.episodes.sort(sortEpisodes);
  }

  return [...bySeason.values()];
}

function preferredSeasonName(current, next) {
  if (isSpecialsName(next) && !isSpecialsName(current)) {
    return next;
  }

  if (/^season\s+\d+$/i.test(next) && !/^season\s+\d+$/i.test(current)) {
    return next;
  }

  return current;
}

function isSpecialsName(value) {
  return /specials?/i.test(String(value || ""));
}

function emptyCollection(type) {
  if (type === "tv") {
    return { shows: [], items: [], byId: {}, episodesById: {} };
  }
  if (type === "music") {
    return { artists: [], tracksById: {} };
  }
  return { items: [], byId: {} };
}

function indexMeta(index) {
  return {
    generatedAt: index.generatedAt,
    libraries: index.libraries
  };
}

function artistPath(libraryPath, filePath) {
  const relativeParts = path.relative(libraryPath, filePath).split(path.sep).filter(Boolean);
  return relativeParts.length >= 3 ? path.join(libraryPath, relativeParts[0]) : libraryPath;
}

function sortTracks(a, b) {
  return (a.disc || 1) - (b.disc || 1)
    || (a.track || Number.MAX_SAFE_INTEGER) - (b.track || Number.MAX_SAFE_INTEGER)
    || a.filename.localeCompare(b.filename);
}

module.exports = { MediaIndex };
