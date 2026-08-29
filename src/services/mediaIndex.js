const fs = require("fs/promises");
const path = require("path");
const { createId, isAudioFile, isImageFile, isVideoFile, parseEpisodeFile, parseMovieFolder, parseMusicFile } = require("../utils/mediaParsers");
const { MusicTagReader, inferredAlbumDirectory } = require("./musicTagReader");
const logger = require("../utils/logger");

const MUSIC_SCAN_CONCURRENCY = 8;

class MediaIndex {
  constructor(config, indexStore) {
    this.config = config;
    this.indexStore = indexStore;
    this.databaseBacked = indexStore.type === "mysql";
    this.index = this.emptyIndex();
    this.reindexInFlight = null;
    this.libraryReindexInFlight = new Map();
    this.libraryReindexPending = new Set();
    this.libraryScanProgress = new Map();
    this.fileStatsRefreshNeeded = false;
    this.updateListeners = new Set();
    this.pendingChangedVideoMedia = [];
    this.musicTags = new MusicTagReader();
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
        trackProgress: library.trackProgress !== false,
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

    this.fileStatsRefreshNeeded = !await this.hasIndexedFileStats();
    if (this.fileStatsRefreshNeeded) {
      logger.info("[index] file stats missing; background reindex required");
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
    const changedMedia = [];
    const removedMedia = [];
    nextIndex.generatedAt = new Date().toISOString();
    for (const library of this.config.libraries) {
      this.startLibraryScan(library);
      try {
        const previousCollection = await this.previousCollection(library);
        const collection = await this.scanLibrary(library, previousCollection);
        nextIndex[library.key] = collection;
        changedMedia.push(...changedVideoMedia(collection, previousCollection, library));
        removedMedia.push(...removedVideoMedia(collection, previousCollection, library));
      } finally {
        this.finishLibraryScan(library.key);
      }
    }

    await this.indexStore.save(nextIndex);
    this.index = this.databaseBacked ? indexMeta(nextIndex) : nextIndex;
    this.fileStatsRefreshNeeded = false;
    this.pendingChangedVideoMedia = changedMedia;
    await this.notifyUpdated(null, { changedMedia, removedMedia });
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

    this.startLibraryScan(library);
    try {
      const previousCollection = await this.previousCollection(library);
      const collection = await this.scanLibrary(library, previousCollection);
      const changedMedia = changedVideoMedia(collection, previousCollection, library);
      const removedMedia = removedVideoMedia(collection, previousCollection, library);
      this.updateLibraryScan(library.key, { phase: "Saving library index", filePath: null, detail: null, etaSeconds: null });
      this.index.libraries = this.emptyIndex().libraries;
      this.index.generatedAt = new Date().toISOString();
      if (this.databaseBacked) {
        await this.indexStore.saveLibrary(library, collection, this.index);
      } else {
        this.index[library.key] = collection;
        await this.indexStore.save(this.index);
      }
      this.pendingChangedVideoMedia = changedMedia;
      await this.notifyUpdated(library.key, { changedMedia, removedMedia });
      return this.index;
    } finally {
      this.finishLibraryScan(library.key);
    }
  }

  addUpdateListener(listener) {
    if (typeof listener !== "function") throw new TypeError("Media index update listener must be a function");
    this.updateListeners.add(listener);
    return () => this.updateListeners.delete(listener);
  }

  async notifyUpdated(libraryKey, details = {}) {
    await Promise.all([...this.updateListeners].map((listener) => listener(libraryKey, details)));
  }

  consumeChangedVideoMedia() {
    const changedMedia = this.pendingChangedVideoMedia;
    this.pendingChangedVideoMedia = [];
    return changedMedia;
  }

  async videoMediaReferences() {
    const refs = [];
    for (const library of this.config.libraries) {
      if (library.type === "music" || library.type === "images") continue;
      const collection = await this.loadCollection(library.key, library.type);
      refs.push(...collectionMediaItems(collection, library.type)
        .filter((item) => isVideoFile(item.filePath))
        .map((item) => ({
          id: item.id,
          mediaType: library.key,
          filePath: item.filePath,
          sizeBytes: item.sizeBytes,
          mtimeMs: item.mtimeMs
        })));
    }
    return refs;
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

  async hasIndexedFileStats() {
    if (this.databaseBacked) {
      return this.indexStore.hasFileStats();
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
        if (episodes.some((episode) => !hasFileStats(episode))
          || items.some((movie) => !hasFileStats(movie))) {
          return false;
        }
        continue;
      }

      if (library.type === "music") {
        const tracks = Object.values(collection.tracksById || {});
        if (!Array.isArray(collection.artists) || !collection.tracksById
          || tracks.some((track) => !hasFileStats(track))) {
          return false;
        }
        continue;
      }

      const movies = collection.items || [];
      if (movies.some((movie) => !hasFileStats(movie))) {
        return false;
      }
    }

    return true;
  }

  requiresFileStatsRefresh() {
    return this.fileStatsRefreshNeeded;
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

  taskStatus() {
    return {
      fullReindex: Boolean(this.reindexInFlight),
      libraryReindexes: [...this.libraryReindexInFlight.keys()],
      pendingLibraries: [...this.libraryReindexPending],
      libraryProgress: [...this.libraryScanProgress.values()].map((entry) => ({ ...entry }))
    };
  }

  startLibraryScan(library) {
    const now = new Date().toISOString();
    this.libraryScanProgress.set(library.key, {
      libraryKey: library.key,
      phase: "Discovering files",
      current: null,
      total: null,
      etaSeconds: null,
      detail: null,
      filePath: library.path,
      startedAt: now,
      updatedAt: now
    });
  }

  updateLibraryScan(libraryKey, changes) {
    const current = this.libraryScanProgress.get(libraryKey);
    if (!current) return;
    this.libraryScanProgress.set(libraryKey, {
      ...current,
      ...changes,
      updatedAt: new Date().toISOString()
    });
  }

  finishLibraryScan(libraryKey) {
    this.libraryScanProgress.delete(libraryKey);
  }

  async previousCollection(library) {
    if (this.databaseBacked) {
      return {
        identityItems: await this.indexStore.loadFileIdentities(library.key, library.type)
      };
    }
    return this.index[library.key] || emptyCollection(library.type);
  }

  async scanLibrary(library, previousCollection = null) {
    let collection;
    if (library.type === "tv") {
      collection = await this.scanTvLibrary(library.path);
    } else if (library.type === "music") {
      collection = await this.scanMusicLibrary(
        library.path,
        previousCollection,
        (progress) => this.updateLibraryScan(library.key, progress)
      );
    } else if (library.type === "images") {
      collection = await this.scanImageLibrary(library.path);
    } else {
      collection = await this.scanMovieLibrary(library.path);
    }
    return reconcileMediaIdentity(collection, previousCollection, library.type);
  }

  async scanTvLibrary(libraryPath) {
    const showsByKey = new Map();
    const items = [];
    const byId = {};
    const episodesById = {};
    const videoFiles = await this.findVideoFiles(libraryPath);
    const filesPerDir = countFilesPerDirectory(videoFiles);
    const fileOrderPerDir = orderFilesPerDirectory(videoFiles);

    for (const filePath of videoFiles) {
      let parsed = parseEpisodeFile(filePath);
      const id = createId(filePath);
      const fileStats = await this.fileStats(filePath);
      const parentDirectory = path.basename(path.dirname(filePath));
      const inferredShowName = nearestShowDirectory(libraryPath, filePath);
      const specialsFolder = nearestSpecialsFolder(libraryPath, filePath);
      const specialsFolderDetails = specialsFolder && seasonFolderDetails(specialsFolder);
      const specialsShowName = inferredShowName || specialsFolderDetails && specialsFolderDetails.showName;
      if (specialsFolder && specialsShowName) {
        parsed = {
          ...parsed,
          season: 0,
          episode: Number.isFinite(parsed.episode) ? parsed.episode : fileOrderPerDir.get(filePath) || 1,
          showName: specialsShowName,
          matchType: parsed.matchType || "specialFolder"
        };
      }
      if (!Number.isFinite(parsed.season) || !Number.isFinite(parsed.episode)) {
        const movie = await this.movieItem(libraryPath, filePath, filesPerDir.get(path.dirname(filePath)) || 0, fileStats);
        items.push(movie);
        byId[movie.id] = movie;
        continue;
      }
      if (parsed.matchType === "specialFeature" && !inferredShowName) {
        const movie = await this.movieItem(libraryPath, filePath, filesPerDir.get(path.dirname(filePath)) || 0, fileStats);
        items.push(movie);
        byId[movie.id] = movie;
        continue;
      }

      const showName = showNameForEpisode(libraryPath, filePath, parsed);
      const showId = createId(showName);
      const seasonNumber = Number.isFinite(parsed.season)
        ? parsed.season
        : this.parseSeasonFolder(parentDirectory);
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
        mtimeMs: fileStats.mtimeMs,
        sizeBytes: fileStats.sizeBytes
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

  async scanMusicLibrary(libraryPath, previousCollection = null, reportProgress = () => {}) {
    const artistsById = new Map();
    const albumsById = new Map();
    const tracksById = {};
    const audioFiles = await this.findMediaFiles(libraryPath, isAudioFile, ({ directories, files }) => {
      reportProgress({
        phase: "Discovering music files",
        current: null,
        total: null,
        etaSeconds: null,
        detail: `${directories.toLocaleString()} folders scanned; ${files.toLocaleString()} files found`,
        filePath: libraryPath
      });
    });
    const previousByPath = new Map(collectionMediaItems(previousCollection || {}, "music")
      .map((item) => [normalizedFilePath(item.filePath), item]));
    const artworkByDirectory = new Map();
    const startedAt = Date.now();
    const activePaths = new Set();
    let processed = 0;
    reportProgress({
      phase: "Inspecting music files",
      current: 0,
      total: audioFiles.length,
      etaSeconds: null,
      detail: `${MUSIC_SCAN_CONCURRENCY} files in parallel`,
      filePath: null
    });

    const scannedTracks = await mapWithConcurrency(audioFiles, MUSIC_SCAN_CONCURRENCY, async (filePath) => {
      activePaths.add(filePath);
      const stats = await this.fileStats(filePath);
      const previous = previousByPath.get(normalizedFilePath(filePath));
      const unchanged = previous
        && Number(previous.mtimeMs) === Number(stats.mtimeMs)
        && Number(previous.sizeBytes) === Number(stats.sizeBytes)
        && previous.musicTagsRead === true;
      const fallback = parseMusicFile(libraryPath, filePath);
      let tags = unchanged ? musicTagsFromTrack(previous) : null;
      if (!tags) {
        try {
          tags = await this.musicTags.read(filePath);
        } catch (err) {
          logger.full(`[index] music tags unavailable file="${filePath}" message="${err.message}"`);
          tags = {};
        }
      }
      const parsed = musicIdentity(fallback, tags);
      const albumPath = inferredAlbumDirectory(filePath);
      const localArtworkPath = await findLocalAlbumArtwork(albumPath, artworkByDirectory);
      const artistIdentity = parsed.artist;
      const albumIdentity = tags.musicBrainzReleaseId
        || `${parsed.artist}:${parsed.album}:${parsed.year || ""}:${normalizedFilePath(albumPath)}`;
      const artistId = createId(`artist:${artistIdentity}`);
      const albumId = createId(`album:${albumIdentity}`);
      const track = {
        id: createId(filePath),
        artistId,
        artistName: parsed.artists[0] || parsed.artist,
        albumId,
        albumName: parsed.album,
        year: parsed.year,
        disc: parsed.disc,
        track: parsed.track,
        title: parsed.title,
        artists: parsed.artists,
        albumArtist: parsed.artist,
        discTotal: tags.discTotal || null,
        trackTotal: tags.trackTotal || null,
        compilation: tags.compilation === true,
        musicBrainzArtistIds: tags.musicBrainzArtistIds || [],
        musicBrainzAlbumArtistId: tags.musicBrainzAlbumArtistId || null,
        musicBrainzReleaseId: tags.musicBrainzReleaseId || null,
        musicBrainzReleaseGroupId: tags.musicBrainzReleaseGroupId || null,
        musicBrainzRecordingId: tags.musicBrainzRecordingId || null,
        musicBrainzTrackId: tags.musicBrainzTrackId || null,
        hasEmbeddedArtwork: tags.hasEmbeddedArtwork === true,
        localArtworkPath,
        musicTagsRead: true,
        filename: path.basename(filePath),
        filePath,
        addedAtMs: stats.addedAtMs,
        mtimeMs: stats.mtimeMs,
        sizeBytes: stats.sizeBytes
      };

      activePaths.delete(filePath);
      processed += 1;
      const elapsedMs = Date.now() - startedAt;
      reportProgress({
        phase: "Inspecting music files",
        current: processed,
        total: audioFiles.length,
        etaSeconds: processed > 0
          ? Math.max(0, Math.ceil(elapsedMs / processed * (audioFiles.length - processed) / 1000))
          : null,
        detail: `${Math.min(activePaths.size, MUSIC_SCAN_CONCURRENCY)} files active`,
        filePath: activePaths.values().next().value || filePath
      });

      return { albumId, albumPath, artistId, filePath, localArtworkPath, parsed, tags, track };
    });

    reportProgress({
      phase: "Building music catalogue",
      current: audioFiles.length,
      total: audioFiles.length,
      etaSeconds: null,
      detail: null,
      filePath: null
    });

    for (const scanned of scannedTracks) {
      const { albumId, albumPath, artistId, filePath, localArtworkPath, parsed, tags, track } = scanned;
      const existingAlbumEntry = albumsById.get(albumId);
      if (existingAlbumEntry) {
        const { album, artist } = existingAlbumEntry;
        if (artist.id !== artistId) {
          logger.full(`[index] consolidated music album id=${albumId} album="${parsed.album}" owner="${artist.name}" conflictingArtist="${parsed.artist}"`);
        }

        track.artistId = artist.id;
        album.localArtworkPath = album.localArtworkPath || localArtworkPath;
        album.hasEmbeddedArtwork = album.hasEmbeddedArtwork || tags.hasEmbeddedArtwork === true;
        album.musicBrainzReleaseId = album.musicBrainzReleaseId || tags.musicBrainzReleaseId || null;
        album.musicBrainzReleaseGroupId = album.musicBrainzReleaseGroupId || tags.musicBrainzReleaseGroupId || null;
        album.tracks.push(track);
        tracksById[track.id] = track;
        continue;
      }

      let artist = artistsById.get(artistId);
      if (!artist) {
        artist = {
          id: artistId,
          name: parsed.artist,
          path: artistPathForName(libraryPath, filePath, parsed.artist),
          musicBrainzArtistId: tags.musicBrainzAlbumArtistId || null,
          albums: []
        };
        artistsById.set(artistId, artist);
      }
      artist.musicBrainzArtistId = artist.musicBrainzArtistId || tags.musicBrainzAlbumArtistId || null;
      const album = {
        id: albumId,
        name: parsed.album,
        year: parsed.year,
        path: albumPath,
        localArtworkPath,
        hasEmbeddedArtwork: tags.hasEmbeddedArtwork === true,
        musicBrainzReleaseId: tags.musicBrainzReleaseId || null,
        musicBrainzReleaseGroupId: tags.musicBrainzReleaseGroupId || null,
        tracks: []
      };
      artist.albums.push(album);
      albumsById.set(albumId, { album, artist });
      album.tracks.push(track);
      tracksById[track.id] = track;
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
        mtimeMs: stats.mtimeMs,
        sizeBytes: stats.sizeBytes
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

  async findMediaFiles(dirPath, predicate, reportProgress = null) {
    const result = [];
    let directories = 0;
    const visit = async (currentPath) => {
      directories += 1;
      for (const entry of await this.safeReadDir(currentPath, currentPath === dirPath)) {
        const entryPath = path.join(currentPath, entry.name);
        if (entry.isDirectory()) {
          await visit(entryPath);
          continue;
        }

        if (entry.isFile() && predicate(entryPath)) {
          result.push(entryPath);
        }
      }
      if (reportProgress && (directories % 25 === 0 || currentPath === dirPath)) {
        reportProgress({ directories, files: result.length });
      }
    };

    await visit(dirPath);
    if (reportProgress) reportProgress({ directories, files: result.length });

    return result.sort((a, b) => a.localeCompare(b));
  }

  async safeReadDir(dirPath, isLibraryRoot = false) {
    try {
      return await fs.readdir(dirPath, { withFileTypes: true });
    } catch (err) {
      if (err.code === "ENOENT") {
        if (!isLibraryRoot) {
          logger.info(`[index] warning skipped unreadable directory path="${dirPath}" code=${err.code} message="${err.message}"`);
        }
        return [];
      }

      if (!isLibraryRoot) {
        logger.info(`[index] warning skipped unreadable directory path="${dirPath}" code=${err.code || "unknown"} message="${err.message}"`);
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
      mtimeMs: stat.mtimeMs || addedAtMs,
      sizeBytes: stat.size
    };
  }

  parseSeasonFolder(folderName) {
    if (isSpecialsFolder(folderName)) {
      return 0;
    }
    const season = seasonNumberFromFolder(folderName);
    return season === null ? 0 : season;
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
    mtimeMs: fileStats.mtimeMs,
    sizeBytes: fileStats.sizeBytes
  };
}

function showNameForEpisode(libraryPath, filePath, parsed) {
  const parentDirectory = path.basename(path.dirname(filePath));
  const seasonFolderName = nearestSeasonFolder(libraryPath, filePath);
  const seasonFolder = seasonFolderDetails(seasonFolderName || parentDirectory);
  if (parsed.matchType === "animeNumber"
    || parsed.matchType === "specialFeature"
    || parsed.matchType === "specialFolder"
    || seasonFolder) {
    const directoryName = nearestShowDirectory(libraryPath, filePath);
    if (directoryName) {
      return directoryName;
    }
    if (seasonFolder && seasonFolder.showName) {
      return seasonFolder.showName;
    }
  }

  return parsed.showName || nearestShowDirectory(libraryPath, filePath) || path.basename(filePath, path.extname(filePath));
}

function nearestShowDirectory(libraryPath, filePath) {
  const relativeParts = relativeDirectoryParts(libraryPath, filePath);
  const seasonIndex = relativeParts.findIndex(isSeasonFolder);
  if (seasonIndex > 0) {
    for (let index = seasonIndex - 1; index >= 0; index -= 1) {
      if (!isMetadataFolder(relativeParts[index])) return relativeParts[index];
    }
  }
  if (seasonIndex === 0) return null;
  const filteredParts = relativeParts.filter((part) => !isSeasonFolder(part) && !isMetadataFolder(part));
  return filteredParts.length > 0 ? filteredParts[filteredParts.length - 1] : null;
}

function nearestSeasonFolder(libraryPath, filePath) {
  return relativeDirectoryParts(libraryPath, filePath).find(isSeasonFolder) || null;
}

function nearestSpecialsFolder(libraryPath, filePath) {
  return relativeDirectoryParts(libraryPath, filePath).find(isSpecialsFolder) || null;
}

function relativeDirectoryParts(libraryPath, filePath) {
  return path.relative(libraryPath, path.dirname(filePath))
    .split(path.sep)
    .filter(Boolean);
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
  if (season === 0) {
    return isSpecialsName(parent) ? parent : "Specials";
  }
  return isSeasonFolder(parent) ? parent : `Season ${season}`;
}

function isSeasonFolder(value) {
  return isSpecialsName(value)
    || seasonNumberFromFolder(value) !== null
    || /^\d+(?:st|nd|rd|th)?\s+(?:season|series|gig)$/i.test(String(value || ""));
}

function seasonNumberFromFolder(value) {
  const details = seasonFolderDetails(value);
  return details ? details.season : null;
}

function seasonFolderDetails(value) {
  const text = String(value || "").trim();
  const leadingMatch = text.match(/^(?:(?:season|series)\s*|s\s*)0*(\d{1,4})(?=$|[\s._:\-]|\(|\[)/i);
  if (leadingMatch) {
    return { season: Number.parseInt(leadingMatch[1], 10), showName: null };
  }

  const trailingMatch = text.match(/^(.+?)\s+(?:-\s*)?(?:season|series|s)\s*0*(\d{1,4})(?=$|[\s._:\-]|\(|\[)/i);
  return trailingMatch
    ? { season: Number.parseInt(trailingMatch[2], 10), showName: trailingMatch[1].trim() }
    : null;
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
  const parentDirectory = path.basename(path.dirname(filePath));
  const filename = path.basename(filePath, path.extname(filePath));
  if (siblingVideoCount > 1) {
    const namedCollectionMovie = parseNamedCollectionMovie(parentDirectory, filename);
    if (namedCollectionMovie) return namedCollectionMovie;
  }
  if (relativeDir && relativeDir !== "." && siblingVideoCount === 1) {
    return parseMovieFolder(parentDirectory);
  }

  const title = siblingVideoCount > 1 && isMovieCollectionFolder(parentDirectory)
    ? stripCollectionSequence(filename)
    : filename;
  return parseMovieFolder(title);
}

function parseNamedCollectionMovie(parentDirectory, filename) {
  const parent = normalizeMoviePathText(parentDirectory);
  const name = normalizeMoviePathText(filename);
  const prefix = `${parent} - `;
  if (!parent || !name.toLowerCase().startsWith(prefix.toLowerCase())) return null;

  const match = name.slice(prefix.length).match(/^((?:19|20)\d{2})\s*-\s*(.+)$/);
  return match ? parseMovieFolder(`${match[2]} (${match[1]})`) : null;
}

function normalizeMoviePathText(value) {
  return String(value || "")
    .replace(/[._]+/g, " ")
    .replace(/\s*-\s*/g, " - ")
    .replace(/\s+/g, " ")
    .trim();
}

function isMovieCollectionFolder(value) {
  return /\b(?:collection|anthology|box[\s._-]*set)\b/i.test(String(value || ""));
}

function stripCollectionSequence(value) {
  const stripped = String(value || "").replace(/\s*-\s*0*\d{1,3}\s*$/, "").trim();
  return stripped || String(value || "").trim();
}

function countFilesPerDirectory(filePaths) {
  const counts = new Map();
  for (const filePath of filePaths) {
    const dirPath = path.dirname(filePath);
    counts.set(dirPath, (counts.get(dirPath) || 0) + 1);
  }

  return counts;
}

function orderFilesPerDirectory(filePaths) {
  const byDirectory = new Map();
  for (const filePath of filePaths) {
    const directory = path.dirname(filePath);
    const files = byDirectory.get(directory) || [];
    files.push(filePath);
    byDirectory.set(directory, files);
  }

  const order = new Map();
  for (const files of byDirectory.values()) {
    files
      .sort((a, b) => path.basename(a).localeCompare(path.basename(b), undefined, { numeric: true }))
      .forEach((filePath, index) => order.set(filePath, index + 1));
  }
  return order;
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
  return /^specials?$/i.test(String(value || "").trim());
}

function isSpecialsFolder(value) {
  return isSpecialsName(value) || seasonNumberFromFolder(value) === 0;
}

function reconcileMediaIdentity(collection, previousCollection, type) {
  if (!previousCollection) {
    return collection;
  }

  const currentItems = collectionMediaItems(collection, type);
  const previousItems = collectionMediaItems(previousCollection, type);
  if (currentItems.length === 0 || previousItems.length === 0) {
    return collection;
  }

  const currentPaths = new Set(currentItems.map((item) => normalizedFilePath(item.filePath)));
  const previousPaths = new Set(previousItems.map((item) => normalizedFilePath(item.filePath)));
  const addedItems = currentItems.filter((item) => !previousPaths.has(normalizedFilePath(item.filePath)));
  const removedItems = previousItems.filter((item) => !currentPaths.has(normalizedFilePath(item.filePath)));
  const addedByFingerprint = groupByFingerprint(addedItems);
  const removedByFingerprint = groupByFingerprint(removedItems);

  for (const [fingerprint, additions] of addedByFingerprint) {
    const removals = removedByFingerprint.get(fingerprint) || [];
    if (additions.length !== 1 || removals.length !== 1) {
      continue;
    }

    const item = additions[0];
    const previous = removals[0];
    item.id = previous.id;
    if (Number.isFinite(Number(previous.addedAtMs))) {
      item.addedAtMs = Number(previous.addedAtMs);
    }
    logger.full(`[index] file rename retained id=${item.id} from="${previous.filePath}" to="${item.filePath}"`);
  }

  rebuildCollectionLookups(collection, type);
  return collection;
}

function collectionMediaItems(collection, type) {
  if (Array.isArray(collection.identityItems)) {
    return collection.identityItems;
  }
  if (type === "tv") {
    return [
      ...Object.values(collection.episodesById || {}),
      ...(collection.items || [])
    ];
  }
  if (type === "music") {
    return Object.values(collection.tracksById || {});
  }
  return collection.items || [];
}

function changedVideoMedia(collection, previousCollection, library) {
  if (!library || library.type === "music" || library.type === "images") {
    return [];
  }

  const previousByPath = new Map(collectionMediaItems(previousCollection || {}, library.type)
    .map((item) => [normalizedFilePath(item.filePath), item]));

  return collectionMediaItems(collection, library.type)
    .filter((item) => isVideoFile(item.filePath))
    .filter((item) => {
      const previous = previousByPath.get(normalizedFilePath(item.filePath));
      return !previous
        || Number(previous.sizeBytes) !== Number(item.sizeBytes)
        || Number(previous.mtimeMs) !== Number(item.mtimeMs);
    })
    .map((item) => ({
      id: item.id,
      mediaType: library.key,
      filePath: item.filePath,
      sizeBytes: item.sizeBytes,
      mtimeMs: item.mtimeMs
    }));
}

function removedVideoMedia(collection, previousCollection, library) {
  if (!library || library.type === "music" || library.type === "images") {
    return [];
  }

  const currentIds = new Set(collectionMediaItems(collection, library.type)
    .filter((item) => isVideoFile(item.filePath))
    .map((item) => String(item.id)));
  return collectionMediaItems(previousCollection || {}, library.type)
    .filter((item) => isVideoFile(item.filePath) && !currentIds.has(String(item.id)))
    .map((item) => ({
      mediaType: library.key,
      mediaId: item.id
    }));
}

function groupByFingerprint(items) {
  const grouped = new Map();
  for (const item of items) {
    const fingerprint = mediaFingerprint(item);
    if (!fingerprint) {
      continue;
    }
    const matches = grouped.get(fingerprint) || [];
    matches.push(item);
    grouped.set(fingerprint, matches);
  }
  return grouped;
}

function mediaFingerprint(item) {
  const sizeBytes = Number(item && item.sizeBytes);
  const mtimeMs = Number(item && item.mtimeMs);
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0 || !Number.isFinite(mtimeMs) || mtimeMs <= 0) {
    return null;
  }
  return `${Math.round(sizeBytes)}:${Math.round(mtimeMs)}`;
}

function hasFileStats(item) {
  return Number.isFinite(Number(item && item.addedAtMs))
    && Number.isFinite(Number(item && item.mtimeMs))
    && Number.isFinite(Number(item && item.sizeBytes));
}

function normalizedFilePath(filePath) {
  const normalized = path.normalize(String(filePath || ""));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function rebuildCollectionLookups(collection, type) {
  if (type === "tv") {
    const episodes = (collection.shows || [])
      .flatMap((show) => show.seasons || [])
      .flatMap((season) => season.episodes || []);
    collection.episodesById = Object.fromEntries(episodes.map((episode) => [episode.id, episode]));
    collection.byId = Object.fromEntries((collection.items || []).map((item) => [item.id, item]));
    return;
  }
  if (type === "music") {
    const tracks = (collection.artists || [])
      .flatMap((artist) => artist.albums || [])
      .flatMap((album) => album.tracks || []);
    collection.tracksById = Object.fromEntries(tracks.map((track) => [track.id, track]));
    return;
  }
  collection.byId = Object.fromEntries((collection.items || []).map((item) => [item.id, item]));
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

function artistPathForName(libraryPath, filePath, artistName) {
  const directories = path.relative(libraryPath, path.dirname(filePath)).split(path.sep).filter(Boolean);
  const normalizedArtist = normalizeMusicText(artistName);
  const matchingIndex = directories.findIndex((part) => {
    const normalizedPart = normalizeMusicText(part);
    return normalizedPart === normalizedArtist || normalizedPart.startsWith(`${normalizedArtist} `);
  });
  return matchingIndex >= 0
    ? path.join(libraryPath, ...directories.slice(0, matchingIndex + 1))
    : artistPath(libraryPath, filePath);
}

function musicIdentity(fallback, tags) {
  const folderArtist = fallback.artist && !/^unknown artist$/i.test(fallback.artist)
    ? fallback.artist
    : null;
  const artists = tags.artists && tags.artists.length
    ? tags.artists
    : [tags.artist || tags.albumArtist || fallback.artist].filter(Boolean);
  const taggedAlbum = tags.album && tags.album !== "Unknown Album" ? tags.album : null;
  return {
    artist: folderArtist
      || tags.albumArtist
      || (tags.compilation ? "Various Artists" : tags.artist)
      || "Unknown Artist",
    artists,
    album: taggedAlbum || fallback.album || "Unknown Album",
    year: tags.year || fallback.year || null,
    disc: tags.disc || fallback.disc || 1,
    track: tags.track || fallback.track || null,
    title: tags.title || fallback.title
  };
}

function musicTagsFromTrack(track) {
  return {
    title: track.title,
    artist: track.artists && track.artists[0] || track.artistName,
    artists: track.artists || [],
    albumArtist: track.albumArtist || track.artistName,
    album: track.albumName,
    year: track.year,
    disc: track.disc,
    discTotal: track.discTotal,
    track: track.track,
    trackTotal: track.trackTotal,
    compilation: track.compilation,
    musicBrainzArtistIds: track.musicBrainzArtistIds || [],
    musicBrainzAlbumArtistId: track.musicBrainzAlbumArtistId,
    musicBrainzReleaseId: track.musicBrainzReleaseId,
    musicBrainzReleaseGroupId: track.musicBrainzReleaseGroupId,
    musicBrainzRecordingId: track.musicBrainzRecordingId,
    musicBrainzTrackId: track.musicBrainzTrackId,
    hasEmbeddedArtwork: track.hasEmbeddedArtwork
  };
}

async function findLocalAlbumArtwork(directory, cache) {
  if (cache.has(directory)) return cache.get(directory);
  let entries = [];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (err) {
    if (err.code !== "ENOENT") logger.full(`[index] album artwork scan failed directory="${directory}" message="${err.message}"`);
  }
  const preferred = ["cover", "folder", "front", "album", "albumart"];
  const images = entries.filter((entry) => entry.isFile() && isImageFile(entry.name));
  const selected = images.sort((a, b) => {
    const left = preferred.indexOf(path.basename(a.name, path.extname(a.name)).toLowerCase());
    const right = preferred.indexOf(path.basename(b.name, path.extname(b.name)).toLowerCase());
    return (left < 0 ? preferred.length : left) - (right < 0 ? preferred.length : right) || a.name.localeCompare(b.name);
  })[0];
  const result = selected ? path.join(directory, selected.name) : null;
  cache.set(directory, result);
  return result;
}

function normalizeMusicText(value) {
  return String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function sortTracks(a, b) {
  return (a.disc || 1) - (b.disc || 1)
    || (a.track || Number.MAX_SAFE_INTEGER) - (b.track || Number.MAX_SAFE_INTEGER)
    || a.filename.localeCompare(b.filename);
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  const workerCount = Math.max(1, Math.min(Number(concurrency) || 1, items.length || 1));
  let nextIndex = 0;
  let firstError = null;
  const workers = Array.from({ length: workerCount }, async () => {
    while (!firstError) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      try {
        results[index] = await mapper(items[index], index);
      } catch (err) {
        firstError = err;
      }
    }
  });
  await Promise.all(workers);
  if (firstError) throw firstError;
  return results;
}

module.exports = { MediaIndex };
