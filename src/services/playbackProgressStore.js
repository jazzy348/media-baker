const fs = require("fs/promises");
const path = require("path");
const mysql = require("mysql2/promise");

class PlaybackProgressStore {
  constructor(config) {
    this.config = config;
    this.pool = null;
    this.initialized = false;
    this.jsonPath = config.playback.progressPath;
  }

  async get(userId, mediaType, mediaId) {
    await this.init();

    if (this.config.mysql.enabled) {
      const [rows] = await this.pool.execute(
        `SELECT media_type, media_id, status, position_seconds, duration_seconds, cache_key,
                user_id, created_at, updated_at, watched_at
         FROM playback_progress
         WHERE user_id = ? AND media_type = ? AND media_id = ?`,
        [userId || "global", mediaType, mediaId]
      );
      return rows[0] ? fromMysqlRecord(rows[0]) : null;
    }

    const data = await this.readJson();
    return data[recordKey(userId, mediaType, mediaId)] || null;
  }

  async getMany(userId, refs = []) {
    await this.init();
    const normalizedUserId = userId || "global";
    const grouped = new Map();
    for (const ref of refs || []) {
      if (!ref || !ref.mediaType || !ref.mediaId) {
        continue;
      }
      const ids = grouped.get(ref.mediaType) || new Set();
      ids.add(String(ref.mediaId));
      grouped.set(ref.mediaType, ids);
    }

    if (grouped.size === 0) {
      return [];
    }

    if (this.config.mysql.enabled) {
      const records = [];
      for (const [mediaType, ids] of grouped) {
        const mediaIds = [...ids];
        if (mediaIds.length === 0) {
          continue;
        }
        const placeholders = mediaIds.map(() => "?").join(", ");
        const [rows] = await this.pool.execute(
          `SELECT media_type, media_id, status, position_seconds, duration_seconds, cache_key,
                  user_id, created_at, updated_at, watched_at
           FROM playback_progress
           WHERE user_id = ? AND media_type = ? AND media_id IN (${placeholders})`,
          [normalizedUserId, mediaType, ...mediaIds]
        );
        records.push(...rows.map(fromMysqlRecord));
      }
      return records;
    }

    const data = await this.readJson();
    return [...grouped].flatMap(([mediaType, ids]) => (
      [...ids].map((mediaId) => data[recordKey(normalizedUserId, mediaType, mediaId)]).filter(Boolean)
    ));
  }

  async list(userId = null, options = {}) {
    await this.init();
    const filters = normalizeListOptions(options);

    if (this.config.mysql.enabled) {
      const clauses = [];
      const params = [];
      if (userId) {
        clauses.push("user_id = ?");
        params.push(userId);
      }
      if (filters.excludedUserIds.length > 0) {
        clauses.push(`user_id NOT IN (${filters.excludedUserIds.map(() => "?").join(", ")})`);
        params.push(...filters.excludedUserIds);
      }
      if (filters.statuses.length > 0) {
        clauses.push(`status IN (${filters.statuses.map(() => "?").join(", ")})`);
        params.push(...filters.statuses);
      }
      if (filters.since) {
        clauses.push("updated_at >= ?");
        params.push(new Date(filters.since));
      }
      if (filters.before) {
        clauses.push("updated_at < ?");
        params.push(new Date(filters.before));
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      const limit = filters.limit ? `LIMIT ${filters.limit} OFFSET ${filters.offset}` : "";
      const [rows] = await this.pool.execute(
        `SELECT user_id, media_type, media_id, status, position_seconds, duration_seconds, cache_key,
                created_at, updated_at, watched_at
         FROM playback_progress
         ${where}
         ORDER BY updated_at DESC, user_id ASC, media_type ASC, media_id ASC
         ${limit}`,
        params
      );
      return rows.map(fromMysqlRecord);
    }

    const data = await this.readJson();
    return Object.values(data)
      .filter((record) => !userId || (record.userId || "global") === userId)
      .filter((record) => !filters.excludedUserIds.includes(record.userId || "global"))
      .filter((record) => filters.statuses.length === 0 || filters.statuses.includes(record.status))
      .filter((record) => !filters.since || timeMs(record.updatedAt) >= filters.since)
      .filter((record) => !filters.before || timeMs(record.updatedAt) < filters.before)
      .sort((first, second) => timeMs(second.updatedAt) - timeMs(first.updatedAt)
        || String(first.userId || "global").localeCompare(String(second.userId || "global"))
        || String(first.mediaType || "").localeCompare(String(second.mediaType || ""))
        || String(first.mediaId || "").localeCompare(String(second.mediaId || "")))
      .slice(filters.offset, filters.limit ? filters.offset + filters.limit : undefined);
  }

  async save(record) {
    await this.init();
    const updated = normalizeRecord(record);

    if (this.config.mysql.enabled) {
      await this.pool.execute(
        `INSERT INTO playback_progress
          (user_id, media_type, media_id, status, position_seconds, duration_seconds, cache_key, watched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
          status = VALUES(status),
          position_seconds = VALUES(position_seconds),
          duration_seconds = VALUES(duration_seconds),
          cache_key = VALUES(cache_key),
          watched_at = VALUES(watched_at),
          updated_at = CURRENT_TIMESTAMP`,
        [
          updated.userId,
          updated.mediaType,
          updated.mediaId,
          updated.status,
          updated.positionSeconds,
          updated.durationSeconds,
          updated.cacheKey,
          updated.watchedAt ? new Date(updated.watchedAt) : null
        ]
      );
      return updated;
    }

    const data = await this.readJson();
    data[recordKey(updated.userId, updated.mediaType, updated.mediaId)] = {
      ...updated,
      updatedAt: new Date().toISOString(),
      createdAt: updated.createdAt || new Date().toISOString()
    };
    await fs.mkdir(path.dirname(this.jsonPath), { recursive: true });
    await fs.writeFile(this.jsonPath, JSON.stringify(data, null, 2));
    return data[recordKey(updated.userId, updated.mediaType, updated.mediaId)];
  }

  async removeUser(userId) {
    await this.init();
    const normalizedUserId = String(userId || "").trim();
    if (!normalizedUserId) {
      return 0;
    }

    if (this.config.mysql.enabled) {
      const [result] = await this.pool.execute(
        "DELETE FROM playback_progress WHERE user_id = ?",
        [normalizedUserId]
      );
      return Number(result.affectedRows) || 0;
    }

    const data = await this.readJson();
    let removed = 0;
    for (const [key, record] of Object.entries(data)) {
      if ((record.userId || "global") !== normalizedUserId) {
        continue;
      }
      delete data[key];
      removed += 1;
    }
    if (removed > 0) {
      await fs.mkdir(path.dirname(this.jsonPath), { recursive: true });
      await fs.writeFile(this.jsonPath, JSON.stringify(data, null, 2));
    }
    return removed;
  }

  async init() {
    if (this.initialized) {
      return;
    }

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
        CREATE TABLE IF NOT EXISTS playback_progress (
          media_type VARCHAR(32) NOT NULL,
          user_id VARCHAR(64) NOT NULL DEFAULT 'global',
          media_id VARCHAR(64) NOT NULL,
          status VARCHAR(32) NOT NULL,
          position_seconds DOUBLE NOT NULL DEFAULT 0,
          duration_seconds DOUBLE NOT NULL DEFAULT 0,
          cache_key VARCHAR(64) NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          watched_at TIMESTAMP NULL,
          PRIMARY KEY (user_id, media_type, media_id),
          INDEX idx_playback_progress_status_updated (status, updated_at),
          INDEX idx_playback_progress_cache_key (cache_key)
        )
      `);
      await ensureColumn(this.pool, "playback_progress", "user_id", "VARCHAR(64) NOT NULL DEFAULT 'global'");
      await ensureUserPrimaryKey(this.pool);
      await ensureIndex(
        this.pool,
        "playback_progress",
        "idx_playback_progress_user_updated",
        ["user_id", "updated_at"]
      );
    }

    this.initialized = true;
  }

  async readJson() {
    try {
      return normalizeJsonProgress(JSON.parse(await fs.readFile(this.jsonPath, "utf8")));
    } catch (err) {
      if (err.code === "ENOENT") {
        return {};
      }
      throw err;
    }
  }
}

function normalizeRecord(record) {
  return {
    mediaType: record.mediaType,
    userId: record.userId || "global",
    mediaId: record.mediaId,
    status: record.status,
    positionSeconds: Number(record.positionSeconds) || 0,
    durationSeconds: Number(record.durationSeconds) || 0,
    cacheKey: record.cacheKey || null,
    watchedAt: record.watchedAt || null,
    createdAt: record.createdAt || null,
    updatedAt: record.updatedAt || null
  };
}

function normalizeListOptions(options) {
  const statuses = [...new Set((Array.isArray(options.statuses) ? options.statuses : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean))];
  return {
    statuses,
    excludedUserIds: [...new Set((Array.isArray(options.excludedUserIds) ? options.excludedUserIds : [])
      .map((value) => String(value || "").trim())
      .filter(Boolean))],
    since: validTime(options.since),
    before: validTime(options.before),
    limit: Math.max(0, Math.min(Number.parseInt(options.limit, 10) || 0, 500)),
    offset: Math.max(0, Number.parseInt(options.offset, 10) || 0)
  };
}

function fromMysqlRecord(row) {
  return {
    mediaType: row.media_type,
    userId: row.user_id || "global",
    mediaId: row.media_id,
    status: row.status,
    positionSeconds: Number(row.position_seconds) || 0,
    durationSeconds: Number(row.duration_seconds) || 0,
    cacheKey: row.cache_key,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    watchedAt: toIso(row.watched_at)
  };
}

function validTime(value) {
  const timestamp = Date.parse(value || "");
  return Number.isFinite(timestamp) ? timestamp : null;
}

function timeMs(value) {
  return validTime(value) || 0;
}

function toIso(value) {
  return value ? new Date(value).toISOString() : null;
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

async function ensureUserPrimaryKey(pool) {
  const [rows] = await pool.execute(
    `SELECT COLUMN_NAME
     FROM information_schema.KEY_COLUMN_USAGE
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'playback_progress'
       AND CONSTRAINT_NAME = 'PRIMARY'
     ORDER BY ORDINAL_POSITION`
  );
  const columns = rows.map((row) => row.COLUMN_NAME);
  if (columns.join(",") === "user_id,media_type,media_id") {
    return;
  }

  await pool.execute("ALTER TABLE playback_progress DROP PRIMARY KEY, ADD PRIMARY KEY (user_id, media_type, media_id)");
}

async function ensureIndex(pool, table, indexName, columns) {
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
  await pool.execute(
    `CREATE INDEX ${indexName} ON ${table} (${columns.join(", ")})`
  );
}

function recordKey(userId, mediaType, mediaId) {
  return `${userId || "global"}:${mediaType}:${mediaId}`;
}

function normalizeJsonProgress(data) {
  const normalized = {};
  for (const record of Object.values(data || {})) {
    if (!record || !record.mediaType || !record.mediaId) {
      continue;
    }
    const nextRecord = normalizeRecord(record);
    normalized[recordKey(nextRecord.userId, nextRecord.mediaType, nextRecord.mediaId)] = nextRecord;
  }
  return normalized;
}

module.exports = { PlaybackProgressStore };
