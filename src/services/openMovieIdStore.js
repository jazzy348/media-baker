const fs = require("fs/promises");
const path = require("path");
const mysql = require("mysql2/promise");

const REGISTRY_VERSION = 1;
const INSERT_BATCH_SIZE = 500;
const TABLES = {
  movie: "openmovie_movie_ids",
  episode: "openmovie_episode_ids"
};
const VARIANT_TABLE = "openmovie_playback_variant_ids";
const VARIANT_SOURCE_TABLE = "openmovie_playback_variant_sources";

class OpenMovieIdStore {
  constructor(config) {
    this.config = config;
    this.mysql = config.mysql.enabled;
    this.pool = null;
    this.initialized = false;
    this.initPromise = null;
    this.jsonPath = config.openMovieIdPath;
    this.jsonOperation = Promise.resolve();
    this.registry = null;
  }

  async init() {
    if (this.initialized) return;
    if (!this.initPromise) {
      this.initPromise = this.mysql ? this.initMysql() : this.initJson();
    }
    await this.initPromise;
  }

  async sync(movieRefs, episodeRefs) {
    await this.init();
    if (this.mysql) {
      await Promise.all([
        this.insertMysql("movie", movieRefs),
        this.insertMysql("episode", episodeRefs)
      ]);
      return;
    }

    await this.withJsonRegistry(async (registry) => {
      let changed = allocateJsonIds(registry, "movie", movieRefs);
      changed = allocateJsonIds(registry, "episode", episodeRefs) || changed;
      return changed;
    });
  }

  async mappings(kind) {
    await this.init();
    assertKind(kind);
    if (this.mysql) {
      const [rows] = await this.pool.query(
        `SELECT id, library_key, media_id FROM ${TABLES[kind]} ORDER BY id`
      );
      return rows.map((row) => ({
        id: Number(row.id),
        libraryKey: row.library_key,
        mediaId: row.media_id
      }));
    }

    return this.readJsonRegistry((registry) => Object.entries(registry[plural(kind)]).map(([key, id]) => {
      const separator = key.indexOf(":");
      return {
        id: Number(id),
        libraryKey: key.slice(0, separator),
        mediaId: key.slice(separator + 1)
      };
    }).sort((a, b) => a.id - b.id));
  }

  async resolve(kind, id) {
    await this.init();
    assertKind(kind);
    const numericId = positiveInteger(id);
    if (!numericId) return null;

    if (this.mysql) {
      const [rows] = await this.pool.execute(
        `SELECT id, library_key, media_id FROM ${TABLES[kind]} WHERE id = ? LIMIT 1`,
        [numericId]
      );
      const row = rows[0];
      return row ? { id: Number(row.id), libraryKey: row.library_key, mediaId: row.media_id } : null;
    }

    return this.readJsonRegistry((registry) => {
      const entry = Object.entries(registry[plural(kind)]).find(([, value]) => Number(value) === numericId);
      if (!entry) return null;
      const separator = entry[0].indexOf(":");
      return {
        id: numericId,
        libraryKey: entry[0].slice(0, separator),
        mediaId: entry[0].slice(separator + 1)
      };
    });
  }

  async peekNextIds() {
    await this.init();
    if (this.mysql) {
      const tableNames = [...Object.values(TABLES), VARIANT_TABLE];
      const [rows] = await this.pool.query(
        `SELECT TABLE_NAME, AUTO_INCREMENT
         FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME IN (${tableNames.map(() => "?").join(", ")})`,
        tableNames
      );
      const nextByTable = new Map(rows.map((row) => [row.TABLE_NAME, Number(row.AUTO_INCREMENT) || 1]));
      return {
        movie: nextByTable.get(TABLES.movie) || 1,
        episode: nextByTable.get(TABLES.episode) || 1,
        variant: nextByTable.get(VARIANT_TABLE) || 1
      };
    }

    return this.readJsonRegistry((registry) => ({
      movie: registry.nextMovieId,
      episode: registry.nextEpisodeId,
      variant: registry.nextVariantId
    }));
  }

  async variantSourceSignatures() {
    await this.init();
    if (this.mysql) {
      const [rows] = await this.pool.query(
        `SELECT media_kind, library_key, media_id, source_signature FROM ${VARIANT_SOURCE_TABLE}`
      );
      return rows.map((row) => ({
        kind: row.media_kind,
        libraryKey: row.library_key,
        mediaId: row.media_id,
        sourceSignature: row.source_signature
      }));
    }

    return this.readJsonRegistry((registry) => Object.entries(registry.variantSources).map(([key, sourceSignature]) => {
      const [kind, libraryKey, ...mediaIdParts] = key.split(":");
      return { kind, libraryKey, mediaId: mediaIdParts.join(":"), sourceSignature };
    }));
  }

  async syncVariants(kind, libraryKey, mediaId, sourceSignature, variants) {
    await this.init();
    assertKind(kind);
    const normalized = normalizeVariants(variants);
    if (this.mysql) {
      const connection = await this.pool.getConnection();
      try {
        await connection.beginTransaction();
        await connection.execute(
          `UPDATE ${VARIANT_TABLE} SET active = 0 WHERE media_kind = ? AND library_key = ? AND media_id = ?`,
          [kind, libraryKey, mediaId]
        );
        for (const variant of normalized) {
          await connection.execute(
            `INSERT INTO ${VARIANT_TABLE}
              (media_kind, library_key, media_id, variant_key, audio_json, subtitle_json, is_default, active)
             VALUES (?, ?, ?, ?, ?, ?, ?, 1)
             ON DUPLICATE KEY UPDATE
               audio_json = VALUES(audio_json),
               subtitle_json = VALUES(subtitle_json),
               is_default = VALUES(is_default),
               active = 1`,
            [
              kind,
              libraryKey,
              mediaId,
              variant.key,
              JSON.stringify(variant.audio),
              variant.subtitle ? JSON.stringify(variant.subtitle) : null,
              variant.default ? 1 : 0
            ]
          );
        }
        await connection.execute(
          `INSERT INTO ${VARIANT_SOURCE_TABLE} (media_kind, library_key, media_id, source_signature)
           VALUES (?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE source_signature = VALUES(source_signature), synced_at = CURRENT_TIMESTAMP`,
          [kind, libraryKey, mediaId, sourceSignature]
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

    await this.withJsonRegistry(async (registry) => {
      const sourceKey = variantSourceKey(kind, libraryKey, mediaId);
      for (const record of Object.values(registry.variants)) {
        if (record.kind === kind && record.libraryKey === libraryKey && record.mediaId === mediaId) {
          record.active = false;
        }
      }
      for (const variant of normalized) {
        const key = variantRecordKey(kind, libraryKey, mediaId, variant.key);
        const previous = registry.variants[key];
        registry.variants[key] = {
          id: previous ? previous.id : registry.nextVariantId++,
          kind,
          libraryKey,
          mediaId,
          variantKey: variant.key,
          audio: variant.audio,
          subtitle: variant.subtitle,
          default: variant.default,
          active: true
        };
      }
      registry.variantSources[sourceKey] = sourceSignature;
      return true;
    });
  }

  async variants(kind = null, libraryKeys = null) {
    await this.init();
    if (kind) assertKind(kind);
    const allowedLibraries = normalizedLibraryKeys(libraryKeys);
    if (this.mysql) {
      const conditions = ["active = 1"];
      const params = [];
      if (kind) {
        conditions.push("media_kind = ?");
        params.push(kind);
      }
      if (allowedLibraries) {
        if (allowedLibraries.length === 0) return [];
        conditions.push(`library_key IN (${allowedLibraries.map(() => "?").join(", ")})`);
        params.push(...allowedLibraries);
      }
      const [rows] = await this.pool.execute(
        `SELECT id, media_kind, library_key, media_id, audio_json, subtitle_json, is_default
         FROM ${VARIANT_TABLE}
         WHERE ${conditions.join(" AND ")}
         ORDER BY id`,
        params
      );
      return rows.map(variantFromRow);
    }

    return this.readJsonRegistry((registry) => Object.values(registry.variants)
      .filter((record) => record.active
        && (!kind || record.kind === kind)
        && (!allowedLibraries || allowedLibraries.includes(record.libraryKey)))
      .map(publicStoredVariant)
      .sort((first, second) => first.id - second.id));
  }

  async resolveVariant(id) {
    await this.init();
    const numericId = positiveInteger(id);
    if (!numericId) return null;
    if (this.mysql) {
      const [rows] = await this.pool.execute(
        `SELECT id, media_kind, library_key, media_id, audio_json, subtitle_json, is_default
         FROM ${VARIANT_TABLE}
         WHERE id = ? AND active = 1
         LIMIT 1`,
        [numericId]
      );
      return rows[0] ? variantFromRow(rows[0]) : null;
    }

    return this.readJsonRegistry((registry) => {
      const record = Object.values(registry.variants)
        .find((entry) => entry.active && Number(entry.id) === numericId);
      return record ? publicStoredVariant(record) : null;
    });
  }

  async initMysql() {
    this.pool = mysql.createPool({
      host: this.config.mysql.host,
      port: this.config.mysql.port,
      user: this.config.mysql.user,
      password: this.config.mysql.password,
      database: this.config.mysql.database,
      waitForConnections: true,
      connectionLimit: this.config.mysql.connectionLimit
    });

    for (const table of Object.values(TABLES)) {
      await this.pool.execute(`
        CREATE TABLE IF NOT EXISTS ${table} (
          id INT UNSIGNED NOT NULL AUTO_INCREMENT,
          library_key VARCHAR(191) NOT NULL,
          media_id VARCHAR(64) NOT NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (id),
          UNIQUE KEY uq_${table}_media (library_key, media_id)
        )
      `);
    }
    await this.pool.execute(`
      CREATE TABLE IF NOT EXISTS ${VARIANT_TABLE} (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        media_kind VARCHAR(16) NOT NULL,
        library_key VARCHAR(191) NOT NULL,
        media_id VARCHAR(64) NOT NULL,
        variant_key VARCHAR(191) NOT NULL,
        audio_json TEXT NOT NULL,
        subtitle_json TEXT NULL,
        is_default TINYINT(1) NOT NULL DEFAULT 0,
        active TINYINT(1) NOT NULL DEFAULT 1,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_openmovie_variant (media_kind, library_key, media_id, variant_key),
        INDEX idx_openmovie_variant_media (media_kind, library_key, media_id, active)
      )
    `);
    await this.pool.execute(`
      CREATE TABLE IF NOT EXISTS ${VARIANT_SOURCE_TABLE} (
        media_kind VARCHAR(16) NOT NULL,
        library_key VARCHAR(191) NOT NULL,
        media_id VARCHAR(64) NOT NULL,
        source_signature VARCHAR(191) NOT NULL,
        synced_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (media_kind, library_key, media_id)
      )
    `);
    this.initialized = true;
  }

  async initJson() {
    await fs.mkdir(path.dirname(this.jsonPath), { recursive: true });
    try {
      this.registry = parseRegistry(await fs.readFile(this.jsonPath, "utf8"));
      normalizeVariantRegistry(this.registry);
      validateRegistry(this.registry);
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      this.registry = emptyRegistry();
      await writeJsonRegistry(this.jsonPath, this.registry);
    }
    this.initialized = true;
  }

  async insertMysql(kind, refs) {
    assertKind(kind);
    const values = uniqueRefs(refs);
    for (let offset = 0; offset < values.length; offset += INSERT_BATCH_SIZE) {
      const batch = values.slice(offset, offset + INSERT_BATCH_SIZE);
      const lookupPlaceholders = batch.map(() => "(?, ?)").join(", ");
      const [existingRows] = await this.pool.query(
        `SELECT library_key, media_id FROM ${TABLES[kind]} `
        + `WHERE (library_key, media_id) IN (${lookupPlaceholders})`,
        batch.flatMap((ref) => [ref.libraryKey, ref.mediaId])
      );
      const existing = new Set(existingRows.map((row) => `${row.library_key}:${row.media_id}`));
      const missing = batch.filter((ref) => !existing.has(refKey(ref)));
      if (missing.length === 0) continue;
      const insertPlaceholders = missing.map(() => "(?, ?)").join(", ");
      await this.pool.query(
        `INSERT IGNORE INTO ${TABLES[kind]} (library_key, media_id) VALUES ${insertPlaceholders}`,
        missing.flatMap((ref) => [ref.libraryKey, ref.mediaId])
      );
    }
  }

  async withJsonRegistry(operation) {
    const task = this.jsonOperation.then(async () => {
      validateRegistry(this.registry);
      const changed = await operation(this.registry);
      if (changed) await writeJsonRegistry(this.jsonPath, this.registry);
    });
    this.jsonOperation = task.catch(() => {});
    return task;
  }

  async readJsonRegistry(reader) {
    await this.jsonOperation;
    validateRegistry(this.registry);
    return reader(this.registry);
  }
}

function allocateJsonIds(registry, kind, refs) {
  const entries = registry[plural(kind)];
  const nextKey = kind === "movie" ? "nextMovieId" : "nextEpisodeId";
  let changed = false;
  for (const ref of uniqueRefs(refs)) {
    const key = refKey(ref);
    if (entries[key]) continue;
    entries[key] = registry[nextKey];
    registry[nextKey] += 1;
    changed = true;
  }
  return changed;
}

function uniqueRefs(refs) {
  const byKey = new Map();
  for (const ref of refs || []) {
    const libraryKey = String(ref && ref.libraryKey || "").trim();
    const mediaId = String(ref && ref.mediaId || "").trim();
    if (!libraryKey || !mediaId) continue;
    byKey.set(`${libraryKey}:${mediaId}`, { libraryKey, mediaId });
  }
  return [...byKey.values()].sort((a, b) => (
    a.libraryKey.localeCompare(b.libraryKey) || a.mediaId.localeCompare(b.mediaId)
  ));
}

function normalizedLibraryKeys(libraryKeys) {
  if (libraryKeys === null || libraryKeys === undefined) return null;
  return [...new Set((libraryKeys || []).map((key) => String(key || "").trim()).filter(Boolean))];
}

function refKey(ref) {
  return `${ref.libraryKey}:${ref.mediaId}`;
}

function plural(kind) {
  return kind === "movie" ? "movies" : "episodes";
}

function assertKind(kind) {
  if (!TABLES[kind]) throw new Error(`Unsupported OpenMovie ID kind: ${kind}`);
}

function positiveInteger(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function emptyRegistry() {
  return {
    version: REGISTRY_VERSION,
    nextMovieId: 1,
    nextEpisodeId: 1,
    nextVariantId: 1,
    movies: {},
    episodes: {},
    variants: {},
    variantSources: {}
  };
}

function parseRegistry(raw) {
  return JSON.parse(raw);
}

function validateRegistry(registry) {
  if (!registry || registry.version !== REGISTRY_VERSION
    || !positiveInteger(registry.nextMovieId)
    || !positiveInteger(registry.nextEpisodeId)
    || !positiveInteger(registry.nextVariantId)
    || !registry.movies || typeof registry.movies !== "object"
    || !registry.episodes || typeof registry.episodes !== "object"
    || !registry.variants || typeof registry.variants !== "object"
    || !registry.variantSources || typeof registry.variantSources !== "object") {
    throw new Error("Invalid OpenMovie ID registry");
  }
}

function normalizeVariantRegistry(registry) {
  if (!registry.variants || typeof registry.variants !== "object") registry.variants = {};
  if (!registry.variantSources || typeof registry.variantSources !== "object") registry.variantSources = {};
  if (!positiveInteger(registry.nextVariantId)) {
    registry.nextVariantId = Math.max(0, ...Object.values(registry.variants).map((entry) => Number(entry.id) || 0)) + 1;
  }
}

function normalizeVariants(variants) {
  const byKey = new Map();
  for (const variant of variants || []) {
    const key = String(variant && variant.key || "").trim();
    if (!key || !variant.audio) continue;
    byKey.set(key, {
      key,
      audio: variant.audio,
      subtitle: variant.subtitle || null,
      default: Boolean(variant.default)
    });
  }
  return [...byKey.values()];
}

function variantSourceKey(kind, libraryKey, mediaId) {
  return `${kind}:${libraryKey}:${mediaId}`;
}

function variantRecordKey(kind, libraryKey, mediaId, variantKey) {
  return `${variantSourceKey(kind, libraryKey, mediaId)}:${variantKey}`;
}

function variantFromRow(row) {
  return {
    id: Number(row.id),
    kind: row.media_kind,
    libraryKey: row.library_key,
    mediaId: row.media_id,
    audio: parseJson(row.audio_json, null),
    subtitle: parseJson(row.subtitle_json, null),
    default: Boolean(row.is_default)
  };
}

function publicStoredVariant(record) {
  return {
    id: Number(record.id),
    kind: record.kind,
    libraryKey: record.libraryKey,
    mediaId: record.mediaId,
    audio: record.audio || null,
    subtitle: record.subtitle || null,
    default: Boolean(record.default)
  };
}

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  try {
    return typeof value === "string" ? JSON.parse(value) : value;
  } catch (err) {
    return fallback;
  }
}

async function writeJsonRegistry(filePath, registry) {
  const temporaryPath = `${filePath}.tmp`;
  await fs.writeFile(temporaryPath, JSON.stringify(registry, null, 2));
  await fs.rename(temporaryPath, filePath);
}

module.exports = { OpenMovieIdStore };
