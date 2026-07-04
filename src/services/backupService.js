const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const readline = require("readline");
const zlib = require("zlib");
const { once } = require("events");
const { finished } = require("stream/promises");
const mysql = require("mysql2/promise");
const logger = require("../utils/logger");

const FORMAT = "media-baker-backup";
const VERSION = 1;
const BACKUP_PATTERN = /^media-baker-\d{8}-\d{6}\.mbbackup\.gz$/;
const ROW_BATCH_SIZE = 250;

class BackupService {
  constructor(config, appSettings) {
    this.config = config;
    this.appSettings = appSettings;
    this.timer = null;
    this.inFlight = null;
    this.restoreInFlight = null;
    this.lastScheduledKey = null;
    this.lastResult = null;
    this.progress = null;
    this.readiness = Promise.resolve();
  }

  setReadiness(promise) {
    this.readiness = promise || Promise.resolve();
  }

  start() {
    this.restart();
  }

  restart() {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this.runSchedule(), 30 * 1000);
    this.timer.unref?.();
    this.runSchedule();
  }

  async settings() {
    const settings = await this.appSettings.get();
    return normalizeBackupSettings(settings.backup, this.config);
  }

  async saveSettings(input) {
    const current = await this.appSettings.get();
    const backup = normalizeBackupSettings(input, this.config);
    await fsp.mkdir(backup.directory, { recursive: true });
    await fsp.access(backup.directory, fs.constants.R_OK | fs.constants.W_OK);
    const saved = await this.appSettings.save({ ...current, backup });
    this.restart();
    return saved.backup;
  }

  async status() {
    const settings = await this.settings();
    return {
      settings,
      running: Boolean(this.inFlight),
      restoring: Boolean(this.restoreInFlight),
      progress: this.progress,
      lastResult: this.lastResult,
      backups: await this.list(settings.directory)
    };
  }

  async list(directory = null) {
    const selected = path.resolve(directory || (await this.settings()).directory);
    const entries = await fsp.readdir(selected, { withFileTypes: true }).catch((err) => {
      if (err.code === "ENOENT") return [];
      throw err;
    });
    const backups = [];
    for (const entry of entries) {
      if (!entry.isFile() || !BACKUP_PATTERN.test(entry.name)) continue;
      const stat = await fsp.stat(path.join(selected, entry.name));
      backups.push({
        filename: entry.name,
        size: stat.size,
        createdAt: stat.mtime.toISOString()
      });
    }
    return backups.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async create(reason = "manual") {
    if (this.restoreInFlight) throw new Error("A database restore is currently running");
    if (this.inFlight) return this.inFlight;
    this.progress = backupProgress(reason);
    this.inFlight = this.createBackup(reason).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  startCreate(reason = "manual") {
    if (this.restoreInFlight) throw new Error("A database restore is currently running");
    const started = !this.inFlight;
    this.create(reason).catch(() => {});
    return { started, running: true, progress: this.progress };
  }

  async createBackup(reason) {
    try {
      await this.readiness;
    } catch (err) {
      this.lastResult = { ok: false, reason, error: `Cached image migration must complete before backup: ${err.message}`, createdAt: new Date().toISOString() };
      this.updateProgress({ phase: "failed", error: this.lastResult.error, finishedAt: new Date().toISOString() });
      throw new Error(this.lastResult.error);
    }
    let settings;
    try {
      settings = await this.settings();
      await fsp.mkdir(settings.directory, { recursive: true });
    } catch (err) {
      this.lastResult = { ok: false, reason, error: err.message, createdAt: new Date().toISOString() };
      this.updateProgress({ phase: "failed", error: err.message, finishedAt: new Date().toISOString() });
      throw err;
    }
    const filename = backupFilename(new Date());
    const finalPath = path.join(settings.directory, filename);
    const partialPath = `${finalPath}.partial`;
    logger.info(`[backup] started reason=${reason} destination="${finalPath}"`);
    try {
      this.updateProgress({ phase: "preparing", current: filename });
      const writer = createBackupWriter(partialPath);
      await writer.write({ type: "header", format: FORMAT, version: VERSION, createdAt: new Date().toISOString(), storage: this.config.mysql.enabled ? "mysql" : "json" });
      if (this.config.mysql.enabled) {
        await this.backupMysql(writer);
      } else {
        await this.backupJson(writer);
      }
      this.updateProgress({ phase: "finalizing", completedUnits: this.progress.totalUnits });
      await writer.close();
      await fsp.rename(partialPath, finalPath);
      await this.applyRetention(settings.directory, settings.retentionCount);
      const stat = await fsp.stat(finalPath);
      this.lastResult = { ok: true, reason, filename, createdAt: new Date().toISOString(), size: stat.size };
      this.updateProgress({ phase: "complete", percent: 100, etaSeconds: 0, finishedAt: new Date().toISOString() });
      logger.info(`[backup] complete reason=${reason} filename="${filename}" size=${stat.size}`);
      return this.lastResult;
    } catch (err) {
      await fsp.rm(partialPath, { force: true });
      this.lastResult = { ok: false, reason, error: err.message, createdAt: new Date().toISOString() };
      this.updateProgress({ phase: "failed", error: err.message, finishedAt: new Date().toISOString() });
      logger.error(`[backup] failed reason=${reason} message="${err.message}"`, err);
      throw err;
    }
  }

  async backupMysql(writer) {
    const connection = await mysql.createConnection(mysqlOptions(this.config.mysql));
    try {
      await connection.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      await connection.query("START TRANSACTION WITH CONSISTENT SNAPSHOT");
      const [tableRows] = await connection.query("SHOW FULL TABLES WHERE Table_type = 'BASE TABLE'");
      const tableNames = tableRows.map((row) => Object.values(row)[0]).sort();
      const tables = [];
      for (const table of tableNames) {
        const [rows] = await connection.query(`SHOW CREATE TABLE ${identifier(table)}`);
        const [keyRows] = await connection.query(`SHOW KEYS FROM ${identifier(table)} WHERE Key_name = 'PRIMARY'`);
        const primaryKey = keyRows
          .sort((a, b) => Number(a.Seq_in_index) - Number(b.Seq_in_index))
          .map((row) => row.Column_name);
        const [[countRow]] = await connection.query(`SELECT COUNT(*) AS rowCount FROM ${identifier(table)}`);
        tables.push({ name: table, primaryKey, rowCount: Number(countRow.rowCount) || 0 });
        await writer.write({ type: "table", name: table, createSql: rows[0]["Create Table"] });
      }
      this.updateProgress({
        phase: "exporting",
        completedUnits: 0,
        totalUnits: tables.reduce((total, table) => total + table.rowCount, 0),
        unit: "rows"
      });
      for (const table of tables) {
        this.updateProgress({ current: table.name });
        let offset = 0;
        const order = table.primaryKey.length > 0 ? ` ORDER BY ${table.primaryKey.map(identifier).join(", ")}` : "";
        while (true) {
          const [rows] = await connection.query(`SELECT * FROM ${identifier(table.name)}${order} LIMIT ${ROW_BATCH_SIZE} OFFSET ${offset}`);
          if (rows.length === 0) break;
          await writer.write({ type: "rows", table: table.name, rows });
          offset += rows.length;
          this.updateProgress({ completedUnits: this.progress.completedUnits + rows.length });
          if (rows.length < ROW_BATCH_SIZE) break;
        }
      }
      await connection.commit();
    } catch (err) {
      await connection.rollback().catch(() => {});
      throw err;
    } finally {
      await connection.end();
    }
  }

  async backupJson(writer) {
    const entries = jsonDataFiles(this.config);
    const sizes = new Map();
    for (const entry of entries) {
      const stat = await fsp.stat(entry.path).catch((err) => {
        if (err.code === "ENOENT") return null;
        throw err;
      });
      sizes.set(entry.name, stat ? stat.size : 0);
    }
    this.updateProgress({
      phase: "exporting",
      completedUnits: 0,
      totalUnits: [...sizes.values()].reduce((total, size) => total + size, 0),
      unit: "bytes"
    });
    for (const entry of entries) {
      this.updateProgress({ current: entry.name });
      let content = null;
      try {
        content = await fsp.readFile(entry.path, "utf8");
      } catch (err) {
        if (err.code !== "ENOENT") throw err;
      }
      await writer.write({ type: "file", name: entry.name, content });
      this.updateProgress({ completedUnits: this.progress.completedUnits + (sizes.get(entry.name) || 0) });
    }
  }

  updateProgress(changes) {
    if (!this.progress) return;
    this.progress = { ...this.progress, ...changes, updatedAt: new Date().toISOString() };
    if (Object.prototype.hasOwnProperty.call(changes, "percent")) return;
    const total = Number(this.progress.totalUnits) || 0;
    const completed = Math.max(0, Number(this.progress.completedUnits) || 0);
    const elapsedSeconds = Math.max(0, (Date.now() - Date.parse(this.progress.startedAt)) / 1000);
    const rate = elapsedSeconds > 0 ? completed / elapsedSeconds : 0;
    this.progress.percent = total > 0 ? Math.min(99, Math.round(completed / total * 1000) / 10) : 0;
    this.progress.etaSeconds = rate > 0 && total > completed ? Math.ceil((total - completed) / rate) : null;
    this.progress.elapsedSeconds = Math.floor(elapsedSeconds);
  }

  async restore(filename) {
    if (this.inFlight) throw new Error("A database backup is currently running");
    if (this.restoreInFlight) return this.restoreInFlight;
    this.restoreInFlight = this.restoreBackup(filename).finally(() => {
      this.restoreInFlight = null;
    });
    return this.restoreInFlight;
  }

  async restoreBackup(filename) {
    const settings = await this.settings();
    const safeName = path.basename(String(filename || ""));
    if (safeName !== filename || !BACKUP_PATTERN.test(safeName)) {
      throw new Error("Invalid backup filename");
    }
    const backupPath = path.join(settings.directory, safeName);
    logger.info(`[backup] restore started filename="${safeName}"`);
    const storage = this.config.mysql.enabled ? "mysql" : "json";
    let mysqlConnection = null;
    const jsonEntries = new Map();
    try {
      const inspection = await inspectBackup(backupPath, storage, this.config);
      if (this.config.mysql.enabled) {
        mysqlConnection = await mysql.createConnection(mysqlOptions(this.config.mysql));
        await replaceMysqlSchema(mysqlConnection, inspection.schemas);
      }
      for await (const record of backupRecords(backupPath)) {
        if (record.type === "rows") {
          await insertRows(mysqlConnection, record.table, record.rows);
          continue;
        }
        if (record.type === "file") {
          jsonEntries.set(record.name, record.content);
        }
      }
      if (this.config.mysql.enabled) {
        await mysqlConnection.query("SET FOREIGN_KEY_CHECKS = 1");
      } else {
        await restoreJsonFiles(this.config, jsonEntries);
      }
      this.lastResult = { ok: true, reason: "restore", filename: safeName, restoredAt: new Date().toISOString() };
      logger.info(`[backup] restore complete filename="${safeName}"`);
      return this.lastResult;
    } catch (err) {
      this.lastResult = { ok: false, reason: "restore", filename: safeName, error: err.message, restoredAt: new Date().toISOString() };
      logger.error(`[backup] restore failed filename="${safeName}" message="${err.message}"`, err);
      throw err;
    } finally {
      if (mysqlConnection) await mysqlConnection.end();
    }
  }

  async applyRetention(directory, retentionCount) {
    const backups = await this.list(directory);
    await Promise.all(backups.slice(retentionCount).map((backup) => fsp.rm(path.join(directory, backup.filename), { force: true })));
  }

  async runSchedule() {
    const settings = await this.settings().catch((err) => {
      logger.error(`[backup] schedule settings failed message="${err.message}"`, err);
      return null;
    });
    if (!settings || !settings.enabled || this.inFlight || this.restoreInFlight) return;
    const now = new Date();
    const [hour, minute] = settings.time.split(":").map(Number);
    if (!settings.days.includes(now.getDay()) || now.getHours() !== hour || now.getMinutes() !== minute) return;
    const key = `${localDateKey(now)}:${settings.time}`;
    if (this.lastScheduledKey === key) return;
    this.lastScheduledKey = key;
    this.create("scheduled").catch(() => {});
  }
}

function createBackupWriter(filePath) {
  const output = fs.createWriteStream(filePath);
  const gzip = zlib.createGzip({ level: 6 });
  gzip.pipe(output);
  return {
    async write(record) {
      if (!gzip.write(`${JSON.stringify(record)}\n`)) await once(gzip, "drain");
    },
    async close() {
      gzip.end();
      await finished(output);
    }
  };
}

async function inspectBackup(filePath, storage, config) {
  let header = null;
  let dataStarted = false;
  const schemas = [];
  const schemaNames = new Set();
  const fileNames = new Set();
  for await (const record of backupRecords(filePath)) {
    if (!header) {
      validateHeader(record, storage);
      header = record;
      continue;
    }
    if (record.type === "table") {
      if (dataStarted || storage !== "mysql" || !record.name || !record.createSql) {
        throw new Error("Invalid backup table schema order");
      }
      if (schemaNames.has(record.name)) throw new Error(`Duplicate backup table schema: ${record.name}`);
      schemaNames.add(record.name);
      schemas.push(record);
      continue;
    }
    if (record.type === "rows") {
      if (storage !== "mysql" || !record.table || !schemaNames.has(record.table) || !Array.isArray(record.rows)) {
        throw new Error("Invalid MySQL backup row record");
      }
      dataStarted = true;
      continue;
    }
    if (record.type === "file") {
      if (storage !== "json" || !record.name || !(record.content === null || typeof record.content === "string")) {
        throw new Error("Invalid JSON backup file record");
      }
      if (fileNames.has(record.name)) throw new Error(`Duplicate JSON backup entry: ${record.name}`);
      fileNames.add(record.name);
      dataStarted = true;
      continue;
    }
    throw new Error(`Unknown backup record type: ${record.type}`);
  }
  if (!header) throw new Error("Invalid or empty backup");
  if (storage === "mysql" && schemas.length === 0) throw new Error("MySQL backup contains no table schemas");
  if (storage === "json") {
    const missing = jsonDataFiles(config).map((entry) => entry.name).filter((name) => !fileNames.has(name));
    if (missing.length > 0) throw new Error(`JSON backup is missing entries: ${missing.join(", ")}`);
  }
  return { header, schemas };
}

async function* backupRecords(filePath) {
  const reader = readline.createInterface({
    input: fs.createReadStream(filePath).pipe(zlib.createGunzip()),
    crlfDelay: Infinity
  });
  try {
    for await (const line of reader) {
      if (line.trim()) yield JSON.parse(line);
    }
  } finally {
    reader.close();
  }
}

async function replaceMysqlSchema(connection, schemas) {
  await connection.query("SET FOREIGN_KEY_CHECKS = 0");
  const [rows] = await connection.query("SHOW FULL TABLES WHERE Table_type = 'BASE TABLE'");
  for (const row of rows) {
    await connection.query(`DROP TABLE IF EXISTS ${identifier(Object.values(row)[0])}`);
  }
  for (const schema of schemas) {
    await connection.query(schema.createSql);
  }
}

async function insertRows(connection, table, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return;
  const columns = Object.keys(rows[0]);
  const values = rows.map((row) => columns.map((column) => reviveValue(row[column])));
  await connection.query(
    `INSERT INTO ${identifier(table)} (${columns.map(identifier).join(", ")}) VALUES ?`,
    [values]
  );
}

function reviveValue(value) {
  if (value && value.type === "Buffer" && Array.isArray(value.data)) return Buffer.from(value.data);
  return value;
}

async function restoreJsonFiles(config, entries) {
  const files = jsonDataFiles(config);
  for (const file of files) {
    await fsp.rm(file.path, { force: true });
  }
  for (const file of files) {
    const content = entries.get(file.name);
    if (content === null || content === undefined) continue;
    await fsp.mkdir(path.dirname(file.path), { recursive: true });
    await fsp.writeFile(file.path, content);
  }
}

function jsonDataFiles(config) {
  return [
    { name: "accounts", path: config.accountStorePath },
    { name: "libraries", path: config.libraryStorePath },
    { name: "settings", path: config.settingsStorePath },
    { name: "media-index", path: config.indexPath },
    { name: "metadata", path: path.join(config.metadata.cachePath, "metadata.json") },
    { name: "playback-progress", path: config.playback.progressPath }
  ];
}

function validateHeader(record, storage) {
  if (!record || record.type !== "header" || record.format !== FORMAT || record.version !== VERSION) {
    throw new Error("Unsupported backup format");
  }
  if (record.storage !== storage) {
    throw new Error(`Backup storage type ${record.storage} cannot be restored into ${storage}`);
  }
}

function mysqlOptions(config) {
  return {
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    dateStrings: true,
    multipleStatements: false
  };
}

function identifier(value) {
  return `\`${String(value).replace(/`/g, "``")}\``;
}

function normalizeBackupSettings(input, config) {
  const value = input || {};
  const defaultDirectory = path.join(path.dirname(config.settingsStorePath), "backups");
  const selectedTime = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value.time || "")) ? String(value.time) : "03:00";
  const days = [...new Set((Array.isArray(value.days) ? value.days : [0, 1, 2, 3, 4, 5, 6])
    .map(Number)
    .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))];
  return {
    enabled: Boolean(value.enabled),
    directory: path.resolve(String(value.directory || defaultDirectory)),
    time: selectedTime,
    days: days.length > 0 ? days : [0, 1, 2, 3, 4, 5, 6],
    retentionCount: Math.max(1, Math.min(Number.parseInt(value.retentionCount, 10) || 7, 365))
  };
}

function backupFilename(date) {
  const stamp = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("") + "-" + [
    String(date.getHours()).padStart(2, "0"),
    String(date.getMinutes()).padStart(2, "0"),
    String(date.getSeconds()).padStart(2, "0")
  ].join("");
  return `media-baker-${stamp}.mbbackup.gz`;
}

function backupProgress(reason) {
  const startedAt = new Date().toISOString();
  return {
    reason,
    phase: "queued",
    current: null,
    unit: null,
    completedUnits: 0,
    totalUnits: 0,
    percent: 0,
    elapsedSeconds: 0,
    etaSeconds: null,
    startedAt,
    updatedAt: startedAt
  };
}

function localDateKey(date) {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

module.exports = { BackupService, normalizeBackupSettings };
