const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const logger = require("../utils/logger");

const LABELLED_PLACEHOLDER_VERSION = 3;

class OpenMovieArtworkService {
  constructor(mediaIndex, metadata, imageProcessor, cachePath) {
    this.mediaIndex = mediaIndex;
    this.metadata = metadata;
    this.imageProcessor = imageProcessor;
    this.placeholderPath = path.resolve(__dirname, "..", "..", "public", "icons", "media-baker-512.png");
    this.labelledPlaceholderDirectory = path.join(cachePath, "openmovie-labelled-placeholders");
    this.labelledPlaceholderOperations = new Map();
  }

  async movie(library, item) {
    let record = null;
    let filePath = null;
    let reason = "Metadata service is unavailable.";
    try {
      if (this.metadata) {
        record = await this.metadata.getForMedia(library.key, item);
        filePath = record && record.available && record.posterFilename
          ? await this.metadata.ensurePosterFile(record.posterFilename)
          : null;
        reason = record && record.posterUnavailableReason || "Movie poster is unavailable.";
      }
    } catch (err) {
      reason = err.message;
    }
    if (filePath) return filePath;

    logger.info(
      `[openmovie] movie artwork unresolved movieId=${item && item.id || "unknown"} `
      + `provider=${record && record.provider || "unknown"} `
      + `providerId=${record && record.providerId || "unknown"} source=placeholder `
      + `reason="${singleLine(reason)}"`
    );
    return this.labelledPlaceholder(record && record.title || item && item.title, "Unknown movie");
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
    return this.labelledPlaceholder(show && show.name || context.showName, "Unknown show");
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
    if (mode === "show") {
      return this.show(resolved.library, context.show, {
        episodeId: resolved.id,
        showName: resolved.item.showName
      });
    }
    if (mode === "season") return this.season(resolved.library, context.show, context.season);
    return this.episode(resolved.library, context.show, context.season, resolved.item);
  }

  async labelledPlaceholder(value, fallbackLabel = "Unknown media") {
    const label = String(value || fallbackLabel).trim() || fallbackLabel;
    if (!this.imageProcessor || typeof this.imageProcessor.createLabelledPoster !== "function") {
      return this.placeholderPath;
    }
    const key = crypto.createHash("sha256")
      .update(`${LABELLED_PLACEHOLDER_VERSION}:${label}`)
      .digest("hex");
    const filePath = path.join(this.labelledPlaceholderDirectory, `${key}.webp`);
    if (await existingFile(filePath)) return filePath;
    if (this.labelledPlaceholderOperations.has(key)) return this.labelledPlaceholderOperations.get(key);

    const operation = this.imageProcessor.createLabelledPoster(this.placeholderPath, filePath, label)
      .then(() => filePath)
      .catch((err) => {
        logger.error(`[openmovie] labelled placeholder failed title="${singleLine(label)}" message="${singleLine(err.message)}"`, err);
        return this.placeholderPath;
      })
      .finally(() => this.labelledPlaceholderOperations.delete(key));
    this.labelledPlaceholderOperations.set(key, operation);
    return operation;
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

async function existingFile(filePath) {
  try {
    const stats = await fs.stat(filePath);
    return stats.isFile();
  } catch (err) {
    if (err.code === "ENOENT") return false;
    throw err;
  }
}

module.exports = { LABELLED_PLACEHOLDER_VERSION, OpenMovieArtworkService };
