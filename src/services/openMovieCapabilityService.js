const crypto = require("crypto");

const VERSION = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const API_KEY_ID_BYTES = 8;
const AAD = Buffer.from("MediaBaker.OpenMovie.v1", "ascii");

const OPERATIONS = Object.freeze({
  MOVIES: 1,
  TV: 2,
  ON_DECK: 3,
  MOVIE_POSTER: 4,
  EPISODE_POSTER: 5,
  SHOW_POSTER: 6,
  SEASON_POSTER: 7,
  POSTER_ATLAS: 8,
  MOVIE_PLAYBACK: 9,
  EPISODE_PLAYBACK: 10,
  VARIANT_PLAYBACK: 11,
  ON_DECK_POSTER_ATLAS: 12
});

const ON_DECK_PAGE_SIZE = 12;

class OpenMovieCapabilityService {
  constructor(key) {
    this.key = Buffer.from(key);
    if (this.key.length !== 32) throw new Error("OpenMovie capability key must be 32 bytes");
  }

  bootstrap(apiKeyId) {
    return {
      moviesUrl: this.url(OPERATIONS.MOVIES, apiKeyId, 1),
      tvUrl: this.url(OPERATIONS.TV, apiKeyId, 1),
      onDeckUrl: this.url(OPERATIONS.ON_DECK, apiKeyId, 1)
    };
  }

  url(operation, apiKeyId, ...values) {
    return `/api/openmovie/access/${this.encrypt(operation, apiKeyId, values)}`;
  }

  encrypt(operation, apiKeyId, values = []) {
    const principal = apiKeyIdBuffer(apiKeyId);
    const body = Buffer.concat([
      Buffer.from([VERSION, operation]),
      principal,
      ...values.map(encodeUnsignedVarint)
    ]);
    const nonce = crypto.randomBytes(NONCE_BYTES);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(AAD);
    const ciphertext = Buffer.concat([cipher.update(body), cipher.final()]);
    return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]).toString("base64url");
  }

  decrypt(token) {
    try {
      const packed = Buffer.from(String(token || ""), "base64url");
      if (packed.length < NONCE_BYTES + TAG_BYTES + 2 + API_KEY_ID_BYTES) return null;
      const nonce = packed.subarray(0, NONCE_BYTES);
      const tag = packed.subarray(packed.length - TAG_BYTES);
      const ciphertext = packed.subarray(NONCE_BYTES, packed.length - TAG_BYTES);
      const decipher = crypto.createDecipheriv("aes-256-gcm", this.key, nonce);
      decipher.setAAD(AAD);
      decipher.setAuthTag(tag);
      const body = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      if (body[0] !== VERSION || !operationName(body[1])) return null;
      const values = [];
      let offset = 2 + API_KEY_ID_BYTES;
      while (offset < body.length) {
        const decoded = decodeUnsignedVarint(body, offset);
        values.push(decoded.value);
        offset = decoded.offset;
      }
      return {
        operation: body[1],
        operationName: operationName(body[1]),
        apiKeyId: body.subarray(2, 2 + API_KEY_ID_BYTES).toString("hex"),
        values
      };
    } catch (err) {
      return null;
    }
  }

  protectMovieCatalogue(items, apiKeyId, currentOffset = 1) {
    const atlasUrls = new Map();
    const protectedItems = (items || []).map((movie) => this.protectMovie(movie, apiKeyId, atlasUrls));
    return {
      offsetUrl: this.url(OPERATIONS.MOVIES, apiKeyId, nextOffset(items, currentOffset)),
      items: protectedItems
    };
  }

  protectTvCatalogue(items, apiKeyId, currentOffset = 1) {
    const atlasUrls = new Map();
    const protectedItems = (items || []).map((show) => this.protectShow(show, apiKeyId, atlasUrls));
    return {
      offsetUrl: this.url(OPERATIONS.TV, apiKeyId, nextEpisodeOffset(items, currentOffset)),
      items: protectedItems
    };
  }

  futureUrls(apiKeyId, nextIds, count) {
    return {
      count,
      movies: futureSequence(nextIds.movie, count, (id) => ({
        posterUrl: this.url(OPERATIONS.MOVIE_POSTER, apiKeyId, id),
        playbackUrl: this.url(OPERATIONS.MOVIE_PLAYBACK, apiKeyId, id)
      })),
      episodes: futureSequence(nextIds.episode, count, (id) => ({
        posterUrl: this.url(OPERATIONS.EPISODE_POSTER, apiKeyId, id),
        showPosterUrl: this.url(OPERATIONS.SHOW_POSTER, apiKeyId, id),
        seasonPosterUrl: this.url(OPERATIONS.SEASON_POSTER, apiKeyId, id),
        playbackUrl: this.url(OPERATIONS.EPISODE_PLAYBACK, apiKeyId, id)
      })),
      variants: futureSequence(nextIds.variant, count, (id) => ({
        playbackUrl: this.url(OPERATIONS.VARIANT_PLAYBACK, apiKeyId, id)
      })),
      onDeckPages: futurePageSequence(count, (page) => ({
        pageUrl: this.url(OPERATIONS.ON_DECK, apiKeyId, page),
        posterAtlasUrl: this.url(OPERATIONS.ON_DECK_POSTER_ATLAS, apiKeyId, page)
      }))
    };
  }

  protectOnDeckPage(items, apiKeyId, page, totalItems) {
    const atlasUrl = this.url(OPERATIONS.ON_DECK_POSTER_ATLAS, apiKeyId, page);
    const protectedItems = (items || []).map((item, slot) => {
      const kind = item.showTitle ? "episode" : "movie";
      const protectedItem = this.protectPlayable(item, kind, apiKeyId);
      protectedItem.posterUrl = this.url(
        kind === "episode" ? OPERATIONS.SEASON_POSTER : OPERATIONS.MOVIE_POSTER,
        apiKeyId,
        item.id
      );
      protectedItem.posterAtlas = {
        url: atlasUrl,
        slot,
        page: page - 1,
        layout: 1
      };
      return protectedItem;
    });
    return {
      page,
      pageSize: ON_DECK_PAGE_SIZE,
      pageCount: Math.ceil(totalItems / ON_DECK_PAGE_SIZE),
      totalItems,
      posterAtlasUrl: atlasUrl,
      nextPageUrl: this.url(OPERATIONS.ON_DECK, apiKeyId, page + 1),
      nextPosterAtlasUrl: this.url(OPERATIONS.ON_DECK_POSTER_ATLAS, apiKeyId, page + 1),
      items: protectedItems
    };
  }

  protectMovie(movie, apiKeyId, atlasUrls = new Map()) {
    const output = this.protectPlayable(movie, "movie", apiKeyId);
    output.posterUrl = this.url(OPERATIONS.MOVIE_POSTER, apiKeyId, movie.id);
    return protectAtlas(output, apiKeyId, this, atlasUrls);
  }

  protectShow(show, apiKeyId, atlasUrls = new Map()) {
    const seasons = (show.seasons || []).map((season) => this.protectSeason(season, apiKeyId, atlasUrls));
    const firstEpisodeId = firstId((show.seasons || []).flatMap((season) => season.episodes || []));
    const { posterUrl, ...publicShow } = show;
    const output = { ...publicShow, seasons };
    output.posterUrl = firstEpisodeId
      ? this.url(OPERATIONS.SHOW_POSTER, apiKeyId, firstEpisodeId)
      : null;
    return protectAtlas(output, apiKeyId, this, atlasUrls);
  }

  protectSeason(season, apiKeyId, atlasUrls = new Map()) {
    const episodes = (season.episodes || []).map((episode) => this.protectEpisode(episode, apiKeyId, atlasUrls));
    const firstEpisodeId = firstId(season.episodes);
    const { posterUrl, ...publicSeason } = season;
    const output = { ...publicSeason, episodes };
    output.posterUrl = firstEpisodeId
      ? this.url(OPERATIONS.SEASON_POSTER, apiKeyId, firstEpisodeId)
      : null;
    return protectAtlas(output, apiKeyId, this, atlasUrls);
  }

  protectEpisode(episode, apiKeyId, atlasUrls = new Map()) {
    const output = this.protectPlayable(episode, "episode", apiKeyId);
    output.posterUrl = this.url(OPERATIONS.EPISODE_POSTER, apiKeyId, episode.id);
    return protectAtlas(output, apiKeyId, this, atlasUrls);
  }

  protectPlayable(item, kind, apiKeyId) {
    const playbackOperation = kind === "episode" ? OPERATIONS.EPISODE_PLAYBACK : OPERATIONS.MOVIE_PLAYBACK;
    const { id, playbackUrl, playbackVariants, ...publicItem } = item;
    return {
      ...publicItem,
      playbackUrl: this.url(playbackOperation, apiKeyId, id),
      playbackVariants: (playbackVariants || []).map((variant) => {
        const { id: variantId, playbackUrl: previousUrl, ...publicVariant } = variant;
        return {
          ...publicVariant,
          playbackUrl: this.url(OPERATIONS.VARIANT_PLAYBACK, apiKeyId, variantId)
        };
      })
    };
  }
}

function futureSequence(startId, count, createUrls) {
  return {
    startId,
    endId: startId + count - 1,
    urls: Array.from({ length: count }, (_, index) => createUrls(startId + index))
  };
}

function futurePageSequence(count, createUrls) {
  return {
    startPage: 1,
    endPage: count,
    urls: Array.from({ length: count }, (_, index) => createUrls(index + 1))
  };
}

function protectAtlas(item, apiKeyId, service, atlasUrls) {
  if (!item.posterAtlas || !item.posterAtlas.id) return item;
  const { id, ...assignment } = item.posterAtlas;
  let url = atlasUrls.get(id);
  if (!url) {
    url = service.url(OPERATIONS.POSTER_ATLAS, apiKeyId, id);
    atlasUrls.set(id, url);
  }
  return {
    ...item,
    posterAtlas: {
      ...assignment,
      url
    }
  };
}

function firstId(items) {
  const item = (items || []).find((entry) => Number.isSafeInteger(Number(entry.id)) && Number(entry.id) > 0);
  return item ? Number(item.id) : null;
}

function nextOffset(items, currentOffset) {
  return Math.max(Number(currentOffset) - 1, ...(items || []).map((item) => Number(item.id) || 0)) + 1;
}

function nextEpisodeOffset(shows, currentOffset) {
  return Math.max(Number(currentOffset) - 1, ...(shows || []).flatMap((show) => (show.seasons || [])
    .flatMap((season) => (season.episodes || []).map((episode) => Number(episode.id) || 0)))) + 1;
}

function apiKeyIdBuffer(value) {
  const text = String(value || "");
  if (!/^[a-f0-9]{16}$/i.test(text)) throw new Error("API key record ID is invalid");
  return Buffer.from(text, "hex");
}

function encodeUnsignedVarint(value) {
  let remaining = Number(value);
  if (!Number.isSafeInteger(remaining) || remaining < 0) throw new Error("Capability value must be a non-negative integer");
  const bytes = [];
  do {
    let byte = remaining % 128;
    remaining = Math.floor(remaining / 128);
    if (remaining > 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining > 0);
  return Buffer.from(bytes);
}

function decodeUnsignedVarint(buffer, start) {
  let value = 0;
  let multiplier = 1;
  let offset = start;
  while (offset < buffer.length && multiplier <= Number.MAX_SAFE_INTEGER) {
    const byte = buffer[offset];
    value += (byte & 0x7f) * multiplier;
    offset += 1;
    if ((byte & 0x80) === 0) {
      if (!Number.isSafeInteger(value)) throw new Error("Capability value is too large");
      return { value, offset };
    }
    multiplier *= 128;
  }
  throw new Error("Capability value is invalid");
}

function operationName(operation) {
  return Object.keys(OPERATIONS).find((name) => OPERATIONS[name] === operation) || null;
}

module.exports = {
  OpenMovieCapabilityService,
  OPEN_MOVIE_OPERATIONS: OPERATIONS,
  OPEN_MOVIE_ON_DECK_PAGE_SIZE: ON_DECK_PAGE_SIZE
};
