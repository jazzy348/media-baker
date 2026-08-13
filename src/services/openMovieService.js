const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const { LABELLED_PLACEHOLDER_VERSION } = require("./openMovieArtworkService");
const logger = require("../utils/logger");
const { getMediaPlaybackOptions } = require("./mediaOptions");

class OpenMovieService {
  constructor(mediaIndex, idStore, metadata, ffmpeg, subtitles, posterAtlases = null) {
    this.mediaIndex = mediaIndex;
    this.idStore = idStore;
    this.metadata = metadata;
    this.ffmpeg = ffmpeg;
    this.subtitles = subtitles;
    this.posterAtlases = posterAtlases;
    this.syncOperation = Promise.resolve();
    this.variantSyncOperation = Promise.resolve();
    this.variantItemOperations = new Map();
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

  async movieCatalogue(allowedLibraryKeys = null, offset = 1) {
    await this.syncOperation;
    const minimumId = minimumOpenMovieId(offset);
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
    const variants = await this.variantMap("movie", libraries.map((library) => library.key));

    const entries = movies.map(({ id, library, item }) => {
      const record = metadata.get(mappingKey(library.key, item.id));
      const playbackVariants = variants.get(mappingKey(library.key, item.id)) || [];
      return { library, item, output: {
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
        posterUrl: `/api/openmovie/movies/${id}/poster?fallbackVersion=${LABELLED_PLACEHOLDER_VERSION}`,
        playbackUrl: `/api/openmovie/movies/${id}/play`,
        playbackVariants
      } };
    });
    if (this.posterAtlases) await this.posterAtlases.decorateMovies(entries);
    return entries
      .map((entry) => entry.output)
      .filter((movie) => movie.id >= minimumId);
  }

  async tvCatalogue(allowedLibraryKeys = null, offset = 1) {
    await this.syncOperation;
    const minimumId = minimumOpenMovieId(offset);
    const libraries = this.mediaLibraries(allowedLibraryKeys).filter((library) => library.type === "tv");
    const records = await this.collectMedia(libraries);
    const ids = mappingMap(await this.idStore.mappings("episode"));
    const visibleShows = records.shows.filter(({ library, show }) => (
      showEpisodes(show).some((episode) => ids.has(mappingKey(library.key, episode.id)))
    ));
    const metadataRefs = [];
    for (const { library, show } of visibleShows) {
      metadataRefs.push({ mediaType: library.key, id: show.id });
      for (const episode of showEpisodes(show)) {
        metadataRefs.push({ mediaType: library.key, id: episode.id });
      }
    }
    const metadata = await this.cachedMetadata(metadataRefs);
    const seasonMetadataByShow = this.metadata && this.metadata.getCachedSeasonMetadataForShows
      ? await this.metadata.getCachedSeasonMetadataForShows(visibleShows.map(({ library, show }) => ({
        mediaType: library.key,
        show
      })))
      : new Map();
    const variants = await this.variantMap("episode", libraries.map((library) => library.key));

    const showEntries = visibleShows.map(({ library, show }) => {
      const seasonMetadata = seasonMetadataByShow.get(mappingKey(library.key, show.id)) || new Map();
      const seasonEntries = [...(show.seasons || [])]
        .sort((first, second) => (Number(first.season) || 0) - (Number(second.season) || 0))
        .map((season) => {
        const episodeEntries = [...(season.episodes || [])]
          .sort((first, second) => (
            (Number(first.episode) || 0) - (Number(second.episode) || 0)
            || String(first.title || "").localeCompare(String(second.title || ""))
          ))
          .map((episode) => {
            const output = openMovieEpisode(library, episode, ids, metadata, variants);
            return output ? { item: episode, output } : null;
          })
          .filter(Boolean);
        const episodes = episodeEntries.map((entry) => entry.output);
        const details = seasonMetadata.get(Number(season.season)) || {};
        return { season, episodes: episodeEntries, output: {
          season: numberOrNull(season.season),
          title: details.name || season.name || defaultSeasonName(season.season),
          overview: details.overview || "",
          airDate: details.airDate || null,
          year: numberOrNull(details.year),
          episodeCount: episodes.length,
          providerId: details.providerId || null,
          posterUrl: episodes.length > 0 ? `/api/openmovie/episodes/${episodes[0].id}/season-poster` : null,
          episodes
        } };
      });
      const seasons = seasonEntries.map((entry) => entry.output);
      const episodes = seasons.flatMap((season) => season.episodes);
      const showRecord = metadata.get(mappingKey(library.key, show.id))
        || firstAvailableMetadata(show, library, metadata);
      return { library, show, seasons: seasonEntries, output: {
        library: library.key,
        libraryTitle: library.title,
        title: metadataTitle(showRecord, show.name),
        originalTitle: show.name,
        year: metadataYear(showRecord, null),
        overview: metadataOverview(showRecord),
        aliases: metadataAliases(showRecord),
        provider: metadataValue(showRecord, "provider"),
        providerId: metadataValue(showRecord, "providerId"),
        posterUrl: episodes.length > 0
          ? `${episodes[0].posterUrl}?art=show&fallbackVersion=${LABELLED_PLACEHOLDER_VERSION}`
          : null,
        episodeCount: episodes.length,
        seasons
      } };
    });
    showEntries.sort((first, second) => (
      first.output.title.localeCompare(second.output.title)
      || first.output.library.localeCompare(second.output.library)
    ));
    if (this.posterAtlases) await this.posterAtlases.decorateTv(showEntries);
    return showEntries
      .map((entry) => filterOpenMovieShowByOffset(entry.output, minimumId))
      .filter(Boolean);
  }

  async onDeckCatalogue(items, allowedLibraryKeys = null) {
    await this.syncOperation;
    const cards = Array.isArray(items) ? items : [];
    const libraries = this.mediaLibraries(allowedLibraryKeys);
    const libraryByKey = new Map(libraries.map((library) => [library.key, library]));
    const resolved = [];
    for (const card of cards) {
      const library = libraryByKey.get(card.mediaType);
      if (!library) continue;
      const kind = library.type === "tv" ? "episode" : "movie";
      const item = kind === "episode"
        ? await this.mediaIndex.getEpisode(card.id, library.key)
        : await this.mediaIndex.getMovie(card.id, library.key);
      if (item) resolved.push({ card, kind, library, item });
    }
    if (resolved.length === 0) return [];

    const movieIds = mappingMap(await this.idStore.mappings("movie"));
    const episodeIds = mappingMap(await this.idStore.mappings("episode"));
    const metadataRefs = [];
    for (const entry of resolved) {
      metadataRefs.push({ mediaType: entry.library.key, id: entry.item.id });
      if (entry.kind === "episode" && entry.item.showId) {
        metadataRefs.push({ mediaType: entry.library.key, id: entry.item.showId });
      }
    }
    const metadata = await this.cachedMetadata(metadataRefs);
    const movieLibraryKeys = uniqueStrings(resolved
      .filter((entry) => entry.kind === "movie")
      .map((entry) => entry.library.key));
    const episodeLibraryKeys = uniqueStrings(resolved
      .filter((entry) => entry.kind === "episode")
      .map((entry) => entry.library.key));
    const [movieVariants, episodeVariants] = await Promise.all([
      this.variantMap("movie", movieLibraryKeys),
      this.variantMap("episode", episodeLibraryKeys)
    ]);

    const outputByMedia = new Map();
    const outputs = resolved.map(({ card, kind, library, item }) => {
      const ids = kind === "episode" ? episodeIds : movieIds;
      const id = ids.get(mappingKey(library.key, item.id));
      if (!id) return null;
      const record = metadata.get(mappingKey(library.key, item.id));
      const variants = kind === "episode" ? episodeVariants : movieVariants;
      const output = {
        id,
        library: library.key,
        title: kind === "episode" ? item.title : metadataTitle(record, item.title),
        year: metadataYear(record, item.year),
        overview: metadataOverview(record),
        playbackUrl: `/api/openmovie/${kind === "episode" ? "episodes" : "movies"}/${id}/play`,
        playbackVariants: variants.get(mappingKey(library.key, item.id)) || [],
        progress: card.progress,
        onDeckReason: card.onDeckReason
      };
      if (kind === "episode") {
        const showRecord = metadata.get(mappingKey(library.key, item.showId));
        output.showTitle = metadataTitle(showRecord, item.showName);
        output.season = numberOrNull(item.season);
        output.episode = numberOrNull(item.episode);
      }
      outputByMedia.set(mappingKey(library.key, item.id), output);
      return output;
    }).filter(Boolean);

    if (this.posterAtlases) {
      const selectedLibraryKeys = new Set(resolved.map((entry) => entry.library.key));
      const records = await this.collectMedia(libraries.filter((library) => selectedLibraryKeys.has(library.key)));
      const selectedMovieLibraries = new Set(movieLibraryKeys);
      const movieAtlasEntries = records.movies
        .filter(({ library }) => selectedMovieLibraries.has(library.key))
        .map(({ library, item }) => {
          const id = movieIds.get(mappingKey(library.key, item.id));
          return id ? {
            library,
            item,
            output: outputByMedia.get(mappingKey(library.key, item.id)) || { id }
          } : null;
        })
        .filter(Boolean);
      if (movieAtlasEntries.length > 0) await this.posterAtlases.decorateMovies(movieAtlasEntries);

      const selectedSeasons = new Set(resolved
        .filter((entry) => entry.kind === "episode")
        .map((entry) => episodeCollectionKey(entry.library.key, entry.item.showId, entry.item.season)));
      const episodeAtlasEntries = [];
      for (const { library, show } of records.shows) {
        for (const season of show.seasons || []) {
          if (!selectedSeasons.has(episodeCollectionKey(library.key, show.id, season.season))) continue;
          for (const item of season.episodes || []) {
            const id = episodeIds.get(mappingKey(library.key, item.id));
            if (!id) continue;
            episodeAtlasEntries.push({
              library,
              showId: show.id,
              season: season.season,
              id,
              output: outputByMedia.get(mappingKey(library.key, item.id)) || { id }
            });
          }
        }
      }
      if (episodeAtlasEntries.length > 0) await this.posterAtlases.decorateEpisodes(episodeAtlasEntries);
    }

    return outputs;
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

  async resolveVariant(id, allowedLibraryKeys = null) {
    await this.syncOperation;
    const variant = await this.idStore.resolveVariant(id);
    if (!variant || !canAccessLibrary(variant.libraryKey, allowedLibraryKeys)) return null;
    const library = this.mediaIndex.libraryForKey(variant.libraryKey);
    if (!library) return null;
    const item = variant.kind === "episode"
      ? library.type === "tv" && await this.mediaIndex.getEpisode(variant.mediaId, variant.libraryKey)
      : library.type === "movies" && await this.mediaIndex.getMovie(variant.mediaId, variant.libraryKey);
    return item ? { variant, library, item } : null;
  }

  async refreshVariants(mediaType, mediaId) {
    const library = this.mediaIndex.libraryForKey(mediaType);
    if (!library || (library.type !== "movies" && library.type !== "tv")) return false;
    const kind = library.type === "tv" ? "episode" : "movie";
    const item = kind === "episode"
      ? await this.mediaIndex.getEpisode(mediaId, library.key)
      : await this.mediaIndex.getMovie(mediaId, library.key);
    if (!item) return false;

    const sourceSignature = await mediaSourceSignature(item, new Map());
    await this.syncVariantItem(kind, library, item, sourceSignature);
    return true;
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
    this.queueVariantSync(libraryKey);
  }

  queueVariantSync(libraryKey = null) {
    const task = this.variantSyncOperation.then(() => this.syncLibraryVariants(libraryKey));
    this.variantSyncOperation = task.catch((err) => {
      logger.error(`[openmovie] playback variant sync failed message="${err.message}"`, err);
    });
  }

  async syncLibraryVariants(libraryKey = null) {
    if (!this.ffmpeg) return;
    const libraries = this.mediaLibraries(null).filter((library) => !libraryKey || library.key === libraryKey);
    if (libraries.length === 0) return;
    const records = await this.collectMedia(libraries);
    const items = [
      ...records.movies.map(({ library, item }) => ({ kind: "movie", library, item })),
      ...records.episodes.map(({ library, item }) => ({ kind: "episode", library, item }))
    ];
    const signatures = new Map((await this.idStore.variantSourceSignatures()).map((entry) => [
      variantSourceMapKey(entry.kind, entry.libraryKey, entry.mediaId),
      entry.sourceSignature
    ]));
    let unchanged = 0;
    let synchronised = 0;
    let failed = 0;
    const directorySignatures = new Map();
    logger.info(`[openmovie] playback variant sync starting files=${items.length}${libraryKey ? ` library=${libraryKey}` : ""}`);

    for (const { kind, library, item } of items) {
      const sourceSignature = await mediaSourceSignature(item, directorySignatures);
      const key = variantSourceMapKey(kind, library.key, item.id);
      if (signatures.get(key) === sourceSignature) {
        unchanged += 1;
        continue;
      }
      try {
        await this.syncVariantItem(kind, library, item, sourceSignature);
        synchronised += 1;
      } catch (err) {
        failed += 1;
        logger.full(`[openmovie] playback variant discovery failed file="${item.filePath}" message="${err.message}"`);
      }
    }

    logger.info(
      `[openmovie] playback variant sync complete files=${items.length}`
      + ` synchronised=${synchronised} unchanged=${unchanged} failed=${failed}`
    );
  }

  async syncVariantItem(kind, library, item, sourceSignature) {
    const key = variantSourceMapKey(kind, library.key, item.id);
    const previous = this.variantItemOperations.get(key) || Promise.resolve();
    const task = previous.then(async () => {
      const options = await getMediaPlaybackOptions(item, this.ffmpeg, {
        library,
        mediaType: library.key,
        subtitles: this.subtitles
      });
      const variants = playbackVariantsForOptions(options);
      await this.idStore.syncVariants(kind, library.key, item.id, sourceSignature, variants);
    });
    const queuedTask = task.catch(() => {});
    this.variantItemOperations.set(key, queuedTask);
    try {
      await task;
    } finally {
      if (this.variantItemOperations.get(key) === queuedTask) this.variantItemOperations.delete(key);
    }
  }

  async variantMap(kind, libraryKeys) {
    const grouped = new Map();
    for (const variant of await this.idStore.variants(kind, libraryKeys)) {
      const key = mappingKey(variant.libraryKey, variant.mediaId);
      const entries = grouped.get(key) || [];
      entries.push(openMoviePlaybackVariant(variant));
      grouped.set(key, entries);
    }
    for (const entries of grouped.values()) {
      entries.sort((first, second) => Number(second.default) - Number(first.default) || first.id - second.id);
    }
    return grouped;
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

function openMovieEpisode(library, episode, ids, metadata, variants) {
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
    playbackUrl: `/api/openmovie/episodes/${id}/play`,
    playbackVariants: variants.get(mappingKey(library.key, episode.id)) || []
  };
}

function filterOpenMovieShowByOffset(show, minimumId) {
  const seasons = (show.seasons || []).map((season) => {
    const episodes = (season.episodes || []).filter((episode) => episode.id >= minimumId);
    return episodes.length > 0
      ? { ...season, episodeCount: episodes.length, episodes }
      : null;
  }).filter(Boolean);
  if (seasons.length === 0) return null;
  return {
    ...show,
    episodeCount: seasons.reduce((total, season) => total + season.episodeCount, 0),
    seasons
  };
}

function playbackVariantsForOptions(options) {
  const audioOptions = Array.isArray(options.audio) ? options.audio : [];
  const subtitleOptions = Array.isArray(options.subtitles) && options.subtitles.length > 0
    ? options.subtitles
    : [{ id: "none", language: "none", label: "No subtitles", source: "none" }];
  const variants = [];
  for (let audioIndex = 0; audioIndex < audioOptions.length; audioIndex += 1) {
    const audio = storedAudioOption(audioOptions[audioIndex]);
    for (const subtitleOption of subtitleOptions) {
      const subtitle = subtitleOption.id === "none" ? null : storedSubtitleOption(subtitleOption);
      variants.push({
        key: variantOptionKey(audio, subtitle),
        audio,
        subtitle,
        default: audioIndex === 0 && !subtitle
      });
    }
  }
  return variants;
}

function storedAudioOption(option) {
  return {
    selector: option.id,
    language: option.language || "unknown",
    label: option.label || option.language || "Audio",
    channels: numberOrNull(option.channels),
    channelLayout: option.channelLayout || null
  };
}

function storedSubtitleOption(option) {
  return {
    selector: option.id,
    language: option.language || "unknown",
    label: option.label || option.language || "Subtitles",
    source: option.source || "embedded",
    forced: Boolean(option.forced)
  };
}

function variantOptionKey(audio, subtitle) {
  return crypto.createHash("sha256")
    .update(JSON.stringify({ audio, subtitle }))
    .digest("hex")
    .slice(0, 32);
}

async function mediaSourceSignature(item, directorySignatures) {
  const directory = path.dirname(item.filePath);
  let directorySignature = directorySignatures.get(directory);
  if (directorySignature === undefined) {
    try {
      const stats = await fs.stat(directory);
      directorySignature = Number(stats.mtimeMs) || 0;
    } catch (err) {
      directorySignature = 0;
    }
    directorySignatures.set(directory, directorySignature);
  }
  return crypto.createHash("sha256")
    .update(JSON.stringify({
      filePath: item.filePath,
      sizeBytes: Number(item.sizeBytes) || 0,
      mtimeMs: Number(item.mtimeMs) || 0,
      directoryMtimeMs: directorySignature
    }))
    .digest("hex")
    .slice(0, 32);
}

function variantSourceMapKey(kind, libraryKey, mediaId) {
  return `${kind}:${libraryKey}:${mediaId}`;
}

function openMoviePlaybackVariant(variant) {
  return {
    id: variant.id,
    audio: publicAudioOption(variant.audio),
    subtitle: variant.subtitle ? publicSubtitleOption(variant.subtitle) : null,
    default: Boolean(variant.default),
    playbackUrl: `/api/openmovie/play/${variant.id}`
  };
}

function publicAudioOption(audio) {
  return {
    language: audio.language,
    label: audio.label,
    channels: audio.channels,
    channelLayout: audio.channelLayout
  };
}

function publicSubtitleOption(subtitle) {
  return {
    language: subtitle.language,
    label: subtitle.label,
    source: subtitle.source,
    forced: Boolean(subtitle.forced)
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

function episodeCollectionKey(libraryKey, showId, season) {
  return `${libraryKey}:${showId}:${Number(season) || 0}`;
}

function uniqueStrings(values) {
  return [...new Set(values)];
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

function minimumOpenMovieId(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
}

function firstAvailableMetadata(show, library, metadata) {
  for (const episode of showEpisodes(show)) {
    const record = metadata.get(mappingKey(library.key, episode.id));
    if (record && record.available) return record;
  }
  return null;
}

module.exports = { OpenMovieService };
