const mysql = require("mysql2/promise");
const logger = require("../../utils/logger");

class MysqlIndexStore {
  constructor(config) {
    this.rootConfig = config;
    this.config = config.mysql;
    this.pool = null;
    this.initialized = false;
    this.type = "mysql";
  }

  async load() {
    await this.init();

    const [[meta]] = await this.pool.execute("SELECT generated_at, libraries_json FROM media_index_meta WHERE id = 1");
    if (!meta) {
      logger.info("[index] MySQL index missing; will reindex");
      return null;
    }

    const index = {
      generatedAt: toIsoString(meta.generated_at),
      libraries: JSON.parse(meta.libraries_json)
    };
    for (const library of this.rootConfig.libraries) {
      index[library.key] = library.type === "tv"
        ? await this.loadTvCollection(library.key)
        : await this.loadMovieCollection(library.key);
    }

    logger.info("[index] loaded MySQL index");
    return index;
  }

  async save(index) {
    await this.init();

    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.query("DELETE FROM media_episodes");
      await connection.query("DELETE FROM media_seasons");
      await connection.query("DELETE FROM media_shows");
      await connection.query("DELETE FROM media_movies");

      await connection.execute(
        `INSERT INTO media_index_meta (id, generated_at, libraries_json)
         VALUES (1, ?, ?)
         ON DUPLICATE KEY UPDATE generated_at = VALUES(generated_at), libraries_json = VALUES(libraries_json)`,
        [new Date(index.generatedAt), JSON.stringify(index.libraries)]
      );

      for (const library of this.rootConfig.libraries) {
        if (library.type === "tv") {
          await this.insertTvCollection(connection, library.key, index[library.key]);
        } else {
          await this.insertMovieCollection(connection, library.key, index[library.key]);
        }
      }

      await connection.commit();
    } catch (err) {
      await connection.rollback();
      throw err;
    } finally {
      connection.release();
    }

    logger.info("[index] saved MySQL index");
  }

  async init() {
    if (this.initialized) {
      return;
    }

    this.pool = mysql.createPool({
      host: this.config.host,
      port: this.config.port,
      user: this.config.user,
      password: this.config.password,
      database: this.config.database,
      waitForConnections: true,
      connectionLimit: this.config.connectionLimit
    });

    try {
      await this.pool.execute("DROP TABLE IF EXISTS media_index");
    } catch (err) {
      logger.full(`[index] old media_index table cleanup skipped: ${err.message}`);
    }

    await this.pool.execute(`
      CREATE TABLE IF NOT EXISTS media_index_meta (
        id TINYINT NOT NULL PRIMARY KEY,
        generated_at DATETIME NOT NULL,
        libraries_json TEXT NOT NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    await this.pool.execute(`
      CREATE TABLE IF NOT EXISTS media_shows (
        collection VARCHAR(32) NOT NULL,
        id VARCHAR(64) NOT NULL,
        name VARCHAR(512) NOT NULL,
        path TEXT NOT NULL,
        PRIMARY KEY (collection, id),
        INDEX idx_media_shows_name (name)
      )
    `);

    await this.pool.execute(`
      CREATE TABLE IF NOT EXISTS media_seasons (
        collection VARCHAR(32) NOT NULL,
        show_id VARCHAR(64) NOT NULL,
        season INT NOT NULL,
        name VARCHAR(255) NOT NULL,
        PRIMARY KEY (collection, show_id, season)
      )
    `);

    await this.pool.execute(`
      CREATE TABLE IF NOT EXISTS media_episodes (
        collection VARCHAR(32) NOT NULL,
        id VARCHAR(64) NOT NULL,
        show_id VARCHAR(64) NOT NULL,
        show_name VARCHAR(512) NOT NULL,
        season INT NULL,
        episode INT NULL,
        title VARCHAR(512) NOT NULL,
        filename VARCHAR(512) NOT NULL,
        file_path TEXT NOT NULL,
        added_at_ms DOUBLE NULL,
        mtime_ms DOUBLE NULL,
        PRIMARY KEY (collection, id),
        INDEX idx_media_episodes_show (collection, show_id),
        INDEX idx_media_episodes_title (title)
      )
    `);

    await this.pool.execute(`
      CREATE TABLE IF NOT EXISTS media_movies (
        collection VARCHAR(32) NOT NULL,
        id VARCHAR(64) NOT NULL,
        title VARCHAR(512) NOT NULL,
        release_year INT NULL,
        filename VARCHAR(512) NOT NULL,
        folder VARCHAR(512) NOT NULL,
        file_path TEXT NOT NULL,
        added_at_ms DOUBLE NULL,
        mtime_ms DOUBLE NULL,
        PRIMARY KEY (collection, id),
        INDEX idx_media_movies_title (title)
      )
    `);

    await ensureColumn(this.pool, "media_episodes", "added_at_ms", "DOUBLE NULL");
    await ensureColumn(this.pool, "media_episodes", "mtime_ms", "DOUBLE NULL");
    await ensureColumn(this.pool, "media_movies", "added_at_ms", "DOUBLE NULL");
    await ensureColumn(this.pool, "media_movies", "mtime_ms", "DOUBLE NULL");

    this.initialized = true;
    logger.info(`[index] MySQL index store ready host=${this.config.host} database=${this.config.database}`);
  }

  async loadTvCollection(collection) {
    const [showRows] = await this.pool.execute(
      "SELECT id, name, path FROM media_shows WHERE collection = ? ORDER BY name",
      [collection]
    );
    const [seasonRows] = await this.pool.execute(
      "SELECT show_id, season, name FROM media_seasons WHERE collection = ? ORDER BY season",
      [collection]
    );
    const [episodeRows] = await this.pool.execute(
      "SELECT id, show_id, show_name, season, episode, title, filename, file_path, added_at_ms, mtime_ms FROM media_episodes WHERE collection = ? ORDER BY season, episode, filename",
      [collection]
    );
    const movieCollection = await this.loadMovieCollection(collection);

    const episodesById = {};
    const seasonsByShow = new Map();

    for (const row of seasonRows) {
      const seasons = seasonsByShow.get(row.show_id) || [];
      seasons.push({
        season: row.season,
        name: row.name,
        episodes: []
      });
      seasonsByShow.set(row.show_id, seasons);
    }

    for (const row of episodeRows) {
      const episode = {
        id: row.id,
        showId: row.show_id,
        showName: row.show_name,
        season: row.season,
        episode: row.episode,
        title: row.title,
        filename: row.filename,
        filePath: row.file_path,
        addedAtMs: numberOrNull(row.added_at_ms),
        mtimeMs: numberOrNull(row.mtime_ms)
      };
      episodesById[episode.id] = episode;

      const seasons = seasonsByShow.get(episode.showId) || [];
      let season = seasons.find((entry) => entry.season === episode.season);
      if (!season) {
        season = { season: episode.season || 0, name: `Season ${episode.season || 0}`, episodes: [] };
        seasons.push(season);
        seasonsByShow.set(episode.showId, seasons);
      }
      season.episodes.push(episode);
    }

    return {
      shows: showRows.map((row) => ({
        id: row.id,
        name: row.name,
        path: row.path,
        seasons: (seasonsByShow.get(row.id) || [])
          .map((season) => ({
            ...season,
            episodes: season.episodes.sort(sortEpisodes)
          }))
          .sort((a, b) => a.season - b.season)
      })),
      items: movieCollection.items,
      byId: movieCollection.byId,
      episodesById
    };
  }

  async loadMovieCollection(collection) {
    const [rows] = await this.pool.execute(
      "SELECT id, title, release_year, filename, folder, file_path, added_at_ms, mtime_ms FROM media_movies WHERE collection = ? ORDER BY title, release_year",
      [collection]
    );

    const items = rows.map((row) => ({
      id: row.id,
      title: row.title,
      year: row.release_year,
      filename: row.filename,
      folder: row.folder,
      filePath: row.file_path,
      addedAtMs: numberOrNull(row.added_at_ms),
      mtimeMs: numberOrNull(row.mtime_ms)
    }));
    const byId = Object.fromEntries(items.map((movie) => [movie.id, movie]));

    return { items, byId };
  }

  async insertTvCollection(connection, collection, tvIndex) {
    const shows = [];
    const seasons = [];
    const episodes = [];

    for (const show of tvIndex.shows) {
      shows.push([collection, show.id, show.name, show.path]);
      const seasonsByNumber = new Map();
      for (const season of show.seasons) {
        const seasonNumber = season.season || 0;
        if (!seasonsByNumber.has(seasonNumber)) {
          seasonsByNumber.set(seasonNumber, [collection, show.id, seasonNumber, season.name]);
        }
        for (const episode of season.episodes) {
          episodes.push([
            collection,
            episode.id,
            episode.showId,
            episode.showName,
            episode.season,
            episode.episode,
            episode.title,
            episode.filename,
            episode.filePath,
            episode.addedAtMs || null,
            episode.mtimeMs || null
          ]);
        }
      }
      seasons.push(...seasonsByNumber.values());
    }

    await bulkInsert(connection, "media_shows", ["collection", "id", "name", "path"], shows);
    await bulkInsert(connection, "media_seasons", ["collection", "show_id", "season", "name"], seasons);
    await bulkInsert(connection, "media_episodes", ["collection", "id", "show_id", "show_name", "season", "episode", "title", "filename", "file_path", "added_at_ms", "mtime_ms"], episodes);
    await this.insertMovieCollection(connection, collection, {
      items: tvIndex.items || []
    });
  }

  async insertMovieCollection(connection, collection, movieIndex) {
    const rows = movieIndex.items.map((movie) => [
      collection,
      movie.id,
      movie.title,
      movie.year,
      movie.filename,
      movie.folder,
      movie.filePath,
      movie.addedAtMs || null,
      movie.mtimeMs || null
    ]);

    await bulkInsert(connection, "media_movies", ["collection", "id", "title", "release_year", "filename", "folder", "file_path", "added_at_ms", "mtime_ms"], rows);
  }
}

async function ensureColumn(pool, table, column, definition) {
  const [rows] = await pool.execute(
    `SELECT COUNT(*) AS count
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND COLUMN_NAME = ?`,
    [table, column]
  );

  if (Number(rows[0].count) > 0) {
    return;
  }

  await pool.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

async function bulkInsert(connection, table, columns, rows) {
  if (rows.length === 0) {
    return;
  }

  await connection.query(
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES ?`,
    [rows]
  );
}

function toIsoString(value) {
  if (value instanceof Date) {
    return value.toISOString();
  }

  return new Date(value).toISOString();
}

function numberOrNull(value) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sortEpisodes(a, b) {
  return (a.season || 0) - (b.season || 0) || (a.episode || 0) - (b.episode || 0) || a.filename.localeCompare(b.filename);
}

module.exports = { MysqlIndexStore };
