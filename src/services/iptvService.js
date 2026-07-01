const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const { fileURLToPath } = require("url");
const { XMLParser } = require("fast-xml-parser");
const logger = require("../utils/logger");
const { effectiveDeinterlaceMode } = require("../utils/deinterlace");

const SOURCE_TIMEOUT_MS = 60 * 1000;
const STREAM_START_TIMEOUT_MS = 20 * 1000;
const HARDWARE_STREAM_START_TIMEOUT_MS = 10 * 1000;
const STREAM_IDLE_MS = 60 * 1000;
const ICON_MAX_BYTES = 5 * 1024 * 1024;
const ICON_MANIFEST_FILENAME = "icons.json";
const MIN_READY_SEGMENTS = 1;
const MIN_PLAYLIST_SEGMENTS = 10;
const MIN_PLAYLIST_SECONDS = 120;
const MEMORY_CACHE_ROOT = "/dev/shm";
const MIN_MEMORY_CACHE_BYTES = 64 * 1024 * 1024;
const ESTIMATED_LIVE_BYTES_PER_SECOND = 2 * 1024 * 1024;

class IptvService {
  constructor(config, ffmpeg) {
    this.config = config.iptv;
    this.ffmpeg = ffmpeg;
    this.channels = [];
    this.channelsById = new Map();
    this.guideChannels = [];
    this.programmesByChannel = new Map();
    this.refreshedAt = null;
    this.lastError = null;
    this.refreshTimer = null;
    this.idleTimer = null;
    this.refreshPromise = null;
    this.streams = new Map();
    this.streamStartPromises = new Map();
    this.codecPlans = new Map();
    this.activeIconFilenames = new Set();
    this.streamCachePath = null;
    this.generation = 0;
  }

  start() {
    this.restart();
  }

  restart() {
    this.generation += 1;
    this.stopTimers();
    this.stopAllStreams();
    this.streamStartPromises.clear();
    this.codecPlans.clear();
    this.streamCachePath = null;
    if (!this.config.enabled) {
      this.channels = [];
      this.channelsById.clear();
      this.guideChannels = [];
      this.programmesByChannel.clear();
      this.refreshedAt = null;
      this.lastError = null;
      return;
    }

    this.refresh().catch((err) => {
      logger.error(`[iptv] initial refresh failed message="${err.message}"`, err);
    });
    this.refreshTimer = setInterval(() => {
      this.refresh().catch((err) => {
        logger.error(`[iptv] scheduled refresh failed message="${err.message}"`, err);
      });
    }, this.config.refreshIntervalSeconds * 1000);
    this.refreshTimer.unref?.();
    this.idleTimer = setInterval(() => this.stopIdleStreams(), 10 * 1000);
    this.idleTimer.unref?.();
  }

  stopTimers() {
    clearInterval(this.refreshTimer);
    clearInterval(this.idleTimer);
    this.refreshTimer = null;
    this.idleTimer = null;
  }

  async refresh() {
    if (!this.config.enabled) {
      return this.status();
    }
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = this.loadLineup()
      .catch((err) => {
        this.lastError = err.message;
        throw err;
      })
      .finally(() => {
        this.refreshPromise = null;
      });
    return this.refreshPromise;
  }

  async loadLineup() {
    const sourceType = this.config.sourceType === "hdhomerun" ? "hdhomerun" : "m3u";
    const { playlistChannels, xmlGuide } = sourceType === "hdhomerun"
      ? await this.loadHdHomeRunLineup()
      : await this.loadM3uLineup();
    const matched = applyChannelMappings(
      matchLineup(playlistChannels, xmlGuide.channels),
      xmlGuide.channels,
      this.config.channelMappings
    );
    const channels = await this.cacheChannelIcons(matched);
    await this.resolveStreamCachePath();
    await this.reconcileChannelCaches(new Set(channels.map((channel) => channel.id)));

    this.channels = channels.sort(sortChannels);
    this.channelsById = new Map(this.channels.map((channel) => [channel.id, channel]));
    this.guideChannels = xmlGuide.channels;
    this.programmesByChannel = groupProgrammes(xmlGuide.programmes);
    this.refreshedAt = new Date().toISOString();
    this.lastError = null;
    logger.info(`[iptv] lineup ready source=${sourceType} channels=${this.channels.length} matched=${this.channels.filter((channel) => channel.guideChannelId).length} programmes=${xmlGuide.programmes.length}`);
    return this.status();
  }

  async loadM3uLineup() {
    if (!this.config.playlistUrl || !this.config.guideUrl) {
      throw new Error("Both an M3U playlist and EPG are required");
    }

    logger.info("[iptv] refreshing M3U playlist and EPG");
    const [playlistText, guideText] = await Promise.all([
      readSource(this.config.playlistUrl),
      readSource(this.config.guideUrl)
    ]);
    return {
      playlistChannels: parseM3u(playlistText, this.config.playlistUrl),
      xmlGuide: parseXmlTv(guideText, this.config.guideUrl)
    };
  }

  async loadHdHomeRunLineup() {
    if (!this.config.hdHomeRunUrl) {
      throw new Error("An HDHomeRun device address is required");
    }

    const lineupUrl = hdHomeRunLineupUrl(this.config.hdHomeRunUrl);
    logger.info(`[iptv] refreshing HDHomeRun lineup url="${redactSource(lineupUrl)}" epg=${Boolean(this.config.guideUrl)}`);
    const [lineupText, guideText] = await Promise.all([
      readSource(lineupUrl),
      this.config.guideUrl ? readSource(this.config.guideUrl) : Promise.resolve("")
    ]);
    const playlistChannels = parseHdHomeRunLineup(lineupText, lineupUrl);
    if (playlistChannels.length === 0) {
      throw new Error("The HDHomeRun lineup did not contain any unprotected channels");
    }
    return {
      playlistChannels,
      xmlGuide: guideText ? parseXmlTv(guideText, this.config.guideUrl) : { channels: [], programmes: [] }
    };
  }

  status() {
    return {
      enabled: Boolean(this.config.enabled),
      sourceType: this.config.sourceType === "hdhomerun" ? "hdhomerun" : "m3u",
      ready: this.channels.length > 0,
      channelCount: this.channels.length,
      matchedChannelCount: this.channels.filter((channel) => channel.guideChannelId).length,
      bufferSeconds: this.config.bufferSeconds,
      segmentSeconds: this.config.segmentSeconds,
      refreshedAt: this.refreshedAt,
      error: this.lastError
    };
  }

  guide(startValue, hoursValue) {
    const startMs = finiteDateMs(startValue, Date.now());
    const hours = Math.max(1, Math.min(Number.parseInt(hoursValue, 10) || 6, 24));
    const endMs = startMs + hours * 60 * 60 * 1000;
    return {
      ...this.status(),
      start: new Date(startMs).toISOString(),
      end: new Date(endMs).toISOString(),
      channels: this.channels.map((channel) => ({
        id: channel.id,
        name: channel.name,
        number: channel.number,
        logo: channel.logo,
        logoFilename: channel.logoFilename || null,
        group: channel.group,
        guideMatched: Boolean(channel.guideChannelId),
        programmes: (this.programmesByChannel.get(channel.guideChannelId) || [])
          .filter((programme) => programme.stopMs > startMs && programme.startMs < endMs)
          .map(publicProgramme)
      }))
    };
  }

  matchingData() {
    const mappings = this.config.channelMappings || {};
    const deinterlaceModes = this.config.channelDeinterlaceModes || {};
    return {
      defaultDeinterlaceMode: this.config.deinterlaceMode || "auto",
      channels: this.channels.map((channel) => ({
        id: channel.id,
        name: channel.name,
        number: channel.number,
        automaticGuideChannelId: channel.automaticGuideChannelId || null,
        guideChannelId: channel.guideChannelId || null,
        manualGuideChannelId: Object.prototype.hasOwnProperty.call(mappings, channel.id) ? mappings[channel.id] : null,
        automaticMatchMethod: channel.automaticMatchMethod || null,
        automaticMatchScore: channel.automaticMatchScore || null,
        guideSuggestions: channel.guideSuggestions || [],
        deinterlaceMode: deinterlaceModes[channel.id] || "default"
      })),
      guideChannels: this.guideChannels.map((channel) => ({
        id: channel.id,
        name: channel.names[0] || channel.id,
        names: channel.names
      }))
    };
  }

  applyConfiguredChannelMappings() {
    this.channels = applyChannelMappings(this.channels, this.guideChannels, this.config.channelMappings).sort(sortChannels);
    this.channelsById = new Map(this.channels.map((channel) => [channel.id, channel]));
    return this.matchingData();
  }

  resetChannel(channelId) {
    this.codecPlans.delete(channelId);
    const stream = this.streams.get(channelId);
    if (stream) {
      logger.info(`[iptv] restarting channel after settings change id=${channelId}`);
      stopProcess(stream.child);
      this.streams.delete(channelId);
    }
  }

  async playlist(channelId) {
    const stream = await this.ensureStream(channelId);
    stream.lastAccessAt = Date.now();
    return fs.readFile(stream.playlistPath, "utf8");
  }

  async streamFile(channelId, filename) {
    if (!/^segment_\d+\.ts$/.test(String(filename || ""))) {
      return null;
    }
    const stream = this.streams.get(channelId);
    if (!stream) {
      return null;
    }
    stream.lastAccessAt = Date.now();
    const filePath = path.join(stream.cacheDir, filename);
    try {
      const stat = await fs.stat(filePath);
      return stat.isFile() ? filePath : null;
    } catch (err) {
      return null;
    }
  }

  async iconFile(filename) {
    const selected = path.basename(String(filename || ""));
    if (selected !== filename || !this.activeIconFilenames.has(selected)) {
      return null;
    }
    const filePath = path.join(this.config.cachePath, "icons", selected);
    try {
      const stat = await fs.stat(filePath);
      return stat.isFile() ? filePath : null;
    } catch (err) {
      return null;
    }
  }

  async cacheChannelIcons(channels) {
    const iconDir = path.join(this.config.cachePath, "icons");
    const manifestPath = path.join(iconDir, ICON_MANIFEST_FILENAME);
    await fs.mkdir(iconDir, { recursive: true });
    const previous = await readJson(manifestPath, {});
    const next = {};

    const cachedChannels = await mapWithConcurrency(channels, 6, async (channel) => {
      const source = String(channel.logo || "").trim();
      if (!source) {
        return { ...channel, logoFilename: null };
      }

      const previousEntry = previous[channel.id];
      if (previousEntry
        && previousEntry.source === source
        && safeCacheFilename(previousEntry.filename)
        && await fileExists(path.join(iconDir, previousEntry.filename))) {
        next[channel.id] = previousEntry;
        return { ...channel, logoFilename: previousEntry.filename };
      }

      try {
        const downloaded = await downloadIcon(source);
        const filename = `${channel.id}-${shortHash(source)}.${downloaded.extension}`;
        await fs.writeFile(path.join(iconDir, filename), downloaded.buffer);
        next[channel.id] = { source, filename };
        return { ...channel, logoFilename: filename };
      } catch (err) {
        logger.full(`[iptv] icon cache failed channel="${channel.name}" message="${err.message}"`);
        return { ...channel, logoFilename: null };
      }
    });

    const activeFilenames = new Set(Object.values(next).map((entry) => entry.filename));
    await removeStaleIconFiles(iconDir, activeFilenames);
    await fs.writeFile(manifestPath, JSON.stringify(next, null, 2));
    this.activeIconFilenames = activeFilenames;
    return cachedChannels;
  }

  async reconcileChannelCaches(validChannelIds) {
    const stopping = [];
    for (const [channelId, stream] of this.streams) {
      if (!validChannelIds.has(channelId)) {
        logger.info(`[iptv] removing unavailable channel id=${channelId}`);
        stopping.push(stopProcessAndWait(stream.child));
        this.streams.delete(channelId);
      }
    }
    for (const channelId of this.codecPlans.keys()) {
      if (!validChannelIds.has(channelId)) {
        this.codecPlans.delete(channelId);
      }
    }
    await Promise.all(stopping);

    const cacheRoots = new Set([this.config.cachePath, this.streamCachePath].filter(Boolean));
    await Promise.all([...cacheRoots].map((cacheRoot) => this.reconcileCacheRoot(cacheRoot, validChannelIds)));
  }

  async reconcileCacheRoot(cacheRoot, validChannelIds) {
    let entries;
    try {
      entries = await fs.readdir(cacheRoot, { withFileTypes: true });
    } catch (err) {
      if (err.code === "ENOENT") {
        return;
      }
      throw err;
    }
    await Promise.all(entries
      .filter((entry) => entry.isDirectory() && entry.name !== "icons" && !validChannelIds.has(entry.name))
      .map((entry) => fs.rm(path.join(cacheRoot, entry.name), {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 200
      })));
  }

  async resolveStreamCachePath() {
    if (this.streamCachePath) {
      return this.streamCachePath;
    }

    this.streamCachePath = await selectLiveCachePath(this.config.cachePath, this.config.bufferSeconds);
    const storage = this.streamCachePath === this.config.cachePath ? "disk" : "memory";
    logger.info(`[iptv] live HLS cache storage=${storage} path="${this.streamCachePath}"`);
    return this.streamCachePath;
  }

  async ensureStream(channelId) {
    if (this.streamStartPromises.has(channelId)) {
      return this.streamStartPromises.get(channelId);
    }
    const existing = this.streams.get(channelId);
    if (existing && !existing.exited) {
      existing.lastAccessAt = Date.now();
      if (existing.readyPromise) {
        await existing.readyPromise;
      }
      return existing;
    }
    const generation = this.generation;
    const startPromise = this.startChannelStream(channelId, generation)
      .finally(() => {
        if (this.streamStartPromises.get(channelId) === startPromise) {
          this.streamStartPromises.delete(channelId);
        }
      });
    this.streamStartPromises.set(channelId, startPromise);
    return startPromise;
  }

  async startChannelStream(channelId, generation) {
    const channel = this.channelsById.get(channelId);
    if (!channel) {
      throw Object.assign(new Error("IPTV channel not found"), { status: 404 });
    }

    const codecPlan = await this.codecPlan(channel);
    if (!this.config.enabled || generation !== this.generation) {
      throw Object.assign(new Error("IPTV settings changed while the channel was starting"), { status: 503 });
    }

    const cacheDir = path.join(await this.resolveStreamCachePath(), channelId);
    return this.launchChannelStream(channel, generation, cacheDir, codecPlan, true);
  }

  async launchChannelStream(channel, generation, cacheDir, codecPlan, allowHardwareFallback) {
    if (!this.config.enabled || generation !== this.generation) {
      throw Object.assign(new Error("IPTV settings changed while the channel was starting"), { status: 503 });
    }

    await fs.rm(cacheDir, { recursive: true, force: true });
    await fs.mkdir(cacheDir, { recursive: true });
    const playlistPath = path.join(cacheDir, "master.m3u8");
    const args = liveHlsArgs(channel.url, cacheDir, playlistPath, this.config, codecPlan);
    logger.info(`[iptv] starting channel id=${channel.id} name="${channel.name}" video=${codecPlan.videoInputCodec || "none"}->${codecPlan.videoCodec || "none"} audio=${codecPlan.audioInputCodec || "none"}->${codecPlan.audioCodec || "none"} deinterlace=${codecPlan.deinterlaceMode} bufferSeconds=${this.config.bufferSeconds}`);
    logger.full(`[iptv] ffmpeg command ${this.ffmpeg.ffmpegPath} ${safeCommandArgs(args, channel.url).map(quoteArg).join(" ")}`);
    const child = this.ffmpeg.spawn(args);
    const stream = {
      channelId: channel.id,
      cacheDir,
      playlistPath,
      child,
      exited: false,
      starting: true,
      suppressExitLog: false,
      lastAccessAt: Date.now(),
      stderr: []
    };
    this.streams.set(channel.id, stream);
    child.stderr.on("data", (chunk) => rememberStderr(stream, chunk));
    child.once("exit", (code) => {
      stream.exited = true;
      if (this.streams.get(channel.id) === stream) {
        this.streams.delete(channel.id);
      }
      if (!stream.starting && !stream.suppressExitLog) {
        if (code !== 0 && code !== null) {
          logger.error(`[iptv] channel stopped id=${channel.id} code=${code} error="${stderrSummary(stream)}"`);
        } else {
          logger.info(`[iptv] channel stopped id=${channel.id}`);
        }
      }
    });
    const startedAt = Date.now();
    const canRetryWithSoftware = allowHardwareFallback && isHardwareVideoCodec(codecPlan.videoCodec);
    const timeoutMs = canRetryWithSoftware ? HARDWARE_STREAM_START_TIMEOUT_MS : STREAM_START_TIMEOUT_MS;
    stream.readyPromise = waitForPlaylist(playlistPath, child, timeoutMs);
    try {
      await stream.readyPromise;
      stream.starting = false;
      logger.info(`[iptv] channel ready id=${channel.id} startupMs=${Date.now() - startedAt}`);
      return stream;
    } catch (err) {
      stream.suppressExitLog = canRetryWithSoftware;
      await stopProcessAndWait(child);
      if (this.streams.get(channel.id) === stream) {
        this.streams.delete(channel.id);
      }

      if (canRetryWithSoftware && this.config.enabled && generation === this.generation) {
        const softwarePlan = softwareCodecPlan(codecPlan);
        this.codecPlans.set(channel.id, softwarePlan);
        logger.info(`[iptv] hardware start failed channel id=${channel.id} encoder=${codecPlan.videoCodec} message="${err.message}" ffmpeg="${stderrSummary(stream)}"; retrying video=libx264`);
        return this.launchChannelStream(channel, generation, cacheDir, softwarePlan, false);
      }

      err.status = err.status || 504;
      logger.error(`[iptv] channel failed to start id=${channel.id} startupMs=${Date.now() - startedAt} message="${err.message}" ffmpeg="${stderrSummary(stream)}"`);
      throw err;
    } finally {
      stream.readyPromise = null;
    }
  }

  async codecPlan(channel) {
    const cached = this.codecPlans.get(channel.id);
    if (cached) {
      logger.info(`[iptv] cached codec plan channel="${channel.name}" video=${cached.videoInputCodec || "unknown"}->${cached.videoCodec || "none"} audio=${cached.audioInputCodec || "unknown"}->${cached.audioCodec || "none"} deinterlace=${cached.deinterlaceMode}`);
      return cached;
    }

    let probe = null;
    if (this.config.sourceType === "hdhomerun") {
      logger.info(`[iptv] using compatibility transcode for HDHomeRun channel="${channel.name}"`);
    } else {
      try {
        probe = await this.ffmpeg.probeStream(channel.url);
      } catch (err) {
        const message = summarizeError(err.message).split(channel.url).join(redactSource(channel.url));
        logger.info(`[iptv] live probe failed channel="${channel.name}"; using compatible transcode message="${message}"`);
      }
    }

    const streams = probe && Array.isArray(probe.streams) ? probe.streams : [];
    const video = streams.find((stream) => stream.codec_type === "video") || null;
    const audio = streams.find((stream) => stream.codec_type === "audio") || null;
    const hasKnownStreams = streams.length > 0;
    const deinterlace = deinterlacePlan(
      effectiveDeinterlaceMode(this.config, channel.id),
      video,
      this.config.sourceType === "hdhomerun"
    );
    const forceVideoTranscode = this.config.sourceType === "hdhomerun";
    const videoCompatible = !forceVideoTranscode
      && !deinterlace.enabled
      && video
      && video.codec_name === "h264"
      && video.pix_fmt === "yuv420p";
    const audioCompatible = audio && audio.codec_name === "aac";
    const needsVideoTranscode = deinterlace.enabled || (hasKnownStreams ? Boolean(video && !videoCompatible) : true);
    const hardwareProfile = needsVideoTranscode
      ? await this.ffmpeg.detectHardwareProfile()
      : { encoder: null, inputArgs: [], uploadFilter: null };
    const plan = {
      hasVideo: hasKnownStreams ? Boolean(video) : true,
      hasAudio: hasKnownStreams ? Boolean(audio) : true,
      videoInputCodec: video && video.codec_name || null,
      audioInputCodec: audio && audio.codec_name || null,
      videoCodec: hasKnownStreams && !video ? null : videoCompatible ? "copy" : hardwareProfile.encoder || "libx264",
      audioCodec: hasKnownStreams && !audio ? null : audioCompatible ? "copy" : "aac",
      inputArgs: needsVideoTranscode
        ? [
          ...(hardwareProfile.inputArgs || []),
          ...(deinterlace.enabled ? [] : hardwareProfile.hwaccelArgs || [])
        ]
        : [],
      uploadFilter: needsVideoTranscode ? hardwareProfile.uploadFilter || null : null,
      hardwareFrames: needsVideoTranscode && !deinterlace.enabled ? hardwareProfile.hardwareFrames || null : null,
      deinterlaceMode: deinterlace.mode,
      deinterlaceFilter: deinterlace.filter
    };
    this.codecPlans.set(channel.id, plan);
    return plan;
  }

  stopIdleStreams() {
    const cutoff = Date.now() - STREAM_IDLE_MS;
    for (const [channelId, stream] of this.streams) {
      if (stream.lastAccessAt < cutoff) {
        logger.info(`[iptv] stopping idle channel id=${channelId}`);
        stopProcess(stream.child);
        this.streams.delete(channelId);
      }
    }
  }

  stopAllStreams() {
    for (const stream of this.streams.values()) {
      stopProcess(stream.child);
    }
    this.streams.clear();
  }
}

async function readSource(value) {
  const source = String(value || "").trim();
  if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source, {
      headers: { "User-Agent": "MediaBaker/1.0" },
      redirect: "follow",
      signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS)
    });
    if (!response.ok) {
      throw new Error(`Source returned HTTP ${response.status}`);
    }
    return response.text();
  }

  const filePath = source.startsWith("file://") ? new URL(source) : source;
  return fs.readFile(filePath, "utf8");
}

async function downloadIcon(source) {
  if (!/^https?:\/\//i.test(source)) {
    const filePath = source.startsWith("file://") ? fileURLToPath(source) : source;
    const extension = iconExtension("", filePath);
    if (!extension) {
      throw new Error("Unsupported local icon file type");
    }
    const buffer = await fs.readFile(filePath);
    if (buffer.length === 0 || buffer.length > ICON_MAX_BYTES) {
      throw new Error(buffer.length === 0 ? "Icon file was empty" : "Icon is larger than 5 MB");
    }
    return { buffer, extension };
  }

  const response = await fetch(source, {
    headers: { "User-Agent": "MediaBaker/1.0" },
    redirect: "follow",
    signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS)
  });
  if (!response.ok) {
    throw new Error(`Icon returned HTTP ${response.status}`);
  }

  const contentType = String(response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const extension = iconExtension(contentType, source);
  if (!extension) {
    throw new Error(`Unsupported icon content type: ${contentType || "unknown"}`);
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > ICON_MAX_BYTES) {
    throw new Error("Icon is larger than 5 MB");
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length === 0 || buffer.length > ICON_MAX_BYTES) {
    throw new Error(buffer.length === 0 ? "Icon response was empty" : "Icon is larger than 5 MB");
  }
  return { buffer, extension };
}

function iconExtension(contentType, source) {
  const byType = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/svg+xml": "svg"
  };
  if (byType[contentType]) {
    return byType[contentType];
  }
  try {
    const pathname = /^https?:\/\//i.test(source) ? new URL(source).pathname : source;
    const extension = path.extname(pathname).slice(1).toLowerCase();
    return ["png", "jpg", "jpeg", "webp", "gif", "svg"].includes(extension)
      ? extension.replace("jpeg", "jpg")
      : null;
  } catch (err) {
    return null;
  }
}

async function removeStaleIconFiles(iconDir, activeFilenames) {
  const entries = await fs.readdir(iconDir, { withFileTypes: true });
  await Promise.all(entries
    .filter((entry) => entry.isFile()
      && entry.name !== ICON_MANIFEST_FILENAME
      && !activeFilenames.has(entry.name))
    .map((entry) => fs.rm(path.join(iconDir, entry.name), { force: true })));
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT" || err instanceof SyntaxError) {
      return fallback;
    }
    throw err;
  }
}

async function fileExists(filePath) {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch (err) {
    return false;
  }
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

function shortHash(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, 12);
}

function safeCacheFilename(value) {
  const filename = String(value || "");
  return Boolean(filename) && path.basename(filename) === filename;
}

function parseM3u(text, source = "") {
  const lines = String(text || "").replace(/^\uFEFF/, "").split(/\r?\n/);
  const channels = [];
  let pending = null;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (line.startsWith("#EXTINF:")) {
      pending = parseExtInf(line);
      continue;
    }
    if (line.startsWith("#")) {
      continue;
    }
    if (!pending) {
      pending = { attributes: {}, name: `Channel ${channels.length + 1}` };
    }
    const url = resolvePlaylistUrl(line, source);
    const attributes = pending.attributes;
    channels.push({
      id: channelId(attributes["tvg-id"], pending.name, url),
      guideId: attributes["tvg-id"] || "",
      tvgName: attributes["tvg-name"] || "",
      name: pending.name || attributes["tvg-name"] || attributes["tvg-id"] || `Channel ${channels.length + 1}`,
      number: attributes["tvg-chno"] || attributes["channel-number"] || "",
      logo: resolveAssetUrl(attributes["tvg-logo"], source),
      group: attributes["group-title"] || "",
      url
    });
    pending = null;
  }
  return channels;
}

function parseHdHomeRunLineup(text, source = "") {
  let lineup;
  try {
    lineup = JSON.parse(String(text || ""));
  } catch (err) {
    throw new Error("HDHomeRun returned an invalid lineup.json response");
  }
  if (!Array.isArray(lineup)) {
    throw new Error("HDHomeRun lineup.json must contain a channel list");
  }

  return lineup
    .filter((entry) => entry && entry.URL && !hdHomeRunTags(entry).includes("drm"))
    .map((entry) => {
      const number = String(entry.GuideNumber || "").trim();
      const name = String(entry.GuideName || number || "HDHomeRun channel").trim();
      const url = resolvePlaylistUrl(entry.URL, source);
      return {
        id: channelId(number, name, url),
        guideId: number,
        tvgName: name,
        name,
        number,
        logo: "",
        group: hdHomeRunTags(entry).includes("favorite") ? "Favorites" : "HDHomeRun",
        url
      };
    });
}

function hdHomeRunTags(entry) {
  return String(entry.Tags || "")
    .split(",")
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean);
}

function hdHomeRunLineupUrl(value) {
  let address = String(value || "").trim();
  if (!/^https?:\/\//i.test(address)) {
    address = `http://${address}`;
  }
  let url;
  try {
    url = new URL(address);
  } catch (err) {
    throw new Error("HDHomeRun device address is not a valid URL or hostname");
  }
  if (!/\/lineup\.json$/i.test(url.pathname)) {
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/lineup.json`;
  }
  url.search = "";
  url.hash = "";
  return url.toString();
}

function parseExtInf(line) {
  const commaIndex = commaOutsideQuotes(line);
  const header = commaIndex >= 0 ? line.slice(0, commaIndex) : line;
  const name = commaIndex >= 0 ? line.slice(commaIndex + 1).trim() : "";
  const attributes = {};
  for (const match of header.matchAll(/([\w-]+)\s*=\s*"([^"]*)"/g)) {
    attributes[match[1].toLowerCase()] = match[2].trim();
  }
  return { attributes, name };
}

function commaOutsideQuotes(value) {
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '"') {
      quoted = !quoted;
    } else if (value[index] === "," && !quoted) {
      return index;
    }
  }
  return -1;
}

function parseXmlTv(text, source = "") {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
    textNodeName: "#text",
    parseTagValue: false,
    trimValues: true
  });
  const document = parser.parse(String(text || ""));
  const tv = document && document.tv || {};
  const channels = arrayValue(tv.channel).map((channel) => ({
    id: String(channel.id || "").trim(),
    names: arrayValue(channel["display-name"]).map(textValue).filter(Boolean),
    logo: resolveAssetUrl(attributeValue(arrayValue(channel.icon)[0], "src"), source)
  })).filter((channel) => channel.id);
  const programmes = arrayValue(tv.programme).map((programme) => {
    const startMs = parseXmlTvDate(programme.start);
    const stopMs = parseXmlTvDate(programme.stop);
    return {
      channelId: String(programme.channel || "").trim(),
      startMs,
      stopMs: stopMs > startMs ? stopMs : startMs + 30 * 60 * 1000,
      title: firstText(programme.title) || "Untitled programme",
      subtitle: firstText(programme["sub-title"]),
      description: firstText(programme.desc),
      category: firstText(programme.category),
      icon: resolveAssetUrl(attributeValue(arrayValue(programme.icon)[0], "src"), source)
    };
  }).filter((programme) => programme.channelId && Number.isFinite(programme.startMs));
  return { channels, programmes };
}

function matchLineup(playlistChannels, guideChannels) {
  const byId = new Map(guideChannels.map((channel) => [channel.id.toLowerCase(), channel]));
  const byName = new Map();
  for (const channel of guideChannels) {
    for (const name of channel.names) {
      const key = normalizeChannelName(name);
      if (key && !byName.has(key)) {
        byName.set(key, channel);
      }
    }
  }

  return playlistChannels.map((channel) => {
    const exactGuideChannel = byId.get(String(channel.guideId || "").toLowerCase())
      || byName.get(normalizeChannelName(channel.tvgName))
      || byName.get(normalizeChannelName(channel.name));
    const suggestions = rankGuideChannels(channel, guideChannels, 6);
    const fuzzyMatch = exactGuideChannel ? null : confidentGuideMatch(suggestions);
    const guideChannel = exactGuideChannel || fuzzyMatch && fuzzyMatch.channel;
    return {
      ...channel,
      automaticGuideChannelId: guideChannel && guideChannel.id || null,
      guideChannelId: guideChannel && guideChannel.id || null,
      automaticMatchMethod: exactGuideChannel ? "exact" : fuzzyMatch ? "fuzzy" : null,
      automaticMatchScore: exactGuideChannel ? 1 : fuzzyMatch ? fuzzyMatch.score : null,
      guideSuggestions: suggestions.map((suggestion) => ({
        id: suggestion.channel.id,
        score: suggestion.score
      })),
      logo: channel.logo || guideChannel && guideChannel.logo || ""
    };
  });
}

function rankGuideChannels(channel, guideChannels, limit) {
  const sourceNames = [channel.tvgName, channel.name].filter(Boolean);
  return guideChannels
    .map((guideChannel) => ({
      channel: guideChannel,
      score: Math.max(0, ...sourceNames.flatMap((sourceName) => guideChannel.names.map((guideName) => channelNameScore(sourceName, guideName))))
    }))
    .filter((candidate) => candidate.score >= 0.35)
    .sort((a, b) => b.score - a.score || a.channel.id.localeCompare(b.channel.id))
    .slice(0, limit);
}

function confidentGuideMatch(suggestions) {
  const best = suggestions[0];
  if (!best || best.score < 0.64) {
    return null;
  }
  const runnerUp = suggestions[1];
  if (runnerUp && best.score - runnerUp.score < 0.05) {
    return null;
  }
  return best;
}

function channelNameScore(leftValue, rightValue) {
  const left = channelNameParts(leftValue);
  const right = channelNameParts(rightValue);
  if (!left.compact || !right.compact) {
    return 0;
  }
  if (left.compact === right.compact) {
    return 1;
  }

  const leftNumbers = left.tokens.filter((token) => /^\d+$/.test(token));
  const rightNumbers = right.tokens.filter((token) => /^\d+$/.test(token));
  const numberConflict = leftNumbers.length && rightNumbers.length
    && !leftNumbers.some((number) => rightNumbers.includes(number));
  const edit = levenshteinSimilarity(left.compact, right.compact);
  const bigrams = diceCoefficient(left.compact, right.compact);
  const tokens = tokenSimilarity(left.tokens, right.tokens);
  const prefix = commonPrefixLength(left.compact, right.compact) / Math.min(left.compact.length, right.compact.length);
  const containment = left.compact.includes(right.compact) || right.compact.includes(left.compact) ? 1 : 0;
  const score = Math.max(
    edit * 0.45 + bigrams * 0.35 + tokens * 0.2,
    prefix * 0.55 + tokens * 0.3 + containment * 0.15,
    tokens * 0.72 + prefix * 0.18 + containment * 0.1
  );
  return Number((numberConflict ? score * 0.55 : score).toFixed(4));
}

function channelNameParts(value) {
  const words = String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\b(?:uhd|fhd|hd|sd|4k|1080p|720p|channel|television|tv)\b/g, " ")
    .replace(/\bone\b/g, " 1 ")
    .replace(/\btwo\b/g, " 2 ")
    .replace(/\bthree\b/g, " 3 ")
    .replace(/\bfour\b/g, " 4 ")
    .replace(/\bfive\b/g, " 5 ")
    .replace(/(?:uhd|fhd|hd|sd)$/g, " ")
    .replace(/([a-z])(\d)/g, "$1 $2")
    .replace(/(\d)([a-z])/g, "$1 $2")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const tokens = words.split(/\s+/).filter((token) => token && token !== "and");
  return { tokens, compact: tokens.join("") };
}

function tokenSimilarity(left, right) {
  const remaining = [...right];
  let matches = 0;
  for (const leftToken of left) {
    const matchIndex = remaining.findIndex((rightToken) => leftToken === rightToken
      || Math.min(leftToken.length, rightToken.length) >= 2
        && (leftToken.startsWith(rightToken) || rightToken.startsWith(leftToken)));
    if (matchIndex >= 0) {
      matches += 1;
      remaining.splice(matchIndex, 1);
    }
  }
  return left.length + right.length ? (2 * matches) / (left.length + right.length) : 0;
}

function diceCoefficient(left, right) {
  if (left.length < 2 || right.length < 2) {
    return left === right ? 1 : 0;
  }
  const leftPairs = new Map();
  for (let index = 0; index < left.length - 1; index += 1) {
    const pair = left.slice(index, index + 2);
    leftPairs.set(pair, (leftPairs.get(pair) || 0) + 1);
  }
  let matches = 0;
  for (let index = 0; index < right.length - 1; index += 1) {
    const pair = right.slice(index, index + 2);
    const count = leftPairs.get(pair) || 0;
    if (count > 0) {
      matches += 1;
      leftPairs.set(pair, count - 1);
    }
  }
  return (2 * matches) / (left.length + right.length - 2);
}

function levenshteinSimilarity(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let diagonal = previous[0];
    previous[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const above = previous[rightIndex];
      previous[rightIndex] = Math.min(
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + 1,
        diagonal + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1)
      );
      diagonal = above;
    }
  }
  return 1 - previous[right.length] / Math.max(left.length, right.length);
}

function commonPrefixLength(left, right) {
  let length = 0;
  while (length < left.length && length < right.length && left[length] === right[length]) {
    length += 1;
  }
  return length;
}

function applyChannelMappings(channels, guideChannels, mappings) {
  const validGuideIds = new Set(guideChannels.map((channel) => channel.id));
  const configured = mappings && typeof mappings === "object" ? mappings : {};
  return channels.map((channel) => {
    const automaticGuideChannelId = channel.automaticGuideChannelId || null;
    const manualGuideChannelId = Object.prototype.hasOwnProperty.call(configured, channel.id)
      ? String(configured[channel.id] || "").trim()
      : null;
    return {
      ...channel,
      automaticGuideChannelId,
      guideChannelId: manualGuideChannelId && validGuideIds.has(manualGuideChannelId)
        ? manualGuideChannelId
        : automaticGuideChannelId
    };
  });
}

function groupProgrammes(programmes) {
  const grouped = new Map();
  for (const programme of programmes) {
    const list = grouped.get(programme.channelId) || [];
    list.push(programme);
    grouped.set(programme.channelId, list);
  }
  for (const list of grouped.values()) {
    list.sort((a, b) => a.startMs - b.startMs);
  }
  return grouped;
}

function liveHlsArgs(sourceUrl, cacheDir, playlistPath, config, codecPlan) {
  const segmentSeconds = Math.max(2, Number(config.segmentSeconds) || 6);
  const requestedBufferSeconds = Math.max(10, Number(config.bufferSeconds) || 180);
  const retainedSeconds = Math.max(MIN_PLAYLIST_SECONDS, requestedBufferSeconds);
  const listSize = Math.max(MIN_PLAYLIST_SEGMENTS, Math.ceil(retainedSeconds / segmentSeconds));
  const deleteThreshold = Math.max(2, Math.ceil(30 / segmentSeconds));
  const reconnectArgs = /^https?:\/\//i.test(sourceUrl)
    ? ["-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "10"]
    : [];
  return [
    "-hide_banner", "-loglevel", "warning", "-y",
    "-fflags", "+genpts+discardcorrupt",
    ...(codecPlan.inputArgs || []),
    "-analyzeduration", "1M", "-probesize", "1M",
    ...reconnectArgs,
    "-i", sourceUrl,
    "-map", "0:v:0?", "-map", "0:a:0?", "-sn", "-dn",
    ...liveVideoCodecArgs(codecPlan, segmentSeconds),
    ...liveAudioCodecArgs(codecPlan),
    "-f", "hls",
    "-hls_time", String(segmentSeconds),
    "-hls_list_size", String(listSize),
    "-hls_delete_threshold", String(deleteThreshold),
    "-hls_start_number_source", "epoch",
    "-hls_flags", "delete_segments+append_list+omit_endlist+independent_segments+temp_file",
    "-hls_segment_filename", path.join(cacheDir, "segment_%05d.ts"),
    playlistPath
  ];
}

function liveVideoCodecArgs(codecPlan, segmentSeconds) {
  if (!codecPlan.hasVideo || !codecPlan.videoCodec) {
    return [];
  }
  if (codecPlan.videoCodec === "copy") {
    return ["-c:v", "copy"];
  }

  const args = ["-c:v", codecPlan.videoCodec];
  const filters = [];
  if (codecPlan.deinterlaceFilter) {
    filters.push(codecPlan.deinterlaceFilter);
  }
  if (codecPlan.videoCodec === "h264_nvenc") {
    args.push("-preset", "p1", "-tune", "ll", "-rc", "vbr", "-cq", "24", "-b:v", "0", "-maxrate", "16M", "-bufsize", "32M", "-spatial-aq", "1");
  } else if (codecPlan.videoCodec === "h264_vaapi") {
    filters.push(codecPlan.uploadFilter || "format=nv12,hwupload");
    args.push("-qp", "24");
  } else if (codecPlan.videoCodec === "h264_qsv" || codecPlan.videoCodec === "h264_amf") {
    args.push("-b:v", "5M", "-maxrate", "8M", "-bufsize", "12M");
  } else if (codecPlan.videoCodec === "h264_videotoolbox") {
    args.push("-b:v", "5M");
  } else {
    args.push("-preset", "veryfast", "-tune", "zerolatency", "-crf", "23");
  }

  if (filters.length > 0) {
    args.push("-vf", filters.join(","));
  }

  if (codecPlan.videoCodec !== "h264_vaapi" && codecPlan.hardwareFrames !== "cuda") {
    args.push("-pix_fmt", "yuv420p");
  }
  args.push(
    "-sc_threshold", "0",
    "-force_key_frames", `expr:gte(t,n_forced*${segmentSeconds})`
  );
  return args;
}

function deinterlacePlan(mode, video, hdHomeRun) {
  const fieldOrder = String(video && video.field_order || "").toLowerCase();
  const markedInterlaced = ["tt", "bb", "tb", "bt", "interlaced"].includes(fieldOrder);
  const enabled = mode === "force" || mode === "smooth" || mode === "auto" && (hdHomeRun || markedInterlaced);
  if (!enabled) {
    return { enabled: false, mode, filter: null };
  }

  const frameMode = mode === "smooth" ? "send_field" : "send_frame";
  const frameSelection = mode === "auto" ? "interlaced" : "all";
  return {
    enabled: true,
    mode,
    filter: `bwdif=mode=${frameMode}:parity=auto:deint=${frameSelection}`
  };
}

function liveAudioCodecArgs(codecPlan) {
  if (!codecPlan.hasAudio || !codecPlan.audioCodec) {
    return [];
  }
  return codecPlan.audioCodec === "copy"
    ? ["-c:a", "copy"]
    : ["-c:a", "aac", "-b:a", "192k"];
}

async function waitForPlaylist(filePath, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`IPTV stream exited before the first segment (code ${child.exitCode})`);
    }
    try {
      const playlist = await fs.readFile(filePath, "utf8");
      const segments = playlist.split(/\r?\n/).filter((line) => line && !line.startsWith("#"));
      const readySegments = await Promise.all(segments.slice(-MIN_READY_SEGMENTS)
        .map((segment) => fileExists(path.join(path.dirname(filePath), path.basename(segment)))));
      if (segments.length >= MIN_READY_SEGMENTS && readySegments.every(Boolean)) {
        return;
      }
    } catch (err) {
      // The first complete playlist and segment have not been written yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for the IPTV stream to start");
}

async function selectLiveCachePath(diskCachePath, bufferSeconds) {
  if (process.platform === "win32") {
    return diskCachePath;
  }

  try {
    const stats = await fs.statfs(MEMORY_CACHE_ROOT);
    const availableBytes = Number(stats.bavail) * Number(stats.bsize);
    const requiredBytes = Math.max(
      MIN_MEMORY_CACHE_BYTES,
      Math.max(MIN_PLAYLIST_SECONDS, Number(bufferSeconds) || 180) * ESTIMATED_LIVE_BYTES_PER_SECOND
    );
    if (!Number.isFinite(availableBytes) || availableBytes < requiredBytes) {
      return diskCachePath;
    }

    const memoryPath = path.join(MEMORY_CACHE_ROOT, `media-baker-iptv-${shortHash(path.resolve(diskCachePath))}`);
    await fs.mkdir(memoryPath, { recursive: true });
    const marker = path.join(memoryPath, `.write-check-${process.pid}`);
    await fs.writeFile(marker, "");
    await fs.rm(marker, { force: true });
    return memoryPath;
  } catch (err) {
    return diskCachePath;
  }
}

function rememberStderr(stream, chunk) {
  const lines = String(chunk).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  stream.stderr.push(...lines);
  stream.stderr = stream.stderr.slice(-40);
}

function stderrSummary(stream) {
  const meaningful = stream.stderr.filter((line) => !line.startsWith("Last message repeated")
    && !line.startsWith("Consider increasing the value")
    && !line.includes("Could not find codec parameters for stream")
    && !line.includes("Codec AVOption sc_threshold"));
  return (meaningful.length > 0 ? meaningful : stream.stderr).slice(-8).join(" | ");
}

function isHardwareVideoCodec(codec) {
  return ["h264_nvenc", "h264_qsv", "h264_vaapi", "h264_amf", "h264_videotoolbox"].includes(codec);
}

function softwareCodecPlan(codecPlan) {
  return {
    ...codecPlan,
    videoCodec: codecPlan.hasVideo ? "libx264" : null,
    inputArgs: [],
    uploadFilter: null,
    hardwareFrames: null
  };
}

function stopProcess(child) {
  if (child && child.exitCode === null && !child.killed) {
    child.kill("SIGTERM");
  }
}

function stopProcessAndWait(child) {
  if (!child || child.exitCode !== null || child.killed) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish();
    }, 5000);
    child.once("exit", finish);
    child.kill("SIGTERM");
  });
}

function publicProgramme(programme) {
  return {
    title: programme.title,
    subtitle: programme.subtitle,
    description: programme.description,
    category: programme.category,
    icon: programme.icon,
    start: new Date(programme.startMs).toISOString(),
    stop: new Date(programme.stopMs).toISOString()
  };
}

function parseXmlTvDate(value) {
  const match = String(value || "").trim().match(/^(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?\s*([+-])(\d{2})(\d{2})$/)
    || String(value || "").trim().match(/^(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?$/);
  if (!match) {
    return NaN;
  }
  const utc = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4] || 0),
    Number(match[5] || 0),
    Number(match[6] || 0)
  );
  if (!match[7]) {
    return utc;
  }
  const offsetMs = (Number(match[8]) * 60 + Number(match[9])) * 60 * 1000;
  return match[7] === "+" ? utc - offsetMs : utc + offsetMs;
}

function arrayValue(value) {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function firstText(value) {
  return textValue(arrayValue(value)[0]);
}

function textValue(value) {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "object") {
    return String(value["#text"] || "").trim();
  }
  return String(value).trim();
}

function attributeValue(value, name) {
  return value && typeof value === "object" ? String(value[name] || "").trim() : "";
}

function normalizeChannelName(value) {
  return channelNameParts(value).compact;
}

function resolvePlaylistUrl(value, source) {
  const target = String(value || "").trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || path.isAbsolute(target) || /^\\\\/.test(target)) {
    return target;
  }
  if (/^https?:\/\//i.test(source)) {
    return new URL(target, source).toString();
  }
  const sourcePath = String(source || "").startsWith("file://") ? fileURLToPath(source) : source;
  return path.resolve(path.dirname(sourcePath || "."), target);
}

function resolveAssetUrl(value, source) {
  const target = String(value || "").trim();
  return target ? resolvePlaylistUrl(target, source) : "";
}

function channelId(guideId, name, url) {
  return crypto.createHash("sha256").update(`${guideId || ""}\0${name || ""}\0${url}`).digest("hex").slice(0, 16);
}

function sortChannels(a, b) {
  const numberA = Number.parseFloat(a.number);
  const numberB = Number.parseFloat(b.number);
  if (Number.isFinite(numberA) && Number.isFinite(numberB) && numberA !== numberB) {
    return numberA - numberB;
  }
  if (Number.isFinite(numberA) !== Number.isFinite(numberB)) {
    return Number.isFinite(numberA) ? -1 : 1;
  }
  return a.name.localeCompare(b.name);
}

function finiteDateMs(value, fallback) {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

function quoteArg(value) {
  const text = String(value);
  return /\s/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
}

function safeCommandArgs(args, sourceUrl) {
  return args.map((arg) => arg === sourceUrl ? redactSource(sourceUrl) : arg);
}

function redactSource(source) {
  try {
    const url = new URL(source);
    url.username = "";
    url.password = "";
    url.search = "";
    return url.toString();
  } catch (err) {
    return String(source || "");
  }
}

function summarizeError(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 2)
    .join(" | ");
}

module.exports = { IptvService, parseM3u, parseHdHomeRunLineup, parseXmlTv, hdHomeRunLineupUrl };
