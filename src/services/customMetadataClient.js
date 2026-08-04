class CustomMetadataClient {
  constructor(config) {
    this.config = config;
  }

  active() {
    const settings = this.config.metadata && this.config.metadata.customService;
    return Boolean(this.config.metadata && this.config.metadata.source === "custom" && settings && settings.baseUrl && settings.apiKey);
  }

  async fetchVideoUrl(url) {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/^\/3\/?/, "/");
    const language = parsed.searchParams.get("language") || this.config.metadata.language;
    const artworkLanguages = parsed.searchParams.get("include_image_language") || this.config.metadata.posterLanguages;
    let match = path.match(/^\/search\/(movie|tv)$/);
    if (match) {
      const kind = match[1];
      const response = await this.search({
        mediaType: kind === "tv" ? "series" : "movie",
        title: parsed.searchParams.get("query"),
        year: parsed.searchParams.get(kind === "tv" ? "first_air_date_year" : "primary_release_year"),
        language,
        artworkLanguages
      });
      return { results: response.items.map((item) => videoRaw(item, kind)) };
    }

    match = path.match(/^\/(movie|tv)\/([^/]+)$/);
    if (match) {
      const kind = match[1];
      return videoRaw((await this.media(kind === "tv" ? "series" : "movie", match[2], { language, artworkLanguages })).item, kind);
    }
    match = path.match(/^\/tv\/([^/]+)\/season\/([^/]+)$/);
    if (match) return seasonRaw((await this.season(match[1], match[2], { language, artworkLanguages })).item);
    match = path.match(/^\/tv\/([^/]+)\/season\/([^/]+)\/episode\/([^/]+)$/);
    if (match) return episodeRaw((await this.episode(match[1], match[2], match[3], { language, artworkLanguages })).item);
    match = path.match(/^\/(movie|tv)\/([^/]+)\/images$/);
    if (match) {
      const mediaType = match[1] === "tv" ? "series" : "movie";
      const item = (await this.media(mediaType, match[2], { language, artworkLanguages })).item;
      return { posters: artworkId(item) ? [{ file_path: assetPath(artworkId(item)), iso_639_1: null, vote_average: 0 }] : [] };
    }
    throw new Error(`Unsupported custom metadata video request: ${path}`);
  }

  search(input) {
    return this.request("/api/v1/search", { method: "POST", body: input });
  }

  media(mediaType, id, options = {}) {
    return this.request(`/api/v1/media/${encodeURIComponent(mediaType)}/${encodeURIComponent(id)}${query(options)}`);
  }

  season(id, season, options = {}) {
    return this.request(`/api/v1/series/${encodeURIComponent(id)}/seasons/${encodeURIComponent(season)}${query(options)}`);
  }

  episode(id, season, episode, options = {}) {
    return this.request(`/api/v1/series/${encodeURIComponent(id)}/seasons/${encodeURIComponent(season)}/episodes/${encodeURIComponent(episode)}${query(options)}`);
  }

  async artwork(assetId) {
    const response = await fetch(this.url(`/api/v1/assets/${encodeURIComponent(assetId)}`), { headers: this.headers(false) });
    if (!response.ok) throw new Error(`Custom metadata artwork request failed with HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }

  async request(path, options = {}) {
    const response = await fetch(this.url(path), {
      method: options.method || "GET",
      headers: this.headers(Boolean(options.body)),
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    if (!response.ok) {
      let message = `Custom metadata request failed with HTTP ${response.status}`;
      try {
        const body = await response.json();
        if (body.error) message = body.error;
      } catch (err) {
        // Keep the HTTP status when the response is not JSON.
      }
      throw new Error(message);
    }
    return response.json();
  }

  url(path) {
    const base = String(this.config.metadata.customService.baseUrl).replace(/\/+$/, "");
    return `${base}${path}`;
  }

  headers(json) {
    return {
      Accept: json ? "application/json" : "image/webp",
      Authorization: `Bearer ${this.config.metadata.customService.apiKey}`,
      ...(json ? { "Content-Type": "application/json" } : {})
    };
  }
}

function videoRaw(item, kind) {
  const common = {
    id: item.id,
    overview: item.overview || null,
    original_language: item.originalLanguage || null,
    poster_path: artworkId(item) ? assetPath(artworkId(item)) : null,
    popularity: Number(item.popularity) || 0,
    vote_count: Number(item.voteCount) || 0
  };
  return kind === "tv"
    ? { ...common, name: item.title, original_name: item.originalTitle || item.title, first_air_date: item.releaseDate || yearDate(item.releaseYear) }
    : { ...common, title: item.title, original_title: item.originalTitle || item.title, release_date: item.releaseDate || yearDate(item.releaseYear) };
}

function seasonRaw(item) {
  return {
    id: item.id,
    name: item.title,
    air_date: item.releaseDate || yearDate(item.releaseYear),
    overview: item.overview || null,
    season_number: item.seasonNumber,
    poster_path: artworkId(item) ? assetPath(artworkId(item)) : null,
    episodes: (item.episodes || []).map(episodeRaw)
  };
}

function episodeRaw(item) {
  return {
    id: item.id,
    name: item.title,
    air_date: item.releaseDate || yearDate(item.releaseYear),
    overview: item.overview || null,
    season_number: item.seasonNumber,
    episode_number: item.episodeNumber,
    still_path: artworkId(item) ? assetPath(artworkId(item)) : null
  };
}

function artworkId(item) {
  return item && item.artwork && item.artwork.id || null;
}

function yearDate(year) {
  return Number.isFinite(Number(year)) ? `${Number(year)}-01-01` : null;
}

function assetPath(assetId) {
  return `custom-asset:${assetId}`;
}

function assetIdFromPath(value) {
  const match = String(value || "").match(/^custom-asset:([A-Za-z0-9._~-]+)$/);
  return match ? match[1] : null;
}

function query(options) {
  const params = new URLSearchParams();
  Object.entries(options || {}).forEach(([key, value]) => {
    if (value !== null && value !== undefined && value !== "") params.set(key, Array.isArray(value) ? value.join(",") : String(value));
  });
  const text = params.toString();
  return text ? `?${text}` : "";
}

module.exports = { CustomMetadataClient, assetIdFromPath, assetPath };
