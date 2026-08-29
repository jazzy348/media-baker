class PlaybackSyncService {
  constructor({ accountService, mediaIndex, metadataStore, progress }) {
    this.accountService = accountService;
    this.mediaIndex = mediaIndex;
    this.metadataStore = metadataStore;
    this.progress = progress;
    this.catalogCache = null;
    this.catalogPromise = null;
  }

  invalidateCatalog() {
    this.catalogCache = null;
  }

  async accounts() {
    return (await this.accountService.list()).map((account) => ({
      id: account.id,
      username: account.username
    }));
  }

  async catalog(offset = 0, limit = 500) {
    const items = await this.catalogItems();
    const safeOffset = Math.max(0, Number.parseInt(offset, 10) || 0);
    const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 500, 1000));
    return {
      items: items.slice(safeOffset, safeOffset + safeLimit),
      offset: safeOffset,
      limit: safeLimit,
      total: items.length,
      hasMore: safeOffset + safeLimit < items.length
    };
  }

  async import(userId, records) {
    const account = await this.accountService.findById(String(userId || "").trim());
    if (!account) throw Object.assign(new Error("Media Baker account not found"), { status: 404 });
    const catalog = await this.catalogItems();
    const allowed = new Set(catalog.map((item) => `${item.mediaType}:${item.mediaId}`));
    for (const record of records || []) {
      if (!allowed.has(`${record.mediaType}:${record.mediaId}`)) {
        throw Object.assign(new Error(`Media item not found: ${record.mediaType}:${record.mediaId}`), { status: 404 });
      }
    }
    return this.progress.importRecords(account.id, records);
  }

  async catalogItems() {
    if (this.catalogCache) return this.catalogCache;
    if (this.catalogPromise) return this.catalogPromise;
    this.catalogPromise = this.buildCatalog();
    try {
      this.catalogCache = await this.catalogPromise;
      return this.catalogCache;
    } finally {
      this.catalogPromise = null;
    }
  }

  async buildCatalog() {
    const pending = [];
    const refs = [];
    for (const library of this.mediaIndex.config.libraries) {
      if (library.trackProgress === false || !["movies", "tv"].includes(library.type)) continue;
      const collection = await this.mediaIndex.loadCollection(library.key, library.type);
      if (library.type === "movies") {
        for (const movie of collection.items || []) {
          pending.push({ kind: "movie", library, media: movie });
          refs.push({ mediaType: library.key, id: movie.id });
        }
        continue;
      }
      for (const show of collection.shows || []) {
        refs.push({ mediaType: library.key, id: show.id });
        for (const season of show.seasons || []) {
          for (const episode of season.episodes || []) {
            pending.push({ kind: "episode", library, media: episode, show });
            refs.push({ mediaType: library.key, id: episode.id });
          }
        }
      }
    }
    const records = await this.metadataStore.getMany(refs);
    const metadata = new Map(records.map((record) => [`${record.mediaType}:${record.mediaId}`, record]));
    return pending.map(({ kind, library, media, show }) => {
      const record = metadata.get(`${library.key}:${media.id}`);
      const showRecord = show && metadata.get(`${library.key}:${show.id}`);
      return {
        kind,
        mediaType: library.key,
        mediaId: media.id,
        libraryTitle: library.title,
        title: record && record.title || media.title || media.name || media.filename,
        year: Number(record && record.releaseYear || media.year) || null,
        showTitle: show ? showRecord && showRecord.title || show.name : null,
        season: kind === "episode" ? Number(media.season) : null,
        episode: kind === "episode" ? Number(media.episode) : null,
        durationSeconds: Number(media.durationSeconds) || 0,
        providerIds: providerIds(record),
        showProviderIds: providerIds(showRecord)
      };
    });
  }
}

function providerIds(record) {
  if (!record) return {};
  const result = {};
  const provider = normalizeProvider(record.provider);
  if (provider && record.providerId) result[provider] = String(record.providerId);
  const source = parseJson(record.sourceJson);
  collectProviderIds(source, result);
  const episodeProviderId = source && source.mediaBakerEpisode && source.mediaBakerEpisode.providerId;
  if (episodeProviderId) result[provider || "tmdb"] = String(episodeProviderId);
  return result;
}

function collectProviderIds(value, result, depth = 0) {
  if (!value || depth > 4) return;
  if (Array.isArray(value)) {
    for (const entry of value) collectProviderIds(entry, result, depth + 1);
    return;
  }
  if (typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    const provider = normalizeProvider(key.replace(/_id$/i, ""));
    if (provider && /(?:_id|providerids?)$/i.test(key) && ["string", "number"].includes(typeof entry)) {
      result[provider] = String(entry);
    } else if (/^providerids?$/i.test(key) && entry && typeof entry === "object") {
      for (const [name, id] of Object.entries(entry)) {
        const namedProvider = normalizeProvider(name);
        if (namedProvider && id !== null && id !== undefined) result[namedProvider] = String(id);
      }
    }
    collectProviderIds(entry, result, depth + 1);
  }
}

function normalizeProvider(value) {
  const key = String(value || "").trim().toLowerCase();
  return { tmdb: "tmdb", themoviedb: "tmdb", imdb: "imdb", tvdb: "tvdb" }[key] || null;
}

function parseJson(value) {
  try { return typeof value === "string" ? JSON.parse(value) : value; } catch (err) { return null; }
}

module.exports = { PlaybackSyncService };
