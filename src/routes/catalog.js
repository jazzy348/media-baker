const express = require("express");
const path = require("path");
const { getMediaPlaybackOptions } = require("../services/mediaOptions");
const { resolveMediaFile } = require("../services/mediaResolver");
const { httpError, isClientAbort } = require("../utils/httpErrors");
const { createId } = require("../utils/mediaParsers");
const { establishWebStreamAuthCookie } = require("../middleware/auth");

module.exports = function createCatalogRoutes({ config, mediaIndex, ffmpeg, hls, images, metadata, subtitles, playbackTokens }) {
  const router = express.Router();

  router.get("/home", async (req, res, next) => {
    try {
      const categories = categoriesForRequest(config, req);
      const mode = homeMode(req.query.mode);
      const rows = await Promise.all(categories.map(async (category) => {
        const collection = await mediaIndex.loadCollection(category.collection);
        const allItems = category.folderBrowser
          ? rootMediaFolderItems(category, collection.items, authContext(req))
          : await itemsForCategory(mediaIndex, category, collection);
        const items = homeItems(allItems, mode, 18);
        return {
          key: category.key,
          title: category.title,
          total: category.kind === "episode" ? (await libraryItemsForCategory(mediaIndex, category, collection)).length : allItems.length,
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
      const metadataRefs = mediaIndex.databaseBacked && metadata && metadata.searchCachedRefs
        ? await metadata.searchCachedRefs(query, categories.map((category) => category.mediaType), 1200)
        : [];
      const metadataIdsByType = groupMetadataIds(metadataRefs);
      const allItems = (await Promise.all(categories.map((category) => searchItemsForCategory(
        mediaIndex,
        category,
        query,
        metadataIdsByType.get(category.mediaType) || []
      )))).flat();
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
      const supportsMetadataMatching = category.kind !== "image" && !category.noMetadata;
      const metadataFilter = supportsMetadataMatching
        ? metadataFilterMode(req.query.metadata || req.query.filter)
        : "all";
      const folderBrowsing = category.kind === "image" || category.folderBrowser;
      const requestedFolder = folderBrowsing ? normalizeCatalogFolder(req.query.folder) : "";
      let allItems;
      if (category.kind === "image") {
        const collection = await mediaIndex.loadCollection(category.collection, "images");
        const browser = imageFolderItems(category, collection.items, requestedFolder, authContext(req));
        allItems = [
          ...sortLibraryItems(browser.folders, sort),
          ...sortLibraryItems(browser.images, sort)
        ];
      } else if (category.folderBrowser) {
        const collection = await mediaIndex.loadCollection(category.collection, "movies");
        const browser = mediaFolderItems(category, collection.items, requestedFolder, authContext(req));
        allItems = [
          ...sortLibraryItems(browser.folders, sort),
          ...sortLibraryItems(browser.items, sort)
        ];
      } else {
        allItems = await libraryItemsForCategory(mediaIndex, category);
      }
      if (metadataFilter === "unmatched") {
        requireMetadataManagement(req);
        allItems = await unmatchedMetadataItems(allItems, metadata);
      }
      if (!folderBrowsing) {
        allItems = sortLibraryItems(allItems, sort);
      }
      const pageItems = allItems.slice(offset, offset + limit);

      res.json({
        key: category.key,
        title: category.title,
        total: allItems.length,
        offset,
        limit,
        sort,
        metadataFilter,
        supportsMetadataMatching,
        folder: requestedFolder,
        parentFolder: parentCatalogFolder(requestedFolder),
        nextOffset: offset + pageItems.length,
        hasMore: offset + pageItems.length < allItems.length,
        items: await withCachedMetadata(pageItems, metadata, authContext(req))
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/libraries/:mediaType/image-folder-collage", async (req, res, next) => {
    try {
      const category = categoryForMediaType(config, req, req.params.mediaType);
      if (!category || category.kind !== "image") {
        next(httpError(404, "Image folder not found"));
        return;
      }

      const folder = normalizeCatalogFolder(req.query.folder);
      if (!folder) {
        next(httpError(404, "Image folder not found"));
        return;
      }
      const imageIds = String(req.query.images || "").split(",").filter(Boolean).slice(0, 4);
      const folderImages = (await Promise.all(imageIds.map((id) => mediaIndex.getImage(id, category.collection))))
        .filter((item) => item && imageIsInFolder(item, folder));
      if (folderImages.length === 0) {
        next(httpError(404, "Image folder not found"));
        return;
      }

      const filePath = await images.collageFor(category.key, folder, folderImages);
      res.set("Cache-Control", "private, max-age=86400");
      res.type("image/webp");
      res.sendFile(filePath, (err) => {
        if (err && !isClientAbort(err)) {
          next(httpError(err.statusCode || 404, "Image collage not found"));
        }
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/libraries/:mediaType/media-folder-collage", async (req, res, next) => {
    try {
      const category = categoryForMediaType(config, req, req.params.mediaType);
      if (!category || !category.folderBrowser) {
        next(httpError(404, "Playlist artwork not found"));
        return;
      }

      const folder = normalizeCatalogFolder(req.query.folder);
      const itemIds = String(req.query.items || "").split(",").filter(Boolean).slice(0, 4);
      if (!folder || itemIds.length === 0) {
        next(httpError(404, "Playlist artwork not found"));
        return;
      }
      const mediaFiles = (await Promise.all(itemIds.map((id) => mediaIndex.getMovie(id, category.collection))))
        .filter((item) => item && mediaIsInFolder(category, item, folder));
      const thumbnailSources = (await Promise.all(mediaFiles.map(async (item) => {
        const thumbnail = await metadata.ensureThumbnailForMedia(category.mediaType, item);
        return thumbnail.available && thumbnail.filePath
          ? { ...item, filePath: thumbnail.filePath }
          : null;
      }))).filter(Boolean);
      if (thumbnailSources.length === 0) {
        next(httpError(404, "Playlist artwork not found"));
        return;
      }

      const filePath = await images.collageFor(`media-${category.key}`, folder, thumbnailSources);
      res.set("Cache-Control", "private, max-age=86400");
      res.type("image/webp");
      res.sendFile(filePath, (err) => {
        if (err && !isClientAbort(err)) {
          next(httpError(err.statusCode || 404, "Playlist artwork not found"));
        }
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
      establishWebStreamAuthCookie(req, res);
      if (library && library.type === "images") {
        res.json({
          item: itemFromMediaFile(req.params.mediaType, mediaFile),
          nextItem: null,
          filePath: mediaFile.filePath,
          image: true,
          originalUrl: authenticatedImageUrl(req.params.mediaType, mediaFile.id, authContext(req)),
          webPlaybackToken: playbackTokens.createWebStreamToken(req.params.mediaType, mediaFile.id, req.user && req.user.id || "global"),
          quality: [{ id: "original", label: "Original image" }],
          audio: [{ id: "none", label: "No audio" }],
          subtitles: [{ id: "none", label: "No subtitles" }]
        });
        return;
      }
      const options = await getMediaPlaybackOptions(mediaFile, ffmpeg, {
        library,
        subtitles,
        mediaType: req.params.mediaType
      });
      res.json({
        item: itemFromMediaFile(req.params.mediaType, mediaFile),
        nextItem: itemFromMediaFile(req.params.mediaType, await mediaIndex.nextPlayable(req.params.mediaType, mediaFile.id)),
        webPlaybackToken: playbackTokens.createWebStreamToken(req.params.mediaType, mediaFile.id, req.user && req.user.id || "global"),
        ...options
      });
    } catch (err) {
      next(err);
    }
  });

  router.post("/:mediaType/:id/copy-token", async (req, res, next) => {
    try {
      requireCopyStreamPermission(req);
      assertMediaAccess(req, req.params.mediaType);
      const mediaFile = await resolveMediaFile(mediaIndex, req.params.mediaType, req.params.id);
      res.json({
        playbackToken: playbackTokens.createCopyStreamToken(
          req.params.mediaType,
          mediaFile.id,
          req.user.id
        )
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/:mediaType/:id/image", async (req, res, next) => {
    try {
      assertMediaAccess(req, req.params.mediaType);
      const library = mediaIndex.libraryForKey(req.params.mediaType);
      if (!library || library.type !== "images") {
        next(httpError(404, "Image not found"));
        return;
      }
      const mediaFile = await resolveMediaFile(mediaIndex, req.params.mediaType, req.params.id);
      const filePath = await images.fileFor(mediaFile);
      res.set("Cache-Control", "private, max-age=86400");
      res.type(path.extname(filePath));
      res.sendFile(filePath, (err) => {
        if (err && !isClientAbort(err)) {
          next(httpError(err.statusCode || 404, "Image not found"));
        }
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
        if (err && !isClientAbort(err)) {
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
        if (err && !isClientAbort(err)) {
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
        if (err && !isClientAbort(err)) {
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

async function itemsForCategory(mediaIndex, category, indexedCollection = null) {
  if (category.kind === "movie") {
    const collection = indexedCollection || await mediaIndex.loadCollection(category.collection, "movies");
    return collection.items.map((movie) => movieCatalogItem(category, movie));
  }

  if (category.kind === "track") {
    const collection = indexedCollection || await mediaIndex.loadCollection(category.collection, "music");
    const tracks = collection.tracks || Object.values(collection.tracksById || {});
    return tracks.map((track) => ({
      id: track.id,
      mediaType: category.mediaType,
      category: category.title,
      itemType: "track",
      title: track.title,
      subtitle: `${track.artistName} - ${track.albumName}`,
      artistId: track.artistId,
      artistName: track.artistName,
      albumId: track.albumId,
      albumName: track.albumName,
      disc: track.disc,
      track: track.track,
      filePath: track.filePath,
      addedAtMs: track.addedAtMs || track.mtimeMs || 0,
      searchText: `${track.artistName} ${track.albumName} ${track.title}`,
      fallbackSearchText: `${track.artistName} ${track.albumName} ${track.title}`
    }));
  }
  if (category.kind === "image") {
    const collection = indexedCollection || await mediaIndex.loadCollection(category.collection, "images");
    return collection.items.map((image) => ({
      id: image.id,
      mediaType: category.mediaType,
      category: category.title,
      itemType: "image",
      title: image.title,
      subtitle: image.folder || image.filename,
      filePath: image.filePath,
      addedAtMs: image.addedAtMs || image.mtimeMs || 0,
      searchText: image.title,
      fallbackSearchText: image.title
    }));
  }

  const collection = indexedCollection || await mediaIndex.loadCollection(category.collection, "tv");
  const episodeRows = collection.episodes || collection.shows.flatMap((show) => show.seasons.flatMap((season) => season.episodes));
  const episodes = episodeRows.map((episode) => ({
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
  }));
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

async function searchItemsForCategory(mediaIndex, category, query, metadataIds) {
  const collection = await mediaIndex.searchCollection(category.collection, query, metadataIds);
  if (category.kind === "movie" || category.kind === "image") {
    return itemsForCategory(mediaIndex, category, collection);
  }
  if (category.kind === "track") {
    return [
      ...await libraryItemsForCategory(mediaIndex, category, collection),
      ...await musicAlbumItems(mediaIndex, category, collection),
      ...await itemsForCategory(mediaIndex, category, collection)
    ];
  }

  return [
    ...await libraryItemsForCategory(mediaIndex, category, collection),
    ...await itemsForCategory(mediaIndex, category, collection)
  ];
}

async function musicAlbumItems(mediaIndex, category, indexedCollection = null) {
  const collection = indexedCollection || await mediaIndex.loadCollection(category.collection, "music");
  if (collection.albums) {
    return collection.albums.map((album) => ({
      id: album.id,
      mediaType: category.mediaType,
      category: category.title,
      itemType: "album",
      kind: "album",
      title: album.name,
      subtitle: `${album.artistName} - ${album.trackCount} tracks`,
      artistId: album.artistId,
      artistName: album.artistName,
      albumId: album.id,
      albumName: album.name,
      metadataId: album.metadataId,
      metadataIds: album.metadataId ? [album.metadataId] : [],
      addedAtMs: album.addedAtMs || 0,
      searchText: `${album.artistName} ${album.name}`,
      fallbackSearchText: `${album.artistName} ${album.name}`
    }));
  }
  return collection.artists.flatMap((artist) => artist.albums.map((album) => ({
    id: album.id,
    mediaType: category.mediaType,
    category: category.title,
    itemType: "album",
    kind: "album",
    title: album.name,
    subtitle: `${artist.name} - ${album.tracks.length} tracks`,
    artistId: artist.id,
    artistName: artist.name,
    albumId: album.id,
    albumName: album.name,
    metadataId: album.tracks[0] ? album.tracks[0].id : null,
    metadataIds: album.tracks.map((track) => track.id),
    addedAtMs: album.tracks.reduce((latest, track) => Math.max(latest, track.addedAtMs || track.mtimeMs || 0), 0),
    searchText: `${artist.name} ${album.name}`,
    fallbackSearchText: `${artist.name} ${album.name}`
  })));
}

async function libraryItemsForCategory(mediaIndex, category, indexedCollection = null) {
  if (category.kind === "movie" || category.kind === "image") {
    return itemsForCategory(mediaIndex, category, indexedCollection);
  }

  if (category.kind === "track") {
    const collection = indexedCollection || await mediaIndex.loadCollection(category.collection, "music");
    return collection.artists.map((artist) => {
      const tracks = (artist.albums || []).flatMap((album) => album.tracks);
      const albumCount = artist.albumCount === undefined ? artist.albums.length : artist.albumCount;
      const trackCount = artist.trackCount === undefined ? tracks.length : artist.trackCount;
      return {
        id: artist.id,
        mediaType: category.mediaType,
        category: category.title,
        itemType: "artist",
        kind: "artist",
        title: artist.name,
        subtitle: `${albumCount} albums - ${trackCount} tracks`,
        artistId: artist.id,
        artistName: artist.name,
        metadataId: artist.metadataId || (tracks[0] ? tracks[0].id : null),
        metadataIds: artist.metadataId ? [artist.metadataId] : tracks.map((track) => track.id),
        addedAtMs: artist.addedAtMs || tracks.reduce((latest, track) => Math.max(latest, track.addedAtMs || track.mtimeMs || 0), 0),
        searchText: artist.name,
        fallbackSearchText: artist.name
      };
    });
  }

  const collection = indexedCollection || await mediaIndex.loadCollection(category.collection, "tv");
  const shows = collection.shows.map((show) => {
    const episodes = (show.seasons || []).flatMap((season) => season.episodes);
    const seasonCount = show.seasonCount === undefined ? show.seasons.length : show.seasonCount;
    const episodeCount = show.episodeCount === undefined ? episodes.length : show.episodeCount;
    const firstEpisode = episodes[0] || null;
    const addedAtMs = episodes.reduce((latest, episode) => Math.max(latest, episode.addedAtMs || episode.mtimeMs || 0), 0);
    return {
      id: show.id,
      mediaType: category.mediaType,
      category: category.title,
      itemType: "show",
      kind: "show",
      title: show.name,
      subtitle: `${seasonCount} seasons - ${episodeCount} episodes`,
      showId: show.id,
      showName: show.name,
      metadataId: show.metadataId || (firstEpisode ? firstEpisode.id : null),
      metadataIds: show.metadataId ? [show.metadataId] : episodes.map((episode) => episode.id),
      addedAtMs: show.addedAtMs || addedAtMs,
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
  if (!mediaFile) {
    return null;
  }
  return {
    id: mediaFile.id,
    mediaType,
    title: mediaFile.title || mediaFile.filename,
    showId: mediaFile.showId,
    showName: mediaFile.showName,
    season: mediaFile.season,
    episode: mediaFile.episode,
    artistId: mediaFile.artistId,
    artistName: mediaFile.artistName,
    albumId: mediaFile.albumId,
    albumName: mediaFile.albumName,
    disc: mediaFile.disc,
    track: mediaFile.track,
    itemType: mediaFile.artistId ? "track" : undefined,
    subtitle: mediaFile.artistName
      ? `${mediaFile.artistName} - ${mediaFile.albumName}`
      : mediaFile.showName
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
  const typeBoost = searchTypeBoost(item);
  const metadataScore = weightedFuzzyScore(item.metadataTitle, tokens, 1000000);
  if (metadataScore > 0) {
    return metadataScore + typeBoost;
  }

  const aliasScore = weightedFuzzyScore((item.metadataAliases || []).join(" "), tokens, 500000);
  if (aliasScore > 0) {
    return aliasScore + typeBoost;
  }

  if (!item.metadataTitle && (!item.metadataAliases || item.metadataAliases.length === 0)) {
    const fallbackScore = weightedFuzzyScore(item.fallbackSearchText, tokens, 100000);
    if (fallbackScore > 0) {
      return fallbackScore + typeBoost;
    }
  }

  const textScore = fuzzyScore(String(item.searchText || "").toLowerCase(), tokens);
  return textScore > 0 ? textScore + typeBoost : 0;
}

function searchTypeBoost(item) {
  if (item.itemType === "artist") {
    return 3000000;
  }
  if (item.itemType === "show") {
    return 2000000;
  }
  return 0;
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

function groupMetadataIds(refs) {
  const grouped = new Map();
  for (const ref of refs || []) {
    const ids = grouped.get(ref.mediaType) || [];
    ids.push(ref.id);
    grouped.set(ref.mediaType, ids);
  }
  return grouped;
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

  const metadataItems = items.filter((item) => !item.localThumbnail && !["image", "image-folder", "media-folder", "playlist"].includes(item.itemType));
  const refs = metadataItems.flatMap((item) => metadataIdsForItem(item).map((id) => ({
    mediaType: item.mediaType,
    id
  })));
  const cachedByKey = await metadata.getCachedForMediaItems(refs);
  const auth = typeof authContextValue === "object"
    ? authContextValue
    : { token: authContextValue, paramName: "authToken" };
  return items.map((item) => {
    if (["image-folder", "media-folder", "playlist"].includes(item.itemType)) {
      return item;
    }
    if (item.itemType === "image") {
      return {
        ...item,
        thumbnailUrl: authenticatedImageUrl(item.mediaType, item.id, auth)
      };
    }
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

    const title = ["artist", "album"].includes(item.itemType) ? item.title : cached.title || item.title;
    return {
      ...item,
      title,
      metadataTitle: item.itemType === "artist" ? item.title : cached.title || null,
      metadataAliases: item.itemType === "artist" ? [] : cached.aliases || [],
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
      kind: library.type === "tv" ? "episode" : library.type === "music" ? "track" : library.type === "images" ? "image" : "movie",
      localThumbnails: Boolean(library.localThumbnails),
      noMetadata: Boolean(library.noMetadata),
      noSubtitles: Boolean(library.noSubtitles),
      path: library.path,
      folderBrowser: library.rawType === "yt-dlp"
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

function requireCopyStreamPermission(req) {
  const permissions = req.user && req.user.permissions || {};
  if (!req.user || (!permissions.isAdmin && !permissions.canCopyStreamUrls)) {
    throw httpError(403, "Copy stream URL access required");
  }
}

function librarySkipsMetadata(mediaIndex, mediaType) {
  const library = mediaIndex.libraryForKey(mediaType);
  return Boolean(library && (library.noMetadata || library.type === "images"));
}

function authenticatedImageUrl(mediaType, mediaId, auth) {
  const params = new URLSearchParams({ [auth.paramName]: auth.token });
  return `/api/catalog/${encodeURIComponent(mediaType)}/${encodeURIComponent(mediaId)}/image?${params.toString()}`;
}

function imageFolderItems(category, items, currentFolder, auth) {
  const folders = new Map();
  const directImages = [];
  for (const item of items) {
    const itemFolder = normalizeCatalogFolder(item.folder);
    if (itemFolder === currentFolder) {
      directImages.push(imageCatalogItem(category, item));
      continue;
    }

    const prefix = currentFolder ? `${currentFolder}/` : "";
    if (!itemFolder.startsWith(prefix)) {
      continue;
    }
    const remainder = itemFolder.slice(prefix.length);
    const childName = remainder.split("/")[0];
    if (!childName) {
      continue;
    }
    const folderPath = prefix + childName;
    const folder = folders.get(folderPath) || {
      id: `folder:${folderPath}`,
      mediaType: category.mediaType,
      category: category.title,
      itemType: "image-folder",
      title: childName,
      folderPath,
      imageCount: 0,
      addedAtMs: 0,
      collageImageIds: []
    };
    folder.imageCount += 1;
    folder.addedAtMs = Math.max(folder.addedAtMs, item.addedAtMs || item.mtimeMs || 0);
    if (folder.collageImageIds.length < 4) {
      folder.collageImageIds.push(item.id);
    }
    folders.set(folderPath, folder);
  }

  return {
    folders: [...folders.values()].map((folder) => {
      const { collageImageIds, ...publicFolder } = folder;
      return {
        ...publicFolder,
        collageUrl: authenticatedImageCollageUrl(category.mediaType, folder.folderPath, collageImageIds, auth),
        subtitle: `${folder.imageCount} image${folder.imageCount === 1 ? "" : "s"}`,
        searchText: folder.title,
        fallbackSearchText: folder.title
      };
    }),
    images: directImages
  };
}

function rootMediaFolderItems(category, items, auth) {
  const browser = mediaFolderItems(category, items, "", auth);
  return [...browser.folders, ...browser.items];
}

function mediaFolderItems(category, items, currentFolder, auth) {
  const folders = new Map();
  const directItems = [];
  for (const item of items) {
    const itemFolder = catalogFolderForMedia(category, item);
    if (itemFolder === currentFolder) {
      directItems.push(movieCatalogItem(category, item));
      continue;
    }

    const prefix = currentFolder ? `${currentFolder}/` : "";
    if (!itemFolder.startsWith(prefix)) {
      continue;
    }
    const childName = itemFolder.slice(prefix.length).split("/")[0];
    if (!childName) {
      continue;
    }
    const folderPath = prefix + childName;
    const folder = folders.get(folderPath) || {
      id: `folder:${folderPath}`,
      mediaType: category.mediaType,
      category: category.title,
      itemType: "playlist",
      title: childName,
      folderPath,
      itemCount: 0,
      addedAtMs: 0,
      itemIds: []
    };
    folder.itemCount += 1;
    folder.addedAtMs = Math.max(folder.addedAtMs, item.addedAtMs || item.mtimeMs || 0);
    folder.itemIds.push(item.id);
    folders.set(folderPath, folder);
  }

  return {
    folders: [...folders.values()].map((folder) => {
      const { itemIds, ...publicFolder } = folder;
      const collageItemIds = stableFolderSample(folder.folderPath, itemIds, 4);
      return {
        ...publicFolder,
        subtitle: `${folder.itemCount} video${folder.itemCount === 1 ? "" : "s"}`,
        collageUrl: authenticatedMediaFolderCollageUrl(category.mediaType, folder.folderPath, collageItemIds, auth),
        searchText: folder.title,
        fallbackSearchText: folder.title
      };
    }),
    items: directItems
  };
}

function catalogFolderForMedia(category, item) {
  const relativeDirectory = path.relative(category.path, path.dirname(item.filePath));
  return relativeDirectory && relativeDirectory !== "." ? normalizeCatalogFolder(relativeDirectory) : "";
}

function mediaIsInFolder(category, item, folder) {
  const itemFolder = catalogFolderForMedia(category, item);
  return itemFolder === folder || itemFolder.startsWith(`${folder}/`);
}

function stableFolderSample(folder, itemIds, limit) {
  return [...itemIds]
    .sort((left, right) => createId(`${folder}:${left}`).localeCompare(createId(`${folder}:${right}`)))
    .slice(0, limit);
}

function movieCatalogItem(category, movie) {
  return {
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
  };
}

function imageCatalogItem(category, image) {
  return {
    id: image.id,
    mediaType: category.mediaType,
    category: category.title,
    itemType: "image",
    title: image.title,
    subtitle: image.filename,
    filePath: image.filePath,
    addedAtMs: image.addedAtMs || image.mtimeMs || 0,
    searchText: image.title,
    fallbackSearchText: image.title
  };
}

function normalizeCatalogFolder(value) {
  const parts = String(value || "")
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part && part !== ".");
  if (parts.includes("..")) {
    throw httpError(400, "Invalid folder");
  }
  return parts.join("/");
}

function parentCatalogFolder(folder) {
  const parts = normalizeCatalogFolder(folder).split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

function imageIsInFolder(item, folder) {
  const itemFolder = normalizeCatalogFolder(item.folder);
  return itemFolder === folder || itemFolder.startsWith(`${folder}/`);
}

function authenticatedImageCollageUrl(mediaType, folder, imageIds, auth) {
  const params = new URLSearchParams({ folder, images: imageIds.join(","), [auth.paramName]: auth.token });
  return `/api/catalog/libraries/${encodeURIComponent(mediaType)}/image-folder-collage?${params.toString()}`;
}

function authenticatedMediaFolderCollageUrl(mediaType, folder, itemIds, auth) {
  const params = new URLSearchParams({ folder, items: itemIds.join(","), [auth.paramName]: auth.token });
  return `/api/catalog/libraries/${encodeURIComponent(mediaType)}/media-folder-collage?${params.toString()}`;
}

async function resolveMetadataTarget(mediaIndex, mediaType, id) {
  const library = mediaIndex.libraryForKey(mediaType);
  if (!library) {
    throw httpError(404, "Library not found");
  }

  if (library.type === "images") {
    throw httpError(400, "Image libraries do not use metadata matching");
  }

  if (library.type === "music") {
    const track = await resolveMediaFile(mediaIndex, mediaType, id);
    return {
      mediaFile: track,
      publicTarget: {
        id: track.id,
        type: "track",
        title: track.title,
        artistName: track.artistName,
        albumName: track.albumName
      }
    };
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

  const episode = await mediaIndex.getEpisode(id, library.key);
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

  const looseItem = await mediaIndex.getMovie(id, library.key);
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

  const show = await mediaIndex.getShow(id, library.key);
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
