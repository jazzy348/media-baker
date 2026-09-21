const fs = require("fs/promises");
const path = require("path");
const mysql = require("mysql2/promise");

class CopyQueueStore {
  constructor(config) {
    this.config = config;
    this.jsonPath = config.copyQueueStorePath;
    this.pool = null;
    this.initialized = false;
    this.jsonWriteQueue = Promise.resolve();
  }

  async list() {
    await this.init();
    if (!this.config.mysql.enabled) {
      const data = await this.readJson();
      return Object.values(data).filter(activeQueue);
    }

    const [rows] = await this.pool.execute(
      `SELECT queue_id, token_hash, owner_user_id, owner_name, name, state,
              current_index, profile_json, created_at, updated_at, expires_at
       FROM copy_stream_queues
       WHERE expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP(3)`
    );
    if (rows.length === 0) return [];
    const queueIds = rows.map((row) => row.queue_id);
    const placeholders = queueIds.map(() => "?").join(", ");
    const [itemRows] = await this.pool.execute(
      `SELECT queue_id, item_id, position, media_type, media_id, library_title, title,
              duration_seconds, stream_options_json, skip_markers_json, completion_start_seconds,
              added_by_user_id, added_by_name, added_at
       FROM copy_stream_queue_items
       WHERE queue_id IN (${placeholders})
       ORDER BY queue_id, position`,
      queueIds
    );
    const itemsByQueue = new Map();
    for (const row of itemRows) {
      if (!itemsByQueue.has(row.queue_id)) itemsByQueue.set(row.queue_id, []);
      itemsByQueue.get(row.queue_id).push(itemFromMysql(row));
    }
    return rows.map((row) => queueFromMysql(row, itemsByQueue.get(row.queue_id) || []));
  }

  async save(queue) {
    await this.init();
    if (!this.config.mysql.enabled) {
      await this.updateJson((data) => {
        data[queue.id] = serializableQueue(queue);
      });
      return;
    }

    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute(
        `INSERT INTO copy_stream_queues
          (queue_id, token_hash, owner_user_id, owner_name, name, state,
           current_index, profile_json, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           owner_name = VALUES(owner_name), name = VALUES(name), state = VALUES(state),
           current_index = VALUES(current_index), profile_json = VALUES(profile_json),
           expires_at = VALUES(expires_at), updated_at = CURRENT_TIMESTAMP(3)`,
        [
          queue.id, queue.tokenHash, queue.ownerUserId, queue.ownerName, queue.name,
          queue.state, queue.currentIndex, JSON.stringify(queue.profile || {}),
          new Date(queue.createdAt), queue.expiresAt ? new Date(queue.expiresAt) : null
        ]
      );
      await connection.execute("DELETE FROM copy_stream_queue_items WHERE queue_id = ?", [queue.id]);
      if (queue.items.length > 0) {
        const values = queue.items.map((item, position) => [
          queue.id, item.id, position, item.mediaType, item.mediaId, item.libraryTitle || "", item.title,
          Number(item.durationSeconds) || 0, JSON.stringify(item.streamOptions || {}), JSON.stringify(item.skipMarkers || []),
          Number(item.completionStartSeconds) || null, item.addedByUserId,
          item.addedByName, new Date(item.addedAt)
        ]);
        await connection.query(
          `INSERT INTO copy_stream_queue_items
            (queue_id, item_id, position, media_type, media_id, library_title, title,
             duration_seconds, stream_options_json, skip_markers_json, completion_start_seconds,
             added_by_user_id, added_by_name, added_at)
           VALUES ?`,
          [values]
        );
      }
      await connection.commit();
    } catch (err) {
      await connection.rollback();
      throw err;
    } finally {
      connection.release();
    }
  }

  async remove(queueId) {
    await this.init();
    if (!this.config.mysql.enabled) {
      await this.updateJson((data) => { delete data[queueId]; });
      return;
    }
    await this.pool.execute("DELETE FROM copy_stream_queues WHERE queue_id = ?", [queueId]);
  }

  async init() {
    if (this.initialized) return;
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
        CREATE TABLE IF NOT EXISTS copy_stream_queues (
          queue_id VARCHAR(40) NOT NULL,
          token_hash CHAR(64) NOT NULL,
          owner_user_id VARCHAR(64) NOT NULL,
          owner_name VARCHAR(128) NOT NULL,
          name VARCHAR(255) NOT NULL,
          state VARCHAR(16) NOT NULL DEFAULT 'idle',
          current_index INT NOT NULL DEFAULT 0,
          profile_json LONGTEXT NOT NULL,
          created_at DATETIME(3) NOT NULL,
          updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
          expires_at DATETIME(3) NULL,
          PRIMARY KEY (queue_id),
          UNIQUE KEY idx_copy_stream_queue_token (token_hash),
          INDEX idx_copy_stream_queue_owner (owner_user_id),
          INDEX idx_copy_stream_queue_expires (expires_at)
        )
      `);
      await this.pool.execute(`
        CREATE TABLE IF NOT EXISTS copy_stream_queue_items (
          queue_id VARCHAR(40) NOT NULL,
          item_id VARCHAR(40) NOT NULL,
          position INT NOT NULL,
          media_type VARCHAR(64) NOT NULL,
          media_id VARCHAR(64) NOT NULL,
          library_title VARCHAR(255) NOT NULL DEFAULT '',
          title VARCHAR(512) NOT NULL,
          duration_seconds DOUBLE NOT NULL DEFAULT 0,
          stream_options_json LONGTEXT NOT NULL,
          skip_markers_json LONGTEXT NULL,
          completion_start_seconds DOUBLE NULL,
          added_by_user_id VARCHAR(64) NOT NULL,
          added_by_name VARCHAR(128) NOT NULL,
          added_at DATETIME(3) NOT NULL,
          PRIMARY KEY (queue_id, item_id),
          INDEX idx_copy_stream_queue_item_position (queue_id, position),
          CONSTRAINT fk_copy_stream_queue_items_queue
            FOREIGN KEY (queue_id) REFERENCES copy_stream_queues(queue_id) ON DELETE CASCADE
        )
      `);
      await ensureColumn(this.pool, "copy_stream_queue_items", "library_title", "VARCHAR(255) NOT NULL DEFAULT ''");
      await ensureColumn(this.pool, "copy_stream_queue_items", "skip_markers_json", "LONGTEXT NULL");
    }
    this.initialized = true;
  }

  async readJson() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.jsonPath, "utf8"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch (err) {
      if (err.code === "ENOENT") return {};
      throw err;
    }
  }

  async updateJson(update) {
    const operation = this.jsonWriteQueue.then(async () => {
      const data = await this.readJson();
      update(data);
      await fs.mkdir(path.dirname(this.jsonPath), { recursive: true });
      const temporary = `${this.jsonPath}.${process.pid}.${Date.now()}.tmp`;
      try {
        await fs.writeFile(temporary, JSON.stringify(data, null, 2));
        await fs.rm(this.jsonPath, { force: true });
        await fs.rename(temporary, this.jsonPath);
      } finally {
        await fs.rm(temporary, { force: true }).catch(() => {});
      }
    });
    this.jsonWriteQueue = operation.catch(() => {});
    return operation;
  }
}

function queueFromMysql(row, items) {
  return {
    id: row.queue_id,
    tokenHash: row.token_hash,
    ownerUserId: row.owner_user_id,
    ownerName: row.owner_name,
    name: row.name,
    state: row.state,
    currentIndex: Number(row.current_index) || 0,
    profile: parseJson(row.profile_json),
    items,
    createdAt: isoDate(row.created_at),
    updatedAt: isoDate(row.updated_at),
    expiresAt: row.expires_at ? isoDate(row.expires_at) : null
  };
}

function itemFromMysql(row) {
  return {
    id: row.item_id,
    mediaType: row.media_type,
    mediaId: row.media_id,
    libraryTitle: row.library_title,
    title: row.title,
    durationSeconds: Number(row.duration_seconds) || 0,
    streamOptions: parseJson(row.stream_options_json),
    skipMarkers: parseJson(row.skip_markers_json, []),
    completionStartSeconds: Number(row.completion_start_seconds) || null,
    addedByUserId: row.added_by_user_id,
    addedByName: row.added_by_name,
    addedAt: isoDate(row.added_at)
  };
}

function serializableQueue(queue) {
  const { runtime, ...stored } = queue;
  return stored;
}

function activeQueue(queue) {
  return !queue.expiresAt || Date.parse(queue.expiresAt) > Date.now();
}

function parseJson(value, fallback = {}) {
  if (value && typeof value === "object") return value;
  try { return JSON.parse(value || "null") || fallback; } catch (err) { return fallback; }
}

function isoDate(value) {
  return new Date(value).toISOString();
}

async function ensureColumn(pool, table, column, definition) {
  const [rows] = await pool.execute(
    `SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]
  );
  if (rows.length === 0) await pool.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

module.exports = { CopyQueueStore };
