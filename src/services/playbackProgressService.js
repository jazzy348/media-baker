const crypto = require("crypto");

const STATUS_IN_PROGRESS = "in_progress";
const STATUS_WATCHED = "watched";
const STATUS_REMOVED = "removed";
const WATCHED_PREFETCH_GRACE_SECONDS = 30;
const logger = require("../utils/logger");

class PlaybackProgressService {
  constructor(config, store) {
    this.config = config;
    this.store = store;
    this.playbackSessions = new Map();
  }

  async get(userId, mediaType, mediaId) {
    const record = await this.store.get(userId, mediaType, mediaId);
    return record ? toPublicProgress(record) : emptyProgress(mediaType, mediaId);
  }

  async getMany(userId, refs = []) {
    const records = await this.store.getMany(userId, refs);
    return new Map(records.map((record) => [
      recordKey(record.mediaType, record.mediaId),
      toPublicProgress(record)
    ]));
  }

  async removeUserHistory(userId) {
    const normalizedUserId = String(userId || "").trim();
    if (!normalizedUserId) {
      return 0;
    }

    for (const [key, session] of this.playbackSessions) {
      if (session.userId !== normalizedUserId) {
        continue;
      }
      if (session.completionTimer) {
        clearTimeout(session.completionTimer);
      }
      this.playbackSessions.delete(key);
    }

    return this.store.removeUser(normalizedUserId);
  }

  async importRecords(userId, records = []) {
    const normalizedUserId = String(userId || "").trim();
    if (!normalizedUserId) throw new Error("Import user is required");

    const summary = { imported: 0, updated: 0, unchanged: 0 };
    for (const input of records) {
      const incoming = importedRecord(normalizedUserId, input);
      const current = await this.store.get(normalizedUserId, incoming.mediaType, incoming.mediaId);
      const merged = mergeImportedRecord(current, incoming);
      if (!merged) {
        summary.unchanged += 1;
        continue;
      }
      await this.store.saveImported(merged);
      if (current) summary.updated += 1;
      else summary.imported += 1;
    }
    return summary;
  }

  async recordSegmentDelivery(userId, mediaType, mediaId, cacheKey, playbackSessionId, segment, options = {}) {
    if (!segment || !Number.isFinite(segment.startSeconds) || !Number.isFinite(segment.durationSeconds)) {
      return null;
    }

    const durationSeconds = Math.max(Number(segment.mediaDurationSeconds) || 0, segment.startSeconds + segment.durationSeconds);
    if (durationSeconds <= 0) {
      return null;
    }

    const trackProgress = options.trackProgress !== false;
    const current = trackProgress ? await this.store.get(userId, mediaType, mediaId) : null;

    const positionSeconds = this.confirmedPosition(
      playbackSessionId,
      userId,
      mediaType,
      mediaId,
      current,
      segment,
      cacheKey,
      durationSeconds
    );
    if (!trackProgress) {
      return null;
    }
    const tailSegmentsComplete = this.recordTailSegmentDelivery(
      playbackSessionId,
      userId,
      mediaType,
      mediaId,
      positionSeconds,
      durationSeconds,
      segment
    );
    if (positionSeconds <= 0 && !current) {
      return null;
    }
    const threshold = watchedThreshold(this.config);
    const completionPositionSeconds = watchedCompletionPosition(positionSeconds, durationSeconds, segment);
    const markerCompletionSeconds = positiveCompletionSeconds(options.completionStartSeconds, durationSeconds);
    const watched = tailSegmentsComplete
      || (markerCompletionSeconds !== null && completionPositionSeconds >= markerCompletionSeconds)
      || completionPositionSeconds >= durationSeconds * (1 - threshold);
    if (current
      && current.status === STATUS_IN_PROGRESS
      && positionSeconds <= Number(current.positionSeconds || 0)
      && !watched) {
      if (segment.isFinalSegment) {
        this.scheduleEndOfStreamSettlement(playbackSessionId, userId, mediaType, mediaId, cacheKey, current);
      }
      return current;
    }
    const nextRecord = {
      ...current,
      userId: userId || "global",
      mediaType,
      mediaId,
      status: watched ? STATUS_WATCHED : STATUS_IN_PROGRESS,
      positionSeconds: watched ? durationSeconds : positionSeconds,
      durationSeconds,
      cacheKey,
      watchedAt: watched ? new Date().toISOString() : current && current.watchedAt || null
    };

    const saved = await this.store.save(nextRecord);
    if (!watched && segment.isFinalSegment) {
      this.scheduleEndOfStreamSettlement(playbackSessionId, userId, mediaType, mediaId, cacheKey, saved);
    }
    return saved;
  }

  confirmedPosition(playbackSessionId, userId, mediaType, mediaId, current, segment, cacheKey, durationSeconds) {
    const now = Date.now();
    this.removeExpiredPlaybackSessions(now);
    const sessionKey = playbackSessionId || `${userId || "global"}:${mediaType}:${mediaId}:${segment.startSeconds}`;
    let session = this.playbackSessions.get(sessionKey);
    if (!session) {
      const storedPosition = current && current.status === STATUS_IN_PROGRESS
        ? Math.max(0, Number(current.positionSeconds) || 0)
        : 0;
      const segmentStart = Math.max(0, segment.startSeconds);
      session = {
        userId: userId || "global",
        mediaType,
        mediaId,
        cacheKey: cacheKey || null,
        durationSeconds,
        confirmedSeconds: Math.min(storedPosition, segmentStart),
        lastSegmentIndex: Number.isFinite(segment.index) ? segment.index : null,
        initialSeekCandidate: Number.isFinite(segment.index) && segmentStart - storedPosition >= 30
          ? { index: segment.index, startSeconds: segmentStart }
          : null,
        lastDeliveryAt: now,
        lastActivityAt: now,
        completionTimer: null,
        tailSegmentIndexes: new Set()
      };
      this.playbackSessions.set(sessionKey, session);
      return session.confirmedSeconds;
    }

    const elapsedSeconds = Math.max(0, (now - session.lastDeliveryAt) / 1000);
    const maximumInterval = Math.max(15, Number(segment.durationSeconds) * 5);
    const clockPosition = session.confirmedSeconds + Math.min(elapsedSeconds, maximumInterval);
    const segmentStart = Math.max(0, segment.startSeconds);
    const minimumSeekSegments = Math.max(4, Math.ceil(30 / Math.max(1, Number(segment.durationSeconds) || 1)));
    const forwardSegmentJump = Number.isFinite(segment.index)
      && Number.isFinite(session.lastSegmentIndex)
      && segment.index - session.lastSegmentIndex >= minimumSeekSegments;
    const forwardTimeJump = segmentStart - session.confirmedSeconds >= 30;
    const confirmsInitialSeek = session.initialSeekCandidate
      && Number.isFinite(segment.index)
      && segment.index > session.initialSeekCandidate.index
      && segment.index <= session.initialSeekCandidate.index + 2;
    if (confirmsInitialSeek) {
      logger.info(`[progress] confirmed initial seek mediaType=${mediaType} id=${mediaId} to=${Math.floor(session.initialSeekCandidate.startSeconds)}s`);
      session.confirmedSeconds = Math.max(session.confirmedSeconds, session.initialSeekCandidate.startSeconds);
      session.initialSeekCandidate = null;
    } else if (forwardSegmentJump && forwardTimeJump) {
      logger.info(`[progress] detected forward seek mediaType=${mediaType} id=${mediaId} from=${Math.floor(session.confirmedSeconds)}s to=${Math.floor(segmentStart)}s`);
      session.confirmedSeconds = segmentStart;
      session.initialSeekCandidate = null;
    } else {
      session.confirmedSeconds = Math.max(
        session.confirmedSeconds,
        Math.min(clockPosition, segmentStart)
      );
    }
    if (Number.isFinite(segment.index)) {
      session.lastSegmentIndex = segment.index;
    }
    session.cacheKey = cacheKey || session.cacheKey || null;
    session.durationSeconds = Math.max(Number(session.durationSeconds) || 0, Number(durationSeconds) || 0);
    session.lastDeliveryAt = now;
    session.lastActivityAt = now;
    return session.confirmedSeconds;
  }

  recordTailSegmentDelivery(playbackSessionId, userId, mediaType, mediaId, positionSeconds, durationSeconds, segment) {
    if (!Number.isFinite(segment.index)
      || !Number.isFinite(segment.remainingSegments)
      || segment.remainingSegments > 2
      || positionSeconds < durationSeconds * 0.5) {
      return false;
    }
    const session = playbackSessionId
      ? this.playbackSessions.get(playbackSessionId)
      : [...this.playbackSessions.values()].find((entry) =>
        entry.userId === (userId || "global") && entry.mediaType === mediaType && entry.mediaId === mediaId);
    if (!session) return false;
    session.tailSegmentIndexes = session.tailSegmentIndexes || new Set();
    session.tailSegmentIndexes.add(segment.index);
    return session.tailSegmentIndexes.size >= 2;
  }

  removeExpiredPlaybackSessions(now = Date.now()) {
    const cutoff = now - 24 * 60 * 60 * 1000;
    for (const [key, session] of this.playbackSessions) {
      if (session.lastActivityAt < cutoff) {
        if (session.completionTimer) clearTimeout(session.completionTimer);
        this.playbackSessions.delete(key);
      }
    }
  }

  scheduleEndOfStreamSettlement(playbackSessionId, userId, mediaType, mediaId, cacheKey, record) {
    const durationSeconds = Number(record.durationSeconds) || 0;
    const positionSeconds = Number(record.positionSeconds) || 0;
    if (durationSeconds <= 0 || positionSeconds < durationSeconds * 0.5) return;
    const session = playbackSessionId
      ? this.playbackSessions.get(playbackSessionId)
      : [...this.playbackSessions.values()].find((entry) =>
        entry.userId === (userId || "global") && entry.mediaType === mediaType && entry.mediaId === mediaId);
    if (!session) return;
    if (session.completionTimer) clearTimeout(session.completionTimer);
    const remainingMs = Math.max(1000, Math.ceil(durationSeconds - positionSeconds) * 1000);
    session.completionTimer = setTimeout(() => {
      session.completionTimer = null;
      this.settleEndOfStream(userId, mediaType, mediaId, cacheKey, durationSeconds)
        .catch((err) => logger.error(`[progress] end-of-stream settlement failed mediaType=${mediaType} id=${mediaId} message="${err.message}"`, err));
    }, remainingMs);
    session.completionTimer.unref?.();
  }

  async settleEndOfStream(userId, mediaType, mediaId, cacheKey, durationSeconds) {
    const current = await this.store.get(userId, mediaType, mediaId);
    if (!current || current.status !== STATUS_IN_PROGRESS || current.cacheKey !== cacheKey) return current;
    return this.store.save({
      ...current,
      status: STATUS_WATCHED,
      positionSeconds: durationSeconds,
      durationSeconds,
      watchedAt: new Date().toISOString()
    });
  }

  clearEndOfStreamSettlements(userId, mediaType, mediaId) {
    for (const session of this.playbackSessions.values()) {
      if (session.userId !== (userId || "global") || session.mediaType !== mediaType || session.mediaId !== mediaId) continue;
      if (session.completionTimer) clearTimeout(session.completionTimer);
      session.completionTimer = null;
    }
  }

  async recordPlaybackPosition(userId, mediaType, mediaId, positionSeconds, durationSeconds, options = {}) {
    const duration = Math.max(0, Number(durationSeconds) || 0);
    const position = Math.max(0, Math.min(duration, Number(positionSeconds) || 0));
    if (duration <= 0) {
      return null;
    }

    const normalizedUserId = userId || "global";
    const current = await this.store.get(normalizedUserId, mediaType, mediaId);
    const now = Date.now();
    const sessionKey = `web:${normalizedUserId}:${mediaType}:${mediaId}`;
    const session = this.playbackSessions.get(sessionKey) || {
      userId: normalizedUserId,
      mediaType,
      mediaId,
      cacheKey: current && current.cacheKey || null,
      completionTimer: null,
      tailSegmentIndexes: new Set()
    };
    session.confirmedSeconds = position;
    session.durationSeconds = duration;
    session.lastDeliveryAt = now;
    session.lastActivityAt = now;
    this.playbackSessions.set(sessionKey, session);

    if (position <= 0 && !current) {
      return null;
    }

    const markerCompletionSeconds = positiveCompletionSeconds(options.completionStartSeconds, duration);
    const watched = Boolean(current && current.status === STATUS_WATCHED)
      || (markerCompletionSeconds !== null && position >= markerCompletionSeconds)
      || position >= duration * (1 - watchedThreshold(this.config));
    return this.store.save({
      ...current,
      userId: normalizedUserId,
      mediaType,
      mediaId,
      status: watched ? STATUS_WATCHED : STATUS_IN_PROGRESS,
      positionSeconds: watched ? duration : position,
      durationSeconds: duration,
      cacheKey: current && current.cacheKey || null,
      watchedAt: watched ? current && current.watchedAt || new Date().toISOString() : null
    });
  }

  async markWatched(userId, mediaType, mediaId, durationSeconds = 0) {
    this.clearEndOfStreamSettlements(userId, mediaType, mediaId);
    const current = await this.store.get(userId, mediaType, mediaId);
    const duration = Number(durationSeconds) || current && current.durationSeconds || 0;
    return this.store.save({
      ...current,
      userId: userId || "global",
      mediaType,
      mediaId,
      status: STATUS_WATCHED,
      positionSeconds: duration,
      durationSeconds: duration,
      cacheKey: current && current.cacheKey || null,
      watchedAt: new Date().toISOString()
    });
  }

  async markRemoved(userId, mediaType, mediaId) {
    this.clearEndOfStreamSettlements(userId, mediaType, mediaId);
    const current = await this.store.get(userId, mediaType, mediaId);
    return this.store.save({
      ...current,
      userId: userId || "global",
      mediaType,
      mediaId,
      status: STATUS_REMOVED,
      positionSeconds: current && current.positionSeconds || 0,
      durationSeconds: current && current.durationSeconds || 0,
      cacheKey: current && current.cacheKey || null,
      watchedAt: current && current.watchedAt || null
    });
  }

  async markShowOnDeckRemoved(userId, mediaType, showId) {
    return this.store.save({
      userId: userId || "global",
      mediaType,
      mediaId: onDeckShowSuppressionId(showId),
      status: STATUS_REMOVED,
      positionSeconds: 0,
      durationSeconds: 0,
      cacheKey: null,
      watchedAt: null
    });
  }

  async markUnwatched(userId, mediaType, mediaId) {
    this.clearEndOfStreamSettlements(userId, mediaType, mediaId);
    return this.store.save({
      userId: userId || "global",
      mediaType,
      mediaId,
      status: STATUS_REMOVED,
      positionSeconds: 0,
      durationSeconds: 0,
      cacheKey: null,
      watchedAt: null
    });
  }

  async onDeck(mediaIndex, metadata, authToken, authParamName = "authToken", allowedLibraryKey = null, userId = "global") {
    const records = await this.store.list(userId);
    const recordsByKey = recordMap(records);
    const cutoff = Date.now() - this.config.playback.onDeckTtlSeconds * 1000;
    const itemsByKey = new Map();

    const latestWatchedByShow = new Map();
    for (const record of records) {
      if (!recordAllowed(record, allowedLibraryKey)) {
        continue;
      }

      const updatedAtMs = timeMs(record.updatedAt);
      if (record.status === STATUS_IN_PROGRESS && record.positionSeconds > 0 && updatedAtMs >= cutoff) {
        const mediaFile = await mediaFileForRecord(mediaIndex, record);
        if (mediaFile && !showOnDeckSuppressed(recordsByKey, record.mediaType, mediaFile.showId, record.updatedAt)) {
          itemsByKey.set(recordKey(record.mediaType, record.mediaId), await this.cardForRecord(mediaIndex, metadata, authToken, authParamName, record, mediaFile, "resume"));
        }
        continue;
      }

      if (record.status === STATUS_WATCHED) {
        const mediaFile = await mediaFileForRecord(mediaIndex, record);
        if (mediaFile
          && mediaFile.showId
          && !showOnDeckSuppressed(recordsByKey, record.mediaType, mediaFile.showId, record.updatedAt)) {
          const showKey = `${record.mediaType}:${mediaFile.showId}`;
          const previous = latestWatchedByShow.get(showKey);
          if (!previous || compareEpisodes(mediaFile, previous.mediaFile) > 0) {
            latestWatchedByShow.set(showKey, { record, mediaFile });
          }
        }
      }
    }

    for (const { record, mediaFile } of latestWatchedByShow.values()) {
      const nextEpisode = await nextEpisodeFor(mediaIndex, record.mediaType, mediaFile);
      if (!nextEpisode) {
        continue;
      }

      const nextKey = recordKey(record.mediaType, nextEpisode.id);
      const nextRecord = recordsByKey.get(nextKey);
      if (nextRecord && [STATUS_WATCHED, STATUS_REMOVED, STATUS_IN_PROGRESS].includes(nextRecord.status)) {
        continue;
      }

      const availableAtMs = Math.max(timeMs(record.updatedAt), Number(nextEpisode.addedAtMs) || 0);
      if (availableAtMs < cutoff) {
        continue;
      }

      itemsByKey.set(nextKey, await this.cardForRecord(mediaIndex, metadata, authToken, authParamName, {
        mediaType: record.mediaType,
        mediaId: nextEpisode.id,
        status: "next",
        positionSeconds: 0,
        durationSeconds: 0,
        updatedAt: new Date(availableAtMs).toISOString(),
        watchedAt: null
      }, nextEpisode, "next"));
    }

    return [...itemsByKey.values()]
      .sort((a, b) => timeMs(b.updatedAt) - timeMs(a.updatedAt));
  }

  async history(mediaIndex, metadata, authToken, authParamName = "authToken", allowedLibraryKey = null, userId = "global") {
    const records = await this.store.list(userId);
    const items = [];
    for (const record of records) {
      if (!recordAllowed(record, allowedLibraryKey)) {
        continue;
      }

      if (record.status !== STATUS_WATCHED && record.status !== STATUS_IN_PROGRESS) {
        continue;
      }

      const mediaFile = await mediaFileForRecord(mediaIndex, record);
      if (!mediaFile) {
        continue;
      }

      items.push(await this.cardForRecord(mediaIndex, metadata, authToken, authParamName, record, mediaFile, "history"));
    }

    return items.sort((a, b) => timeMs(b.updatedAt) - timeMs(a.updatedAt));
  }

  async adminHistory(mediaIndex, metadata, authToken, authParamName = "authToken", options = {}) {
    const limit = Math.max(1, Math.min(Number.parseInt(options.limit, 10) || 100, 250));
    const records = await this.store.list(options.userId || null, {
      statuses: [STATUS_WATCHED, STATUS_IN_PROGRESS],
      excludedUserIds: ["global"],
      since: options.since,
      before: options.before,
      offset: options.offset,
      limit: limit + 1
    });
    const pageRecords = records.slice(0, limit);
    const items = [];
    for (const record of pageRecords) {
      const mediaFile = await mediaFileForRecord(mediaIndex, record);
      if (!mediaFile) {
        continue;
      }
      items.push({
        ...await this.cardForRecord(
          mediaIndex,
          metadata,
          authToken,
          authParamName,
          record,
          mediaFile,
          "history"
        ),
        userId: record.userId || "global"
      });
    }

    return {
      items,
      hasMore: records.length > limit,
      nextOffset: records.length > limit
        ? Math.max(0, Number.parseInt(options.offset, 10) || 0) + limit
        : null
    };
  }

  async currentlyPlaying(mediaIndex, metadata, authToken, authParamName = "authToken", activeSeconds = 120) {
    const now = Date.now();
    const cutoff = now - Math.max(15, Number(activeSeconds) || 120) * 1000;
    this.removeExpiredPlaybackSessions(now);
    const sessions = [...this.playbackSessions.values()]
      .filter((session) => Number(session.lastActivityAt) >= cutoff);
    const items = [];

    for (const session of sessions) {
      const stored = await this.store.get(session.userId, session.mediaType, session.mediaId);
      const record = {
        ...stored,
        userId: session.userId || "global",
        mediaType: session.mediaType,
        mediaId: session.mediaId,
        status: STATUS_IN_PROGRESS,
        positionSeconds: Math.max(0, Number(session.confirmedSeconds) || 0),
        durationSeconds: Math.max(
          Number(session.durationSeconds) || 0,
          Number(stored && stored.durationSeconds) || 0
        ),
        cacheKey: session.cacheKey || stored && stored.cacheKey || null,
        updatedAt: new Date(session.lastActivityAt).toISOString()
      };
      const mediaFile = await mediaFileForRecord(mediaIndex, record, false);
      if (!mediaFile) {
        continue;
      }

      items.push({
        ...await this.cardForRecord(mediaIndex, metadata, authToken, authParamName, record, mediaFile, "active"),
        userId: record.userId || "global",
        cacheKey: record.cacheKey || null,
        activeAgoSeconds: Math.max(0, Math.round((now - session.lastActivityAt) / 1000))
      });
    }

    return items.sort((a, b) => timeMs(b.updatedAt) - timeMs(a.updatedAt));
  }

  async isCacheProtected(cacheKey) {
    if (!cacheKey) {
      return false;
    }

    const cutoff = Date.now() - this.config.playback.onDeckTtlSeconds * 1000;
    const records = await this.store.list();
    return records.some((record) => record.cacheKey === cacheKey
      && record.status === STATUS_IN_PROGRESS
      && record.positionSeconds > 0
      && timeMs(record.updatedAt) >= cutoff);
  }

  async protectedCacheKeys() {
    const cutoff = Date.now() - this.config.playback.onDeckTtlSeconds * 1000;
    const records = await this.store.list();
    return new Set(records
      .filter((record) => record.cacheKey
        && record.status === STATUS_IN_PROGRESS
        && record.positionSeconds > 0
        && timeMs(record.updatedAt) >= cutoff)
      .map((record) => record.cacheKey));
  }

  async cacheReleaseBaseMs(cacheKey) {
    if (!cacheKey) {
      return 0;
    }

    const records = await this.store.list();
    const retentionMs = this.config.playback.onDeckTtlSeconds * 1000;
    let base = 0;
    for (const record of records) {
      if (record.cacheKey !== cacheKey) {
        continue;
      }

      const updatedAtMs = timeMs(record.updatedAt);
      if (record.status === STATUS_WATCHED || record.status === STATUS_REMOVED) {
        base = Math.max(base, updatedAtMs);
      } else if (record.status === STATUS_IN_PROGRESS) {
        base = Math.max(base, updatedAtMs + retentionMs);
      }
    }

    return base;
  }

  async cardForRecord(mediaIndex, metadata, authToken, authParamName, record, mediaFile, reason) {
    const item = itemFromMediaFile(mediaIndex, record.mediaType, mediaFile);
    const [cached, seriesCached] = metadata && metadata.getCachedForMedia
      ? await Promise.all([
        metadata.getCachedForMedia(record.mediaType, metadataIdForMediaFile(mediaFile)),
        mediaFile.showId ? metadata.getCachedForMedia(record.mediaType, mediaFile.showId) : null
      ])
      : [null, null];
    const preservePlayableTitle = Boolean(mediaFile.showId || mediaFile.artistId);
    const title = !preservePlayableTitle && cached && cached.available && cached.title
      ? cached.title
      : item.title;
    const seriesPosterUrl = seriesCached && seriesCached.available && seriesCached.posterFilename
      ? metadata.posterUrl(seriesCached.posterFilename, authToken, authParamName)
      : null;
    return {
      ...item,
      title,
      metadataTitle: cached && cached.available ? cached.title : null,
      metadataAliases: cached && cached.available ? cached.aliases || [] : [],
      posterUrl: seriesPosterUrl || (cached && cached.posterFilename ? metadata.posterUrl(cached.posterFilename, authToken, authParamName) : item.posterUrl),
      thumbnailUrl: (item.showId || item.localThumbnail) && metadata
        ? metadata.thumbnailUrl(record.mediaType, item.id, authToken, authParamName)
        : item.thumbnailUrl,
      seasonPosterUrl: item.showId && Number(item.season) !== 0 && metadata
        ? metadata.seasonPosterUrl(record.mediaType, item.id, authToken, authParamName)
        : seriesPosterUrl,
      progress: toPublicProgress(record),
      onDeckReason: reason,
      updatedAt: record.updatedAt || null
    };
  }
}

function itemFromMediaFile(mediaIndex, mediaType, mediaFile) {
  const library = mediaIndex.libraryForKey(mediaType);
  const category = library ? library.title : mediaType;
  if (mediaFile.showId) {
    return {
      id: mediaFile.id,
      mediaType,
      category,
      title: mediaFile.title || mediaFile.filename,
      subtitle: `${mediaFile.showName} S${pad(mediaFile.season)}E${pad(mediaFile.episode)}`,
      showId: mediaFile.showId,
      showName: mediaFile.showName,
      season: mediaFile.season,
      episode: mediaFile.episode,
      filePath: mediaFile.filePath,
      localThumbnail: Boolean(library && library.localThumbnails)
    };
  }

  if (mediaFile.artistId) {
    return {
      id: mediaFile.id,
      mediaType,
      category,
      itemType: "track",
      title: mediaFile.title || mediaFile.filename,
      subtitle: `${mediaFile.artistName} - ${mediaFile.albumName}`,
      artistId: mediaFile.artistId,
      artistName: mediaFile.artistName,
      albumId: mediaFile.albumId,
      albumName: mediaFile.albumName,
      disc: mediaFile.disc,
      track: mediaFile.track,
      filePath: mediaFile.filePath
    };
  }

  return {
    id: mediaFile.id,
    mediaType,
    category,
    title: mediaFile.title || mediaFile.filename,
    subtitle: mediaFile.year ? String(mediaFile.year) : mediaFile.filename,
    filePath: mediaFile.filePath,
    localThumbnail: Boolean(library && library.localThumbnails)
  };
}

async function mediaFileForRecord(mediaIndex, record, requireProgressTracking = true) {
  const library = mediaIndex.libraryForKey(record.mediaType);
  if (!library || requireProgressTracking && library.trackProgress === false) {
    return null;
  }

  if (library.type === "tv") {
    return await mediaIndex.getEpisode(record.mediaId, library.key) || await mediaIndex.getMovie(record.mediaId, library.key);
  }

  if (library.type === "music") {
    return await mediaIndex.getTrack(record.mediaId, library.key);
  }

  return await mediaIndex.getMovie(record.mediaId, library.key);
}

async function nextEpisodeFor(mediaIndex, mediaType, episode) {
  const show = await mediaIndex.getShow(episode.showId, mediaType);
  if (!show) {
    return null;
  }

  const episodes = show.seasons
    .flatMap((season) => season.episodes)
    .sort((a, b) => (a.season || 0) - (b.season || 0) || (a.episode || 0) - (b.episode || 0) || a.filename.localeCompare(b.filename));
  const index = episodes.findIndex((item) => item.id === episode.id);
  return index >= 0 ? episodes[index + 1] || null : null;
}

function compareEpisodes(a, b) {
  return (Number(a.season) || 0) - (Number(b.season) || 0)
    || (Number(a.episode) || 0) - (Number(b.episode) || 0)
    || String(a.filename || "").localeCompare(String(b.filename || ""));
}

function onDeckShowSuppressionId(showId) {
  const digest = crypto.createHash("sha256").update(String(showId || "")).digest("hex");
  return `on-deck-show:${digest.slice(0, 48)}`;
}

function showOnDeckSuppressed(recordsByKey, mediaType, showId, activityAt) {
  if (!showId) {
    return false;
  }
  const suppression = recordsByKey.get(recordKey(mediaType, onDeckShowSuppressionId(showId)));
  return Boolean(suppression && timeMs(suppression.updatedAt) >= timeMs(activityAt));
}

function metadataIdForMediaFile(mediaFile) {
  return mediaFile.showId ? mediaFile.id : mediaFile.id;
}

function toPublicProgress(record) {
  const durationSeconds = Number(record.durationSeconds) || 0;
  const positionSeconds = Number(record.positionSeconds) || 0;
  return {
    status: record.status,
    positionSeconds,
    durationSeconds,
    percent: durationSeconds > 0 ? Math.min(100, Math.round((positionSeconds / durationSeconds) * 1000) / 10) : 0,
    resumeSeconds: record.status === STATUS_IN_PROGRESS ? Math.max(0, Math.floor(positionSeconds)) : 0,
    updatedAt: record.updatedAt || null,
    watchedAt: record.watchedAt || null
  };
}

function emptyProgress(mediaType, mediaId) {
  return {
    mediaType,
    mediaId,
    status: "none",
    positionSeconds: 0,
    durationSeconds: 0,
    percent: 0,
    resumeSeconds: 0,
    updatedAt: null,
    watchedAt: null
  };
}

function watchedThreshold(config) {
  const percent = Math.max(1, Math.min(Number(config.playback.watchedThresholdPercent) || 10, 95));
  return percent / 100;
}

function importedRecord(userId, input = {}) {
  const mediaType = String(input.mediaType || "").trim();
  const mediaId = String(input.mediaId || "").trim();
  const status = input.status === STATUS_WATCHED ? STATUS_WATCHED : STATUS_IN_PROGRESS;
  const durationSeconds = Math.max(0, Number(input.durationSeconds) || 0);
  const positionSeconds = status === STATUS_WATCHED
    ? durationSeconds
    : Math.max(0, Math.min(durationSeconds, Number(input.positionSeconds) || 0));
  if (!mediaType || !mediaId || durationSeconds <= 0) {
    throw new Error("Imported playback records require mediaType, mediaId, and durationSeconds");
  }
  const updatedAt = validImportTime(input.updatedAt) || new Date().toISOString();
  return {
    userId,
    mediaType,
    mediaId,
    status,
    positionSeconds,
    durationSeconds,
    cacheKey: null,
    updatedAt,
    watchedAt: status === STATUS_WATCHED
      ? validImportTime(input.watchedAt) || updatedAt
      : null
  };
}

function mergeImportedRecord(current, incoming) {
  if (!current) return incoming;
  const currentTime = timeMs(current.updatedAt);
  const incomingTime = timeMs(incoming.updatedAt);

  if (current.status === STATUS_WATCHED && incoming.status !== STATUS_WATCHED) return null;
  if (current.status === STATUS_WATCHED && incoming.status === STATUS_WATCHED && currentTime >= incomingTime) return null;
  if (incoming.status === STATUS_IN_PROGRESS) {
    const positionSeconds = Math.max(Number(current.positionSeconds) || 0, incoming.positionSeconds);
    if (current.status === STATUS_IN_PROGRESS
      && currentTime >= incomingTime
      && positionSeconds <= Number(current.positionSeconds || 0)) {
      return null;
    }
    return {
      ...current,
      ...incoming,
      positionSeconds,
      durationSeconds: Math.max(Number(current.durationSeconds) || 0, incoming.durationSeconds),
      updatedAt: incomingTime >= currentTime ? incoming.updatedAt : current.updatedAt
    };
  }
  return {
    ...current,
    ...incoming,
    durationSeconds: Math.max(Number(current.durationSeconds) || 0, incoming.durationSeconds)
  };
}

function validImportTime(value) {
  const timestamp = Date.parse(value || "");
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function watchedCompletionPosition(positionSeconds, durationSeconds, segment) {
  const deliveredThroughSeconds = Math.min(
    durationSeconds,
    Math.max(0, Number(segment.startSeconds) || 0) + Math.max(0, Number(segment.durationSeconds) || 0)
  );
  return Math.max(
    positionSeconds,
    Math.min(deliveredThroughSeconds, positionSeconds + WATCHED_PREFETCH_GRACE_SECONDS)
  );
}

function positiveCompletionSeconds(value, durationSeconds) {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 && seconds < durationSeconds
    ? seconds
    : null;
}

function recordMap(records) {
  return new Map(records.map((record) => [recordKey(record.mediaType, record.mediaId), record]));
}

function recordAllowed(record, allowedLibraryKey) {
  if (!allowedLibraryKey) {
    return true;
  }
  if (Array.isArray(allowedLibraryKey)) {
    return allowedLibraryKey.includes(record.mediaType);
  }
  return record.mediaType === allowedLibraryKey;
}

function recordKey(mediaType, mediaId) {
  return `${mediaType}:${mediaId}`;
}

function timeMs(value) {
  const parsed = value ? Date.parse(value) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function pad(value) {
  return String(value || 0).padStart(2, "0");
}

module.exports = { PlaybackProgressService };
