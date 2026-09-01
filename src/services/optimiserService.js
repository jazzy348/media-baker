const fs = require("fs/promises");
const crypto = require("crypto");
const os = require("os");
const path = require("path");
const logger = require("../utils/logger");

const VIDEO_EXTENSIONS = new Set([".mkv", ".mp4", ".avi", ".mov", ".wmv", ".m4v", ".webm", ".ts", ".m2ts"]);
const OPTIMISABLE_LIBRARY_TYPES = new Set(["tv", "movies"]);
const SIMPLE_MP4_VIDEO_CODECS = new Set(["h264", "hevc"]);
const SIMPLE_MP4_AUDIO_CODECS = new Set(["aac", "ac3", "eac3", "mp3"]);
const MAX_FAILURES = 200;
const LOCK_STALE_MS = 15 * 60 * 1000;
const LOCK_HEARTBEAT_MS = 30 * 1000;
const SOURCE_STABILITY_MS = 60 * 1000;
const OPTIMISER_VIDEO_QP = "23";
const AUDIO_PACKET_TIMELINE_TOLERANCE_SECONDS = 1;
const PACKET_CONTENT_TOLERANCE_SECONDS = 1;
const VIDEO_PACKET_COUNT_TOLERANCE = 2;
const INTENTIONAL_GAP_THRESHOLD_SECONDS = 1;
const LANGUAGE_GROUPS = [
  ["eng", "en", "english"],
  ["jpn", "ja", "japanese"],
  ["fre", "fra", "fr", "french"],
  ["ger", "deu", "de", "german"],
  ["spa", "es", "spanish"],
  ["ita", "it", "italian"],
  ["por", "pt", "portuguese"],
  ["dut", "nld", "nl", "dutch"],
  ["chi", "zho", "zh", "chinese"],
  ["kor", "ko", "korean"],
  ["rus", "ru", "russian"],
  ["ara", "ar", "arabic"],
  ["pol", "pl", "polish"],
  ["swe", "sv", "swedish"],
  ["dan", "da", "danish"],
  ["fin", "fi", "finnish"],
  ["nor", "nob", "no", "norwegian"],
  ["tur", "tr", "turkish"],
  ["cze", "ces", "cs", "czech"],
  ["hun", "hu", "hungarian"]
];

class OptimiserService {
  constructor(config, ffmpeg, mediaIndex, appSettings = null, metadata = null) {
    this.config = config;
    this.ffmpeg = ffmpeg;
    this.mediaIndex = mediaIndex;
    this.appSettings = appSettings;
    this.metadata = metadata;
    this.timer = null;
    this.running = false;
    this.stopRequested = false;
    this.currentJobs = new Map();
    this.queueLauncher = null;
    this.queueState = null;
    this.pendingFullScans = new Set();
    this.failureSave = Promise.resolve();
    this.lastRun = null;
    this.instanceId = `${os.hostname()}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
  }

  start() {
    this.stop();
    const scanIntervalSeconds = optimiserScanIntervalSeconds(this.config);
    this.timer = setInterval(() => {
      this.run("schedule").catch((err) => {
        logger.error(`[optimiser] scheduled run failed message="${err.message}"`, err);
      });
    }, scanIntervalSeconds * 1000);
    this.timer.unref && this.timer.unref();
    logFull(`[optimiser] scheduler started enabled=${Boolean(this.config.optimizer && this.config.optimizer.enabled)} intervalSeconds=${scanIntervalSeconds}`);
    if (this.config.optimizer && this.config.optimizer.enabled) {
      this.run("startup").catch((err) => logger.error(`[optimiser] startup run failed message="${err.message}"`, err));
    }
  }

  restart() {
    if (!this.config.optimizer || !this.config.optimizer.enabled) {
      this.requestStop();
    }
    this.start();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  requestStop() {
    this.stopRequested = true;
    this.pendingFullScans.clear();
    for (const job of this.currentJobs.values()) {
      if (job.child) {
        job.child.kill("SIGTERM");
      }
    }
  }

  status() {
    const currentJobs = [...this.currentJobs.values()].map(publicCurrent);
    return {
      enabled: Boolean(this.config.optimizer && this.config.optimizer.enabled),
      scanIntervalSeconds: optimiserScanIntervalSeconds(this.config),
      parallelJobs: optimizerParallelJobs(this.config),
      running: this.running,
      current: currentJobs[0] || null,
      currentJobs,
      queue: publicQueue(this.queueState),
      lastRun: this.lastRun,
      failures: optimiserFailures(this.config),
      retryQueued: optimiserRetryQueue(this.config).length,
      pendingFullScans: [...this.pendingFullScans],
      libraries: optimiserLibraries(this.config)
    };
  }

  taskQueue(offset = 0, limit = 50) {
    if (!this.queueState) return { total: 0, offset: 0, items: [] };
    const start = Math.max(0, Number.parseInt(offset, 10) || 0);
    const size = Math.max(1, Math.min(Number.parseInt(limit, 10) || 50, 200));
    const nextIndex = Math.max(0, Number(this.queueState.nextIndex) || 0);
    const pending = (this.queueState.items || []).slice(nextIndex);
    return {
      total: pending.length,
      offset: start,
      items: pending.slice(start, start + size).map(publicQueueItem)
    };
  }

  async clearFailures() {
    await this.updateOptimiserState((optimizer) => {
      const failures = optimiserFailures({ optimizer });
      if (failures.length === 0) {
        return optimizer;
      }
      const retryQueue = mergeRetryEntries(
        optimiserRetryQueue({ optimizer }),
        failures.map((failure) => ({
          libraryKey: failure.libraryKey,
          filePath: failure.filePath,
          queuedAt: new Date().toISOString()
        }))
      );
      return {
        ...optimizer,
        failures: [],
        retryQueue
      };
    });
    return this.status();
  }

  startFullScan(libraryKey) {
    if (this.running) {
      this.pendingFullScans.add(libraryKey);
      const launched = this.nudgeQueue();
      logFull(`[optimiser] full scan queued library=${libraryKey} activeRunLaunched=${launched}`);
      return this.status();
    }
    this.run("full-scan", { libraryKey, ignoreWindow: true, ignoreCheckpoint: true }).catch((err) => {
      logger.error(`[optimiser] full scan failed library=${libraryKey} message="${err.message}"`, err);
    });
    return this.status();
  }

  async run(reason = "manual", options = {}) {
    if (this.running) {
      const launched = this.nudgeQueue();
      logFull(`[optimiser] run skipped reason=already-running trigger=${reason} launched=${launched}`);
      return this.status();
    }

    if (!this.config.optimizer || !this.config.optimizer.enabled) {
      this.lastRun = { at: new Date().toISOString(), reason, status: "skipped", message: "Optimiser is disabled" };
      logFull(`[optimiser] run skipped reason=disabled trigger=${reason}`);
      return this.status();
    }

    this.running = true;
    this.stopRequested = false;
    const startedAt = Date.now();
    let processed = 0;
    let skipped = 0;
    let failed = 0;
    let locked = 0;
    const parallelJobs = optimizerParallelJobs(this.config);

    try {
      const available = optimiserLibraries(this.config);
      await this.pruneRetryQueue(available.map((entry) => entry.key));
      const enabled = available.filter((entry) => entry.enabled);
      const targets = enabled
        .filter((entry) => options.libraryKey
          ? entry.key === options.libraryKey
          : options.ignoreWindow || inLibraryWindow(entry));
      logFull(`[optimiser] run started trigger=${reason} availableLibraries=${available.length} enabledLibraries=${enabled.length} targetLibraries=${targets.length} parallelJobs=${parallelJobs}`);
      if (targets.length === 0) {
        const message = enabled.length === 0
          ? "No optimiser-enabled libraries"
          : "No optimiser-enabled libraries are inside their run window";
        this.lastRun = {
          at: new Date().toISOString(),
          reason,
          status: "skipped",
          message,
          processed: 0,
          skipped: 0,
          failed: 0,
          durationSeconds: Math.round((Date.now() - startedAt) / 1000)
        };
        logFull(`[optimiser] run skipped message="${message}"`);
        return this.status();
      }

      for (const librarySettings of targets) {
        if (this.stopRequested) break;
        const library = this.config.libraries.find((entry) => entry.key === librarySettings.key);
        if (!isOptimisableLibrary(library)) {
          logFull(`[optimiser] library skipped key=${librarySettings.key} reason=unsupported-or-missing`);
          skipped += 1;
          continue;
        }
        let libraryProcessed = 0;
        const checkpointMs = options.ignoreCheckpoint ? 0 : Number(librarySettings.lastCheckedMs) || startedAt;
        const items = await this.libraryItems(library, checkpointMs);
        logFull(`[optimiser] library starting key=${library.key} type=${library.type} mode=${librarySettings.mode} files=${items.length} allDay=${librarySettings.allDay} window=${librarySettings.startTime}-${librarySettings.endTime} checkpointMs=${checkpointMs}`);
        const results = await this.optimizeLibraryItems(library, librarySettings, items);
        processed += results.processed;
        libraryProcessed = results.processed;
        skipped += results.skipped;
        failed += results.failed;
        locked += results.locked;
        if (libraryProcessed > 0) {
          logFull(`[optimiser] reindexing library=${library.key} processed=${libraryProcessed}`);
          await this.mediaIndex.reindexLibrary(library.key);
        }
        if (!this.stopRequested && results.locked === 0) {
          await this.saveLibraryCheckpoint(library.key, startedAt);
        } else if (results.locked > 0) {
          logFull(`[optimiser] checkpoint deferred library=${library.key} locked=${results.locked}`);
        }
        logFull(`[optimiser] library complete key=${library.key} processed=${libraryProcessed} locked=${results.locked}`);
      }

      this.lastRun = {
        at: new Date().toISOString(),
        reason,
        status: this.stopRequested ? "stopped" : "complete",
        processed,
        skipped,
        failed,
        locked,
        durationSeconds: Math.round((Date.now() - startedAt) / 1000)
      };
      logFull(`[optimiser] run ${this.lastRun.status} trigger=${reason} processed=${processed} skipped=${skipped} failed=${failed} locked=${locked} durationSeconds=${this.lastRun.durationSeconds}`);
    } finally {
      this.currentJobs.clear();
      this.queueLauncher = null;
      this.queueState = null;
      this.running = false;
      this.startNextPendingFullScan();
    }

    return this.status();
  }

  nudgeQueue() {
    if (typeof this.queueLauncher !== "function") {
      return 0;
    }
    return this.queueLauncher();
  }

  startNextPendingFullScan() {
    if (this.running || this.pendingFullScans.size === 0) {
      return;
    }
    const [libraryKey] = this.pendingFullScans;
    this.pendingFullScans.delete(libraryKey);
    setImmediate(() => {
      this.run("full-scan", { libraryKey, ignoreWindow: true, ignoreCheckpoint: true }).catch((err) => {
        logger.error(`[optimiser] queued full scan failed library=${libraryKey} message="${err.message}"`, err);
      });
    });
  }

  async libraryItems(library, sinceMs = 0) {
    const collection = await this.mediaIndex.loadCollection(library.key, library.type);
    const retryEntries = optimiserRetryQueue(this.config)
      .filter((entry) => entry.libraryKey === library.key);
    const retryPaths = new Set(retryEntries.map((entry) => comparableFilePath(entry.filePath)));
    const items = videoItemsFromCollection(collection, library.type)
      .filter((item) => item.filePath && VIDEO_EXTENSIONS.has(path.extname(item.filePath).toLowerCase()))
      .filter((item) => !isOptimiserSidecarPath(item.filePath))
      .filter((item) => sinceMs <= 0
        || mediaTimestampMs(item) > sinceMs
        || retryPaths.has(comparableFilePath(item.filePath)))
      .map((item) => retryPaths.has(comparableFilePath(item.filePath))
        ? { ...item, optimiserRetryQueued: true }
        : item);
    const indexedPaths = new Set(items.map((item) => comparableFilePath(item.filePath)));
    const staleRetries = [];

    for (const retry of retryEntries) {
      const comparablePath = comparableFilePath(retry.filePath);
      if (indexedPaths.has(comparablePath)) {
        continue;
      }
      try {
        const stat = await fs.stat(retry.filePath);
        if (!stat.isFile()
          || !VIDEO_EXTENSIONS.has(path.extname(retry.filePath).toLowerCase())
          || isOptimiserSidecarPath(retry.filePath)) {
          staleRetries.push(retry);
          continue;
        }
        items.push({
          filePath: retry.filePath,
          filename: path.basename(retry.filePath),
          title: path.parse(retry.filePath).name,
          mtimeMs: stat.mtimeMs,
          addedAtMs: stat.mtimeMs,
          optimiserRetryQueued: true
        });
        indexedPaths.add(comparablePath);
        logFull(`[optimiser] retry source resolved outside index library=${library.key} file="${retry.filePath}"`);
      } catch (err) {
        staleRetries.push(retry);
        logFull(`[optimiser] removing unavailable retry library=${library.key} file="${retry.filePath}" message="${err.message}"`);
      }
    }

    if (staleRetries.length > 0) {
      await this.removeRetryEntries(staleRetries);
    }
    return items;
  }

  async optimizeItem(library, item, settings, options = {}) {
    const sourceSnapshot = await stableSourceSnapshot(item.filePath);
    if (!sourceSnapshot) {
      logFull(`[optimiser] deferred changing source file="${item.filePath}"`);
      return "deferred";
    }

    const probe = await this.ffmpeg.probe(item.filePath);
    const preferredAudioLanguage = this.config.streaming.preferredAudioLanguage;
    const preferredSubtitleLanguage = optimiserSubtitleLanguage(this.config);
    const audioLanguages = {
      preferred: preferredAudioLanguage,
      secondary: settings.secondaryAudioLanguage,
      original: await this.originalLanguageForItem(library, item)
    };
    const streamPlan = createOptimiserStreamPlan(
      probe,
      settings,
      audioLanguages,
      preferredSubtitleLanguage
    );
    const outputPath = optimizedOutputPath(item.filePath, settings.mode, streamPlan);
    if (isAlreadyOptimized(item.filePath, probe, outputPath, settings, audioLanguages, preferredSubtitleLanguage)) {
      logFull(`[optimiser] skipped already-optimised file="${item.filePath}" mode=${settings.mode}`);
      return "skipped";
    }

    const lock = await claimOptimiserLock(item.filePath, this.instanceId, Boolean(options.allowStaleLockReclaim));
    if (!lock) {
      logFull(`[optimiser] skipped locked file="${item.filePath}"`);
      return "locked";
    }

    try {
      const lockedSourceSnapshot = await stableSourceSnapshot(item.filePath);
      if (!lockedSourceSnapshot
        || lockedSourceSnapshot.size !== sourceSnapshot.size
        || lockedSourceSnapshot.mtimeMs !== sourceSnapshot.mtimeMs) {
        logFull(`[optimiser] deferred source changed before lock file="${item.filePath}"`);
        return "deferred";
      }
      const tempPath = path.join(path.dirname(outputPath), `.${path.basename(outputPath)}.media-baker.tmp${path.extname(outputPath)}`);
      const videoTempPath = `${tempPath}.video.mkv`;
      const audioSourceTempPath = `${tempPath}.audio-source.mka`;
      const audioTempPaths = streamPlan.audio.map((_, index) => `${tempPath}.audio-${index}.mka`);
      const intermediatePaths = [tempPath, videoTempPath, audioSourceTempPath, ...audioTempPaths];
      const packetTimelineCache = new Map();
      await Promise.all(intermediatePaths.map((filePath) => fs.rm(filePath, { force: true })));
      const hardwareProfile = await this.ffmpeg.detectHardwareProfile(
        streamPlan.preserveHdr ? "hevc" : "h264"
      );
      const hardwareDecodeEnabled = await this.ffmpeg.canHardwareDecode(
        hardwareProfile,
        item.filePath,
        streamPlan.video.stream
      );
      const currentJob = createCurrentJob(library, item, outputPath, optimiserStageCount(streamPlan));
      this.currentJobs.set(currentJob.id, currentJob);
      let stageIndex = 0;
      logFull(`[optimiser] starting library=${library.key} mode=${settings.mode} input="${item.filePath}" output="${outputPath}"`);
      logFull(`[optimiser] retained streams ${describeStreamPlan(streamPlan)}`);
      try {
        let videoArgs = this.videoFfmpegArgs(
          item.filePath,
          videoTempPath,
          streamPlan,
          hardwareProfile,
          hardwareDecodeEnabled
        );
        logFull(
          `[optimiser] video pipeline encoder=${hardwareProfile.encoder || (streamPlan.preserveHdr ? "libx265" : "libx264")} `
          + `decoder=${hardwareDecodeEnabled ? hardwareProfile.decoder : "software"}`
        );
        logFull(`[optimiser] ffmpeg video ${videoArgs.map(quoteArg).join(" ")}`);
        beginOptimiserStage(currentJob, "video", "Encoding video", ++stageIndex);
        let videoResult;
        try {
          videoResult = await this.runFfmpeg(
            library,
            item,
            outputPath,
            videoTempPath,
            videoArgs,
            lock,
            streamPlan.video.durationSeconds,
            currentJob
          );
        } catch (err) {
          if (!hardwareDecodeEnabled || this.stopRequested) throw err;
          logFull(
            `[optimiser] hardware decode failed file="${item.filePath}" message="${err.message}"; `
            + "retrying video encode with software decode"
          );
          videoArgs = this.videoFfmpegArgs(
            item.filePath,
            videoTempPath,
            streamPlan,
            hardwareProfile,
            false
          );
          logFull(`[optimiser] ffmpeg video software-decode retry ${videoArgs.map(quoteArg).join(" ")}`);
          videoResult = await this.runFfmpeg(
            library,
            item,
            outputPath,
            videoTempPath,
            videoArgs,
            lock,
            streamPlan.video.durationSeconds,
            currentJob
          );
          if (videoResult === "complete") {
            this.ffmpeg.markHardwareDecodeFailed(hardwareProfile, streamPlan.video.stream, err.message);
          }
        }
        if (videoResult === "stopped") {
          return "stopped";
        }
        beginOptimiserStage(currentJob, "video-validation", "Validating video", ++stageIndex);
        await this.validateVideoOutput(
          item.filePath,
          videoTempPath,
          streamPlan.video,
          packetTimelineCache,
          validationProgressUpdater(currentJob)
        );
        completeOptimiserStage(currentJob);

        if (streamPlan.audio.length > 0) {
          let audioInputPath = item.filePath;
          if (streamPlan.audio.length > 1) {
            const extractArgs = this.audioSourceFfmpegArgs(item.filePath, audioSourceTempPath, streamPlan);
            logFull(`[optimiser] ffmpeg audio extraction ${extractArgs.map(quoteArg).join(" ")}`);
            beginOptimiserStage(currentJob, "audio-extraction", "Extracting retained audio", ++stageIndex);
            const extractResult = await this.runFfmpeg(
              library,
              item,
              outputPath,
              audioSourceTempPath,
              extractArgs,
              lock,
              Math.max(...streamPlan.audio.map((audio) => audio.durationSeconds)),
              currentJob
            );
            if (extractResult === "stopped") {
              return "stopped";
            }
            beginOptimiserStage(
              currentJob,
              "audio-extraction-validation",
              "Validating extracted audio",
              ++stageIndex
            );
            await this.validateAudioSourceOutput(
              item.filePath,
              audioSourceTempPath,
              streamPlan.audio,
              packetTimelineCache,
              validationProgressUpdater(currentJob)
            );
            completeOptimiserStage(currentJob);
            audioInputPath = audioSourceTempPath;
          }

          for (let index = 0; index < streamPlan.audio.length; index += 1) {
            const plannedAudio = streamPlan.audio[index];
            const inputSpecifier = streamPlan.audio.length > 1 ? `0:a:${index}` : `0:${plannedAudio.stream.index}`;
            const audioArgs = this.audioTrackFfmpegArgs(
              audioInputPath,
              audioTempPaths[index],
              plannedAudio,
              inputSpecifier,
              streamPlan.downmixToStereo
            );
            logFull(`[optimiser] ffmpeg audio track=${index + 1} ${audioArgs.map(quoteArg).join(" ")}`);
            beginOptimiserStage(
              currentJob,
              "audio",
              `Encoding audio track ${index + 1} of ${streamPlan.audio.length}`,
              ++stageIndex
            );
            const audioResult = await this.runFfmpeg(
              library,
              item,
              outputPath,
              audioTempPaths[index],
              audioArgs,
              lock,
              plannedAudio.durationSeconds,
              currentJob
            );
            if (audioResult === "stopped") {
              return "stopped";
            }
            beginOptimiserStage(
              currentJob,
              "audio-validation",
              `Validating audio track ${index + 1} of ${streamPlan.audio.length}`,
              ++stageIndex
            );
            await this.validateAudioOutput(
              item.filePath,
              audioTempPaths[index],
              plannedAudio,
              index,
              packetTimelineCache,
              streamPlan.downmixToStereo,
              validationProgressUpdater(currentJob)
            );
            completeOptimiserStage(currentJob);
          }
        }

        const muxArgs = this.muxFfmpegArgs(
          videoTempPath,
          audioTempPaths,
          item.filePath,
          tempPath,
          streamPlan,
          preferredSubtitleLanguage
        );
        logFull(`[optimiser] ffmpeg mux ${muxArgs.map(quoteArg).join(" ")}`);
        beginOptimiserStage(currentJob, "mux", "Assembling final file", ++stageIndex);
        const muxResult = await this.runFfmpeg(
          library,
          item,
          outputPath,
          tempPath,
          muxArgs,
          lock,
          mediaDurationSeconds(item, probe),
          currentJob
        );
        if (muxResult === "stopped") {
          return "stopped";
        }

        beginOptimiserStage(currentJob, "output-validation", "Validating final output", ++stageIndex);
        await this.validateOutput(
          tempPath,
          streamPlan,
          item.filePath,
          packetTimelineCache,
          validationProgressUpdater(currentJob)
        );
        completeOptimiserStage(currentJob);
        await assertSourceUnchanged(item.filePath, sourceSnapshot);
        await replaceOriginal(item.filePath, outputPath, tempPath);
      } catch (err) {
        await fs.rm(tempPath, { force: true }).catch(() => {});
        throw err;
      } finally {
        this.currentJobs.delete(currentJob.id);
        await Promise.all(intermediatePaths.slice(1).map((filePath) => fs.rm(filePath, { force: true }).catch(() => {})));
      }
      await this.removeFailureForFile(item.filePath);
      logFull(`[optimiser] complete input="${item.filePath}" output="${outputPath}"`);
      return "processed";
    } finally {
      await lock.release();
    }
  }

  async originalLanguageForItem(library, item) {
    if (!this.config.metadata || !this.config.metadata.enabled || !this.metadata
      || typeof this.metadata.getCachedOriginalLanguage !== "function") {
      return null;
    }
    try {
      return await this.metadata.getCachedOriginalLanguage(library.key, [item.showId, item.id]);
    } catch (err) {
      logFull(`[optimiser] original language lookup failed library=${library.key} id=${item.id} message="${err.message}"`);
      return null;
    }
  }

  async optimizeLibraryItems(library, settings, items) {
    let index = 0;
    let active = 0;
    let complete = false;
    this.updateQueueState(library, items, index, active);
    const results = {
      processed: 0,
      skipped: 0,
      failed: 0,
      locked: 0
    };

    return new Promise((resolve) => {
      const finish = () => {
        if (complete) {
          return;
        }
        complete = true;
        if (this.queueLauncher === launch) {
          this.queueLauncher = null;
        }
        if (this.queueState && this.queueState.libraryKey === library.key && this.queueState.items === items) {
          this.queueState = null;
        }
        resolve(results);
      };

      const launch = () => {
        this.updateQueueState(library, items, index, active);
        if (complete) {
          return 0;
        }

        if ((this.stopRequested || index >= items.length) && active === 0) {
          finish();
          return 0;
        }

        let launched = 0;
        const limit = Math.min(optimizerParallelJobs(this.config), items.length || 1);
        while (!this.stopRequested && active < limit && index < items.length) {
          const item = items[index];
          index += 1;
          if (!item) {
            break;
          }

          active += 1;
          launched += 1;
          this.updateQueueState(library, items, index, active);
          this.optimizeItem(library, item, settings, { allowStaleLockReclaim: index >= items.length })
            .catch(async (err) => {
              results.failed += 1;
              await this.recordFailure(library, item, settings, err);
              logger.error(`[optimiser] file failed library=${library.key} file="${item.filePath}" message="${err.message}"`, err);
              return "failed";
            })
            .then(async (result) => {
              if (item.optimiserRetryQueued && retryAttemptCompleted(result)) {
                await this.removeRetryForFile(library.key, item.filePath);
              }
              if (result === "processed") {
                results.processed += 1;
              } else if (result === "skipped" || result === "locked" || result === "deferred") {
                results.skipped += 1;
                if (result === "locked" || result === "deferred") {
                  results.locked += 1;
                }
              }
            })
            .finally(() => {
              active -= 1;
              this.updateQueueState(library, items, index, active);
              launch();
            });
        }

        if ((this.stopRequested || index >= items.length) && active === 0) {
          finish();
        }

        return launched;
      };

      this.queueLauncher = launch;
      launch();
    });
  }

  updateQueueState(library, items, nextIndex, active) {
    this.queueState = {
      libraryKey: library.key,
      libraryTitle: library.title || library.key,
      total: items.length,
      nextIndex,
      active,
      items
    };
  }

  async saveLibraryCheckpoint(libraryKey, timestampMs) {
    const currentLibraries = this.config.optimizer && this.config.optimizer.libraries || {};
    const nextLibraries = {
      ...currentLibraries,
      [libraryKey]: {
        ...(currentLibraries[libraryKey] || {}),
        lastCheckedMs: timestampMs
      }
    };

    if (this.appSettings && typeof this.appSettings.save === "function") {
      await this.appSettings.save({
        optimizer: {
          enabled: Boolean(this.config.optimizer && this.config.optimizer.enabled),
          libraries: nextLibraries
        }
      });
      return;
    }

    this.config.optimizer = {
      ...(this.config.optimizer || {}),
      libraries: nextLibraries
    };
  }

  async recordFailure(library, item, settings, err) {
    const failure = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      at: new Date().toISOString(),
      libraryKey: library.key,
      libraryTitle: library.title || library.key,
      title: item.title || item.filename || path.basename(item.filePath),
      filePath: item.filePath,
      mode: settings.mode === "all" ? "all" : "preferred",
      message: String(err && err.message || "Optimiser failed")
    };
    await this.updateFailures((failures) => [
      failure,
      ...failures.filter((entry) => entry.filePath !== item.filePath)
    ].slice(0, MAX_FAILURES));
  }

  async removeFailureForFile(filePath) {
    await this.updateFailures((failures) => {
      if (!failures.some((entry) => entry.filePath === filePath)) {
        return failures;
      }
      return failures.filter((entry) => entry.filePath !== filePath);
    });
  }

  async updateFailures(mutator) {
    return this.updateOptimiserState((optimizer) => {
      const currentFailures = optimiserFailures({ optimizer });
      const failures = mutator(currentFailures);
      return failures === currentFailures
        ? optimizer
        : { ...optimizer, failures };
    });
  }

  async removeRetryForFile(libraryKey, filePath) {
    await this.updateOptimiserState((optimizer) => {
      const retryQueue = optimiserRetryQueue({ optimizer });
      const comparablePath = comparableFilePath(filePath);
      if (!retryQueue.some((entry) => entry.libraryKey === libraryKey
        && comparableFilePath(entry.filePath) === comparablePath)) {
        return optimizer;
      }
      return {
        ...optimizer,
        retryQueue: retryQueue.filter((entry) => entry.libraryKey !== libraryKey
          || comparableFilePath(entry.filePath) !== comparablePath)
      };
    });
  }

  async removeRetryEntries(entries) {
    const keys = new Set(entries.map((entry) => (
      `${entry.libraryKey}\0${comparableFilePath(entry.filePath)}`
    )));
    await this.updateOptimiserState((optimizer) => {
      const retryQueue = optimiserRetryQueue({ optimizer });
      const filtered = retryQueue.filter((entry) => (
        !keys.has(`${entry.libraryKey}\0${comparableFilePath(entry.filePath)}`)
      ));
      return filtered.length === retryQueue.length
        ? optimizer
        : { ...optimizer, retryQueue: filtered };
    });
  }

  async pruneRetryQueue(libraryKeys) {
    const availableKeys = new Set(libraryKeys);
    await this.updateOptimiserState((optimizer) => {
      const retryQueue = optimiserRetryQueue({ optimizer });
      const filtered = retryQueue.filter((entry) => availableKeys.has(entry.libraryKey));
      return filtered.length === retryQueue.length
        ? optimizer
        : { ...optimizer, retryQueue: filtered };
    });
  }

  async updateOptimiserState(mutator) {
    const previous = this.failureSave.catch(() => {});
    const next = previous.then(async () => {
      const currentOptimizer = this.config.optimizer || {};
      const nextOptimizer = mutator(currentOptimizer);
      if (nextOptimizer === currentOptimizer) {
        return;
      }
      await this.saveOptimiserState(nextOptimizer);
    });
    this.failureSave = next;
    return next;
  }

  async saveOptimiserState(nextOptimizer) {
    if (this.appSettings && typeof this.appSettings.save === "function") {
      await this.appSettings.save({ optimizer: nextOptimizer }).catch((err) => {
        logger.error(`[optimiser] failed to save retry state message="${err.message}"`, err);
        throw err;
      });
      return;
    }

    this.config.optimizer = nextOptimizer;
  }

  videoFfmpegArgs(inputPath, outputPath, streamPlan, hardwareProfile, hardwareDecodeEnabled = false) {
    const videoEncoder = hardwareProfile.encoder || (streamPlan.preserveHdr ? "libx265" : "libx264");
    return [
      "-hide_banner",
      "-y",
      "-fflags",
      "+genpts+discardcorrupt",
      "-nostats",
      "-progress",
      "pipe:2",
      ...hardwareProfile.inputArgs,
      ...(hardwareDecodeEnabled ? hardwareProfile.hwaccelArgs : []),
      "-i",
      inputPath,
      "-map",
      `0:${streamPlan.video.stream.index}`,
      "-an",
      "-sn",
      "-dn",
      "-map_metadata",
      "-1",
      "-map_chapters",
      "-1",
      "-c:v",
      videoEncoder,
      ...videoEncodingArgs(videoEncoder, hardwareProfile, streamPlan, hardwareDecodeEnabled),
      ...timestampOutputArgs(),
      outputPath
    ];
  }

  audioSourceFfmpegArgs(inputPath, outputPath, streamPlan) {
    const args = [
      "-hide_banner",
      "-y",
      "-fflags",
      "+genpts+discardcorrupt",
      "-nostats",
      "-progress",
      "pipe:2",
      "-i",
      inputPath
    ];

    streamPlan.audio.forEach(({ stream }) => args.push("-map", `0:${stream.index}`));
    args.push(
      "-vn",
      "-sn",
      "-dn",
      "-map_chapters",
      "-1",
      "-c:a",
      "copy",
      outputPath
    );
    return args;
  }

  audioTrackFfmpegArgs(inputPath, outputPath, plannedAudio, inputSpecifier, downmixToStereo) {
    const args = [
      "-hide_banner",
      "-y",
      "-fflags",
      "+genpts+discardcorrupt",
      "-nostats",
      "-progress",
      "pipe:2",
      "-i",
      inputPath,
      "-map",
      inputSpecifier,
      "-vn",
      "-sn",
      "-dn",
      "-map_chapters",
      "-1",
      "-c:a",
      "aac",
      "-af",
      "asetpts=PTS-STARTPTS"
    ];
    if (downmixToStereo && Number(plannedAudio.stream && plannedAudio.stream.channels) > 2) {
      args.push("-ac", "2");
    }
    args.push(...timestampOutputArgs(), outputPath);
    return args;
  }

  muxFfmpegArgs(videoPath, audioPaths, inputPath, outputPath, streamPlan, preferredSubtitleLanguage = "english") {
    const args = [
      "-hide_banner",
      "-y",
      "-fflags",
      "+genpts+discardcorrupt",
      "-nostats",
      "-progress",
      "pipe:2",
      "-i",
      videoPath
    ];
    audioPaths.forEach((audioPath) => args.push("-i", audioPath));
    args.push("-i", inputPath);

    const sourceInputIndex = audioPaths.length + 1;
    args.push(
      "-map",
      "0:v:0",
      "-map_metadata",
      String(sourceInputIndex),
      "-map_chapters",
      String(sourceInputIndex)
    );

    streamPlan.audio.forEach((_, index) => args.push("-map", `${index + 1}:a:0`));
    streamPlan.subtitles.forEach(({ stream }) => args.push("-map", `${sourceInputIndex}:${stream.index}`));

    args.push(
      "-c:v",
      "copy",
      ...(streamPlan.audio.length > 0 ? ["-c:a", "copy"] : ["-an"]),
      ...subtitleEncodingArgs(streamPlan.subtitles, preferredSubtitleLanguage, outputPath)
    );
    if (path.extname(outputPath).toLowerCase() === ".mp4") {
      args.push("-movflags", "+faststart");
      if (streamPlan.preserveHdr) {
        args.push("-tag:v", "hvc1");
      }
    }
    args.push(...timestampOutputArgs(), outputPath);
    return args;
  }

  async validateOutput(outputPath, streamPlan, sourcePath, packetTimelineCache, onProgress = null) {
    const outputProbe = await this.ffmpeg.probe(outputPath, { analyzeduration: "10M", probesize: "10M" });
    const outputVideo = streamsOfType(outputProbe, "video");
    const outputAudio = streamsOfType(outputProbe, "audio");
    const outputSubtitles = streamsOfType(outputProbe, "subtitle");
    const expectedVideoCodec = streamPlan.preserveHdr ? "hevc" : "h264";
    if (outputVideo.length !== 1 || outputVideo[0].codec_name !== expectedVideoCodec) {
      throw new Error(
        `Optimised output validation failed: expected one ${videoCodecLabel(expectedVideoCodec)} video track, found ${outputVideo.length}`
      );
    }
    if (streamPlan.preserveHdr && (!isHdrVideo(outputVideo[0]) || !isTenBitVideo(outputVideo[0]))) {
      throw new Error("Optimised output validation failed: HDR colour information or 10-bit video was not preserved");
    }
    if (outputAudio.length !== streamPlan.audio.length || outputAudio.some((stream) => stream.codec_name !== "aac")) {
      throw new Error(`Optimised output validation failed: expected ${streamPlan.audio.length} AAC audio track(s), found ${outputAudio.length}`);
    }
    if (outputSubtitles.length !== streamPlan.subtitles.length) {
      throw new Error(`Optimised output validation failed: expected ${streamPlan.subtitles.length} subtitle track(s), found ${outputSubtitles.length}`);
    }

    const progress = combinedProgress(streamPlan.audio.length + 1, onProgress);
    await this.validatePacketTimeline(
      "video track",
      sourcePath,
      streamPlan.video.stream.index,
      outputPath,
      outputVideo[0].index,
      streamPlan.video.durationSeconds,
      packetTimelineCache,
      null,
      progress.forItem(0),
      "video"
    );
    await Promise.all(streamPlan.audio.map((source, index) => this.validatePacketTimeline(
      `audio track ${index + 1}`,
      sourcePath,
      source.stream.index,
      outputPath,
      outputAudio[index].index,
      source.durationSeconds,
      packetTimelineCache,
      AUDIO_PACKET_TIMELINE_TOLERANCE_SECONDS,
      progress.forItem(index + 1)
    )));
    progress.complete();
    streamPlan.audio.forEach((source, index) => {
      assertAudioChannelCount(`audio track ${index + 1}`, source.stream, outputAudio[index], streamPlan.downmixToStereo);
    });
  }

  async validateVideoOutput(sourcePath, outputPath, plannedVideo, packetTimelineCache, onProgress = null) {
    const outputProbe = await this.ffmpeg.probe(outputPath, { analyzeduration: "10M", probesize: "10M" });
    const outputVideo = streamsOfType(outputProbe, "video");
    const expectedVideoCodec = plannedVideo.preserveHdr ? "hevc" : "h264";
    if (outputVideo.length !== 1 || outputVideo[0].codec_name !== expectedVideoCodec) {
      throw new Error(
        `Optimised video pass failed: expected one ${videoCodecLabel(expectedVideoCodec)} video track, found ${outputVideo.length}`
      );
    }
    if (plannedVideo.preserveHdr && (!isHdrVideo(outputVideo[0]) || !isTenBitVideo(outputVideo[0]))) {
      throw new Error("Optimised video pass failed: HDR colour information or 10-bit video was not preserved");
    }
    await this.validatePacketTimeline(
      "video track",
      sourcePath,
      plannedVideo.stream.index,
      outputPath,
      outputVideo[0].index,
      plannedVideo.durationSeconds,
      packetTimelineCache,
      null,
      onProgress,
      "video"
    );
  }

  async validateAudioSourceOutput(
    sourcePath,
    outputPath,
    plannedAudio,
    packetTimelineCache,
    onProgress = null
  ) {
    const outputProbe = await this.ffmpeg.probe(outputPath, { analyzeduration: "10M", probesize: "10M" });
    const outputAudio = streamsOfType(outputProbe, "audio");
    if (outputAudio.length !== plannedAudio.length) {
      throw new Error(`Optimised audio extraction failed: expected ${plannedAudio.length} audio track(s), found ${outputAudio.length}`);
    }
    const progress = combinedProgress(plannedAudio.length, onProgress);
    await Promise.all(plannedAudio.map((source, index) => this.validatePacketTimeline(
      `extracted audio track ${index + 1}`,
      sourcePath,
      source.stream.index,
      outputPath,
      outputAudio[index].index,
      source.durationSeconds,
      packetTimelineCache,
      AUDIO_PACKET_TIMELINE_TOLERANCE_SECONDS,
      progress.forItem(index)
    )));
    progress.complete();
  }

  async validateAudioOutput(
    sourcePath,
    outputPath,
    plannedAudio,
    outputIndex,
    packetTimelineCache,
    downmixToStereo,
    onProgress = null
  ) {
    const outputProbe = await this.ffmpeg.probe(outputPath, { analyzeduration: "10M", probesize: "10M" });
    const outputAudio = streamsOfType(outputProbe, "audio");
    if (outputAudio.length !== 1 || outputAudio[0].codec_name !== "aac") {
      throw new Error(`Optimised audio pass failed: expected one AAC audio track, found ${outputAudio.length}`);
    }
    assertAudioChannelCount(`audio track ${outputIndex + 1}`, plannedAudio.stream, outputAudio[0], downmixToStereo);
    await this.validatePacketTimeline(
      `audio track ${outputIndex + 1}`,
      sourcePath,
      plannedAudio.stream.index,
      outputPath,
      outputAudio[0].index,
      plannedAudio.durationSeconds,
      packetTimelineCache,
      AUDIO_PACKET_TIMELINE_TOLERANCE_SECONDS,
      onProgress
    );
  }

  async validatePacketTimeline(
    label,
    sourcePath,
    sourceStreamIndex,
    outputPath,
    outputStreamIndex,
    expectedDurationSeconds,
    packetTimelineCache,
    toleranceSeconds = null,
    onProgress = null,
    streamType = "audio"
  ) {
    const edgeProgress = combinedProgress(2, rangedPercent(onProgress, 0, 40));
    const sourceTimeline = await this.cachedPacketTimeline(
      sourcePath,
      sourceStreamIndex,
      expectedDurationSeconds,
      packetTimelineCache,
      {
        fallbackToExpected: true,
        inactivityTimeoutMs: 30 * 1000,
        label,
        onProgress: edgeProgress.forItem(0)
      }
    );
    edgeProgress.setComplete(0);
    const outputTimeline = await this.cachedPacketTimeline(
      outputPath,
      outputStreamIndex,
      expectedDurationSeconds,
      packetTimelineCache,
      { onProgress: edgeProgress.forItem(1) }
    );
    edgeProgress.complete();
    try {
      assertMatchingPacketTimeline(label, sourceTimeline, outputTimeline, toleranceSeconds);
      reportPercent(onProgress, 100);
    } catch (timelineError) {
      await this.validatePacketContentStructure(
        label,
        sourcePath,
        sourceStreamIndex,
        outputPath,
        outputStreamIndex,
        expectedDurationSeconds,
        toleranceSeconds,
        timelineError,
        rangedPercent(onProgress, 40, 100),
        streamType
      );
      reportPercent(onProgress, 100);
    }
  }

  async validatePacketContentStructure(
    label,
    sourcePath,
    sourceStreamIndex,
    outputPath,
    outputStreamIndex,
    expectedDurationSeconds,
    toleranceSeconds,
    timelineError,
    onProgress = null,
    streamType = "audio"
  ) {
    logFull(
      `[optimiser] ${label} timeline drift detected; checking full `
      + (streamType === "video" ? "frame packet continuity" : "packet content and gap structure")
    );
    let sourceContent;
    let outputContent;
    const progress = combinedProgress(2, onProgress);
    try {
      [sourceContent, outputContent] = await Promise.all([
        this.ffmpeg.probePacketContentTimeline(sourcePath, sourceStreamIndex, {
          expectedDurationSeconds,
          onProgress: progress.forItem(0)
        }),
        this.ffmpeg.probePacketContentTimeline(outputPath, outputStreamIndex, {
          expectedDurationSeconds,
          onProgress: progress.forItem(1)
        })
      ]);
      progress.complete();
    } catch (err) {
      logFull(`[optimiser] ${label} full packet structure check unavailable message="${err.message}"`);
      throw timelineError;
    }
    assertMatchingPacketContentStructure(
      label,
      sourceContent,
      outputContent,
      toleranceSeconds,
      streamType === "video"
    );
    logFull(
      `[optimiser] ${label} timeline drift accepted because `
      + (streamType === "video" ? "frame packet continuity was preserved" : "packet content and intentional gaps were preserved")
    );
  }

  async cachedPacketTimeline(filePath, streamIndex, expectedDurationSeconds, cache, options = {}) {
    const key = `${filePath}:${streamIndex}:${expectedDurationSeconds}`;
    if (!cache.has(key)) {
      let pending = this.ffmpeg.probePacketTimeline(
        filePath,
        streamIndex,
        expectedDurationSeconds,
        {
          ...(options.inactivityTimeoutMs
            ? { inactivityTimeoutMs: options.inactivityTimeoutMs }
            : {}),
          onProgress: options.onProgress
        }
      );
      if (options.fallbackToExpected) {
        pending = pending.catch((err) => {
          logFull(
            `[optimiser] source ${options.label || "stream"} packet seek unavailable `
            + `file="${filePath}" stream=${streamIndex} message="${err.message}"; `
            + "validating output against mapped source duration"
          );
          return expectedPacketTimeline(expectedDurationSeconds);
        });
      }
      cache.set(key, pending);
    }
    return cache.get(key);
  }

  runFfmpeg(library, item, outputPath, tempPath, args, lock = null, durationSeconds = 0, job = null) {
    return new Promise((resolve, reject) => {
      const child = this.ffmpeg.spawn(args);
      let stderr = "";
      let settled = false;
      if (job) {
        job.durationSeconds = durationSeconds;
        job.stagePercent = 0;
        job.percent = overallJobPercent(job, 0);
        job.child = child;
      }

      child.stderr.on("data", (chunk) => {
        const text = chunk.toString();
        stderr += text;
        if (stderr.length > 16000) stderr = stderr.slice(-16000);
        const seconds = progressSecondsFromFfmpeg(stderr);
        if (job && seconds !== null && job.durationSeconds > 0) {
          job.stagePercent = Math.max(0, Math.min(100, Math.round(seconds / job.durationSeconds * 1000) / 10));
          job.percent = overallJobPercent(job, job.stagePercent);
        }
        if (lock && seconds !== null) {
          lock.touch().catch((err) => {
            logFull(`[optimiser] lock heartbeat failed file="${item.filePath}" message="${err.message}"`);
          });
        }
      });

      child.once("error", async (err) => {
        if (settled) return;
        settled = true;
        if (job) job.child = null;
        await fs.rm(tempPath, { force: true }).catch(() => {});
        reject(err);
      });
      child.once("close", async (code) => {
        if (settled) return;
        settled = true;
        if (job) job.child = null;
        if (this.stopRequested) {
          await fs.rm(tempPath, { force: true }).catch(() => {});
          resolve("stopped");
          return;
        }
        if (code === 0) {
          if (job) {
            job.stagePercent = 100;
            job.percent = overallJobPercent(job, 100);
          }
          resolve("complete");
          return;
        }
        await fs.rm(tempPath, { force: true }).catch(() => {});
        reject(new Error(`ffmpeg exited with code ${code}: ${summarize(stderr)}`));
      });
    });
  }
}

function optimiserLibraries(config) {
  const configured = config.optimizer && config.optimizer.libraries || {};
  return (config.libraries || [])
    .filter(isOptimisableLibrary)
    .map((library) => normalizeLibrarySettings(library, configured[library.key]));
}

function optimiserFailures(config) {
  return Array.isArray(config.optimizer && config.optimizer.failures)
    ? config.optimizer.failures
    : [];
}

function optimiserRetryQueue(config) {
  return Array.isArray(config.optimizer && config.optimizer.retryQueue)
    ? config.optimizer.retryQueue
    : [];
}

function mergeRetryEntries(current, additions) {
  const merged = [];
  const seen = new Set();
  [...current, ...additions].forEach((entry) => {
    if (!entry || !entry.libraryKey || !entry.filePath) {
      return;
    }
    const key = `${entry.libraryKey}\0${comparableFilePath(entry.filePath)}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    merged.push(entry);
  });
  return merged.slice(0, MAX_FAILURES);
}

function comparableFilePath(filePath) {
  const normalized = path.normalize(String(filePath || ""));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function retryAttemptCompleted(result) {
  return result === "processed" || result === "skipped" || result === "failed";
}

function optimizerParallelJobs(config) {
  const value = Number.parseInt(config.optimizer && config.optimizer.parallelJobs, 10);
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.max(1, Math.min(value, 8));
}

function optimiserScanIntervalSeconds(config) {
  const value = Number.parseInt(config.optimizer && config.optimizer.scanIntervalSeconds, 10);
  return Number.isFinite(value) ? Math.max(10, value) : 60;
}

function isOptimisableLibrary(library) {
  return Boolean(library && OPTIMISABLE_LIBRARY_TYPES.has(library.type));
}

function normalizeLibrarySettings(library, input = {}) {
  return {
    key: library.key,
    title: library.title,
    type: library.type,
    enabled: Boolean(input.enabled),
    mode: input.mode === "all" ? "all" : "preferred",
    downmixToStereo: Boolean(input.downmixToStereo),
    preserveHdr: Boolean(input.preserveHdr),
    allDay: Boolean(input.allDay),
    secondaryAudioLanguage: String(input.secondaryAudioLanguage || "").trim(),
    startTime: timeValue(input.startTime, "01:00"),
    endTime: timeValue(input.endTime, "06:00"),
    lastCheckedMs: nonNegativeNumber(input.lastCheckedMs, 0)
  };
}

function inLibraryWindow(settings) {
  if (settings.allDay) return true;
  const now = new Date();
  const current = now.getHours() * 60 + now.getMinutes();
  const start = timeMinutes(settings.startTime);
  const end = timeMinutes(settings.endTime);
  return start <= end
    ? current >= start && current < end
    : current >= start || current < end;
}

function videoItemsFromCollection(collection, type) {
  if (!collection) return [];
  if (type === "tv") {
    const episodes = (collection.shows || []).flatMap((show) => (
      (show.seasons || []).flatMap((season) => season.episodes || [])
    ));
    return [...episodes, ...(collection.items || [])];
  }
  return collection.items || [];
}

function mediaTimestampMs(item) {
  return Math.max(
    nonNegativeNumber(item && item.addedAtMs, 0),
    nonNegativeNumber(item && item.mtimeMs, 0)
  );
}

function isOptimiserSidecarPath(filePath) {
  const filename = path.basename(filePath || "").toLowerCase();
  return filename.includes(".media-baker.tmp.")
    || filename.endsWith(".media-baker.lock")
    || filename.endsWith(".media-baker-backup")
    || /\.optimized\.(mp4|mkv)$/i.test(filename);
}

function mediaDurationSeconds(item, probe) {
  return positiveNumber(item && item.durationSeconds)
    || positiveNumber(probe && probe.format && probe.format.duration)
    || Math.max(0, ...(probe && Array.isArray(probe.streams)
      ? probe.streams.map((stream) => positiveNumber(stream.duration))
      : [0]));
}

function durationTagSeconds(value) {
  const match = String(value || "").match(/^(\d+):(\d+):(\d+(?:\.\d+)?)$/);
  if (!match) return 0;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

function formatDuration(value) {
  const seconds = Math.max(0, Number(value) || 0);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  const remainder = Math.floor(seconds % 60);
  return [hours, minutes, remainder].map((part) => String(part).padStart(2, "0")).join(":");
}

function optimizedOutputPath(filePath, mode, streamPlan = null) {
  const parsed = path.parse(filePath);
  return path.join(parsed.dir, `${parsed.name}.${optimizedOutputExtension(mode, streamPlan)}`);
}

function optimizedOutputExtension(mode, streamPlan) {
  if (mode !== "all") {
    return "mp4";
  }

  const audioCount = streamPlan && streamPlan.audio ? streamPlan.audio.length : 0;
  const subtitleCount = streamPlan && streamPlan.subtitles ? streamPlan.subtitles.length : 0;
  return audioCount > 1 || subtitleCount > 0 ? "mkv" : "mp4";
}

function streamsOfType(probe, type) {
  return (probe && probe.streams || []).filter((stream) => stream.codec_type === type);
}

function selectPreferredAudio(audioStreams, preferredLanguage) {
  if (audioStreams.length === 0) return null;
  const programmeStreams = audioStreams.filter((stream) => !isAuxiliaryAudio(stream));
  const candidates = programmeStreams.length > 0 ? programmeStreams : audioStreams;
  return candidates.find((stream) => languageMatches(stream, preferredLanguage))
    || candidates.find((stream) => stream.disposition && stream.disposition.default)
    || candidates[0];
}

function selectRetainedAudio(audioStreams, languages = {}) {
  if (audioStreams.length === 0) return [];
  const programmeStreams = audioStreams.filter((stream) => !isAuxiliaryAudio(stream));
  const candidates = programmeStreams.length > 0 ? programmeStreams : audioStreams;
  const retainedLanguages = [languages.preferred, languages.original, languages.secondary]
    .map((language) => String(language || "").trim())
    .filter(Boolean);
  const retained = candidates.filter((stream) => (
    retainedLanguages.some((language) => languageMatches(stream, language))
  ));
  return retained.length > 0 ? retained : [selectPreferredAudio(candidates, languages.preferred)].filter(Boolean);
}

function selectOneAudioPerLanguage(audioStreams, languages = {}) {
  const selected = new Map();
  audioStreams.forEach((stream) => {
    const languageKey = retainedAudioLanguageKey(stream, languages) || `stream:${stream.index}`;
    const current = selected.get(languageKey);
    if (!current || downmixSourceScore(stream) > downmixSourceScore(current)) {
      selected.set(languageKey, stream);
    }
  });
  return [...selected.values()];
}

function retainedAudioLanguageKey(stream, languages) {
  const matched = [languages.preferred, languages.original, languages.secondary]
    .map((language) => String(language || "").trim())
    .find((language) => language && languageMatches(stream, language));
  return matched ? languageAliases(matched)[0] : streamLanguageKey(stream);
}

function downmixSourceScore(stream) {
  const channels = Number(stream && stream.channels) || 0;
  let score = channels > 0 && channels <= 2 ? 100 : 0;
  if (channels === 2) score += 10;
  if (stream && stream.disposition && stream.disposition.default) score += 20;
  return score;
}

function selectRetainedSubtitles(subtitleStreams, preferredLanguage) {
  const matching = subtitleStreams.filter((stream) => languageMatches(stream, preferredLanguage));
  const full = bestSubtitle(matching.filter((stream) => !isForcedSubtitle(stream)), false);
  const forced = bestSubtitle(matching.filter(isForcedSubtitle), true);
  return [
    full ? { stream: full, forced: false } : null,
    forced ? { stream: forced, forced: true } : null
  ].filter(Boolean);
}

function createOptimiserStreamPlan(probe, settings, audioLanguages, preferredSubtitleLanguage) {
  const video = streamsOfType(probe, "video")[0];
  if (!video) {
    throw new Error("Optimiser could not find a video track");
  }
  const preserveHdr = Boolean(settings.preserveHdr && isHdrVideo(video));

  const sourceAudio = streamsOfType(probe, "audio");
  const preferredAudio = selectPreferredAudio(sourceAudio, audioLanguages.preferred);
  let retainedAudio = settings.mode === "all"
    ? selectRetainedAudio(sourceAudio, audioLanguages)
    : preferredAudio ? [preferredAudio] : [];
  if (settings.downmixToStereo) {
    retainedAudio = selectOneAudioPerLanguage(retainedAudio, audioLanguages);
  }
  const retainedSubtitles = settings.mode === "all"
    ? selectRetainedSubtitles(streamsOfType(probe, "subtitle"), preferredSubtitleLanguage)
    : [];

  return {
    mode: settings.mode,
    downmixToStereo: settings.downmixToStereo,
    preserveHdr,
    video: {
      ...plannedStream(video, probe),
      preserveHdr
    },
    audio: retainedAudio.map((stream) => plannedStream(stream, probe)),
    subtitles: retainedSubtitles.map((subtitle) => ({
      ...subtitle,
      durationSeconds: streamDurationSeconds(subtitle.stream, probe)
    }))
  };
}

function plannedStream(stream, probe) {
  const durationSeconds = streamDurationSeconds(stream, probe);
  if (durationSeconds <= 0) {
    throw new Error(`Optimiser could not determine the duration of ${stream.codec_type} stream ${stream.index}`);
  }
  return { stream, durationSeconds };
}

function streamDurationSeconds(stream, probe) {
  return durationTagSeconds(stream && stream.tags && stream.tags.DURATION)
    || positiveNumber(stream && stream.duration)
    || streamTimeBaseDurationSeconds(stream)
    || streamFrameDurationSeconds(stream)
    || positiveNumber(probe && probe.format && probe.format.duration);
}

function streamTimeBaseDurationSeconds(stream) {
  const durationTicks = positiveNumber(stream && stream.duration_ts);
  const timeBase = rationalNumber(stream && stream.time_base);
  return durationTicks > 0 && timeBase > 0 ? durationTicks * timeBase : 0;
}

function streamFrameDurationSeconds(stream) {
  const frames = positiveNumber(stream && stream.nb_frames);
  const frameRate = rationalNumber(stream && (stream.avg_frame_rate || stream.r_frame_rate));
  return frames > 0 && frameRate > 0 ? frames / frameRate : 0;
}

function rationalNumber(value) {
  const match = String(value || "").match(/^(-?\d+)\/(-?\d+)$/);
  if (!match || Number(match[2]) === 0) {
    return positiveNumber(value);
  }
  return Number(match[1]) / Number(match[2]);
}

function describeStreamPlan(plan) {
  const video = `video=${plan.video.stream.index}:${formatDuration(plan.video.durationSeconds)}`;
  const audio = plan.audio.map(({ stream, durationSeconds }) => (
    `${stream.index}:${streamLanguageKey(stream) || "unknown"}:${formatDuration(durationSeconds)}`
  )).join(",");
  const subtitles = plan.subtitles.map(({ stream, forced, durationSeconds }) => (
    `${stream.index}:${streamLanguageKey(stream) || "unknown"}${forced ? ":forced" : ""}:${formatDuration(durationSeconds)}`
  )).join(",");
  return `${video} audio=[${audio}] subtitles=[${subtitles}]`;
}

function bestSubtitle(streams, forced) {
  return streams
    .map((stream, order) => ({ stream, order, score: subtitleScore(stream, forced) }))
    .sort((left, right) => right.score - left.score || left.order - right.order)[0]?.stream || null;
}

function subtitleScore(stream, forced) {
  const title = String(stream && stream.tags && stream.tags.title || "").toLowerCase();
  const codec = String(stream && stream.codec_name || "").toLowerCase();
  let score = 0;
  if (stream.disposition && stream.disposition.default) score += 30;
  if (["ass", "ssa"].includes(codec)) score += 25;
  else if (["subrip", "webvtt", "mov_text"].includes(codec)) score += 20;
  else if (codec === "hdmv_pgs_subtitle") score += 5;
  if (/\bmain\b/.test(title)) score += 15;
  if (/\b(?:sdh|cc|hearing impaired)\b/.test(title)) score -= 15;
  if (/\bdub\b/.test(title)) score -= 10;
  if (forced && stream.disposition && stream.disposition.forced) score += 40;
  if (forced && /\b(?:forced|signs?|songs?)\b/.test(title)) score += 30;
  return score;
}

function subtitleEncodingArgs(subtitles, preferredLanguage, outputPath) {
  if (subtitles.length === 0) return ["-sn"];
  const args = ["-c:s", "copy"];
  const outputExtension = path.extname(outputPath).toLowerCase();
  const languageName = displayLanguageName(preferredLanguage);
  subtitles.forEach((subtitle, outputIndex) => {
    if (outputExtension === ".mkv"
      && String(subtitle.stream && subtitle.stream.codec_name || "").toLowerCase() === "mov_text") {
      args.push(`-c:s:${outputIndex}`, "srt");
    }
    args.push(
      `-metadata:s:s:${outputIndex}`,
      `title=${languageName}${subtitle.forced ? " Forced" : ""}`,
      `-disposition:s:${outputIndex}`,
      subtitle.forced ? "forced" : "0"
    );
  });
  return args;
}

function isAuxiliaryAudio(stream) {
  const disposition = stream && stream.disposition || {};
  const title = String(stream && stream.tags && stream.tags.title || "").toLowerCase();
  return Boolean(disposition.comment || disposition.visual_impaired)
    || /\b(?:commentary|audio description|descriptive audio|described video|director(?:'s)? comments?)\b/.test(title);
}

function isForcedSubtitle(stream) {
  const title = String(stream && stream.tags && stream.tags.title || "").toLowerCase();
  return Boolean(stream && stream.disposition && stream.disposition.forced)
    || /\b(?:forced|signs?|songs?)\b/.test(title);
}

function languageMatches(stream, preferredLanguage) {
  const language = String(stream && stream.tags && stream.tags.language || "").trim().toLowerCase();
  const title = String(stream && stream.tags && stream.tags.title || "").toLowerCase();
  return languageAliases(preferredLanguage).some((alias) => (
    language === alias || new RegExp(`(?:^|[^a-z])${escapeRegExp(alias)}(?:$|[^a-z])`, "i").test(title)
  ));
}

function streamLanguageKey(stream) {
  const language = String(stream && stream.tags && stream.tags.language || "").trim().toLowerCase();
  if (language && language !== "und") {
    const group = LANGUAGE_GROUPS.find((aliases) => aliases.includes(language));
    return group ? group[0] : language;
  }
  const title = String(stream && stream.tags && stream.tags.title || "").toLowerCase();
  const group = LANGUAGE_GROUPS.find((aliases) => aliases.some((alias) => (
    new RegExp(`(?:^|[^a-z])${escapeRegExp(alias)}(?:$|[^a-z])`, "i").test(title)
  )));
  return group ? group[0] : null;
}

function languageAliases(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return [];
  return LANGUAGE_GROUPS.find((aliases) => aliases.includes(normalized)) || [normalized];
}

function displayLanguageName(value) {
  const aliases = languageAliases(value);
  const name = aliases.find((alias) => alias.length > 3) || String(value || "Subtitle");
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isAlreadyOptimized(filePath, probe, outputPath, settings, audioLanguages, preferredSubtitleLanguage) {
  const video = streamsOfType(probe, "video")[0];
  const audio = streamsOfType(probe, "audio");
  const extension = path.extname(filePath).toLowerCase();
  const preserveHdr = Boolean(settings.preserveHdr && isHdrVideo(video));
  if (extension === ".mp4" && settings.mode !== "all") {
    const selectedAudio = selectPreferredAudio(audio, audioLanguages.preferred);
    const videoCodec = String(video && video.codec_name || "").toLowerCase();
    const audioCodec = String(selectedAudio && selectedAudio.codec_name || "").toLowerCase();
    if (
      SIMPLE_MP4_VIDEO_CODECS.has(videoCodec)
      && (!selectedAudio || SIMPLE_MP4_AUDIO_CODECS.has(audioCodec))
      && (!settings.downmixToStereo || !selectedAudio || Number(selectedAudio.channels) <= 2)
    ) {
      return true;
    }
  }

  const expectedVideoCodec = preserveHdr ? "hevc" : "h264";
  if (!video || video.codec_name !== expectedVideoCodec) return false;
  if (preserveHdr && !isTenBitVideo(video)) return false;

  const outputExtension = path.extname(outputPath).toLowerCase();
  if (extension !== outputExtension) return false;

  if (settings.mode === "all") {
    let retainedAudio = selectRetainedAudio(audio, audioLanguages);
    if (settings.downmixToStereo) {
      retainedAudio = selectOneAudioPerLanguage(retainedAudio, audioLanguages);
    }
    const subtitles = streamsOfType(probe, "subtitle");
    const retainedSubtitles = selectRetainedSubtitles(subtitles, preferredSubtitleLanguage);
    return audio.length > 0
      && audio.every((stream) => stream.codec_name === "aac")
      && retainedAudio.length === audio.length
      && (!settings.downmixToStereo || audio.every((stream) => Number(stream.channels) <= 2))
      && retainedSubtitles.length === subtitles.length
      && retainedSubtitles.every((subtitle) => {
        const title = String(subtitle.stream.tags && subtitle.stream.tags.title || "");
        return title === `${displayLanguageName(preferredSubtitleLanguage)}${subtitle.forced ? " Forced" : ""}`
          && Boolean(subtitle.stream.disposition && subtitle.stream.disposition.forced) === subtitle.forced;
      });
  }
  return false;
}

function optimiserSubtitleLanguage(config) {
  return config && config.subtitles && config.subtitles.defaultLanguage || "english";
}

function videoEncodingArgs(encoder, hardwareProfile, streamPlan, hardwareDecodeEnabled = false) {
  const preserveHdr = Boolean(streamPlan && streamPlan.preserveHdr);
  const pixelFormat = preserveHdr ? "p010le" : "yuv420p";
  const softwareFilterArgs = ["-vf", "setpts=PTS-STARTPTS", "-pix_fmt", pixelFormat];
  const hardwareFilterArgs = ["-vf", "setpts=PTS-STARTPTS"];
  const hardwareConversionRequired = hardwareDecodeEnabled
    && !preserveHdr
    && isTenBitVideo(streamPlan.video.stream);
  const convertedHardwareFilterArgs = [
    "-vf",
    "setpts=PTS-STARTPTS,hwdownload,format=p010le,format=yuv420p",
    "-pix_fmt",
    pixelFormat
  ];
  const frameFilterArgs = hardwareDecodeEnabled
    ? hardwareConversionRequired ? convertedHardwareFilterArgs : hardwareFilterArgs
    : softwareFilterArgs;
  const hdrArgs = preserveHdr ? hdrColourArgs(streamPlan.video.stream) : [];

  if (encoder === "h264_nvenc" || encoder === "hevc_nvenc") {
    return [
      ...frameFilterArgs,
      ...(preserveHdr ? ["-profile:v", "main10"] : []),
      "-preset",
      "p5",
      "-rc",
      "constqp",
      "-qp",
      OPTIMISER_VIDEO_QP,
      ...hdrArgs
    ];
  }

  if (encoder === "h264_qsv" || encoder === "hevc_qsv") {
    return [
      ...frameFilterArgs,
      ...(preserveHdr ? ["-profile:v", "main10"] : []),
      "-preset",
      "slow",
      "-global_quality",
      OPTIMISER_VIDEO_QP,
      ...hdrArgs
    ];
  }

  if (encoder === "h264_vaapi" || encoder === "hevc_vaapi") {
    return [
      ...(hardwareDecodeEnabled
        ? hardwareConversionRequired
          ? [
            "-vf",
            `setpts=PTS-STARTPTS,hwdownload,format=p010le,${hardwareProfile.uploadFilter || "format=nv12,hwupload"}`
          ]
          : hardwareFilterArgs
        : [
          "-vf",
          `setpts=PTS-STARTPTS,${hardwareProfile.uploadFilter || `format=${preserveHdr ? "p010le" : "nv12"},hwupload`}`
        ]),
      ...(preserveHdr ? ["-profile:v", "main10"] : []),
      "-qp",
      OPTIMISER_VIDEO_QP,
      ...hdrArgs
    ];
  }

  if (encoder === "h264_amf" || encoder === "hevc_amf") {
    return [
      ...frameFilterArgs,
      ...(preserveHdr ? ["-profile:v", "main10"] : []),
      "-usage",
      "transcoding",
      "-quality",
      "quality",
      "-rc",
      "cqp",
      "-qp_i",
      OPTIMISER_VIDEO_QP,
      "-qp_p",
      OPTIMISER_VIDEO_QP,
      "-qp_b",
      OPTIMISER_VIDEO_QP,
      ...hdrArgs
    ];
  }

  if (encoder === "h264_videotoolbox" || encoder === "hevc_videotoolbox") {
    return [
      ...frameFilterArgs,
      ...(preserveHdr ? ["-profile:v", "main10"] : []),
      "-q:v",
      "72",
      ...hdrArgs
    ];
  }

  return [
    "-vf",
    `setpts=PTS-STARTPTS,format=${preserveHdr ? "yuv420p10le" : "yuv420p"}`,
    "-pix_fmt",
    preserveHdr ? "yuv420p10le" : "yuv420p",
    ...(preserveHdr ? ["-profile:v", "main10"] : []),
    "-preset",
    "medium",
    "-crf",
    OPTIMISER_VIDEO_QP,
    ...hdrArgs
  ];
}

function isHdrVideo(stream) {
  const transfer = String(stream && stream.color_transfer || "").toLowerCase();
  const sideData = Array.isArray(stream && stream.side_data_list) ? stream.side_data_list : [];
  return ["smpte2084", "arib-std-b67"].includes(transfer)
    || sideData.some((entry) => /mastering display metadata|content light level metadata|dovi/i.test(
      String(entry && entry.side_data_type || "")
    ));
}

function isTenBitVideo(stream) {
  const pixelFormat = String(stream && stream.pix_fmt || "").toLowerCase();
  const bitsPerRawSample = Number.parseInt(stream && stream.bits_per_raw_sample, 10);
  return Number.isFinite(bitsPerRawSample) && bitsPerRawSample >= 10
    || /(?:p010|10le|10be|10bit)/.test(pixelFormat);
}

function hdrColourArgs(stream) {
  const values = [
    ["-color_primaries", stream && stream.color_primaries],
    ["-color_trc", stream && stream.color_transfer],
    ["-colorspace", stream && stream.color_space],
    ["-color_range", stream && stream.color_range]
  ];
  return values.flatMap(([flag, value]) => {
    const normalized = String(value || "").trim();
    return normalized && normalized !== "unknown" && normalized !== "unspecified"
      ? [flag, normalized]
      : [];
  });
}

function videoCodecLabel(codec) {
  return codec === "hevc" ? "HEVC Main 10" : "H.264";
}

function timestampOutputArgs() {
  return ["-avoid_negative_ts", "make_zero"];
}

function expectedPacketTimeline(durationSeconds) {
  const duration = Math.max(0, Number(durationSeconds) || 0);
  return {
    startSeconds: 0,
    endSeconds: duration,
    durationSeconds: duration,
    maximumPacketDurationSeconds: 0,
    packetDurationSeconds: duration,
    packetCount: 0
  };
}

function assertMatchingPacketTimeline(label, sourceTimeline, outputTimeline, fixedToleranceSeconds = null) {
  const toleranceSeconds = Number.isFinite(fixedToleranceSeconds)
    ? fixedToleranceSeconds
    : Math.max(
      0.25,
      sourceTimeline.maximumPacketDurationSeconds * 3,
      outputTimeline.maximumPacketDurationSeconds * 3
    );
  const differenceSeconds = Math.abs(outputTimeline.durationSeconds - sourceTimeline.durationSeconds);
  logFull(
    `[optimiser] ${label} packet timeline source=${formatPreciseDuration(sourceTimeline.durationSeconds)} `
    + `output=${formatPreciseDuration(outputTimeline.durationSeconds)} difference=${differenceSeconds.toFixed(3)}s `
    + `tolerance=${toleranceSeconds.toFixed(3)}s`
  );
  if (differenceSeconds > toleranceSeconds) {
    throw new Error(
      `Optimised output validation failed: ${label} packet timeline differs by ${differenceSeconds.toFixed(3)} seconds `
      + `(source ${formatPreciseDuration(sourceTimeline.durationSeconds)}, `
      + `output ${formatPreciseDuration(outputTimeline.durationSeconds)})`
    );
  }
}

function assertMatchingPacketContentStructure(
  label,
  sourceTimeline,
  outputTimeline,
  fixedToleranceSeconds = null,
  comparePacketCount = false
) {
  if (comparePacketCount) {
    const sourcePacketCount = Math.max(0, Number(sourceTimeline && sourceTimeline.packetCount) || 0);
    const outputPacketCount = Math.max(0, Number(outputTimeline && outputTimeline.packetCount) || 0);
    const packetDifference = Math.abs(outputPacketCount - sourcePacketCount);
    logFull(
      `[optimiser] ${label} packet content sourcePackets=${sourcePacketCount} outputPackets=${outputPacketCount} `
      + `difference=${packetDifference} tolerance=${VIDEO_PACKET_COUNT_TOLERANCE}`
    );
    if (sourcePacketCount <= 0 || outputPacketCount <= 0 || packetDifference > VIDEO_PACKET_COUNT_TOLERANCE) {
      throw new Error(
        `Optimised output validation failed: ${label} frame packet count differs by ${packetDifference} `
        + `(source ${sourcePacketCount}, output ${outputPacketCount})`
      );
    }
    return;
  }

  const toleranceSeconds = Number.isFinite(fixedToleranceSeconds)
    ? Math.max(PACKET_CONTENT_TOLERANCE_SECONDS, fixedToleranceSeconds)
    : Math.max(
      PACKET_CONTENT_TOLERANCE_SECONDS,
      sourceTimeline.maximumPacketDurationSeconds * 3,
      outputTimeline.maximumPacketDurationSeconds * 3
    );
  const sourceContent = positiveNumber(sourceTimeline.packetDurationSeconds);
  const outputContent = positiveNumber(outputTimeline.packetDurationSeconds);
  const contentDifference = Math.abs(outputContent - sourceContent);
  if (sourceContent <= 0 || outputContent <= 0 || contentDifference > toleranceSeconds) {
    throw new Error(
      `Optimised output validation failed: ${label} media content differs by ${contentDifference.toFixed(3)} seconds `
      + `(source ${formatPreciseDuration(sourceContent)}, output ${formatPreciseDuration(outputContent)})`
    );
  }

  const sourceGap = packetGapSeconds(sourceTimeline);
  const outputGap = packetGapSeconds(outputTimeline);
  const gapDifference = Math.abs(outputGap - sourceGap);
  const hasIntentionalGap = Math.max(sourceGap, outputGap) > INTENTIONAL_GAP_THRESHOLD_SECONDS;
  if (hasIntentionalGap && gapDifference > toleranceSeconds) {
    throw new Error(
      `Optimised output validation failed: ${label} intentional gaps differ by ${gapDifference.toFixed(3)} seconds `
      + `(source ${formatPreciseDuration(sourceGap)}, output ${formatPreciseDuration(outputGap)})`
    );
  }
}

function packetGapSeconds(timeline) {
  return Math.max(
    0,
    positiveNumber(timeline && timeline.durationSeconds)
      - positiveNumber(timeline && timeline.packetDurationSeconds)
  );
}

function assertAudioChannelCount(label, sourceStream, outputStream, downmixToStereo) {
  const sourceChannels = Number(sourceStream && sourceStream.channels);
  const outputChannels = Number(outputStream && outputStream.channels);
  if (!Number.isFinite(sourceChannels) || sourceChannels <= 0) {
    return;
  }
  const expectedChannels = downmixToStereo && sourceChannels > 2 ? 2 : sourceChannels;
  if (outputChannels !== expectedChannels) {
    throw new Error(
      `Optimised output validation failed: ${label} has ${outputChannels || 0} channels, expected ${expectedChannels}`
    );
  }
}

function formatPreciseDuration(value) {
  const seconds = Math.max(0, Number(value) || 0);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  const remainder = seconds % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${remainder.toFixed(3).padStart(6, "0")}`;
}

function timeValue(value, fallback) {
  const text = String(value || "");
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(text) ? text : fallback;
}

function timeMinutes(value) {
  const [hours, minutes] = timeValue(value, "00:00").split(":").map(Number);
  return hours * 60 + minutes;
}

function nonNegativeNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function positiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function progressSecondsFromFfmpeg(text) {
  const matches = [...String(text).matchAll(/(?:out_time|time)=(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
  const match = matches[matches.length - 1];
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

function optimiserStageCount(streamPlan) {
  const audioTracks = streamPlan.audio.length;
  const processingStages = 2 + audioTracks + (audioTracks > 1 ? 1 : 0);
  return processingStages * 2;
}

function createCurrentJob(library, item, outputPath, stageCount) {
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    filePath: item.filePath,
    outputPath,
    title: item.title || item.filename || path.basename(item.filePath),
    libraryTitle: library.title || library.key,
    artworkUrl: optimiserArtworkUrl(item),
    durationSeconds: 0,
    startedAt: new Date().toISOString(),
    percent: 0,
    stageKey: "preparing",
    stageLabel: "Preparing",
    stageIndex: 0,
    stageCount,
    stagePercent: 0,
    child: null
  };
}

function beginOptimiserStage(job, stageKey, stageLabel, stageIndex) {
  job.stageKey = stageKey;
  job.stageLabel = stageLabel;
  job.stageIndex = stageIndex;
  job.stagePercent = 0;
  job.percent = overallJobPercent(job, 0);
}

function completeOptimiserStage(job) {
  job.stagePercent = 100;
  job.percent = overallJobPercent(job, 100);
}

function validationProgressUpdater(job) {
  return (progress) => {
    const percent = progressPercent(progress);
    job.stagePercent = Math.max(job.stagePercent, percent);
    job.percent = overallJobPercent(job, job.stagePercent);
  };
}

function combinedProgress(itemCount, onProgress) {
  const count = Math.max(1, Number(itemCount) || 1);
  const values = Array(count).fill(0);
  const publish = () => reportPercent(
    onProgress,
    values.reduce((sum, value) => sum + value, 0) / count
  );
  return {
    forItem(index) {
      const safeIndex = Math.max(0, Math.min(Number(index) || 0, count - 1));
      return (progress) => {
        values[safeIndex] = Math.max(values[safeIndex], progressPercent(progress));
        publish();
      };
    },
    setComplete(index) {
      const safeIndex = Math.max(0, Math.min(Number(index) || 0, count - 1));
      values[safeIndex] = 100;
      publish();
    },
    complete() {
      values.fill(100);
      publish();
    }
  };
}

function rangedPercent(onProgress, rangeStart, rangeEnd) {
  if (typeof onProgress !== "function") {
    return null;
  }
  const start = Number(rangeStart) || 0;
  const width = Math.max(0, (Number(rangeEnd) || 0) - start);
  let lastPercent = start;
  return (progress) => {
    const percent = start + progressPercent(progress) / 100 * width;
    lastPercent = Math.max(lastPercent, percent);
    onProgress(lastPercent);
  };
}

function reportPercent(onProgress, progress) {
  if (typeof onProgress === "function") {
    onProgress(progressPercent(progress));
  }
}

function progressPercent(progress) {
  const value = typeof progress === "object" && progress !== null
    ? progress.percent
    : progress;
  return Math.round(Math.max(0, Math.min(Number(value) || 0, 100)) * 10) / 10;
}

function overallJobPercent(job, stagePercent) {
  const stageCount = Math.max(1, Number(job.stageCount) || 1);
  const stageIndex = Math.max(1, Math.min(Number(job.stageIndex) || 1, stageCount));
  const completedStages = stageIndex - 1;
  const fraction = (completedStages + Math.max(0, Math.min(Number(stagePercent) || 0, 100)) / 100) / stageCount;
  return Math.round(fraction * 1000) / 10;
}

function publicCurrent(current) {
  return {
    filePath: current.filePath,
    outputPath: current.outputPath,
    title: current.title,
    libraryTitle: current.libraryTitle,
    artworkUrl: current.artworkUrl,
    startedAt: current.startedAt,
    percent: current.percent,
    stageKey: current.stageKey,
    stageLabel: current.stageLabel,
    stageIndex: current.stageIndex,
    stageCount: current.stageCount,
    stagePercent: current.stagePercent,
    remainingStages: Math.max(0, (Number(current.stageCount) || 0) - (Number(current.stageIndex) || 0))
  };
}

function publicQueue(queue) {
  if (!queue) {
    return {
      libraryKey: null,
      libraryTitle: null,
      total: 0,
      active: 0,
      completed: 0,
      pending: 0,
      remaining: 0,
      next: []
    };
  }

  const total = Number(queue.total) || 0;
  const nextIndex = Math.max(0, Math.min(Number(queue.nextIndex) || 0, total));
  const active = Math.max(0, Number(queue.active) || 0);
  const completed = Math.max(0, nextIndex - active);
  const pending = Math.max(0, total - nextIndex);
  return {
    libraryKey: queue.libraryKey,
    libraryTitle: queue.libraryTitle,
    total,
    active,
    completed,
    pending,
    remaining: active + pending,
    next: (queue.items || []).slice(nextIndex, nextIndex + 8).map(publicQueueItem)
  };
}

function publicQueueItem(item) {
  return {
    title: item.title || item.filename || path.basename(item.filePath || ""),
    filePath: item.filePath,
    artworkUrl: optimiserArtworkUrl(item)
  };
}

function optimiserArtworkUrl(item) {
  return item && (item.collageUrl || item.thumbnailUrl || item.seasonPosterUrl || item.posterUrl) || null;
}

async function claimOptimiserLock(filePath, instanceId, allowStaleReclaim) {
  const lockPath = optimiserLockPath(filePath);
  const lockId = crypto.randomBytes(8).toString("hex");
  const startedAt = new Date().toISOString();

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const lock = {
      owner: instanceId,
      lockId,
      filePath,
      startedAt,
      updatedAt: startedAt
    };

    try {
      await fs.writeFile(lockPath, JSON.stringify(lock, null, 2), { flag: "wx" });
      logFull(`[optimiser] lock acquired file="${filePath}" lock="${lockPath}"`);
      return createOptimiserLockHandle(lockPath, lock);
    } catch (err) {
      if (err.code !== "EEXIST") {
        throw err;
      }
    }

    const existing = await readOptimiserLock(lockPath);
    if (!existing || !isOptimiserLockStale(existing)) {
      return null;
    }

    if (!allowStaleReclaim) {
      logFull(`[optimiser] stale lock deferred file="${filePath}" lock="${lockPath}"`);
      return null;
    }

    const latest = await readOptimiserLock(lockPath);
    if (!sameOptimiserLock(existing, latest) || !isOptimiserLockStale(latest)) {
      return null;
    }

    await fs.rm(lockPath, { force: true });
    logFull(`[optimiser] stale lock reclaimed file="${filePath}" lock="${lockPath}"`);
  }

  return null;
}

function createOptimiserLockHandle(lockPath, lock) {
  let released = false;
  let lastHeartbeat = Date.now();

  return {
    async touch() {
      if (released || Date.now() - lastHeartbeat < LOCK_HEARTBEAT_MS) {
        return;
      }
      lastHeartbeat = Date.now();
      const current = await readOptimiserLock(lockPath);
      if (!sameOptimiserLock(lock, current)) {
        released = true;
        return;
      }
      lock.updatedAt = new Date().toISOString();
      await fs.writeFile(lockPath, JSON.stringify(lock, null, 2)).catch((err) => {
        logFull(`[optimiser] lock heartbeat failed lock="${lockPath}" message="${err.message}"`);
      });
    },
    async release() {
      if (released) {
        return;
      }
      released = true;
      try {
        const current = await readOptimiserLock(lockPath);
        if (sameOptimiserLock(lock, current)) {
          await fs.rm(lockPath, { force: true });
          logFull(`[optimiser] lock released lock="${lockPath}"`);
        }
      } catch (err) {
        logFull(`[optimiser] lock release failed lock="${lockPath}" message="${err.message}"`);
      }
    }
  };
}

async function readOptimiserLock(lockPath) {
  try {
    return JSON.parse(await fs.readFile(lockPath, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT" || err instanceof SyntaxError) {
      return null;
    }
    throw err;
  }
}

function sameOptimiserLock(left, right) {
  return Boolean(left && right && left.owner === right.owner && left.lockId === right.lockId);
}

function isOptimiserLockStale(lock) {
  const updatedAt = Date.parse(lock && lock.updatedAt);
  return !Number.isFinite(updatedAt) || Date.now() - updatedAt > LOCK_STALE_MS;
}

function optimiserLockPath(filePath) {
  return path.join(path.dirname(filePath), `.${path.basename(filePath)}.media-baker.lock`);
}

async function stableSourceSnapshot(filePath) {
  const stat = await fs.stat(filePath);
  if (!stat.isFile() || stat.size <= 0) {
    throw new Error(`Optimiser source is not a readable media file: ${filePath}`);
  }
  if (Date.now() - stat.mtimeMs < SOURCE_STABILITY_MS) {
    return null;
  }
  return { size: stat.size, mtimeMs: stat.mtimeMs };
}

async function assertSourceUnchanged(filePath, snapshot) {
  const stat = await fs.stat(filePath);
  if (stat.size !== snapshot.size || stat.mtimeMs !== snapshot.mtimeMs) {
    throw new Error("Optimiser source changed while it was being read; the output was discarded and the file will be retried later");
  }
}

async function replaceOriginal(inputPath, outputPath, tempPath) {
  const samePath = path.resolve(inputPath).toLowerCase() === path.resolve(outputPath).toLowerCase();
  const backupPath = `${inputPath}.media-baker-backup`;
  await fs.rm(backupPath, { force: true });
  if (!samePath) {
    await fs.rm(outputPath, { force: true });
  }
  await fs.rename(inputPath, backupPath);
  try {
    await fs.rename(tempPath, outputPath);
    await fs.rm(backupPath, { force: true });
  } catch (err) {
    await fs.rename(backupPath, inputPath).catch(() => {});
    throw err;
  }
  if (!samePath) {
    await fs.rm(inputPath, { force: true });
  }
}

function quoteArg(value) {
  const text = String(value);
  return /\s/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
}

function summarize(value) {
  const lines = String(value || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const diagnosticLines = lines.filter((line) => !/^(?:frame|fps|stream_\d+_\d+_q|bitrate|total_size|out_time(?:_us|_ms)?|dup_frames|drop_frames|speed|progress)=/i.test(line));
  return (diagnosticLines.length > 0 ? diagnosticLines : lines).slice(-8).join(" | ");
}

function logFull(message) {
  if (logger.isFullEnabled()) {
    logger.full(message);
  }
}

module.exports = { OptimiserService, optimiserLibraries };
