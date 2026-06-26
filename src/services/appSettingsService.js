const fs = require("fs/promises");
const path = require("path");
const mysql = require("mysql2/promise");

const SETTINGS_KEY = "runtime";
const VALID_LOG_LEVELS = new Set(["errors", "error", "info", "full"]);

const DEFAULT_RUNTIME_SETTINGS = {
  logging: {
    level: "info",
    retentionDays: 5
  },
  indexScan: {
    enabled: true,
    intervalSeconds: 15 * 60,
    runOnStartup: false
  },
  metadata: {
    enabled: false,
    provider: "tmdb",
    tmdbApiKey: "",
    tmdbReadAccessToken: "",
    language: "en-US",
    posterSize: "w500",
    thumbnailSize: "w300",
    posterLanguages: ["en", "null", "ja"],
    preloadOnStartup: true,
    requestDelayMs: 250
  },
  subtitles: {
    enabled: false,
    provider: "subdl",
    subdlApiKey: "",
    userAgent: "MediaBaker v1.0",
    defaultLanguage: "en",
    sync: {
      enabled: true,
      maxOffsetSeconds: 900,
      timeoutSeconds: 900
    }
  },
  playback: {
    onDeckTtlSeconds: 14 * 24 * 60 * 60,
    watchedThresholdPercent: 10
  },
  hls: {
    ttlSeconds: 24 * 60 * 60,
    segmentSeconds: 6,
    segmentWaitTimeoutSeconds: 90,
    forceTranscodeCompatibleVideo: false
  },
  fallbackStream: {
    enabled: true,
    segmentSeconds: 4
  },
  ffmpeg: {
    enableGpu: true
  },
  streaming: {
    preferredAudioLanguage: "english"
  }
};

class AppSettingsService {
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
        CREATE TABLE IF NOT EXISTS app_settings (
          settings_key VARCHAR(64) NOT NULL PRIMARY KEY,
          settings_json MEDIUMTEXT NOT NULL,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )
      `);
    }

    this.initialized = true;
  }

  async get() {
    await this.init();
    const stored = await this.read();
    const base = runtimeSettingsFromConfig(this.config);
    return normalizeRuntimeSettings(stored ? deepMerge(base, stored) : base);
  }

  async save(input) {
    await this.init();
    const settings = normalizeRuntimeSettings(input);
    await this.write(settings);
    applyRuntimeSettings(this.config, settings);
    return settings;
  }

  async applyToConfig() {
    await this.init();
    const stored = await this.read();
    const base = runtimeSettingsFromConfig(this.config);
    const settings = normalizeRuntimeSettings(stored ? deepMerge(base, stored) : base);
    if (!stored) {
      await this.write(settings);
    }
    applyRuntimeSettings(this.config, settings);
    return settings;
  }

  async write(settings) {
    if (this.config.mysql.enabled) {
      await this.pool.execute(
        `INSERT INTO app_settings (settings_key, settings_json)
         VALUES (?, ?)
         ON DUPLICATE KEY UPDATE settings_json = VALUES(settings_json)`,
        [SETTINGS_KEY, JSON.stringify(settings)]
      );
    } else {
      await fs.mkdir(path.dirname(this.config.settingsStorePath), { recursive: true });
      await fs.writeFile(this.config.settingsStorePath, JSON.stringify(settings, null, 2));
    }
  }

  async read() {
    if (this.config.mysql.enabled) {
      const [rows] = await this.pool.execute(
        "SELECT settings_json FROM app_settings WHERE settings_key = ?",
        [SETTINGS_KEY]
      );
      return rows[0] ? parseJson(rows[0].settings_json, null) : null;
    }

    try {
      return JSON.parse(await fs.readFile(this.config.settingsStorePath, "utf8"));
    } catch (err) {
      if (err.code === "ENOENT") {
        return null;
      }
      throw err;
    }
  }
}

function runtimeSettingsFromConfig(config) {
  return {
    logging: {
      level: config.logging && config.logging.level,
      retentionDays: config.logging && config.logging.retentionDays
    },
    indexScan: {
      enabled: config.indexScan && config.indexScan.enabled,
      intervalSeconds: config.indexScan && config.indexScan.intervalSeconds,
      runOnStartup: config.indexScan && config.indexScan.runOnStartup
    },
    metadata: {
      enabled: config.metadata && config.metadata.enabled,
      provider: config.metadata && config.metadata.provider,
      tmdbApiKey: config.metadata && config.metadata.tmdbApiKey,
      tmdbReadAccessToken: config.metadata && config.metadata.tmdbReadAccessToken,
      language: config.metadata && config.metadata.language,
      posterSize: config.metadata && config.metadata.posterSize,
      thumbnailSize: config.metadata && config.metadata.thumbnailSize,
      posterLanguages: config.metadata && config.metadata.posterLanguages,
      preloadOnStartup: config.metadata && config.metadata.preloadOnStartup,
      requestDelayMs: config.metadata && config.metadata.requestDelayMs
    },
    subtitles: {
      enabled: config.subtitles && config.subtitles.enabled,
      provider: config.subtitles && config.subtitles.provider,
      subdlApiKey: config.subtitles && config.subtitles.subdlApiKey,
      userAgent: config.subtitles && config.subtitles.userAgent,
      defaultLanguage: config.subtitles && config.subtitles.defaultLanguage,
      sync: {
        enabled: config.subtitles && config.subtitles.sync && config.subtitles.sync.enabled,
        maxOffsetSeconds: config.subtitles && config.subtitles.sync && config.subtitles.sync.maxOffsetSeconds,
        timeoutSeconds: config.subtitles && config.subtitles.sync && config.subtitles.sync.timeoutSeconds
      }
    },
    playback: {
      onDeckTtlSeconds: config.playback && config.playback.onDeckTtlSeconds,
      watchedThresholdPercent: config.playback && config.playback.watchedThresholdPercent
    },
    hls: {
      ttlSeconds: config.hls && config.hls.ttlSeconds,
      segmentSeconds: config.hls && config.hls.segmentSeconds,
      segmentWaitTimeoutSeconds: config.hls && config.hls.segmentWaitTimeoutSeconds,
      forceTranscodeCompatibleVideo: config.hls && config.hls.forceTranscodeCompatibleVideo
    },
    fallbackStream: {
      enabled: config.fallbackStream && config.fallbackStream.enabled,
      segmentSeconds: config.fallbackStream && config.fallbackStream.segmentSeconds
    },
    ffmpeg: {
      enableGpu: config.ffmpeg && config.ffmpeg.enableGpu
    },
    streaming: {
      preferredAudioLanguage: config.streaming && config.streaming.preferredAudioLanguage
    }
  };
}

function applyRuntimeSettings(config, settings) {
  const normalized = normalizeRuntimeSettings(settings);
  config.logging.level = normalized.logging.level;
  config.logging.retentionDays = normalized.logging.retentionDays;
  Object.assign(config.indexScan, normalized.indexScan);
  Object.assign(config.metadata, normalized.metadata);
  const ffsubsyncPath = config.subtitles.sync && config.subtitles.sync.ffsubsyncPath;
  Object.assign(config.subtitles, normalized.subtitles);
  Object.assign(config.subtitles.sync, normalized.subtitles.sync);
  if (ffsubsyncPath) {
    config.subtitles.sync.ffsubsyncPath = ffsubsyncPath;
  }
  Object.assign(config.playback, normalized.playback);
  Object.assign(config.hls, normalized.hls);
  Object.assign(config.fallbackStream, normalized.fallbackStream);
  config.ffmpeg.enableGpu = normalized.ffmpeg.enableGpu;
  config.streaming.preferredAudioLanguage = normalized.streaming.preferredAudioLanguage;
  return config;
}

function normalizeRuntimeSettings(input = {}) {
  const merged = deepMerge(DEFAULT_RUNTIME_SETTINGS, input || {});
  return {
    logging: {
      level: normalizeLogLevel(merged.logging.level),
      retentionDays: intValue(merged.logging.retentionDays, DEFAULT_RUNTIME_SETTINGS.logging.retentionDays)
    },
    indexScan: {
      enabled: boolValue(merged.indexScan.enabled, DEFAULT_RUNTIME_SETTINGS.indexScan.enabled),
      intervalSeconds: intValue(merged.indexScan.intervalSeconds, DEFAULT_RUNTIME_SETTINGS.indexScan.intervalSeconds),
      runOnStartup: boolValue(merged.indexScan.runOnStartup, DEFAULT_RUNTIME_SETTINGS.indexScan.runOnStartup)
    },
    metadata: {
      enabled: boolValue(merged.metadata.enabled, DEFAULT_RUNTIME_SETTINGS.metadata.enabled),
      provider: stringValue(merged.metadata.provider, DEFAULT_RUNTIME_SETTINGS.metadata.provider),
      tmdbApiKey: stringValue(merged.metadata.tmdbApiKey, ""),
      tmdbReadAccessToken: stringValue(merged.metadata.tmdbReadAccessToken, ""),
      language: stringValue(merged.metadata.language, DEFAULT_RUNTIME_SETTINGS.metadata.language),
      posterSize: stringValue(merged.metadata.posterSize, DEFAULT_RUNTIME_SETTINGS.metadata.posterSize),
      thumbnailSize: stringValue(merged.metadata.thumbnailSize, DEFAULT_RUNTIME_SETTINGS.metadata.thumbnailSize),
      posterLanguages: listValue(merged.metadata.posterLanguages, DEFAULT_RUNTIME_SETTINGS.metadata.posterLanguages),
      preloadOnStartup: boolValue(merged.metadata.preloadOnStartup, DEFAULT_RUNTIME_SETTINGS.metadata.preloadOnStartup),
      requestDelayMs: intValue(merged.metadata.requestDelayMs, DEFAULT_RUNTIME_SETTINGS.metadata.requestDelayMs, 0)
    },
    subtitles: {
      enabled: boolValue(merged.subtitles.enabled, DEFAULT_RUNTIME_SETTINGS.subtitles.enabled),
      provider: stringValue(merged.subtitles.provider, DEFAULT_RUNTIME_SETTINGS.subtitles.provider),
      subdlApiKey: stringValue(merged.subtitles.subdlApiKey, ""),
      userAgent: stringValue(merged.subtitles.userAgent, DEFAULT_RUNTIME_SETTINGS.subtitles.userAgent),
      defaultLanguage: stringValue(merged.subtitles.defaultLanguage, DEFAULT_RUNTIME_SETTINGS.subtitles.defaultLanguage),
      sync: {
        enabled: boolValue(merged.subtitles.sync.enabled, DEFAULT_RUNTIME_SETTINGS.subtitles.sync.enabled),
        maxOffsetSeconds: intValue(merged.subtitles.sync.maxOffsetSeconds, DEFAULT_RUNTIME_SETTINGS.subtitles.sync.maxOffsetSeconds),
        timeoutSeconds: intValue(merged.subtitles.sync.timeoutSeconds, DEFAULT_RUNTIME_SETTINGS.subtitles.sync.timeoutSeconds)
      }
    },
    playback: {
      onDeckTtlSeconds: intValue(merged.playback.onDeckTtlSeconds, DEFAULT_RUNTIME_SETTINGS.playback.onDeckTtlSeconds),
      watchedThresholdPercent: intValue(merged.playback.watchedThresholdPercent, DEFAULT_RUNTIME_SETTINGS.playback.watchedThresholdPercent, 1)
    },
    hls: {
      ttlSeconds: intValue(merged.hls.ttlSeconds, DEFAULT_RUNTIME_SETTINGS.hls.ttlSeconds),
      segmentSeconds: intValue(merged.hls.segmentSeconds, DEFAULT_RUNTIME_SETTINGS.hls.segmentSeconds),
      segmentWaitTimeoutSeconds: intValue(merged.hls.segmentWaitTimeoutSeconds, DEFAULT_RUNTIME_SETTINGS.hls.segmentWaitTimeoutSeconds),
      forceTranscodeCompatibleVideo: boolValue(merged.hls.forceTranscodeCompatibleVideo, DEFAULT_RUNTIME_SETTINGS.hls.forceTranscodeCompatibleVideo)
    },
    fallbackStream: {
      enabled: boolValue(merged.fallbackStream.enabled, DEFAULT_RUNTIME_SETTINGS.fallbackStream.enabled),
      segmentSeconds: intValue(merged.fallbackStream.segmentSeconds, DEFAULT_RUNTIME_SETTINGS.fallbackStream.segmentSeconds)
    },
    ffmpeg: {
      enableGpu: boolValue(merged.ffmpeg.enableGpu, DEFAULT_RUNTIME_SETTINGS.ffmpeg.enableGpu)
    },
    streaming: {
      preferredAudioLanguage: stringValue(merged.streaming.preferredAudioLanguage, DEFAULT_RUNTIME_SETTINGS.streaming.preferredAudioLanguage)
    }
  };
}

function deepMerge(base, override) {
  const output = Array.isArray(base) ? [...base] : { ...base };
  Object.entries(override || {}).forEach(([key, value]) => {
    if (value && typeof value === "object" && !Array.isArray(value) && base && base[key] && typeof base[key] === "object" && !Array.isArray(base[key])) {
      output[key] = deepMerge(base[key], value);
    } else if (value !== undefined) {
      output[key] = value;
    }
  });
  return output;
}

function normalizeLogLevel(value) {
  const level = String(value || "info").toLowerCase();
  return VALID_LOG_LEVELS.has(level) ? level : "info";
}

function boolValue(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function intValue(value, fallback, minimum = 1) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
}

function stringValue(value, fallback) {
  const text = String(value === undefined || value === null ? "" : value).trim();
  return text || fallback;
}

function listValue(value, fallback) {
  if (Array.isArray(value)) {
    const items = value.map((item) => String(item).trim()).filter(Boolean);
    return items.length > 0 ? items : [...fallback];
  }

  if (typeof value === "string") {
    const items = value.split(",").map((item) => item.trim()).filter(Boolean);
    return items.length > 0 ? items : [...fallback];
  }

  return [...fallback];
}

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch (err) {
    return fallback;
  }
}

module.exports = {
  AppSettingsService,
  applyRuntimeSettings,
  normalizeRuntimeSettings,
  runtimeSettingsFromConfig
};
