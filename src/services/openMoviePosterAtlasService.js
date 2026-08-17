const crypto = require("crypto");
const fs = require("fs/promises");
const logger = require("../utils/logger");

const LAYOUT_VERSION = 1;
const SLOTS_PER_ATLAS = 12;
const RENDERER_SIGNATURE = "openmovie-poster-atlas-v1-1200x1350-4x3-edge-copy-q88";
const MOVIE_ARTWORK_SIGNATURE = "movie-artwork-v2-labelled-placeholder";
const SHOW_ARTWORK_SIGNATURE = "parent-show-artwork-v5-labelled-placeholder";

class OpenMoviePosterAtlasService {
  constructor(store, imageProcessor, artwork, idStore) {
    this.store = store;
    this.imageProcessor = imageProcessor;
    this.artwork = artwork;
    this.idStore = idStore;
    this.collectionOperations = new Map();
    this.renderOperations = new Map();
    this.episodeIdMapPromise = null;
    this.lastCleanupAt = 0;
  }

  async init() {
    await this.store.init();
    await this.cleanupExpired(true);
  }

  async decorateMovies(entries) {
    const byLibrary = groupBy(entries, (entry) => entry.library.key);
    for (const libraryEntries of byLibrary.values()) {
      const library = libraryEntries[0].library;
      await this.ensureCollection({
        libraryKey: library.key,
        kind: "movies",
        key: `movies:${library.key}`,
        items: libraryEntries.map((entry) => ({
          entityKey: String(entry.output.id),
          output: entry.output
        }))
      });
    }
    entries.sort(compareAtlasEntries);
  }

  async decorateTv(entries) {
    this.episodeIdMapPromise = null;
    const showsByLibrary = groupBy(entries, (entry) => entry.library.key);
    for (const libraryEntries of showsByLibrary.values()) {
      const library = libraryEntries[0].library;
      await this.ensureCollection({
        libraryKey: library.key,
        kind: "shows",
        key: `shows:${library.key}`,
        items: libraryEntries.map((entry) => ({
          entityKey: String(entry.show.id),
          output: entry.output
        }))
      });

      for (const entry of libraryEntries) {
        await this.ensureCollection({
          libraryKey: library.key,
          kind: "seasons",
          key: collectionKey("seasons", library.key, entry.show.id),
          items: entry.seasons.map((season) => ({
            entityKey: String(season.output.season),
            output: season.output
          }))
        });
        for (const season of entry.seasons) {
          await this.ensureCollection({
            libraryKey: library.key,
            kind: "episodes",
            key: collectionKey("episodes", library.key, entry.show.id, season.output.season),
            items: season.episodes.map((episode) => ({
              entityKey: String(episode.output.id),
              output: episode.output
            }))
          });
        }
      }
    }
    for (const entry of entries) {
      entry.seasons.sort(compareAtlasEntries);
      entry.output.seasons = entry.seasons.map((season) => {
        season.episodes.sort(compareAtlasEntries);
        season.output.episodes = season.episodes.map((episode) => episode.output);
        return season.output;
      });
    }
    entries.sort(compareAtlasEntries);
  }

  async decorateEpisodes(entries) {
    const bySeason = groupBy(entries, (entry) => (
      collectionKey("episodes", entry.library.key, entry.showId, entry.season)
    ));
    for (const seasonEntries of bySeason.values()) {
      const first = seasonEntries[0];
      await this.ensureCollection({
        libraryKey: first.library.key,
        kind: "episodes",
        key: collectionKey("episodes", first.library.key, first.showId, first.season),
        items: seasonEntries.map((entry) => ({
          entityKey: String(entry.id),
          output: entry.output
        }))
      });
    }
  }

  async ensureCollection(collection) {
    if (!collection.items.length) return;
    const operationKey = `${collection.kind}:${collection.key}`;
    const previous = this.collectionOperations.get(operationKey) || Promise.resolve();
    const operation = previous.then(() => this.ensureCollectionNow(collection));
    const tracked = operation.catch(() => {});
    this.collectionOperations.set(operationKey, tracked);
    try {
      await operation;
    } finally {
      if (this.collectionOperations.get(operationKey) === tracked) this.collectionOperations.delete(operationKey);
    }
  }

  async ensureCollectionNow(collection) {
    const currentPages = await this.store.currentPages(collection.kind, collection.key);
    const itemMap = new Map(collection.items.map((item) => [item.entityKey, item]));
    const orderedEntityKeys = [];
    const seenEntityKeys = new Set();
    for (const page of currentPages.sort((first, second) => first.page - second.page)) {
      for (const slot of normalizedPageSlots(page.slots)) {
        if (!slot.entityKey || !itemMap.has(slot.entityKey) || seenEntityKeys.has(slot.entityKey)) continue;
        orderedEntityKeys.push(slot.entityKey);
        seenEntityKeys.add(slot.entityKey);
      }
    }
    for (const item of collection.items) {
      if (seenEntityKeys.has(item.entityKey)) continue;
      orderedEntityKeys.push(item.entityKey);
      seenEntityKeys.add(item.entityKey);
    }

    const pages = [];
    for (let offset = 0; offset < orderedEntityKeys.length; offset += SLOTS_PER_ATLAS) {
      const entityKeys = orderedEntityKeys.slice(offset, offset + SLOTS_PER_ATLAS);
      pages.push({
        page: Math.floor(offset / SLOTS_PER_ATLAS),
        slots: Array.from({ length: SLOTS_PER_ATLAS }, (_, slot) => ({
          slot,
          entityKey: entityKeys[slot] || null
        }))
      });
    }

    const currentByPage = new Map(currentPages.map((page) => [page.page, page]));
    const assignmentMap = new Map();
    for (const page of pages) {
      const slots = normalizedPageSlots(page.slots);
      const contentSignature = crypto.createHash("sha256").update(JSON.stringify({
        renderer: rendererSignature(collection.kind),
        layout: LAYOUT_VERSION,
        slots: slots.map((slot) => slot.entityKey)
      })).digest("hex");

      const current = currentByPage.get(page.page);
      let published = current;
      if (!current || current.layout !== LAYOUT_VERSION || current.contentSignature !== contentSignature) {
        published = await this.publishPage(collection, page.page, slots, contentSignature);
      }
      for (const slot of slots) {
        if (!slot.entityKey || !itemMap.has(slot.entityKey)) continue;
        assignmentMap.set(slot.entityKey, {
          id: published.id,
          slot: slot.slot,
          page: published.page,
          layout: published.layout
        });
      }
    }
    await this.store.removeCurrentPagesFrom(collection.kind, collection.key, pages.length);

    for (const item of collection.items) {
      const assignment = assignmentMap.get(item.entityKey);
      if (!assignment) throw new Error(`Poster atlas assignment was not created for ${collection.key}:${item.entityKey}`);
      item.output.posterAtlas = assignment;
    }
  }

  async publishPage(collection, page, slots, contentSignature) {
    const id = await this.store.reserve({
      libraryKey: collection.libraryKey,
      collectionKind: collection.kind,
      collectionKey: collection.key,
      page,
      layout: LAYOUT_VERSION,
      contentSignature
    });
    const filename = `atlas-${id}.webp`;
    try {
      await fs.rm(this.store.filePath(filename), { force: true });
      await this.store.publish(id, filename, slots);
      logger.info(`[openmovie] poster atlas registered id=${id} library=${collection.libraryKey} collection=${collection.kind} page=${page}`);
      return {
        id,
        page,
        layout: LAYOUT_VERSION,
        contentSignature,
        filename,
        slots
      };
    } catch (err) {
      await this.store.fail(id);
      throw err;
    }
  }

  async resolve(id, allowedLibraryKeys = null) {
    const atlas = await this.store.resolve(id);
    if (!atlas) return null;
    if (Array.isArray(allowedLibraryKeys) && !allowedLibraryKeys.includes(atlas.libraryKey)) {
      return { forbidden: true, atlas };
    }
    const cached = await this.ensureCached(atlas);
    return { atlas, ...cached, forbidden: false };
  }

  async renderOnDeck(items, allowedLibraryKeys = null) {
    if (!this.imageProcessor || typeof this.imageProcessor.createPosterAtlasBuffer !== "function") {
      throw new Error("In-memory poster atlas rendering is unavailable");
    }
    const artworkPaths = [];
    for (const item of (items || []).slice(0, SLOTS_PER_ATLAS)) {
      artworkPaths.push(await this.resolveOnDeckArtwork(item, allowedLibraryKeys));
    }
    return this.imageProcessor.createPosterAtlasBuffer(artworkPaths, this.artwork.placeholderPath);
  }

  async resolveOnDeckArtwork(item, allowedLibraryKeys) {
    const kind = item && item.showTitle ? "episode" : "movie";
    const mapping = item && await this.idStore.resolve(kind, item.id);
    if (!mapping || (Array.isArray(allowedLibraryKeys) && !allowedLibraryKeys.includes(mapping.libraryKey))) {
      return this.artwork.placeholderPath;
    }
    const library = this.artwork.mediaIndex.libraryForKey(mapping.libraryKey);
    if (!library) return this.artwork.placeholderPath;
    const media = kind === "episode"
      ? await this.artwork.mediaIndex.getEpisode(mapping.mediaId, library.key)
      : await this.artwork.mediaIndex.getMovie(mapping.mediaId, library.key);
    if (!media) return this.artwork.placeholderPath;
    const resolved = { id: mapping.id, library, item: media };
    return kind === "episode"
      ? this.artwork.resolvedEpisode(resolved, "season")
      : this.artwork.resolvedMovie(resolved);
  }

  async ensureCached(atlas) {
    await this.cleanupExpired(false);
    const window = this.cacheWindow();
    const filePath = this.store.filePath(`atlas-${atlas.id}-${window.bucket}.webp`);
    if (!filePath) throw new Error(`Poster atlas ${atlas.id} has an invalid cache filename`);
    const cached = await existingFile(filePath);
    if (cached) return cacheResult(filePath, atlas.id, window);

    const operationKey = `${atlas.id}:${window.bucket}`;
    if (this.renderOperations.has(operationKey)) return this.renderOperations.get(operationKey);
    const operation = this.renderAtlas(atlas, filePath, window)
      .finally(() => this.renderOperations.delete(operationKey));
    this.renderOperations.set(operationKey, operation);
    return operation;
  }

  async renderAtlas(atlas, filePath, window) {
    const cached = await existingFile(filePath);
    if (cached) return cacheResult(filePath, atlas.id, window);
    const artworkPaths = [];
    const context = atlas.collectionKind === "shows"
      ? { episodeIds: await this.openMovieEpisodeIds() }
      : null;
    for (const slot of normalizedPageSlots(atlas.slots)) {
      artworkPaths.push(await this.resolveArtwork(atlas, slot.entityKey, context));
    }
    try {
      await this.imageProcessor.createPosterAtlas(artworkPaths, filePath, this.artwork.placeholderPath);
      logger.info(`[openmovie] poster atlas rendered id=${atlas.id} ttlSeconds=${this.cacheTtlSeconds()}`);
      return cacheResult(filePath, atlas.id, window);
    } catch (err) {
      await fs.rm(filePath, { force: true });
      throw err;
    }
  }

  async resolveArtwork(atlas, entityKey, context = null) {
    if (!entityKey) return this.artwork.placeholderPath;
    const library = this.artwork.mediaIndex.libraryForKey(atlas.libraryKey);
    if (!library) return this.artwork.placeholderPath;
    let fallbackLabel = null;
    try {
      if (atlas.collectionKind === "movies") {
        const mapping = await this.idStore.resolve("movie", entityKey);
        const item = mapping && mapping.libraryKey === library.key
          ? await this.artwork.mediaIndex.getMovie(mapping.mediaId, library.key)
          : null;
        fallbackLabel = item && item.title;
        return item ? await this.artwork.movie(library, item) : this.artwork.placeholderPath;
      }
      if (atlas.collectionKind === "shows") {
        const show = await this.artwork.mediaIndex.getShow(entityKey, library.key);
        fallbackLabel = show && show.name;
        const episodeId = show && firstOpenMovieEpisodeId(show, library.key, context && context.episodeIds);
        return this.artwork.show(library, show, { episodeId });
      }
      if (atlas.collectionKind === "seasons") {
        const showId = collectionOwner(atlas.collectionKey, "seasons", library.key);
        const show = showId && await this.artwork.mediaIndex.getShow(showId, library.key);
        const seasonNumber = Number.parseInt(entityKey, 10);
        const season = show && (show.seasons || []).find((entry) => Number.parseInt(entry.season, 10) === seasonNumber);
        return season ? await this.artwork.season(library, show, season) : this.artwork.placeholderPath;
      }
      if (atlas.collectionKind === "episodes") {
        const mapping = await this.idStore.resolve("episode", entityKey);
        const item = mapping && mapping.libraryKey === library.key
          ? await this.artwork.mediaIndex.getEpisode(mapping.mediaId, library.key)
          : null;
        if (!item) return this.artwork.placeholderPath;
        const context = await this.artwork.episodeContext({ library, item });
        return this.artwork.episode(library, context.show, context.season, item);
      }
    } catch (err) {
      logger.full(`[openmovie] poster atlas artwork fallback id=${atlas.id} entity=${entityKey} message="${err.message}"`);
      if (atlas.collectionKind === "movies" || atlas.collectionKind === "shows") {
        const unknownLabel = atlas.collectionKind === "movies" ? "Unknown movie" : "Unknown show";
        return this.artwork.labelledPlaceholder(fallbackLabel, unknownLabel);
      }
    }
    return this.artwork.placeholderPath;
  }

  async openMovieEpisodeIds() {
    if (!this.episodeIdMapPromise) {
      this.episodeIdMapPromise = this.idStore.mappings("episode")
        .then((mappings) => new Map(mappings.map((mapping) => [
          `${mapping.libraryKey}:${mapping.mediaId}`,
          mapping.id
        ])))
        .catch((err) => {
          this.episodeIdMapPromise = null;
          throw err;
        });
    }
    return this.episodeIdMapPromise;
  }

  cacheTtlSeconds() {
    return Math.max(1, Number.parseInt(this.store.config.hls && this.store.config.hls.ttlSeconds, 10) || 86400);
  }

  cacheWindow() {
    const ttlSeconds = this.cacheTtlSeconds();
    const durationMs = ttlSeconds * 1000;
    const now = Date.now();
    const bucket = Math.floor(now / durationMs);
    return {
      bucket,
      ttlSeconds
    };
  }

  async cleanupExpired(force) {
    const now = Date.now();
    if (!force && now - this.lastCleanupAt < 60 * 60 * 1000) return;
    this.lastCleanupAt = now;
    const ttlMs = this.cacheTtlSeconds() * 1000;
    const entries = await fs.readdir(this.store.imageDirectory, { withFileTypes: true }).catch((err) => {
      if (err.code === "ENOENT") return [];
      throw err;
    });
    let removed = 0;
    for (const entry of entries) {
      if (!entry.isFile() || !/^atlas-\d+(?:-\d+)?\.webp$/.test(entry.name)) continue;
      const filePath = this.store.filePath(entry.name);
      const stats = await fs.stat(filePath).catch(() => null);
      if (!stats || now - stats.mtimeMs < ttlMs) continue;
      await fs.rm(filePath, { force: true });
      removed += 1;
    }
    if (removed > 0) logger.info(`[openmovie] expired poster atlas cache removed=${removed}`);
  }
}

function normalizedPageSlots(slots) {
  const bySlot = new Map((slots || []).map((slot) => [Number(slot.slot), slot.entityKey || null]));
  return Array.from({ length: SLOTS_PER_ATLAS }, (_, slot) => ({
    slot,
    entityKey: bySlot.get(slot) || null
  }));
}

function rendererSignature(collectionKind) {
  if (collectionKind === "movies") {
    return `${RENDERER_SIGNATURE}:${MOVIE_ARTWORK_SIGNATURE}`;
  }
  return collectionKind === "shows"
    ? `${RENDERER_SIGNATURE}:${SHOW_ARTWORK_SIGNATURE}`
    : RENDERER_SIGNATURE;
}

function firstOpenMovieEpisodeId(show, libraryKey, episodeIds) {
  if (!episodeIds) return null;
  for (const episode of showEpisodes(show)) {
    const id = episodeIds.get(`${libraryKey}:${episode.id}`);
    if (id) return id;
  }
  return null;
}

function showEpisodes(show) {
  return (show && show.seasons || [])
    .flatMap((season) => season.episodes || [])
    .sort((first, second) => (
      (Number(first.season) || 0) - (Number(second.season) || 0)
      || (Number(first.episode) || 0) - (Number(second.episode) || 0)
      || String(first.title || "").localeCompare(String(second.title || ""))
    ));
}

function collectionKey(...parts) {
  return parts.map((part) => String(part === null || part === undefined ? "unknown" : part)).join(":");
}

function groupBy(values, selector) {
  const groups = new Map();
  for (const value of values || []) {
    const key = selector(value);
    const group = groups.get(key) || [];
    group.push(value);
    groups.set(key, group);
  }
  return groups;
}

async function existingFile(filePath) {
  try {
    return await fs.stat(filePath);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    return null;
  }
}

function cacheResult(filePath, atlasId, window) {
  const expiresAt = (window.bucket + 1) * window.ttlSeconds * 1000;
  return {
    filePath,
    ttlSeconds: Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)),
    etag: `"atlas-${atlasId}-${window.bucket}"`
  };
}

function collectionOwner(key, kind, libraryKey) {
  const prefix = `${kind}:${libraryKey}:`;
  return String(key || "").startsWith(prefix) ? String(key).slice(prefix.length) : null;
}

function compareAtlasEntries(first, second) {
  const firstAtlas = first.output.posterAtlas;
  const secondAtlas = second.output.posterAtlas;
  const firstLibrary = first.library && first.library.key || "";
  const secondLibrary = second.library && second.library.key || "";
  return firstLibrary.localeCompare(secondLibrary)
    || firstAtlas.page - secondAtlas.page
    || firstAtlas.slot - secondAtlas.slot;
}

module.exports = { OpenMoviePosterAtlasService };
