const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const { createMediaQueueItem, MAX_QUEUE_ITEMS, publicQueueItem } = require("./mediaQueue");
const { resolveMediaFile } = require("./mediaResolver");
const { httpError } = require("../utils/httpErrors");
const logger = require("../utils/logger");

const DEFAULT_EXPIRES_SECONDS = 24 * 60 * 60;
const INACTIVE_AFTER_MS = 30 * 1000;
const MEDIA_PUBLISH_AHEAD_SECONDS = 18;
const HOLDING_AHEAD_SEGMENTS = 2;
const PLAYLIST_SEGMENTS = 120;
const SEGMENT_MEMORY = 360;

class CopyQueueService {
  constructor({ store, mediaIndex, hls, fallbackStream, progress, skipDetection }) {
    this.store = store;
    this.mediaIndex = mediaIndex;
    this.hls = hls;
    this.fallbackStream = fallbackStream;
    this.progress = progress;
    this.skipDetection = skipDetection;
    this.queues = new Map();
    this.queueIdsByTokenHash = new Map();
    this.fallbackSourcePromise = null;
  }

  async init() {
    for (const queue of await this.store.list()) this.register(queue);
  }

  async create(user, values) {
    requireStreamQueuePermission(user);
    const token = crypto.randomBytes(32).toString("base64url");
    const now = new Date();
    const expiresInSeconds = normalizeExpiration(values.expiresInSeconds);
    const item = await this.createItem(user, values);
    const queue = {
      id: crypto.randomBytes(12).toString("hex"),
      tokenHash: hash(token),
      ownerUserId: user.id,
      ownerName: user.username,
      name: cleanName(values.name, item.title),
      state: "idle",
      currentIndex: 0,
      profile: item.streamOptions,
      items: [item],
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: expiresInSeconds === null
        ? null
        : new Date(now.getTime() + expiresInSeconds * 1000).toISOString(),
      runtime: runtimeState()
    };
    this.register(queue);
    await this.store.save(queue);
    this.prewarm(queue, item);
    logger.info(`[copy-queue] created id=${queue.id} owner=${user.id} mediaType=${item.mediaType} mediaId=${item.mediaId}`);
    return { queue: publicQueue(queue), token };
  }

  list(user) {
    requireStreamQueuePermission(user);
    const isAdmin = Boolean(user && user.permissions && user.permissions.isAdmin);
    return [...this.queues.values()]
      .filter((queue) => (isAdmin || queue.ownerUserId === user.id) && !expired(queue))
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .map(publicQueue);
  }

  getOwned(user, queueId) {
    requireStreamQueuePermission(user);
    const queue = this.queues.get(queueId);
    const isAdmin = Boolean(user && user.permissions && user.permissions.isAdmin);
    if (!queue || (!isAdmin && queue.ownerUserId !== user.id) || expired(queue)) throw httpError(404, "Stream not found");
    return queue;
  }

  async add(user, queueId, values) {
    const queue = this.getOwned(user, queueId);
    if (queue.items.length >= MAX_QUEUE_ITEMS) throw httpError(409, `A stream can contain at most ${MAX_QUEUE_ITEMS} items`);
    const item = await this.createItem(user, values);
    queue.items.push(item);
    queue.updatedAt = new Date().toISOString();
    if (queue.currentIndex >= queue.items.length - 1 && queue.state === "finished") {
      queue.currentIndex = queue.items.length - 1;
      queue.state = "idle";
      resetRuntimeCurrent(queue.runtime);
    }
    await this.store.save(queue);
    if (queue.state === "idle" && queue.items[queue.currentIndex] === item) this.prewarm(queue, item);
    return publicQueue(queue);
  }

  async reorder(user, queueId, itemIds) {
    const queue = this.getOwned(user, queueId);
    const futureStart = queue.state === "idle" ? queue.currentIndex : queue.currentIndex + 1;
    const fixed = queue.items.slice(0, futureStart);
    const future = queue.items.slice(futureStart);
    const requested = Array.isArray(itemIds) ? itemIds.map(String) : [];
    if (requested.length !== future.length || new Set(requested).size !== requested.length) {
      throw httpError(400, "Provide every editable queue item exactly once");
    }
    const byId = new Map(future.map((item) => [item.id, item]));
    const ordered = requested.map((id) => byId.get(id));
    if (ordered.some((item) => !item)) throw httpError(400, "Queue order contains an unknown item");
    queue.items = [...fixed, ...ordered];
    queue.updatedAt = new Date().toISOString();
    await this.store.save(queue);
    return publicQueue(queue);
  }

  async removeItem(user, queueId, itemId) {
    const queue = this.getOwned(user, queueId);
    const index = queue.items.findIndex((item) => item.id === itemId);
    const editableFrom = queue.state === "idle" ? queue.currentIndex : queue.currentIndex + 1;
    if (index < editableFrom) throw httpError(409, "The current or completed item cannot be removed");
    queue.items.splice(index, 1);
    queue.updatedAt = new Date().toISOString();
    await this.store.save(queue);
    return publicQueue(queue);
  }

  async skip(user, queueId) {
    const queue = this.getOwned(user, queueId);
    if (queue.state !== "playing") throw httpError(409, "The stream is not playing");
    if (!queue.items[queue.currentIndex]) throw httpError(409, "The stream has finished");
    await this.advance(queue, "skipped");
    return publicQueue(queue);
  }

  async play(user, queueId) {
    const queue = this.getOwned(user, queueId);
    if (!queue.items[queue.currentIndex]) throw httpError(409, "Add media before starting the stream");
    if (queue.state === "playing") return publicQueue(queue);
    queue.state = "playing";
    queue.updatedAt = new Date().toISOString();
    resetRuntimeCurrent(queue.runtime);
    await this.store.save(queue);
    this.prewarm(queue, queue.items[queue.currentIndex]);
    logger.info(`[copy-queue] playback started id=${queue.id} owner=${user.id} currentIndex=${queue.currentIndex}`);
    return publicQueue(queue);
  }

  async revoke(user, queueId) {
    const queue = this.getOwned(user, queueId);
    this.queues.delete(queue.id);
    this.queueIdsByTokenHash.delete(queue.tokenHash);
    await this.store.remove(queue.id);
    logger.info(`[copy-queue] revoked id=${queue.id} owner=${user.id}`);
  }

  async playlist(token) {
    const queue = this.findByToken(token);
    const now = Date.now();
    const runtime = queue.runtime || (queue.runtime = runtimeState());
    if (runtime.lastAccessAt && now - runtime.lastAccessAt > INACTIVE_AFTER_MS) {
      const pauseMs = now - runtime.lastAccessAt;
      if (runtime.currentStartedAt) runtime.currentStartedAt += pauseMs;
      if (runtime.holdingStartedAt) runtime.holdingStartedAt += pauseMs;
    }
    runtime.lastAccessAt = now;
    if (!runtime.refreshPromise) {
      runtime.refreshPromise = this.refresh(queue, now)
        .finally(() => { runtime.refreshPromise = null; });
    }
    await runtime.refreshPromise;
    let visible = runtime.history.slice(-PLAYLIST_SEGMENTS);
    const lastHoldingIndex = visible.findLastIndex((entry) => entry.fallback);
    if (lastHoldingIndex >= 0 && visible[lastHoldingIndex + 1]?.item) {
      visible = visible.slice(lastHoldingIndex + 1);
    }
    if (visible.length === 0) throw httpError(503, "Stream is preparing");
    const targetDuration = Math.max(1, ...visible.map((entry) => Math.ceil(entry.duration)));
    const lines = [
      "#EXTM3U",
      "#EXT-X-VERSION:6",
      `#EXT-X-TARGETDURATION:${targetDuration}`,
      `#EXT-X-MEDIA-SEQUENCE:${visible[0].sequence}`,
      `#EXT-X-DISCONTINUITY-SEQUENCE:${visible[0].discontinuitiesBefore}`
    ];
    for (const entry of visible) {
      if (entry.discontinuity) lines.push("#EXT-X-DISCONTINUITY");
      lines.push(`#EXTINF:${entry.duration.toFixed(3)},`);
      lines.push(`/api/copy-queues/stream/${encodeURIComponent(token)}/segments/${entry.sequence}.ts`);
    }
    return lines.join("\n");
  }

  async segment(token, sequence) {
    const queue = this.findByToken(token);
    const entry = queue.runtime && queue.runtime.segments.get(Number(sequence));
    if (!entry) throw httpError(404, "Queue segment is no longer available");
    if (entry.filePath) return { queue, entry, filePath: entry.filePath, release: () => {} };
    const result = await this.hls.waitForCachedFile(entry.cacheKey, entry.filename);
    if (!result || result.status !== "ready") throw httpError(result && result.status === "pending" ? 503 : 404, "Queue segment is not available");
    return {
      queue,
      entry,
      filePath: result.filePath,
      release: this.hls.beginCacheRead(entry.cacheKey)
    };
  }

  recordDelivery(queue, entry) {
    if (!this.progress || !entry.item || entry.fallback) return;
    const key = `${entry.item.id}:${entry.filename}`;
    if (queue.runtime.delivered.has(key)) return;
    queue.runtime.delivered.add(key);
    const library = this.mediaIndex.libraryForKey(entry.item.mediaType);
    if (!library) return;
    this.hls.segmentProgress(entry.cacheKey, entry.filename)
      .then((segmentProgress) => segmentProgress && this.progress.recordSegmentDelivery(
        queue.ownerUserId,
        entry.item.mediaType,
        entry.item.mediaId,
        entry.cacheKey,
        `${queue.id}:${entry.item.id}`,
        segmentProgress,
        {
          trackProgress: library.trackProgress !== false,
          completionStartSeconds: entry.item.completionStartSeconds
        }
      ))
      .catch((err) => logger.error(`[copy-queue] progress failed id=${queue.id} message="${err.message}"`, err));
  }

  async refresh(queue, now) {
    const runtime = queue.runtime;
    if (queue.state !== "playing") {
      const readyItem = queue.state === "idle" ? queue.items[queue.currentIndex] : null;
      if (readyItem) this.prewarm(queue, readyItem);
      await this.publishHolding(queue, now);
      return;
    }
    let transitions = 0;
    while (transitions < 4) {
      const item = queue.items[queue.currentIndex];
      if (!item) {
        queue.state = "finished";
        await this.publishHolding(queue, now);
        return;
      }
      if (runtime.mode !== `item:${item.id}`) {
        runtime.mode = `item:${item.id}`;
        runtime.currentStartedAt = 0;
        runtime.sourceCursor = 0;
        runtime.holdingStartedAt = 0;
        queue.state = "playing";
      }
      let source;
      try {
        source = await this.sourceFor(queue, item);
      } catch (err) {
        logger.error(`[copy-queue] item skipped id=${queue.id} mediaType=${item.mediaType} mediaId=${item.mediaId} message="${err.message}"`, err);
        await this.advance(queue, "unavailable");
        transitions += 1;
        continue;
      }
      if (queue.items[queue.currentIndex] !== item || runtime.mode !== `item:${item.id}`) {
        transitions += 1;
        continue;
      }
      if (!runtime.currentStartedAt) runtime.currentStartedAt = Date.now();
      const elapsed = Math.max(0, (Date.now() - runtime.currentStartedAt) / 1000);
      const horizon = elapsed + MEDIA_PUBLISH_AHEAD_SECONDS;
      while (runtime.sourceCursor < source.segments.length
        && source.segments[runtime.sourceCursor].startSeconds < horizon) {
        const segment = source.segments[runtime.sourceCursor];
        this.publish(queue, {
          duration: segment.duration,
          cacheKey: source.cacheKey,
          filename: segment.filename,
          item,
          discontinuity: runtime.sourceCursor === 0
        });
        runtime.sourceCursor += 1;
      }
      const duration = source.duration || item.durationSeconds;
      if (duration > 0 && elapsed >= duration && runtime.sourceCursor >= source.segments.length) {
        await this.advance(queue, "completed");
        transitions += 1;
        continue;
      }
      if (duration > 0 && duration - elapsed < 60) {
        const next = queue.items[queue.currentIndex + 1];
        if (next) this.sourceFor(queue, next).catch(() => {});
      }
      return;
    }
  }

  async sourceFor(queue, item) {
    const runtime = queue.runtime;
    if (runtime.sources.has(item.id)) return runtime.sources.get(item.id);
    if (runtime.sourcePromises.has(item.id)) return runtime.sourcePromises.get(item.id);
    const operation = (async () => {
      const mediaFile = await resolveMediaFile(this.mediaIndex, item.mediaType, item.mediaId);
      const stream = await this.hls.prepare(mediaFile, {
        ...item.streamOptions,
        mediaType: item.mediaType,
        mediaId: item.mediaId,
        rendition: "muxed"
      });
      const parsed = parseMediaPlaylist(await this.hls.getPlaylist(stream.cacheKey));
      if (parsed.segments.length === 0) throw new Error("HLS playlist contains no segments");
      const source = { cacheKey: stream.cacheKey, ...parsed };
      runtime.sources.set(item.id, source);
      return source;
    })().finally(() => runtime.sourcePromises.delete(item.id));
    runtime.sourcePromises.set(item.id, operation);
    return operation;
  }

  async publishHolding(queue, now) {
    const runtime = queue.runtime;
    if (runtime.mode !== "holding") {
      runtime.mode = "holding";
      runtime.holdingStartedAt = now;
      runtime.holdingCursor = 0;
    }
    const source = await this.fallbackSource();
    if (!source || source.segments.length === 0) return;
    const elapsed = Math.max(0, (now - runtime.holdingStartedAt) / 1000);
    const requiredDuration = elapsed + holdingAheadSeconds(source);
    let publishedDuration = runtime.holdingPublishedDuration || 0;
    while (publishedDuration < requiredDuration) {
      const index = runtime.holdingCursor % source.segments.length;
      const segment = source.segments[index];
      this.publish(queue, {
        duration: segment.duration,
        filePath: path.join(source.directory, segment.filename),
        fallback: true,
        discontinuity: runtime.holdingCursor === 0
      });
      runtime.holdingCursor += 1;
      publishedDuration += segment.duration;
    }
    runtime.holdingPublishedDuration = publishedDuration;
  }

  fallbackSource() {
    if (!this.fallbackSourcePromise) {
      this.fallbackSourcePromise = this.fallbackStream.ensurePrepared()
        .then((ready) => ready ? fs.readFile(this.fallbackStream.playlistPath, "utf8") : null)
        .then((playlist) => ({
          ...parseMediaPlaylist(playlist || ""),
          directory: path.dirname(this.fallbackStream.playlistPath)
        }))
        .catch((err) => {
          logger.error(`[copy-queue] fallback playlist unavailable message="${err.message}"`, err);
          return null;
        });
    }
    return this.fallbackSourcePromise;
  }

  prewarm(queue, item) {
    const runtime = queue.runtime;
    const retryAt = runtime.prewarmRetryAt.get(item.id) || 0;
    if (retryAt > Date.now()) return;
    runtime.prewarmRetryAt.set(item.id, Number.POSITIVE_INFINITY);
    this.sourceFor(queue, item)
      .then(() => runtime.prewarmRetryAt.delete(item.id))
      .catch((err) => {
        runtime.prewarmRetryAt.set(item.id, Date.now() + 30 * 1000);
        logger.info(`[copy-queue] prewarm failed id=${queue.id} mediaType=${item.mediaType} mediaId=${item.mediaId} message="${err.message}"`);
      });
  }

  publish(queue, values) {
    const runtime = queue.runtime;
    const entry = {
      sequence: runtime.nextSequence,
      discontinuitiesBefore: runtime.discontinuityCount,
      ...values
    };
    if (entry.discontinuity) runtime.discontinuityCount += 1;
    runtime.nextSequence += 1;
    runtime.history.push(entry);
    runtime.segments.set(entry.sequence, entry);
    if (runtime.history.length > SEGMENT_MEMORY) {
      const removed = runtime.history.splice(0, runtime.history.length - SEGMENT_MEMORY);
      for (const old of removed) runtime.segments.delete(old.sequence);
    }
  }

  async advance(queue, reason) {
    queue.currentIndex += 1;
    queue.state = queue.currentIndex < queue.items.length ? "playing" : "finished";
    queue.updatedAt = new Date().toISOString();
    resetRuntimeCurrent(queue.runtime);
    await this.store.save(queue);
    logger.info(`[copy-queue] advanced id=${queue.id} reason=${reason} currentIndex=${queue.currentIndex}`);
  }

  async createItem(user, values) {
    return createMediaQueueItem({
      mediaIndex: this.mediaIndex,
      skipDetection: this.skipDetection,
      actor: user,
      mediaType: String(values.mediaType || ""),
      mediaId: String(values.mediaId || ""),
      streamOptions: values
    });
  }

  findByToken(token) {
    const queueId = this.queueIdsByTokenHash.get(hash(token));
    const queue = queueId && this.queues.get(queueId);
    if (!queue || expired(queue)) throw httpError(404, "Stream not found");
    return queue;
  }

  register(queue) {
    queue.runtime = runtimeState();
    this.queues.set(queue.id, queue);
    this.queueIdsByTokenHash.set(queue.tokenHash, queue.id);
  }
}

function runtimeState() {
  return {
    mode: "",
    currentStartedAt: 0,
    holdingStartedAt: 0,
    holdingCursor: 0,
    holdingPublishedDuration: 0,
    sourceCursor: 0,
    discontinuityCount: 0,
    nextSequence: Date.now(),
    lastAccessAt: 0,
    history: [],
    segments: new Map(),
    sources: new Map(),
    sourcePromises: new Map(),
    prewarmRetryAt: new Map(),
    delivered: new Set(),
    refreshPromise: null
  };
}

function resetRuntimeCurrent(runtime) {
  if (!runtime) return;
  runtime.mode = "";
  runtime.currentStartedAt = 0;
  runtime.holdingStartedAt = 0;
  runtime.holdingCursor = 0;
  runtime.holdingPublishedDuration = 0;
  runtime.sourceCursor = 0;
}

function parseMediaPlaylist(playlist) {
  const segments = [];
  let duration = null;
  let cursor = 0;
  for (const rawLine of String(playlist || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("#EXTINF:")) {
      duration = Number.parseFloat(line.slice(8));
      continue;
    }
    if (!line || line.startsWith("#") || !Number.isFinite(duration) || duration <= 0) continue;
    const filename = path.basename(line.split("?")[0]);
    segments.push({ filename, duration, startSeconds: cursor });
    cursor += duration;
    duration = null;
  }
  return { segments, duration: cursor };
}

function holdingAheadSeconds(source) {
  const durations = (source.segments || [])
    .slice(0, HOLDING_AHEAD_SEGMENTS)
    .map((segment) => Number(segment.duration) || 0);
  return Math.max(1, durations.reduce((total, duration) => total + duration, 0));
}

function publicQueue(queue) {
  return {
    id: queue.id,
    ownerUserId: queue.ownerUserId,
    ownerName: queue.ownerName,
    name: queue.name,
    state: queue.state,
    currentIndex: queue.currentIndex,
    itemCount: queue.items.length,
    items: queue.items.map((item, index) => {
      const visible = publicQueueItem(item, index, queue.currentIndex);
      if (queue.state === "idle" && index === queue.currentIndex) visible.status = "ready";
      return visible;
    }),
    createdAt: queue.createdAt,
    updatedAt: queue.updatedAt,
    expiresAt: queue.expiresAt
  };
}

function requireStreamQueuePermission(user) {
  const permissions = user && user.permissions || {};
  if (!user || (!permissions.isAdmin && !permissions.canManageStreamQueues)) {
    throw httpError(403, "Stream management permission required");
  }
}

function normalizeExpiration(value) {
  if (value === null || value === "unlimited") return null;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_EXPIRES_SECONDS;
  return Math.min(seconds, 365 * 24 * 60 * 60);
}

function cleanName(value, fallback) {
  return String(value || `${fallback} stream`).trim().slice(0, 255) || "Stream";
}

function expired(queue) {
  return Boolean(queue.expiresAt && Date.parse(queue.expiresAt) <= Date.now());
}

function hash(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

module.exports = { CopyQueueService };
