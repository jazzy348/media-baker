const fs = require("fs/promises");
const path = require("path");
const mysql = require("mysql2/promise");

const REGISTRY_VERSION = 1;
const INSERT_BATCH_SIZE = 500;
const TABLES = {
  movie: "openmovie_movie_ids",
  episode: "openmovie_episode_ids"
};

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
    this.initialized = true;
  }

  async initJson() {
    await fs.mkdir(path.dirname(this.jsonPath), { recursive: true });
    try {
      this.registry = parseRegistry(await fs.readFile(this.jsonPath, "utf8"));
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
    movies: {},
    episodes: {}
  };
}

function parseRegistry(raw) {
  return JSON.parse(raw);
}

function validateRegistry(registry) {
  if (!registry || registry.version !== REGISTRY_VERSION
    || !positiveInteger(registry.nextMovieId)
    || !positiveInteger(registry.nextEpisodeId)
    || !registry.movies || typeof registry.movies !== "object"
    || !registry.episodes || typeof registry.episodes !== "object") {
    throw new Error("Invalid OpenMovie ID registry");
  }
}

async function writeJsonRegistry(filePath, registry) {
  const temporaryPath = `${filePath}.tmp`;
  await fs.writeFile(temporaryPath, JSON.stringify(registry, null, 2));
  await fs.rename(temporaryPath, filePath);
}

module.exports = { OpenMovieIdStore };
