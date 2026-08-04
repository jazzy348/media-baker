const fs = require("fs/promises");
const path = require("path");
const mysql = require("mysql2/promise");

const STORE_VERSION = 2;

class SkipMarkerStore {
  constructor(config) {
    this.config = config;
    this.jsonPath = config.skipMarkerStorePath;
    this.pool = null;
    this.initialized = false;
    this.initializationPromise = null;
    this.jsonWriteChain = Promise.resolve();
  }

  async getMarkers(mediaType, mediaId) {
    await this.init();
    if (this.config.mysql.enabled) {
      const [rows] = await this.pool.execute(
        `SELECT marker_type, start_seconds, end_seconds, confidence, source
         FROM media_skip_markers
         WHERE media_type = ? AND media_id = ?
         ORDER BY start_seconds, marker_index`,
        [mediaType, mediaId]
      );
      return rows.map(markerFromRow);
    }

    const data = await this.readJson();
    return data.markers[mediaKey(mediaType, mediaId)] || [];
  }

  async listMarkerRecords(limit = 200) {
    await this.init();
    const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 200, 1000));
    if (this.config.mysql.enabled) {
      const [rows] = await this.pool.query(
        `SELECT media_type, media_id, marker_index, marker_type, start_seconds, end_seconds,
                confidence, source, updated_at
         FROM media_skip_markers
         ORDER BY updated_at DESC, media_type, media_id, marker_index
         LIMIT ${safeLimit}`
      );
      return rows.map((row) => ({
        mediaType: row.media_type,
        mediaId: row.media_id,
        markerIndex: Number(row.marker_index),
        ...markerFromRow(row),
        updatedAt: dateIso(row.updated_at)
      }));
    }

    const data = await this.readJson();
    return Object.entries(data.markers)
      .flatMap(([key, markers]) => {
        const [mediaType, ...mediaIdParts] = key.split(":");
        const mediaId = mediaIdParts.join(":");
        return normalizeMarkers(markers).map((entry, markerIndex) => ({
          mediaType,
          mediaId,
          markerIndex,
          ...entry,
          updatedAt: null
        }));
      })
      .slice(0, safeLimit);
  }

  async countMarkers() {
    await this.init();
    if (this.config.mysql.enabled) {
      const [rows] = await this.pool.execute(
        `SELECT marker_type, COUNT(*) AS marker_count
         FROM media_skip_markers
         GROUP BY marker_type`
      );
      return rows.reduce(
        (counts, row) => {
          const key = row.marker_type === "credits" ? "credits" : "intros";
          counts[key] += Number(row.marker_count) || 0;
          return counts;
        },
        { intros: 0, credits: 0 }
      );
    }

    const data = await this.readJson();
    return Object.values(data.markers).reduce(
      (counts, markers) => {
        for (const marker of normalizeMarkers(markers)) {
          counts[marker.type === "credits" ? "credits" : "intros"] += 1;
        }
        return counts;
      },
      { intros: 0, credits: 0 }
    );
  }

  async getAnalysis(mediaType, groupId) {
    await this.init();
    if (this.config.mysql.enabled) {
      const [rows] = await this.pool.execute(
        `SELECT member_ids_json, algorithm_version, analysed_at
         FROM media_skip_analysis
         WHERE media_type = ? AND group_id = ?`,
        [mediaType, groupId]
      );
      if (!rows[0]) {
        return null;
      }
      return {
        memberIds: parseJson(rows[0].member_ids_json, []),
        algorithmVersion: Number(rows[0].algorithm_version) || 0,
        analysedAt: dateIso(rows[0].analysed_at)
      };
    }

    const data = await this.readJson();
    return data.analysis[groupKey(mediaType, groupId)] || null;
  }

  async listAnalyses() {
    await this.init();
    if (this.config.mysql.enabled) {
      const [rows] = await this.pool.execute(
        `SELECT media_type, group_id, member_ids_json, algorithm_version, analysed_at
         FROM media_skip_analysis`
      );
      return rows.map((row) => ({
        mediaType: row.media_type,
        groupId: row.group_id,
        memberIds: parseJson(row.member_ids_json, []),
        algorithmVersion: Number(row.algorithm_version) || 0,
        analysedAt: dateIso(row.analysed_at)
      }));
    }

    const data = await this.readJson();
    return Object.entries(data.analysis).map(([key, analysis]) => {
      const mediaType = analysis.mediaType || key.split(":")[0];
      return {
        mediaType,
        groupId: String(analysis.groupId || key.slice(mediaType.length + 1)),
        memberIds: Array.isArray(analysis.memberIds) ? analysis.memberIds : [],
        algorithmVersion: Number(analysis.algorithmVersion) || 0,
        analysedAt: analysis.analysedAt || null
      };
    });
  }

  async getFingerprints(mediaType, mediaId, signature, algorithmVersion) {
    await this.init();
    if (this.config.mysql.enabled) {
      const [rows] = await this.pool.execute(
        `SELECT stream_index, language, is_default, expected_streams, duration_seconds, chapters_json,
                head_json, tail_json, signature, algorithm_version, updated_at
         FROM media_skip_fingerprints
         WHERE media_type = ? AND media_id = ? AND signature = ? AND algorithm_version = ?
         ORDER BY is_default DESC, stream_index`,
        [mediaType, mediaId, signature, algorithmVersion]
      );
      return rows.map(fingerprintFromRow);
    }

    const data = await this.readJson();
    return Object.values(data.fingerprints)
      .filter((entry) => entry.mediaType === mediaType
        && entry.mediaId === String(mediaId)
        && entry.signature === signature
        && Number(entry.algorithmVersion) === Number(algorithmVersion))
      .sort((first, second) => Number(second.isDefault) - Number(first.isDefault)
        || Number(first.streamIndex) - Number(second.streamIndex));
  }

  async saveFingerprint(mediaType, groupId, mediaId, fingerprint) {
    await this.init();
    const normalized = normalizeFingerprint(mediaType, groupId, mediaId, fingerprint);
    if (this.config.mysql.enabled) {
      await this.pool.execute(
        `INSERT INTO media_skip_fingerprints
          (media_type, media_id, stream_index, group_id, signature, language, is_default, expected_streams,
           duration_seconds, chapters_json, head_json, tail_json, algorithm_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           group_id = VALUES(group_id),
           signature = VALUES(signature),
           language = VALUES(language),
           is_default = VALUES(is_default),
           expected_streams = VALUES(expected_streams),
           duration_seconds = VALUES(duration_seconds),
           chapters_json = VALUES(chapters_json),
           head_json = VALUES(head_json),
           tail_json = VALUES(tail_json),
           algorithm_version = VALUES(algorithm_version),
           updated_at = CURRENT_TIMESTAMP`,
        [
          normalized.mediaType,
          normalized.mediaId,
          normalized.streamIndex,
          normalized.groupId,
          normalized.signature,
          normalized.language,
          normalized.isDefault ? 1 : 0,
          normalized.expectedStreams,
          normalized.duration,
          JSON.stringify(normalized.chapters),
          JSON.stringify(normalized.head),
          JSON.stringify(normalized.tail),
          normalized.algorithmVersion
        ]
      );
      return;
    }

    await this.updateJson((data) => {
      data.fingerprints[fingerprintKey(mediaType, mediaId, normalized.streamIndex)] = normalized;
    });
  }

  async saveFailure(mediaType, groupId, mediaId, filePath, message) {
    await this.init();
    const failure = {
      mediaType,
      groupId: String(groupId),
      mediaId: String(mediaId),
      filePath: String(filePath || ""),
      message: String(message || "Skip detection failed"),
      lastFailedAt: new Date().toISOString()
    };
    if (this.config.mysql.enabled) {
      await this.pool.execute(
        "DELETE FROM media_skip_failures WHERE media_type = ? AND file_path = ? AND media_id <> ?",
        [mediaType, failure.filePath, failure.mediaId]
      );
      await this.pool.execute(
        `INSERT INTO media_skip_failures
          (media_type, media_id, group_id, file_path, failure_message, attempts)
         VALUES (?, ?, ?, ?, ?, 1)
         ON DUPLICATE KEY UPDATE
           group_id = VALUES(group_id),
           file_path = VALUES(file_path),
           failure_message = VALUES(failure_message),
           attempts = attempts + 1,
           last_failed_at = CURRENT_TIMESTAMP`,
        [mediaType, failure.mediaId, failure.groupId, failure.filePath, failure.message]
      );
      return;
    }

    await this.updateJson((data) => {
      const key = mediaKey(mediaType, mediaId);
      for (const [existingKey, existing] of Object.entries(data.failures)) {
        if (existingKey !== key
          && existing.mediaType === mediaType
          && existing.filePath === failure.filePath) {
          delete data.failures[existingKey];
        }
      }
      const previous = data.failures[key];
      data.failures[key] = {
        ...failure,
        attempts: Math.max(0, Number(previous && previous.attempts) || 0) + 1
      };
    });
  }

  async clearFailure(mediaType, mediaId, filePath = null) {
    await this.init();
    if (this.config.mysql.enabled) {
      if (filePath) {
        await this.pool.execute(
          "DELETE FROM media_skip_failures WHERE media_type = ? AND file_path = ?",
          [mediaType, String(filePath)]
        );
      } else {
        await this.pool.execute(
          "DELETE FROM media_skip_failures WHERE media_type = ? AND media_id = ?",
          [mediaType, String(mediaId)]
        );
      }
      return;
    }
    await this.updateJson((data) => {
      if (filePath) {
        for (const [key, failure] of Object.entries(data.failures)) {
          if (failure.mediaType === mediaType && failure.filePath === String(filePath)) {
            delete data.failures[key];
          }
        }
      } else {
        delete data.failures[mediaKey(mediaType, mediaId)];
      }
    });
  }

  async listFailures(limit = 500) {
    await this.init();
    const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 500, 100000));
    if (this.config.mysql.enabled) {
      const [rows] = await this.pool.query(
        `SELECT media_type, media_id, group_id, file_path, failure_message, attempts, last_failed_at
         FROM media_skip_failures
         ORDER BY last_failed_at DESC
         LIMIT ${safeLimit}`
      );
      return rows.map((row) => ({
        mediaType: row.media_type,
        mediaId: row.media_id,
        groupId: row.group_id,
        filePath: row.file_path,
        message: row.failure_message,
        attempts: Number(row.attempts) || 0,
        lastFailedAt: dateIso(row.last_failed_at)
      }));
    }
    const data = await this.readJson();
    return Object.values(data.failures)
      .sort((first, second) => Date.parse(second.lastFailedAt || 0) - Date.parse(first.lastFailedAt || 0))
      .slice(0, safeLimit);
  }

  async clearFailures(mediaType = null, groupId = null) {
    await this.init();
    if (this.config.mysql.enabled) {
      const clauses = [];
      const params = [];
      if (mediaType) {
        clauses.push("media_type = ?");
        params.push(mediaType);
      }
      if (groupId) {
        clauses.push("group_id = ?");
        params.push(String(groupId));
      }
      const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
      await this.pool.execute(`DELETE FROM media_skip_failures${where}`, params);
      return;
    }

    await this.updateJson((data) => {
      for (const [key, failure] of Object.entries(data.failures)) {
        if ((!mediaType || failure.mediaType === mediaType)
          && (!groupId || String(failure.groupId) === String(groupId))) {
          delete data.failures[key];
        }
      }
    });
  }

  async clearAnalysis(mediaType = null, groupId = null, includeFingerprints = false) {
    await this.init();
    if (this.config.mysql.enabled) {
      const clauses = [];
      const params = [];
      if (mediaType) {
        clauses.push("media_type = ?");
        params.push(mediaType);
      }
      if (groupId) {
        clauses.push("group_id = ?");
        params.push(groupId);
      }
      const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
      await this.pool.execute(`DELETE FROM media_skip_analysis${where}`, params);
      if (includeFingerprints) {
        await this.pool.execute(`DELETE FROM media_skip_fingerprints${where}`, params);
      }
      return;
    }

    await this.updateJson((data) => {
      for (const [key, analysis] of Object.entries(data.analysis)) {
        if (matchesRecord(key, analysis, mediaType, groupId)) {
          delete data.analysis[key];
        }
      }
      if (includeFingerprints) {
        for (const [key, fingerprint] of Object.entries(data.fingerprints)) {
          if ((!mediaType || fingerprint.mediaType === mediaType)
            && (!groupId || fingerprint.groupId === groupId)) {
            delete data.fingerprints[key];
          }
        }
      }
    });
  }

  async saveGroup(mediaType, groupId, memberIds, markersByMediaId, algorithmVersion) {
    await this.init();
    const normalizedIds = [...new Set(memberIds.map(String))];
    if (this.config.mysql.enabled) {
      const connection = await this.pool.getConnection();
      try {
        await connection.beginTransaction();
        for (const mediaId of normalizedIds) {
          await connection.execute(
            "DELETE FROM media_skip_markers WHERE media_type = ? AND media_id = ?",
            [mediaType, mediaId]
          );
          const markers = normalizeMarkers(markersByMediaId[mediaId]);
          for (let index = 0; index < markers.length; index += 1) {
            const marker = markers[index];
            await connection.execute(
              `INSERT INTO media_skip_markers
                (media_type, media_id, marker_index, marker_type, start_seconds, end_seconds, confidence, source)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              [mediaType, mediaId, index, marker.type, marker.startSeconds, marker.endSeconds, marker.confidence, marker.source]
            );
          }
        }
        await connection.execute(
          `INSERT INTO media_skip_analysis (media_type, group_id, member_ids_json, algorithm_version)
           VALUES (?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             member_ids_json = VALUES(member_ids_json),
             algorithm_version = VALUES(algorithm_version),
             analysed_at = CURRENT_TIMESTAMP`,
          [mediaType, groupId, JSON.stringify(normalizedIds), algorithmVersion]
        );
        await connection.commit();
      } catch (err) {
        await connection.rollback();
        throw err;
      } finally {
        connection.release();
      }
      return;
    }

    await this.updateJson((data) => {
      for (const mediaId of normalizedIds) {
        data.markers[mediaKey(mediaType, mediaId)] = normalizeMarkers(markersByMediaId[mediaId]);
      }
      data.analysis[groupKey(mediaType, groupId)] = {
        mediaType,
        groupId: String(groupId),
        memberIds: normalizedIds,
        algorithmVersion,
        analysedAt: new Date().toISOString()
      };
    });
  }

  async init() {
    if (this.initialized) {
      return;
    }
    if (this.initializationPromise) {
      return this.initializationPromise;
    }
    this.initializationPromise = this.initialize();
    try {
      await this.initializationPromise;
      this.initialized = true;
    } finally {
      this.initializationPromise = null;
    }
  }

  async initialize() {
    if (!this.config.mysql.enabled) {
      return;
    }
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
      CREATE TABLE IF NOT EXISTS media_skip_markers (
        media_type VARCHAR(64) NOT NULL,
        media_id VARCHAR(128) NOT NULL,
        marker_index INT NOT NULL,
        marker_type VARCHAR(16) NOT NULL,
        start_seconds DOUBLE NOT NULL,
        end_seconds DOUBLE NOT NULL,
        confidence DOUBLE NOT NULL DEFAULT 1,
        source VARCHAR(32) NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (media_type, media_id, marker_index),
        INDEX idx_media_skip_markers_lookup (media_type, media_id, start_seconds)
      )
    `);
    await this.pool.execute(`
      CREATE TABLE IF NOT EXISTS media_skip_analysis (
        media_type VARCHAR(64) NOT NULL,
        group_id VARCHAR(128) NOT NULL,
        member_ids_json MEDIUMTEXT NOT NULL,
        algorithm_version INT NOT NULL DEFAULT 0,
        analysed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (media_type, group_id)
      )
    `);
    await ensureColumn(this.pool, "media_skip_analysis", "algorithm_version", "INT NOT NULL DEFAULT 0");
    await this.pool.execute(`
      CREATE TABLE IF NOT EXISTS media_skip_fingerprints (
        media_type VARCHAR(64) NOT NULL,
        media_id VARCHAR(128) NOT NULL,
        stream_index INT NOT NULL,
        group_id VARCHAR(128) NOT NULL,
        signature VARCHAR(255) NOT NULL,
        language VARCHAR(32) NOT NULL DEFAULT 'und',
        is_default TINYINT(1) NOT NULL DEFAULT 0,
        expected_streams INT NOT NULL DEFAULT 1,
        duration_seconds DOUBLE NOT NULL,
        chapters_json MEDIUMTEXT NOT NULL,
        head_json MEDIUMTEXT NOT NULL,
        tail_json MEDIUMTEXT NOT NULL,
        algorithm_version INT NOT NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (media_type, media_id, stream_index),
        INDEX idx_media_skip_fingerprints_group (media_type, group_id),
        INDEX idx_media_skip_fingerprints_signature (media_type, media_id, signature, algorithm_version)
      )
    `);
    await ensureColumn(this.pool, "media_skip_fingerprints", "expected_streams", "INT NOT NULL DEFAULT 1");
    await this.pool.execute(`
      CREATE TABLE IF NOT EXISTS media_skip_failures (
        media_type VARCHAR(64) NOT NULL,
        media_id VARCHAR(128) NOT NULL,
        group_id VARCHAR(128) NOT NULL,
        file_path TEXT NOT NULL,
        failure_message TEXT NOT NULL,
        attempts INT NOT NULL DEFAULT 1,
        last_failed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (media_type, media_id),
        INDEX idx_media_skip_failures_group (media_type, group_id)
      )
    `);
  }

  async readJson() {
    try {
      return normalizeJsonData(JSON.parse(await fs.readFile(this.jsonPath, "utf8")));
    } catch (err) {
      if (err.code === "ENOENT") {
        return emptyJsonData();
      }
      throw err;
    }
  }

  updateJson(mutator) {
    const operation = this.jsonWriteChain.then(async () => {
      const data = await this.readJson();
      await mutator(data);
      await atomicWriteJson(this.jsonPath, data);
    });
    this.jsonWriteChain = operation.catch(() => {});
    return operation;
  }
}

function normalizeMarkers(markers) {
  return (Array.isArray(markers) ? markers : [])
    .map((entry) => ({
      type: entry.type === "credits" ? "credits" : "intro",
      startSeconds: Math.max(0, Number(entry.startSeconds) || 0),
      endSeconds: Math.max(0, Number(entry.endSeconds) || 0),
      confidence: Math.max(0, Math.min(1, Number(entry.confidence) || 0)),
      source: String(entry.source || "audio-match")
    }))
    .filter((entry) => entry.endSeconds > entry.startSeconds)
    .sort((first, second) => first.startSeconds - second.startSeconds);
}

function normalizeFingerprint(mediaType, groupId, mediaId, fingerprint) {
  return {
    mediaType,
    mediaId: String(mediaId),
    groupId: String(groupId),
    streamIndex: Number(fingerprint.streamIndex) || 0,
    signature: String(fingerprint.signature || ""),
    language: String(fingerprint.language || "und"),
    isDefault: Boolean(fingerprint.isDefault),
    expectedStreams: Math.max(1, Number(fingerprint.expectedStreams) || 1),
    duration: Math.max(0, Number(fingerprint.duration) || 0),
    chapters: Array.isArray(fingerprint.chapters) ? fingerprint.chapters : [],
    head: fingerprint.head || null,
    tail: fingerprint.tail || null,
    algorithmVersion: Number(fingerprint.algorithmVersion) || 0,
    updatedAt: new Date().toISOString()
  };
}

function fingerprintFromRow(row) {
  return {
    streamIndex: Number(row.stream_index),
    language: row.language || "und",
    isDefault: Boolean(row.is_default),
    expectedStreams: Math.max(1, Number(row.expected_streams) || 1),
    duration: Number(row.duration_seconds),
    chapters: parseJson(row.chapters_json, []),
    head: parseJson(row.head_json, null),
    tail: parseJson(row.tail_json, null),
    signature: row.signature,
    algorithmVersion: Number(row.algorithm_version) || 0,
    updatedAt: dateIso(row.updated_at)
  };
}

function markerFromRow(row) {
  return {
    type: row.marker_type,
    startSeconds: Number(row.start_seconds),
    endSeconds: Number(row.end_seconds),
    confidence: Number(row.confidence),
    source: row.source
  };
}

function emptyJsonData() {
  return {
    version: STORE_VERSION,
    markers: {},
    analysis: {},
    fingerprints: {},
    failures: {}
  };
}

function normalizeJsonData(parsed) {
  return {
    version: STORE_VERSION,
    markers: parsed && parsed.markers || {},
    analysis: parsed && parsed.analysis || {},
    fingerprints: parsed && parsed.fingerprints || {},
    failures: parsed && parsed.failures || {}
  };
}

async function atomicWriteJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, JSON.stringify(data, null, 2));
    await fs.rename(temporaryPath, filePath);
  } catch (err) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw err;
  }
}

async function ensureColumn(pool, table, column, definition) {
  const [rows] = await pool.execute(
    `SELECT 1
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?
     LIMIT 1`,
    [table, column]
  );
  if (rows.length === 0) {
    await pool.execute(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
  }
}

function matchesRecord(key, record, mediaType, groupId) {
  const recordMediaType = record.mediaType || key.split(":")[0];
  const recordGroupId = record.groupId || key.slice(recordMediaType.length + 1);
  return (!mediaType || recordMediaType === mediaType)
    && (!groupId || recordGroupId === groupId);
}

function mediaKey(mediaType, mediaId) {
  return `${mediaType}:${mediaId}`;
}

function groupKey(mediaType, groupId) {
  return `${mediaType}:${groupId}`;
}

function fingerprintKey(mediaType, mediaId, streamIndex) {
  return `${mediaType}:${mediaId}:${streamIndex}`;
}

function parseJson(value, fallback) {
  try {
    return typeof value === "string" ? JSON.parse(value) : value;
  } catch (err) {
    return fallback;
  }
}

function dateIso(value) {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

module.exports = { SkipMarkerStore };
