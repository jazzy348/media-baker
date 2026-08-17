const fs = require("fs/promises");
const path = require("path");
const mysql = require("mysql2/promise");

const STORE_VERSION = 1;

class KeyframeStore {
  constructor(config) {
    this.config = config;
    this.jsonPath = config.keyframeStorePath;
    this.pool = null;
    this.jsonData = null;
    this.initialized = false;
    this.writePromise = Promise.resolve();
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
        CREATE TABLE IF NOT EXISTS media_keyframes (
          media_type VARCHAR(128) NOT NULL,
          media_id VARCHAR(64) NOT NULL,
          file_path TEXT NOT NULL,
          source_size BIGINT UNSIGNED NOT NULL,
          source_mtime_ms DOUBLE NOT NULL,
          stream_index INT NOT NULL,
          target_seconds DOUBLE NOT NULL,
          format_version INT NOT NULL,
          segments_json LONGTEXT NOT NULL,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          PRIMARY KEY (media_type, media_id),
          INDEX idx_media_keyframes_updated (updated_at)
        )
      `);
    } else {
      this.jsonData = await loadJsonStore(this.jsonPath);
    }

    this.initialized = true;
  }

  async get(mediaType, mediaId) {
    await this.init();
    if (!mediaType || !mediaId) return null;

    if (this.pool) {
      const [rows] = await this.pool.execute(
        `SELECT media_type, media_id, file_path, source_size, source_mtime_ms,
                stream_index, target_seconds, format_version, segments_json, updated_at
         FROM media_keyframes
         WHERE media_type = ? AND media_id = ?`,
        [mediaType, mediaId]
      );
      return rows[0] ? fromMysqlRow(rows[0]) : null;
    }

    return expandRecord(this.jsonData.records[recordKey(mediaType, mediaId)] || null);
  }

  async save(record) {
    await this.init();
    const normalized = normalizeRecord(record);

    if (this.pool) {
      await this.pool.execute(
        `INSERT INTO media_keyframes
          (media_type, media_id, file_path, source_size, source_mtime_ms,
           stream_index, target_seconds, format_version, segments_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
          file_path = VALUES(file_path),
          source_size = VALUES(source_size),
          source_mtime_ms = VALUES(source_mtime_ms),
          stream_index = VALUES(stream_index),
          target_seconds = VALUES(target_seconds),
          format_version = VALUES(format_version),
          segments_json = VALUES(segments_json),
          updated_at = CURRENT_TIMESTAMP`,
        [
          normalized.mediaType,
          normalized.mediaId,
          normalized.filePath,
          normalized.size,
          normalized.mtimeMs,
          normalized.streamIndex,
          normalized.targetSeconds,
          normalized.version,
          JSON.stringify(compactSegments(normalized.segments))
        ]
      );
      return normalized;
    }

    this.jsonData.records[recordKey(normalized.mediaType, normalized.mediaId)] = compactRecord(normalized);
    const write = this.writePromise.then(() => atomicWriteJson(this.jsonPath, this.jsonData));
    this.writePromise = write.catch(() => {});
    await write;
    return normalized;
  }

  async removeMany(refs = []) {
    await this.init();
    const grouped = new Map();
    for (const ref of refs) {
      if (!ref || !ref.mediaType || !ref.mediaId) continue;
      const ids = grouped.get(String(ref.mediaType)) || new Set();
      ids.add(String(ref.mediaId));
      grouped.set(String(ref.mediaType), ids);
    }
    if (grouped.size === 0) return 0;

    if (this.pool) {
      let removed = 0;
      for (const [mediaType, ids] of grouped) {
        const mediaIds = [...ids];
        const [result] = await this.pool.execute(
          `DELETE FROM media_keyframes
           WHERE media_type = ? AND media_id IN (${mediaIds.map(() => "?").join(", ")})`,
          [mediaType, ...mediaIds]
        );
        removed += Number(result.affectedRows) || 0;
      }
      return removed;
    }

    let removed = 0;
    for (const [mediaType, ids] of grouped) {
      for (const mediaId of ids) {
        const key = recordKey(mediaType, mediaId);
        if (!this.jsonData.records[key]) continue;
        delete this.jsonData.records[key];
        removed += 1;
      }
    }
    if (removed > 0) {
      const write = this.writePromise.then(() => atomicWriteJson(this.jsonPath, this.jsonData));
      this.writePromise = write.catch(() => {});
      await write;
    }
    return removed;
  }

  async missingReferences(refs = []) {
    await this.init();
    const candidates = (refs || []).filter((ref) => ref && ref.mediaType && ref.id);
    if (candidates.length === 0) return [];

    let existing;
    if (this.pool) {
      const [rows] = await this.pool.query("SELECT media_type, media_id FROM media_keyframes");
      existing = new Set(rows.map((row) => recordKey(row.media_type, row.media_id)));
    } else {
      existing = new Set(Object.keys(this.jsonData.records));
    }
    return candidates.filter((ref) => !existing.has(recordKey(ref.mediaType, ref.id)));
  }
}

function normalizeRecord(record) {
  if (!record || !record.mediaType || !record.mediaId) {
    throw new Error("Keyframe records require mediaType and mediaId");
  }
  return {
    version: Number(record.version) || STORE_VERSION,
    mediaType: String(record.mediaType),
    mediaId: String(record.mediaId),
    filePath: String(record.filePath || ""),
    size: Math.max(0, Number(record.size) || 0),
    mtimeMs: Math.max(0, Number(record.mtimeMs) || 0),
    streamIndex: Number(record.streamIndex) || 0,
    targetSeconds: Math.max(1, Number(record.targetSeconds) || 1),
    segments: expandSegments(record.segments),
    updatedAt: record.updatedAt || new Date().toISOString()
  };
}

function compactRecord(record) {
  return {
    v: record.version,
    t: record.mediaType,
    i: record.mediaId,
    p: record.filePath,
    s: record.size,
    m: record.mtimeMs,
    x: record.streamIndex,
    d: record.targetSeconds,
    g: compactSegments(record.segments),
    u: new Date().toISOString()
  };
}

function expandRecord(record) {
  if (!record) return null;
  return normalizeRecord({
    version: record.v,
    mediaType: record.t,
    mediaId: record.i,
    filePath: record.p,
    size: record.s,
    mtimeMs: record.m,
    streamIndex: record.x,
    targetSeconds: record.d,
    segments: record.g,
    updatedAt: record.u
  });
}

function fromMysqlRow(row) {
  let segments = [];
  try {
    segments = JSON.parse(row.segments_json);
  } catch (_) {
    return null;
  }
  return normalizeRecord({
    version: row.format_version,
    mediaType: row.media_type,
    mediaId: row.media_id,
    filePath: row.file_path,
    size: row.source_size,
    mtimeMs: row.source_mtime_ms,
    streamIndex: row.stream_index,
    targetSeconds: row.target_seconds,
    segments,
    updatedAt: row.updated_at
  });
}

function compactSegments(segments) {
  return (segments || []).map((segment) => [
    roundTimelineNumber(segment.startSeconds),
    roundTimelineNumber(segment.durationSeconds)
  ]);
}

function expandSegments(segments) {
  return (segments || []).map((segment) => Array.isArray(segment)
    ? { startSeconds: Number(segment[0]) || 0, durationSeconds: Number(segment[1]) || 0 }
    : { startSeconds: Number(segment.startSeconds) || 0, durationSeconds: Number(segment.durationSeconds) || 0 });
}

function roundTimelineNumber(value) {
  return Number((Number(value) || 0).toFixed(6));
}

function recordKey(mediaType, mediaId) {
  return `${mediaType}:${mediaId}`;
}

async function loadJsonStore(filePath) {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
    return {
      version: STORE_VERSION,
      records: parsed && typeof parsed.records === "object" && !Array.isArray(parsed.records)
        ? parsed.records
        : {}
    };
  } catch (error) {
    if (error.code === "ENOENT") return { version: STORE_VERSION, records: {} };
    throw error;
  }
}

async function atomicWriteJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  try {
    await fs.writeFile(temporaryPath, JSON.stringify(value), "utf8");
    await fs.rm(filePath, { force: true });
    await fs.rename(temporaryPath, filePath);
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
}

module.exports = { KeyframeStore };
