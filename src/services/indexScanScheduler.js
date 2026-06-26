const logger = require("../utils/logger");

class IndexScanScheduler {
  constructor(config, mediaIndex, metadata) {
    this.config = config.indexScan;
    this.mediaIndex = mediaIndex;
    this.metadata = metadata;
    this.timer = null;
    this.running = false;
    this.pendingReason = null;
    this.status = {
      enabled: this.config.enabled,
      intervalSeconds: this.config.intervalSeconds,
      running: false,
      queued: false,
      pendingReason: null,
      lastStartedAt: null,
      lastFinishedAt: null,
      lastError: null
    };
  }

  start() {
    this.stop();
    this.status.enabled = this.config.enabled;
    this.status.intervalSeconds = this.config.intervalSeconds;
    if (!this.config.enabled) {
      logger.info("[index-scan] periodic scan disabled");
      return;
    }

    const intervalMs = this.config.intervalSeconds * 1000;
    this.timer = setInterval(() => {
      this.run("interval").catch((err) => {
        logger.error(`[index-scan] scan failed message="${err.message}"`, err);
      });
    }, intervalMs);

    if (typeof this.timer.unref === "function") {
      this.timer.unref();
    }

    logger.info(`[index-scan] periodic scan enabled intervalSeconds=${this.config.intervalSeconds}`);

    if (this.config.runOnStartup) {
      setImmediate(() => {
        this.run("startup").catch((err) => {
          logger.error(`[index-scan] startup scan failed message="${err.message}"`, err);
        });
      });
    }
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  restart() {
    this.stop();
    this.start();
  }

  async run(reason) {
    if (this.running) {
      this.pendingReason = reason;
      this.status.queued = true;
      this.status.pendingReason = reason;
      logger.info(`[index-scan] queued reason=${reason} status=already-running`);
      return this.status;
    }

    this.running = true;
    this.status.running = true;
    this.status.queued = false;
    this.status.pendingReason = null;
    this.status.lastStartedAt = new Date().toISOString();
    this.status.lastError = null;

    const before = countIndex(this.mediaIndex.index);
    logger.info(`[index-scan] started reason=${reason} total=${before.total}`);

    try {
      await this.mediaIndex.reindex();
      const after = countIndex(this.mediaIndex.index);
      logger.info(`[index-scan] complete previousTotal=${before.total} total=${after.total} delta=${after.total - before.total}`);
      this.status.lastFinishedAt = new Date().toISOString();

      if (this.metadata && this.metadata.config.enabled && this.metadata.config.preloadOnStartup) {
        this.metadata.preloadAll(this.mediaIndex).catch((err) => {
          logger.error(`[metadata] background preload after scan failed message="${err.message}"`, err);
        });
      }
    } catch (err) {
      this.status.lastError = err.message;
      throw err;
    } finally {
      this.running = false;
      this.status.running = false;
      this.runPending();
    }

    return this.status;
  }

  getStatus() {
    return { ...this.status };
  }

  runPending() {
    const reason = this.pendingReason;
    this.pendingReason = null;
    this.status.queued = false;
    this.status.pendingReason = null;
    if (!reason) {
      return;
    }

    this.mediaIndex.syncLibrariesFromConfig()
      .catch((err) => {
        logger.error(`[index-scan] queued library sync failed message="${err.message}"`, err);
      })
      .finally(() => {
        setImmediate(() => {
          this.run(`${reason}-queued`).catch((err) => {
            logger.error(`[index-scan] queued scan failed message="${err.message}"`, err);
          });
        });
      });
  }
}

function countIndex(index) {
  const libraries = Array.isArray(index.libraries) ? index.libraries : [];
  const counts = {};
  let total = 0;

  for (const library of libraries) {
    const collection = index[library.key];
    const count = library.type === "tv"
      ? countEpisodes(collection)
      : countMovies(collection);
    counts[library.key] = count;
    total += count;
  }

  return { ...counts, total };
}

function countEpisodes(collection) {
  const episodeCount = (collection && collection.shows || []).reduce((count, show) => (
    count + show.seasons.reduce((seasonCount, season) => seasonCount + season.episodes.length, 0)
  ), 0);
  return episodeCount + countMovies(collection);
}

function countMovies(collection) {
  return collection && collection.items ? collection.items.length : 0;
}

module.exports = { IndexScanScheduler };
