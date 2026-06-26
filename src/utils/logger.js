const fs = require("fs");
const path = require("path");

const LEVELS = {
  errors: 0,
  error: 0,
  info: 1,
  full: 2
};

let currentLevel = LEVELS.info;
let logDirectory = null;
let retentionDays = 5;
let currentLogDate = null;
const entries = [];
const MAX_ENTRIES = 500;
const DAY_MS = 24 * 60 * 60 * 1000;

function configure(options) {
  const settings = typeof options === "object" && options !== null ? options : { level: options };
  currentLevel = levelValue(settings.level);
  logDirectory = settings.path || settings.directory || settings.logPath || logDirectory;
  retentionDays = positiveInt(settings.retentionDays, retentionDays || 5);

  if (logDirectory) {
    try {
      fs.mkdirSync(logDirectory, { recursive: true });
      cleanupOldLogs();
    } catch (err) {
      console.error(`[logger] file logging disabled path="${logDirectory}" error="${err.message}"`);
      logDirectory = null;
    }
  }
}

function error(message, err) {
  pushEntry("error", message);
  console.error(message);
  if (err && err.stack && currentLevel >= LEVELS.full) {
    console.error(err.stack);
  }
  writeFileEntry("error", message, err);
}

function info(message) {
  pushEntry("info", message);
  if (currentLevel >= LEVELS.info) {
    console.log(message);
    writeFileEntry("info", message);
  }
}

function full(message) {
  pushEntry("full", message);
  if (currentLevel >= LEVELS.full) {
    console.log(message);
    writeFileEntry("full", message);
  }
}

function recent(limit = 200) {
  const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 200, MAX_ENTRIES));
  return entries.slice(-safeLimit);
}

function pushEntry(level, message) {
  entries.push({
    at: new Date().toISOString(),
    level,
    message: String(message || "")
  });
  if (entries.length > MAX_ENTRIES) {
    entries.splice(0, entries.length - MAX_ENTRIES);
  }
}

function levelValue(level) {
  const key = String(level || "info").toLowerCase();
  return Object.prototype.hasOwnProperty.call(LEVELS, key) ? LEVELS[key] : LEVELS.info;
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function writeFileEntry(level, message, err) {
  if (!logDirectory) {
    return;
  }

  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  if (date !== currentLogDate) {
    currentLogDate = date;
    try {
      cleanupOldLogs();
    } catch (err) {
      console.error(`[logger] failed to clean log files path="${logDirectory}" error="${err.message}"`);
      logDirectory = null;
      return;
    }
  }

  const lines = [`[${now.toISOString()}] ${level}: ${String(message || "")}`];
  if (err && err.stack && currentLevel >= LEVELS.full) {
    lines.push(err.stack);
  }

  try {
    fs.appendFileSync(path.join(logDirectory, `${date}.log`), `${lines.join("\n")}\n`);
  } catch (err) {
    console.error(`[logger] failed to write log file path="${logDirectory}" error="${err.message}"`);
    logDirectory = null;
  }
}

function cleanupOldLogs() {
  if (!logDirectory) {
    return;
  }

  const now = new Date();
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const cutoff = todayUtc - (retentionDays - 1) * DAY_MS;

  fs.readdirSync(logDirectory, { withFileTypes: true }).forEach((entry) => {
    if (!entry.isFile() || !/^\d{4}-\d{2}-\d{2}\.log$/.test(entry.name)) {
      return;
    }

    const logTime = Date.parse(`${entry.name.slice(0, 10)}T00:00:00.000Z`);
    if (Number.isFinite(logTime) && logTime < cutoff) {
      fs.unlinkSync(path.join(logDirectory, entry.name));
    }
  });
}

module.exports = {
  configure,
  error,
  info,
  full,
  recent
};
