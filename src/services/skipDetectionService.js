const crypto = require("crypto");
const path = require("path");
const logger = require("../utils/logger");

const ALGORITHM_VERSION = 2;
const WINDOW_SECONDS = 12 * 60;
const FRAME_SECONDS = 1;
const SAMPLE_RATE = 4000;
const MINIMUM_MATCH_SECONDS = 18;
const MAXIMUM_INTRO_SECONDS = 4 * 60;
const MAXIMUM_CREDITS_SECONDS = 5 * 60;
const MATCH_THRESHOLD = 0.88;
const MAX_AUDIO_STREAMS = 2;
const SPECTRAL_FREQUENCIES = [90, 160, 280, 480, 800, 1250, 1900, 2900];

class SkipDetectionService {
  constructor(config, mediaIndex, ffmpeg, store, options = {}) {
    this.config = config;
    this.mediaIndex = mediaIndex;
    this.ffmpeg = ffmpeg;
    this.store = store;
    this.prepareRun = typeof options.prepareRun === "function" ? options.prepareRun : null;
    this.running = false;
    this.queued = false;
    this.cancelled = false;
    this.activeProcess = null;
    this.retryFailureGroups = new Set();
    this.retryFailureEpisodes = new Set();
    this.checkpointedSeasonKeys = new Set();
    this.checkpointedEpisodeKeys = new Set();
    this.status = initialStatus();
  }

  start() {
    // Retry intent is deliberately process-local and must never carry into startup work.
    this.retryFailureGroups.clear();
    this.retryFailureEpisodes.clear();
    this.status.enabled = this.enabled();
    if (!this.enabled()) {
      logger.info("[skip-detection] disabled");
      return;
    }
    if (this.config.indexScan && this.config.indexScan.enabled && this.config.indexScan.runOnStartup) {
      logger.info("[skip-detection] waiting for startup index scan");
      return;
    }
    setImmediate(() => this.schedule("startup"));
  }

  stop() {
    this.cancelled = true;
    this.queued = false;
    this.status.enabled = this.enabled();
    this.status.queued = false;
    if (this.activeProcess && !this.activeProcess.killed) {
      this.activeProcess.kill();
    }
  }

  restart() {
    this.status.enabled = this.enabled();
    if (!this.enabled()) {
      this.stop();
      return;
    }
    if (this.running) {
      this.queued = true;
      this.status.queued = true;
      return;
    }
    this.cancelled = false;
    setImmediate(() => this.schedule("settings-update"));
  }

  enabled() {
    return Boolean(this.config.skipDetection && this.config.skipDetection.enabled);
  }

  schedule(reason = "index-scan") {
    if (!this.enabled()) {
      return;
    }
    if (this.running) {
      this.queued = true;
      this.status.queued = true;
      return;
    }
    this.run(reason).catch((err) => {
      if (!this.cancelled) {
        this.status.lastError = err.message;
        logger.error(`[skip-detection] background analysis failed message="${err.message}"`, err);
      }
    });
  }

  async getStatus() {
    const [failures, markers] = await Promise.all([
      this.store.listFailures(500),
      this.store.countMarkers()
    ]);
    return {
      ...clone(this.status),
      enabled: this.enabled(),
      running: this.running,
      queued: this.queued,
      algorithmVersion: ALGORITHM_VERSION,
      markers,
      failures
    };
  }

  async retryFailures() {
    const failures = await this.store.listFailures(100000);
    const groups = uniqueFailureGroups(failures);
    for (const failure of failures) {
      rememberFailureRetry(this.retryFailureEpisodes, failure);
    }
    for (const failure of groups) {
      this.retryFailureGroups.add(analysisKey(failure.mediaType, failure.groupId));
      await this.store.clearAnalysis(failure.mediaType, failure.groupId, false);
    }
    await this.store.clearFailures();
    this.schedule("retry-failures");
    return { accepted: true, count: failures.length };
  }

  async reanalyse({ mediaType = null, groupId = null, includeFingerprints = false } = {}) {
    const failures = await this.store.listFailures(100000);
    for (const failure of failures) {
      if ((!mediaType || failure.mediaType === mediaType)
        && (!groupId || failure.groupId === groupId)) {
        this.retryFailureGroups.add(analysisKey(failure.mediaType, failure.groupId));
        rememberFailureRetry(this.retryFailureEpisodes, failure);
      }
    }
    await this.store.clearAnalysis(mediaType, groupId, includeFingerprints);
    await this.store.clearFailures(mediaType, groupId);
    this.schedule(includeFingerprints ? "full-reanalysis" : "marker-reanalysis");
    return { accepted: true, mediaType, groupId, includeFingerprints };
  }

  async markerReviews(limit = 200) {
    const records = await this.store.listMarkerRecords(limit);
    const grouped = new Map();
    for (const record of records) {
      const key = `${record.mediaType}:${record.mediaId}`;
      const entry = grouped.get(key) || {
        mediaType: record.mediaType,
        markerId: record.mediaId,
        markers: [],
        updatedAt: record.updatedAt
      };
      entry.markers.push({
        type: record.type,
        startSeconds: record.startSeconds,
        endSeconds: record.endSeconds,
        confidence: record.confidence,
        source: record.source
      });
      grouped.set(key, entry);
    }

    const unresolved = new Map(grouped);
    for (const library of this.config.libraries.filter((entry) => entry.type === "tv")) {
      if (unresolved.size === 0) {
        break;
      }
      const collection = await this.mediaIndex.loadCollection(library.key, "tv");
      for (const show of collection.shows || []) {
        for (const season of show.seasons || []) {
          const groupId = `${show.id}:${season.season || 0}`;
          for (const episode of season.episodes || []) {
            const markerId = episodeMarkerId(episode);
            const key = `${library.key}:${markerId}`;
            const review = unresolved.get(key);
            if (!review) {
              continue;
            }
            review.groupId = groupId;
            review.libraryTitle = library.title;
            review.showName = show.name;
            review.season = Number(episode.season) || 0;
            review.episode = Number(episode.episode) || 0;
            review.item = {
              id: episode.id,
              mediaType: library.key,
              itemType: "episode",
              category: library.title,
              title: episode.title,
              subtitle: `${show.name} S${pad(episode.season)}E${pad(episode.episode)}`,
              showId: episode.showId,
              showName: episode.showName,
              season: episode.season,
              episode: episode.episode,
              filePath: episode.filePath
            };
            unresolved.delete(key);
          }
        }
      }
    }
    return [...grouped.values()];
  }

  async getMarkers(mediaType, mediaFile) {
    if (!this.enabled()) {
      return [];
    }
    return this.store.getMarkers(mediaType, episodeMarkerId(mediaFile));
  }

  async completionStartSeconds(mediaType, mediaFile) {
    const credits = (await this.getMarkers(mediaType, mediaFile))
      .filter((entry) => entry.type === "credits")
      .map((entry) => Number(entry.startSeconds))
      .filter((value) => Number.isFinite(value) && value > 0);
    return credits.length > 0 ? Math.min(...credits) : null;
  }

  async run(reason) {
    if (!this.enabled() || this.running) {
      return;
    }
    this.running = true;
    this.cancelled = false;
    this.status = {
      ...initialStatus(),
      enabled: true,
      running: true,
      reason,
      startedAt: new Date().toISOString(),
      phase: "discovering"
    };
    logger.info(`[skip-detection] analysis started reason=${reason} algorithm=${ALGORITHM_VERSION}`);

    try {
      if (this.prepareRun) {
        await this.prepareRun();
      }
      if (!this.enabled()) {
        this.status.enabled = false;
        this.status.phase = "disabled";
        return;
      }
      const seasons = await this.buildWorkList();
      this.status.totals.seasons = seasons.length;
      this.status.totals.episodes = seasons.reduce((total, entry) => total + entry.episodes.length, 0);
      const analyses = await this.store.listAnalyses();
      const failures = await this.store.listFailures(100000);
      const failureState = {
        episodeKeys: new Set(failures.map((entry) => failureKey(entry.mediaType, entry.mediaId))),
        pathKeys: new Set(failures
          .filter((entry) => entry.filePath)
          .map((entry) => failurePathKey(entry.mediaType, entry.filePath)))
      };
      const analysesByGroup = new Map(analyses.map((entry) => [
        analysisKey(entry.mediaType, entry.groupId),
        entry
      ]));
      this.checkpointedSeasonKeys = new Set();
      this.checkpointedEpisodeKeys = new Set();
      const pendingSeasons = [];

      for (const work of seasons) {
        const memberIds = work.episodes.map(episodeMarkerId);
        const previous = analysesByGroup.get(analysisKey(work.library.key, work.groupId));
        const currentMemberIds = new Set(memberIds.map(String));
        if (previous && Number(previous.algorithmVersion) === ALGORITHM_VERSION) {
          for (const memberId of previous.memberIds || []) {
            if (currentMemberIds.has(String(memberId))) {
            this.checkpointedEpisodeKeys.add(failureKey(work.library.key, memberId));
            }
          }
          if (sameMembers(previous.memberIds, memberIds)) {
            this.checkpointedSeasonKeys.add(analysisKey(work.library.key, work.groupId));
          }
        }
        const retryFailures = this.retryFailureGroups.has(analysisKey(work.library.key, work.groupId))
          || work.episodes.some((episode) => shouldRetryFailure(this.retryFailureEpisodes, work.library.key, episode));
        if (previous
          && Number(previous.algorithmVersion) === ALGORITHM_VERSION
          && sameMembers(previous.memberIds, memberIds)
          && !retryFailures) {
          this.status.completed.seasons += 1;
          this.status.completed.episodes += work.episodes.length;
          this.status.unchangedSeasons += 1;
          this.status.cachedEpisodes += work.episodes.length;
        } else if (!retryFailures
          && work.episodes.every((episode) => isKnownFailure(failureState, work.library.key, episode))) {
          this.status.completed.seasons += 1;
          this.status.completed.episodes += work.episodes.length;
          this.status.failedEpisodes += work.episodes.length;
          this.status.unchangedSeasons += 1;
          this.checkpointedSeasonKeys.add(analysisKey(work.library.key, work.groupId));
          for (const episode of work.episodes) {
            this.checkpointedEpisodeKeys.add(failureKey(work.library.key, episodeFailureId(episode)));
          }
          logger.full(
            `[skip-detection] skipped failed season mediaType=${work.library.key}`
            + ` group=${work.groupId} episodes=${work.episodes.length}`
          );
        } else {
          pendingSeasons.push(work);
        }
      }
      this.updateCheckpointedStatus();
      this.updateEta();

      for (const work of pendingSeasons) {
        if (this.cancelled || !this.enabled()) {
          break;
        }
        this.setCurrent(work, null, "checking-season");
        const result = await this.analyseSeason(work, failureState);
        this.status.completed.seasons += 1;
        if (result.saved) {
          this.status.analysedSeasons += 1;
        }
        this.updateEta();
      }

      this.status.phase = this.cancelled ? "cancelled" : "complete";
      this.status.finishedAt = new Date().toISOString();
      logger.info(
        `[skip-detection] analysis complete analysedSeasons=${this.status.analysedSeasons}`
        + ` unchangedSeasons=${this.status.unchangedSeasons}`
        + ` cachedEpisodes=${this.status.cachedEpisodes}`
        + ` analysedEpisodes=${this.status.analysedEpisodes}`
        + ` failedEpisodes=${this.status.failedEpisodes}`
      );
    } finally {
      this.running = false;
      this.status.running = false;
      this.status.current = null;
      this.activeProcess = null;
      if (this.queued && this.enabled() && !this.cancelled) {
        this.queued = false;
        this.status.queued = false;
        setImmediate(() => this.schedule("queued"));
      }
    }
  }

  async buildWorkList() {
    const work = [];
    const libraries = this.config.libraries.filter((library) => library.type === "tv");
    this.status.totals.libraries = libraries.length;
    for (const library of libraries) {
      if (this.cancelled) {
        break;
      }
      const collection = await this.mediaIndex.loadCollection(library.key, "tv");
      for (const show of collection.shows || []) {
        for (const season of show.seasons || []) {
          const episodes = selectCanonicalEpisodes(season.episodes || [], library.path);
          if (episodes.length === 0) {
            continue;
          }
          work.push({
            library,
            show,
            season,
            episodes,
            groupId: `${show.id}:${season.season || 0}`
          });
        }
      }
    }
    return work;
  }

  async analyseSeason(work, failureState = { episodeKeys: new Set(), pathKeys: new Set() }) {
    logger.full(
      `[skip-detection] analysing mediaType=${work.library.key}`
      + ` group=${work.groupId} episodes=${work.episodes.length}`
    );
    const analysedEpisodes = [];
    const markersByMediaId = Object.fromEntries(work.episodes.map((episode) => [episodeMarkerId(episode), []]));

    for (const episode of work.episodes) {
      if (this.cancelled) {
        return { saved: false };
      }
      const startedAt = Date.now();
      const markerId = episodeMarkerId(episode);
      const retryFailures = this.retryFailureGroups.has(analysisKey(work.library.key, work.groupId))
        || shouldRetryFailure(this.retryFailureEpisodes, work.library.key, episode);
      const knownFailure = isKnownFailure(failureState, work.library.key, episode);
      if (knownFailure && !retryFailures) {
        this.status.failedEpisodes += 1;
        this.status.completed.episodes += 1;
        this.checkpointedEpisodeKeys.add(failureKey(work.library.key, episodeFailureId(episode)));
        this.updateCheckpointedStatus();
        this.updateEta();
        continue;
      }
      this.setCurrent(work, episode, "loading-checkpoint");
      try {
        const entry = await this.loadOrCreateEpisodeFingerprint(work, episode);
        markersByMediaId[markerId].push(...markersFromChapters(entry.chapters, entry.duration));
        analysedEpisodes.push(entry);
        await this.store.clearFailure(work.library.key, episodeFailureId(episode), episode.filePath);
      } catch (err) {
        this.status.failedEpisodes += 1;
        this.status.lastError = err.message;
        await this.store.saveFailure(
          work.library.key,
          work.groupId,
          episodeFailureId(episode),
          episode.filePath,
          err.message
        );
        logger.full(`[skip-detection] episode failed file="${episode.filePath}" message="${err.message}"`);
      } finally {
        this.status.completed.episodes += 1;
        this.status.episodeTimings.push(Date.now() - startedAt);
        if (this.status.episodeTimings.length > 50) {
          this.status.episodeTimings.shift();
        }
        this.updateEta();
      }
    }

    if (analysedEpisodes.length > 1) {
      this.setCurrent(work, null, "comparing");
      this.addRecurringAudioMarkers(analysedEpisodes, markersByMediaId);
    }

    if (this.cancelled) {
      return { saved: false };
    }
    this.setCurrent(work, null, "saving");
    await this.store.saveGroup(
      work.library.key,
      work.groupId,
      work.episodes.map(episodeMarkerId),
      markersByMediaId,
      ALGORITHM_VERSION
    );
    this.checkpointedSeasonKeys.add(analysisKey(work.library.key, work.groupId));
    for (const episode of work.episodes) {
      this.checkpointedEpisodeKeys.add(failureKey(work.library.key, episodeFailureId(episode)));
    }
    this.updateCheckpointedStatus();
    this.retryFailureGroups.delete(analysisKey(work.library.key, work.groupId));
    for (const episode of work.episodes) {
      this.retryFailureEpisodes.delete(failureKey(work.library.key, episodeFailureId(episode)));
      this.retryFailureEpisodes.delete(failurePathKey(work.library.key, episode.filePath));
    }
    for (const markers of Object.values(markersByMediaId)) {
      this.status.markers.intros += markers.filter((entry) => entry.type === "intro").length;
      this.status.markers.credits += markers.filter((entry) => entry.type === "credits").length;
    }
    return { saved: true };
  }

  async loadOrCreateEpisodeFingerprint(work, episode) {
    const markerId = episodeMarkerId(episode);
    const indexedSignature = indexSignature(episode);
    if (indexedSignature) {
      const cached = await this.store.getFingerprints(
        work.library.key,
        markerId,
        indexedSignature,
        ALGORITHM_VERSION
      );
      if (completeFingerprintSet(cached)) {
        this.status.cachedEpisodes += 1;
        return episodeEntry(episode, markerId, cached);
      }
    }

    this.setCurrent(work, episode, "probing");
    const probe = await this.ffmpeg.probe(episode.filePath, {
      showChapters: true,
      analyzeduration: "10M",
      probesize: "10M"
    });
    const duration = mediaDuration(probe);
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error("Media duration is unavailable");
    }
    const audioStreams = selectAudioStreams(probe.streams || []);
    const signature = indexedSignature || probeSignature(duration, audioStreams);
    const cached = await this.store.getFingerprints(
      work.library.key,
      markerId,
      signature,
      ALGORITHM_VERSION
    );
    if (completeFingerprintSet(cached)) {
      this.status.cachedEpisodes += 1;
      return episodeEntry(episode, markerId, cached);
    }

    const records = [];
    if (audioStreams.length === 0) {
      const record = {
        streamIndex: -1,
        language: "und",
        isDefault: true,
        expectedStreams: 1,
        duration,
        chapters: probe.chapters || [],
        head: null,
        tail: null,
        signature,
        algorithmVersion: ALGORITHM_VERSION
      };
      await this.store.saveFingerprint(work.library.key, work.groupId, markerId, record);
      records.push(record);
    } else {
      const streamFailures = [];
      for (const stream of audioStreams) {
        if (this.cancelled) {
          throw new Error("Skip detection cancelled");
        }
        try {
          this.setCurrent(work, episode, `fingerprinting-head:${stream.index}`);
          const headSeconds = Math.min(WINDOW_SECONDS, duration);
          const headPcm = await this.readAudioWindow(episode.filePath, stream.index, 0, headSeconds);
          const tailStart = Math.max(0, duration - Math.min(WINDOW_SECONDS, duration));
          this.setCurrent(work, episode, `fingerprinting-tail:${stream.index}`);
          const tailPcm = await this.readAudioWindow(
            episode.filePath,
            stream.index,
            tailStart,
            Math.min(WINDOW_SECONDS, duration)
          );
          records.push({
            streamIndex: stream.index,
            language: stream.language,
            isDefault: stream.isDefault,
            duration,
            chapters: probe.chapters || [],
            head: fingerprint(headPcm, 0),
            tail: fingerprint(tailPcm, tailStart),
            signature,
            algorithmVersion: ALGORITHM_VERSION
          });
        } catch (err) {
          streamFailures.push(`stream ${stream.index}: ${err.message}`);
        }
      }
      if (records.length === 0) {
        throw new Error(`Audio fingerprint decoding failed (${streamFailures.join("; ")})`);
      }
      for (const record of records) {
        record.expectedStreams = records.length;
        await this.store.saveFingerprint(work.library.key, work.groupId, markerId, record);
      }
      if (streamFailures.length > 0) {
        logger.full(
          `[skip-detection] using remaining audio tracks file="${episode.filePath}"`
          + ` failures="${streamFailures.join("; ")}"`
        );
      }
    }
    this.status.analysedEpisodes += 1;
    return episodeEntry(episode, markerId, records);
  }

  addRecurringAudioMarkers(episodes, markersByMediaId) {
    const candidates = new Map(episodes.map((entry) => [entry.markerId, { intro: [], credits: [] }]));
    for (const [firstIndex, secondIndex] of comparisonPairs(episodes.length)) {
      const first = episodes[firstIndex];
      const second = episodes[secondIndex];
      for (const [firstAudio, secondAudio] of matchingAudioPairs(first.audio, second.audio)) {
        addPairCandidates(first, second, "intro", firstAudio.head, secondAudio.head, candidates);
        addPairCandidates(first, second, "credits", firstAudio.tail, secondAudio.tail, candidates);
      }
    }

    for (const entry of episodes) {
      const existing = markersByMediaId[entry.markerId];
      const episodeCandidates = candidates.get(entry.markerId);
      if (!existing.some((markerEntry) => markerEntry.type === "intro")) {
        const intro = selectIntroCandidate(episodeCandidates.intro, entry.duration);
        if (intro) {
          existing.push(intro);
        }
      }
      const chapterCredits = existing.filter((markerEntry) => markerEntry.type === "credits");
      existing.push(...selectCreditCandidates(episodeCandidates.credits, entry.duration, chapterCredits));
      markersByMediaId[entry.markerId] = mergeMarkers(existing);
    }
  }

  readAudioWindow(filePath, streamIndex, startSeconds, durationSeconds) {
    return new Promise((resolve, reject) => {
      const args = [
        "-hide_banner", "-loglevel", "error",
        "-fflags", "+discardcorrupt+genpts",
        "-err_detect", "ignore_err",
        "-flags", "+output_corrupt",
        "-ss", String(Math.max(0, startSeconds)),
        "-i", filePath,
        "-map", `0:${streamIndex}`, "-vn", "-sn", "-dn",
        "-ac", "1", "-ar", String(SAMPLE_RATE),
        "-t", String(Math.max(1, durationSeconds)),
        "-f", "s16le", "pipe:1"
      ];
      const child = this.ffmpeg.spawnWithOutput(args);
      this.activeProcess = child;
      const chunks = [];
      const errors = [];
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, 2 * 60 * 1000);
      timeout.unref?.();
      child.stdout.on("data", (chunk) => chunks.push(chunk));
      child.stderr.on("data", (chunk) => {
        errors.push(chunk);
        if (errors.length > 8) {
          errors.shift();
        }
      });
      child.once("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
      child.once("close", (code) => {
        clearTimeout(timeout);
        if (this.activeProcess === child) {
          this.activeProcess = null;
        }
        if (this.cancelled) {
          reject(new Error("Skip detection cancelled"));
          return;
        }
        if (timedOut) {
          reject(new Error("Audio fingerprint timed out"));
          return;
        }
        if (code !== 0) {
          const pcm = Buffer.concat(chunks);
          const decodedSeconds = pcm.length / (SAMPLE_RATE * 2);
          const requiredSeconds = Math.min(
            durationSeconds,
            Math.max(MINIMUM_MATCH_SECONDS, durationSeconds - (FRAME_SECONDS * 2))
          );
          if (decodedSeconds >= requiredSeconds) {
            logger.full(
              `[skip-detection] accepted complete audio despite decoder exit`
              + ` stream=${streamIndex} decodedSeconds=${decodedSeconds.toFixed(1)}`
              + ` requestedSeconds=${durationSeconds.toFixed(1)}`
            );
            resolve(pcm);
            return;
          }
          reject(new Error(Buffer.concat(errors).toString("utf8").trim() || `ffmpeg exited with code ${code}`));
          return;
        }
        resolve(Buffer.concat(chunks));
      });
    });
  }

  setCurrent(work, episode, phase) {
    this.status.phase = phase;
    this.status.current = {
      libraryKey: work.library.key,
      libraryTitle: work.library.title,
      showId: work.show.id,
      showName: work.show.name,
      season: Number(work.season.season) || 0,
      groupId: work.groupId,
      episodeId: episode && episode.id || null,
      episode: episode && Number(episode.episode) || null,
      title: episode && episode.title || null,
      filePath: episode && episode.filePath || null
    };
  }

  updateEta() {
    const remaining = Math.max(0, this.status.totals.episodes - this.status.completed.episodes);
    const timings = this.status.episodeTimings;
    const averageMs = timings.length > 0
      ? timings.reduce((total, value) => total + value, 0) / timings.length
      : 0;
    this.status.etaSeconds = averageMs > 0 ? Math.round((remaining * averageMs) / 1000) : null;
  }

  updateCheckpointedStatus() {
    this.status.checkpointed.seasons = this.checkpointedSeasonKeys.size;
    this.status.checkpointed.episodes = this.checkpointedEpisodeKeys.size;
  }
}

function initialStatus() {
  return {
    enabled: false,
    running: false,
    queued: false,
    reason: null,
    phase: "idle",
    startedAt: null,
    finishedAt: null,
    current: null,
    totals: { libraries: 0, seasons: 0, episodes: 0 },
    completed: { seasons: 0, episodes: 0 },
    checkpointed: { seasons: 0, episodes: 0 },
    analysedSeasons: 0,
    unchangedSeasons: 0,
    cachedEpisodes: 0,
    analysedEpisodes: 0,
    failedEpisodes: 0,
    markers: { intros: 0, credits: 0 },
    etaSeconds: null,
    lastError: null,
    episodeTimings: []
  };
}

function episodeEntry(episode, markerId, records) {
  const first = records[0];
  return {
    episode,
    markerId,
    duration: Number(first.duration),
    chapters: first.chapters || [],
    audio: records
      .filter((record) => Number(record.streamIndex) >= 0 && record.head && record.tail)
      .map((record) => ({
        streamIndex: Number(record.streamIndex),
        language: normalizeLanguage(record.language),
        isDefault: Boolean(record.isDefault),
        head: decodeFingerprint(record.head),
        tail: decodeFingerprint(record.tail)
      }))
  };
}

function selectAudioStreams(streams) {
  const eligible = streams
    .filter((stream) => stream.codec_type === "audio" && !isCommentaryStream(stream))
    .map((stream) => ({
      index: Number(stream.index),
      language: normalizeLanguage(stream.tags && (stream.tags.language || stream.tags.LANGUAGE)),
      isDefault: Boolean(stream.disposition && stream.disposition.default),
      isOriginal: Boolean(stream.disposition && stream.disposition.original)
    }))
    .sort((first, second) => Number(second.isOriginal) - Number(first.isOriginal)
      || Number(second.isDefault) - Number(first.isDefault)
      || first.index - second.index);
  const selected = [];
  for (const stream of eligible) {
    if (selected.length === 0
      || selected.length < MAX_AUDIO_STREAMS
        && !selected.some((entry) => entry.language !== "und" && entry.language === stream.language)) {
      selected.push(stream);
    }
    if (selected.length >= MAX_AUDIO_STREAMS) {
      break;
    }
  }
  return selected;
}

function isCommentaryStream(stream) {
  const text = `${stream.tags && stream.tags.title || ""} ${stream.tags && stream.tags.handler_name || ""}`.toLowerCase();
  return /commentary|audio description|descriptive|director.?s comments/.test(text);
}

function normalizeLanguage(value) {
  const language = String(value || "und").trim().toLowerCase();
  const aliases = {
    english: "eng",
    en: "eng",
    japanese: "jpn",
    ja: "jpn",
    spanish: "spa",
    es: "spa",
    french: "fra",
    fre: "fra",
    fr: "fra",
    german: "deu",
    ger: "deu",
    de: "deu"
  };
  return aliases[language] || language || "und";
}

function matchingAudioPairs(firstAudio, secondAudio) {
  if (firstAudio.length === 0 || secondAudio.length === 0) {
    return [];
  }
  const sameLanguage = [];
  for (const first of firstAudio) {
    for (const second of secondAudio) {
      if (first.language !== "und" && first.language === second.language) {
        sameLanguage.push([first, second]);
      }
    }
  }
  if (sameLanguage.length > 0) {
    return sameLanguage;
  }
  const firstDefault = firstAudio.find((entry) => entry.isDefault) || firstAudio[0];
  const secondDefault = secondAudio.find((entry) => entry.isDefault) || secondAudio[0];
  return [[firstDefault, secondDefault]];
}

function comparisonPairs(length) {
  const pairs = new Set();
  const add = (first, second) => {
    if (first >= 0 && second >= 0 && first < length && second < length && first !== second) {
      pairs.add(`${Math.min(first, second)}:${Math.max(first, second)}`);
    }
  };
  if (length <= 6) {
    for (let first = 0; first < length; first += 1) {
      for (let second = first + 1; second < length; second += 1) {
        add(first, second);
      }
    }
  } else {
    const anchors = [0, Math.floor(length / 2), length - 1];
    for (let index = 0; index < length; index += 1) {
      add(index, index + 1);
      add(index, index + 2);
      for (const anchor of anchors) {
        add(index, anchor);
      }
    }
  }
  return [...pairs].map((value) => value.split(":").map(Number));
}

function markersFromChapters(chapters, duration) {
  const markers = [];
  for (const chapter of chapters || []) {
    const title = String(chapter.tags && (chapter.tags.title || chapter.tags.TITLE) || "").trim().toLowerCase();
    if (!title || /recap|previously|preview|next episode/.test(title)) {
      continue;
    }
    const startSeconds = Math.max(0, Number(chapter.start_time) || 0);
    const endSeconds = Math.min(duration, Number(chapter.end_time) || 0);
    if (endSeconds - startSeconds < 5) {
      continue;
    }
    if (/\b(opening|opening credits|intro|theme song|op)\b/.test(title)) {
      markers.push(marker("intro", startSeconds, endSeconds, 1, "chapter"));
    } else if (/\b(end credits|ending credits|credits|closing|ending|ed)\b/.test(title)) {
      markers.push(marker("credits", startSeconds, endSeconds, 1, "chapter"));
    }
  }
  return mergeMarkers(markers);
}

function fingerprint(pcm, windowStart) {
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2));
  const frameSize = SAMPLE_RATE * FRAME_SECONDS;
  const vectors = [];
  const loudness = [];
  for (let offset = 0; offset + frameSize <= samples.length; offset += frameSize) {
    const temporal = temporalEnergy(samples, offset, frameSize, 8);
    const spectral = spectralEnergy(samples, offset, frameSize);
    const vector = [...standardize(temporal), ...standardize(spectral)];
    let square = 0;
    for (let index = offset; index < offset + frameSize; index += 1) {
      const value = samples[index] / 32768;
      square += value * value;
    }
    vectors.push(vector);
    loudness.push(Math.sqrt(square / frameSize));
  }
  return packFingerprint(vectors, loudness, windowStart);
}

function temporalEnergy(samples, offset, frameSize, bins) {
  const output = [];
  const binSize = Math.floor(frameSize / bins);
  for (let bin = 0; bin < bins; bin += 1) {
    const start = offset + bin * binSize;
    const end = bin === bins - 1 ? offset + frameSize : start + binSize;
    let square = 0;
    for (let index = start; index < end; index += 1) {
      const value = samples[index] / 32768;
      square += value * value;
    }
    output.push(Math.log1p(square / Math.max(1, end - start) * 1000));
  }
  return output;
}

function spectralEnergy(samples, offset, frameSize) {
  const output = new Array(SPECTRAL_FREQUENCIES.length).fill(0);
  const windowSize = 256;
  const windowCount = 4;
  for (let windowIndex = 0; windowIndex < windowCount; windowIndex += 1) {
    const start = offset + Math.floor((frameSize - windowSize) * windowIndex / Math.max(1, windowCount - 1));
    for (let frequencyIndex = 0; frequencyIndex < SPECTRAL_FREQUENCIES.length; frequencyIndex += 1) {
      output[frequencyIndex] += goertzel(samples, start, windowSize, SPECTRAL_FREQUENCIES[frequencyIndex]);
    }
  }
  return output.map((value) => Math.log1p(value / windowCount));
}

function goertzel(samples, start, length, frequency) {
  const coefficient = 2 * Math.cos(2 * Math.PI * frequency / SAMPLE_RATE);
  let previous = 0;
  let previousPrevious = 0;
  for (let index = 0; index < length; index += 1) {
    const sample = samples[start + index] / 32768;
    const current = sample + coefficient * previous - previousPrevious;
    previousPrevious = previous;
    previous = current;
  }
  return Math.max(0, previousPrevious ** 2 + previous ** 2 - coefficient * previous * previousPrevious);
}

function packFingerprint(vectors, loudness, windowStart) {
  const dimensions = vectors[0] ? vectors[0].length : 0;
  const packed = Buffer.alloc(vectors.length * (dimensions + 1));
  for (let frame = 0; frame < vectors.length; frame += 1) {
    const base = frame * (dimensions + 1);
    for (let dimension = 0; dimension < dimensions; dimension += 1) {
      packed[base + dimension] = Math.round((clamp(vectors[frame][dimension], -3, 3) + 3) / 6 * 254);
    }
    const level = Math.log10(Math.max(0.0001, loudness[frame] || 0.0001));
    packed[base + dimensions] = Math.round(clamp((level + 4) / 4, 0, 1) * 255);
  }
  return {
    frameSeconds: FRAME_SECONDS,
    windowStart: roundTime(windowStart),
    dimensions,
    frameCount: vectors.length,
    data: packed.toString("base64")
  };
}

function decodeFingerprint(value) {
  if (!value || !value.data) {
    return [];
  }
  const bytes = Buffer.from(value.data, "base64");
  const dimensions = Number(value.dimensions) || 0;
  const stride = dimensions + 1;
  const frameCount = Math.min(Number(value.frameCount) || 0, Math.floor(bytes.length / Math.max(1, stride)));
  const frames = [];
  for (let frame = 0; frame < frameCount; frame += 1) {
    const base = frame * stride;
    const vector = [];
    for (let dimension = 0; dimension < dimensions; dimension += 1) {
      vector.push(bytes[base + dimension] / 254 * 6 - 3);
    }
    const loudness = 10 ** (bytes[base + dimensions] / 255 * 4 - 4);
    frames.push({
      time: Number(value.windowStart) + frame * (Number(value.frameSeconds) || FRAME_SECONDS),
      vector,
      loudness
    });
  }
  return frames;
}

function standardize(values) {
  const mean = values.reduce((total, value) => total + value, 0) / Math.max(1, values.length);
  const variance = values.reduce((total, value) => total + (value - mean) ** 2, 0) / Math.max(1, values.length);
  const deviation = Math.sqrt(variance) || 1;
  return values.map((value) => (value - mean) / deviation);
}

function addPairCandidates(first, second, type, firstFrames, secondFrames, candidates) {
  if (!firstFrames || !secondFrames || firstFrames.length === 0 || secondFrames.length === 0) {
    return;
  }
  const matches = recurringRuns(firstFrames, secondFrames);
  for (const match of matches) {
    const firstStart = firstFrames[match.firstStart].time;
    const secondStart = secondFrames[match.secondStart].time;
    const duration = match.frames * FRAME_SECONDS;
    candidates.get(first.markerId)[type].push({
      startSeconds: firstStart,
      endSeconds: firstStart + duration,
      confidence: match.confidence,
      partnerId: second.markerId
    });
    candidates.get(second.markerId)[type].push({
      startSeconds: secondStart,
      endSeconds: secondStart + duration,
      confidence: match.confidence,
      partnerId: first.markerId
    });
  }
}

function recurringRuns(first, second) {
  const stride = 2;
  const firstCoarse = first
    .map((frame, index) => ({ frame, index }))
    .filter((entry) => entry.index % stride === 0);
  const secondCoarse = second
    .map((frame, index) => ({ frame, index }))
    .filter((entry) => entry.index % stride === 0);
  const minimumFrames = Math.ceil(MINIMUM_MATCH_SECONDS / (FRAME_SECONDS * stride));
  const runs = [];
  for (let diagonal = -secondCoarse.length + 1; diagonal < firstCoarse.length; diagonal += 1) {
    let firstIndex = Math.max(0, diagonal);
    let secondIndex = Math.max(0, -diagonal);
    let runStartFirst = -1;
    let runStartSecond = -1;
    let scores = [];
    let misses = 0;
    while (firstIndex < firstCoarse.length && secondIndex < secondCoarse.length) {
      const score = frameSimilarity(firstCoarse[firstIndex].frame, secondCoarse[secondIndex].frame);
      if (score >= MATCH_THRESHOLD) {
        if (runStartFirst < 0) {
          runStartFirst = firstCoarse[firstIndex].index;
          runStartSecond = secondCoarse[secondIndex].index;
        }
        scores.push(score);
        misses = 0;
      } else if (runStartFirst >= 0 && misses < 1) {
        misses += 1;
      } else if (runStartFirst >= 0) {
        pushRun(runs, runStartFirst, runStartSecond, scores, minimumFrames, stride);
        runStartFirst = -1;
        runStartSecond = -1;
        scores = [];
        misses = 0;
      }
      firstIndex += 1;
      secondIndex += 1;
    }
    if (runStartFirst >= 0) {
      pushRun(runs, runStartFirst, runStartSecond, scores, minimumFrames, stride);
    }
  }

  const selected = [];
  for (const run of runs.sort((firstRun, secondRun) => secondRun.frames * secondRun.confidence - firstRun.frames * firstRun.confidence)) {
    if (selected.some((entry) => rangesOverlap(
      entry.firstStart,
      entry.firstStart + entry.frames,
      run.firstStart,
      run.firstStart + run.frames
    ) || rangesOverlap(
      entry.secondStart,
      entry.secondStart + entry.frames,
      run.secondStart,
      run.secondStart + run.frames
    ))) {
      continue;
    }
    selected.push(run);
    if (selected.length >= 3) {
      break;
    }
  }
  return selected.map((run) => refineRun(run, first, second));
}

function pushRun(runs, firstStart, secondStart, scores, minimumFrames, stride = 1) {
  if (scores.length < minimumFrames) {
    return;
  }
  runs.push({
    firstStart,
    secondStart,
    frames: scores.length * stride,
    confidence: scores.reduce((total, value) => total + value, 0) / scores.length
  });
}

function refineRun(run, first, second) {
  let firstStart = run.firstStart;
  let secondStart = run.secondStart;
  let frames = run.frames;
  while (firstStart > 0
    && secondStart > 0
    && frameSimilarity(first[firstStart - 1], second[secondStart - 1]) >= MATCH_THRESHOLD - 0.04) {
    firstStart -= 1;
    secondStart -= 1;
    frames += 1;
  }
  while (firstStart + frames < first.length
    && secondStart + frames < second.length
    && frameSimilarity(first[firstStart + frames], second[secondStart + frames]) >= MATCH_THRESHOLD - 0.04) {
    frames += 1;
  }
  return { ...run, firstStart, secondStart, frames };
}

function frameSimilarity(first, second) {
  if (first.loudness < 0.002 || second.loudness < 0.002) {
    return 0;
  }
  let dot = 0;
  let firstLength = 0;
  let secondLength = 0;
  for (let index = 0; index < first.vector.length; index += 1) {
    dot += first.vector[index] * second.vector[index];
    firstLength += first.vector[index] ** 2;
    secondLength += second.vector[index] ** 2;
  }
  const cosine = dot / Math.max(0.0001, Math.sqrt(firstLength * secondLength));
  const loudnessRatio = Math.min(first.loudness, second.loudness) / Math.max(first.loudness, second.loudness);
  return cosine * (0.75 + loudnessRatio * 0.25);
}

function selectIntroCandidate(candidates, duration) {
  const selected = clusterCandidates(candidates)
    .filter((entry) => entry.startSeconds <= Math.min(10 * 60, duration * 0.45)
      && entry.endSeconds <= Math.min(WINDOW_SECONDS + 2, duration)
      && entry.endSeconds - entry.startSeconds <= MAXIMUM_INTRO_SECONDS)
    .sort(candidateSort)[0];
  return selected ? marker("intro", selected.startSeconds, selected.endSeconds, selected.confidence, "audio-match-v2") : null;
}

function selectCreditCandidates(candidates, duration, existing) {
  const selected = [];
  for (const candidate of clusterCandidates(candidates).sort(candidateSort)) {
    const length = candidate.endSeconds - candidate.startSeconds;
    if (candidate.startSeconds < duration * 0.65 || length > MAXIMUM_CREDITS_SECONDS) {
      continue;
    }
    if ([...existing, ...selected].some((entry) => markerOverlap(entry, candidate) > 0.45)) {
      continue;
    }
    selected.push(marker(
      "credits",
      candidate.startSeconds,
      Math.min(duration, candidate.endSeconds),
      candidate.confidence,
      "audio-match-v2"
    ));
    if (selected.length >= 2) {
      break;
    }
  }
  return selected.sort((first, second) => first.startSeconds - second.startSeconds);
}

function clusterCandidates(candidates) {
  const clusters = [];
  for (const candidate of candidates || []) {
    let cluster = clusters.find((entry) => markerOverlap(entry, candidate) >= 0.55
      || Math.abs(entry.startSeconds - candidate.startSeconds) <= 6);
    if (!cluster) {
      cluster = { entries: [], partners: new Set(), startSeconds: candidate.startSeconds, endSeconds: candidate.endSeconds };
      clusters.push(cluster);
    }
    cluster.entries.push(candidate);
    cluster.partners.add(candidate.partnerId);
    cluster.startSeconds = median(cluster.entries.map((entry) => entry.startSeconds));
    cluster.endSeconds = median(cluster.entries.map((entry) => entry.endSeconds));
  }
  return clusters.map((cluster) => ({
    startSeconds: cluster.startSeconds,
    endSeconds: cluster.endSeconds,
    confidence: Math.min(
      0.99,
      cluster.entries.reduce((total, entry) => total + entry.confidence, 0) / cluster.entries.length
      + Math.min(0.06, (cluster.partners.size - 1) * 0.02)
    )
  }));
}

function candidateSort(first, second) {
  return (second.endSeconds - second.startSeconds) * second.confidence
    - (first.endSeconds - first.startSeconds) * first.confidence;
}

function mergeMarkers(markers) {
  const output = [];
  for (const entry of [...markers].sort((first, second) => first.startSeconds - second.startSeconds)) {
    const duplicate = output.find((candidate) => candidate.type === entry.type && markerOverlap(candidate, entry) >= 0.7);
    if (!duplicate) {
      output.push(entry);
    } else if ((entry.confidence || 0) > (duplicate.confidence || 0)) {
      Object.assign(duplicate, entry);
    }
  }
  return output.sort((first, second) => first.startSeconds - second.startSeconds);
}

function marker(type, startSeconds, endSeconds, confidence, source) {
  return {
    type,
    startSeconds: roundTime(startSeconds),
    endSeconds: roundTime(endSeconds),
    confidence: Math.round(confidence * 1000) / 1000,
    source
  };
}

function markerOverlap(first, second) {
  const overlap = Math.max(0, Math.min(first.endSeconds, second.endSeconds) - Math.max(first.startSeconds, second.startSeconds));
  const shortest = Math.min(first.endSeconds - first.startSeconds, second.endSeconds - second.startSeconds);
  return shortest > 0 ? overlap / shortest : 0;
}

function rangesOverlap(firstStart, firstEnd, secondStart, secondEnd) {
  return Math.max(firstStart, secondStart) < Math.min(firstEnd, secondEnd);
}

function mediaDuration(probe) {
  const formatDuration = Number(probe.format && probe.format.duration);
  if (Number.isFinite(formatDuration) && formatDuration > 0) {
    return formatDuration;
  }
  return Math.max(0, ...(probe.streams || []).map((stream) => Number(stream.duration) || 0));
}

function indexSignature(episode) {
  const sizeBytes = Number(episode && episode.sizeBytes);
  const mtimeMs = Number(episode && episode.mtimeMs);
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0 || !Number.isFinite(mtimeMs) || mtimeMs <= 0) {
    return null;
  }
  return `index:${Math.round(sizeBytes)}:${Math.round(mtimeMs)}`;
}

function probeSignature(duration, streams) {
  return `probe:${roundTime(duration)}:${streams.map((entry) => `${entry.index}:${entry.language}`).join(",")}`;
}

function completeFingerprintSet(records) {
  if (!Array.isArray(records) || records.length === 0) {
    return false;
  }
  const expected = Math.max(...records.map((entry) => Math.max(1, Number(entry.expectedStreams) || 1)));
  return records.length >= expected;
}

function median(values) {
  const sorted = [...values].sort((first, second) => first - second);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function roundTime(value) {
  return Math.round(Math.max(0, Number(value) || 0) * 10) / 10;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function sameMembers(first, second) {
  return Array.isArray(first)
    && first.length === second.length
    && first.every((value, index) => String(value) === String(second[index]));
}

function analysisKey(mediaType, groupId) {
  return `${mediaType}:${groupId}`;
}

function failureKey(mediaType, mediaId) {
  return `${mediaType}:${mediaId}`;
}

function failurePathKey(mediaType, filePath) {
  return `${mediaType}:${comparableFilePath(filePath)}`;
}

function comparableFilePath(filePath) {
  const normalized = path.normalize(String(filePath || ""));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function rememberFailureRetry(target, failure) {
  target.add(failureKey(failure.mediaType, failure.mediaId));
  if (failure.filePath) {
    target.add(failurePathKey(failure.mediaType, failure.filePath));
  }
}

function shouldRetryFailure(target, mediaType, episode) {
  return target.has(failureKey(mediaType, episodeFailureId(episode)))
    || target.has(failurePathKey(mediaType, episode.filePath));
}

function isKnownFailure(failureState, mediaType, episode) {
  return failureState.episodeKeys.has(failureKey(mediaType, episodeFailureId(episode)))
    || failureState.pathKeys.has(failurePathKey(mediaType, episode.filePath));
}

function uniqueFailureGroups(failures) {
  const groups = new Map();
  for (const failure of failures) {
    groups.set(analysisKey(failure.mediaType, failure.groupId), failure);
  }
  return [...groups.values()];
}

function episodeMarkerId(episode) {
  return `${episode.showId || episode.showName || "show"}:${Number(episode.season) || 0}:${Number(episode.episode) || 0}`;
}

function episodeFailureId(episode) {
  const filePath = comparableFilePath(episode && episode.filePath);
  if (!filePath) {
    return String(episode && episode.id || episodeMarkerId(episode));
  }
  return `file-${crypto.createHash("sha256").update(filePath).digest("hex").slice(0, 32)}`;
}

function selectCanonicalEpisodes(episodes, libraryPath) {
  const selected = new Map();
  for (const episode of [...episodes].sort(sortEpisodes)) {
    const key = episodeMarkerId(episode);
    const current = selected.get(key);
    if (!current || compareEpisodeCandidates(episode, current, libraryPath) < 0) {
      selected.set(key, episode);
    }
  }
  return [...selected.values()].sort(sortEpisodes);
}

function compareEpisodeCandidates(first, second, libraryPath) {
  const firstRank = episodeCandidateRank(first, libraryPath);
  const secondRank = episodeCandidateRank(second, libraryPath);
  for (let index = 0; index < firstRank.length; index += 1) {
    if (firstRank[index] !== secondRank[index]) {
      return firstRank[index] < secondRank[index] ? -1 : 1;
    }
  }
  return String(first.filePath || "").localeCompare(String(second.filePath || ""));
}

function episodeCandidateRank(episode, libraryPath) {
  const filePath = String(episode && episode.filePath || "");
  const relativePath = libraryPath ? path.relative(libraryPath, filePath) : filePath;
  const segments = relativePath.split(/[\\/]+/).filter(Boolean);
  const searchable = segments.join(" ").toLowerCase();
  const alternate = /\b(?:alternate|alternative)\s+versions?\b|\bversion\s+[a-z0-9]+\b|\bjust\s+music\s+videos?\b/.test(searchable);
  return [alternate ? 1 : 0, segments.length, filePath.length];
}

function sortEpisodes(first, second) {
  return (first.episode || 0) - (second.episode || 0) || String(first.filename).localeCompare(String(second.filename));
}

function pad(value) {
  return String(Math.max(0, Number(value) || 0)).padStart(2, "0");
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

module.exports = { SkipDetectionService, episodeMarkerId };
