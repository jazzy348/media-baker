const crypto = require("crypto");
const { WebSocketServer, WebSocket } = require("ws");
const { resolveMediaFile } = require("./mediaResolver");
const { createMediaQueueItem, MAX_QUEUE_ITEMS, publicQueueItem } = require("./mediaQueue");
const logger = require("../utils/logger");

const ROOM_TTL_MS = 24 * 60 * 60 * 1000;
const EMPTY_ROOM_GRACE_MS = 60 * 1000;
const STATE_BROADCAST_MS = 15 * 1000;
const HEARTBEAT_MS = 25 * 1000;

class WatchTogetherService {
  constructor({ store, mediaIndex, playbackTokens, progress, skipDetection }) {
    this.store = store;
    this.mediaIndex = mediaIndex;
    this.playbackTokens = playbackTokens;
    this.progress = progress;
    this.skipDetection = skipDetection;
    this.rooms = new Map();
    this.invites = new Map();
    this.tickets = new Map();
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
    this.stateTimer = null;
    this.heartbeatTimer = null;
  }

  async init() {
    for (const stored of await this.store.list()) {
      const room = runtimeRoom(stored);
      if (!currentQueueItem(room)) {
        await this.store.remove(room.id);
        continue;
      }
      const storedPosition = currentPosition(room);
      activateCurrentQueueItem(room);
      room.positionSeconds = storedPosition;
      room.playbackState = "paused";
      room.stateChangedAt = new Date().toISOString();
      this.rooms.set(room.id, room);
      this.invites.set(room.inviteHash, room.id);
      await this.store.save(room);
      this.scheduleEmptyCleanup(room);
    }
    this.stateTimer = setInterval(() => this.broadcastStates(), STATE_BROADCAST_MS);
    this.stateTimer.unref?.();
    this.heartbeatTimer = setInterval(() => this.heartbeat(), HEARTBEAT_MS);
    this.heartbeatTimer.unref?.();
  }

  attach(server) {
    server.on("upgrade", (request, socket, head) => {
      let parsed;
      try {
        parsed = new URL(request.url, "http://localhost");
      } catch (err) {
        socket.destroy();
        return;
      }
      if (parsed.pathname !== "/api/watch-together/socket") return;
      const ticket = this.tickets.get(hash(parsed.searchParams.get("ticket")));
      const room = ticket && this.rooms.get(ticket.roomId);
      const participant = room && room.participants.get(ticket.participantId);
      if (!room || !participant || participant.removed || Date.parse(room.expiresAt) <= Date.now()) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(request, socket, head, (ws) => this.onConnection(ws, room, participant));
    });
  }

  async create({ user, mediaType, mediaFile, library, streamOptions, skipMarkers, durationSeconds, completionStartSeconds }) {
    const now = Date.now();
    const inviteToken = randomToken(24);
    const firstItem = {
      id: crypto.randomBytes(10).toString("hex"),
      mediaType,
      mediaId: mediaFile.id,
      libraryTitle: library.title,
      title: mediaFile.title || mediaFile.episodeName || mediaFile.filename,
      durationSeconds: Number(durationSeconds) || Number(mediaFile.durationSeconds) || 0,
      streamOptions: { ...streamOptions },
      skipMarkers: Array.isArray(skipMarkers) ? skipMarkers : [],
      completionStartSeconds: Number(completionStartSeconds) || null,
      addedByUserId: user.id,
      addedByName: user.username,
      addedAt: new Date(now).toISOString()
    };
    const room = runtimeRoom({
      id: crypto.randomBytes(12).toString("hex"),
      inviteHash: hash(inviteToken),
      hostUserId: user.id,
      hostName: user.username,
      mediaType,
      mediaId: mediaFile.id,
      mediaTitle: firstItem.title,
      libraryTitle: library.title,
      durationSeconds: firstItem.durationSeconds,
      streamOptions: { ...streamOptions, completionStartSeconds: firstItem.completionStartSeconds },
      skipMarkers: firstItem.skipMarkers,
      queue: [firstItem],
      currentQueueIndex: 0,
      queueRevision: 1,
      playbackState: "paused",
      positionSeconds: 0,
      stateChangedAt: new Date(now).toISOString(),
      everyoneCanControl: false,
      everyoneCanQueue: false,
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ROOM_TTL_MS).toISOString()
    });
    this.rooms.set(room.id, room);
    this.invites.set(room.inviteHash, room.id);
    await this.store.save(room);
    this.scheduleEmptyCleanup(room);
    logger.info(`[watch-together] room created id=${room.id} host="${room.hostName}" mediaType=${mediaType} mediaId=${mediaFile.id}`);
    return { room: publicRoom(room), inviteToken };
  }

  join(inviteToken, principal = null, guestName = "", clientId = "") {
    const roomId = this.invites.get(hash(inviteToken));
    const room = roomId && this.rooms.get(roomId);
    if (!room || Date.parse(room.expiresAt) <= Date.now()) throw statusError(404, "Watch Together room not found");

    const user = principal && principal.user;
    const normalizedClientId = cleanClientId(clientId);
    const identityKey = user ? `user:${user.id}` : `guest:${normalizedClientId}`;
    if (!user && !normalizedClientId) throw statusError(400, "A browser identity is required");
    if (room.bannedKeys.has(identityKey)) throw statusError(403, "You have been removed from this room");
    const displayName = user ? user.username : cleanGuestName(guestName);
    if (!displayName) throw statusError(400, "Enter a name to join");

    let participant = [...room.participants.values()].find((entry) => entry.identityKey === identityKey && !entry.removed);
    if (!participant) {
      participant = {
        id: crypto.randomBytes(10).toString("hex"),
        identityKey,
        userId: user ? user.id : null,
        displayName,
        isHost: Boolean(user && user.id === room.hostUserId),
        connected: false,
        ready: false,
        requiredForPlayback: !room.playbackStarted,
        removed: false,
        everConnected: false,
        ws: null,
        permissions: user ? { ...user.permissions } : null,
        lastProgressAt: 0,
        lastChatAt: 0
      };
      room.participants.set(participant.id, participant);
    } else {
      participant.displayName = displayName;
    }

    this.broadcast(room, { type: "participants", participants: participantList(room) });

    const ticket = randomToken(32);
    if (participant.ticketHash) this.tickets.delete(participant.ticketHash);
    participant.ticketHash = hash(ticket);
    this.tickets.set(participant.ticketHash, { roomId: room.id, participantId: participant.id });
    clearTimeout(room.emptyTimer);
    room.emptyTimer = null;

    const playback = playbackItem(room, participant, this.playbackTokens);
    if (!playback) throw statusError(409, "This Watch Together queue has finished");
    return {
      room: publicRoom(room),
      participant: publicParticipant(participant),
      state: stateSnapshot(room),
      ticket,
      ...playback
    };
  }

  authorizePlayback(payload) {
    const room = payload && this.rooms.get(payload.roomId);
    const participant = room && room.participants.get(payload.participantId);
    const queued = room && room.queue.some((item) => (
      item.mediaType === payload.mediaType && item.mediaId === payload.mediaId
    ));
    return Boolean(room && participant && queued && !participant.removed && Date.parse(room.expiresAt) > Date.now());
  }

  activeRooms() {
    return [...this.rooms.values()].map((room) => ({
      ...publicRoom(room),
      state: stateSnapshot(room),
      connected: [...room.participants.values()].filter((participant) => participant.connected).length,
      participants: participantList(room)
    }));
  }

  async adminClose(roomId, adminName) {
    const room = this.rooms.get(roomId);
    if (!room) throw statusError(404, "Watch Together room not found");
    this.system(room, `${adminName || "An administrator"} closed the room.`);
    await this.closeRoom(room, "closed");
  }

  onConnection(ws, room, participant) {
    if (participant.ws && participant.ws.readyState === WebSocket.OPEN) participant.ws.close(4001, "Reconnected");
    const reconnecting = participant.everConnected;
    participant.ws = ws;
    participant.connected = true;
    participant.ready = false;
    if (room.resumeWhenReady) participant.requiredForPlayback = false;
    participant.everConnected = true;
    participant.alive = true;
    clearTimeout(room.emptyTimer);
    room.emptyTimer = null;

    ws.on("pong", () => { participant.alive = true; });
    ws.on("message", (data) => {
      try {
        this.onMessage(room, participant, data);
      } catch (err) {
        logger.full(`[watch-together] invalid message room=${room.id} participant=${participant.id} message="${err.message}"`);
      }
    });
    ws.on("close", (code) => this.onDisconnect(room, participant, ws, code));
    ws.on("error", (err) => logger.full(`[watch-together] socket error room=${room.id} participant=${participant.id} message="${err.message}"`));

    send(ws, {
      type: "welcome",
      room: publicRoom(room),
      self: publicParticipant(participant),
      state: stateSnapshot(room),
      participants: participantList(room),
      chat: room.chat
    });
    this.system(room, reconnecting ? `${participant.displayName} reconnected.` : `${participant.displayName} joined.`);
    this.broadcast(room, { type: "participants", participants: participantList(room) });
  }

  onDisconnect(room, participant, ws, code) {
    if (participant.ws !== ws) return;
    participant.ws = null;
    participant.connected = false;
    participant.ready = false;
    if (!participant.removed) {
      const interrupted = ![1000, 1001, 4000, 4001, 4003].includes(Number(code));
      this.system(room, interrupted
        ? `${participant.displayName}'s connection was interrupted.`
        : `${participant.displayName} left.`);
    }
    this.broadcast(room, { type: "participants", participants: participantList(room) });
    this.resumeWhenBuffered(room).catch((err) => logger.error(`[watch-together] playback resume failed room=${room.id} message="${err.message}"`, err));
    if (![...room.participants.values()].some((entry) => entry.connected)) this.scheduleEmptyCleanup(room);
  }

  onMessage(room, participant, raw) {
    if (raw.length > 16 * 1024) return;
    let message;
    try { message = JSON.parse(raw.toString("utf8")); } catch (err) { return; }
    if (!message || typeof message !== "object" || Array.isArray(message)) return;
    if (message.type === "ready") {
      if (Number(message.queueRevision) !== Number(room.queueRevision)) return;
      if (Number(message.readinessRevision) !== room.readinessRevision) return;
      participant.ready = Boolean(message.ready);
      if (participant.ready && room.playbackStarted && !participant.requiredForPlayback) {
        participant.requiredForPlayback = true;
      }
      const reportedDuration = Number(message.durationSeconds);
      if ((!Number.isFinite(room.durationSeconds) || room.durationSeconds <= 0)
        && Number.isFinite(reportedDuration)
        && reportedDuration > 0) {
        room.durationSeconds = reportedDuration;
        this.store.save(room).catch((err) => logger.error(`[watch-together] duration save failed room=${room.id} message="${err.message}"`, err));
        this.broadcast(room, { type: "room", room: publicRoom(room) });
      }
      this.broadcast(room, { type: "participants", participants: participantList(room) });
      this.resumeWhenBuffered(room).catch((err) => logger.error(`[watch-together] playback resume failed room=${room.id} message="${err.message}"`, err));
      return;
    }
    if (message.type === "chat") {
      const now = Date.now();
      if (now - participant.lastChatAt < 500) return;
      participant.lastChatAt = now;
      const text = String(message.text || "").trim().slice(0, 500);
      if (text) this.chat(room, participant, text);
      return;
    }
    if (message.type === "control") {
      this.control(room, participant, message).catch((err) => send(participant.ws, { type: "error", message: err.message }));
      return;
    }
    if (message.type === "kick") {
      this.kick(room, participant, String(message.participantId || ""));
      return;
    }
    if (message.type === "permissions") {
      this.changePermissions(room, participant, message);
      return;
    }
    if (message.type === "queue-add") {
      this.addQueueItem(room, participant, message).catch((err) => send(participant.ws, { type: "error", message: err.message }));
      return;
    }
    if (message.type === "queue-remove") {
      this.removeQueueItem(room, participant, String(message.itemId || "")).catch((err) => send(participant.ws, { type: "error", message: err.message }));
      return;
    }
    if (message.type === "queue-order") {
      this.reorderQueue(room, participant, message.itemIds).catch((err) => send(participant.ws, { type: "error", message: err.message }));
      return;
    }
    if (message.type === "queue-skip") {
      if (canControl(room, participant)) {
        this.advanceQueue(room, `${participant.displayName} skipped the current item.`).catch((err) => send(participant.ws, { type: "error", message: err.message }));
      }
      return;
    }
    if (message.type === "ended") {
      const current = currentQueueItem(room);
      const nearEnd = current && current.id === message.itemId
        && currentPosition(room) >= Math.max(0, room.durationSeconds - 5);
      if (nearEnd) {
        this.advanceQueue(room, null).catch((err) => logger.error(`[watch-together] advance failed room=${room.id} message="${err.message}"`, err));
      }
      return;
    }
    if (message.type === "close-room") {
      if (participant.isHost) {
        this.system(room, `${participant.displayName} closed the room.`);
        this.closeRoom(room, "closed").catch((err) => logger.error(`[watch-together] close failed message="${err.message}"`, err));
      }
      return;
    }
    if (message.type === "progress") this.recordProgress(room, participant, message);
  }

  async control(room, participant, message) {
    if (!canControl(room, participant)) throw statusError(403, "Only the host can control playback");
    const action = String(message.action || "");
    const before = currentPosition(room);
    const requested = Number(message.positionSeconds);
    const position = Number.isFinite(requested) ? clamp(requested, 0, room.durationSeconds || requested) : before;
    if (action === "play") {
      const waiting = participantsWaitingForBuffer(room);
      if (waiting.length > 0) {
        throw statusError(409, `Waiting for ${waiting.length} participant${waiting.length === 1 ? "" : "s"} to buffer`);
      }
      const initialPlayback = !room.playbackStarted;
      room.playbackStarted = true;
      room.resumeWhenReady = false;
      room.positionSeconds = initialPlayback ? 0 : position;
      room.playbackState = "playing";
      room.stateChangedAt = new Date().toISOString();
      this.system(room, `${participant.displayName} started playback.`);
    } else if (action === "pause") {
      room.resumeWhenReady = false;
      room.positionSeconds = position;
      room.playbackState = "paused";
      room.stateChangedAt = new Date().toISOString();
      this.system(room, `${participant.displayName} paused playback.`);
    } else if (action === "seek") {
      room.resumeWhenReady = room.playbackState === "playing" || room.resumeWhenReady === "seek"
        ? "seek"
        : false;
      room.readinessRevision += 1;
      room.positionSeconds = position;
      room.playbackState = "paused";
      room.stateChangedAt = new Date().toISOString();
      for (const entry of room.participants.values()) {
        if (entry.requiredForPlayback && !entry.removed) entry.ready = false;
      }
      this.system(room, room.resumeWhenReady
        ? `${participant.displayName} seeked to ${formatTime(position)}. Waiting for everyone to buffer.`
        : `${participant.displayName} seeked to ${formatTime(position)}.`);
    } else {
      return;
    }
    await this.store.save(room);
    this.broadcast(room, { type: "state", state: stateSnapshot(room), actorId: participant.id, reason: action });
    if (action === "seek") this.broadcast(room, { type: "participants", participants: participantList(room) });
  }

  kick(room, actor, participantId) {
    if (!actor.isHost) return;
    const target = room.participants.get(participantId);
    if (!target || target.isHost) return;
    room.bannedKeys.add(target.identityKey);
    target.removed = true;
    this.system(room, `${actor.displayName} removed ${target.displayName} from the room.`);
    send(target.ws, { type: "kicked", message: "You were removed from the Watch Together room." });
    if (target.ticketHash) this.tickets.delete(target.ticketHash);
    target.ws?.close(4003, "Removed");
    room.participants.delete(target.id);
    this.broadcast(room, { type: "participants", participants: participantList(room) });
    this.resumeWhenBuffered(room).catch((err) => logger.error(`[watch-together] playback resume failed room=${room.id} message="${err.message}"`, err));
  }

  changePermissions(room, actor, message) {
    if (!actor.isHost) return;
    const controlEnabled = Boolean(message.everyoneCanControl);
    const queueEnabled = Boolean(message.everyoneCanQueue);
    if (room.everyoneCanControl === controlEnabled && room.everyoneCanQueue === queueEnabled) return;
    const controlChanged = room.everyoneCanControl !== controlEnabled;
    const queueChanged = room.everyoneCanQueue !== queueEnabled;
    room.everyoneCanControl = controlEnabled;
    room.everyoneCanQueue = queueEnabled;
    this.store.save(room).catch((err) => logger.error(`[watch-together] save failed message="${err.message}"`, err));
    if (controlChanged) {
      this.system(room, controlEnabled
        ? `${actor.displayName} allowed everyone to control playback.`
        : `${actor.displayName} limited playback controls to the host.`);
    }
    if (queueChanged) {
      this.system(room, queueEnabled
        ? `${actor.displayName} allowed signed-in participants to add to the queue.`
        : `${actor.displayName} limited queue additions to the host.`);
    }
    this.broadcast(room, { type: "room", room: publicRoom(room) });
  }

  async addQueueItem(room, participant, message) {
    if (!participant.userId) throw statusError(403, "Sign in to add media to the queue");
    if (!participant.isHost && !room.everyoneCanQueue) throw statusError(403, "Only the host can add to the queue");
    if (room.queue.length >= MAX_QUEUE_ITEMS) throw statusError(409, `A room queue can contain at most ${MAX_QUEUE_ITEMS} items`);
    const actor = {
      id: participant.userId,
      username: participant.displayName,
      permissions: participant.permissions || {}
    };
    const item = await createMediaQueueItem({
      mediaIndex: this.mediaIndex,
      skipDetection: this.skipDetection,
      actor,
      mediaType: String(message.mediaType || ""),
      mediaId: String(message.mediaId || ""),
      streamOptions: message.streamOptions || {}
    });
    const wasFinished = room.currentQueueIndex >= room.queue.length;
    room.queue.push(item);
    room.updatedAt = new Date().toISOString();
    this.system(room, `${participant.displayName} added ${item.title} to the queue.`);
    if (wasFinished) {
      room.currentQueueIndex = room.queue.length - 1;
      room.queueRevision += 1;
      activateCurrentQueueItem(room);
      resetParticipantReadiness(room);
      await this.store.save(room);
      this.broadcastRoomAndPlayback(room);
      return;
    }
    await this.store.save(room);
    this.broadcast(room, { type: "room", room: publicRoom(room) });
  }

  async removeQueueItem(room, participant, itemId) {
    if (!participant.isHost) throw statusError(403, "Only the host can remove queued media");
    const index = room.queue.findIndex((item) => item.id === itemId);
    if (index <= room.currentQueueIndex) throw statusError(409, "The current or completed item cannot be removed");
    const [removed] = room.queue.splice(index, 1);
    room.updatedAt = new Date().toISOString();
    await this.store.save(room);
    this.system(room, `${participant.displayName} removed ${removed.title} from the queue.`);
    this.broadcast(room, { type: "room", room: publicRoom(room) });
  }

  async reorderQueue(room, participant, itemIds) {
    if (!participant.isHost) throw statusError(403, "Only the host can reorder the queue");
    const future = room.queue.slice(room.currentQueueIndex + 1);
    const requested = Array.isArray(itemIds) ? itemIds.map(String) : [];
    const byId = new Map(future.map((item) => [item.id, item]));
    if (requested.length !== future.length || new Set(requested).size !== requested.length) {
      throw statusError(400, "Provide every upcoming item exactly once");
    }
    const ordered = requested.map((id) => byId.get(id));
    if (ordered.some((item) => !item)) throw statusError(400, "Queue order contains an unknown item");
    room.queue = [...room.queue.slice(0, room.currentQueueIndex + 1), ...ordered];
    room.updatedAt = new Date().toISOString();
    await this.store.save(room);
    this.system(room, `${participant.displayName} reordered the queue.`);
    this.broadcast(room, { type: "room", room: publicRoom(room) });
  }

  async advanceQueue(room, announcement) {
    if (room.transitioning) return;
    room.transitioning = true;
    try {
      const previous = currentQueueItem(room);
      room.positionSeconds = room.durationSeconds;
      room.playbackState = "paused";
      room.stateChangedAt = new Date().toISOString();
      room.currentQueueIndex += 1;
      room.queueRevision += 1;
      room.resumeWhenReady = room.currentQueueIndex < room.queue.length ? "queue" : false;
      if (announcement) this.system(room, announcement);
      if (!currentQueueItem(room)) {
        room.resumeWhenReady = false;
        await this.store.save(room);
        this.system(room, previous ? `${previous.title} finished. The queue is empty.` : "The queue is empty.");
        this.broadcast(room, { type: "room", room: publicRoom(room) });
        this.broadcast(room, { type: "state", state: stateSnapshot(room), reason: "queue-finished" });
        return;
      }
      activateCurrentQueueItem(room);
      resetParticipantReadiness(room);
      await this.store.save(room);
      this.system(room, `Up next: ${room.mediaTitle}. Waiting for everyone to buffer.`);
      this.broadcastRoomAndPlayback(room);
    } finally {
      room.transitioning = false;
    }
  }

  async resumeWhenBuffered(room) {
    if (!room.resumeWhenReady || participantsWaitingForBuffer(room).length > 0) return;
    if (![...room.participants.values()].some((participant) => participant.connected && !participant.removed)) return;
    const reason = room.resumeWhenReady;
    room.resumeWhenReady = false;
    room.playbackStarted = true;
    if (reason === "queue") room.positionSeconds = 0;
    room.playbackState = "playing";
    room.stateChangedAt = new Date().toISOString();
    const resumedAt = room.stateChangedAt;
    const readinessRevision = room.readinessRevision;
    await this.store.save(room);
    if (room.playbackState !== "playing" || room.stateChangedAt !== resumedAt || room.readinessRevision !== readinessRevision) return;
    this.system(room, reason === "queue" ? `${room.mediaTitle} started.` : `Playback resumed at ${formatTime(room.positionSeconds)}.`);
    this.broadcast(room, { type: "state", state: stateSnapshot(room), reason: reason === "queue" ? "queue-start" : "seek-resume" });
  }

  broadcastRoomAndPlayback(room) {
    this.broadcast(room, { type: "room", room: publicRoom(room) });
    this.broadcast(room, { type: "participants", participants: participantList(room) });
    for (const participant of room.participants.values()) {
      send(participant.ws, {
        type: "item",
        room: publicRoom(room),
        playback: playbackItem(room, participant, this.playbackTokens)
      });
    }
  }

  chat(room, participant, text) {
    const message = { id: randomToken(8), type: "message", participantId: participant.id, name: participant.displayName, text, createdAt: new Date().toISOString() };
    room.chat.push(message);
    room.chat = room.chat.slice(-100);
    this.broadcast(room, { type: "chat", message });
  }

  system(room, text) {
    const message = { id: randomToken(8), type: "system", text, createdAt: new Date().toISOString() };
    room.chat.push(message);
    room.chat = room.chat.slice(-100);
    this.broadcast(room, { type: "chat", message });
  }

  recordProgress(room, participant, message) {
    if (!participant.userId || Date.now() - participant.lastProgressAt < 4000) return;
    participant.lastProgressAt = Date.now();
    const library = this.mediaIndex.libraryForKey(room.mediaType);
    if (!library || library.trackProgress === false) return;
    const duration = Number(message.durationSeconds) || room.durationSeconds;
    this.progress.recordPlaybackPosition(
      participant.userId,
      room.mediaType,
      room.mediaId,
      Number(message.positionSeconds) || 0,
      duration,
      { completionStartSeconds: room.streamOptions.completionStartSeconds }
    ).catch((err) => logger.error(`[watch-together] progress failed room=${room.id} user=${participant.userId} message="${err.message}"`, err));
  }

  broadcastStates() {
    for (const room of this.rooms.values()) {
      if ([...room.participants.values()].some((participant) => participant.connected)) {
        this.broadcast(room, { type: "state", state: stateSnapshot(room), reason: "sync" });
      }
    }
  }

  heartbeat() {
    for (const room of this.rooms.values()) {
      for (const participant of room.participants.values()) {
        if (!participant.connected || !participant.ws) continue;
        if (participant.alive === false) {
          participant.ws.terminate();
          continue;
        }
        participant.alive = false;
        participant.ws.ping();
      }
    }
  }

  broadcast(room, message) {
    for (const participant of room.participants.values()) send(participant.ws, message);
  }

  scheduleEmptyCleanup(room) {
    clearTimeout(room.emptyTimer);
    room.emptyTimer = setTimeout(() => {
      room.emptyTimer = null;
      if (![...room.participants.values()].some((participant) => participant.connected)) {
        this.closeRoom(room, "empty").catch((err) => logger.error(`[watch-together] empty room cleanup failed message="${err.message}"`, err));
      }
    }, EMPTY_ROOM_GRACE_MS);
    room.emptyTimer.unref?.();
  }

  async closeRoom(room, reason) {
    if (!this.rooms.has(room.id)) return;
    this.broadcast(room, { type: "room-closed", reason });
    for (const participant of room.participants.values()) {
      if (participant.ticketHash) this.tickets.delete(participant.ticketHash);
      participant.ws?.close(4000, reason);
    }
    clearTimeout(room.emptyTimer);
    this.rooms.delete(room.id);
    this.invites.delete(room.inviteHash);
    await this.store.remove(room.id);
    logger.info(`[watch-together] room closed id=${room.id} reason=${reason}`);
  }

  async close() {
    clearInterval(this.stateTimer);
    clearInterval(this.heartbeatTimer);
    for (const room of [...this.rooms.values()]) {
      room.positionSeconds = currentPosition(room);
      room.playbackState = "paused";
      room.stateChangedAt = new Date().toISOString();
      await this.store.save(room);
      for (const participant of room.participants.values()) participant.ws?.close(1001, "Server stopping");
    }
    this.wss.close();
  }
}

function runtimeRoom(room) {
  return {
    ...room,
    queue: Array.isArray(room.queue) ? room.queue : [],
    currentQueueIndex: Math.max(0, Number(room.currentQueueIndex) || 0),
    queueRevision: Math.max(1, Number(room.queueRevision) || 1),
    everyoneCanQueue: Boolean(room.everyoneCanQueue),
    playbackStarted: Boolean(
      room.playbackStarted
      || Number(room.positionSeconds) > 0
      || room.playbackState === "playing"
    ),
    resumeWhenReady: false,
    readinessRevision: 0,
    transitioning: false,
    participants: new Map(),
    chat: [],
    bannedKeys: new Set(),
    emptyTimer: null
  };
}

function currentPosition(room) {
  const base = Number(room.positionSeconds) || 0;
  if (room.playbackState !== "playing") return clamp(base, 0, room.durationSeconds || base);
  return clamp(base + Math.max(0, Date.now() - Date.parse(room.stateChangedAt)) / 1000, 0, room.durationSeconds || Infinity);
}

function stateSnapshot(room) {
  return {
    state: room.playbackState,
    positionSeconds: currentPosition(room),
    changedAt: room.stateChangedAt,
    serverTime: new Date().toISOString(),
    readinessRevision: room.readinessRevision
  };
}

function publicRoom(room) {
  const current = currentQueueItem(room);
  return {
    id: room.id,
    mediaType: room.mediaType,
    mediaId: room.mediaId,
    mediaTitle: room.mediaTitle,
    libraryTitle: room.libraryTitle,
    durationSeconds: room.durationSeconds,
    hostUserId: room.hostUserId,
    hostName: room.hostName,
    everyoneCanControl: room.everyoneCanControl,
    everyoneCanQueue: room.everyoneCanQueue,
    queueRevision: room.queueRevision,
    currentQueueIndex: room.currentQueueIndex,
    currentQueueItemId: current && current.id || null,
    queue: room.queue.map((item, index) => publicQueueItem(item, index, room.currentQueueIndex)),
    skipMarkers: current && current.skipMarkers || [],
    createdAt: room.createdAt,
    expiresAt: room.expiresAt
  };
}

function currentQueueItem(room) {
  return room.queue[room.currentQueueIndex] || null;
}

function activateCurrentQueueItem(room) {
  const item = currentQueueItem(room);
  if (!item) return false;
  room.mediaType = item.mediaType;
  room.mediaId = item.mediaId;
  room.mediaTitle = item.title;
  room.libraryTitle = item.libraryTitle || room.libraryTitle;
  room.durationSeconds = Number(item.durationSeconds) || 0;
  room.streamOptions = {
    ...item.streamOptions,
    completionStartSeconds: Number(item.completionStartSeconds) || null
  };
  room.skipMarkers = item.skipMarkers || [];
  room.positionSeconds = 0;
  room.playbackState = "paused";
  room.stateChangedAt = new Date().toISOString();
  return true;
}

function resetParticipantReadiness(room) {
  for (const participant of room.participants.values()) {
    if (participant.connected && !participant.removed) {
      participant.ready = false;
      participant.requiredForPlayback = true;
    }
  }
}

function canControl(room, participant) {
  return Boolean(participant && (participant.isHost || room.everyoneCanControl));
}

function playbackItem(room, participant, playbackTokens) {
  const item = currentQueueItem(room);
  if (!item) return null;
  const options = item.streamOptions || {};
  const token = playbackTokens.createWatchStreamToken(room.id, participant.id, item.mediaType, item.mediaId);
  const query = new URLSearchParams({
    audio: options.audio || "",
    subtitle: options.subtitle || "none",
    audioChannels: options.audioChannels || "preserve",
    quality: options.quality || "original",
    playbackToken: token
  });
  return {
    queueItemId: item.id,
    queueRevision: room.queueRevision,
    mediaType: item.mediaType,
    mediaId: item.mediaId,
    title: item.title,
    category: item.libraryTitle || room.libraryTitle,
    durationSeconds: item.durationSeconds,
    skipMarkers: item.skipMarkers || [],
    streamUrl: `/api/watch-streams/${encodeURIComponent(item.mediaType)}/${encodeURIComponent(item.mediaId)}/master.m3u8?${query}`
  };
}

function publicParticipant(participant) {
  return {
    id: participant.id,
    name: participant.displayName,
    isHost: participant.isHost,
    connected: participant.connected,
    ready: participant.ready,
    blocksPlayback: Boolean(participant.requiredForPlayback)
      && (participant.connected || !participant.everConnected),
    loggedIn: Boolean(participant.userId)
  };
}

function participantList(room) {
  return [...room.participants.values()].filter((participant) => !participant.removed).map(publicParticipant);
}

function participantsWaitingForBuffer(room) {
  return [...room.participants.values()].filter((participant) => (
    !participant.removed
    && participant.requiredForPlayback
    && (participant.connected || !participant.everConnected)
    && !participant.ready
  ));
}

function send(ws, message) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function randomToken(bytes) { return crypto.randomBytes(bytes).toString("base64url"); }
function hash(value) { return crypto.createHash("sha256").update(String(value || "")).digest("hex"); }
function clamp(value, minimum, maximum) { return Math.max(minimum, Math.min(maximum, value)); }
function cleanGuestName(value) { return String(value || "").replace(/[\r\n\t]/g, " ").replace(/\s+/g, " ").trim().slice(0, 32); }
function cleanClientId(value) { return String(value || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 100); }
function formatTime(seconds) { const total = Math.max(0, Math.floor(seconds)); return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`; }
function statusError(status, message) { const error = new Error(message); error.status = status; return error; }

module.exports = { WatchTogetherService };
