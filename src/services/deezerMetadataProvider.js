const fs = require("fs/promises");
const path = require("path");
const { MusicTagReader } = require("./musicTagReader");

const API_BASE = "https://api.deezer.com";
const USER_AGENT = "MediaBaker/0.4.1 (https://github.com/jazzy348/media-baker)";
const REQUEST_TIMEOUT_MS = 20000;
const MAX_ATTEMPTS = 3;
const MUSIC_METADATA_VERSION = "deezer-v4";

class DeezerMetadataProvider {
  constructor(posterDir, cachedImages, customMetadata = null) {
    this.posterDir = posterDir;
    this.cachedImages = cachedImages;
    this.customMetadata = customMetadata;
    this.musicTags = new MusicTagReader();
  }

  providerName() {
    return this.customMetadata && this.customMetadata.active() ? "custom" : "deezer";
  }

  async find(mediaFile, input = {}) {
    const candidates = await this.search(mediaFile, input);
    if (!candidates.length) return null;
    return candidates[0].details ? candidates[0] : this.lookup(candidates[0].id, candidates[0].kind);
  }

  async search(mediaFile, input = {}) {
    const searchType = input.searchType === "artist" || mediaFile.musicEntityType === "artist"
      ? "artist"
      : input.searchType === "track" ? "track" : "album";
    const album = String(input.title || input.album || mediaFile.albumName || "").trim();
    const artist = String(input.artist || mediaFile.artistName || "").trim();
    const year = Number.parseInt(input.year || mediaFile.year, 10) || null;
    if (this.customMetadata && this.customMetadata.active()) {
      const recordingSearch = searchType === "track" || isUnknownAlbum(album);
      const response = await this.customMetadata.search({
        mediaType: "music",
        title: searchType === "artist"
          ? artist || album
          : recordingSearch ? String(mediaFile.title || mediaFile.filename || "").trim() : album,
        artist,
        year,
        searchType,
        trackTitle: String(mediaFile.title || mediaFile.filename || "").trim(),
        language: input.language || null,
        artworkLanguages: input.artworkLanguages || [],
        identifiers: musicIdentifiers(mediaFile)
      });
      return response.items.map((item) => customMusicItem(item, false, searchType));
    }

    if (searchType === "artist") return this.searchArtists(artist || album);
    if (isUnknownAlbum(album)) {
      return this.searchTracks(mediaFile, artist, year);
    }
    if (!album) return [];

    const albums = await this.searchAlbums(album, artist);
    if (albums.length) return rankAlbums(albums, { album, artist, year });
    return this.searchTracks(mediaFile, artist, year);
  }

  async searchAlbums(album, artist) {
    const queries = albumSearchQueries(album, artist);
    const albums = new Map();
    for (const query of queries) {
      const data = await this.fetchJson(`/search/album?${new URLSearchParams({ q: query, limit: "25" })}`);
      for (const raw of data.data || []) {
        const album = normalizeAlbum(raw);
        if (album.id && !albums.has(album.id)) albums.set(album.id, album);
      }
    }
    return [...albums.values()];
  }

  async searchArtists(name) {
    if (!knownArtist(name)) return [];
    const data = await this.fetchJson(`/search/artist?${new URLSearchParams({ q: cleanProviderQuery(name), limit: "25" })}`);
    return rankArtists((data.data || []).map((item) => normalizeArtist(item)), name);
  }

  async searchTracks(mediaFile, artist, year) {
    const title = String(mediaFile.title || mediaFile.filename || "").trim();
    if (!title) return [];
    const query = deezerQuery({ track: title, artist: knownArtist(artist) ? artist : null });
    const data = await this.fetchJson(`/search/track?${new URLSearchParams({ q: query, limit: "25" })}`);
    const albums = new Map();
    for (const track of data.data || []) {
      if (!track.album || !track.album.id) continue;
      const candidate = normalizeAlbum({
        ...track.album,
        artist: track.artist,
        rank: track.rank,
        trackTitle: track.title
      });
      const current = albums.get(candidate.id);
      if (!current || candidate.popularity > current.popularity) albums.set(candidate.id, candidate);
    }
    return rankAlbums([...albums.values()], { album: null, artist, year, track: title });
  }

  async lookup(providerId, kind = "album") {
    if (this.customMetadata && this.customMetadata.active()) {
      return customMusicItem((await this.customMetadata.media("music", providerId)).item, true, kind);
    }
    if (kind === "artist") return normalizeArtist(await this.fetchJson(`/artist/${encodeURIComponent(providerId)}`), true);
    return normalizeAlbum(await this.fetchJson(`/album/${encodeURIComponent(providerId)}`), true);
  }

  async createRecord(mediaType, mediaFile, album) {
    if (album.kind === "artist" || mediaFile.musicEntityType === "artist") {
      return this.createArtistRecord(mediaType, mediaFile, album);
    }
    if (album.id && !album.details) album = await this.lookup(album.id, "album");
    const providerId = String(album.id || "");
    const artistName = album.artist || mediaFile.albumArtist || mediaFile.artistName;
    const cover = await this.resolveCover(mediaFile, providerId, album.coverUrl, album.customPosterPath);
    return {
      mediaType,
      mediaId: mediaFile.id,
      found: true,
      provider: this.providerName(),
      providerId: providerId || null,
      title: mediaFile.title || mediaFile.filename,
      releaseYear: album.releaseYear || mediaFile.year || null,
      overview: album.overview || [album.title, artistName].filter(Boolean).join(" by "),
      posterPath: cover.path,
      posterFilename: cover.filename,
      posterUnavailable: !cover.filename,
      posterUnavailableReason: cover.filename ? null : "no-cover-art",
      sourceJson: JSON.stringify({
        ...album.raw,
        provider: this.providerName(),
        artistName,
        albumName: album.title || mediaFile.albumName,
        albumArtist: mediaFile.albumArtist || artistName,
        deezerAlbumId: this.providerName() === "deezer" ? providerId || null : null,
        coverUrl: album.coverUrl || null,
        customPosterPath: album.customPosterPath || null,
        localArtworkPath: mediaFile.localArtworkPath || null,
        hasEmbeddedArtwork: mediaFile.hasEmbeddedArtwork === true,
        albumId: mediaFile.albumId || null,
        musicFilePath: mediaFile.filePath || null,
        musicIdentity: musicIdentity(mediaFile),
        musicMetadataVersion: MUSIC_METADATA_VERSION,
        trackTitle: mediaFile.title,
        aliases: [mediaFile.artistName, mediaFile.albumName].filter(Boolean)
      })
    };
  }

  async createArtistRecord(mediaType, mediaFile, artist) {
    if (artist.id && !artist.details) artist = await this.lookup(artist.id, "artist");
    const providerId = String(artist.id || "");
    const cover = await this.resolveArtistCover(mediaFile, providerId, artist.coverUrl, artist.customPosterPath);
    return {
      mediaType,
      mediaId: mediaFile.id,
      found: true,
      provider: this.providerName(),
      providerId: providerId || null,
      title: artist.title || mediaFile.artistName || mediaFile.title,
      releaseYear: null,
      overview: artist.overview || null,
      posterPath: cover.path,
      posterFilename: cover.filename,
      posterUnavailable: !cover.filename,
      posterUnavailableReason: cover.filename ? null : "no-artist-artwork",
      sourceJson: JSON.stringify({
        ...artist.raw,
        provider: this.providerName(),
        artistName: artist.title || mediaFile.artistName,
        deezerArtistId: this.providerName() === "deezer" ? providerId || null : null,
        coverUrl: artist.coverUrl || null,
        customPosterPath: artist.customPosterPath || null,
        musicEntityType: "artist",
        musicIdentity: musicIdentity(mediaFile),
        musicMetadataVersion: MUSIC_METADATA_VERSION,
        aliases: []
      })
    };
  }

  async ensurePoster(record) {
    if (record.posterFilename) return record;
    const source = parseJson(record.sourceJson);
    let coverUrl = source.coverUrl || null;
    let customPosterPath = source.customPosterPath || null;
    if (record.providerId) {
      try {
        const album = await this.lookup(record.providerId, source.musicEntityType === "artist" ? "artist" : "album");
        coverUrl = album.coverUrl || coverUrl;
        customPosterPath = album.customPosterPath || customPosterPath;
      } catch (err) {
        if (!/HTTP 404\b/.test(err.message)) throw err;
      }
    }
    const mediaFile = {
      id: record.mediaId,
      albumId: source.albumId,
      filePath: source.musicFilePath,
      localArtworkPath: source.localArtworkPath
    };
    const cover = source.musicEntityType === "artist"
      ? await this.resolveArtistCover(mediaFile, record.providerId, coverUrl, customPosterPath)
      : await this.resolveCover(mediaFile, record.providerId, coverUrl, customPosterPath);
    return {
      ...record,
      posterPath: cover.path,
      posterFilename: cover.filename,
      posterUnavailable: !cover.filename,
      posterUnavailableReason: cover.filename ? null : "no-cover-art"
    };
  }

  async resolveCover(mediaFile, providerId, coverUrl = null, customPosterPath = null) {
    const identity = providerId || mediaFile.albumId || mediaFile.id;
    const filename = `music-album-${identity}-500.webp`;
    if (mediaFile.localArtworkPath) {
      try {
        return {
          path: `local-file:${mediaFile.localArtworkPath}`,
          filename: await this.cachedImages.cacheFile(mediaFile.localArtworkPath, this.posterDir, filename)
        };
      } catch (err) {
        if (err.code !== "ENOENT") throw err;
      }
    }
    try {
      const picture = await this.musicTags.cover(mediaFile.filePath);
      if (picture && picture.data) {
        return {
          path: `embedded-art:${mediaFile.id}`,
          filename: await this.cachedImages.cacheBuffer(picture.data, this.posterDir, filename, extensionForMime(picture.format))
        };
      }
    } catch (err) {
      // A malformed embedded image should not block provider artwork.
    }
    for (const url of [customPosterPath, coverUrl].filter(Boolean)) {
      const cached = await this.cacheCover(identity, url);
      if (cached) return { path: url, filename: cached };
    }
    return { path: null, filename: null };
  }

  async resolveArtistCover(mediaFile, providerId, coverUrl = null, customPosterPath = null) {
    const identity = providerId || mediaFile.id;
    for (const url of [customPosterPath, coverUrl].filter(Boolean)) {
      const cached = await this.cacheCover(identity, url, "artist");
      if (cached) return { path: url, filename: cached };
    }
    return { path: null, filename: null };
  }

  candidate(album) {
    return {
      provider: this.providerName(),
      providerId: album.id || null,
      title: album.title || "Untitled album",
      originalTitle: null,
      year: album.releaseYear || null,
      overview: album.overview || [album.title, album.artist].filter(Boolean).join(" by "),
      posterPath: album.coverUrl || null,
      posterUrl: album.customPosterPath
        ? `/api/catalog/metadata/custom-poster/${encodeURIComponent(album.customPosterPath.slice("custom-asset:".length))}`
        : album.coverUrl || null,
      score: Number(album.score) || 0,
      popularity: Number(album.popularity) || 0,
      voteCount: 0
    };
  }

  async cacheCover(providerId, url, kind = "album") {
    const filename = `deezer-${kind}-${providerId}-1000.webp`;
    const filePath = path.join(this.posterDir, filename);
    try {
      await fs.access(filePath);
      return filename;
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }

    if (String(url).startsWith("custom-asset:") && this.customMetadata && this.customMetadata.active()) {
      try {
        const buffer = await this.customMetadata.artwork(String(url).slice("custom-asset:".length));
        return this.cachedImages.cacheBuffer(buffer, this.posterDir, filename, ".webp");
      } catch (err) {
        if (/HTTP 404\b/.test(err.message)) return null;
        throw err;
      }
    }

    const response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Deezer artwork lookup failed with HTTP ${response.status}`);
    return this.cachedImages.cacheBuffer(Buffer.from(await response.arrayBuffer()), this.posterDir, filename, ".jpg");
  }

  async fetchJson(endpoint) {
    let lastError;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        const response = await fetch(`${API_BASE}${endpoint}`, {
          headers: { Accept: "application/json", "User-Agent": USER_AGENT },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });
        if (!response.ok) throw providerError(response.status, endpoint);
        const data = await response.json();
        if (data && data.error) throw providerError(deezerErrorStatus(data.error.code), endpoint, data.error.message);
        return data;
      } catch (err) {
        lastError = err;
        if (!isTransientError(err) || attempt === MAX_ATTEMPTS) throw err;
        await delay(250 * (2 ** (attempt - 1)));
      }
    }
    throw lastError;
  }
}

function normalizeAlbum(raw, details = false) {
  const artist = raw.artist && raw.artist.name || null;
  const releaseDate = raw.release_date || null;
  const genres = raw.genres && Array.isArray(raw.genres.data)
    ? raw.genres.data.map((genre) => genre.name).filter(Boolean)
    : [];
  return {
    kind: "album",
    id: raw.id ? String(raw.id) : null,
    title: raw.title || null,
    artist,
    releaseDate,
    releaseYear: yearOf(releaseDate),
    overview: [raw.title && artist ? `${raw.title} by ${artist}` : null, genres.length ? genres.join(", ") : null].filter(Boolean).join(" - ") || null,
    coverUrl: raw.cover_xl || raw.cover_big || raw.cover_medium || raw.cover || null,
    customPosterPath: null,
    popularity: Number(raw.fans || raw.rank) || 0,
    score: Number(raw.rank) || 0,
    details,
    raw
  };
}

function normalizeArtist(raw, details = false) {
  return {
    kind: "artist",
    id: raw.id ? String(raw.id) : null,
    title: raw.name || null,
    artist: raw.name || null,
    releaseDate: null,
    releaseYear: null,
    overview: null,
    coverUrl: raw.picture_xl || raw.picture_big || raw.picture_medium || raw.picture || null,
    customPosterPath: null,
    popularity: Number(raw.nb_fan || raw.rank) || 0,
    score: Number(raw.nb_fan || raw.rank) || 0,
    details,
    raw
  };
}

function customMusicItem(item, details, requestedKind = "album") {
  const kind = item.musicEntityType === "artist" || requestedKind === "artist" ? "artist" : "album";
  return {
    kind,
    id: item.id,
    title: item.title,
    artist: item.artist || item.albumArtist || null,
    releaseDate: item.releaseDate || (item.releaseYear ? `${item.releaseYear}-01-01` : null),
    releaseYear: Number(item.releaseYear) || yearOf(item.releaseDate),
    overview: item.overview || null,
    coverUrl: null,
    customPosterPath: item.artwork && item.artwork.id ? `custom-asset:${item.artwork.id}` : null,
    popularity: Number(item.popularity) || 0,
    score: Number(item.popularity) || 0,
    details,
    raw: item
  };
}

function rankArtists(artists, query) {
  return artists
    .map((artist) => ({
      ...artist,
      score: similarity(artist.title, query) * 200 + Math.log10(Math.max(1, artist.popularity || 0))
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 12);
}

function rankAlbums(albums, query) {
  return albums
    .map((album) => ({ ...album, score: albumScore(album, query) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 12);
}

function albumScore(album, query) {
  const title = query.album ? similarity(album.title, query.album) * 120 : 0;
  const artist = knownArtist(query.artist) ? similarity(album.artist, query.artist) * 100 : 0;
  const year = query.year && album.releaseYear ? Math.max(0, 20 - Math.abs(query.year - album.releaseYear) * 5) : 0;
  const track = query.track && album.raw && album.raw.trackTitle ? similarity(album.raw.trackTitle, query.track) * 80 : 0;
  return title + artist + year + track + Math.log10(Math.max(1, album.popularity || 0));
}

function deezerQuery(fields) {
  return Object.entries(fields)
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}:"${String(value).replace(/"/g, "")}"`)
    .join(" ");
}

function albumSearchQueries(album, artist) {
  const titles = releaseTitleVariants(album);
  const queries = [...titles];
  if (knownArtist(artist)) queries.push(...titles.map((title) => `${title} ${artist}`));
  return [...new Set(queries.map(cleanProviderQuery).filter(Boolean))].slice(0, 5);
}

function releaseTitleVariants(value) {
  const original = cleanProviderQuery(value);
  const withoutBrackets = cleanProviderQuery(original.replace(/\[[^\]]*\]/g, " "));
  const withoutEditions = cleanProviderQuery(withoutBrackets.replace(/\(([^)]*(?:deluxe|expanded|bonus|remaster|anniversary|edition|version|reissue)[^)]*)\)/gi, " "));
  const withoutSuffix = cleanProviderQuery(withoutEditions.replace(/(?:\s*[-:]\s*)?(?:greatest\s+hits|deluxe|expanded|bonus\s+tracks?|remastered?|special\s+edition|anniversary\s+edition)(?:\s+version)?$/i, ""));
  return [...new Set([original, withoutBrackets, withoutEditions, withoutSuffix].filter(Boolean))];
}

function cleanProviderQuery(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[_:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function musicIdentifiers(mediaFile) {
  return [
    ["artist", mediaFile.musicBrainzArtistId || mediaFile.musicBrainzAlbumArtistId],
    ["release", mediaFile.musicBrainzReleaseId],
    ["release-group", mediaFile.musicBrainzReleaseGroupId],
    ["recording", mediaFile.musicBrainzRecordingId]
  ].filter(([, value]) => value).map(([type, value]) => ({ namespace: "musicbrainz", type, value }));
}

function musicIdentity(mediaFile) {
  if (mediaFile.musicEntityType === "artist") {
    return {
      entityType: "artist",
      artistName: String(mediaFile.artistName || mediaFile.title || "Unknown Artist").trim(),
      artistId: mediaFile.musicBrainzArtistId || mediaFile.musicBrainzAlbumArtistId || null
    };
  }
  return {
    entityType: "album",
    artistName: String(mediaFile.albumArtist || mediaFile.artistName || "Unknown Artist").trim(),
    albumName: String(mediaFile.albumName || "Unknown Album").trim(),
    year: Number.parseInt(mediaFile.year, 10) || null,
    releaseId: mediaFile.musicBrainzReleaseId || null,
    releaseGroupId: mediaFile.musicBrainzReleaseGroupId || null
  };
}

function extensionForMime(value) {
  const mime = String(value || "").toLowerCase();
  if (mime.includes("png")) return ".png";
  if (mime.includes("webp")) return ".webp";
  if (mime.includes("gif")) return ".gif";
  return ".jpg";
}

function parseJson(value) {
  try { return JSON.parse(value) || {}; } catch (err) { return {}; }
}

function similarity(left, right) {
  const a = normalize(left);
  const b = normalize(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.8;
  const leftWords = new Set(a.split(" "));
  const rightWords = new Set(b.split(" "));
  const common = [...leftWords].filter((word) => rightWords.has(word)).length;
  return common / Math.max(leftWords.size, rightWords.size);
}

function normalize(value) {
  return String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function knownArtist(value) {
  return Boolean(String(value || "").trim()) && !/^unknown artist$/i.test(String(value).trim());
}

function isUnknownAlbum(value) {
  return !String(value || "").trim() || /^unknown album$/i.test(String(value).trim());
}

function yearOf(value) {
  const year = Number.parseInt(String(value || "").slice(0, 4), 10);
  return Number.isFinite(year) ? year : null;
}

function providerError(status, endpoint, detail = null) {
  const error = new Error(`Deezer metadata lookup failed with HTTP ${status}${detail ? `: ${detail}` : ""}`);
  error.status = status;
  error.provider = "deezer";
  error.endpoint = endpoint;
  return error;
}

function deezerErrorStatus(code) {
  if ([100, 200, 300, 500].includes(Number(code))) return 400;
  if (Number(code) === 800) return 404;
  if (Number(code) === 4) return 429;
  return 502;
}

function isTransientError(err) {
  const status = Number(err && err.status);
  return !status || status === 408 || status === 425 || status === 429 || status >= 500;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { DeezerMetadataProvider, MUSIC_METADATA_VERSION };
