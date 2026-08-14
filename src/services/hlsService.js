const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const { SUBTITLE_EXTENSIONS, isAudioFile, normalizeAudioPreference } = require("../utils/mediaParsers");
const { normalizeQualityPreference, qualityProfileForProbe } = require("./qualityProfiles");
const logger = require("../utils/logger");

const SEEK_AHEAD_THRESHOLD_SECONDS = 30;
const SEEK_PRE_ROLL_SECONDS = 24;
const SEEK_REASSERT_INTERVAL_MS = 1500;
const HLS_CACHE_FORMAT_VERSION = "synthetic-vod-keyframe-timeline-v22";
const HLS_CACHE_FORMAT_MARKER = ".hls-cache-format";
const KEYFRAME_CACHE_DIRECTORY = ".keyframes";
const MAXIMUM_COPIED_SEGMENT_SECONDS = 60;

class HlsService {
  constructor(config, ffmpeg, progress = null) {
    this.config = config;
    this.ffmpeg = ffmpeg;
    this.progress = progress;
    this.activeSetups = new Map();
    this.activeTranscodes = new Map();
    this.keyframeSetups = new Map();
    this.keyframeWarmQueue = new Map();
    this.keyframeWarmRunning = false;
    this.cacheFormatPromise = null;
  }

  queueKeyframeIndex(mediaFiles = []) {
    let added = 0;
    for (const mediaFile of mediaFiles) {
      if (!mediaFile || !mediaFile.filePath) continue;
      const queueKey = normalizedFilePath(mediaFile.filePath);
      if (!this.keyframeWarmQueue.has(queueKey)) added += 1;
      this.keyframeWarmQueue.set(queueKey, mediaFile);
    }
    if (added > 0) {
      logger.info(`[hls] queued background keyframe indexing files=${added} pending=${this.keyframeWarmQueue.size}`);
    }
    this.startKeyframeWarmQueue();
  }

  startKeyframeWarmQueue() {
    if (this.keyframeWarmRunning || this.keyframeWarmQueue.size === 0) return;
    this.keyframeWarmRunning = true;
    setImmediate(() => {
      this.drainKeyframeWarmQueue()
        .catch((error) => logger.error(`[hls] background keyframe indexing stopped message="${error.message}"`, error))
        .finally(() => {
          this.keyframeWarmRunning = false;
          this.startKeyframeWarmQueue();
        });
    });
  }

  async drainKeyframeWarmQueue() {
    await this.ensureCacheFormat();
    while (this.keyframeWarmQueue.size > 0) {
      const [queueKey, mediaFile] = this.keyframeWarmQueue.entries().next().value;
      this.keyframeWarmQueue.delete(queueKey);
      try {
        const probe = await this.ffmpeg.probe(mediaFile.filePath);
        const videoStream = selectVideoStream(probe);
        if (videoStream && isCompatibleH264Stream(videoStream) && !this.config.hls.forceTranscodeCompatibleVideo) {
          await this.keyframeTimelineFor(mediaFile.filePath, probe, videoStream);
        }
      } catch (error) {
        logger.full(`[hls] background keyframe index skipped input="${mediaFile.filePath}" message="${summarizeFfmpegOutput(error.message)}"`);
      }
      await delay(25);
    }
  }

  async prepare(mediaFile, options = {}) {
    await this.ensureCacheFormat();
    const normalizedOptions = {
      audio: normalizeAudioPreference(options.audio, this.config.streaming.preferredAudioLanguage),
      subtitle: normalizeSubtitlePreference(options.subtitle),
      audioChannels: normalizeAudioChannelPreference(options.audioChannels || options.audioMode || options.channelMode),
      quality: normalizeQualityPreference(options.quality)
    };
    logger.info(`[hls] prepare file="${mediaFile.filePath}" requestedAudio=${options.audio || "default"} selectedAudio=${normalizedOptions.audio} subtitle=${normalizedOptions.subtitle} audioChannels=${normalizedOptions.audioChannels} quality=${normalizedOptions.quality}`);
    const cacheKey = await this.buildCacheKey(mediaFile.filePath, normalizedOptions);
    const cacheDir = path.join(this.config.hls.cachePath, cacheKey);
    const playlistPath = path.join(cacheDir, "master.m3u8");

    if (this.activeSetups.has(cacheKey)) {
      logger.info(`[hls] joining active ffmpeg setup cacheKey=${cacheKey}`);
      await this.activeSetups.get(cacheKey);
      return this.result(cacheKey, cacheDir, playlistPath);
    }

    if (this.activeTranscodes.has(cacheKey)) {
      this.touchTranscode(cacheKey);
      logger.info(`[hls] joining active transcode cacheKey=${cacheKey}`);
      return this.result(cacheKey, cacheDir, playlistPath);
    }

    if (await this.isUsableCache(cacheKey)) {
      logger.info(`[hls] cache hit cacheKey=${cacheKey} playlist="${playlistPath}"`);
      return this.result(cacheKey, cacheDir, playlistPath);
    }

    const existingManifest = await this.readManifestIfPresent(cacheKey);
    const resumeState = existingManifest ? await this.resumeState(cacheDir, existingManifest) : { complete: false, resumeFromSegment: 0 };
    if (resumeState.complete) {
      logger.info(`[hls] segment cache complete cacheKey=${cacheKey} playlist="${playlistPath}"`);
      return this.result(cacheKey, cacheDir, playlistPath);
    }
    const effectiveResumeState = canResumePartialTranscode(normalizedOptions)
      ? resumeState
      : { complete: false, resumeFromSegment: 0 };

    logger.info(`[hls] cache miss cacheKey=${cacheKey}; starting ffmpeg setup`);
    const setup = this.startHls(mediaFile, normalizedOptions, cacheDir, playlistPath, cacheKey, {
      resumeFromSegment: effectiveResumeState.resumeFromSegment,
      resumeFromSeconds: existingManifest
        ? segmentStartSeconds(existingManifest, effectiveResumeState.resumeFromSegment)
        : 0,
      preserveCache: Boolean(existingManifest),
      segmentTimeline: existingManifest && existingManifest.segments,
      sourceSignature: existingManifest && existingManifest.sourceSignature
    })
      .finally(() => this.activeSetups.delete(cacheKey));
    this.activeSetups.set(cacheKey, setup);

    await this.activeSetups.get(cacheKey);
    return this.result(cacheKey, cacheDir, playlistPath);
  }

  getCachedFilePath(cacheKey, filename) {
    if (!/^[a-f0-9]{24}$/.test(cacheKey) || filename.includes("/") || filename.includes("\\") || filename.includes("..")) {
      return null;
    }

    return path.join(this.config.hls.cachePath, cacheKey, filename);
  }

  async getPlaylist(cacheKey) {
    await this.ensureCacheFormat();
    const manifest = await this.readManifest(cacheKey);
    const publishedPlaylist = await readPublishedPlaylist(cacheKey, this.config.hls.cachePath);
    if (!publishedPlaylist || !isCompletePlaylist(publishedPlaylist)) {
      const cacheDir = path.join(this.config.hls.cachePath, cacheKey);
      const resumeState = await this.resumeState(cacheDir, manifest);
      if (!resumeState.complete) {
        await this.ensureActiveForCache(cacheKey, manifest, resumeState);
      }
    }

    return buildVodPlaylist(manifest);
  }

  async waitForCachedFile(cacheKey, filename) {
    await this.ensureCacheFormat();
    const filePath = this.getCachedFilePath(cacheKey, filename);
    if (!filePath) {
      return null;
    }

    const manifestPath = path.join(this.config.hls.cachePath, cacheKey, "stream.json");
    const timeoutMs = this.config.hls.segmentWaitTimeoutSeconds * 1000;
    const startedAt = Date.now();
    const segmentIndex = segmentFilenameIndex(filename);
    const manifest = segmentIndex === null ? null : await this.readManifestIfPresent(cacheKey);
    if (segmentIndex !== null && !manifest) {
      return {
        status: "missing",
        reason: "manifest-removed"
      };
    }
    if (manifest && segmentIndex >= manifest.segmentCount) {
      return {
        status: "missing",
        reason: "outside-manifest"
      };
    }

    if (manifest && !await isPublishedSegment(cacheKey, filename, this.config.hls.cachePath)) {
      await this.ensureActiveForSegment(cacheKey, manifest, segmentIndex);
    } else {
      this.touchTranscode(cacheKey);
    }

    let lastActivationAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      this.touchTranscode(cacheKey);
      if (await isPublishedSegment(cacheKey, filename, this.config.hls.cachePath)) {
        this.touchTranscode(cacheKey);
        return {
          status: "ready",
          filePath
        };
      }

      if (manifest && Date.now() - lastActivationAt >= SEEK_REASSERT_INTERVAL_MS) {
        await this.ensureActiveForSegment(cacheKey, manifest, segmentIndex);
        lastActivationAt = Date.now();
      }

      if (!await fileExists(manifestPath)) {
        return {
          status: "missing",
          reason: "manifest-removed"
        };
      }

      const publishedPlaylist = await readPublishedPlaylist(cacheKey, this.config.hls.cachePath);
      if (publishedPlaylist && isCompletePlaylist(publishedPlaylist)) {
        return {
          status: "missing",
          reason: "completed-playlist-missing-segment"
        };
      }

      await delay(300);
    }

    return {
      status: "pending",
      reason: "not-ready"
    };
  }

  async cleanupExpired() {
    await this.ensureCacheFormat();
    await fs.mkdir(this.config.hls.cachePath, { recursive: true });
    const entries = await fs.readdir(this.config.hls.cachePath, { withFileTypes: true });
    const now = Date.now();
    const ttlMs = this.config.hls.ttlSeconds * 1000;

    await Promise.all(entries.map(async (entry) => {
      if (!entry.isDirectory() || entry.name === KEYFRAME_CACHE_DIRECTORY) {
        return;
      }

      const dirPath = path.join(this.config.hls.cachePath, entry.name);
      if (this.progress && await this.progress.isCacheProtected(entry.name)) {
        return;
      }

      const stat = await fs.stat(dirPath);
      const releaseBaseMs = this.progress ? await this.progress.cacheReleaseBaseMs(entry.name) : 0;
      const ageBaseMs = Math.max(stat.mtimeMs, releaseBaseMs);
      if (now - ageBaseMs > ttlMs) {
        await fs.rm(dirPath, { recursive: true, force: true });
      }
    }));
  }

  async ensureCacheFormat() {
    if (!this.cacheFormatPromise) {
      this.cacheFormatPromise = this.initializeCacheFormat().catch((error) => {
        this.cacheFormatPromise = null;
        throw error;
      });
    }

    await this.cacheFormatPromise;
  }

  async initializeCacheFormat() {
    const cachePath = this.config.hls.cachePath;
    const markerPath = path.join(cachePath, HLS_CACHE_FORMAT_MARKER);
    await fs.mkdir(cachePath, { recursive: true });

    let previousVersion = null;
    try {
      previousVersion = (await fs.readFile(markerPath, "utf8")).trim();
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }

    if (previousVersion === HLS_CACHE_FORMAT_VERSION) {
      return;
    }

    const entries = await fs.readdir(cachePath, { withFileTypes: true });
    await Promise.all(entries.map((entry) => fs.rm(path.join(cachePath, entry.name), {
      recursive: true,
      force: true
    })));
    await fs.writeFile(markerPath, `${HLS_CACHE_FORMAT_VERSION}\n`, "utf8");
    logger.info(`[hls] cache format changed previous=${previousVersion || "none"} current=${HLS_CACHE_FORMAT_VERSION}; cleared cache="${cachePath}"`);
  }

  async segmentProgress(cacheKey, filename) {
    const segmentIndex = segmentFilenameIndex(filename);
    if (segmentIndex === null) {
      return null;
    }

    const manifest = await this.readManifestIfPresent(cacheKey);
    if (!manifest || segmentIndex >= manifest.segmentCount) {
      return null;
    }

    return {
      index: segmentIndex,
      startSeconds: segmentStartSeconds(manifest, segmentIndex),
      durationSeconds: segmentDuration(manifest, segmentIndex),
      mediaDurationSeconds: Number(manifest.duration) || 0,
      segmentCount: manifest.segmentCount,
      remainingSegments: manifest.segmentCount - segmentIndex - 1,
      isFinalSegment: segmentIndex === manifest.segmentCount - 1
    };
  }

  result(cacheKey, cacheDir, playlistPath) {
    return {
      cacheKey,
      cacheDir,
      playlistPath
    };
  }

  async buildCacheKey(filePath, options) {
    const stat = await sourceFileSignature(filePath);
    return crypto
      .createHash("sha1")
      .update(JSON.stringify({
        hlsFormatVersion: HLS_CACHE_FORMAT_VERSION,
        filePath,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        segmentSeconds: this.config.hls.segmentSeconds,
        options
      }))
      .digest("hex")
      .slice(0, 24);
  }

  async isUsableCache(cacheKey) {
    const playlistPath = path.join(this.config.hls.cachePath, cacheKey, "master.m3u8");
    try {
      const stat = await fs.stat(playlistPath);
      const ttlMs = this.config.hls.ttlSeconds * 1000;
      if (Date.now() - stat.mtimeMs > ttlMs) {
        return false;
      }

      const manifest = await this.readManifestIfPresent(cacheKey);
      if (!manifest) return false;
      const cacheDir = path.join(this.config.hls.cachePath, cacheKey);
      return (await this.resumeState(cacheDir, manifest)).complete;
    } catch (err) {
      if (err.code === "ENOENT") {
        return false;
      }

      throw err;
    }
  }

  async ensureActiveForCache(cacheKey, manifest = null, knownResumeState = null) {
    if (this.activeTranscodes.has(cacheKey)) {
      this.touchTranscode(cacheKey);
      return true;
    }

    if (this.activeSetups.has(cacheKey)) {
      logger.info(`[hls] joining active ffmpeg setup cacheKey=${cacheKey}`);
      await this.activeSetups.get(cacheKey);
      this.touchTranscode(cacheKey);
      return true;
    }

    const currentManifest = manifest || await this.readManifestIfPresent(cacheKey);
    if (!currentManifest || !currentManifest.inputPath || !currentManifest.options) {
      return false;
    }

    const cacheDir = path.join(this.config.hls.cachePath, cacheKey);
    const playlistPath = path.join(cacheDir, "master.m3u8");
    const resumeState = knownResumeState || await this.resumeState(cacheDir, currentManifest);
    if (resumeState.complete) {
      return true;
    }
    const effectiveResumeState = canResumePartialTranscode(currentManifest.options)
      ? resumeState
      : { complete: false, resumeFromSegment: 0 };

    logger.info(`[hls] restarting partial transcode cacheKey=${cacheKey} input="${currentManifest.inputPath}" resumeSegment=${effectiveResumeState.resumeFromSegment}`);
    const setup = this.startHls(
      { filePath: currentManifest.inputPath },
      currentManifest.options,
      cacheDir,
      playlistPath,
      cacheKey,
      {
        resumeFromSegment: effectiveResumeState.resumeFromSegment,
        resumeFromSeconds: segmentStartSeconds(currentManifest, effectiveResumeState.resumeFromSegment),
        preserveCache: true,
        segmentTimeline: currentManifest.segments,
        sourceSignature: currentManifest.sourceSignature
      }
    ).finally(() => this.activeSetups.delete(cacheKey));
    this.activeSetups.set(cacheKey, setup);
    await setup;
    this.touchTranscode(cacheKey);
    return true;
  }

  async ensureActiveForSegment(cacheKey, manifest, targetSegment) {
    const segmentIndex = Math.max(0, Number.parseInt(targetSegment, 10) || 0);
    const cacheDir = path.join(this.config.hls.cachePath, cacheKey);
    const filename = `segment_${String(segmentIndex).padStart(5, "0")}.ts`;
    if (await isPublishedSegment(cacheKey, filename, this.config.hls.cachePath)) {
      this.touchTranscode(cacheKey);
      return true;
    }

    if (this.activeSetups.has(cacheKey)) {
      logger.info(`[hls] joining active ffmpeg setup cacheKey=${cacheKey} requestedSegment=${segmentIndex}`);
      await this.activeSetups.get(cacheKey);
      if (await isPublishedSegment(cacheKey, filename, this.config.hls.cachePath)) return true;
    }

    const active = this.activeTranscodes.get(cacheKey);
    if (active) {
      const prioritySegment = Number.isInteger(active.prioritySegment) ? active.prioritySegment : null;
      const priorityPending = prioritySegment !== null
        && !await isPublishedSegment(cacheKey, `segment_${String(prioritySegment).padStart(5, "0")}.ts`, this.config.hls.cachePath);
      if (priorityPending) {
        logger.full(`[hls] joining active priority seek cacheKey=${cacheKey} requestedSegment=${segmentIndex} prioritySegment=${prioritySegment}`);
        this.touchTranscode(cacheKey);
        return true;
      }

      const bounds = await publishedSegmentBounds(cacheDir);
      if (!shouldRepositionTranscode(active, bounds, segmentIndex, manifest)) {
        active.prioritySegment = segmentIndex;
        this.touchTranscode(cacheKey);
        return true;
      }
    }

    return this.restartTranscodeForSeek(cacheKey, manifest, segmentIndex);
  }

  async restartTranscodeForSeek(cacheKey, manifest, targetSegment) {
    if (this.activeSetups.has(cacheKey)) {
      await this.activeSetups.get(cacheKey);
      return true;
    }

    const targetStartSeconds = segmentStartSeconds(manifest, targetSegment);
    const startSegment = seekPreRollSegment(manifest, targetSegment, SEEK_PRE_ROLL_SECONDS);
    const startSeconds = segmentStartSeconds(manifest, startSegment);
    const cacheDir = path.join(this.config.hls.cachePath, cacheKey);
    const playlistPath = path.join(cacheDir, "master.m3u8");
    const setup = (async () => {
      const active = this.activeTranscodes.get(cacheKey);
      if (active) await this.stopTranscodeForSeek(cacheKey, active, targetSegment);
      const targetFilename = `segment_${String(targetSegment).padStart(5, "0")}.ts`;
      if (await isPublishedSegment(cacheKey, targetFilename, this.config.hls.cachePath)) return;
      await removeTemporarySegments(cacheDir);
      logger.info(`[hls] repositioning transcode cacheKey=${cacheKey} input="${manifest.inputPath}" requestedSegment=${targetSegment} startSegment=${startSegment} requestedSeconds=${formatFfmpegSeconds(targetStartSeconds)} startSeconds=${formatFfmpegSeconds(startSeconds)}`);
      await this.startHls(
        { filePath: manifest.inputPath },
        manifest.options,
        cacheDir,
        playlistPath,
        cacheKey,
        {
          resumeFromSegment: startSegment,
          resumeFromSeconds: startSeconds,
          requestedSegment: targetSegment,
          preserveCache: true,
          segmentTimeline: manifest.segments,
          sourceSignature: manifest.sourceSignature
        }
      );
    })();
    const trackedSetup = setup.finally(() => {
      if (this.activeSetups.get(cacheKey) === trackedSetup) this.activeSetups.delete(cacheKey);
    });
    this.activeSetups.set(cacheKey, trackedSetup);
    await trackedSetup;
    this.touchTranscode(cacheKey);
    return true;
  }

  async resumeState(cacheDir, manifest) {
    if (!manifest || !Number.isFinite(Number(manifest.segmentCount))) {
      return { complete: false, resumeFromSegment: 0 };
    }

    let entries;
    try {
      entries = await fs.readdir(cacheDir);
    } catch (err) {
      if (err.code === "ENOENT") {
        return { complete: false, resumeFromSegment: 0 };
      }

      throw err;
    }

    const existingSegments = new Set(entries
      .map(segmentFilenameIndex)
      .filter((index) => index !== null));
    let resumeFromSegment = 0;
    while (existingSegments.has(resumeFromSegment)) {
      resumeFromSegment += 1;
    }

    const segmentCount = Number(manifest.segmentCount);
    return {
      complete: resumeFromSegment >= segmentCount,
      resumeFromSegment: Math.min(resumeFromSegment, Math.max(0, segmentCount - 1))
    };
  }

  touchTranscode(cacheKey) {
    const active = this.activeTranscodes.get(cacheKey);
    if (!active) {
      return;
    }

    active.lastAccessAt = Date.now();
    this.armTranscodeIdleTimer(cacheKey, active);
  }

  registerTranscode(cacheKey, state, armTimer = true) {
    this.activeTranscodes.set(cacheKey, state);
    if (armTimer) {
      this.armTranscodeIdleTimer(cacheKey, state);
    }
  }

  armTranscodeIdleTimer(cacheKey, active = this.activeTranscodes.get(cacheKey)) {
    if (!active || active.completed) {
      return;
    }

    if (active.idleTimer) {
      clearTimeout(active.idleTimer);
    }

    const timeoutMs = this.transcodeIdleTimeoutMs();
    active.idleTimer = setTimeout(() => {
      const current = this.activeTranscodes.get(cacheKey);
      if (!current || current !== active || current.completed) {
        return;
      }

      if (Date.now() - current.lastAccessAt >= timeoutMs) {
        this.stopTranscodeForIdle(cacheKey, current);
        return;
      }

      this.armTranscodeIdleTimer(cacheKey, current);
    }, timeoutMs);
    active.idleTimer.unref && active.idleTimer.unref();
  }

  stopTranscodeForIdle(cacheKey, active = this.activeTranscodes.get(cacheKey)) {
    if (!active || active.completed || active.stoppedForIdle) {
      return false;
    }

    active.stoppedForIdle = true;
    active.stopReason = "idle";
    logger.info(`[hls] stopping idle transcode cacheKey=${cacheKey} input="${active.inputPath}" idleSeconds=${Math.round((Date.now() - active.lastAccessAt) / 1000)}`);
    try {
      active.child.kill("SIGTERM");
    } catch (err) {
      logger.full(`[hls] idle transcode stop ignored cacheKey=${cacheKey} message="${err.message}"`);
    }
    const killTimer = setTimeout(() => {
      if (!active.completed) {
        try {
          active.child.kill("SIGKILL");
        } catch (err) {
          logger.full(`[hls] idle transcode force-stop ignored cacheKey=${cacheKey} message="${err.message}"`);
        }
      }
    }, 5000);
    killTimer.unref && killTimer.unref();
    return true;
  }

  async stopTranscodeForSeek(cacheKey, active, targetSegment) {
    if (!active || active.completed) return;
    active.stoppedForSeek = true;
    active.stopReason = "seek";
    if (active.idleTimer) clearTimeout(active.idleTimer);
    logger.info(`[hls] stopping transcode for seek cacheKey=${cacheKey} input="${active.inputPath}" currentStartSegment=${active.resumeFromSegment} requestedSegment=${targetSegment}`);
    try {
      active.child.kill("SIGTERM");
    } catch (err) {
      logger.full(`[hls] seek transcode stop ignored cacheKey=${cacheKey} message="${err.message}"`);
    }

    await Promise.race([
      active.exitPromise.catch(() => {}),
      delay(5000)
    ]);
    if (!active.completed) {
      try {
        active.child.kill("SIGKILL");
      } catch (err) {
        logger.full(`[hls] seek transcode force-stop ignored cacheKey=${cacheKey} message="${err.message}"`);
      }
      await Promise.race([
        active.exitPromise.catch(() => {}),
        delay(2000)
      ]);
    }
    if (!active.completed) {
      throw new Error(`Timed out stopping the active HLS transcode before seeking to segment ${targetSegment}`);
    }
  }

  transcodeIdleTimeoutMs() {
    const configuredSeconds = Number(this.config.hls.inactiveTranscodeTimeoutSeconds);
    if (Number.isFinite(configuredSeconds) && configuredSeconds > 0) {
      return Math.max(15, configuredSeconds) * 1000;
    }

    const segmentSeconds = Number(this.config.hls.segmentSeconds) || 6;
    return Math.max(30, segmentSeconds * 8) * 1000;
  }

  async startHls(mediaFile, options, cacheDir, playlistPath, cacheKey = path.basename(cacheDir), resume = {}) {
    const inputPath = mediaFile.filePath;
    let resumeFromSegment = Math.max(0, Number.parseInt(resume.resumeFromSegment, 10) || 0);
    let resumeFromSeconds = Math.max(0, Number(resume.resumeFromSeconds) || 0);
    let preserveCache = Boolean(resume.preserveCache);
    let reusableSegmentTimeline = resume.segmentTimeline;
    const initialSourceSignature = await sourceFileSignature(inputPath);
    if (resume.sourceSignature && !sourceSignaturesMatch(resume.sourceSignature, initialSourceSignature)) {
      logger.info(`[hls] source changed since its cached timeline was created; discarding partial HLS input="${inputPath}"`);
      resumeFromSegment = 0;
      resumeFromSeconds = 0;
      preserveCache = false;
      reusableSegmentTimeline = null;
    }
    logger.info(`[hls] start input="${inputPath}" cacheDir="${cacheDir}" playlist="${playlistPath}" audio=${options.audio} audioChannels=${options.audioChannels} quality=${options.quality} resumeSegment=${resumeFromSegment}`);
    await this.cleanupExpired();
    if (resumeFromSegment > 0 || preserveCache) {
      await fs.mkdir(cacheDir, { recursive: true });
      await fs.rm(playlistPath, { force: true });
    } else {
      await fs.rm(cacheDir, { recursive: true, force: true });
      await fs.mkdir(cacheDir, { recursive: true });
    }

    let probe = null;
    let hlsBuild = null;
    let verifiedSourceSignature = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const beforeSignature = await sourceFileSignature(inputPath);
      if (!sourceSignaturesMatch(resume.sourceSignature, beforeSignature)) {
        reusableSegmentTimeline = null;
      }
      try {
        probe = await this.ffmpeg.probe(inputPath, isAudioFile(inputPath)
          ? { analyzeduration: "1M", probesize: "1M" }
          : {});
        hlsBuild = await this.buildFfmpegArgs(inputPath, probe, options, playlistPath, {
          resumeFromSegment,
          resumeFromSeconds,
          segmentTimeline: reusableSegmentTimeline
        });
      } catch (error) {
        if (error.code !== "MEDIA_BAKER_SOURCE_CHANGED" || attempt === 3) throw error;
        logger.info(`[hls] source changed while indexing keyframes; re-checking before FFmpeg input="${inputPath}" attempt=${attempt + 1}`);
        if (preserveCache || resumeFromSegment > 0) {
          await fs.rm(cacheDir, { recursive: true, force: true });
          await fs.mkdir(cacheDir, { recursive: true });
          preserveCache = false;
          resumeFromSegment = 0;
          resumeFromSeconds = 0;
        }
        reusableSegmentTimeline = null;
        await delay(250);
        continue;
      }
      const afterSignature = await sourceFileSignature(inputPath);
      if (sourceSignaturesMatch(beforeSignature, afterSignature)) {
        verifiedSourceSignature = afterSignature;
        break;
      }
      if (attempt === 3) {
        throw new Error(`Media file kept changing while preparing HLS: ${inputPath}`);
      }
      logger.info(`[hls] source changed during HLS setup; probing replacement before FFmpeg input="${inputPath}" attempt=${attempt + 1}`);
      if (preserveCache || resumeFromSegment > 0) {
        await fs.rm(cacheDir, { recursive: true, force: true });
        await fs.mkdir(cacheDir, { recursive: true });
        preserveCache = false;
        resumeFromSegment = 0;
        resumeFromSeconds = 0;
      }
      reusableSegmentTimeline = null;
      await delay(250);
    }
    const manifest = buildManifest(probe, hlsBuild.segmentSeconds || this.config.hls.segmentSeconds, {
      independentSegments: hlsBuild.independentSegments,
      splitByTime: hlsBuild.splitByTime,
      segmentTimeline: hlsBuild.segmentTimeline,
      sourceSignature: verifiedSourceSignature,
      inputPath,
      options
    });
    await fs.writeFile(path.join(cacheDir, "stream.json"), JSON.stringify(manifest, null, 2));
    const args = hlsBuild.args;
    logger.full(`[ffmpeg] command ${quoteCommand(this.ffmpeg.ffmpegPath, args)}`);
    const child = this.ffmpeg.spawn(args);
    let stderr = "";

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (stderr.length > 20000) {
        stderr = stderr.slice(-20000);
      }
    });

    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });

    const exitPromise = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => {
        logger.full(`[ffmpeg] exit code=${code} input="${inputPath}"`);
        if (code === 0) {
          resolve();
          return;
        }

        reject(new Error(`ffmpeg exited with code ${code}: ${summarizeFfmpegOutput(stderr)}`));
      });
    });

    logger.info(`[hls] transcode launched input="${inputPath}" playlist="${playlistPath}"`);
    const active = {
      child,
      exitPromise,
      inputPath,
      cacheDir,
      resumeFromSegment,
      prioritySegment: Number.isInteger(resume.requestedSegment) ? resume.requestedSegment : null,
      lastAccessAt: Date.now(),
      stoppedForIdle: false,
      stoppedForSeek: false,
      stopReason: null,
      completed: false,
      idleTimer: null
    };
    this.registerTranscode(cacheKey, active, false);
    const cleanupActiveTranscode = () => {
      active.completed = true;
      if (active.idleTimer) {
        clearTimeout(active.idleTimer);
      }
      if (this.activeTranscodes.get(cacheKey) === active) {
        this.activeTranscodes.delete(cacheKey);
      }
    };
    try {
      await waitForInitialHlsSegment(
        path.join(cacheDir, `segment_${String(resumeFromSegment).padStart(5, "0")}.ts`),
        exitPromise,
        this.config.hls.segmentWaitTimeoutSeconds * 1000
      );
      active.lastAccessAt = Date.now();
      this.armTranscodeIdleTimer(cacheKey, active);
      logger.info(`[hls] playback ready input="${inputPath}" playlist="${playlistPath}" firstSegment=${resumeFromSegment}`);
      monitorTranscodeExit(exitPromise, active, cleanupActiveTranscode, cacheKey, inputPath, cacheDir);
    } catch (err) {
      active.stopReason = "startup-failed";
      if (!active.completed) {
        try {
          child.kill("SIGTERM");
        } catch (killErr) {
          logger.full(`[hls] startup stop ignored cacheKey=${cacheKey} message="${killErr.message}"`);
        }
        await Promise.race([
          exitPromise.catch(() => {}),
          delay(2000)
        ]);
        if (!active.completed) {
          try {
            child.kill("SIGKILL");
          } catch (killErr) {
            logger.full(`[hls] startup force-stop ignored cacheKey=${cacheKey} message="${killErr.message}"`);
          }
          await Promise.race([
            exitPromise.catch(() => {}),
            delay(1000)
          ]);
        }
      }
      cleanupActiveTranscode();
      logger.error(`[hls] ffmpeg failed before playback input="${inputPath}" error="${summarizeFfmpegOutput(err.message)}"; removing cacheDir="${cacheDir}"`);
      await fs.rm(cacheDir, { recursive: true, force: true });
      throw err;
    }
  }

  async keyframeTimelineFor(inputPath, probe, videoStream) {
    const targetSeconds = Math.max(1, Number(this.config.hls.segmentSeconds) || 6);
    const cacheDirectory = path.join(this.config.hls.cachePath, KEYFRAME_CACHE_DIRECTORY);
    const cacheName = crypto.createHash("sha1")
      .update(JSON.stringify({ inputPath, streamIndex: videoStream.index, targetSeconds }))
      .digest("hex");
    const cachePath = path.join(cacheDirectory, `${cacheName}.json`);
    const stat = await sourceFileSignature(inputPath);
    const signature = {
      version: 1,
      inputPath,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      streamIndex: videoStream.index,
      targetSeconds
    };
    const cached = await readJsonIfPresent(cachePath);
    if (cached && keyframeCacheMatches(cached, signature) && Array.isArray(cached.segments)) {
      logger.full(`[hls] keyframe timeline cache hit input="${inputPath}" segments=${cached.segments.length}`);
      return cached.segments;
    }
    if (this.keyframeSetups.has(cachePath)) {
      logger.info(`[hls] joining keyframe scan input="${inputPath}"`);
      return this.keyframeSetups.get(cachePath);
    }

    const setup = (async () => {
      const startedAt = Date.now();
      logger.info(`[hls] indexing source keyframes input="${inputPath}"`);
      const keyframes = await this.ffmpeg.probeVideoKeyframes(inputPath, videoStream.index, {
        inactivityTimeoutMs: Math.max(
          30000,
          Number(this.config.hls.segmentWaitTimeoutSeconds) * 1000 || 0
        )
      });
      const segments = buildKeyframeSegmentTimeline(
        keyframes,
        probe,
        videoStream,
        targetSeconds
      );
      const afterSignature = await sourceFileSignature(inputPath);
      if (!sourceSignaturesMatch(stat, afterSignature)) {
        const error = new Error(`Media file changed while indexing keyframes: ${inputPath}`);
        error.code = "MEDIA_BAKER_SOURCE_CHANGED";
        throw error;
      }
      await fs.mkdir(cacheDirectory, { recursive: true });
      await writeJsonAtomically(cachePath, { ...signature, segments });
      logger.info(`[hls] source keyframes indexed input="${inputPath}" keyframes=${keyframes.length} segments=${segments.length} durationMs=${Date.now() - startedAt}`);
      return segments;
    })().finally(() => this.keyframeSetups.delete(cachePath));
    this.keyframeSetups.set(cachePath, setup);
    return setup;
  }

  async buildFfmpegArgs(inputPath, probe, options, playlistPath, resume = {}) {
    const videoStream = isAudioFile(inputPath) ? null : selectVideoStream(probe);
    const audioStream = selectAudioStream(probe, options.audio);
    const audioMode = selectAudioMode(audioStream, options.audioChannels);
    if (!videoStream) {
      return this.buildAudioOnlyFfmpegArgs(inputPath, audioStream, audioMode, playlistPath, resume);
    }
    const subtitle = await this.selectSubtitle(inputPath, probe, options, audioStream);
    const qualityProfile = qualityProfileForProbe(probe, options.quality);
    const scaleFilter = transcodeScaleFilter(videoStream, qualityProfile.targetHeight);
    const compatibleH264 = isCompatibleH264Stream(videoStream);
    const forceCompatibleTranscode = this.config.hls.forceTranscodeCompatibleVideo
      && compatibleH264
      && !scaleFilter;
    const needsTranscode = {
      video: !compatibleH264 || Boolean(scaleFilter) || forceCompatibleTranscode || qualityProfile.forceTranscode,
      audio: true
    };
    const hardwareProfile = await this.ffmpeg.detectHardwareProfile();
    const hardwareEncoder = hardwareProfile.encoder;
    let videoCodec = needsTranscode.video || subtitle
      ? hardwareEncoder || "libx264"
      : "copy";
    let segmentTimeline = Array.isArray(resume.segmentTimeline) ? resume.segmentTimeline : null;
    if (videoCodec === "copy" && !segmentTimeline) {
      try {
        segmentTimeline = await this.keyframeTimelineFor(inputPath, probe, videoStream);
      } catch (error) {
        if (error.code === "MEDIA_BAKER_SOURCE_CHANGED") throw error;
        logger.info(`[hls] source keyframe index failed; using video transcode input="${inputPath}" message="${summarizeFfmpegOutput(error.message)}"`);
      }
    }
    if (videoCodec === "copy" && !isSafeCopiedSegmentTimeline(segmentTimeline)) {
      logger.info(`[hls] source keyframe spacing is unsuitable for responsive HLS; using video transcode input="${inputPath}"`);
      videoCodec = hardwareEncoder || "libx264";
      segmentTimeline = null;
      needsTranscode.video = true;
    }
    // MPEG-TS segments must carry independently usable AAC configuration. Some
    // container AAC tracks only provide that configuration in their first frame.
    const audioCodec = "aac";
    const useHardwareFrames = hardwareProfile.hardwareFrames === "cuda" && videoCodec === hardwareProfile.encoder && Boolean(scaleFilter || subtitle);
    const hardwareDownloadFilter = useHardwareFrames ? hardwareFrameDownloadFilter(hardwareProfile.hardwareFrames, videoStream) : null;
    const hardwareUploadFilter = videoCodec === hardwareProfile.encoder ? hardwareProfile.uploadFilter : null;
    logger.full(`[hls] selected video=${streamLog(videoStream)} compatibleH264=${compatibleH264} audio=${streamLog(audioStream)} audioMode=${audioMode.id} subtitle=${subtitleLog(subtitle)} quality=${qualityProfile.id} targetHeight=${qualityProfile.targetHeight || "original"} targetBitrate=${qualityProfile.targetBitrate || "auto"} scale=${scaleFilter || "none"} needsTranscode=${JSON.stringify(needsTranscode)} forceCompatibleTranscode=${Boolean(forceCompatibleTranscode)} hardwareVendor=${hardwareProfile.vendor || "none"} hardwareEncoder=${hardwareEncoder || "none"} hardwareDecoder=${hardwareProfile.decoder || "software"} videoCodec=${videoCodec} audioCodec=${audioCodec} hardwareFrames=${hardwareProfile.hardwareFrames || "none"} hardwareDownloadFilter=${hardwareDownloadFilter || "none"} hardwareUploadFilter=${hardwareUploadFilter || "none"} variableSegments=${Boolean(segmentTimeline)}`);
    const args = [
      "-hide_banner",
      "-y",
      "-fflags",
      "+genpts",
      "-analyzeduration",
      "100M",
      "-probesize",
      "100M"
    ];

    if (subtitle && subtitle.needsSubtitleDurationFix) {
      args.push("-fix_sub_duration");
    }

    if (videoCodec === hardwareProfile.encoder && hardwareProfile.inputArgs.length > 0) {
      args.push(...hardwareProfile.inputArgs);
    }

    if (useHardwareFrames && hardwareProfile.hwaccelArgs.length > 0) {
      args.push(...hardwareProfile.hwaccelArgs);
    }

    if (resume.resumeFromSeconds > 0) {
      args.push("-ss", formatFfmpegSeconds(resume.resumeFromSeconds));
    }

    args.push("-i", inputPath);

    const bitmapSubtitleFilter = subtitle && subtitle.bitmapSubtitleIndex !== undefined
      ? bitmapSubtitleFilterComplex(subtitle.bitmapSubtitleIndex, scaleFilter, hardwareDownloadFilter, hardwareUploadFilter)
      : null;

    if (bitmapSubtitleFilter) {
      args.push(
        "-filter_complex",
        bitmapSubtitleFilter,
        "-map",
        "[v]"
      );
    } else {
      args.push(
        "-map",
        "0:v:0"
      );
    }

    args.push(
      "-map",
      `0:${audioStream.index}`,
      "-sn",
      "-c:v",
      videoCodec,
      "-c:a",
      audioCodec
    );

    const subtitleSeekSeconds = subtitle && subtitle.videoFilter && resume.resumeFromSeconds > 0
      ? Number(resume.resumeFromSeconds)
      : 0;
    const videoFilter = bitmapSubtitleFilter ? null : composeFilters([
      useHardwareFrames && (scaleFilter || subtitle && subtitle.videoFilter) ? hardwareDownloadFilter : null,
      scaleFilter,
      useHardwareFrames && (scaleFilter || subtitle && subtitle.videoFilter) ? "format=yuv420p" : null,
      subtitleSeekSeconds > 0 ? `setpts=PTS+${formatFfmpegSeconds(subtitleSeekSeconds)}/TB` : null,
      subtitle && subtitle.videoFilter,
      subtitleSeekSeconds > 0 ? `setpts=PTS-${formatFfmpegSeconds(subtitleSeekSeconds)}/TB` : null,
      hardwareUploadFilter
    ]);
    if (videoFilter) {
      args.push("-vf", videoFilter);
    }

    if (subtitle && subtitle.type === "embedded" && !subtitle.burnable) {
      throw new Error(`English subtitle stream ${subtitle.index} uses unsupported codec ${subtitle.codecName}`);
    }

    if (audioCodec === "aac") {
      args.push("-af", composeFilters([
        audioMode.filter,
        "aresample=async=1000:first_pts=0"
      ]));
      if (audioMode.channels) {
        args.push("-ac", String(audioMode.channels));
      }
      args.push("-b:a", audioBitrate(audioMode));
    }

    if (videoCodec === "copy" && String(videoStream.codec_name || "").toLowerCase() === "h264") {
      // MP4 and Matroska commonly store AVC using length-prefixed NAL units.
      // MPEG-TS requires Annex B start codes; relying on the muxer's implicit
      // conversion is inconsistent across FFmpeg builds.
      args.push("-bsf:v", "h264_mp4toannexb");
    }

    if (videoCodec === "libx264") {
      args.push("-preset", "veryfast");
      if (qualityProfile.targetBitrate) {
        args.push(...videoBitrateArgs(qualityProfile.targetBitrate));
      } else {
        args.push("-crf", "21");
      }
    }

    args.push(...hardwareEncoderArgs(videoCodec, qualityProfile.targetBitrate));

    if (videoCodec !== "copy") {
      const gopSize = outputGopSize(videoStream, this.config.hls.segmentSeconds);
      if (videoCodec !== "h264_vaapi") {
        args.push("-pix_fmt", "yuv420p");
      }
      args.push(
        "-profile:v",
        "high",
        "-g",
        String(gopSize),
        "-keyint_min",
        String(gopSize),
        "-sc_threshold",
        "0",
        "-force_key_frames",
        `expr:gte(t,n_forced*${this.config.hls.segmentSeconds})`
      );
    }

    const hlsFlags = ["independent_segments", "temp_file"];

    if (resume.resumeFromSeconds > 0) {
      args.push("-output_ts_offset", formatFfmpegSeconds(resume.resumeFromSeconds));
    } else {
      args.push("-avoid_negative_ts", "make_zero");
    }

    args.push(
      "-max_interleave_delta",
      "0",
      "-f",
      "hls",
      "-hls_time",
      String(this.config.hls.segmentSeconds),
      "-hls_list_size",
      "0",
      "-hls_flags",
      hlsFlags.join("+"),
      "-start_number",
      String(Math.max(0, Number.parseInt(resume.resumeFromSegment, 10) || 0)),
      "-hls_segment_filename",
      path.join(path.dirname(playlistPath), "segment_%05d.ts"),
      playlistPath
    );

    return {
      args,
      independentSegments: hlsFlags.includes("independent_segments"),
      splitByTime: hlsFlags.includes("split_by_time"),
      segmentTimeline
    };
  }

  buildAudioOnlyFfmpegArgs(inputPath, audioStream, audioMode, playlistPath, resume = {}) {
    const audioCodec = audioStream.codec_name === "aac" && !audioMode.forceTranscode ? "copy" : "aac";
    const segmentSeconds = Math.min(2, this.config.hls.segmentSeconds);
    const args = [
      "-hide_banner", "-y",
      "-analyzeduration", "1M",
      "-probesize", "1M"
    ];
    if (resume.resumeFromSeconds > 0) {
      args.push("-ss", formatFfmpegSeconds(resume.resumeFromSeconds));
    }
    args.push(
      "-i", inputPath,
      "-map", `0:${audioStream.index}`,
      "-vn", "-sn",
      "-c:a", audioCodec
    );
    if (audioCodec === "aac") {
      if (audioMode.filter) {
        args.push("-af", audioMode.filter);
      }
      if (audioMode.channels) {
        args.push("-ac", String(audioMode.channels));
      }
      const channels = audioMode.channels || Number.parseInt(audioStream.channels, 10) || 2;
      args.push("-b:a", channels > 2 ? "512k" : "320k");
    }
    if (resume.resumeFromSeconds > 0) {
      args.push("-output_ts_offset", formatFfmpegSeconds(resume.resumeFromSeconds));
    }
    args.push(
      "-muxdelay", "0",
      "-f", "hls",
      "-hls_time", String(segmentSeconds),
      "-hls_list_size", "0",
      "-hls_flags", "split_by_time+temp_file",
      "-start_number", String(Math.max(0, Number.parseInt(resume.resumeFromSegment, 10) || 0)),
      "-hls_segment_filename", path.join(path.dirname(playlistPath), "segment_%05d.ts"),
      playlistPath
    );
    logger.full(`[hls] selected audio-only audio=${streamLog(audioStream)} audioMode=${audioMode.id} audioCodec=${audioCodec} segmentSeconds=${segmentSeconds}`);
    return { args, independentSegments: false, splitByTime: true, segmentSeconds, audioOnly: true };
  }

  async selectSubtitle(inputPath, probe, options, audioStream) {
    if (options.subtitle === "none") {
      logger.full("[hls] subtitles skipped because subtitle=none");
      return null;
    }

    const explicitExternal = externalSubtitleName(options.subtitle);
    if (explicitExternal) {
      const external = await findExternalSubtitleByName(inputPath, explicitExternal);
      if (!external) {
        throw new Error(`Requested sidecar subtitle was not found: ${explicitExternal}`);
      }

      logger.full(`[hls] selected requested external subtitle="${external}"`);
      return {
        type: "external",
        path: external,
        videoFilter: `subtitles=${escapeSubtitleFilterPath(external)}`
      };
    }

    const explicitCached = cachedSubtitleName(options.subtitle);
    if (explicitCached) {
      const cached = this.cachedSubtitlePath(explicitCached);
      if (!cached || !await fileExists(cached)) {
        throw new Error(`Requested cached subtitle was not found: ${explicitCached}`);
      }

      logger.full(`[hls] selected cached subtitle="${cached}"`);
      return {
        type: "cached",
        path: cached,
        videoFilter: `subtitles=${escapeSubtitleFilterPath(cached)}`
      };
    }

    const subtitles = (probe.streams || []).filter((stream) => stream.codec_type === "subtitle");
    const explicitSubtitle = streamIndex(options.subtitle);
    if (explicitSubtitle !== null) {
      const subtitleIndex = subtitles.findIndex((stream) => stream.index === explicitSubtitle);
      if (subtitleIndex === -1) {
        throw new Error(`Requested subtitle stream was not found: ${explicitSubtitle}`);
      }

      return subtitleFromStream(inputPath, subtitles[subtitleIndex], subtitleIndex);
    }

    if (options.subtitle === "auto" && !isJapaneseStream(audioStream)) {
      logger.full(`[hls] subtitles skipped because selected audio is not Japanese: ${streamLog(audioStream)}`);
      return null;
    }

    const external = await findEnglishExternalSubtitle(inputPath);
    if (external) {
      logger.full(`[hls] selected external English subtitle="${external}"`);
      return {
        type: "external",
        path: external,
        videoFilter: `subtitles=${escapeSubtitleFilterPath(external)}`
      };
    }

    const subtitleIndex = selectEnglishSubtitleIndex(subtitles);
    if (subtitleIndex === -1) {
      logger.full(`[hls] no English subtitle found; subtitleStreams=${JSON.stringify(subtitles.map(streamLog))}`);
      if (subtitles.length > 0) {
        throw new Error("Japanese audio was requested, but no English subtitle stream was found.");
      }

      throw new Error("Japanese audio was requested, but this media has no subtitles.");
    }

    const subtitleStream = subtitles[subtitleIndex];
    return subtitleFromStream(inputPath, subtitleStream, subtitleIndex);
  }

  async readManifest(cacheKey) {
    if (!/^[a-f0-9]{24}$/.test(cacheKey)) {
      throw new Error("Invalid HLS cache key");
    }

    const raw = await fs.readFile(path.join(this.config.hls.cachePath, cacheKey, "stream.json"), "utf8");
    return JSON.parse(raw);
  }

  async readManifestIfPresent(cacheKey) {
    try {
      return await this.readManifest(cacheKey);
    } catch (err) {
      if (err.code === "ENOENT") {
        return null;
      }

      throw err;
    }
  }

  cachedSubtitlePath(filename) {
    if (!filename || filename.includes("/") || filename.includes("\\") || filename.includes("..")) {
      return null;
    }

    return path.join(this.config.subtitles.cachePath, path.basename(filename));
  }
}

function subtitleFromStream(inputPath, subtitleStream, subtitleIndex) {
    const codecName = subtitleStream.codec_name || "unknown";
    if (isTextSubtitleCodec(codecName)) {
      logger.full(`[hls] selected embedded text English subtitle=${streamLog(subtitleStream)} relativeIndex=${subtitleIndex}`);
      return {
        type: "embedded",
        index: subtitleStream.index,
        relativeIndex: subtitleIndex,
        codecName,
        burnable: true,
        videoFilter: `subtitles=${escapeSubtitleFilterPath(inputPath)}:si=${subtitleIndex}`
      };
    }

    if (isBitmapSubtitleCodec(codecName)) {
      logger.full(`[hls] selected embedded bitmap English subtitle=${streamLog(subtitleStream)} relativeIndex=${subtitleIndex}`);
      return {
        type: "embedded",
        index: subtitleStream.index,
        relativeIndex: subtitleIndex,
        codecName,
        burnable: true,
        bitmapSubtitleIndex: subtitleIndex,
        needsSubtitleDurationFix: true
      };
    }

    logger.full(`[hls] selected English subtitle has unsupported codec=${codecName} stream=${streamLog(subtitleStream)}`);
    return {
      type: "embedded",
      index: subtitleStream.index,
      relativeIndex: subtitleIndex,
      codecName,
      burnable: false
    };
}

function quoteCommand(binaryPath, args) {
  return [binaryPath, ...args].map(quoteArg).join(" ");
}

function quoteArg(value) {
  const text = String(value);
  if (!text || /[\s"'[\];,()]/.test(text)) {
    return `"${text.replace(/"/g, '\\"')}"`;
  }

  return text;
}

function streamLog(stream) {
  if (!stream) {
    return "none";
  }

  const tags = stream.tags || {};
  const parts = [
    `index=${stream.index}`,
    `type=${stream.codec_type}`,
    `codec=${stream.codec_name || "unknown"}`
  ];

  if (tags.language) {
    parts.push(`lang=${tags.language}`);
  }
  if (tags.title) {
    parts.push(`title="${tags.title}"`);
  }
  if (stream.width && stream.height) {
    parts.push(`size=${stream.width}x${stream.height}`);
  }
  if (stream.pix_fmt) {
    parts.push(`pix_fmt=${stream.pix_fmt}`);
  }
  if (stream.bits_per_raw_sample) {
    parts.push(`bits=${stream.bits_per_raw_sample}`);
  }
  if (stream.profile) {
    parts.push(`profile="${stream.profile}"`);
  }

  return parts.join(" ");
}

function summarizeFfmpegOutput(output) {
  return String(output || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("frame="))
    .slice(-12)
    .join(" | ");
}

function subtitleLog(subtitle) {
  if (!subtitle) {
    return "none";
  }

  if (subtitle.type === "external") {
    return `external path="${subtitle.path}"`;
  }

  return `embedded index=${subtitle.index} relativeIndex=${subtitle.relativeIndex} codec=${subtitle.codecName} burnable=${subtitle.burnable}`;
}

function selectVideoStream(probe) {
  return (probe.streams || []).find((stream) => (
    stream.codec_type === "video"
    && Number(stream.disposition && stream.disposition.attached_pic) !== 1
  ));
}

function isCompatibleH264Stream(stream) {
  if (!stream || stream.codec_name !== "h264") {
    return false;
  }

  const pixelFormat = String(stream.pix_fmt || "").toLowerCase();
  const bitsPerRawSample = Number.parseInt(stream.bits_per_raw_sample || "8", 10);
  const compatiblePixelFormat = pixelFormat === "yuv420p" || pixelFormat === "nv12";
  const compatibleBitDepth = !Number.isFinite(bitsPerRawSample) || bitsPerRawSample <= 8;

  return compatiblePixelFormat && compatibleBitDepth;
}

function selectAudioStream(probe, preference) {
  const audioStreams = (probe.streams || []).filter((stream) => stream.codec_type === "audio");
  if (audioStreams.length === 0) {
    throw new Error("No audio stream found");
  }

  const requestedStream = streamIndex(preference);
  if (requestedStream !== null) {
    const audioStream = audioStreams.find((stream) => stream.index === requestedStream);
    if (!audioStream) {
      throw new Error(`Requested audio stream was not found: ${requestedStream}`);
    }

    return audioStream;
  }

  const languageAliases = preference === "japanese" ? ["jpn", "ja", "japanese"] : ["eng", "en", "english"];
  return audioStreams.find((stream) => languageAliases.includes(String(stream.tags && stream.tags.language || "").toLowerCase()))
    || audioStreams[0];
}

function normalizeSubtitlePreference(value) {
  if (!value || value === "auto") {
    return "auto";
  }

  const selected = String(value);
  if (["none", "off", "false", "0"].includes(selected.toLowerCase())) {
    return "none";
  }

  return selected;
}

function normalizeAudioChannelPreference(value) {
  const selected = String(value || "preserve").toLowerCase();
  if (["stereo", "mixdown", "stereo-mixdown", "stereomixdown"].includes(selected)) {
    return "stereo";
  }
  if (["5.1", "51", "surround", "surround51", "surround-5.1", "six-channel"].includes(selected)) {
    return "surround51";
  }
  if (["stabby", "stabby51", "stabby-5.1", "stabby5.1"].includes(selected)) {
    return "stabby51";
  }

  return "preserve";
}

function selectAudioMode(audioStream, preference) {
  if (preference === "stereo") {
    return {
      id: "stereo",
      forceTranscode: true,
      channels: 2,
      filter: null
    };
  }

  if (preference === "surround51") {
    return {
      id: "surround51",
      forceTranscode: false,
      channels: audioStream.codec_name === "aac" ? null : 6,
      filter: null
    };
  }

  if (preference === "stabby51") {
    return {
      id: "stabby51",
      forceTranscode: true,
      channels: null,
      filter: "channelmap=0|1|4|5|2|3"
    };
  }

  return {
    id: "preserve",
    forceTranscode: false,
    channels: null,
    filter: null
  };
}

function audioBitrate(audioMode) {
  return audioMode.id === "stereo" ? "160k" : "384k";
}

function streamIndex(value) {
  const match = String(value || "").match(/^stream:(\d+)$/);
  return match ? Number.parseInt(match[1], 10) : null;
}

function externalSubtitleName(value) {
  const match = String(value || "").match(/^external:(.+)$/);
  if (!match || match[1].includes("/") || match[1].includes("\\") || match[1].includes("..")) {
    return null;
  }

  return match[1];
}

function cachedSubtitleName(value) {
  const match = String(value || "").match(/^cached:(.+)$/);
  if (!match || match[1].includes("/") || match[1].includes("\\") || match[1].includes("..")) {
    return null;
  }

  return match[1];
}

function isJapaneseStream(stream) {
  if (!stream) {
    return false;
  }

  const tags = stream.tags || {};
  return /(^|[^a-z])(jpn|ja|japanese)([^a-z]|$)/i.test(`${tags.language || ""} ${tags.title || ""} ${tags.handler_name || ""}`);
}

function hardwareEncoderArgs(videoCodec, targetBitrate) {
  if (videoCodec === "h264_nvenc") {
    const args = [
      "-forced-idr",
      "1",
      "-no-scenecut",
      "1",
      "-preset",
      "p1",
      "-tune",
      "ll",
      "-rc",
      "vbr",
      "-cq",
      "24"
    ];
    if (targetBitrate) {
      args.push(...videoBitrateArgs(targetBitrate));
    } else {
      args.push(
        "-b:v",
        "0",
        "-maxrate",
        "16M",
        "-bufsize",
        "32M"
      );
    }

    args.push("-spatial-aq", "1");
    return args;
  }

  if (videoCodec === "h264_vaapi") {
    return ["-qp", vaapiQpForTargetBitrate(targetBitrate)];
  }

  if (videoCodec === "h264_qsv" || videoCodec === "h264_amf") {
    return targetBitrate ? videoBitrateArgs(targetBitrate) : ["-b:v", "5M", "-maxrate", "7M", "-bufsize", "10M"];
  }

  if (videoCodec === "h264_videotoolbox") {
    return targetBitrate ? ["-b:v", bitrateValue(targetBitrate)] : ["-b:v", "5M"];
  }

  return [];
}

function videoBitrateArgs(targetBitrate) {
  return [
    "-b:v",
    bitrateValue(targetBitrate),
    "-maxrate",
    bitrateValue(Math.round(targetBitrate * 1.4)),
    "-bufsize",
    bitrateValue(Math.round(targetBitrate * 2))
  ];
}

function vaapiQpForTargetBitrate(targetBitrate) {
  if (!targetBitrate) {
    return "24";
  }

  if (targetBitrate >= 10_000_000) {
    return "22";
  }
  if (targetBitrate >= 5_000_000) {
    return "24";
  }
  if (targetBitrate >= 2_500_000) {
    return "27";
  }
  return "30";
}

function bitrateValue(bitsPerSecond) {
  return `${Math.max(1, Math.round(bitsPerSecond / 1000))}k`;
}

function transcodeScaleFilter(videoStream, maxHeight) {
  if (!videoStream || !maxHeight || !videoStream.height || videoStream.height <= maxHeight) {
    return null;
  }

  return `scale=-2:${maxHeight}`;
}

function outputGopSize(videoStream, segmentSeconds) {
  const fps = frameRate(videoStream);
  return Math.max(1, Math.round(fps * segmentSeconds));
}

function frameRate(videoStream) {
  if (!videoStream) {
    return 24;
  }

  return parseFrameRate(videoStream.avg_frame_rate)
    || parseFrameRate(videoStream.r_frame_rate)
    || 24;
}

function parseFrameRate(value) {
  const text = String(value || "");
  const fraction = text.match(/^(\d+)\/(\d+)$/);
  if (fraction) {
    const numerator = Number.parseInt(fraction[1], 10);
    const denominator = Number.parseInt(fraction[2], 10);
    return denominator > 0 ? numerator / denominator : null;
  }

  const parsed = Number.parseFloat(text);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function composeFilters(filters) {
  return filters.filter(Boolean).join(",") || null;
}

function hardwareFrameDownloadFilter(frameType, videoStream) {
  if (frameType === "cuda") {
    return cudaFrameDownloadFilter(videoStream);
  }

  return null;
}

function cudaFrameDownloadFilter(videoStream) {
  return isTenBitVideo(videoStream) ? "hwdownload,format=p010le" : "hwdownload,format=nv12";
}

function isTenBitVideo(stream) {
  const pixelFormat = String(stream && stream.pix_fmt || "").toLowerCase();
  const bitsPerRawSample = Number.parseInt(stream && stream.bits_per_raw_sample || "", 10);
  const profile = String(stream && stream.profile || "").toLowerCase();

  return pixelFormat.includes("10") || pixelFormat.includes("p010") || bitsPerRawSample > 8 || profile.includes("10");
}

function bitmapSubtitleFilterComplex(subtitleIndex, scaleFilter, frameDownloadFilter, frameUploadFilter) {
  const uploadFilter = frameUploadFilter ? `,${frameUploadFilter}` : "";
  if (!scaleFilter && !frameDownloadFilter && !frameUploadFilter) {
    return `[0:v:0][0:s:${subtitleIndex}]overlay[v]`;
  }

  const baseFilter = composeFilters([
    frameDownloadFilter,
    scaleFilter,
    frameDownloadFilter ? "format=yuv420p" : null
  ]);

  if (!baseFilter) {
    return `[0:v:0][0:s:${subtitleIndex}]overlay${uploadFilter}[v]`;
  }

  if (!scaleFilter) {
    return `[0:v:0]${baseFilter}[base];[base][0:s:${subtitleIndex}]overlay${uploadFilter}[v]`;
  }

  return `[0:v:0]${baseFilter}[base];[0:s:${subtitleIndex}]${scaleFilter}[sub];[base][sub]overlay${uploadFilter}[v]`;
}

function isEnglishStream(stream) {
  const tags = stream.tags || {};
  return isEnglishText(tags.language) || isEnglishText(tags.title) || isEnglishText(tags.handler_name);
}

function selectEnglishSubtitleIndex(subtitles) {
  const scored = subtitles
    .map((stream, index) => ({ index, score: englishSubtitleScore(stream) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);

  return scored.length > 0 ? scored[0].index : -1;
}

function englishSubtitleScore(stream) {
  if (!isEnglishStream(stream)) {
    return 0;
  }

  const tags = stream.tags || {};
  const text = `${tags.language || ""} ${tags.title || ""} ${tags.handler_name || ""}`;
  let score = 10;

  if (/\b(full|dialogue|dialog|sdh|cc)\b/i.test(text)) {
    score += 5;
  }

  if (/\b(forced|signs?|songs?)\b/i.test(text)) {
    score -= 7;
  }

  return score;
}

function isTextSubtitleCodec(codecName) {
  return ["ass", "ssa", "subrip", "webvtt", "mov_text", "text"].includes(codecName);
}

function isBitmapSubtitleCodec(codecName) {
  return ["dvd_subtitle", "dvb_subtitle", "hdmv_pgs_subtitle", "xsub"].includes(codecName);
}

async function findEnglishExternalSubtitle(inputPath) {
  const parsed = path.parse(inputPath);
  const subtitleDir = parsed.dir || ".";
  const entries = await fs.readdir(subtitleDir, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isFile() && SUBTITLE_EXTENSIONS.includes(path.extname(entry.name).toLowerCase()))
    .map((entry) => subtitleCandidate(parsed, entry.name))
    .filter(Boolean);

  const english = candidates
    .filter((candidate) => candidate.language === "english")
    .sort((a, b) => b.score - a.score)[0];
  if (english) {
    return english.path;
  }

  const exact = candidates.filter((candidate) => candidate.language === "unknown" && candidate.exactBasename);
  if (candidates.length === 1 && exact.length === 1) {
    return exact[0].path;
  }

  return null;
}

async function findExternalSubtitleByName(inputPath, filename) {
  const parsed = path.parse(inputPath);
  const subtitleDir = parsed.dir || ".";
  const candidate = path.join(subtitleDir, filename);

  if (!SUBTITLE_EXTENSIONS.includes(path.extname(candidate).toLowerCase())) {
    return null;
  }

  try {
    await fs.access(candidate);
    return candidate;
  } catch (err) {
    if (err.code === "ENOENT") {
      return null;
    }

    throw err;
  }
}

function subtitleCandidate(video, filename) {
  const videoDir = video.dir || ".";
  const extension = path.extname(filename);
  const basename = path.basename(filename, extension);

  if (basename.toLowerCase() === video.name.toLowerCase()) {
    return {
      path: path.join(videoDir, filename),
      language: "unknown",
      score: 1,
      exactBasename: true
    };
  }

  const prefix = `${video.name}`.toLowerCase();
  if (!basename.toLowerCase().startsWith(prefix)) {
    return null;
  }

  const suffix = basename.slice(video.name.length);
  if (!/^[ ._-]+/.test(suffix)) {
    return null;
  }

  return {
    path: path.join(videoDir, filename),
    language: isEnglishText(suffix) ? "english" : "other",
    score: englishSubtitleTextScore(suffix),
    exactBasename: false
  };
}

function isEnglishText(value) {
  return /(^|[^a-z])(eng|en|english)([^a-z]|$)/i.test(String(value || ""));
}

function englishSubtitleTextScore(value) {
  let score = 10;
  const text = String(value || "");

  if (/\b(full|dialogue|dialog|sdh|cc)\b/i.test(text)) {
    score += 5;
  }

  if (/\b(forced|signs?|songs?)\b/i.test(text)) {
    score -= 7;
  }

  return score;
}

function buildManifest(probe, segmentSeconds, options = {}) {
  const duration = mediaDurationSeconds(probe);
  if (!duration) {
    throw new Error("Unable to determine media duration for synthetic HLS playlist");
  }

  const segments = normalizeSegmentTimeline(options.segmentTimeline, duration);
  const segmentCount = segments
    ? segments.length
    : Math.max(1, Math.ceil(duration / segmentSeconds));
  const targetDuration = segments
    ? Math.max(...segments.map((segment) => segment.durationSeconds))
    : segmentSeconds;
  return {
    version: 2,
    type: "synthetic-vod",
    duration,
    segmentSeconds,
    segmentCount,
    targetDuration: Math.ceil(targetDuration),
    independentSegments: Boolean(options.independentSegments),
    splitByTime: Boolean(options.splitByTime),
    ...(segments ? { segments } : {}),
    sourceSignature: options.sourceSignature || null,
    inputPath: options.inputPath || null,
    options: options.options || null
  };
}

function buildVodPlaylist(manifest) {
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:6",
    "#EXT-X-PLAYLIST-TYPE:VOD",
    ...(manifest.independentSegments ? ["#EXT-X-INDEPENDENT-SEGMENTS"] : []),
    `#EXT-X-TARGETDURATION:${Math.ceil(manifest.targetDuration || manifest.segmentSeconds)}`,
    "#EXT-X-MEDIA-SEQUENCE:0"
  ];

  for (let index = 0; index < manifest.segmentCount; index += 1) {
    lines.push(`#EXTINF:${segmentDuration(manifest, index).toFixed(3)},`);
    lines.push(`segment_${String(index).padStart(5, "0")}.ts`);
  }

  lines.push("#EXT-X-ENDLIST");
  return lines.join("\n");
}

function segmentDuration(manifest, index) {
  const timelineDuration = Number(manifest && manifest.segments && manifest.segments[index] && manifest.segments[index].durationSeconds);
  if (Number.isFinite(timelineDuration) && timelineDuration > 0) {
    return timelineDuration;
  }
  const segmentSeconds = Number(manifest.segmentSeconds) || 6;
  const duration = Number(manifest.duration) || segmentSeconds;
  const elapsed = index * segmentSeconds;
  const remaining = duration - elapsed;
  if (remaining <= 0) {
    return segmentSeconds;
  }

  return Math.min(segmentSeconds, remaining);
}

function segmentStartSeconds(manifest, index) {
  const timelineStart = Number(manifest && manifest.segments && manifest.segments[index] && manifest.segments[index].startSeconds);
  if (Number.isFinite(timelineStart) && timelineStart >= 0) {
    return timelineStart;
  }
  return Math.max(0, index) * (Number(manifest && manifest.segmentSeconds) || 6);
}

function normalizeSegmentTimeline(segments, duration) {
  if (!Array.isArray(segments) || segments.length === 0) return null;
  return segments.map((segment, index) => {
    const startSeconds = Math.max(0, Number(segment.startSeconds) || 0);
    const nextStart = Number(segments[index + 1] && segments[index + 1].startSeconds);
    const durationSeconds = Number.isFinite(nextStart)
      ? nextStart - startSeconds
      : duration - startSeconds;
    return {
      startSeconds: roundSeconds(startSeconds),
      durationSeconds: roundSeconds(Math.max(0.001, durationSeconds))
    };
  });
}

function buildKeyframeSegmentTimeline(keyframes, probe, videoStream, targetSeconds) {
  const duration = mediaDurationSeconds(probe);
  if (!duration || !Array.isArray(keyframes) || keyframes.length === 0) return [];
  const streamStart = Number.parseFloat(videoStream && videoStream.start_time);
  const formatStart = Number.parseFloat(probe && probe.format && probe.format.start_time);
  const origin = Number.isFinite(streamStart)
    ? streamStart
    : Number.isFinite(formatStart) ? formatStart : keyframes[0];
  const normalized = keyframes
    .map((timestamp) => Number(timestamp) - origin)
    .filter((timestamp) => Number.isFinite(timestamp) && timestamp >= -0.05 && timestamp < duration)
    .map((timestamp) => Math.max(0, timestamp))
    .sort((a, b) => a - b);
  if (normalized.length === 0 || normalized[0] > 0.5) return [];

  const starts = [0];
  for (const timestamp of normalized) {
    const currentStart = starts[starts.length - 1];
    if (timestamp >= currentStart + targetSeconds && duration - timestamp > 0.05) {
      starts.push(timestamp);
    }
  }
  return starts.map((startSeconds, index) => ({
    startSeconds: roundSeconds(startSeconds),
    durationSeconds: roundSeconds((starts[index + 1] || duration) - startSeconds)
  }));
}

function isSafeCopiedSegmentTimeline(segments) {
  return Array.isArray(segments)
    && segments.length > 0
    && segments.every((segment, index) => Number.isFinite(Number(segment.startSeconds))
      && Number.isFinite(Number(segment.durationSeconds))
      && Number(segment.durationSeconds) > 0
      && Number(segment.durationSeconds) <= MAXIMUM_COPIED_SEGMENT_SECONDS
      && (index > 0 || Number(segment.startSeconds) <= 0.5));
}

function seekPreRollSegment(manifest, targetSegment, preRollSeconds) {
  const targetStart = segmentStartSeconds(manifest, targetSegment);
  let startSegment = Math.max(0, targetSegment);
  while (startSegment > 0
    && targetStart - segmentStartSeconds(manifest, startSegment) < preRollSeconds) {
    startSegment -= 1;
  }
  return startSegment;
}

function roundSeconds(value) {
  return Math.round(Number(value) * 1000000) / 1000000;
}

function mediaDurationSeconds(probe) {
  const candidates = [
    probe && probe.format && probe.format.duration,
    ...(probe && Array.isArray(probe.streams) ? probe.streams.map((stream) => stream.duration) : [])
  ];

  for (const candidate of candidates) {
    const parsed = Number.parseFloat(candidate);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return null;
}

function escapeSubtitleFilterPath(filePath) {
  return filePath
    .replace(/\\/g, "/")
    .replace(/:/g, "\\\\:")
    .replace(/'/g, `${"\\".repeat(3)}'`)
    .replace(/([,;[\]])/g, "\\$1");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatFfmpegSeconds(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) {
    return "0";
  }

  return value.toFixed(3).replace(/\.?0+$/, "");
}

function shouldRepositionTranscode(active, bounds, targetSegment, manifest) {
  if (!active || active.completed || active.stopReason) return true;
  if (targetSegment < active.resumeFromSegment) return true;
  if (bounds.maximum !== null && targetSegment <= bounds.maximum) return true;
  const frontier = bounds.maximum === null ? active.resumeFromSegment : bounds.maximum;
  const frontierEnd = segmentStartSeconds(manifest, frontier) + segmentDuration(manifest, frontier);
  return segmentStartSeconds(manifest, targetSegment) > frontierEnd + SEEK_AHEAD_THRESHOLD_SECONDS;
}

async function publishedSegmentBounds(cacheDir) {
  let entries;
  try {
    entries = await fs.readdir(cacheDir);
  } catch (err) {
    if (err.code === "ENOENT") return { minimum: null, maximum: null };
    throw err;
  }
  const indexes = entries.map(segmentFilenameIndex).filter((index) => index !== null);
  return indexes.length === 0
    ? { minimum: null, maximum: null }
    : { minimum: Math.min(...indexes), maximum: Math.max(...indexes) };
}

async function removeTemporarySegments(cacheDir) {
  let entries;
  try {
    entries = await fs.readdir(cacheDir);
  } catch (err) {
    if (err.code === "ENOENT") return;
    throw err;
  }
  await Promise.all(entries
    .filter((filename) => filename.endsWith(".tmp"))
    .map((filename) => fs.rm(path.join(cacheDir, filename), { force: true })));
}

function canResumePartialTranscode(options) {
  return options && options.subtitle === "none";
}

function monitorTranscodeExit(exitPromise, active, cleanup, cacheKey, inputPath, cacheDir) {
  exitPromise
    .then(() => {
      cleanup();
      if (active.stopReason) {
        logger.info(`[hls] transcode stopped reason=${active.stopReason} cacheKey=${cacheKey} input="${inputPath}"`);
        return;
      }
      logger.info(`[hls] transcode process reached input end cacheKey=${cacheKey} input="${inputPath}"`);
    })
    .catch(async (err) => {
      cleanup();
      if (active.stopReason) {
        logger.info(`[hls] transcode stopped reason=${active.stopReason} cacheKey=${cacheKey} input="${inputPath}"`);
        return;
      }

      logger.error(`[hls] ffmpeg failed after playback started input="${inputPath}" error="${summarizeFfmpegOutput(err.message)}"; removing cacheDir="${cacheDir}"`);
      await fs.rm(cacheDir, { recursive: true, force: true });
    })
    .catch((err) => {
      logger.error(`[hls] ffmpeg exit cleanup failed cacheKey=${cacheKey} input="${inputPath}" message="${err.message}"`, err);
    });
}

async function waitForInitialHlsSegment(filePath, exitPromise, timeoutMs) {
  const exitState = { settled: false, error: null };
  exitPromise.then(
    () => { exitState.settled = true; },
    (err) => {
      exitState.settled = true;
      exitState.error = err;
    }
  );

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await fileExists(filePath)) {
      return;
    }
    if (exitState.error) {
      throw exitState.error;
    }
    if (exitState.settled) {
      throw new Error("FFmpeg exited without publishing an HLS segment");
    }
    await delay(50);
  }

  throw new Error("Timed out waiting for the first HLS segment");
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (err) {
    if (err.code === "ENOENT") {
      return false;
    }

    throw err;
  }
}

async function readJsonIfPresent(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function sourceFileSignature(filePath) {
  const stat = await fs.stat(filePath);
  return {
    size: stat.size,
    mtimeMs: stat.mtimeMs
  };
}

function sourceSignaturesMatch(left, right) {
  return Boolean(left && right)
    && Number(left.size) === Number(right.size)
    && Number(left.mtimeMs) === Number(right.mtimeMs);
}

function normalizedFilePath(filePath) {
  const normalized = path.normalize(String(filePath || ""));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function keyframeCacheMatches(cached, signature) {
  return cached.version === signature.version
    && cached.inputPath === signature.inputPath
    && Number(cached.size) === Number(signature.size)
    && Number(cached.mtimeMs) === Number(signature.mtimeMs)
    && Number(cached.streamIndex) === Number(signature.streamIndex)
    && Number(cached.targetSeconds) === Number(signature.targetSeconds);
}

async function writeJsonAtomically(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    await fs.writeFile(temporaryPath, JSON.stringify(value), "utf8");
    try {
      await fs.rename(temporaryPath, filePath);
    } catch (error) {
      if (!["EEXIST", "EPERM"].includes(error.code)) throw error;
      await fs.rm(filePath, { force: true });
      await fs.rename(temporaryPath, filePath);
    }
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
}

async function isPublishedSegment(cacheKey, filename, hlsCachePath) {
  return fileExists(path.join(hlsCachePath, cacheKey, filename));
}

async function readPublishedPlaylist(cacheKey, hlsCachePath) {
  try {
    return await fs.readFile(path.join(hlsCachePath, cacheKey, "master.m3u8"), "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      return null;
    }

    throw err;
  }
}

function isCompletePlaylist(playlist) {
  return String(playlist || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .includes("#EXT-X-ENDLIST");
}

function segmentFilenameIndex(filename) {
  const match = String(filename || "").match(/^segment_(\d{5})\.ts$/);
  return match ? Number.parseInt(match[1], 10) : null;
}

module.exports = { HlsService };
