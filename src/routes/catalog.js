const express = require("express");
const path = require("path");
const { getMediaPlaybackOptions } = require("../services/mediaOptions");
const { resolveMediaFile } = require("../services/mediaResolver");
const { httpError } = require("../utils/httpErrors");

module.exports = function createCatalogRoutes({ config, mediaIndex, ffmpeg, hls, metadata, subtitles, playbackTokens }) {
  const router = express.Router();

  router.get("/home", async (req, res, next) => {
    try {
      const categories = categoriesForRequest(config, req);
      const mode = homeMode(req.query.mode);
      const rows = await Promise.all(categories.map(async (category) => {
        const allItems = itemsForCategory(mediaIndex, category);
        const items = homeItems(allItems, mode, 18);
        return {
          key: category.key,
          title: category.title,
          total: category.kind === "episode" ? libraryItemsForCategory(mediaIndex, category).length : allItems.length,
          items: await withCachedMetadata(items, metadata, authContext(req))
        };
      }));

      res.json({
        generatedAt: mediaIndex.index.generatedAt,
        mode,
        rows
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/search", async (req, res, next) => {
    try {
      const query = String(req.query.q || "").trim();
      const categories = categoriesForRequest(config, req);
      const allItems = categories.flatMap((category) => searchItemsForCategory(mediaIndex, category));
      const enrichedItems = await withCachedMetadata(allItems, metadata, authContext(req));
      const results = fuzzySearch(enrichedItems, query).slice(0, 60);

      res.json({
        query,
        results
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/libraries/:mediaType/items", async (req, res, next) => {
    try {
      const category = categoryForMediaType(config, req, req.params.mediaType);
      if (!category) {
        next(httpError(404, "Library not found"));
        return;
      }

      const offset = offsetValue(req.query.offset);
      const limit = limitValue(req.query.limit);
      const sort = librarySortMode(req.query.sort);
      const metadataFilter = metadataFilterMode(req.query.metadata || req.query.filter);
      let allItems = libraryItemsForCategory(mediaIndex, category);
      if (metadataFilter === "unmatched") {
        requireMetadataManagement(req);
        allItems = await unmatchedMetadataItems(allItems, metadata);
      }
      allItems = sortLibraryItems(allItems, sort);
      const pageItems = allItems.slice(offset, offset + limit);

      res.json({
        key: category.key,
        title: category.title,
        total: allItems.length,
        offset,
        limit,
        sort,
        metadataFilter,
        nextOffset: offset + pageItems.length,
        hasMore: offset + pageItems.length < allItems.length,
        items: await withCachedMetadata(pageItems, metadata, authContext(req))
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/metadata/posters/unavailable", async (req, res, next) => {
    try {
      requireMetadataManagement(req);
      const items = (await metadata.listPosterUnavailable(mediaIndex, req.query.limit))
        .filter((item) => canAccessLibrary(req, item.mediaType));
      res.json({
        total: items.length,
        items
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/metadata/recheck-missing", async (req, res, next) => {
    try {
      requireMetadataManagement(req);
      res.json(metadata.missingRecheckStatus());
    } catch (err) {
      next(err);
    }
  });

  router.post("/metadata/recheck-missing", async (req, res, next) => {
    try {
      requireMetadataManagement(req);
      const body = req.body || {};
      res.status(202).json(metadata.startMissingRecheck(mediaIndex, {
        limit: body.limit || req.query.limit
      }));
    } catch (err) {
      next(err);
    }
  });

  router.get("/:mediaType/:id/options", async (req, res, next) => {
    try {
      assertMediaAccess(req, req.params.mediaType);
      const mediaFile = await resolveMediaFile(mediaIndex, req.params.mediaType, req.params.id);
      const library = mediaIndex.libraryForKey(req.params.mediaType);
      const options = await getMediaPlaybackOptions(mediaFile, ffmpeg, {
        library,
        subtitles,
        mediaType: req.params.mediaType
      });
      res.json({
        item: itemFromMediaFile(req.params.mediaType, mediaFile),
        playbackToken: playbackTokens.createStreamToken(req.params.mediaType, mediaFile.id, req.user && req.user.id || "global"),
        ...options
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/metadata/poster/:filename", async (req, res, next) => {
    try {
      if ((req.allowedLibraryKey || Array.isArray(req.allowedLibraryKeys)) && metadata.getCachedByPosterFilename) {
        const record = await metadata.getCachedByPosterFilename(req.params.filename);
        if (!record || !canAccessLibrary(req, record.mediaType)) {
          next(httpError(404, "Poster not found"));
          return;
        }
      }

      const filePath = await metadata.ensurePosterFile(req.params.filename);
      if (!filePath) {
        next(httpError(404, "Poster not found"));
        return;
      }

      res.type(contentTypeForPoster(filePath));
      res.sendFile(filePath, (err) => {
        if (err) {
          next(httpError(err.statusCode || 404, "Poster not found"));
        }
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/:mediaType/:id/metadata/thumbnail", async (req, res, next) => {
    try {
      assertMediaAccess(req, req.params.mediaType);
      const mediaFile = await resolveMediaFile(mediaIndex, req.params.mediaType, req.params.id);
      const result = await metadata.ensureThumbnailForMedia(req.params.mediaType, mediaFile);
      if (!result.available || !result.filePath) {
        next(httpError(404, result.reason || "Thumbnail not found"));
        return;
      }

      res.type(contentTypeForImage(result.filePath));
      res.sendFile(result.filePath, (err) => {
        if (err) {
          next(httpError(err.statusCode || 404, "Thumbnail not found"));
        }
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/:mediaType/:id/metadata/season-poster", async (req, res, next) => {
    try {
      assertMediaAccess(req, req.params.mediaType);
      const mediaFile = await resolveMediaFile(mediaIndex, req.params.mediaType, req.params.id);
      const result = await metadata.ensureSeasonPosterForMedia(req.params.mediaType, mediaFile);
      if (!result.available || !result.filePath) {
        next(httpError(404, result.reason || "Season poster not found"));
        return;
      }

      res.set("Cache-Control", "private, max-age=86400");
      res.type(contentTypeForImage(result.filePath));
      res.sendFile(result.filePath, (err) => {
        if (err) {
          next(httpError(err.statusCode || 404, "Season poster not found"));
        }
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/:mediaType/:id/metadata", async (req, res, next) => {
    try {
      assertMediaAccess(req, req.params.mediaType);
      if (librarySkipsMetadata(mediaIndex, req.params.mediaType)) {
        const mediaFile = await resolveMediaFile(mediaIndex, req.params.mediaType, req.params.id);
        res.json({
          available: false,
          cached: false,
          provider: "local",
          providerId: null,
          title: mediaFile.title || mediaFile.filename,
          aliases: [],
          releaseYear: mediaFile.year || null,
          overview: "",
          posterFilename: null,
          posterUrl: null
        });
        return;
      }
      const mediaFile = await resolveMediaFile(mediaIndex, req.params.mediaType, req.params.id);
      const result = await metadata.getForMedia(req.params.mediaType, mediaFile);
      res.json({
        ...result,
        posterUrl: result.posterFilename ? metadata.posterUrl(result.posterFilename, req.authToken, req.authParamName) : null
      });
    } catch (err) {
      next(err);
    }
  });

  router.post("/:mediaType/:id/metadata/refresh", async (req, res, next) => {
    try {
      requireMetadataManagement(req);
      assertMediaAccess(req, req.params.mediaType);
      const mediaFile = await resolveMediaFile(mediaIndex, req.params.mediaType, req.params.id);
      const result = await metadata.refreshForMedia(req.params.mediaType, mediaFile);
      res.json({
        ...result,
        posterUrl: result.posterFilename ? metadata.posterUrl(result.posterFilename, req.authToken, req.authParamName) : null
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/:mediaType/:id/metadata/search", async (req, res, next) => {
    try {
      requireMetadataManagement(req);
      assertMediaAccess(req, req.params.mediaType);
      const target = await resolveMetadataTarget(mediaIndex, req.params.mediaType, req.params.id);
      const result = await metadata.searchCandidatesForMedia(req.params.mediaType, target.mediaFile, {
        title: req.query.title,
        year: req.query.year
      });
      res.json({
        ...result,
        target: target.publicTarget
      });
    } catch (err) {
      next(err);
    }
  });

  router.post("/:mediaType/:id/metadata/match", async (req, res, next) => {
    try {
      requireMetadataManagement(req);
      assertMediaAccess(req, req.params.mediaType);
      const providerId = stringOrNull(req.body.providerId);
      if (!providerId) {
        next(httpError(400, "providerId is required"));
        return;
      }

      const target = await resolveMetadataTarget(mediaIndex, req.params.mediaType, req.params.id);
      const result = await metadata.matchProviderForMedia(req.params.mediaType, target.mediaFile, {
        providerId
      });
      res.json({
        ...result,
        target: target.publicTarget,
        posterUrl: result.posterFilename ? metadata.posterUrl(result.posterFilename, req.authToken, req.authParamName) : null
      });
    } catch (err) {
      next(err);
    }
  });

  router.post("/:mediaType/:id/metadata/poster", async (req, res, next) => {
    try {
      requireMetadataManagement(req);
      assertMediaAccess(req, req.params.mediaType);
      const posterUrl = stringOrNull(req.body.posterUrl || req.body.url);
      const posterFilePath = stringOrNull(req.body.posterFilePath || req.body.posterPath || req.body.filePath);
      if (!posterUrl && !posterFilePath) {
        next(httpError(400, "posterUrl or posterFilePath is required"));
        return;
      }

      const mediaFile = await resolveMediaFile(mediaIndex, req.params.mediaType, req.params.id);
      const result = await metadata.setPosterForMedia(req.params.mediaType, mediaFile, {
        url: posterUrl,
        filePath: posterUrl ? null : posterFilePath
      });

      res.json({
        ...result,
        posterUrl: result.posterFilename ? metadata.posterUrl(result.posterFilename, req.authToken, req.authParamName) : null
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/:mediaType/:id/subtitles/search", async (req, res, next) => {
    try {
      assertMediaAccess(req, req.params.mediaType);
      const library = mediaIndex.libraryForKey(req.params.mediaType);
      if (library && library.noSubtitles) {
        res.json({ enabled: false, provider: null, candidates: [] });
        return;
      }
      const mediaFile = await resolveMediaFile(mediaIndex, req.params.mediaType, req.params.id);
      const cachedMetadata = metadata && metadata.getCachedForMedia
        ? await metadata.getCachedForMedia(req.params.mediaType, mediaFile.id)
        : null;
      const result = await subtitles.search(req.params.mediaType, mediaFile, {
        language: req.query.language,
        metadata: cachedMetadata
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  router.post("/:mediaType/:id/subtitles/select", async (req, res, next) => {
    try {
      requireAdmin(req);
      const candidateId = stringOrNull(req.body.candidateId);
      if (!candidateId) {
        next(httpError(400, "candidateId is required"));
        return;
      }

      const mediaFile = await resolveMediaFile(mediaIndex, req.params.mediaType, req.params.id);
      const option = await subtitles.download(req.params.mediaType, mediaFile, candidateId);
      res.json({
        ok: true,
        subtitle: option
      });
    } catch (err) {
      next(err);
    }
  });

  router.post("/:mediaType/:id/pregenerate", async (req, res, next) => {
    try {
      requireAdmin(req);
      const mediaFile = await resolveMediaFile(mediaIndex, req.params.mediaType, req.params.id);
      const stream = await hls.prepare(mediaFile, {
        audio: req.body.audio,
        subtitle: req.body.subtitle,
        audioChannels: req.body.audioChannels || req.body.audioMode || req.body.channelMode,
        quality: req.body.quality
      });

      res.json({
        ok: true,
        cacheKey: stream.cacheKey,
        playlistPath: stream.playlistPath
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
};

function itemsForCategory(mediaIndex, category) {
  if (category.kind === "movie") {
    return mediaIndex.collection(category.collection, "movies").items.map((movie) => ({
      id: movie.id,
      mediaType: category.mediaType,
      category: category.title,
      title: movie.title,
      subtitle: movie.year ? String(movie.year) : movie.filename,
      filePath: movie.filePath,
      localThumbnail: Boolean(category.localThumbnails),
      addedAtMs: movie.addedAtMs || movie.mtimeMs || 0,
      searchText: "",
      fallbackSearchText: movie.title
    }));
  }

  const collection = mediaIndex.collection(category.collection, "tv");
  const episodes = collection.shows.flatMap((show) => show.seasons.flatMap((season) => season.episodes.map((episode) => ({
    id: episode.id,
    mediaType: category.mediaType,
    category: category.title,
    title: episode.title || episode.filename,
    subtitle: `${episode.showName} S${pad(episode.season)}E${pad(episode.episode)}`,
    showId: episode.showId,
    showName: episode.showName,
    season: episode.season,
    episode: episode.episode,
    filePath: episode.filePath,
    localThumbnail: Boolean(category.localThumbnails),
    addedAtMs: episode.addedAtMs || episode.mtimeMs || 0,
    searchText: episodeNumberSearchText(episode),
    fallbackSearchText: ""
  }))));
  const looseItems = (collection.items || []).map((movie) => ({
    id: movie.id,
    mediaType: category.mediaType,
    category: category.title,
    title: movie.title,
    subtitle: movie.year ? String(movie.year) : movie.filename,
    filePath: movie.filePath,
    localThumbnail: Boolean(category.localThumbnails),
    addedAtMs: movie.addedAtMs || movie.mtimeMs || 0,
    searchText: "",
    fallbackSearchText: movie.title
  }));

  return [...episodes, ...looseItems];
}

function searchItemsForCategory(mediaIndex, category) {
  if (category.kind === "movie") {
    return itemsForCategory(mediaIndex, category);
  }

  return [
    ...libraryItemsForCategory(mediaIndex, category),
    ...itemsForCategory(mediaIndex, category)
  ];
}

function libraryItemsForCategory(mediaIndex, category) {
  if (category.kind === "movie") {
    return itemsForCategory(mediaIndex, category);
  }

  const collection = mediaIndex.collection(category.collection, "tv");
  const shows = collection.shows.map((show) => {
    const episodes = show.seasons.flatMap((season) => season.episodes);
    const episodeCount = episodes.length;
    const firstEpisode = episodes[0] || null;
    const addedAtMs = episodes.reduce((latest, episode) => Math.max(latest, episode.addedAtMs || episode.mtimeMs || 0), 0);
    return {
      id: show.id,
      mediaType: category.mediaType,
      category: category.title,
      itemType: "show",
      kind: "show",
      title: show.name,
      subtitle: `${show.seasons.length} seasons - ${episodeCount} episodes`,
      showId: show.id,
      showName: show.name,
      metadataId: firstEpisode ? firstEpisode.id : null,
      metadataIds: episodes.map((episode) => episode.id),
      addedAtMs,
      localThumbnail: Boolean(category.localThumbnails),
      searchText: "",
      fallbackSearchText: show.name
    };
  });
  const looseItems = (collection.items || []).map((movie) => ({
    id: movie.id,
    mediaType: category.mediaType,
    category: category.title,
    title: movie.title,
    subtitle: movie.year ? String(movie.year) : movie.filename,
    filePath: movie.filePath,
    localThumbnail: Boolean(category.localThumbnails),
    addedAtMs: movie.addedAtMs || movie.mtimeMs || 0,
    searchText: "",
    fallbackSearchText: movie.title
  }));

  return [...shows, ...looseItems];
}

function itemFromMediaFile(mediaType, mediaFile) {
  return {
    id: mediaFile.id,
    mediaType,
    title: mediaFile.title || mediaFile.filename,
    showId: mediaFile.showId,
    showName: mediaFile.showName,
    season: mediaFile.season,
    episode: mediaFile.episode,
    subtitle: mediaFile.showName
      ? `${mediaFile.showName} S${pad(mediaFile.season)}E${pad(mediaFile.episode)}`
      : mediaFile.year ? String(mediaFile.year) : mediaFile.filename
  };
}

function randomItems(items, limit) {
  return [...items]
    .map((item) => ({ item, sort: Math.random() }))
    .sort((a, b) => a.sort - b.sort)
    .slice(0, limit)
    .map(({ item }) => item);
}

function homeItems(items, mode, limit) {
  if (mode === "random") {
    return randomItems(items, limit);
  }

  return recentlyAddedItems(items, limit);
}

function recentlyAddedItems(items, limit) {
  return [...items]
    .sort((a, b) => (b.addedAtMs || 0) - (a.addedAtMs || 0) || a.title.localeCompare(b.title))
    .slice(0, limit);
}

function homeMode(value) {
  return String(value || "").toLowerCase() === "random" ? "random" : "recent";
}

function sortLibraryItems(items, mode = "alpha") {
  if (mode === "recent") {
    return [...items].sort((a, b) => (b.addedAtMs || 0) - (a.addedAtMs || 0) || a.title.localeCompare(b.title));
  }

  return [...items].sort((a, b) => {
    if (a.showName || b.showName) {
      return String(a.showName || "").localeCompare(String(b.showName || ""))
        || (a.season || 0) - (b.season || 0)
        || (a.episode || 0) - (b.episode || 0)
        || a.title.localeCompare(b.title);
    }

    return a.title.localeCompare(b.title)
      || String(a.subtitle || "").localeCompare(String(b.subtitle || ""));
  });
}

async function unmatchedMetadataItems(items, metadata) {
  if (!metadata || !metadata.getCachedForMediaItems) {
    return [];
  }

  const refs = items.flatMap((item) => metadataIdsForItem(item).map((id) => ({
    mediaType: item.mediaType,
    id
  })));
  const cachedByKey = await metadata.getCachedForMediaItems(refs);

  return items.filter((item) => {
    const ids = metadataIdsForItem(item);
    if (ids.length === 0) {
      return false;
    }

    const cachedRecords = ids
      .map((id) => cachedByKey.get(`${item.mediaType}:${id}`))
      .filter(Boolean);
    return cachedRecords.length > 0 && cachedRecords.every((record) => !record.available);
  });
}

function librarySortMode(value) {
  return String(value || "").toLowerCase() === "recent" ? "recent" : "alpha";
}

function metadataFilterMode(value) {
  return String(value || "").toLowerCase() === "unmatched" ? "unmatched" : "all";
}

function offsetValue(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function limitValue(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return 72;
  }

  return Math.max(1, Math.min(parsed, 120));
}

function fuzzySearch(items, query) {
  if (!query) {
    return randomItems(items, 30);
  }

  const tokens = searchTokens(query);
  return items
    .map((item) => ({ item, score: searchScore(item, tokens) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.item.title.localeCompare(b.item.title))
    .map((entry) => entry.item);
}

function searchScore(item, tokens) {
  const metadataScore = weightedFuzzyScore(item.metadataTitle, tokens, 1000000);
  if (metadataScore > 0) {
    return metadataScore + (item.itemType === "show" ? 2000000 : 0);
  }

  const aliasScore = weightedFuzzyScore((item.metadataAliases || []).join(" "), tokens, 500000);
  if (aliasScore > 0) {
    return aliasScore + (item.itemType === "show" ? 2000000 : 0);
  }

  if (!item.metadataTitle && (!item.metadataAliases || item.metadataAliases.length === 0)) {
    const fallbackScore = weightedFuzzyScore(item.fallbackSearchText, tokens, 100000);
    if (fallbackScore > 0) {
      return fallbackScore + (item.itemType === "show" ? 2000000 : 0);
    }
  }

  return fuzzyScore(String(item.searchText || "").toLowerCase(), tokens);
}

function weightedFuzzyScore(text, tokens, boost) {
  const score = fuzzyScore(String(text || "").toLowerCase(), tokens);
  return score > 0 ? score + boost : 0;
}

function fuzzyScore(text, tokens) {
  const normalized = normalizeSearchText(text);
  if (!normalized || tokens.length === 0) {
    return 0;
  }

  const words = normalized.split(" ");
  let score = 0;
  for (const token of tokens) {
    const tokenScore = tokenWordScore(words, token);
    if (tokenScore === 0) {
      return 0;
    }

    score += tokenScore;
  }

  const phrase = tokens.join(" ");
  if (normalized.includes(phrase)) {
    score += phrase.length * 10;
  }
  return score;
}

function tokenWordScore(words, token) {
  if (words.includes(token)) {
    return token.length * 8;
  }

  if (token.length >= 2 && words.some((word) => word.startsWith(token))) {
    return token.length * 5;
  }

  if (token.length >= 3 && words.some((word) => word.includes(token))) {
    return token.length * 3;
  }

  return 0;
}

function searchTokens(value) {
  return normalizeSearchText(value).split(" ").filter(Boolean);
}

function normalizeSearchText(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function pad(value) {
  return String(value || 0).padStart(2, "0");
}

function stringOrNull(value) {
  const text = String(value || "").trim();
  return text || null;
}

async function withCachedMetadata(items, metadata, authContextValue) {
  if (!metadata || !metadata.getCachedForMediaItems) {
    return items;
  }

  const metadataItems = items.filter((item) => !item.localThumbnail);
  const refs = metadataItems.flatMap((item) => metadataIdsForItem(item).map((id) => ({
    mediaType: item.mediaType,
    id
  })));
  const cachedByKey = await metadata.getCachedForMediaItems(refs);
  const auth = typeof authContextValue === "object"
    ? authContextValue
    : { token: authContextValue, paramName: "authToken" };
  const thumbnailOnlyItems = items.filter((item) => item.localThumbnail);
  if (thumbnailOnlyItems.length > 0 && metadataItems.length === 0) {
    return thumbnailOnlyItems.map((item) => ({
      ...item,
      thumbnailUrl: thumbnailUrlForItem(item, auth)
    }));
  }
  return items.map((item) => {
    if (item.localThumbnail) {
      return {
        ...item,
        thumbnailUrl: thumbnailUrlForItem(item, auth)
      };
    }
    const episodeItem = isEpisodeCatalogItem(item);
    const thumbnailUrl = episodeItem
      ? metadata.thumbnailUrl(item.mediaType, item.id, auth.token, auth.paramName)
      : item.thumbnailUrl;
    const seasonPosterUrl = episodeItem
      ? metadata.seasonPosterUrl(item.mediaType, item.id, auth.token, auth.paramName)
      : null;
    const cached = metadataIdsForItem(item)
      .map((id) => cachedByKey.get(`${item.mediaType}:${id}`))
      .find((record) => record && record.available);
    if (!cached || !cached.available) {
      return {
        ...item,
        thumbnailUrl,
        seasonPosterUrl
      };
    }

    const title = cached.title || item.title;
    return {
      ...item,
      title,
      metadataTitle: cached.title || null,
      metadataAliases: cached.aliases || [],
      posterUrl: cached.posterFilename ? metadata.posterUrl(cached.posterFilename, auth.token, auth.paramName) : item.posterUrl,
      thumbnailUrl,
      seasonPosterUrl,
      searchText: uniqueText([
        item.searchText
      ]).join(" ")
    };
  });
}

function isEpisodeCatalogItem(item) {
  return item
    && item.itemType !== "show"
    && item.showId
    && item.season !== null
    && item.season !== undefined
    && item.episode !== null
    && item.episode !== undefined;
}

function metadataIdsForItem(item) {
  return uniqueText([
    item.metadataId,
    item.id,
    ...(Array.isArray(item.metadataIds) ? item.metadataIds : [])
  ]);
}

function episodeNumberSearchText(item) {
  if (item.season === null || item.season === undefined || item.episode === null || item.episode === undefined) {
    return "";
  }

  const season = Number.parseInt(item.season, 10);
  const episode = Number.parseInt(item.episode, 10);
  if (!Number.isFinite(season) || !Number.isFinite(episode)) {
    return "";
  }

  return uniqueText([
    `S${pad(season)}E${pad(episode)}`,
    `S${season}E${episode}`,
    `${season}x${episode}`,
    `${pad(season)}x${pad(episode)}`,
    `${season}${pad(episode)}`,
    `season ${season} episode ${episode}`,
    `season ${pad(season)} episode ${pad(episode)}`,
    `episode ${episode}`,
    `episode ${pad(episode)}`
  ]).join(" ");
}

function uniqueText(values) {
  const seen = new Set();
  return values
    .map((value) => String(value || "").trim())
    .filter((value) => {
      const key = value.toLowerCase();
      if (!value || seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
}

function categoriesForRequest(config, req) {
  return config.libraries
    .filter((library) => canAccessLibrary(req, library.key))
    .map((library) => ({
      key: library.key,
      mediaType: library.key,
      title: library.title,
      collection: library.key,
      kind: library.type === "tv" ? "episode" : "movie",
      localThumbnails: Boolean(library.localThumbnails),
      noMetadata: Boolean(library.noMetadata),
      noSubtitles: Boolean(library.noSubtitles)
    }));
}

function categoryForMediaType(config, req, mediaType) {
  return categoriesForRequest(config, req).find((entry) => entry.mediaType === mediaType) || null;
}

function assertMediaAccess(req, mediaType) {
  if (!canAccessLibrary(req, mediaType)) {
    throw httpError(404, "Library not found");
  }
}

function requireAdmin(req) {
  if (req.authMode !== "admin") {
    throw httpError(403, "Admin access required");
  }
}

function requireMetadataManagement(req) {
  const permissions = req.user && req.user.permissions || {};
  if (req.authMode !== "admin" && !permissions.canManageMetadata) {
    throw httpError(403, "Metadata management access required");
  }
}

function librarySkipsMetadata(mediaIndex, mediaType) {
  const library = mediaIndex.libraryForKey(mediaType);
  return Boolean(library && library.noMetadata);
}

async function resolveMetadataTarget(mediaIndex, mediaType, id) {
  const library = mediaIndex.libraryForKey(mediaType);
  if (!library) {
    throw httpError(404, "Library not found");
  }

  if (library.type !== "tv") {
    const mediaFile = await resolveMediaFile(mediaIndex, mediaType, id);
    return {
      mediaFile,
      publicTarget: {
        id: mediaFile.id,
        type: "movie",
        title: mediaFile.title || mediaFile.filename
      }
    };
  }

  const episode = mediaIndex.getEpisode(id, library.key);
  if (episode) {
    return {
      mediaFile: episode,
      publicTarget: {
        id: episode.id,
        type: "episode",
        title: episode.title || episode.filename,
        showId: episode.showId,
        showName: episode.showName
      }
    };
  }

  const looseItem = mediaIndex.getMovie(id, library.key);
  if (looseItem) {
    return {
      mediaFile: looseItem,
      publicTarget: {
        id: looseItem.id,
        type: "movie",
        title: looseItem.title || looseItem.filename
      }
    };
  }

  const show = mediaIndex.getShow(id, library.key);
  const firstEpisode = show && show.seasons
    .flatMap((season) => season.episodes || [])
    .sort((a, b) => (a.season || 0) - (b.season || 0) || (a.episode || 0) - (b.episode || 0) || a.filename.localeCompare(b.filename))[0];
  if (!firstEpisode) {
    throw httpError(404, `${library.title} show not found`);
  }

  return {
    mediaFile: firstEpisode,
    publicTarget: {
      id: show.id,
      metadataId: firstEpisode.id,
      type: "show",
      title: show.name
    }
  };
}

function canAccessLibrary(req, libraryKey) {
  if (req.allowedLibraryKey) {
    return req.allowedLibraryKey === libraryKey;
  }
  if (Array.isArray(req.allowedLibraryKeys)) {
    return req.allowedLibraryKeys.includes(libraryKey);
  }
  return true;
}

function authContext(req) {
  return {
    token: req.authToken,
    paramName: req.authParamName || "authToken"
  };
}

function thumbnailUrlForItem(item, auth) {
  const url = new URL(`/api/catalog/${encodeURIComponent(item.mediaType)}/${encodeURIComponent(item.id)}/metadata/thumbnail`, "http://localhost");
  url.searchParams.set(auth.paramName, auth.token);
  return `${url.pathname}${url.search}`;
}

function contentTypeForPoster(filePath) {
  return contentTypeForImage(filePath);
}

function contentTypeForImage(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".png") {
    return "image/png";
  }
  if (extension === ".webp") {
    return "image/webp";
  }

  return "image/jpeg";
}
