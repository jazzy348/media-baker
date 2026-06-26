const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const util = require("util");
const mysql = require("mysql2/promise");

const scryptAsync = util.promisify(crypto.scrypt);
const TOKEN_BYTES = 32;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const API_KEY_PREFIX = "st_";

const DEFAULT_PERMISSIONS = {
  libraries: [],
  canCreateShareLinks: false,
  canManageLibraries: false,
  canManageMetadata: false,
  canManageSettings: false,
  canManageApiKeys: false,
  canReindex: false,
  canManageUsers: false,
  canViewAdmin: false,
  canViewHardware: false,
  canViewLogs: false,
  canViewUserHistory: false,
  isAdmin: false
};

class AccountService {
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
        CREATE TABLE IF NOT EXISTS user_accounts (
          id VARCHAR(32) NOT NULL PRIMARY KEY,
          username VARCHAR(128) NOT NULL UNIQUE,
          password_hash VARCHAR(255) NOT NULL,
          password_salt VARCHAR(64) NOT NULL,
          permissions_json TEXT NOT NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )
      `);

      await this.pool.execute(`
        CREATE TABLE IF NOT EXISTS user_api_keys (
          id VARCHAR(32) NOT NULL PRIMARY KEY,
          user_id VARCHAR(32) NOT NULL,
          key_name VARCHAR(128) NOT NULL,
          key_hash VARCHAR(64) NOT NULL UNIQUE,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          revoked_at TIMESTAMP NULL,
          INDEX idx_user_api_keys_user (user_id),
          INDEX idx_user_api_keys_hash (key_hash)
        )
      `);

      await this.pool.execute(`
        CREATE TABLE IF NOT EXISTS user_sessions (
          token_hash VARCHAR(64) NOT NULL PRIMARY KEY,
          user_id VARCHAR(32) NOT NULL,
          expires_at TIMESTAMP NOT NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_user_sessions_user (user_id),
          INDEX idx_user_sessions_expires (expires_at)
        )
      `);
    }

    this.initialized = true;
  }

  async needsSetup() {
    return (await this.count()) === 0;
  }

  async count() {
    await this.init();
    if (this.config.mysql.enabled) {
      const [[row]] = await this.pool.execute("SELECT COUNT(*) AS count FROM user_accounts");
      return Number(row.count) || 0;
    }

    const data = await this.readJson();
    return (data.accounts || []).length;
  }

  async setupAdmin(input) {
    if (!await this.needsSetup()) {
      throw httpError(409, "Setup has already been completed");
    }

    return this.create({
      username: input.username,
      password: input.password,
      permissions: {
        ...DEFAULT_PERMISSIONS,
        isAdmin: true,
        canCreateShareLinks: true,
        canManageLibraries: true,
        canManageMetadata: true,
        canManageSettings: true,
        canManageApiKeys: true,
        canReindex: true,
        canManageUsers: true,
        canViewAdmin: true,
        canViewHardware: true,
        canViewLogs: true,
        canViewUserHistory: true,
        libraries: []
      }
    });
  }

  async create(input) {
    await this.init();
    const username = normalizeUsername(input.username);
    const password = String(input.password || "");
    if (password.length < 6) {
      throw httpError(400, "Password must be at least 6 characters");
    }

    if (await this.findByUsername(username)) {
      throw httpError(409, "Username already exists");
    }

    const passwordParts = await hashPassword(password);
    const account = {
      id: crypto.randomBytes(8).toString("hex"),
      username,
      passwordHash: passwordParts.hash,
      passwordSalt: passwordParts.salt,
      permissions: normalizePermissions(input.permissions),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    if (this.config.mysql.enabled) {
      await this.pool.execute(
        `INSERT INTO user_accounts (id, username, password_hash, password_salt, permissions_json)
         VALUES (?, ?, ?, ?, ?)`,
        [account.id, account.username, account.passwordHash, account.passwordSalt, JSON.stringify(account.permissions)]
      );
      return publicAccount(account);
    }

    const data = await this.readJson();
    data.accounts = [...(data.accounts || []), account];
    await this.writeJson(data);
    return publicAccount(account);
  }

  async update(id, input) {
    await this.init();
    const account = await this.findById(id);
    if (!account) {
      throw httpError(404, "Account not found");
    }

    const username = input.username !== undefined ? normalizeUsername(input.username) : account.username;
    const existing = username !== account.username ? await this.findByUsername(username) : null;
    if (existing) {
      throw httpError(409, "Username already exists");
    }

    const password = input.password ? String(input.password) : "";
    if (password && password.length < 6) {
      throw httpError(400, "Password must be at least 6 characters");
    }

    const passwordParts = password
      ? await hashPassword(password)
      : { hash: account.passwordHash, salt: account.passwordSalt };
    const updated = {
      ...account,
      username,
      passwordHash: passwordParts.hash,
      passwordSalt: passwordParts.salt,
      permissions: input.permissions ? normalizePermissions(input.permissions) : account.permissions,
      updatedAt: new Date().toISOString()
    };

    if (this.config.mysql.enabled) {
      await this.pool.execute(
        `UPDATE user_accounts
         SET username = ?, password_hash = ?, password_salt = ?, permissions_json = ?
         WHERE id = ?`,
        [updated.username, updated.passwordHash, updated.passwordSalt, JSON.stringify(updated.permissions), updated.id]
      );
      return publicAccount(updated);
    }

    const data = await this.readJson();
    data.accounts = (data.accounts || []).map((entry) => entry.id === updated.id ? updated : entry);
    await this.writeJson(data);
    return publicAccount(updated);
  }

  async remove(id) {
    await this.init();
    if ((await this.count()) <= 1) {
      throw httpError(400, "Cannot remove the last account");
    }

    if (this.config.mysql.enabled) {
      await this.pool.execute("UPDATE user_api_keys SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = ?", [id]);
      const [result] = await this.pool.execute("DELETE FROM user_accounts WHERE id = ?", [id]);
      await this.revokeUserSessions(id);
      return result.affectedRows > 0;
    }

    const data = await this.readJson();
    const before = (data.accounts || []).length;
    data.accounts = (data.accounts || []).filter((account) => account.id !== id);
    data.apiKeys = (data.apiKeys || []).map((apiKey) => (
      apiKey.userId === id && !apiKey.revokedAt
        ? { ...apiKey, revokedAt: new Date().toISOString() }
        : apiKey
    ));
    await this.writeJson(data);
    await this.revokeUserSessions(id);
    return data.accounts.length !== before;
  }

  async list() {
    await this.init();
    if (this.config.mysql.enabled) {
      const [rows] = await this.pool.execute(
        `SELECT id, username, password_hash, password_salt, permissions_json, created_at, updated_at
         FROM user_accounts
         ORDER BY username`
      );
      return rows.map(fromMysqlAccount).map(publicAccount);
    }

    const data = await this.readJson();
    return (data.accounts || []).map(publicAccount).sort((a, b) => a.username.localeCompare(b.username));
  }

  async authenticate(username, password) {
    const account = await this.findByUsername(username);
    if (!account || !await verifyPassword(password, account.passwordSalt, account.passwordHash)) {
      throw httpError(401, "Invalid username or password");
    }

    const token = crypto.randomBytes(TOKEN_BYTES).toString("base64url");
    await this.saveSession(hashToken(token), account.id, Date.now() + SESSION_TTL_MS);

    return {
      token,
      user: publicAccount(account)
    };
  }

  async createApiKey(userId, input = {}) {
    await this.init();
    const account = await this.findById(userId);
    if (!account) {
      throw httpError(404, "Account not found");
    }

    const name = normalizeApiKeyName(input.name);
    const token = `${API_KEY_PREFIX}${crypto.randomBytes(32).toString("base64url")}`;
    const apiKey = {
      id: crypto.randomBytes(8).toString("hex"),
      userId: account.id,
      name,
      keyHash: hashApiKey(token),
      createdAt: new Date().toISOString(),
      revokedAt: null
    };

    if (this.config.mysql.enabled) {
      await this.pool.execute(
        `INSERT INTO user_api_keys (id, user_id, key_name, key_hash)
         VALUES (?, ?, ?, ?)`,
        [apiKey.id, apiKey.userId, apiKey.name, apiKey.keyHash]
      );
    } else {
      const data = await this.readJson();
      data.apiKeys = [...(data.apiKeys || []), apiKey];
      await this.writeJson(data);
    }

    return {
      apiKey: publicApiKey(apiKey, account),
      token
    };
  }

  async listApiKeys(userId = null) {
    await this.init();
    const accounts = await this.list();
    const accountsById = new Map(accounts.map((account) => [account.id, account]));

    if (this.config.mysql.enabled) {
      const [rows] = await this.pool.execute(
        `SELECT id, user_id, key_name, created_at, revoked_at
         FROM user_api_keys
         ${userId ? "WHERE user_id = ?" : ""}
         ORDER BY created_at DESC`,
        userId ? [userId] : []
      );
      return rows.map((row) => publicApiKey(fromMysqlApiKey(row), accountsById.get(row.user_id))).filter(Boolean);
    }

    const data = await this.readJson();
    return (data.apiKeys || [])
      .filter((apiKey) => !userId || apiKey.userId === userId)
      .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0))
      .map((apiKey) => publicApiKey(apiKey, accountsById.get(apiKey.userId)))
      .filter(Boolean);
  }

  async revokeApiKey(id) {
    await this.init();
    const revokedAt = new Date().toISOString();
    if (this.config.mysql.enabled) {
      const [result] = await this.pool.execute(
        "UPDATE user_api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
        [new Date(revokedAt), id]
      );
      return result.affectedRows > 0;
    }

    const data = await this.readJson();
    const apiKey = (data.apiKeys || []).find((entry) => entry.id === id && !entry.revokedAt);
    if (!apiKey) {
      return false;
    }
    apiKey.revokedAt = revokedAt;
    await this.writeJson(data);
    return true;
  }

  async verifyApiKey(token) {
    await this.init();
    const keyHash = hashApiKey(token);
    let apiKey = null;
    if (this.config.mysql.enabled) {
      const [rows] = await this.pool.execute(
        `SELECT id, user_id, key_name, created_at, revoked_at
         FROM user_api_keys
         WHERE key_hash = ? AND revoked_at IS NULL`,
        [keyHash]
      );
      apiKey = rows[0] ? fromMysqlApiKey(rows[0]) : null;
    } else {
      const data = await this.readJson();
      apiKey = (data.apiKeys || []).find((entry) => entry.keyHash === keyHash && !entry.revokedAt) || null;
    }

    if (!apiKey) {
      return null;
    }

    return this.findById(apiKey.userId).then((account) => account ? publicAccount(account) : null);
  }

  async verifySession(token) {
    await this.init();
    const sessionKey = hashToken(token);
    const session = await this.findSession(sessionKey);
    if (!session) {
      return null;
    }

    if (session.expiresAtMs < Date.now()) {
      await this.removeSession(sessionKey);
      return null;
    }

    const account = await this.findById(session.accountId);
    return account ? publicAccount(account) : null;
  }

  async saveSession(tokenHash, accountId, expiresAtMs) {
    if (this.config.mysql.enabled) {
      await this.pool.execute(
        `INSERT INTO user_sessions (token_hash, user_id, expires_at)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), expires_at = VALUES(expires_at)`,
        [tokenHash, accountId, new Date(expiresAtMs)]
      );
      await this.cleanupExpiredSessions();
      return;
    }

    const data = await this.readJson();
    const session = {
      tokenHash,
      accountId,
      expiresAt: new Date(expiresAtMs).toISOString(),
      createdAt: new Date().toISOString()
    };
    data.sessions = [
      ...(data.sessions || []).filter((entry) => entry.tokenHash !== tokenHash && sessionExpiryMs(entry) >= Date.now()),
      session
    ];
    await this.writeJson(data);
  }

  async findSession(tokenHash) {
    if (this.config.mysql.enabled) {
      const [rows] = await this.pool.execute(
        `SELECT token_hash, user_id, expires_at
         FROM user_sessions
         WHERE token_hash = ?`,
        [tokenHash]
      );
      return rows[0] ? fromMysqlSession(rows[0]) : null;
    }

    const data = await this.readJson();
    const session = (data.sessions || []).find((entry) => entry.tokenHash === tokenHash);
    return session ? fromJsonSession(session) : null;
  }

  async removeSession(tokenHash) {
    if (this.config.mysql.enabled) {
      await this.pool.execute("DELETE FROM user_sessions WHERE token_hash = ?", [tokenHash]);
      return;
    }

    const data = await this.readJson();
    data.sessions = (data.sessions || []).filter((entry) => entry.tokenHash !== tokenHash);
    await this.writeJson(data);
  }

  async revokeUserSessions(accountId) {
    if (this.config.mysql.enabled) {
      await this.pool.execute("DELETE FROM user_sessions WHERE user_id = ?", [accountId]);
      return;
    }

    const data = await this.readJson();
    data.sessions = (data.sessions || []).filter((entry) => entry.accountId !== accountId);
    await this.writeJson(data);
  }

  async cleanupExpiredSessions() {
    if (this.config.mysql.enabled) {
      await this.pool.execute("DELETE FROM user_sessions WHERE expires_at < CURRENT_TIMESTAMP");
      return;
    }

    const data = await this.readJson();
    const before = (data.sessions || []).length;
    data.sessions = (data.sessions || []).filter((entry) => sessionExpiryMs(entry) >= Date.now());
    if (data.sessions.length !== before) {
      await this.writeJson(data);
    }
  }

  async findByUsername(username) {
    await this.init();
    const normalized = normalizeUsername(username);
    if (this.config.mysql.enabled) {
      const [rows] = await this.pool.execute(
        `SELECT id, username, password_hash, password_salt, permissions_json, created_at, updated_at
         FROM user_accounts
         WHERE username = ?`,
        [normalized]
      );
      return rows[0] ? fromMysqlAccount(rows[0]) : null;
    }

    const data = await this.readJson();
    return (data.accounts || []).find((account) => account.username.toLowerCase() === normalized.toLowerCase()) || null;
  }

  async findById(id) {
    await this.init();
    if (this.config.mysql.enabled) {
      const [rows] = await this.pool.execute(
        `SELECT id, username, password_hash, password_salt, permissions_json, created_at, updated_at
         FROM user_accounts
         WHERE id = ?`,
        [id]
      );
      return rows[0] ? fromMysqlAccount(rows[0]) : null;
    }

    const data = await this.readJson();
    return (data.accounts || []).find((account) => account.id === id) || null;
  }

  async readJson() {
    try {
      return JSON.parse(await fs.readFile(this.config.accountStorePath, "utf8"));
    } catch (err) {
      if (err.code === "ENOENT") {
        return { accounts: [], apiKeys: [], sessions: [] };
      }
      throw err;
    }
  }

  async writeJson(data) {
    await fs.mkdir(path.dirname(this.config.accountStorePath), { recursive: true });
    await fs.writeFile(this.config.accountStorePath, JSON.stringify({
      accounts: data.accounts || [],
      apiKeys: data.apiKeys || [],
      sessions: data.sessions || []
    }, null, 2));
  }
}

function normalizeUsername(value) {
  const username = String(value || "").trim();
  if (!/^[A-Za-z0-9_.-]{3,64}$/.test(username)) {
    throw httpError(400, "Username must be 3-64 characters and use letters, numbers, dot, dash, or underscore");
  }
  return username;
}

function normalizePermissions(value = {}) {
  const permissions = {
    ...DEFAULT_PERMISSIONS,
    ...value
  };
  permissions.isAdmin = Boolean(permissions.isAdmin);
  if (permissions.isAdmin) {
    return {
      ...DEFAULT_PERMISSIONS,
      isAdmin: true,
      canCreateShareLinks: true,
      canManageLibraries: true,
      canManageMetadata: true,
      canManageSettings: true,
      canManageApiKeys: true,
      canReindex: true,
      canManageUsers: true,
      canViewAdmin: true,
      canViewHardware: true,
      canViewLogs: true,
      canViewUserHistory: true,
      libraries: []
    };
  }

  const canViewAdmin = Boolean(permissions.canViewAdmin
    || permissions.canCreateShareLinks
    || permissions.canManageLibraries
    || permissions.canManageMetadata
    || permissions.canManageSettings
    || permissions.canManageApiKeys
    || permissions.canManageUsers
    || permissions.canReindex
    || permissions.canViewHardware
    || permissions.canViewLogs
    || permissions.canViewUserHistory);
  return {
    ...DEFAULT_PERMISSIONS,
    libraries: Array.isArray(permissions.libraries) ? permissions.libraries.map(String).filter(Boolean) : [],
    canCreateShareLinks: Boolean(permissions.canCreateShareLinks),
    canManageLibraries: Boolean(permissions.canManageLibraries),
    canManageMetadata: Boolean(permissions.canManageMetadata),
    canManageSettings: Boolean(permissions.canManageSettings),
    canManageApiKeys: Boolean(permissions.canManageApiKeys),
    canReindex: Boolean(permissions.canReindex),
    canManageUsers: Boolean(permissions.canManageUsers),
    canViewAdmin,
    canViewHardware: Boolean(permissions.canViewHardware),
    canViewLogs: Boolean(permissions.canViewLogs),
    canViewUserHistory: Boolean(permissions.canViewUserHistory),
    isAdmin: false
  };
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = await scryptAsync(password, salt, 64);
  return {
    salt,
    hash: derived.toString("hex")
  };
}

async function verifyPassword(password, salt, expectedHash) {
  const derived = await scryptAsync(String(password || ""), salt, 64);
  const expected = Buffer.from(expectedHash, "hex");
  return expected.length === derived.length && crypto.timingSafeEqual(expected, derived);
}

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

function hashApiKey(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

function normalizeApiKeyName(value) {
  const name = String(value || "").trim();
  if (name.length < 1 || name.length > 128) {
    throw httpError(400, "API key name must be 1-128 characters");
  }
  return name;
}

function publicApiKey(apiKey, account) {
  if (!apiKey || !account) {
    return null;
  }
  return {
    id: apiKey.id,
    userId: apiKey.userId,
    username: account.username,
    name: apiKey.name,
    createdAt: apiKey.createdAt || null,
    revokedAt: apiKey.revokedAt || null
  };
}

function fromMysqlApiKey(row) {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.key_name,
    createdAt: toIso(row.created_at),
    revokedAt: toIso(row.revoked_at)
  };
}

function fromMysqlSession(row) {
  return {
    tokenHash: row.token_hash,
    accountId: row.user_id,
    expiresAtMs: row.expires_at ? new Date(row.expires_at).getTime() : 0
  };
}

function fromJsonSession(session) {
  return {
    tokenHash: session.tokenHash,
    accountId: session.accountId,
    expiresAtMs: sessionExpiryMs(session)
  };
}

function sessionExpiryMs(session) {
  const parsed = Date.parse(session && session.expiresAt || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function publicAccount(account) {
  return {
    id: account.id,
    username: account.username,
    permissions: normalizePermissions(account.permissions),
    createdAt: account.createdAt || null,
    updatedAt: account.updatedAt || null
  };
}

function fromMysqlAccount(row) {
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    passwordSalt: row.password_salt,
    permissions: parseJson(row.permissions_json, DEFAULT_PERMISSIONS),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at)
  };
}

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch (err) {
    return fallback;
  }
}

function toIso(value) {
  return value ? new Date(value).toISOString() : null;
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

module.exports = { AccountService, normalizePermissions };
