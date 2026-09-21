const crypto = require("crypto");
const fs = require("fs/promises");
const util = require("util");
const mysql = require("mysql2/promise");
const { atomicWriteJson } = require("../utils/atomicFile");

const scryptAsync = util.promisify(crypto.scrypt);
const TOKEN_BYTES = 32;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_TOUCH_INTERVAL_MS = 60 * 60 * 1000;
const API_KEY_PREFIX = "st_";
const LIBRARY_VIEW_PREFIX = "lv_";

const DEFAULT_PERMISSIONS = {
  libraries: [],
  canCopyStreamUrls: false,
  canManageStreamQueues: false,
  canManageLibraries: false,
  canManageMetadata: false,
  canManageSettings: false,
  canManageApiKeys: false,
  canManageBackups: false,
  canManageOptimizer: false,
  canReindex: false,
  canManageUsers: false,
  canViewAdmin: false,
  canViewHardware: false,
  canViewLogs: false,
  canViewTasks: false,
  canViewUserHistory: false,
  isAdmin: false
};

const DEFAULT_PLAYBACK_PREFERENCES = {
  audioLanguage: "",
  subtitleLanguage: "",
  subtitleMode: "none",
  quality: "original",
  audioChannels: "stereo",
  themeColour: "#00d9ff"
};

class AccountService {
  constructor(config) {
    this.config = config;
    this.pool = null;
    this.initialized = false;
    this.jsonMutation = Promise.resolve();
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
          preferences_json TEXT NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )
      `);
      await ensureColumn(this.pool, "user_accounts", "preferences_json", "TEXT NULL");

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

      await this.pool.execute(`
        CREATE TABLE IF NOT EXISTS library_view_links (
          id VARCHAR(32) NOT NULL PRIMARY KEY,
          link_name VARCHAR(128) NOT NULL,
          token_value VARCHAR(128) NOT NULL,
          token_hash VARCHAR(64) NOT NULL UNIQUE,
          library_keys_json TEXT NOT NULL,
          expires_at DATETIME NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          revoked_at DATETIME NULL,
          INDEX idx_library_view_links_hash (token_hash),
          INDEX idx_library_view_links_expires (expires_at)
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
        canCopyStreamUrls: true,
        canManageStreamQueues: true,
        canManageLibraries: true,
        canManageMetadata: true,
        canManageSettings: true,
        canManageApiKeys: true,
        canManageBackups: true,
        canManageOptimizer: true,
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

  async create(input, actor = null) {
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
    const permissions = normalizePermissions(input.permissions);
    assertPermissionCeiling(actor, null, permissions);
    const account = {
      id: crypto.randomBytes(8).toString("hex"),
      username,
      passwordHash: passwordParts.hash,
      passwordSalt: passwordParts.salt,
      permissions,
      preferences: normalizePlaybackPreferences(input.preferences),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    if (this.config.mysql.enabled) {
      await this.pool.execute(
        `INSERT INTO user_accounts (id, username, password_hash, password_salt, permissions_json, preferences_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [account.id, account.username, account.passwordHash, account.passwordSalt, JSON.stringify(account.permissions), JSON.stringify(account.preferences)]
      );
      return publicAccount(account);
    }

    return this.mutateJson((data) => {
      if ((data.accounts || []).some((entry) => entry.username.toLowerCase() === account.username.toLowerCase())) {
        throw httpError(409, "Username already exists");
      }
      data.accounts = [...(data.accounts || []), account];
      return publicAccount(account);
    });
  }

  async update(id, input, actor = null) {
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
      preferences: input.preferences ? normalizePlaybackPreferences(input.preferences) : normalizePlaybackPreferences(account.preferences),
      updatedAt: new Date().toISOString()
    };
    assertPermissionCeiling(actor, account, updated.permissions);

    if (this.config.mysql.enabled) {
      const connection = await this.pool.getConnection();
      try {
        await connection.beginTransaction();
        const [accounts] = await connection.execute("SELECT id, permissions_json FROM user_accounts FOR UPDATE");
        assertAdministratorRemains(accounts.map(fromMysqlPermissionRow), account, updated);
        await connection.execute(
          `UPDATE user_accounts
           SET username = ?, password_hash = ?, password_salt = ?, permissions_json = ?, preferences_json = ?
           WHERE id = ?`,
          [updated.username, updated.passwordHash, updated.passwordSalt, JSON.stringify(updated.permissions), JSON.stringify(updated.preferences), updated.id]
        );
        if (password) await connection.execute("DELETE FROM user_sessions WHERE user_id = ?", [updated.id]);
        await connection.commit();
      } catch (err) {
        await connection.rollback().catch(() => {});
        throw err;
      } finally {
        connection.release();
      }
      return publicAccount(updated);
    }

    return this.mutateJson((data) => {
      const current = (data.accounts || []).find((entry) => entry.id === updated.id);
      if (!current) throw httpError(404, "Account not found");
      if ((data.accounts || []).some((entry) => entry.id !== updated.id && entry.username.toLowerCase() === updated.username.toLowerCase())) {
        throw httpError(409, "Username already exists");
      }
      assertAdministratorRemains(data.accounts || [], current, updated);
      data.accounts = (data.accounts || []).map((entry) => entry.id === updated.id ? updated : entry);
      if (password) data.sessions = (data.sessions || []).filter((entry) => entry.accountId !== updated.id);
      return publicAccount(updated);
    });
  }

  async remove(id, actor = null) {
    await this.init();
    const target = await this.findById(id);
    if (!target) return false;
    assertPermissionCeiling(actor, target, null);

    if (this.config.mysql.enabled) {
      const connection = await this.pool.getConnection();
      try {
        await connection.beginTransaction();
        const [rows] = await connection.execute("SELECT id, permissions_json FROM user_accounts FOR UPDATE");
        if (rows.length <= 1) throw httpError(400, "Cannot remove the last account");
        assertAdministratorRemains(rows.map(fromMysqlPermissionRow), target, null);
        await connection.execute("UPDATE user_api_keys SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = ?", [id]);
        await connection.execute("DELETE FROM user_sessions WHERE user_id = ?", [id]);
        const [result] = await connection.execute("DELETE FROM user_accounts WHERE id = ?", [id]);
        await connection.commit();
        return result.affectedRows > 0;
      } catch (err) {
        await connection.rollback().catch(() => {});
        throw err;
      } finally {
        connection.release();
      }
    }

    return this.mutateJson((data) => {
      const current = (data.accounts || []).find((entry) => entry.id === id);
      if (!current) return false;
      if ((data.accounts || []).length <= 1) throw httpError(400, "Cannot remove the last account");
      assertAdministratorRemains(data.accounts || [], current, null);
      data.accounts = data.accounts.filter((entry) => entry.id !== id);
      data.apiKeys = (data.apiKeys || []).map((apiKey) => apiKey.userId === id && !apiKey.revokedAt
        ? { ...apiKey, revokedAt: new Date().toISOString() }
        : apiKey);
      data.sessions = (data.sessions || []).filter((entry) => entry.accountId !== id);
      return true;
    });
  }

  async list() {
    await this.init();
    if (this.config.mysql.enabled) {
      const [rows] = await this.pool.execute(
        `SELECT id, username, password_hash, password_salt, permissions_json, preferences_json, created_at, updated_at
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

  async verifyAccountPassword(id, password) {
    const account = await this.findById(id);
    return Boolean(account && await verifyPassword(String(password || ""), account.passwordSalt, account.passwordHash));
  }

  async createApiKey(userId, input = {}, actor = null) {
    await this.init();
    const account = await this.findById(userId);
    if (!account) {
      throw httpError(404, "Account not found");
    }
    assertPermissionCeiling(actor, account, account.permissions, { selfOnly: true });

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
      await this.mutateJson((data) => {
        data.apiKeys = [...(data.apiKeys || []), apiKey];
      });
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

    return this.mutateJson((data) => {
      const apiKey = (data.apiKeys || []).find((entry) => entry.id === id && !entry.revokedAt);
      if (!apiKey) return false;
      apiKey.revokedAt = revokedAt;
      return true;
    });
  }

  async verifyApiKey(token) {
    const principal = await this.verifyApiKeyPrincipal(token);
    return principal ? principal.user : null;
  }

  async verifyApiKeyPrincipal(token) {
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

    const account = await this.findById(apiKey.userId);
    return account ? { apiKeyId: apiKey.id, user: publicAccount(account) } : null;
  }

  async resolveApiKeyPrincipal(apiKeyId) {
    await this.init();
    let apiKey = null;
    if (this.config.mysql.enabled) {
      const [rows] = await this.pool.execute(
        `SELECT id, user_id, key_name, created_at, revoked_at
         FROM user_api_keys
         WHERE id = ? AND revoked_at IS NULL`,
        [apiKeyId]
      );
      apiKey = rows[0] ? fromMysqlApiKey(rows[0]) : null;
    } else {
      const data = await this.readJson();
      apiKey = (data.apiKeys || []).find((entry) => entry.id === apiKeyId && !entry.revokedAt) || null;
    }
    if (!apiKey) return null;
    const account = await this.findById(apiKey.userId);
    return account ? { apiKeyId: apiKey.id, user: publicAccount(account) } : null;
  }

  async createLibraryView(input = {}) {
    await this.init();
    const name = normalizeLibraryViewName(input.name);
    const availableLibraryKeys = new Set((this.config.libraries || []).map((library) => library.key));
    const libraryKeys = normalizeLibraryViewLibraries(input.libraryKeys, availableLibraryKeys);
    const expiresAt = normalizeLibraryViewExpiry(input.expiresAt);
    const token = `${LIBRARY_VIEW_PREFIX}${crypto.randomBytes(32).toString("base64url")}`;
    const link = {
      id: crypto.randomBytes(8).toString("hex"),
      name,
      token,
      tokenHash: hashToken(token),
      libraryKeys,
      expiresAt,
      createdAt: new Date().toISOString(),
      revokedAt: null
    };

    if (this.config.mysql.enabled) {
      await this.pool.execute(
        `INSERT INTO library_view_links
          (id, link_name, token_value, token_hash, library_keys_json, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [link.id, link.name, link.token, link.tokenHash, JSON.stringify(link.libraryKeys), expiresAt ? new Date(expiresAt) : null]
      );
    } else {
      await this.mutateJson((data) => {
        data.libraryViews = [...(data.libraryViews || []), link];
      });
    }

    return publicLibraryView(link);
  }

  async listLibraryViews() {
    await this.init();
    if (this.config.mysql.enabled) {
      const [rows] = await this.pool.execute(
        `SELECT id, link_name, token_value, library_keys_json, expires_at, created_at, revoked_at
         FROM library_view_links
         ORDER BY created_at DESC`
      );
      return rows.map(fromMysqlLibraryView).map(publicLibraryView);
    }

    const data = await this.readJson();
    return (data.libraryViews || [])
      .map(publicLibraryView)
      .sort((left, right) => Date.parse(right.createdAt || 0) - Date.parse(left.createdAt || 0));
  }

  async revokeLibraryView(id) {
    await this.init();
    const revokedAt = new Date().toISOString();
    if (this.config.mysql.enabled) {
      const [result] = await this.pool.execute(
        "UPDATE library_view_links SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
        [new Date(revokedAt), id]
      );
      return result.affectedRows > 0;
    }

    return this.mutateJson((data) => {
      const link = (data.libraryViews || []).find((entry) => entry.id === id && !entry.revokedAt);
      if (!link) return false;
      link.revokedAt = revokedAt;
      return true;
    });
  }

  async verifyLibraryViewToken(token) {
    await this.init();
    const tokenHash = hashToken(token);
    let link = null;
    if (this.config.mysql.enabled) {
      const [rows] = await this.pool.execute(
        `SELECT id, link_name, token_value, library_keys_json, expires_at, created_at, revoked_at
         FROM library_view_links
         WHERE token_hash = ? AND revoked_at IS NULL`,
        [tokenHash]
      );
      link = rows[0] ? fromMysqlLibraryView(rows[0]) : null;
    } else {
      const data = await this.readJson();
      link = (data.libraryViews || []).find((entry) => entry.tokenHash === tokenHash && !entry.revokedAt) || null;
    }

    const expiresAtMs = link && link.expiresAt ? Date.parse(link.expiresAt) : null;
    if (!link || link.expiresAt && (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now())) {
      return null;
    }

    const availableLibraryKeys = new Set((this.config.libraries || []).map((library) => library.key));
    const libraryKeys = (link.libraryKeys || []).filter((key) => availableLibraryKeys.has(key));
    return libraryKeys.length > 0 ? {
      id: link.id,
      name: link.name,
      libraryKeys,
      expiresAt: link.expiresAt || null
    } : null;
  }

  async verifySession(token) {
    await this.init();
    const sessionKey = hashToken(token);
    const session = await this.findSession(sessionKey);
    if (!session) {
      return null;
    }

    const now = Date.now();
    if (session.expiresAtMs < now) {
      await this.removeSession(sessionKey);
      return null;
    }

    const account = await this.findById(session.accountId);
    if (!account) {
      return null;
    }

    if (session.expiresAtMs - now <= SESSION_TTL_MS - SESSION_TOUCH_INTERVAL_MS) {
      await this.touchSession(sessionKey, session.accountId, now + SESSION_TTL_MS);
    }

    return publicAccount(account);
  }

  async touchSession(tokenHash, accountId, expiresAtMs) {
    if (this.config.mysql.enabled) {
      await this.pool.execute(
        `UPDATE user_sessions
         SET expires_at = ?
         WHERE token_hash = ? AND user_id = ? AND expires_at >= CURRENT_TIMESTAMP`,
        [new Date(expiresAtMs), tokenHash, accountId]
      );
      return;
    }

    await this.mutateJson((data) => {
      const session = (data.sessions || []).find((entry) => (
        entry.tokenHash === tokenHash
        && entry.accountId === accountId
        && sessionExpiryMs(entry) >= Date.now()
      ));
      if (session) session.expiresAt = new Date(expiresAtMs).toISOString();
    });
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

    const session = {
      tokenHash,
      accountId,
      expiresAt: new Date(expiresAtMs).toISOString(),
      createdAt: new Date().toISOString()
    };
    await this.mutateJson((data) => {
      data.sessions = [
        ...(data.sessions || []).filter((entry) => entry.tokenHash !== tokenHash && sessionExpiryMs(entry) >= Date.now()),
        session
      ];
    });
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

    await this.mutateJson((data) => {
      data.sessions = (data.sessions || []).filter((entry) => entry.tokenHash !== tokenHash);
    });
  }

  async revokeUserSessions(accountId) {
    if (this.config.mysql.enabled) {
      await this.pool.execute("DELETE FROM user_sessions WHERE user_id = ?", [accountId]);
      return;
    }

    await this.mutateJson((data) => {
      data.sessions = (data.sessions || []).filter((entry) => entry.accountId !== accountId);
    });
  }

  async cleanupExpiredSessions() {
    if (this.config.mysql.enabled) {
      await this.pool.execute("DELETE FROM user_sessions WHERE expires_at < CURRENT_TIMESTAMP");
      return;
    }

    await this.mutateJson((data) => {
      data.sessions = (data.sessions || []).filter((entry) => sessionExpiryMs(entry) >= Date.now());
    });
  }

  async findByUsername(username) {
    await this.init();
    const normalized = normalizeUsername(username);
    if (this.config.mysql.enabled) {
      const [rows] = await this.pool.execute(
        `SELECT id, username, password_hash, password_salt, permissions_json, preferences_json, created_at, updated_at
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
        `SELECT id, username, password_hash, password_salt, permissions_json, preferences_json, created_at, updated_at
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
        return { accounts: [], apiKeys: [], sessions: [], libraryViews: [] };
      }
      throw err;
    }
  }

  async writeJson(data) {
    await atomicWriteJson(this.config.accountStorePath, {
      accounts: data.accounts || [],
      apiKeys: data.apiKeys || [],
      sessions: data.sessions || [],
      libraryViews: data.libraryViews || []
    });
  }

  mutateJson(mutator) {
    const operation = this.jsonMutation.then(async () => {
      const data = await this.readJson();
      const result = await mutator(data);
      await this.writeJson(data);
      return result;
    });
    this.jsonMutation = operation.catch(() => {});
    return operation;
  }

  async createSession(accountId) {
    const token = crypto.randomBytes(TOKEN_BYTES).toString("base64url");
    await this.saveSession(hashToken(token), accountId, Date.now() + SESSION_TTL_MS);
    return token;
  }

  async logout(token) {
    if (!token) return;
    await this.removeSession(hashToken(token));
  }
}

function fromMysqlPermissionRow(row) {
  return { id: row.id, permissions: parseJson(row.permissions_json, {}) };
}

function assertAdministratorRemains(accounts, previous, next) {
  if (!previous || !normalizePermissions(previous.permissions).isAdmin) return;
  if (next && normalizePermissions(next.permissions).isAdmin) return;
  const administratorCount = accounts.filter((entry) => normalizePermissions(entry.permissions).isAdmin).length;
  if (administratorCount <= 1) throw httpError(400, "Cannot remove or demote the last administrator");
}

function assertPermissionCeiling(actor, target, requestedPermissions, options = {}) {
  if (!actor || actor.permissions && actor.permissions.isAdmin) return;
  if (options.selfOnly && (!target || target.id !== actor.id)) {
    throw httpError(403, "API keys may only be managed for your own account");
  }
  const targetPermissions = target && normalizePermissions(target.permissions);
  if (targetPermissions && targetPermissions.isAdmin) throw httpError(403, "Only an administrator can manage an administrator account");
  const requested = requestedPermissions && normalizePermissions(requestedPermissions);
  if (!requested) return;
  if (requested.isAdmin) throw httpError(403, "Only an administrator can grant administrator access");
  for (const [name, enabled] of Object.entries(requested)) {
    if (name === "libraries" || name === "canViewAdmin" || !enabled) continue;
    if (!actor.permissions || !actor.permissions[name]) {
      throw httpError(403, `You cannot grant the ${name} permission`);
    }
  }
  const allowedLibraries = new Set(actor.permissions && actor.permissions.libraries || []);
  if ((requested.libraries || []).some((key) => !allowedLibraries.has(key))) {
    throw httpError(403, "You cannot grant access to a library you cannot access");
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
      canCopyStreamUrls: true,
      canManageStreamQueues: true,
      canManageLibraries: true,
      canManageMetadata: true,
      canManageSettings: true,
      canManageApiKeys: true,
      canManageBackups: true,
      canManageOptimizer: true,
      canReindex: true,
      canManageUsers: true,
      canViewAdmin: true,
      canViewHardware: true,
      canViewLogs: true,
      canViewTasks: true,
      canViewUserHistory: true,
      libraries: []
    };
  }

  const canViewAdmin = Boolean(permissions.canViewAdmin
    || permissions.canManageLibraries
    || permissions.canManageMetadata
    || permissions.canManageSettings
    || permissions.canManageApiKeys
    || permissions.canManageBackups
    || permissions.canManageOptimizer
    || permissions.canManageUsers
    || permissions.canReindex
    || permissions.canViewHardware
    || permissions.canViewLogs
    || permissions.canViewTasks
    || permissions.canViewUserHistory);
  return {
    ...DEFAULT_PERMISSIONS,
    libraries: Array.isArray(permissions.libraries) ? permissions.libraries.map(String).filter(Boolean) : [],
    canCopyStreamUrls: Boolean(permissions.canCopyStreamUrls),
    canManageStreamQueues: Boolean(permissions.canManageStreamQueues),
    canManageLibraries: Boolean(permissions.canManageLibraries),
    canManageMetadata: Boolean(permissions.canManageMetadata),
    canManageSettings: Boolean(permissions.canManageSettings),
    canManageApiKeys: Boolean(permissions.canManageApiKeys),
    canManageBackups: Boolean(permissions.canManageBackups),
    canManageOptimizer: Boolean(permissions.canManageOptimizer),
    canReindex: Boolean(permissions.canReindex),
    canManageUsers: Boolean(permissions.canManageUsers),
    canViewAdmin,
    canViewHardware: Boolean(permissions.canViewHardware),
    canViewLogs: Boolean(permissions.canViewLogs),
    canViewTasks: Boolean(permissions.canViewTasks),
    canViewUserHistory: Boolean(permissions.canViewUserHistory),
    isAdmin: false
  };
}

function normalizePlaybackPreferences(value = {}) {
  const preferences = {
    ...DEFAULT_PLAYBACK_PREFERENCES,
    ...(value || {})
  };
  const subtitleMode = String(preferences.subtitleMode || DEFAULT_PLAYBACK_PREFERENCES.subtitleMode).toLowerCase();
  const quality = String(preferences.quality || DEFAULT_PLAYBACK_PREFERENCES.quality).toLowerCase();
  const audioChannels = String(preferences.audioChannels || DEFAULT_PLAYBACK_PREFERENCES.audioChannels).toLowerCase();
  return {
    audioLanguage: normalizePreferenceText(preferences.audioLanguage),
    subtitleLanguage: normalizePreferenceText(preferences.subtitleLanguage),
    subtitleMode: ["none", "preferred", "forced", "any"].includes(subtitleMode) ? subtitleMode : "none",
    quality: ["original", "medium", "low"].includes(quality) ? quality : "original",
    audioChannels: ["stereo", "surround51", "stabby51", "preserve"].includes(audioChannels) ? audioChannels : "stereo",
    themeColour: normalizeThemeColour(preferences.themeColour)
  };
}

function normalizeThemeColour(value) {
  const colour = String(value || "").trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(colour) ? colour : DEFAULT_PLAYBACK_PREFERENCES.themeColour;
}

function normalizePreferenceText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "");
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

function normalizeLibraryViewName(value) {
  const name = String(value || "").trim();
  if (name.length < 1 || name.length > 128) {
    throw httpError(400, "Library view name must be 1-128 characters");
  }
  return name;
}

function normalizeLibraryViewLibraries(value, availableLibraryKeys) {
  const libraryKeys = [...new Set((Array.isArray(value) ? value : []).map((key) => String(key || "").trim()).filter(Boolean))];
  if (libraryKeys.length === 0) {
    throw httpError(400, "Choose at least one library");
  }
  const unknown = libraryKeys.find((key) => !availableLibraryKeys.has(key));
  if (unknown) {
    throw httpError(400, `Unknown library: ${unknown}`);
  }
  return libraryKeys;
}

function normalizeLibraryViewExpiry(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const expiresAtMs = Date.parse(String(value));
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
    throw httpError(400, "Library view expiry must be a future date and time");
  }
  return new Date(expiresAtMs).toISOString();
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

function fromMysqlLibraryView(row) {
  return {
    id: row.id,
    name: row.link_name,
    token: row.token_value || null,
    libraryKeys: parseJson(row.library_keys_json, []),
    expiresAt: toIso(row.expires_at),
    createdAt: toIso(row.created_at),
    revokedAt: toIso(row.revoked_at)
  };
}

function publicLibraryView(link) {
  const expiresAt = link.expiresAt || null;
  const expiresAtMs = expiresAt ? Date.parse(expiresAt) : null;
  return {
    id: link.id,
    name: link.name,
    token: link.token || null,
    libraryKeys: Array.isArray(link.libraryKeys) ? link.libraryKeys.map(String).filter(Boolean) : [],
    expiresAt,
    createdAt: link.createdAt || null,
    revokedAt: link.revokedAt || null,
    expired: Boolean(expiresAt && (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()))
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
    preferences: normalizePlaybackPreferences(account.preferences),
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
    preferences: parseJson(row.preferences_json, DEFAULT_PLAYBACK_PREFERENCES),
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

module.exports = { AccountService, normalizePermissions, normalizePlaybackPreferences };
