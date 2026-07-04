const fs = require("fs/promises");
const path = require("path");
const mysql = require("mysql2/promise");

class MetadataStore {
  constructor(config) {
    this.config = config;
    this.pool = null;
    this.initialized = false;
    this.initializationPromise = null;
    this.jsonPath = path.join(config.metadata.cachePath, "metadata.json");
  }

  async get(mediaType, mediaId) {
    await this.init();

    if (this.config.mysql.enabled) {
      const [rows] = await this.pool.execute(
        `SELECT media_type, media_id, found, provider, provider_id, title, release_year, overview,
                poster_path, poster_filename, poster_unavailable, poster_unavailable_reason,
                thumbnail_path, thumbnail_filename, thumbnail_unavailable, thumbnail_unavailable_reason,
                source_json, created_at, updated_at
         FROM media_metadata
         WHERE media_type = ? AND media_id = ?`,
        [mediaType, mediaId]
      );
      return rows[0] ? fromMysqlRecord(rows[0]) : null;
    }

    const data = await this.readJson();
    return data[recordKey(mediaType, mediaId)] || null;
  }

  async getMany(refs) {
    await this.init();
    const keys = [...new Set(refs
      .map((ref) => recordKey(ref.mediaType, ref.id || ref.mediaId))
      .filter((key) => !key.endsWith(":")))];

    if (keys.length === 0) {
      return [];
    }

    if (this.config.mysql.enabled) {
      const grouped = keys.reduce((map, key) => {
        const [mediaType, mediaId] = key.split(":");
        const ids = map.get(mediaType) || [];
        ids.push(mediaId);
        map.set(mediaType, ids);
        return map;
      }, new Map());
      const records = [];

      for (const [mediaType, ids] of grouped.entries()) {
        for (const chunk of chunks(ids, 500)) {
          const placeholders = chunk.map(() => "?").join(", ");
          const [rows] = await this.pool.execute(
            `SELECT media_type, media_id, found, provider, provider_id, title, release_year, overview,
                    poster_path, poster_filename, poster_unavailable, poster_unavailable_reason,
                    thumbnail_path, thumbnail_filename, thumbnail_unavailable, thumbnail_unavailable_reason,
                    source_json, created_at, updated_at
             FROM media_metadata
             WHERE media_type = ? AND media_id IN (${placeholders})`,
            [mediaType, ...chunk]
          );
          records.push(...rows.map(fromMysqlRecord));
        }
      }

      return records;
    }

    const data = await this.readJson();
    return keys.map((key) => data[key]).filter(Boolean);
  }

  async searchRefs(query, mediaTypes, limit = 1000) {
    await this.init();
    const tokens = searchTokens(query);
    const types = [...new Set((mediaTypes || []).filter(Boolean))];
    const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 1000, 2000));
    if (tokens.length === 0 || types.length === 0) {
      return [];
    }

    if (this.config.mysql.enabled) {
      const typePlaceholders = types.map(() => "?").join(", ");
      const booleanQuery = tokens.map((token) => `+${token}*`).join(" ");
      const [rows] = await this.pool.execute(
        `SELECT media_type, media_id
         FROM media_metadata
         WHERE found = 1
           AND media_type IN (${typePlaceholders})
           AND MATCH(title, source_json) AGAINST(? IN BOOLEAN MODE)
         LIMIT ${safeLimit}`,
        [...types, booleanQuery]
      );
      return rows.map((row) => ({ mediaType: row.media_type, id: row.media_id }));
    }

    const data = await this.readJson();
    return Object.values(data)
      .filter((record) => record.found && types.includes(record.mediaType))
      .filter((record) => {
        const text = normalizeSearchText(`${record.title || ""} ${record.sourceJson || ""}`);
        return tokens.every((token) => text.includes(token));
      })
      .slice(0, safeLimit)
      .map((record) => ({ mediaType: record.mediaType, id: record.mediaId }));
  }

  async getByPosterFilename(filename) {
    await this.init();

    if (this.config.mysql.enabled) {
      const [rows] = await this.pool.execute(
        `SELECT media_type, media_id, found, provider, provider_id, title, release_year, overview,
                poster_path, poster_filename, poster_unavailable, poster_unavailable_reason,
                thumbnail_path, thumbnail_filename, thumbnail_unavailable, thumbnail_unavailable_reason,
                source_json, created_at, updated_at
         FROM media_metadata
         WHERE poster_filename = ?
         LIMIT 1`,
        [filename]
      );
      return rows[0] ? fromMysqlRecord(rows[0]) : null;
    }

    const data = await this.readJson();
    return Object.values(data).find((record) => record.posterFilename === filename) || null;
  }

  async listPosterUnavailable(limit = 100) {
    await this.init();
    const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 100, 1000));

    if (this.config.mysql.enabled) {
      const [rows] = await this.pool.execute(
        `SELECT media_type, media_id, found, provider, provider_id, title, release_year, overview,
                poster_path, poster_filename, poster_unavailable, poster_unavailable_reason,
                thumbnail_path, thumbnail_filename, thumbnail_unavailable, thumbnail_unavailable_reason,
                source_json, created_at, updated_at
         FROM media_metadata
         WHERE found = 1
           AND poster_filename IS NULL
           AND poster_unavailable = 1
         ORDER BY updated_at DESC
         LIMIT ${safeLimit}`
      );
      return rows.map(fromMysqlRecord);
    }

    const data = await this.readJson();
    return Object.values(data)
      .filter((record) => record.found && !record.posterFilename && record.posterUnavailable)
      .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
      .slice(0, safeLimit);
  }

  async save(record) {
    await this.init();

    if (this.config.mysql.enabled) {
      await this.pool.execute(
        `INSERT INTO media_metadata
          (media_type, media_id, found, provider, provider_id, title, release_year, overview,
           poster_path, poster_filename, poster_unavailable, poster_unavailable_reason,
           thumbnail_path, thumbnail_filename, thumbnail_unavailable, thumbnail_unavailable_reason,
           source_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
          found = VALUES(found),
          provider = VALUES(provider),
          provider_id = VALUES(provider_id),
          title = VALUES(title),
          release_year = VALUES(release_year),
          overview = VALUES(overview),
          poster_path = VALUES(poster_path),
          poster_filename = VALUES(poster_filename),
          poster_unavailable = VALUES(poster_unavailable),
          poster_unavailable_reason = VALUES(poster_unavailable_reason),
          thumbnail_path = VALUES(thumbnail_path),
          thumbnail_filename = VALUES(thumbnail_filename),
          thumbnail_unavailable = VALUES(thumbnail_unavailable),
          thumbnail_unavailable_reason = VALUES(thumbnail_unavailable_reason),
          source_json = VALUES(source_json)`,
        [
          record.mediaType,
          record.mediaId,
          record.found ? 1 : 0,
          record.provider,
          record.providerId,
          record.title,
          record.releaseYear,
          record.overview,
          record.posterPath,
          record.posterFilename,
          record.posterUnavailable ? 1 : 0,
          record.posterUnavailableReason || null,
          record.thumbnailPath || null,
          record.thumbnailFilename || null,
          record.thumbnailUnavailable ? 1 : 0,
          record.thumbnailUnavailableReason || null,
          record.sourceJson
        ]
      );
      return;
    }

    const data = await this.readJson();
    data[recordKey(record.mediaType, record.mediaId)] = record;
    await fs.mkdir(path.dirname(this.jsonPath), { recursive: true });
    await fs.writeFile(this.jsonPath, JSON.stringify(data, null, 2));
  }

  async replaceCachedImageFilenames(filenameMap) {
    await this.init();
    const entries = [...filenameMap.entries()].filter(([from, to]) => from && to && from !== to);
    if (entries.length === 0) {
      return;
    }

    if (this.config.mysql.enabled) {
      for (const group of chunks(entries, 250)) {
        const posterCases = group.map(() => "WHEN ? THEN ?").join(" ");
        const thumbnailCases = group.map(() => "WHEN ? THEN ?").join(" ");
        const placeholders = group.map(() => "?").join(", ");
        const pairs = group.flatMap(([from, to]) => [from, to]);
        const names = group.map(([from]) => from);
        await this.pool.execute(
          `UPDATE media_metadata
           SET poster_filename = CASE poster_filename ${posterCases} ELSE poster_filename END,
               thumbnail_filename = CASE thumbnail_filename ${thumbnailCases} ELSE thumbnail_filename END
           WHERE poster_filename IN (${placeholders}) OR thumbnail_filename IN (${placeholders})`,
          [...pairs, ...pairs, ...names, ...names]
        );
      }
      return;
    }

    const data = await this.readJson();
    for (const record of Object.values(data)) {
      record.posterFilename = filenameMap.get(record.posterFilename) || record.posterFilename;
      record.thumbnailFilename = filenameMap.get(record.thumbnailFilename) || record.thumbnailFilename;
    }
    await fs.mkdir(path.dirname(this.jsonPath), { recursive: true });
    await fs.writeFile(this.jsonPath, JSON.stringify(data, null, 2));
  }

  async init() {
    if (this.initialized) {
      return;
    }

    if (!this.initializationPromise) {
      this.initializationPromise = this.initialize();
    }

    try {
      await this.initializationPromise;
    } catch (err) {
      this.initializationPromise = null;
      throw err;
    }
  }

  async initialize() {
    if (this.config.mysql.enabled) {
      this.pool = mysql.createPool({
        host: this.config.mysql.host,
        port: this.config.mysql.port,
        user: this.config.mysql.user,
        password: this.config.mysql.password,
        database: this.config.mysql.database,
        waitForConnections: true,
        connectionLimit: this.config.mysql.connectionLimit
      });

      await this.pool.execute(`
        CREATE TABLE IF NOT EXISTS media_metadata (
          media_type VARCHAR(32) NOT NULL,
          media_id VARCHAR(64) NOT NULL,
          found TINYINT(1) NOT NULL DEFAULT 0,
          provider VARCHAR(32) NOT NULL,
          provider_id VARCHAR(64) NULL,
          title VARCHAR(512) NULL,
          release_year INT NULL,
          overview TEXT NULL,
          poster_path TEXT NULL,
          poster_filename VARCHAR(255) NULL,
          poster_unavailable TINYINT(1) NOT NULL DEFAULT 0,
          poster_unavailable_reason VARCHAR(255) NULL,
          thumbnail_path TEXT NULL,
          thumbnail_filename VARCHAR(255) NULL,
          thumbnail_unavailable TINYINT(1) NOT NULL DEFAULT 0,
          thumbnail_unavailable_reason VARCHAR(255) NULL,
          source_json LONGTEXT NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          PRIMARY KEY (media_type, media_id),
          INDEX idx_media_metadata_provider (provider, provider_id)
        )
      `);

      await ensureColumn(this.pool, "media_metadata", "poster_unavailable", "poster_unavailable TINYINT(1) NOT NULL DEFAULT 0");
      await ensureColumn(this.pool, "media_metadata", "poster_unavailable_reason", "poster_unavailable_reason VARCHAR(255) NULL");
      await ensureColumn(this.pool, "media_metadata", "thumbnail_path", "thumbnail_path TEXT NULL");
      await ensureColumn(this.pool, "media_metadata", "thumbnail_filename", "thumbnail_filename VARCHAR(255) NULL");
      await ensureColumn(this.pool, "media_metadata", "thumbnail_unavailable", "thumbnail_unavailable TINYINT(1) NOT NULL DEFAULT 0");
      await ensureColumn(this.pool, "media_metadata", "thumbnail_unavailable_reason", "thumbnail_unavailable_reason VARCHAR(255) NULL");
      await ensureIndex(this.pool, "media_metadata", "idx_media_metadata_search", "FULLTEXT INDEX idx_media_metadata_search (title, source_json)");
    }

    this.initialized = true;
  }

  async readJson() {
    try {
      return JSON.parse(await fs.readFile(this.jsonPath, "utf8"));
    } catch (err) {
      if (err.code === "ENOENT") {
        return {};
      }
      throw err;
    }
  }
}

function recordKey(mediaType, mediaId) {
  return `${mediaType}:${mediaId}`;
}

function fromMysqlRecord(row) {
  return {
    mediaType: row.media_type,
    mediaId: row.media_id,
    found: Boolean(row.found),
    provider: row.provider,
    providerId: row.provider_id,
    title: row.title,
    releaseYear: row.release_year,
    overview: row.overview,
    posterPath: row.poster_path,
    posterFilename: row.poster_filename,
    posterUnavailable: Boolean(row.poster_unavailable),
    posterUnavailableReason: row.poster_unavailable_reason,
    thumbnailPath: row.thumbnail_path,
    thumbnailFilename: row.thumbnail_filename,
    thumbnailUnavailable: Boolean(row.thumbnail_unavailable),
    thumbnailUnavailableReason: row.thumbnail_unavailable_reason,
    sourceJson: row.source_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function chunks(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
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

async function ensureColumn(pool, table, column, definition) {
  const [rows] = await pool.execute(
    `SELECT COUNT(*) AS count
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND COLUMN_NAME = ?`,
    [table, column]
  );

  if (Number(rows[0].count) > 0) {
    return;
  }

  await pool.execute(`ALTER TABLE \`${table}\` ADD COLUMN ${definition}`);
}

async function ensureIndex(pool, table, indexName, definition) {
  const [rows] = await pool.execute(
    `SELECT COUNT(*) AS count
     FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND INDEX_NAME = ?`,
    [table, indexName]
  );
  if (Number(rows[0].count) > 0) {
    return;
  }
  await pool.execute(`ALTER TABLE ${table} ADD ${definition}`);
}

module.exports = { MetadataStore };
