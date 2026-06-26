const fs = require("fs/promises");
const path = require("path");
const { createId } = require("../utils/mediaParsers");
const logger = require("../utils/logger");

const TMDB_API_BASE = "https://api.themoviedb.org/3";
const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p";

class MetadataService {
  constructor(config, store, ffmpeg = null) {
    this.appConfig = config;
    this.config = config.metadata;
    this.store = store;
    this.ffmpeg = ffmpeg;
    this.posterDir = path.join(this.config.cachePath, "posters");
    this.thumbnailDir = path.join(this.config.cachePath, "thumbnails");
    this.preloadInFlight = null;
    this.missingRecheckInFlight = null;
    this.lastMissingRecheck = null;
    this.thumbnailInFlight = new Map();
  }

  async getForMedia(mediaType, mediaFile) {
    let cached = await this.store.get(mediaType, mediaFile.id);
    if (cached) {
      if (cached.found && !cached.posterFilename && !cached.posterUnavailable) {
        cached = await this.ensurePosterForRecord(cached);
      }
      return toPublicRecord(cached, true);
    }

    if (!this.config.enabled) {
      return { available: false, cached: false, reason: "Metadata lookup is disabled." };
    }

    if (this.config.provider !== "tmdb") {
      return { available: false, cached: false, reason: `Unsupported metadata provider: ${this.config.provider}` };
    }

    if (!this.config.tmdbReadAccessToken && !this.config.tmdbApiKey) {
      return { available: false, cached: false, reason: "TMDb credentials are not configured." };
    }

    const query = metadataQuery(this.appConfig, mediaType, mediaFile);
    logger.info(`[metadata] cache miss mediaType=${mediaType} id=${mediaFile.id} provider=tmdb query="${query.title}" year=${query.year || "none"}`);
    const result = await this.searchTmdb(query);
    const record = result
      ? await this.createFoundRecord(mediaType, mediaFile.id, query.kind, result)
      : createMissingRecord(mediaType, mediaFile.id, "tmdb");

    await this.store.save(record);
    return toPublicRecord(record, false);
  }

  async getCachedForMedia(mediaType, mediaId) {
    const cached = await this.store.get(mediaType, mediaId);
    return cached ? toPublicRecord(cached, true) : null;
  }

  async getCachedByPosterFilename(filename) {
    return this.store.getByPosterFilename(filename);
  }

  async getCachedForMediaItems(items) {
    const records = await this.store.getMany(items);
    return new Map(records.map((record) => [
      recordKey(record.mediaType, record.mediaId),
      toPublicRecord(record, true)
    ]));
  }

  async listPosterUnavailable(mediaIndex, limit) {
    const records = await this.store.listPosterUnavailable(limit);
    const files = mediaFileMap(mediaIndex.index);

    return records.map((record) => {
      const file = files.get(recordKey(record.mediaType, record.mediaId));
      return {
        mediaType: record.mediaType,
        id: record.mediaId,
        title: titleForMediaFile(file) || record.title || record.mediaId,
        subtitle: subtitleForMediaFile(file),
        filePath: file ? file.filePath : null,
        provider: record.provider,
        providerId: record.providerId,
        posterUnavailableReason: record.posterUnavailableReason || null,
        updatedAt: record.updatedAt || null
      };
    });
  }

  async refreshForMedia(mediaType, mediaFile) {
    const unavailable = metadataUnavailableReason(this.config);
    if (unavailable) {
      return unavailable;
    }

    const query = metadataQuery(this.appConfig, mediaType, mediaFile);
    logger.info(`[metadata] refresh mediaType=${mediaType} id=${mediaFile.id} provider=tmdb query="${query.title}" year=${query.year || "none"}`);
    const result = await this.searchTmdb(query);
    const record = result
      ? await this.createFoundRecord(mediaType, mediaFile.id, query.kind, result)
      : createMissingRecord(mediaType, mediaFile.id, "tmdb");

    await this.store.save(record);
    return toPublicRecord(record, false);
  }

  async searchCandidatesForMedia(mediaType, mediaFile, input = {}) {
    const unavailable = metadataUnavailableReason(this.config);
    const defaultQuery = metadataQuery(this.appConfig, mediaType, mediaFile);
    const query = normalizeManualMetadataQuery(defaultQuery, input);
    if (unavailable) {
      return {
        ...unavailable,
        query,
        candidates: []
      };
    }

    logger.info(`[metadata] manual search mediaType=${mediaType} id=${mediaFile.id} provider=tmdb query="${query.title}" year=${query.year || "none"}`);
    const candidates = await this.searchTmdbCandidates(query);
    return {
      available: true,
      provider: "tmdb",
      query,
      candidates: candidates.map((candidate) => toPublicCandidate(candidate, query.kind))
    };
  }

  async matchProviderForMedia(mediaType, mediaFile, input = {}) {
    const unavailable = metadataUnavailableReason(this.config);
    if (unavailable) {
      return unavailable;
    }

    const providerId = String(input.providerId || "").trim();
    if (!providerId) {
      throw new Error("providerId is required");
    }

    const query = metadataQuery(this.appConfig, mediaType, mediaFile);
    const result = await this.fetchTmdbDetails(query.kind, providerId);
    const record = await this.createFoundRecord(mediaType, mediaFile.id, query.kind, result);
    await this.store.save(record);
    return toPublicRecord(record, false);
  }

  startMissingRecheck(mediaIndex, options = {}) {
    if (this.missingRecheckInFlight) {
      return {
        started: false,
        running: true,
        last: this.lastMissingRecheck
      };
    }

    const limit = Math.max(1, Math.min(Number.parseInt(options.limit, 10) || 1000, 5000));
    this.lastMissingRecheck = {
      running: true,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      limit,
      checked: 0,
      matched: 0,
      stillMissing: 0,
      skipped: 0,
      failed: 0,
      error: null
    };

    this.missingRecheckInFlight = this.runMissingRecheck(mediaIndex, limit)
      .then((result) => {
        this.lastMissingRecheck = result;
        return result;
      })
      .catch((err) => {
        this.lastMissingRecheck = {
          ...this.lastMissingRecheck,
          running: false,
          finishedAt: new Date().toISOString(),
          error: err.message
        };
        throw err;
      })
      .finally(() => {
        this.missingRecheckInFlight = null;
      });

    this.missingRecheckInFlight.catch((err) => {
      logger.error(`[metadata] missing recheck failed message="${err.message}"`, err);
    });

    return {
      started: true,
      running: true,
      last: this.lastMissingRecheck
    };
  }

  missingRecheckStatus() {
    return {
      running: Boolean(this.missingRecheckInFlight),
      last: this.lastMissingRecheck
    };
  }

  async setPosterForMedia(mediaType, mediaFile, source) {
    const posterFilename = await this.cacheManualPoster(mediaType, mediaFile.id, source);
    const cached = await this.store.get(mediaType, mediaFile.id);
    const record = cached || createManualRecord(mediaType, mediaFile);
    const updated = {
      ...record,
      mediaType,
      mediaId: mediaFile.id,
      found: true,
      title: record.title || titleForMediaFile(mediaFile),
      posterPath: source.url || source.filePath,
      posterFilename,
      posterUnavailable: false,
      posterUnavailableReason: null
    };

    await this.store.save(updated);
    return toPublicRecord(updated, true);
  }

  posterUrl(filename, token, paramName = "authToken") {
    return filename
      ? `/api/catalog/metadata/poster/${encodeURIComponent(filename)}?${encodeURIComponent(paramName)}=${encodeURIComponent(token)}`
      : null;
  }

  thumbnailUrl(mediaType, mediaId, token, paramName = "authToken") {
    return `/api/catalog/${encodeURIComponent(mediaType)}/${encodeURIComponent(mediaId)}/metadata/thumbnail?${encodeURIComponent(paramName)}=${encodeURIComponent(token)}`;
  }

  startBackgroundPreload(mediaIndex) {
    if (!this.config.enabled || !this.config.preloadOnStartup) {
      return;
    }

    setImmediate(() => {
      this.preloadAll(mediaIndex).catch((err) => {
        logger.error(`[metadata] background preload failed message="${err.message}"`, err);
      });
    });
  }

  async preloadAll(mediaIndex) {
    if (this.preloadInFlight) {
      logger.info("[metadata] background preload already running; joining existing task");
      return this.preloadInFlight;
    }

    this.preloadInFlight = this.runPreload(mediaIndex);
    try {
      return await this.preloadInFlight;
    } finally {
      this.preloadInFlight = null;
    }
  }

  async runPreload(mediaIndex) {
    if (!this.config.tmdbReadAccessToken && !this.config.tmdbApiKey) {
      logger.info("[metadata] background preload skipped: TMDb credentials are not configured");
      return;
    }

    const mediaFiles = listIndexedMediaFiles(mediaIndex.index);
    const recordsByQuery = new Map();
    let cachedCount = 0;
    let fetchedCount = 0;
    let posterRepairedCount = 0;
    let posterUnavailableCount = 0;
    let copiedCount = 0;
    let missingCount = 0;
    let failedCount = 0;

    logger.info(`[metadata] background preload starting files=${mediaFiles.length}`);

    for (const media of mediaFiles) {
      try {
        const cached = await this.store.get(media.mediaType, media.file.id);
        if (cached && (!cached.found || cached.posterFilename || cached.posterUnavailable)) {
          cachedCount += 1;
          continue;
        }

        if (cached && cached.found && !cached.posterFilename) {
          const repaired = await this.ensurePosterForRecord(cached);
          if (repaired.posterFilename) {
            posterRepairedCount += 1;
          } else if (repaired.posterUnavailable) {
            posterUnavailableCount += 1;
          } else {
            cachedCount += 1;
          }
          await delay(this.config.requestDelayMs);
          continue;
        }

        const query = metadataQuery(this.appConfig, media.mediaType, media.file);
        const queryKey = metadataQueryKey(query);
        const sharedRecord = recordsByQuery.get(queryKey);
        if (sharedRecord) {
          await this.store.save(copyRecordForMedia(sharedRecord, media.mediaType, media.file.id));
          copiedCount += 1;
          continue;
        }

        logger.full(`[metadata] preload fetch mediaType=${media.mediaType} id=${media.file.id} query="${query.title}" year=${query.year || "none"}`);
        const result = await this.searchTmdb(query);
        const record = result
          ? await this.createFoundRecord(media.mediaType, media.file.id, query.kind, result)
          : createMissingRecord(media.mediaType, media.file.id, "tmdb");

        await this.store.save(record);
        recordsByQuery.set(queryKey, record);
        if (record.found) {
          fetchedCount += 1;
        } else {
          missingCount += 1;
        }

        await delay(this.config.requestDelayMs);
      } catch (err) {
        failedCount += 1;
        logger.error(`[metadata] preload item failed mediaType=${media.mediaType} id=${media.file.id} message="${err.message}"`, err);
      }
    }

    logger.info(`[metadata] background preload complete cached=${cachedCount} fetched=${fetchedCount} posterRepaired=${posterRepairedCount} posterUnavailable=${posterUnavailableCount} copied=${copiedCount} missing=${missingCount} failed=${failedCount}`);
  }

  async runMissingRecheck(mediaIndex, limit) {
    const unavailable = metadataUnavailableReason(this.config);
    if (unavailable) {
      return {
        running: false,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        limit,
        checked: 0,
        matched: 0,
        stillMissing: 0,
        skipped: 0,
        failed: 0,
        error: unavailable.reason
      };
    }

    const startedAt = new Date().toISOString();
    const missingMedia = await this.indexedMissingMedia(mediaIndex, limit);
    let checked = 0;
    let matched = 0;
    let stillMissing = 0;
    let skipped = 0;
    let failed = 0;

    logger.info(`[metadata] missing recheck starting records=${missingMedia.length} limit=${limit}`);
    for (const media of missingMedia) {
      try {
        checked += 1;
        const query = metadataQuery(this.appConfig, media.mediaType, media.file);
        logger.full(`[metadata] missing recheck fetch mediaType=${media.mediaType} id=${media.file.id} query="${query.title}" year=${query.year || "none"}`);
        const result = await this.searchTmdb(query);
        const updated = result
          ? await this.createFoundRecord(media.mediaType, media.file.id, query.kind, result)
          : createMissingRecord(media.mediaType, media.file.id, "tmdb");
        await this.store.save(updated);

        if (updated.found) {
          matched += 1;
        } else {
          stillMissing += 1;
        }
        await delay(this.config.requestDelayMs);
      } catch (err) {
        failed += 1;
        logger.error(`[metadata] missing recheck item failed mediaType=${media.mediaType} id=${media.file.id} message="${err.message}"`, err);
      }
    }

    const result = {
      running: false,
      startedAt,
      finishedAt: new Date().toISOString(),
      limit,
      checked,
      matched,
      stillMissing,
      skipped,
      failed,
      error: null
    };
    logger.info(`[metadata] missing recheck complete checked=${checked} matched=${matched} stillMissing=${stillMissing} skipped=${skipped} failed=${failed}`);
    return result;
  }

  async indexedMissingMedia(mediaIndex, limit) {
    const mediaFiles = listIndexedMediaFiles(mediaIndex.index);
    const records = await this.store.getMany(mediaFiles.map((media) => ({
      mediaType: media.mediaType,
      id: media.file.id
    })));
    const missingKeys = new Set(records
      .filter((record) => !record.found)
      .map((record) => recordKey(record.mediaType, record.mediaId)));

    return interleaveByMediaType(mediaFiles
      .filter((media) => missingKeys.has(recordKey(media.mediaType, media.file.id))))
      .slice(0, limit);
  }

  posterFilePath(filename) {
    const safeName = path.basename(filename);
    const filePath = path.join(this.posterDir, safeName);
    if (!filePath.startsWith(this.posterDir)) {
      return null;
    }
    return filePath;
  }

  async ensurePosterFile(filename) {
    const filePath = this.posterFilePath(filename);
    if (!filePath) {
      return null;
    }

    try {
      await fs.access(filePath);
      return filePath;
    } catch (err) {
      if (err.code !== "ENOENT") {
        throw err;
      }
    }

    const record = await this.store.getByPosterFilename(path.basename(filename));
    if (!record) {
      return null;
    }

    logger.full(`[metadata] poster cache miss filename="${path.basename(filename)}" provider=${record.provider} mediaType=${record.mediaType} id=${record.mediaId}`);
    const posterPath = await this.resolvePosterPathForRecord(record);
    if (!posterPath) {
      return null;
    }

    await this.cachePosterFile(posterPath, path.basename(filename));
    return filePath;
  }

  async ensureThumbnailForMedia(mediaType, mediaFile) {
    if (!isEpisodeFile(mediaFile)) {
      return { available: false, reason: "Thumbnails are only generated for TV episodes." };
    }

    const key = recordKey(mediaType, mediaFile.id);
    if (this.thumbnailInFlight.has(key)) {
      return this.thumbnailInFlight.get(key);
    }

    const task = this.resolveThumbnailForMedia(mediaType, mediaFile)
      .finally(() => {
        this.thumbnailInFlight.delete(key);
      });
    this.thumbnailInFlight.set(key, task);
    return task;
  }

  async resolveThumbnailForMedia(mediaType, mediaFile) {
    const cached = await this.store.get(mediaType, mediaFile.id);
    if (cached && cached.thumbnailFilename) {
      const filePath = this.thumbnailFilePath(cached.thumbnailFilename);
      if (filePath && await fileExists(filePath)) {
        return { available: true, filePath, filename: cached.thumbnailFilename };
      }
    }

    let record = cached;
    if (!record && metadataUnavailableReason(this.config) === null) {
      await this.getForMedia(mediaType, mediaFile);
      record = await this.store.get(mediaType, mediaFile.id);
    }

    const providerResult = record && record.found
      ? await this.tryProviderThumbnail(mediaType, mediaFile, record)
      : null;
    if (providerResult && providerResult.available) {
      return providerResult;
    }

    return this.generateLocalThumbnail(mediaType, mediaFile, record);
  }

  async tryProviderThumbnail(mediaType, mediaFile, record) {
    const kind = kindForMediaType(this.appConfig, mediaType);
    if (kind !== "tv" || !record.providerId || metadataUnavailableReason(this.config)) {
      return null;
    }

    if (record.thumbnailUnavailable && record.thumbnailUnavailableReason === "no-tmdb-still") {
      return null;
    }

    try {
      const stillPath = await this.findEpisodeStillPath(record.providerId, mediaFile.season, mediaFile.episode);
      if (!stillPath) {
        await this.saveThumbnailState(record, {
          thumbnailUnavailable: true,
          thumbnailUnavailableReason: "no-tmdb-still"
        });
        return null;
      }

      const filename = await this.cacheThumbnailFile(stillPath, thumbnailFilenameFor("tmdb-tv-episode", record.providerId, this.config.thumbnailSize, stillPath, mediaFile));
      const filePath = this.thumbnailFilePath(filename);
      await this.saveThumbnailState(record, {
        thumbnailPath: stillPath,
        thumbnailFilename: filename,
        thumbnailUnavailable: false,
        thumbnailUnavailableReason: null
      });
      return { available: true, filePath, filename };
    } catch (err) {
      logger.full(`[metadata] episode still lookup failed mediaType=${mediaType} id=${mediaFile.id} providerId=${record.providerId} message="${err.message}"`);
      return null;
    }
  }

  async findEpisodeStillPath(providerId, season, episode) {
    const seasonNumber = Number.parseInt(season, 10);
    const episodeNumber = Number.parseInt(episode, 10);
    if (!Number.isFinite(seasonNumber) || !Number.isFinite(episodeNumber)) {
      return null;
    }

    const params = new URLSearchParams({
      language: this.config.language
    });
    const data = await this.fetchJson(`${TMDB_API_BASE}/tv/${providerId}/season/${seasonNumber}/episode/${episodeNumber}?${params.toString()}`);
    return data && data.still_path || null;
  }

  async generateLocalThumbnail(mediaType, mediaFile, record) {
    if (!this.ffmpeg || !mediaFile.filePath) {
      return { available: false, reason: "Local thumbnail generation is unavailable." };
    }

    const filename = safePosterFilename(`local-${mediaType}-${mediaFile.id}-${createId(`${mediaFile.filePath}:${mediaFile.mtimeMs || ""}`)}.jpg`);
    const filePath = path.join(this.thumbnailDir, filename);
    if (!filePath.startsWith(this.thumbnailDir)) {
      return { available: false, reason: "Invalid thumbnail path." };
    }

    if (!await fileExists(filePath)) {
      await fs.mkdir(this.thumbnailDir, { recursive: true });
      try {
        await this.ffmpeg.generateThumbnail(mediaFile.filePath, filePath);
      } catch (err) {
        if (record) {
          await this.saveThumbnailState(record, {
            thumbnailUnavailable: true,
            thumbnailUnavailableReason: "ffmpeg-thumbnail-failed"
          });
        }
        logger.full(`[metadata] local thumbnail failed mediaType=${mediaType} id=${mediaFile.id} file="${mediaFile.filePath}" message="${err.message}"`);
        return { available: false, reason: "Local thumbnail generation failed." };
      }
    }

    if (record) {
      await this.saveThumbnailState(record, {
        thumbnailPath: mediaFile.filePath,
        thumbnailFilename: filename,
        thumbnailUnavailable: false,
        thumbnailUnavailableReason: null
      });
    }
    return { available: true, filePath, filename };
  }

  async saveThumbnailState(record, changes) {
    const updated = {
      ...record,
      ...changes
    };
    await this.store.save(updated);
    return updated;
  }

  thumbnailFilePath(filename) {
    const safeName = path.basename(filename);
    const filePath = path.join(this.thumbnailDir, safeName);
    if (!filePath.startsWith(this.thumbnailDir)) {
      return null;
    }
    return filePath;
  }

  async searchTmdb(query) {
    const results = await this.searchTmdbCandidates(query);
    if (results.length === 0) {
      return null;
    }

    const best = results[0];
    return best.score >= 250 ? best.result : null;
  }

  async searchTmdbCandidates(query) {
    const endpoint = query.kind === "tv" ? "search/tv" : "search/movie";
    const baseParams = {
      query: query.title,
      include_adult: "false",
      language: this.config.language,
      page: "1"
    };
    const searches = [baseParams];
    if (query.year) {
      searches.push({
        ...baseParams,
        [query.kind === "tv" ? "first_air_date_year" : "primary_release_year"]: String(query.year)
      });
    }

    const resultsById = new Map();
    for (const search of searches) {
      const params = new URLSearchParams(search);
      const url = `${TMDB_API_BASE}/${endpoint}?${params.toString()}`;
      const data = await this.fetchJson(url);
      for (const result of Array.isArray(data.results) ? data.results : []) {
        if (result.id && !resultsById.has(result.id)) {
          resultsById.set(result.id, result);
        }
      }
    }

    const results = [...resultsById.values()];
    return rankedMatches(results, query).slice(0, 12);
  }

  async fetchTmdbDetails(kind, providerId) {
    const endpoint = kind === "tv" ? "tv" : "movie";
    const params = new URLSearchParams({
      language: this.config.language
    });
    return this.fetchJson(`${TMDB_API_BASE}/${endpoint}/${encodeURIComponent(providerId)}?${params.toString()}`);
  }

  async createFoundRecord(mediaType, mediaId, kind, result) {
    const providerId = result.id ? String(result.id) : null;
    const title = kind === "tv" ? result.name : result.title;
    const releaseDate = kind === "tv" ? result.first_air_date : result.release_date;
    let posterPath = result.poster_path || await this.findPosterPath(kind, providerId);
    let posterFilename = null;
    if (posterPath) {
      try {
        posterFilename = await this.cachePoster(kind, providerId, posterPath);
      } catch (err) {
        logger.full(`[metadata] primary poster failed mediaType=${mediaType} id=${mediaId} providerId=${providerId || "none"} posterPath="${posterPath}" message="${err.message}"`);
        const fallbackPath = await this.findPosterPath(kind, providerId, posterPath);
        if (fallbackPath) {
          posterPath = fallbackPath;
          posterFilename = await this.cachePoster(kind, providerId, posterPath);
        } else {
          throw err;
        }
      }
    }

    return {
      mediaType,
      mediaId,
      found: true,
      provider: "tmdb",
      providerId,
      title: title || null,
      releaseYear: releaseDate ? Number.parseInt(String(releaseDate).slice(0, 4), 10) || null : null,
      overview: result.overview || null,
      posterPath,
      posterFilename,
      posterUnavailable: !posterPath,
      posterUnavailableReason: posterPath ? null : "no-poster-path",
      sourceJson: JSON.stringify(result)
    };
  }

  async ensurePosterForRecord(record) {
    if (!record.found || record.posterFilename) {
      return record;
    }

    const kind = kindForMediaType(this.appConfig, record.mediaType);
    if (!kind || !record.providerId) {
      return this.markPosterUnavailable(record, "missing-provider-id");
    }

    const posterPath = await this.resolvePosterPathForRecord(record);
    if (!posterPath) {
      return this.markPosterUnavailable(record, "no-poster-path");
    }

    logger.full(`[metadata] poster fallback found mediaType=${record.mediaType} id=${record.mediaId} providerId=${record.providerId} posterPath="${posterPath}"`);
    const updated = {
      ...record,
      posterPath,
      posterFilename: await this.cachePoster(kind, record.providerId, posterPath),
      posterUnavailable: false,
      posterUnavailableReason: null
    };
    await this.store.save(updated);
    return updated;
  }

  async markPosterUnavailable(record, reason) {
    if (record.posterUnavailable) {
      return record;
    }

    const updated = {
      ...record,
      posterUnavailable: true,
      posterUnavailableReason: reason
    };
    logger.full(`[metadata] poster unavailable mediaType=${record.mediaType} id=${record.mediaId} reason=${reason}`);
    await this.store.save(updated);
    return updated;
  }

  async resolvePosterPathForRecord(record) {
    const kind = kindForMediaType(this.appConfig, record.mediaType);
    if (!kind || !record.providerId) {
      return record.posterPath || null;
    }

    if (!record.posterPath) {
      const fallbackPath = await this.findPosterPath(kind, record.providerId);
      if (!fallbackPath) {
        return null;
      }

      const updated = {
        ...record,
        posterPath: fallbackPath,
        posterFilename: await this.cachePoster(kind, record.providerId, fallbackPath),
        posterUnavailable: false,
        posterUnavailableReason: null
      };
      await this.store.save(updated);
      return fallbackPath;
    }

    try {
      await this.cachePosterFile(record.posterPath, posterFilenameFor(kind, record.providerId, this.config.posterSize, record.posterPath));
      return record.posterPath;
    } catch (err) {
      logger.full(`[metadata] saved poster failed mediaType=${record.mediaType} id=${record.mediaId} posterPath="${record.posterPath}" message="${err.message}"`);
      const fallbackPath = await this.findPosterPath(kind, record.providerId, record.posterPath);
      if (!fallbackPath) {
        throw err;
      }

      const updated = {
        ...record,
        posterPath: fallbackPath,
        posterFilename: await this.cachePoster(kind, record.providerId, fallbackPath),
        posterUnavailable: false,
        posterUnavailableReason: null
      };
      await this.store.save(updated);
      return fallbackPath;
    }
  }

  async findPosterPath(kind, providerId, excludedPath = null) {
    if (!providerId) {
      return null;
    }

    const endpoint = kind === "tv" ? `tv/${providerId}/images` : `movie/${providerId}/images`;
    const params = new URLSearchParams({
      include_image_language: this.config.posterLanguages.join(",")
    });
    const data = await this.fetchJson(`${TMDB_API_BASE}/${endpoint}?${params.toString()}`);
    const posters = (Array.isArray(data.posters) ? data.posters : [])
      .filter((poster) => poster.file_path && poster.file_path !== excludedPath);
    const selected = selectPoster(posters, this.config.posterLanguages);
    return selected ? selected.file_path : null;
  }

  async cachePoster(kind, providerId, posterPath) {
    const filename = posterFilenameFor(kind, providerId, this.config.posterSize, posterPath);
    await this.cachePosterFile(posterPath, filename);
    return filename;
  }

  async cachePosterFile(posterPath, filename) {
    const safeName = safePosterFilename(filename);
    const filePath = path.join(this.posterDir, safeName);

    try {
      await fs.access(filePath);
      return safeName;
    } catch (err) {
      if (err.code !== "ENOENT") {
        throw err;
      }
    }

    await fs.mkdir(this.posterDir, { recursive: true });
    const response = await fetch(`${TMDB_IMAGE_BASE}/${this.config.posterSize}${posterPath}`);
    if (!response.ok) {
      throw new Error(`TMDb poster download failed with HTTP ${response.status}`);
    }

    await fs.writeFile(filePath, Buffer.from(await response.arrayBuffer()));
    return safeName;
  }

  async cacheThumbnailFile(thumbnailPath, filename) {
    const safeName = safePosterFilename(filename);
    const filePath = path.join(this.thumbnailDir, safeName);

    try {
      await fs.access(filePath);
      return safeName;
    } catch (err) {
      if (err.code !== "ENOENT") {
        throw err;
      }
    }

    await fs.mkdir(this.thumbnailDir, { recursive: true });
    const response = await fetch(`${TMDB_IMAGE_BASE}/${this.config.thumbnailSize}${thumbnailPath}`);
    if (!response.ok) {
      throw new Error(`TMDb thumbnail download failed with HTTP ${response.status}`);
    }

    await fs.writeFile(filePath, Buffer.from(await response.arrayBuffer()));
    return safeName;
  }

  async cacheManualPoster(mediaType, mediaId, source) {
    const sourceValue = source.url || source.filePath;
    const extension = posterExtension(sourceValue);
    const filename = safePosterFilename(`manual-${mediaType}-${mediaId}-${createId(sourceValue)}${extension}`);
    const filePath = path.join(this.posterDir, filename);

    await fs.mkdir(this.posterDir, { recursive: true });

    if (source.url) {
      const response = await fetch(source.url);
      if (!response.ok) {
        throw new Error(`Manual poster download failed with HTTP ${response.status}`);
      }

      await fs.writeFile(filePath, Buffer.from(await response.arrayBuffer()));
      return filename;
    }

    await fs.copyFile(source.filePath, filePath);
    return filename;
  }

  async fetchJson(url) {
    const headers = {
      Accept: "application/json"
    };

    if (this.config.tmdbReadAccessToken) {
      headers.Authorization = `Bearer ${this.config.tmdbReadAccessToken}`;
    }

    const requestUrl = this.config.tmdbApiKey && !this.config.tmdbReadAccessToken
      ? withApiKey(url, this.config.tmdbApiKey)
      : url;
    const response = await fetch(requestUrl, { headers });
    if (!response.ok) {
      throw new Error(`TMDb metadata lookup failed with HTTP ${response.status}`);
    }

    return response.json();
  }
}

function metadataQuery(config, mediaType, mediaFile) {
  if (kindForMediaType(config, mediaType) === "movie") {
    const parsed = splitTitleYear(mediaFile.title || mediaFile.folder || mediaFile.filename);
    return {
      kind: "movie",
      title: parsed.title,
      year: mediaFile.year || parsed.year
    };
  }

  const parsed = splitTitleYear(mediaFile.showName || mediaFile.title || mediaFile.filename);
  return {
    kind: "tv",
    title: parsed.title,
    year: parsed.year
  };
}

function kindForMediaType(config, mediaType) {
  const library = (config.libraries || []).find((entry) => entry.key === mediaType);
  return library && library.type === "movies" ? "movie" : library && library.type === "tv" ? "tv" : null;
}

function selectPoster(posters, preferredLanguages) {
  if (posters.length === 0) {
    return null;
  }

  const languageRank = new Map(preferredLanguages.map((language, index) => [language.toLowerCase(), index]));
  return [...posters].sort((a, b) => (
    posterLanguageRank(a, languageRank) - posterLanguageRank(b, languageRank)
    || (b.vote_average || 0) - (a.vote_average || 0)
    || (b.vote_count || 0) - (a.vote_count || 0)
    || (b.width || 0) - (a.width || 0)
  ))[0];
}

function posterLanguageRank(poster, languageRank) {
  const language = poster.iso_639_1 === null || poster.iso_639_1 === undefined
    ? "null"
    : String(poster.iso_639_1).toLowerCase();
  return languageRank.has(language) ? languageRank.get(language) : languageRank.size + 1;
}

function metadataQueryKey(query) {
  return `${query.kind}:${query.title.toLowerCase()}:${query.year || ""}`;
}

function listIndexedMediaFiles(index) {
  return (index.libraries || []).flatMap((library) => (
    library.type === "movies"
      ? movieFiles(index[library.key], library.key)
      : [...movieFiles(index[library.key], library.key), ...episodeFiles(index[library.key], library.key)]
  ));
}

function interleaveByMediaType(mediaFiles) {
  const groups = new Map();
  for (const media of mediaFiles) {
    const items = groups.get(media.mediaType) || [];
    items.push(media);
    groups.set(media.mediaType, items);
  }

  const result = [];
  while (groups.size > 0) {
    for (const [mediaType, items] of [...groups.entries()]) {
      const item = items.shift();
      if (item) {
        result.push(item);
      }
      if (items.length === 0) {
        groups.delete(mediaType);
      }
    }
  }

  return result;
}

function movieFiles(collection, mediaType) {
  return (collection && collection.items || []).map((file) => ({ mediaType, file }));
}

function episodeFiles(collection, mediaType) {
  return (collection && collection.shows || []).flatMap((show) => show.seasons.flatMap((season) => (
    season.episodes.map((file) => ({ mediaType, file }))
  )));
}

function copyRecordForMedia(record, mediaType, mediaId) {
  return {
    ...record,
    mediaType,
    mediaId
  };
}

function mediaFileMap(index) {
  return new Map(listIndexedMediaFiles(index).map(({ mediaType, file }) => [
    recordKey(mediaType, file.id),
    file
  ]));
}

function recordKey(mediaType, mediaId) {
  return `${mediaType}:${mediaId}`;
}

function titleForMediaFile(file) {
  if (!file) {
    return null;
  }

  return file.title || file.showName || file.folder || file.filename || null;
}

function subtitleForMediaFile(file) {
  if (!file) {
    return null;
  }

  if (file.showName) {
    return `${file.showName} S${pad(file.season)}E${pad(file.episode)}`;
  }

  return file.year ? String(file.year) : file.filename || null;
}

function pad(value) {
  return String(value || 0).padStart(2, "0");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function splitTitleYear(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(.*)\s+(?:\((\d{4})\)|\[(\d{4})\])$/);
  const year = match ? match[2] || match[3] : null;

  return {
    title: match ? match[1].trim() : text,
    year: year ? Number.parseInt(year, 10) : null
  };
}

function rankedMatches(results, query) {
  return [...results]
    .map((result, index) => ({
      result,
      score: tmdbMatchScore(result, query) - index
    }))
    .sort((a, b) => b.score - a.score);
}

function tmdbMatchScore(result, query) {
  const queryTitle = normalizeTitle(query.title);
  const candidateTitles = uniqueText([
    result.title,
    result.name,
    result.original_title,
    result.original_name
  ]).map(normalizeTitle).filter(Boolean);
  let score = 0;

  for (const title of candidateTitles) {
    if (title === queryTitle) {
      score = Math.max(score, 1000);
    } else if (title.startsWith(queryTitle) || queryTitle.startsWith(title)) {
      score = Math.max(score, 700);
    } else if (title.includes(queryTitle) || queryTitle.includes(title)) {
      score = Math.max(score, 450);
    } else {
      score = Math.max(score, sharedTokenScore(title, queryTitle));
    }
  }

  if (query.year) {
    const candidateYear = resultYear(result, query.kind);
    if (candidateYear) {
      const delta = Math.abs(candidateYear - query.year);
      if (delta === 0) {
        score += 180;
      } else if (delta <= 2) {
        score += 120;
      } else if (delta <= 5) {
        score += 70;
      } else {
        score += Math.max(0, 30 - delta);
      }
    }
  }

  score += Math.min(Number(result.vote_count) || 0, 1000) / 100;
  score += Math.min(Number(result.popularity) || 0, 200) / 20;
  return score;
}

function sharedTokenScore(left, right) {
  const leftTokens = new Set(left.split(" ").filter(Boolean));
  const rightTokens = right.split(" ").filter(Boolean);
  if (leftTokens.size === 0 || rightTokens.length === 0) {
    return 0;
  }

  const matches = rightTokens.filter((token) => leftTokens.has(token)).length;
  if (matches === 0) {
    return 0;
  }

  return Math.floor((matches / rightTokens.length) * 300);
}

function resultYear(result, kind) {
  const date = kind === "tv" ? result.first_air_date : result.release_date;
  return date ? Number.parseInt(String(date).slice(0, 4), 10) || null : null;
}

function normalizeManualMetadataQuery(defaultQuery, input = {}) {
  const rawTitle = String(input.title || "").trim();
  const rawYear = input.year === null || input.year === undefined ? "" : String(input.year).trim();
  const split = rawTitle ? splitTitleYear(rawTitle) : { title: defaultQuery.title, year: defaultQuery.year };
  const parsedYear = rawYear ? Number.parseInt(rawYear, 10) : split.year;

  return {
    ...defaultQuery,
    title: split.title || defaultQuery.title,
    year: Number.isFinite(parsedYear) && parsedYear > 0 ? parsedYear : null
  };
}

function toPublicCandidate(candidate, kind) {
  const result = candidate.result;
  const title = kind === "tv" ? result.name : result.title;
  const originalTitle = kind === "tv" ? result.original_name : result.original_title;
  const date = kind === "tv" ? result.first_air_date : result.release_date;
  const year = date ? Number.parseInt(String(date).slice(0, 4), 10) || null : null;

  return {
    provider: "tmdb",
    providerId: result.id ? String(result.id) : null,
    title: title || originalTitle || "Untitled",
    originalTitle: originalTitle || null,
    year,
    overview: result.overview || "",
    posterPath: result.poster_path || null,
    posterUrl: result.poster_path ? `${TMDB_IMAGE_BASE}/w185${result.poster_path}` : null,
    score: Math.round(candidate.score),
    popularity: Number(result.popularity) || 0,
    voteCount: Number(result.vote_count) || 0
  };
}

function normalizeTitle(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function metadataUnavailableReason(config) {
  if (!config.enabled) {
    return { available: false, cached: false, reason: "Metadata lookup is disabled." };
  }
  if (config.provider !== "tmdb") {
    return { available: false, cached: false, reason: `Unsupported metadata provider: ${config.provider}` };
  }
  if (!config.tmdbReadAccessToken && !config.tmdbApiKey) {
    return { available: false, cached: false, reason: "TMDb credentials are not configured." };
  }

  return null;
}

function createMissingRecord(mediaType, mediaId, provider) {
  return {
    mediaType,
    mediaId,
    found: false,
    provider,
    providerId: null,
    title: null,
    releaseYear: null,
    overview: null,
    posterPath: null,
    posterFilename: null,
    posterUnavailable: false,
    posterUnavailableReason: null,
    thumbnailPath: null,
    thumbnailFilename: null,
    thumbnailUnavailable: false,
    thumbnailUnavailableReason: null,
    sourceJson: null
  };
}

function createManualRecord(mediaType, mediaFile) {
  return {
    mediaType,
    mediaId: mediaFile.id,
    found: true,
    provider: "manual",
    providerId: null,
    title: titleForMediaFile(mediaFile),
    releaseYear: mediaFile.year || null,
    overview: null,
    posterPath: null,
    posterFilename: null,
    posterUnavailable: false,
    posterUnavailableReason: null,
    thumbnailPath: null,
    thumbnailFilename: null,
    thumbnailUnavailable: false,
    thumbnailUnavailableReason: null,
    sourceJson: null
  };
}

function toPublicRecord(record, cached) {
  if (!record.found) {
    return {
      available: false,
      cached,
      provider: record.provider
    };
  }

  return {
    available: true,
    cached,
    provider: record.provider,
    providerId: record.providerId,
    title: record.title,
    aliases: metadataAliases(record),
    releaseYear: record.releaseYear,
    overview: record.overview,
    posterFilename: record.posterFilename,
    posterUnavailable: Boolean(record.posterUnavailable),
    posterUnavailableReason: record.posterUnavailableReason || null
  };
}

function isEpisodeFile(mediaFile) {
  return mediaFile
    && mediaFile.showId
    && mediaFile.season !== null
    && mediaFile.season !== undefined
    && mediaFile.episode !== null
    && mediaFile.episode !== undefined;
}

function metadataAliases(record) {
  const source = parseSourceJson(record.sourceJson);
  return uniqueText([
    source && source.title,
    source && source.name,
    source && source.original_title,
    source && source.original_name
  ].filter((value) => value && value !== record.title));
}

function parseSourceJson(value) {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch (err) {
    return null;
  }
}

function uniqueText(values) {
  const seen = new Set();
  return values.filter((value) => {
    const text = String(value || "").trim();
    const key = text.toLowerCase();
    if (!text || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function withApiKey(url, apiKey) {
  const requestUrl = new URL(url);
  requestUrl.searchParams.set("api_key", apiKey);
  return requestUrl.toString();
}

function posterFilenameFor(kind, providerId, posterSize, posterPath) {
  const extension = path.extname(posterPath) || ".jpg";
  return safePosterFilename(`tmdb-${kind}-${providerId || createId(posterPath)}-${posterSize}${extension}`);
}

function thumbnailFilenameFor(kind, providerId, thumbnailSize, thumbnailPath, mediaFile) {
  const extension = path.extname(thumbnailPath) || ".jpg";
  return safePosterFilename(`${kind}-${providerId || createId(thumbnailPath)}-s${pad(mediaFile.season)}e${pad(mediaFile.episode)}-${thumbnailSize}${extension}`);
}

function posterExtension(value) {
  const extension = path.extname(urlishPath(value)).toLowerCase();
  return [".jpg", ".jpeg", ".png", ".webp"].includes(extension) ? extension : ".jpg";
}

function urlishPath(value) {
  try {
    return new URL(value).pathname;
  } catch (err) {
    return String(value || "");
  }
}

function safePosterFilename(value) {
  return value.replace(/[^a-z0-9._-]/gi, "_");
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (err) {
    if (err.code === "ENOENT") {
      return false;
    }
    throw err;
  }
}

module.exports = { MetadataService };
