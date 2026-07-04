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

    logger.info("[index] loaded MySQL index metadata");
    return {
      generatedAt: toIsoString(meta.generated_at),
      libraries: JSON.parse(meta.libraries_json)
    };
  }

  async loadSnapshot() {
    const index = await this.load();
    if (!index) {
      return null;
    }
    for (const library of this.rootConfig.libraries) {
      index[library.key] = library.type === "tv"
        ? await this.loadTvCollection(library.key)
        : library.type === "music"
          ? await this.loadMusicCollection(library.key)
          : await this.loadMovieCollection(library.key);
    }

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
      await connection.query("DELETE FROM media_tracks");
      await connection.query("DELETE FROM media_albums");
      await connection.query("DELETE FROM media_artists");

      await connection.execute(
        `INSERT INTO media_index_meta (id, generated_at, libraries_json)
         VALUES (1, ?, ?)
         ON DUPLICATE KEY UPDATE generated_at = VALUES(generated_at), libraries_json = VALUES(libraries_json)`,
        [new Date(index.generatedAt), JSON.stringify(index.libraries)]
      );

      for (const library of this.rootConfig.libraries) {
        if (library.type === "tv") {
          await this.insertTvCollection(connection, library.key, index[library.key]);
        } else if (library.type === "music") {
          await this.insertMusicCollection(connection, library.key, index[library.key]);
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

  async saveMeta(index) {
    await this.init();
    await this.pool.execute(
      `INSERT INTO media_index_meta (id, generated_at, libraries_json)
       VALUES (1, ?, ?)
       ON DUPLICATE KEY UPDATE generated_at = VALUES(generated_at), libraries_json = VALUES(libraries_json)`,
      [new Date(index.generatedAt || Date.now()), JSON.stringify(index.libraries || [])]
    );
  }

  async saveLibrary(library, collection, indexMeta) {
    await this.init();
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      for (const table of collectionTables(library.type)) {
        await connection.execute(`DELETE FROM ${table} WHERE collection = ?`, [library.key]);
      }
      if (library.type === "tv") {
        await this.insertTvCollection(connection, library.key, collection);
      } else if (library.type === "music") {
        await this.insertMusicCollection(connection, library.key, collection);
      } else {
        await this.insertMovieCollection(connection, library.key, collection);
      }
      await connection.execute(
        `INSERT INTO media_index_meta (id, generated_at, libraries_json)
         VALUES (1, ?, ?)
         ON DUPLICATE KEY UPDATE generated_at = VALUES(generated_at), libraries_json = VALUES(libraries_json)`,
        [new Date(indexMeta.generatedAt), JSON.stringify(indexMeta.libraries)]
      );
      await connection.commit();
    } catch (err) {
      await connection.rollback();
      throw err;
    } finally {
      connection.release();
    }
    logger.info(`[index] saved MySQL library collection=${library.key}`);
  }

  async getGeneratedCounts() {
    await this.init();
    const counts = {};
    for (const library of this.rootConfig.libraries) {
      const table = library.type === "tv" ? "media_episodes" : library.type === "music" ? "media_tracks" : "media_movies";
      const [[row]] = await this.pool.execute(`SELECT COUNT(*) AS count FROM ${table} WHERE collection = ?`, [library.key]);
      let count = Number(row.count) || 0;
      if (library.type === "tv") {
        const [[loose]] = await this.pool.execute("SELECT COUNT(*) AS count FROM media_movies WHERE collection = ?", [library.key]);
        count += Number(loose.count) || 0;
      }
      counts[library.key] = count;
    }
    return counts;
  }

  async getMovie(collection, id) {
    await this.init();
    const [rows] = await this.pool.execute(
      "SELECT id, title, release_year, filename, folder, file_path, added_at_ms, mtime_ms FROM media_movies WHERE collection = ? AND id = ? LIMIT 1",
      [collection, id]
    );
    return rows[0] ? movieFromRow(rows[0]) : null;
  }

  async getEpisode(collection, id) {
    await this.init();
    const [rows] = await this.pool.execute(
      "SELECT id, show_id, show_name, season, episode, title, filename, file_path, added_at_ms, mtime_ms FROM media_episodes WHERE collection = ? AND id = ? LIMIT 1",
      [collection, id]
    );
    return rows[0] ? episodeFromRow(rows[0]) : null;
  }

  async getTrack(collection, id) {
    await this.init();
    const [rows] = await this.pool.execute(
      `SELECT id, artist_id, artist_name, album_id, album_name, release_year, disc_number,
              track_number, title, filename, file_path, added_at_ms, mtime_ms
       FROM media_tracks WHERE collection = ? AND id = ? LIMIT 1`,
      [collection, id]
    );
    return rows[0] ? trackFromRow(rows[0]) : null;
  }

  async getShow(collection, id) {
    await this.init();
    const [rows] = await this.pool.execute("SELECT id, name, path FROM media_shows WHERE collection = ? AND id = ? LIMIT 1", [collection, id]);
    if (!rows[0]) {
      return null;
    }
    const [seasonRows] = await this.pool.execute("SELECT season, name FROM media_seasons WHERE collection = ? AND show_id = ? ORDER BY season", [collection, id]);
    const [episodeRows] = await this.pool.execute(
      "SELECT id, show_id, show_name, season, episode, title, filename, file_path, added_at_ms, mtime_ms FROM media_episodes WHERE collection = ? AND show_id = ? ORDER BY season, episode, filename",
      [collection, id]
    );
    return showFromRows(rows[0], seasonRows, episodeRows);
  }

  async getSeason(collection, showId, seasonNumber) {
    await this.init();
    const season = Number(seasonNumber);
    const [seasonRows] = await this.pool.execute(
      "SELECT season, name FROM media_seasons WHERE collection = ? AND show_id = ? AND season = ? LIMIT 1",
      [collection, showId, season]
    );
    if (!seasonRows[0]) {
      return null;
    }
    const [episodeRows] = await this.pool.execute(
      `SELECT id, show_id, show_name, season, episode, title, filename, file_path, added_at_ms, mtime_ms
       FROM media_episodes WHERE collection = ? AND show_id = ? AND season = ?
       ORDER BY episode, filename`,
      [collection, showId, season]
    );
    return {
      season: seasonRows[0].season,
      name: seasonRows[0].name,
      episodes: episodeRows.map(episodeFromRow)
    };
  }

  async getArtist(collection, id) {
    await this.init();
    const [rows] = await this.pool.execute("SELECT id, name, path FROM media_artists WHERE collection = ? AND id = ? LIMIT 1", [collection, id]);
    if (!rows[0]) {
      return null;
    }
    const music = await this.loadMusicCollectionForArtist(collection, id);
    return { id: rows[0].id, name: rows[0].name, path: rows[0].path, albums: music };
  }

  async getAlbum(collection, artistId, albumId) {
    await this.init();
    const [albumRows] = await this.pool.execute(
      "SELECT id, artist_id, name, release_year, path FROM media_albums WHERE collection = ? AND artist_id = ? AND id = ? LIMIT 1",
      [collection, artistId, albumId]
    );
    if (!albumRows[0]) {
      return null;
    }
    const [trackRows] = await this.pool.execute(
      `SELECT id, artist_id, artist_name, album_id, album_name, release_year, disc_number,
              track_number, title, filename, file_path, added_at_ms, mtime_ms
       FROM media_tracks WHERE collection = ? AND artist_id = ? AND album_id = ?
       ORDER BY disc_number, track_number, filename`,
      [collection, artistId, albumId]
    );
    return albumsFromRows(albumRows, trackRows)[0];
  }

  async loadMusicCollectionForArtist(collection, artistId) {
    const [albumRows] = await this.pool.execute(
      "SELECT id, artist_id, name, release_year, path FROM media_albums WHERE collection = ? AND artist_id = ? ORDER BY release_year, name",
      [collection, artistId]
    );
    const [trackRows] = await this.pool.execute(
      `SELECT id, artist_id, artist_name, album_id, album_name, release_year, disc_number,
              track_number, title, filename, file_path, added_at_ms, mtime_ms
       FROM media_tracks WHERE collection = ? AND artist_id = ? ORDER BY disc_number, track_number, filename`,
      [collection, artistId]
    );
    return albumsFromRows(albumRows, trackRows);
  }

  async loadCollection(collection, type) {
    await this.init();
    if (type === "tv") {
      return this.loadTvCollection(collection);
    }
    if (type === "music") {
      return this.loadMusicCollection(collection);
    }
    return this.loadMovieCollection(collection);
  }

  async searchCollection(collection, type, query, metadataIds = [], limit = 240) {
    await this.init();
    const tokens = searchTokens(query);
    const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 240, 500));
    if (type === "tv") {
      return this.searchTvCollection(collection, tokens, metadataIds, safeLimit);
    }
    if (type === "music") {
      return this.searchMusicCollection(collection, tokens, metadataIds, safeLimit);
    }
    return this.searchMovieCollection(collection, tokens, metadataIds, safeLimit);
  }

  async searchMovieCollection(collection, tokens, metadataIds, limit) {
    const where = tokenWhere(["title"], tokens);
    const metadataClause = idClause(metadataIds);
    const [rows] = await this.pool.execute(
      `SELECT id, title, release_year, filename, folder, file_path, added_at_ms, mtime_ms
       FROM media_movies
       WHERE collection = ? AND ((${where.sql})${metadataClause.sql})
       ORDER BY title LIMIT ${limit}`,
      [collection, ...where.params, ...metadataClause.params]
    );
    return { items: rows.map(movieFromRow) };
  }

  async searchTvCollection(collection, tokens, metadataIds, limit) {
    const showWhere = tokenWhere(["s.name"], tokens);
    const episodeWhere = tokenWhere([
      "e.title",
      "e.show_name",
      "CONCAT('s', LPAD(COALESCE(e.season, 0), 2, '0'), 'e', LPAD(COALESCE(e.episode, 0), 2, '0'))",
      "CONCAT(COALESCE(e.season, 0), 'x', COALESCE(e.episode, 0))",
      "CONCAT('season ', COALESCE(e.season, 0), ' episode ', COALESCE(e.episode, 0))",
      "CONCAT('episode ', COALESCE(e.episode, 0))"
    ], tokens);
    const metadataClause = idClause(metadataIds, "e.id");
    const [showRows] = await this.pool.execute(
      `SELECT s.id, s.name, s.path,
              COUNT(DISTINCT e.season) AS season_count,
              COUNT(e.id) AS episode_count,
              MAX(COALESCE(e.added_at_ms, e.mtime_ms, 0)) AS added_at_ms,
              MIN(e.id) AS metadata_id
       FROM media_shows s
       LEFT JOIN media_episodes e ON e.collection = s.collection AND e.show_id = s.id
       WHERE s.collection = ? AND (${showWhere.sql})
       GROUP BY s.id, s.name, s.path
       ORDER BY s.name LIMIT ${limit}`,
      [collection, ...showWhere.params]
    );
    const [episodeRows] = await this.pool.execute(
      `SELECT e.id, e.show_id, e.show_name, e.season, e.episode, e.title, e.filename,
              e.file_path, e.added_at_ms, e.mtime_ms
       FROM media_episodes e
       WHERE e.collection = ? AND ((${episodeWhere.sql})${metadataClause.sql})
       ORDER BY e.show_name, e.season, e.episode LIMIT ${limit}`,
      [collection, ...episodeWhere.params, ...metadataClause.params]
    );
    const matchedShowIds = [...new Set(episodeRows.map((row) => row.show_id))];
    const existingShowIds = new Set(showRows.map((row) => row.id));
    const missingShowIds = matchedShowIds.filter((id) => !existingShowIds.has(id));
    if (missingShowIds.length > 0) {
      const placeholders = missingShowIds.map(() => "?").join(", ");
      const [derivedShows] = await this.pool.execute(
        `SELECT s.id, s.name, s.path,
                COUNT(DISTINCT e.season) AS season_count,
                COUNT(e.id) AS episode_count,
                MAX(COALESCE(e.added_at_ms, e.mtime_ms, 0)) AS added_at_ms,
                MIN(e.id) AS metadata_id
         FROM media_shows s
         LEFT JOIN media_episodes e ON e.collection = s.collection AND e.show_id = s.id
         WHERE s.collection = ? AND s.id IN (${placeholders})
         GROUP BY s.id, s.name, s.path`,
        [collection, ...missingShowIds]
      );
      showRows.push(...derivedShows);
    }
    const movies = await this.searchMovieCollection(collection, tokens, metadataIds, limit);
    const shows = showRows.map(showSummaryFromRow);
    for (const show of shows) {
      const matchedEpisode = episodeRows.find((row) => row.show_id === show.id && metadataIds.includes(row.id));
      if (matchedEpisode) {
        show.metadataId = matchedEpisode.id;
      }
    }
    return {
      shows,
      episodes: episodeRows.map(episodeFromRow),
      items: movies.items
    };
  }

  async searchMusicCollection(collection, tokens, metadataIds, limit) {
    const artistWhere = tokenWhere(["a.name"], tokens);
    const albumWhere = tokenWhere(["a.name", "r.name"], tokens);
    const trackWhere = tokenWhere(["t.artist_name", "t.album_name", "t.title"], tokens);
    const metadataClause = idClause(metadataIds, "t.id");
    const [artistRows] = await this.pool.execute(
      `SELECT a.id, a.name, a.path, COUNT(DISTINCT r.id) AS album_count,
              COUNT(DISTINCT t.id) AS track_count, MAX(COALESCE(t.added_at_ms, t.mtime_ms, 0)) AS added_at_ms,
              MIN(t.id) AS metadata_id
       FROM media_artists a
       LEFT JOIN media_albums r ON r.collection = a.collection AND r.artist_id = a.id
       LEFT JOIN media_tracks t ON t.collection = a.collection AND t.artist_id = a.id
       WHERE a.collection = ? AND (${artistWhere.sql})
       GROUP BY a.id, a.name, a.path ORDER BY a.name LIMIT ${limit}`,
      [collection, ...artistWhere.params]
    );
    const [albumRows] = await this.pool.execute(
      `SELECT r.id, r.artist_id, a.name AS artist_name, r.name, r.release_year, r.path,
              COUNT(t.id) AS track_count, MAX(COALESCE(t.added_at_ms, t.mtime_ms, 0)) AS added_at_ms,
              MIN(t.id) AS metadata_id
       FROM media_albums r
       JOIN media_artists a ON a.collection = r.collection AND a.id = r.artist_id
       LEFT JOIN media_tracks t ON t.collection = r.collection AND t.album_id = r.id
       WHERE r.collection = ? AND (${albumWhere.sql})
       GROUP BY r.id, r.artist_id, a.name, r.name, r.release_year, r.path
       ORDER BY a.name, r.release_year, r.name LIMIT ${limit}`,
      [collection, ...albumWhere.params]
    );
    const [trackRows] = await this.pool.execute(
      `SELECT t.id, t.artist_id, t.artist_name, t.album_id, t.album_name, t.release_year,
              t.disc_number, t.track_number, t.title, t.filename, t.file_path, t.added_at_ms, t.mtime_ms
       FROM media_tracks t
       WHERE t.collection = ? AND ((${trackWhere.sql})${metadataClause.sql})
       ORDER BY t.artist_name, t.album_name, t.disc_number, t.track_number LIMIT ${limit}`,
      [collection, ...trackWhere.params, ...metadataClause.params]
    );
    const matchedArtistIds = [...new Set(trackRows.map((row) => row.artist_id))];
    const missingArtistIds = matchedArtistIds.filter((id) => !artistRows.some((row) => row.id === id));
    if (missingArtistIds.length > 0) {
      const placeholders = missingArtistIds.map(() => "?").join(", ");
      const [derivedArtists] = await this.pool.execute(
        `SELECT a.id, a.name, a.path, COUNT(DISTINCT r.id) AS album_count,
                COUNT(DISTINCT t.id) AS track_count, MAX(COALESCE(t.added_at_ms, t.mtime_ms, 0)) AS added_at_ms,
                MIN(t.id) AS metadata_id
         FROM media_artists a
         LEFT JOIN media_albums r ON r.collection = a.collection AND r.artist_id = a.id
         LEFT JOIN media_tracks t ON t.collection = a.collection AND t.artist_id = a.id
         WHERE a.collection = ? AND a.id IN (${placeholders})
         GROUP BY a.id, a.name, a.path`,
        [collection, ...missingArtistIds]
      );
      artistRows.push(...derivedArtists);
    }
    const matchedAlbumIds = [...new Set(trackRows.map((row) => row.album_id))];
    const missingAlbumIds = matchedAlbumIds.filter((id) => !albumRows.some((row) => row.id === id));
    if (missingAlbumIds.length > 0) {
      const placeholders = missingAlbumIds.map(() => "?").join(", ");
      const [derivedAlbums] = await this.pool.execute(
        `SELECT r.id, r.artist_id, a.name AS artist_name, r.name, r.release_year, r.path,
                COUNT(t.id) AS track_count, MAX(COALESCE(t.added_at_ms, t.mtime_ms, 0)) AS added_at_ms,
                MIN(t.id) AS metadata_id
         FROM media_albums r
         JOIN media_artists a ON a.collection = r.collection AND a.id = r.artist_id
         LEFT JOIN media_tracks t ON t.collection = r.collection AND t.album_id = r.id
         WHERE r.collection = ? AND r.id IN (${placeholders})
         GROUP BY r.id, r.artist_id, a.name, r.name, r.release_year, r.path`,
        [collection, ...missingAlbumIds]
      );
      albumRows.push(...derivedAlbums);
    }
    const artists = artistRows.map(artistSummaryFromRow);
    const albums = albumRows.map(albumSummaryFromRow);
    for (const artist of artists) {
      const matchedTrack = trackRows.find((row) => row.artist_id === artist.id && metadataIds.includes(row.id));
      if (matchedTrack) {
        artist.metadataId = matchedTrack.id;
      }
    }
    for (const album of albums) {
      const matchedTrack = trackRows.find((row) => row.album_id === album.id && metadataIds.includes(row.id));
      if (matchedTrack) {
        album.metadataId = matchedTrack.id;
      }
    }
    return {
      artists,
      albums,
      tracks: trackRows.map(trackFromRow)
    };
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

    await this.pool.execute(`
      CREATE TABLE IF NOT EXISTS media_artists (
        collection VARCHAR(32) NOT NULL,
        id VARCHAR(64) NOT NULL,
        name VARCHAR(512) NOT NULL,
        path TEXT NOT NULL,
        PRIMARY KEY (collection, id),
        INDEX idx_media_artists_name (name)
      )
    `);

    await this.pool.execute(`
      CREATE TABLE IF NOT EXISTS media_albums (
        collection VARCHAR(32) NOT NULL,
        id VARCHAR(64) NOT NULL,
        artist_id VARCHAR(64) NOT NULL,
        name VARCHAR(512) NOT NULL,
        release_year INT NULL,
        path TEXT NOT NULL,
        PRIMARY KEY (collection, id),
        INDEX idx_media_albums_artist (collection, artist_id)
      )
    `);

    await this.pool.execute(`
      CREATE TABLE IF NOT EXISTS media_tracks (
        collection VARCHAR(32) NOT NULL,
        id VARCHAR(64) NOT NULL,
        artist_id VARCHAR(64) NOT NULL,
        artist_name VARCHAR(512) NOT NULL,
        album_id VARCHAR(64) NOT NULL,
        album_name VARCHAR(512) NOT NULL,
        release_year INT NULL,
        disc_number INT NULL,
        track_number INT NULL,
        title VARCHAR(512) NOT NULL,
        filename VARCHAR(512) NOT NULL,
        file_path TEXT NOT NULL,
        added_at_ms DOUBLE NULL,
        mtime_ms DOUBLE NULL,
        PRIMARY KEY (collection, id),
        INDEX idx_media_tracks_album (collection, album_id),
        INDEX idx_media_tracks_title (title)
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

  async loadMusicCollection(collection) {
    const [artistRows] = await this.pool.execute(
      "SELECT id, name, path FROM media_artists WHERE collection = ? ORDER BY name",
      [collection]
    );
    const [albumRows] = await this.pool.execute(
      "SELECT id, artist_id, name, release_year, path FROM media_albums WHERE collection = ? ORDER BY release_year, name",
      [collection]
    );
    const [trackRows] = await this.pool.execute(
      `SELECT id, artist_id, artist_name, album_id, album_name, release_year, disc_number,
              track_number, title, filename, file_path, added_at_ms, mtime_ms
       FROM media_tracks WHERE collection = ? ORDER BY disc_number, track_number, filename`,
      [collection]
    );
    const albumsByArtist = new Map();
    const albumsById = new Map();
    const tracksById = {};

    for (const row of albumRows) {
      const album = {
        id: row.id,
        name: row.name,
        year: row.release_year,
        path: row.path,
        tracks: []
      };
      const albums = albumsByArtist.get(row.artist_id) || [];
      albums.push(album);
      albumsByArtist.set(row.artist_id, albums);
      albumsById.set(row.id, album);
    }
    for (const row of trackRows) {
      const track = {
        id: row.id,
        artistId: row.artist_id,
        artistName: row.artist_name,
        albumId: row.album_id,
        albumName: row.album_name,
        year: row.release_year,
        disc: row.disc_number,
        track: row.track_number,
        title: row.title,
        filename: row.filename,
        filePath: row.file_path,
        addedAtMs: numberOrNull(row.added_at_ms),
        mtimeMs: numberOrNull(row.mtime_ms)
      };
      tracksById[track.id] = track;
      const album = albumsById.get(track.albumId);
      if (album) {
        album.tracks.push(track);
      }
    }

    return {
      artists: artistRows.map((row) => ({
        id: row.id,
        name: row.name,
        path: row.path,
        albums: albumsByArtist.get(row.id) || []
      })),
      tracksById
    };
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

  async insertMusicCollection(connection, collection, musicIndex) {
    const artists = [];
    const albums = [];
    const tracks = [];
    for (const artist of musicIndex.artists || []) {
      artists.push([collection, artist.id, artist.name, artist.path]);
      for (const album of artist.albums || []) {
        albums.push([collection, album.id, artist.id, album.name, album.year, album.path]);
        for (const track of album.tracks || []) {
          tracks.push([
            collection, track.id, artist.id, artist.name, album.id, album.name, album.year,
            track.disc, track.track, track.title, track.filename, track.filePath,
            track.addedAtMs || null, track.mtimeMs || null
          ]);
        }
      }
    }
    await bulkInsert(connection, "media_artists", ["collection", "id", "name", "path"], artists);
    await bulkInsert(connection, "media_albums", ["collection", "id", "artist_id", "name", "release_year", "path"], albums);
    await bulkInsert(connection, "media_tracks", ["collection", "id", "artist_id", "artist_name", "album_id", "album_name", "release_year", "disc_number", "track_number", "title", "filename", "file_path", "added_at_ms", "mtime_ms"], tracks);
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

function collectionTables(type) {
  if (type === "tv") {
    return ["media_episodes", "media_seasons", "media_shows", "media_movies"];
  }
  if (type === "music") {
    return ["media_tracks", "media_albums", "media_artists"];
  }
  return ["media_movies"];
}

function movieFromRow(row) {
  return {
    id: row.id,
    title: row.title,
    year: row.release_year,
    filename: row.filename,
    folder: row.folder,
    filePath: row.file_path,
    addedAtMs: numberOrNull(row.added_at_ms),
    mtimeMs: numberOrNull(row.mtime_ms)
  };
}

function episodeFromRow(row) {
  return {
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
}

function trackFromRow(row) {
  return {
    id: row.id,
    artistId: row.artist_id,
    artistName: row.artist_name,
    albumId: row.album_id,
    albumName: row.album_name,
    year: row.release_year,
    disc: row.disc_number,
    track: row.track_number,
    title: row.title,
    filename: row.filename,
    filePath: row.file_path,
    addedAtMs: numberOrNull(row.added_at_ms),
    mtimeMs: numberOrNull(row.mtime_ms)
  };
}

function showFromRows(row, seasonRows, episodeRows) {
  const episodesBySeason = new Map();
  for (const episodeRow of episodeRows) {
    const episode = episodeFromRow(episodeRow);
    const episodes = episodesBySeason.get(episode.season) || [];
    episodes.push(episode);
    episodesBySeason.set(episode.season, episodes);
  }
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    seasons: seasonRows.map((season) => ({
      season: season.season,
      name: season.name,
      episodes: episodesBySeason.get(season.season) || []
    }))
  };
}

function albumsFromRows(albumRows, trackRows) {
  const tracksByAlbum = new Map();
  for (const row of trackRows) {
    const track = trackFromRow(row);
    const tracks = tracksByAlbum.get(track.albumId) || [];
    tracks.push(track);
    tracksByAlbum.set(track.albumId, tracks);
  }
  return albumRows.map((row) => ({
    id: row.id,
    name: row.name,
    year: row.release_year,
    path: row.path,
    tracks: tracksByAlbum.get(row.id) || []
  }));
}

function showSummaryFromRow(row) {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    seasonCount: Number(row.season_count) || 0,
    episodeCount: Number(row.episode_count) || 0,
    addedAtMs: numberOrNull(row.added_at_ms) || 0,
    metadataId: row.metadata_id || null
  };
}

function artistSummaryFromRow(row) {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    albumCount: Number(row.album_count) || 0,
    trackCount: Number(row.track_count) || 0,
    addedAtMs: numberOrNull(row.added_at_ms) || 0,
    metadataId: row.metadata_id || null
  };
}

function albumSummaryFromRow(row) {
  return {
    id: row.id,
    artistId: row.artist_id,
    artistName: row.artist_name,
    name: row.name,
    year: row.release_year,
    path: row.path,
    trackCount: Number(row.track_count) || 0,
    addedAtMs: numberOrNull(row.added_at_ms) || 0,
    metadataId: row.metadata_id || null
  };
}

function tokenWhere(columns, tokens) {
  if (tokens.length === 0) {
    return { sql: "1 = 0", params: [] };
  }
  const expression = `LOWER(CONCAT_WS(' ', ${columns.join(", ")}))`;
  return {
    sql: tokens.map(() => `${expression} LIKE ?`).join(" AND "),
    params: tokens.map((token) => `%${token}%`)
  };
}

function idClause(ids, column = "id") {
  const values = [...new Set((ids || []).filter(Boolean))].slice(0, 1000);
  if (values.length === 0) {
    return { sql: "", params: [] };
  }
  return {
    sql: ` OR ${column} IN (${values.map(() => "?").join(", ")})`,
    params: values
  };
}

function searchTokens(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

function sortEpisodes(a, b) {
  return (a.season || 0) - (b.season || 0) || (a.episode || 0) - (b.episode || 0) || a.filename.localeCompare(b.filename);
}

module.exports = { MysqlIndexStore };
