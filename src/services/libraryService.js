const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const mysql = require("mysql2/promise");

class LibraryService {
  constructor(config) {
    this.config = config;
    this.pool = null;
    this.initialized = false;
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
        CREATE TABLE IF NOT EXISTS media_libraries (
          library_key VARCHAR(64) NOT NULL PRIMARY KEY,
          title VARCHAR(255) NOT NULL,
          library_type VARCHAR(32) NOT NULL,
          raw_type VARCHAR(64) NULL,
          path TEXT NOT NULL,
          three_d TINYINT(1) NOT NULL DEFAULT 0,
          track_progress TINYINT(1) NOT NULL DEFAULT 1,
          sort_order INT NOT NULL DEFAULT 0,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )
      `);
      await ensureColumn(this.pool, "media_libraries", "sort_order", "INT NOT NULL DEFAULT 0");
      await ensureColumn(this.pool, "media_libraries", "track_progress", "TINYINT(1) NOT NULL DEFAULT 1");

      await this.pool.execute(`
        CREATE TABLE IF NOT EXISTS library_shares (
          id VARCHAR(32) NOT NULL PRIMARY KEY,
          library_key VARCHAR(64) NOT NULL,
          token_value VARCHAR(128) NULL,
          token_hash VARCHAR(64) NOT NULL UNIQUE,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          revoked_at TIMESTAMP NULL,
          INDEX idx_library_shares_library (library_key),
          INDEX idx_library_shares_token_hash (token_hash)
        )
      `);
      await ensureColumn(this.pool, "library_shares", "token_value", "VARCHAR(128) NULL");
    }

    this.initialized = true;
    await this.seedIfEmpty();
  }

  async list() {
    await this.init();

    if (this.config.mysql.enabled) {
      const [rows] = await this.pool.execute(
        `SELECT library_key, title, library_type, raw_type, path, three_d, track_progress, sort_order
         FROM media_libraries
         ORDER BY sort_order, title`
      );
      return rows.map(fromMysqlLibrary).map(withStableSortOrder);
    }

    const data = await this.readJson();
    return normalizeStoredLibraries(data.libraries || []);
  }

  async listWithShares() {
    const storedLibraries = await this.list();
    const storedKeys = new Set(storedLibraries.map((library) => library.key));
    const managedLibraries = (this.config.libraries || [])
      .filter((library) => library.managed && !storedKeys.has(library.key));
    const libraries = [...storedLibraries, ...managedLibraries];
    const shares = await this.listShares();
    return libraries.map((library) => ({
      ...library,
      shares: shares.filter((share) => share.libraryKey === library.key)
    }));
  }

  async add(input) {
    await this.init();
    const library = normalizeLibrary(input);
    const libraries = await this.list();
    if (libraries.some((entry) => entry.key === library.key)) {
      throw httpError(409, `Library already exists: ${library.key}`);
    }
    library.sortOrder = libraries.length;

    if (this.config.mysql.enabled) {
      await this.pool.execute(
        `INSERT INTO media_libraries (library_key, title, library_type, raw_type, path, three_d, track_progress, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [library.key, library.title, library.type, library.rawType, library.path, library.threeD ? 1 : 0, library.trackProgress ? 1 : 0, library.sortOrder]
      );
      return library;
    }

    const data = await this.readJson();
    data.libraries = [...(data.libraries || []), library];
    await this.writeJson(data);
    return library;
  }

  async update(key, input) {
    await this.init();
    const selected = String(key || "").trim();
    const current = (await this.list()).find((library) => library.key === selected);
    if (!current) {
      throw httpError(404, "Library not found");
    }

    const trackProgress = input.trackProgress === undefined
      ? current.trackProgress !== false
      : Boolean(input.trackProgress);
    if (this.config.mysql.enabled) {
      await this.pool.execute(
        "UPDATE media_libraries SET track_progress = ? WHERE library_key = ?",
        [trackProgress ? 1 : 0, selected]
      );
    } else {
      const data = await this.readJson();
      data.libraries = (data.libraries || []).map((library) => library.key === selected
        ? { ...library, trackProgress }
        : library);
      await this.writeJson(data);
    }

    return { ...current, trackProgress };
  }

  async remove(key) {
    await this.init();
    const selected = String(key || "");
    if (this.config.mysql.enabled) {
      await this.pool.execute("DELETE FROM library_shares WHERE library_key = ?", [selected]);
      const [result] = await this.pool.execute("DELETE FROM media_libraries WHERE library_key = ?", [selected]);
      return result.affectedRows > 0;
    }

    const data = await this.readJson();
    const before = (data.libraries || []).length;
    data.libraries = (data.libraries || []).filter((library) => library.key !== selected);
    data.shares = (data.shares || []).filter((share) => share.libraryKey !== selected);
    await this.writeJson(data);
    return data.libraries.length !== before;
  }

  async reorder(keys) {
    await this.init();
    const requestedKeys = Array.isArray(keys) ? keys.map((key) => String(key || "").trim()).filter(Boolean) : [];
    const libraries = await this.list();
    const existingKeys = libraries.map((library) => library.key);
    if (!sameKeySet(requestedKeys, existingKeys)) {
      throw httpError(400, "Library order must include every configured library exactly once.");
    }

    const order = new Map(requestedKeys.map((key, index) => [key, index]));
    if (this.config.mysql.enabled) {
      const connection = await this.pool.getConnection();
      try {
        await connection.beginTransaction();
        for (const key of requestedKeys) {
          await connection.execute(
            "UPDATE media_libraries SET sort_order = ? WHERE library_key = ?",
            [order.get(key), key]
          );
        }
        await connection.commit();
      } catch (err) {
        await connection.rollback();
        throw err;
      } finally {
        connection.release();
      }
      return this.list();
    }

    const data = await this.readJson();
    data.libraries = normalizeStoredLibraries(data.libraries || [])
      .sort((a, b) => order.get(a.key) - order.get(b.key))
      .map((library, index) => ({ ...library, sortOrder: index }));
    await this.writeJson(data);
    return data.libraries;
  }

  async createShare(libraryKey) {
    await this.init();
    const library = await this.findAvailableLibrary(libraryKey);
    if (!library) {
      throw httpError(404, "Library not found");
    }

    const token = crypto.randomBytes(32).toString("base64url");
    const share = {
      id: crypto.randomBytes(8).toString("hex"),
      libraryKey,
      token,
      tokenHash: hashToken(token),
      createdAt: new Date().toISOString(),
      revokedAt: null
    };

    if (this.config.mysql.enabled) {
      await this.pool.execute(
        `INSERT INTO library_shares (id, library_key, token_value, token_hash)
         VALUES (?, ?, ?, ?)`,
        [share.id, share.libraryKey, share.token, share.tokenHash]
      );
    } else {
      const data = await this.readJson();
      data.shares = [...(data.shares || []), share];
      await this.writeJson(data);
    }

    return {
      id: share.id,
      libraryKey: share.libraryKey,
      token,
      createdAt: share.createdAt,
      revokedAt: null
    };
  }

  async revokeShare(libraryKey, shareId) {
    await this.init();
    const revokedAt = new Date().toISOString();
    if (this.config.mysql.enabled) {
      const [result] = await this.pool.execute(
        `UPDATE library_shares
         SET revoked_at = ?
         WHERE id = ? AND library_key = ? AND revoked_at IS NULL`,
        [new Date(revokedAt), shareId, libraryKey]
      );
      return result.affectedRows > 0;
    }

    const data = await this.readJson();
    const share = (data.shares || []).find((entry) => entry.id === shareId && entry.libraryKey === libraryKey && !entry.revokedAt);
    if (!share) {
      return false;
    }
    share.revokedAt = revokedAt;
    await this.writeJson(data);
    return true;
  }

  async verifyShareToken(token) {
    await this.init();
    const tokenHash = hashToken(token);
    const shares = await this.listShares(true);
    const share = shares.find((entry) => entry.tokenHash === tokenHash && !entry.revokedAt);
    if (!share) {
      return null;
    }

    const library = await this.findAvailableLibrary(share.libraryKey);
    return library ? { share, library } : null;
  }

  async findAvailableLibrary(libraryKey) {
    const selected = String(libraryKey || "").trim();
    const stored = (await this.list()).find((library) => library.key === selected);
    if (stored) return stored;
    return (this.config.libraries || []).find((library) => library.managed && library.key === selected) || null;
  }

  async listShares(includeHash = false) {
    await this.init();

    if (this.config.mysql.enabled) {
      const [rows] = await this.pool.execute(
        `SELECT id, library_key, token_value, token_hash, created_at, revoked_at
         FROM library_shares
         ORDER BY created_at DESC`
      );
      return rows.map((row) => fromMysqlShare(row, includeHash));
    }

    const data = await this.readJson();
    return (data.shares || []).map((share) => includeHash ? share : publicShare(share));
  }

  async seedIfEmpty() {
    if (this.config.mysql.enabled) {
      const [[row]] = await this.pool.execute("SELECT COUNT(*) AS count FROM media_libraries");
      if (Number(row.count) > 0 || this.config.libraries.length === 0) {
        return;
      }

      for (const [index, library] of this.config.libraries.entries()) {
        await this.pool.execute(
          `INSERT INTO media_libraries (library_key, title, library_type, raw_type, path, three_d, track_progress, sort_order)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [library.key, library.title, library.type, library.rawType, library.path, library.threeD ? 1 : 0, library.trackProgress === false ? 0 : 1, index]
        );
      }
      return;
    }

    const data = await this.readJson();
    if ((data.libraries || []).length > 0 || this.config.libraries.length === 0) {
      return;
    }

    data.libraries = normalizeStoredLibraries(this.config.libraries);
    data.shares = data.shares || [];
    await this.writeJson(data);
  }

  async readJson() {
    try {
      return JSON.parse(await fs.readFile(this.config.libraryStorePath, "utf8"));
    } catch (err) {
      if (err.code === "ENOENT") {
        return { libraries: [], shares: [] };
      }
      throw err;
    }
  }

  async writeJson(data) {
    await fs.mkdir(path.dirname(this.config.libraryStorePath), { recursive: true });
    await fs.writeFile(this.config.libraryStorePath, JSON.stringify({
      libraries: data.libraries || [],
      shares: data.shares || []
    }, null, 2));
  }
}

function normalizeLibrary(input) {
  const title = String(input.title || input.name || "").trim();
  if (!title) {
    throw httpError(400, "Library name is required");
  }

  const rawType = String(input.type || "").trim();
  const type = normalizeLibraryType(rawType);
  const key = slugValue(title);
  const libraryPath = String(input.path || "").trim();
  if (!libraryPath) {
    throw httpError(400, "Library path is required");
  }

  return {
    key,
    title,
    type,
    rawType,
    threeD: isThreeDLibrary({ key, title, type, rawType }),
    trackProgress: input.trackProgress !== false,
    sortOrder: Number.isFinite(Number(input.sortOrder)) ? Number(input.sortOrder) : 0,
    path: path.resolve(libraryPath)
  };
}

function normalizeLibraryType(value) {
  const type = String(value || "").toLowerCase();
  if (["tv", "show", "shows", "series", "episodes"].includes(type)) {
    return "tv";
  }
  if (["movie", "movies", "film", "films"].includes(type)) {
    return "movies";
  }
  if (["music", "audio", "songs", "albums"].includes(type)) {
    return "music";
  }
  if (["image", "images", "photo", "photos", "pictures"].includes(type)) {
    return "images";
  }
  if (/\b3d\b/i.test(type) && /\b(tv|show|shows|series|episodes)\b/i.test(type)) {
    return "tv";
  }
  if (/\b3d\b/i.test(type) && /\b(movie|movies|film|films)\b/i.test(type)) {
    return "movies";
  }

  throw httpError(400, `Unsupported library type: ${value}. Use "tv", "movies", "music", or "images".`);
}

function isThreeDLibrary(library) {
  return /\b3d\b/i.test([
    library.key,
    library.title,
    library.rawType,
    library.type
  ].filter(Boolean).join(" "));
}

function slugValue(value) {
  return String(value || "")
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

function fromMysqlLibrary(row) {
  return {
    key: row.library_key,
    title: row.title,
    type: row.library_type,
    rawType: row.raw_type || row.library_type,
    path: row.path,
    threeD: Boolean(row.three_d),
    trackProgress: Boolean(row.track_progress),
    sortOrder: Number(row.sort_order) || 0
  };
}

function fromMysqlShare(row, includeHash) {
  const share = {
    id: row.id,
    libraryKey: row.library_key,
    token: row.token_value || null,
    createdAt: toIso(row.created_at),
    revokedAt: toIso(row.revoked_at)
  };
  if (includeHash) {
    share.tokenHash = row.token_hash;
  }
  return share;
}

function publicShare(share) {
  return {
    id: share.id,
    libraryKey: share.libraryKey,
    token: share.token || null,
    createdAt: share.createdAt || null,
    revokedAt: share.revokedAt || null
  };
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

function normalizeStoredLibraries(libraries) {
  return libraries
    .map((library, index) => ({
      ...library,
      trackProgress: library.trackProgress !== false,
      sortOrder: Number.isFinite(Number(library.sortOrder)) ? Number(library.sortOrder) : index
    }))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.title.localeCompare(b.title))
    .map(withStableSortOrder);
}

function withStableSortOrder(library, index) {
  return {
    ...library,
    sortOrder: Number.isFinite(Number(library.sortOrder)) ? Number(library.sortOrder) : index
  };
}

function sameKeySet(left, right) {
  if (left.length !== right.length) {
    return false;
  }

  const seen = new Set();
  for (const key of left) {
    if (seen.has(key) || !right.includes(key)) {
      return false;
    }
    seen.add(key);
  }

  return true;
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

module.exports = { LibraryService };
