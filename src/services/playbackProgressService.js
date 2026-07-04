const STATUS_IN_PROGRESS = "in_progress";
const STATUS_WATCHED = "watched";
const STATUS_REMOVED = "removed";

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

  async recordSegmentDelivery(userId, mediaType, mediaId, cacheKey, playbackSessionId, segment) {
    if (!segment || !Number.isFinite(segment.startSeconds) || !Number.isFinite(segment.durationSeconds)) {
      return null;
    }

    const durationSeconds = Math.max(Number(segment.mediaDurationSeconds) || 0, segment.startSeconds + segment.durationSeconds);
    if (durationSeconds <= 0) {
      return null;
    }

    const current = await this.store.get(userId, mediaType, mediaId);
    if (current && current.status === STATUS_REMOVED) {
      return current;
    }

    const positionSeconds = this.confirmedPosition(
      playbackSessionId,
      userId,
      mediaType,
      mediaId,
      current,
      segment
    );
    if (positionSeconds <= 0 && !current) {
      return null;
    }
    if (current
      && current.status === STATUS_IN_PROGRESS
      && positionSeconds <= Number(current.positionSeconds || 0)) {
      return current;
    }
    const threshold = watchedThreshold(this.config);
    const watched = positionSeconds >= durationSeconds * (1 - threshold);
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
    return saved;
  }

  confirmedPosition(playbackSessionId, userId, mediaType, mediaId, current, segment) {
    const now = Date.now();
    this.removeExpiredPlaybackSessions(now);
    const sessionKey = playbackSessionId || `${userId || "global"}:${mediaType}:${mediaId}:${segment.startSeconds}`;
    let session = this.playbackSessions.get(sessionKey);
    if (!session) {
      const storedPosition = current && current.status === STATUS_IN_PROGRESS
        ? Math.max(0, Number(current.positionSeconds) || 0)
        : 0;
      session = {
        confirmedSeconds: Math.min(storedPosition, Math.max(0, segment.startSeconds)),
        lastDeliveryAt: now,
        lastActivityAt: now
      };
      this.playbackSessions.set(sessionKey, session);
      return session.confirmedSeconds;
    }

    const elapsedSeconds = Math.max(0, (now - session.lastDeliveryAt) / 1000);
    const maximumInterval = Math.max(15, Number(segment.durationSeconds) * 5);
    const clockPosition = session.confirmedSeconds + Math.min(elapsedSeconds, maximumInterval);
    session.confirmedSeconds = Math.max(
      session.confirmedSeconds,
      Math.min(clockPosition, Math.max(0, segment.startSeconds))
    );
    session.lastDeliveryAt = now;
    session.lastActivityAt = now;
    return session.confirmedSeconds;
  }

  removeExpiredPlaybackSessions(now = Date.now()) {
    const cutoff = now - 24 * 60 * 60 * 1000;
    for (const [key, session] of this.playbackSessions) {
      if (session.lastActivityAt < cutoff) {
        this.playbackSessions.delete(key);
      }
    }
  }

  async markWatched(userId, mediaType, mediaId, durationSeconds = 0) {
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

  async markUnwatched(userId, mediaType, mediaId) {
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
        if (mediaFile) {
          itemsByKey.set(recordKey(record.mediaType, record.mediaId), await this.cardForRecord(mediaIndex, metadata, authToken, authParamName, record, mediaFile, "resume"));
        }
        continue;
      }

      if (record.status === STATUS_WATCHED) {
        const mediaFile = await mediaFileForRecord(mediaIndex, record);
        if (mediaFile && mediaFile.showId) {
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

  async currentlyPlaying(mediaIndex, metadata, authToken, authParamName = "authToken", activeSeconds = 120) {
    const cutoff = Date.now() - Math.max(15, Number(activeSeconds) || 120) * 1000;
    const records = await this.store.list();
    const items = [];

    for (const record of records) {
      if (record.status !== STATUS_IN_PROGRESS || timeMs(record.updatedAt) < cutoff) {
        continue;
      }

      const mediaFile = await mediaFileForRecord(mediaIndex, record);
      if (!mediaFile) {
        continue;
      }

      items.push({
        ...await this.cardForRecord(mediaIndex, metadata, authToken, authParamName, record, mediaFile, "active"),
        userId: record.userId || "global",
        cacheKey: record.cacheKey || null,
        activeAgoSeconds: Math.max(0, Math.round((Date.now() - timeMs(record.updatedAt)) / 1000))
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
    const cached = metadata && metadata.getCachedForMedia
      ? await metadata.getCachedForMedia(record.mediaType, metadataIdForMediaFile(mediaFile))
      : null;
    const title = cached && cached.available && cached.title ? cached.title : item.title;
    return {
      ...item,
      title,
      metadataTitle: cached && cached.available ? cached.title : null,
      metadataAliases: cached && cached.available ? cached.aliases || [] : [],
      posterUrl: cached && cached.posterFilename ? metadata.posterUrl(cached.posterFilename, authToken, authParamName) : item.posterUrl,
      thumbnailUrl: (item.showId || item.localThumbnail) && metadata
        ? metadata.thumbnailUrl(record.mediaType, item.id, authToken, authParamName)
        : item.thumbnailUrl,
      seasonPosterUrl: item.showId && metadata
        ? metadata.seasonPosterUrl(record.mediaType, item.id, authToken, authParamName)
        : null,
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

async function mediaFileForRecord(mediaIndex, record) {
  const library = mediaIndex.libraryForKey(record.mediaType);
  if (!library || library.trackProgress === false) {
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
