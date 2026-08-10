const path = require("path");
const logger = require("../utils/logger");

class OpenMovieArtworkService {
  constructor(mediaIndex, metadata) {
    this.mediaIndex = mediaIndex;
    this.metadata = metadata;
    this.placeholderPath = path.resolve(__dirname, "..", "..", "public", "icons", "media-baker-512.png");
  }

  async movie(library, item) {
    if (!this.metadata) return this.placeholderPath;
    const record = await this.metadata.getForMedia(library.key, item);
    const filePath = record && record.available && record.posterFilename
      ? await this.metadata.ensurePosterFile(record.posterFilename)
      : null;
    return filePath || this.placeholderPath;
  }

  async show(library, show, context = {}) {
    let resolution;
    try {
      resolution = this.metadata && show
        ? await this.metadata.ensureShowPosterForShow(library.key, show)
        : {
            available: false,
            source: "placeholder",
            reason: !show ? "Parent show is unavailable." : "Metadata service is unavailable.",
            provider: null,
            providerId: null
          };
    } catch (err) {
      resolution = {
        available: false,
        source: "placeholder",
        reason: err.message,
        provider: null,
        providerId: null
      };
    }
    if (resolution.available && resolution.filePath) return resolution.filePath;

    logger.info(
      `[openmovie] show artwork unresolved episodeId=${context.episodeId || "unknown"} `
      + `parentShowId=${show && show.id || "unknown"} provider=${resolution.provider || "unknown"} `
      + `providerId=${resolution.providerId || "unknown"} source=${resolution.source || "placeholder"} `
      + `reason="${singleLine(resolution.reason || "Show poster is unavailable.")}"`
    );
    return this.placeholderPath;
  }

  async season(library, show, season) {
    const episodes = season && Array.isArray(season.episodes) ? season.episodes : [];
    if (this.metadata && episodes.length > 0) {
      const poster = await this.metadata.ensureSeasonPosterForMedia(
        library.key,
        episodes[0],
        showEpisodes(show)
      );
      if (poster && poster.available && poster.filePath) return poster.filePath;
    }
    return this.show(library, show);
  }

  async episode(library, show, season, episode) {
    if (this.metadata) {
      const thumbnail = await this.metadata.ensureThumbnailForMedia(library.key, episode);
      if (thumbnail && thumbnail.available && thumbnail.filePath) return thumbnail.filePath;
    }
    return this.season(library, show, season);
  }

  async resolvedMovie(resolved) {
    return this.movie(resolved.library, resolved.item);
  }

  async resolvedEpisode(resolved, mode = "episode") {
    const context = await this.episodeContext(resolved);
    if (mode === "show") return this.show(resolved.library, context.show, { episodeId: resolved.id });
    if (mode === "season") return this.season(resolved.library, context.show, context.season);
    return this.episode(resolved.library, context.show, context.season, resolved.item);
  }

  async episodeContext(resolved) {
    const show = resolved.item.showId
      ? await this.mediaIndex.getShow(resolved.item.showId, resolved.library.key)
      : null;
    const seasonNumber = Number.parseInt(resolved.item.season, 10);
    const season = show && (show.seasons || []).find((entry) => Number.parseInt(entry.season, 10) === seasonNumber)
      || { season: seasonNumber, episodes: [resolved.item] };
    return { show, season };
  }
}

function singleLine(value) {
  return String(value || "").replace(/[\r\n]+/g, " ").replace(/"/g, "'");
}

function showEpisodes(show) {
  return (show && show.seasons || []).flatMap((season) => season.episodes || []);
}

module.exports = { OpenMovieArtworkService };
