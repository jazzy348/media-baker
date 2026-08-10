const fs = require("fs/promises");
const path = require("path");
const mysql = require("mysql2/promise");

const ATLAS_TABLE = "openmovie_poster_atlases";
const SLOT_TABLE = "openmovie_poster_atlas_slots";
const CURRENT_TABLE = "openmovie_poster_atlas_current";
const JSON_VERSION = 1;

class OpenMoviePosterAtlasStore {
  constructor(config) {
    this.config = config;
    this.mysql = config.mysql.enabled;
    this.pool = null;
    this.initialized = false;
    this.initPromise = null;
    this.jsonPath = path.join(path.dirname(config.openMovieIdPath), "openmovie-poster-atlases.json");
    this.imageDirectory = path.join(path.dirname(config.openMovieIdPath), "openmovie-poster-atlases");
    this.jsonOperation = Promise.resolve();
    this.registry = null;
  }

  async init() {
    if (this.initialized) return;
    if (!this.initPromise) this.initPromise = this.mysql ? this.initMysql() : this.initJson();
    await this.initPromise;
  }

  async currentPages(collectionKind, collectionKey) {
    await this.init();
    if (this.mysql) {
      const [rows] = await this.pool.execute(
        `SELECT cur.page_number, atlas.id, atlas.library_key, atlas.collection_kind,
                atlas.collection_key, atlas.layout_version,
                atlas.content_signature, atlas.filename, slots.slot_number, slots.entity_key
         FROM ${CURRENT_TABLE} cur
         JOIN ${ATLAS_TABLE} atlas ON atlas.id = cur.atlas_id AND atlas.status = 'published'
         JOIN ${SLOT_TABLE} slots ON slots.atlas_id = atlas.id
         WHERE cur.collection_kind = ? AND cur.collection_key = ?
         ORDER BY cur.page_number, slots.slot_number`,
        [collectionKind, collectionKey]
      );
      return pagesFromRows(rows);
    }

    return this.readJson((registry) => Object.values(registry.current)
      .filter((entry) => entry.collectionKind === collectionKind && entry.collectionKey === collectionKey)
      .map((entry) => atlasPublicRecord(registry.atlases[String(entry.atlasId)]))
      .filter(Boolean)
      .sort((first, second) => first.page - second.page));
  }

  async reserve(details) {
    await this.init();
    if (this.mysql) {
      const [result] = await this.pool.execute(
        `INSERT INTO ${ATLAS_TABLE}
          (library_key, collection_kind, collection_key, page_number, layout_version, content_signature, status)
         VALUES (?, ?, ?, ?, ?, ?, 'generating')`,
        [details.libraryKey, details.collectionKind, details.collectionKey, details.page, details.layout, details.contentSignature]
      );
      return Number(result.insertId);
    }

    let id;
    await this.withJson((registry) => {
      id = registry.nextAtlasId++;
      registry.atlases[String(id)] = {
        id,
        libraryKey: details.libraryKey,
        collectionKind: details.collectionKind,
        collectionKey: details.collectionKey,
        page: details.page,
        layout: details.layout,
        contentSignature: details.contentSignature,
        filename: null,
        status: "generating",
        slots: []
      };
      return true;
    });
    return id;
  }

  async publish(id, filename, slots) {
    await this.init();
    const numericId = positiveInteger(id);
    if (!numericId) throw new Error("Invalid poster atlas ID");
    if (this.mysql) {
      const connection = await this.pool.getConnection();
      try {
        await connection.beginTransaction();
        const [rows] = await connection.execute(
          `SELECT collection_kind, collection_key, page_number FROM ${ATLAS_TABLE}
           WHERE id = ? AND status = 'generating' FOR UPDATE`,
          [numericId]
        );
        if (!rows[0]) throw new Error(`Poster atlas ${numericId} cannot be published`);
        await connection.execute(`DELETE FROM ${SLOT_TABLE} WHERE atlas_id = ?`, [numericId]);
        const values = normalizedSlots(slots);
        if (values.length > 0) {
          await connection.query(
            `INSERT INTO ${SLOT_TABLE} (atlas_id, slot_number, entity_key) VALUES ?`,
            [values.map((slot) => [numericId, slot.slot, slot.entityKey])]
          );
        }
        await connection.execute(
          `UPDATE ${ATLAS_TABLE} SET filename = ?, status = 'published', published_at = CURRENT_TIMESTAMP WHERE id = ?`,
          [filename, numericId]
        );
        await connection.execute(
          `INSERT INTO ${CURRENT_TABLE} (collection_kind, collection_key, page_number, atlas_id)
           VALUES (?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE atlas_id = VALUES(atlas_id)`,
          [rows[0].collection_kind, rows[0].collection_key, Number(rows[0].page_number), numericId]
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

    await this.withJson((registry) => {
      const atlas = registry.atlases[String(numericId)];
      if (!atlas || atlas.status !== "generating") throw new Error(`Poster atlas ${numericId} cannot be published`);
      atlas.filename = filename;
      atlas.status = "published";
      atlas.slots = normalizedSlots(slots);
      atlas.publishedAt = new Date().toISOString();
      registry.current[currentKey(atlas.collectionKind, atlas.collectionKey, atlas.page)] = {
        collectionKind: atlas.collectionKind,
        collectionKey: atlas.collectionKey,
        page: atlas.page,
        atlasId: numericId
      };
      return true;
    });
  }

  async fail(id) {
    await this.init();
    const numericId = positiveInteger(id);
    if (!numericId) return;
    if (this.mysql) {
      await this.pool.execute(
        `UPDATE ${ATLAS_TABLE} SET status = 'failed' WHERE id = ? AND status = 'generating'`,
        [numericId]
      );
      return;
    }
    await this.withJson((registry) => {
      const atlas = registry.atlases[String(numericId)];
      if (!atlas || atlas.status !== "generating") return false;
      atlas.status = "failed";
      return true;
    });
  }

  async resolve(id) {
    await this.init();
    const numericId = positiveInteger(id);
    if (!numericId) return null;
    if (this.mysql) {
      const [rows] = await this.pool.execute(
        `SELECT id, library_key, collection_kind, collection_key, page_number,
                layout_version, content_signature, filename
         FROM ${ATLAS_TABLE} WHERE id = ? AND status = 'published' LIMIT 1`,
        [numericId]
      );
      if (!rows[0]) return null;
      const [slotRows] = await this.pool.execute(
        `SELECT slot_number, entity_key FROM ${SLOT_TABLE} WHERE atlas_id = ? ORDER BY slot_number`,
        [numericId]
      );
      return atlasFromRow(rows[0], slotRows.map((row) => ({
        slot: Number(row.slot_number),
        entityKey: row.entity_key || null
      })));
    }
    return this.readJson((registry) => atlasPublicRecord(registry.atlases[String(numericId)]));
  }

  filePath(filename) {
    const safeName = path.basename(String(filename || ""));
    return safeName && safeName === filename ? path.join(this.imageDirectory, safeName) : null;
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
    await this.pool.execute(`
      CREATE TABLE IF NOT EXISTS ${ATLAS_TABLE} (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        library_key VARCHAR(191) NOT NULL,
        collection_kind VARCHAR(32) NOT NULL,
        collection_key VARCHAR(191) NOT NULL,
        page_number INT UNSIGNED NOT NULL,
        layout_version INT UNSIGNED NOT NULL,
        content_signature CHAR(64) NOT NULL,
        filename VARCHAR(255) NULL,
        status VARCHAR(16) NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        published_at TIMESTAMP NULL,
        PRIMARY KEY (id),
        INDEX idx_openmovie_atlas_library (library_key),
        INDEX idx_openmovie_atlas_collection (collection_kind, collection_key, page_number, status)
      )
    `);
    await this.pool.execute(`
      CREATE TABLE IF NOT EXISTS ${SLOT_TABLE} (
        atlas_id BIGINT UNSIGNED NOT NULL,
        slot_number TINYINT UNSIGNED NOT NULL,
        entity_key VARCHAR(191) NULL,
        PRIMARY KEY (atlas_id, slot_number)
      )
    `);
    await this.pool.execute(`
      CREATE TABLE IF NOT EXISTS ${CURRENT_TABLE} (
        collection_kind VARCHAR(32) NOT NULL,
        collection_key VARCHAR(191) NOT NULL,
        page_number INT UNSIGNED NOT NULL,
        atlas_id BIGINT UNSIGNED NOT NULL,
        PRIMARY KEY (collection_kind, collection_key, page_number),
        INDEX idx_openmovie_atlas_current_id (atlas_id)
      )
    `);
    await fs.mkdir(this.imageDirectory, { recursive: true });
    this.initialized = true;
  }

  async initJson() {
    await fs.mkdir(path.dirname(this.jsonPath), { recursive: true });
    await fs.mkdir(this.imageDirectory, { recursive: true });
    try {
      this.registry = parseRegistry(await fs.readFile(this.jsonPath, "utf8"));
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      this.registry = emptyRegistry();
      await writeRegistry(this.jsonPath, this.registry);
    }
    this.initialized = true;
  }

  async withJson(operation) {
    const task = this.jsonOperation.then(async () => {
      validateRegistry(this.registry);
      const changed = await operation(this.registry);
      if (changed) await writeRegistry(this.jsonPath, this.registry);
    });
    this.jsonOperation = task.catch(() => {});
    return task;
  }

  async readJson(reader) {
    await this.jsonOperation;
    validateRegistry(this.registry);
    return reader(this.registry);
  }
}

function pagesFromRows(rows) {
  const pages = new Map();
  for (const row of rows) {
    const page = Number(row.page_number);
    if (!pages.has(page)) pages.set(page, atlasFromRow(row, []));
    pages.get(page).slots.push({ slot: Number(row.slot_number), entityKey: row.entity_key || null });
  }
  return [...pages.values()].sort((first, second) => first.page - second.page);
}

function atlasFromRow(row, slots) {
  return {
    id: Number(row.id),
    libraryKey: row.library_key,
    collectionKind: row.collection_kind,
    collectionKey: row.collection_key,
    page: Number(row.page_number),
    layout: Number(row.layout_version),
    contentSignature: row.content_signature,
    filename: row.filename,
    slots
  };
}

function atlasPublicRecord(atlas) {
  if (!atlas || atlas.status !== "published") return null;
  return {
    id: Number(atlas.id),
    libraryKey: atlas.libraryKey,
    collectionKind: atlas.collectionKind,
    collectionKey: atlas.collectionKey,
    page: Number(atlas.page),
    layout: Number(atlas.layout),
    contentSignature: atlas.contentSignature,
    filename: atlas.filename,
    slots: normalizedSlots(atlas.slots)
  };
}

function normalizedSlots(slots) {
  const bySlot = new Map();
  for (const entry of slots || []) {
    const slot = Number.parseInt(entry && entry.slot, 10);
    if (!Number.isInteger(slot) || slot < 0 || slot > 11) continue;
    bySlot.set(slot, { slot, entityKey: entry.entityKey ? String(entry.entityKey) : null });
  }
  return [...bySlot.values()].sort((first, second) => first.slot - second.slot);
}

function currentKey(kind, key, page) {
  return `${kind}:${key}:${page}`;
}

function emptyRegistry() {
  return { version: JSON_VERSION, nextAtlasId: 1, atlases: {}, current: {} };
}

function parseRegistry(raw) {
  const registry = JSON.parse(raw);
  validateRegistry(registry);
  return registry;
}

function validateRegistry(registry) {
  if (!registry || registry.version !== JSON_VERSION || !positiveInteger(registry.nextAtlasId)
    || !registry.atlases || typeof registry.atlases !== "object"
    || !registry.current || typeof registry.current !== "object") {
    throw new Error("Invalid OpenMovie poster atlas registry");
  }
}

async function writeRegistry(filePath, registry) {
  const temporaryPath = `${filePath}.tmp`;
  await fs.writeFile(temporaryPath, JSON.stringify(registry, null, 2));
  await fs.rename(temporaryPath, filePath);
}

function positiveInteger(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

module.exports = { OpenMoviePosterAtlasStore };
