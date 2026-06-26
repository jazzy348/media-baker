const fs = require("fs");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");
const dockerMode = process.env.MEDIA_BAKER_DOCKER === "1";
const configFilePath = dockerMode ? "/config/config.json" : path.join(rootDir, "config.json");

function intValue(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolvePath(value, fallback) {
  const selected = value || fallback;
  return isAbsolutePath(selected) ? selected : path.resolve(rootDir, selected);
}

function loadConfigFile() {
  try {
    return JSON.parse(fs.readFileSync(configFilePath, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") {
      throw new Error(`Missing config file: ${configFilePath}. Copy config.example.json to config.json, then create the first admin account from the WebUI.`);
    }

    throw err;
  }
}

const fileConfig = loadConfigFile();
const mysqlConfig = normalizeMysqlConfig(fileConfig.mysql);
const seedLibraries = normalizeLibraries(fileConfig.libraries);

module.exports = {
  port: intValue(fileConfig.port, 3000),
  auth: {
    playbackSecretPath: appPath(fileConfig.auth && fileConfig.auth.playbackSecretPath, "cache/playback-secret.json")
  },
  libraries: seedLibraries,
  libraryStorePath: appPath(fileConfig.libraryStorePath, "cache/libraries.json"),
  accountStorePath: appPath(fileConfig.accountStorePath, "cache/accounts.json"),
  settingsStorePath: appPath(fileConfig.settingsStorePath, "cache/settings.json"),
  indexPath: appPath(fileConfig.indexPath, "cache/media-index.json"),
  logging: {
    level: normalizeLogLevel(fileConfig.logging && fileConfig.logging.level || fileConfig.logLevel),
    path: appPath(fileConfig.logging && fileConfig.logging.path, "cache/logs", "/logs"),
    retentionDays: intValue(fileConfig.logging && fileConfig.logging.retentionDays, 5)
  },
  indexScan: {
    enabled: !fileConfig.indexScan || fileConfig.indexScan.enabled !== false,
    intervalSeconds: intValue(fileConfig.indexScan && fileConfig.indexScan.intervalSeconds, 15 * 60),
    runOnStartup: fileConfig.indexScan && typeof fileConfig.indexScan.runOnStartup === "boolean" ? fileConfig.indexScan.runOnStartup : false
  },
  mysql: mysqlConfig,
  metadata: {
    enabled: fileConfig.metadata && typeof fileConfig.metadata.enabled === "boolean" ? fileConfig.metadata.enabled : false,
    provider: fileConfig.metadata && fileConfig.metadata.provider || "tmdb",
    tmdbApiKey: fileConfig.metadata && fileConfig.metadata.tmdbApiKey || "",
    tmdbReadAccessToken: fileConfig.metadata && fileConfig.metadata.tmdbReadAccessToken || "",
    language: fileConfig.metadata && fileConfig.metadata.language || "en-US",
    posterSize: fileConfig.metadata && fileConfig.metadata.posterSize || "w500",
    thumbnailSize: fileConfig.metadata && fileConfig.metadata.thumbnailSize || "w300",
    posterLanguages: listValue(fileConfig.metadata && fileConfig.metadata.posterLanguages, ["en", "null", "ja"]),
    cachePath: appPath(fileConfig.metadata && fileConfig.metadata.cachePath, "cache/metadata"),
    preloadOnStartup: fileConfig.metadata && typeof fileConfig.metadata.preloadOnStartup === "boolean" ? fileConfig.metadata.preloadOnStartup : true,
    requestDelayMs: intValue(fileConfig.metadata && fileConfig.metadata.requestDelayMs, 250)
  },
  subtitles: {
    enabled: fileConfig.subtitles && typeof fileConfig.subtitles.enabled === "boolean" ? fileConfig.subtitles.enabled : false,
    provider: fileConfig.subtitles && fileConfig.subtitles.provider || "subdl",
    subdlApiKey: fileConfig.subtitles && fileConfig.subtitles.subdlApiKey || "",
    userAgent: fileConfig.subtitles && fileConfig.subtitles.userAgent || "MediaBaker v1.0",
    defaultLanguage: fileConfig.subtitles && fileConfig.subtitles.defaultLanguage || "en",
    cachePath: appPath(fileConfig.subtitles && fileConfig.subtitles.cachePath, "cache/subtitles"),
    sync: {
      enabled: !fileConfig.subtitles || !fileConfig.subtitles.sync || fileConfig.subtitles.sync.enabled !== false,
      ffsubsyncPath: ffsubsyncExecutable(),
      maxOffsetSeconds: intValue(fileConfig.subtitles && fileConfig.subtitles.sync && fileConfig.subtitles.sync.maxOffsetSeconds, 900),
      timeoutSeconds: intValue(fileConfig.subtitles && fileConfig.subtitles.sync && fileConfig.subtitles.sync.timeoutSeconds, 900)
    }
  },
  playback: {
    progressPath: appPath(fileConfig.playback && fileConfig.playback.progressPath, "cache/playback-progress.json"),
    onDeckTtlSeconds: intValue(fileConfig.playback && fileConfig.playback.onDeckTtlSeconds, 14 * 24 * 60 * 60),
    watchedThresholdPercent: intValue(fileConfig.playback && fileConfig.playback.watchedThresholdPercent, 10)
  },
  hls: {
    cachePath: appPath(fileConfig.hls && fileConfig.hls.cachePath, "cache/hls"),
    ttlSeconds: intValue(fileConfig.hls && fileConfig.hls.ttlSeconds, 24 * 60 * 60),
    segmentSeconds: intValue(fileConfig.hls && fileConfig.hls.segmentSeconds, 6),
    segmentWaitTimeoutSeconds: intValue(fileConfig.hls && fileConfig.hls.segmentWaitTimeoutSeconds, 90),
    forceTranscodeCompatibleVideo: fileConfig.hls && typeof fileConfig.hls.forceTranscodeCompatibleVideo === "boolean" ? fileConfig.hls.forceTranscodeCompatibleVideo : false
  },
  fallbackStream: {
    enabled: !fileConfig.fallbackStream || fileConfig.fallbackStream.enabled !== false,
    sourcePath: appPath(fileConfig.fallbackStream && fileConfig.fallbackStream.sourcePath, "fallback/404.mp4", "/fallback/404.mp4"),
    cachePath: appPath(fileConfig.fallbackStream && fileConfig.fallbackStream.cachePath, "cache/fallback-hls"),
    segmentSeconds: intValue(fileConfig.fallbackStream && fileConfig.fallbackStream.segmentSeconds, 4)
  },
  ffmpeg: {
    ffmpegPath: appExecutable(fileConfig.ffmpeg && fileConfig.ffmpeg.ffmpegPath || defaultExecutable("ffmpeg"), "ffmpeg"),
    ffprobePath: appExecutable(fileConfig.ffmpeg && fileConfig.ffmpeg.ffprobePath || defaultExecutable("ffprobe"), "ffprobe"),
    enableGpu: fileConfig.ffmpeg && typeof fileConfig.ffmpeg.enableGpu === "boolean" ? fileConfig.ffmpeg.enableGpu : true
  },
  streaming: {
    preferredAudioLanguage: fileConfig.streaming && fileConfig.streaming.preferredAudioLanguage || "english"
  }
};

function appPath(value, fallback, dockerPath = null) {
  if (dockerMode) {
    return dockerPath || resolveDockerCachePath(fallback);
  }

  return resolvePath(value, fallback);
}

function appExecutable(value, dockerExecutable) {
  return dockerMode ? dockerExecutable : resolveExecutablePath(value);
}

function ffsubsyncExecutable() {
  if (dockerMode || process.platform !== "win32") {
    return "ffsubsync";
  }

  return path.join(rootDir, "bin", "ffsubsync.exe");
}

function defaultExecutable(name) {
  if (dockerMode || process.platform !== "win32") {
    return name;
  }

  return path.join(rootDir, "bin", `${name}.exe`);
}

function resolveDockerCachePath(fallback) {
  const relative = String(fallback || "").replace(/\\/g, "/");
  if (relative === "cache" || relative.startsWith("cache/")) {
    return path.posix.join("/cache", relative.slice("cache".length));
  }

  return path.posix.join("/cache", relative);
}

function resolveExecutablePath(value) {
  if (!value || !/[\\/]/.test(value)) {
    return value;
  }

  return resolvePath(value, value);
}

function isAbsolutePath(value) {
  const text = String(value || "");
  return path.isAbsolute(text) || /^[A-Za-z]:[\\/]/.test(text) || /^\\\\/.test(text);
}

function listValue(value, fallback) {
  if (Array.isArray(value)) {
    const items = value.map((item) => String(item).trim()).filter(Boolean);
    return items.length > 0 ? items : fallback;
  }

  if (typeof value === "string") {
    const items = value.split(",").map((item) => item.trim()).filter(Boolean);
    return items.length > 0 ? items : fallback;
  }

  return fallback;
}

function normalizeMysqlConfig(value) {
  if (value === false || value === undefined || value === null) {
    return {
      enabled: false,
      host: "localhost",
      port: 3306,
      user: "media_baker",
      password: "",
      database: "media_baker",
      connectionLimit: 5
    };
  }

  if (value === true) {
    return {
      enabled: true,
      host: "localhost",
      port: 3306,
      user: "media_baker",
      password: "",
      database: "media_baker",
      connectionLimit: 5
    };
  }

  return {
    enabled: value.enabled !== false,
    host: value.host || "localhost",
    port: intValue(value.port, 3306),
    user: value.user || "media_baker",
    password: value.password || "",
    database: value.database || "media_baker",
    connectionLimit: intValue(value.connectionLimit, 5)
  };
}

function normalizeLogLevel(value) {
  const level = String(value || "info").toLowerCase();
  return ["errors", "error", "info", "full"].includes(level) ? level : "info";
}

function normalizeLibraries(value) {
  const rawLibraries = Array.isArray(value)
    ? value
    : legacyLibraries(value);

  const seen = new Set();
  return rawLibraries.map((library, index) => {
    const rawType = String(library.type || "").trim();
    const type = normalizeLibraryType(rawType);
    const key = slugValue(library.key || library.slug || library.id || library.title || library.name || `library-${index + 1}`);
    if (!key) {
      throw new Error(`Library at index ${index} must have a key or title.`);
    }
    if (seen.has(key)) {
      throw new Error(`Duplicate library key: ${key}`);
    }
    seen.add(key);

    if (!library.path) {
      throw new Error(`Library ${key} must define path.`);
    }

    return {
      key,
      title: String(library.title || library.name || key).trim(),
      type,
      rawType,
      threeD: isThreeDLibrary({ ...library, key, type, rawType }),
      path: resolvePath(library.path, library.path)
    };
  });
}

function legacyLibraries(value) {
  if (!value || typeof value !== "object") {
    return [];
  }

  const selected = value || {};
  return [
    { key: "tv", title: "TV Shows", type: "tv", path: selected.tv },
    { key: "movies", title: "Movies", type: "movies", path: selected.movies },
    { key: "anime-tv", title: "Anime TV", type: "tv", path: selected.animeTv },
    { key: "anime-movies", title: "Anime Movies", type: "movies", path: selected.animeMovies }
  ].filter((library) => library.path);
}

function normalizeLibraryType(value) {
  const type = String(value || "").toLowerCase();
  if (["tv", "show", "shows", "series", "episodes"].includes(type)) {
    return "tv";
  }
  if (["movie", "movies", "film", "films"].includes(type)) {
    return "movies";
  }
  if (/\b3d\b/i.test(type) && /\b(tv|show|shows|series|episodes)\b/i.test(type)) {
    return "tv";
  }
  if (/\b3d\b/i.test(type) && /\b(movie|movies|film|films)\b/i.test(type)) {
    return "movies";
  }

  throw new Error(`Unsupported library type: ${value}. Use "tv" or "movies".`);
}

function isThreeDLibrary(library) {
  return /\b3d\b/i.test([
    library.key,
    library.title,
    library.name,
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
