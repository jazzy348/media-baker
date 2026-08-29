const fs = require("fs/promises");
const path = require("path");
const mysql = require("mysql2/promise");

class WatchTogetherStore {
  constructor(config) {
    this.config = config;
    this.jsonPath = config.watchTogetherStorePath;
    this.pool = null;
    this.initialized = false;
    this.jsonWriteQueue = Promise.resolve();
  }

  async list() {
    await this.init();
    if (this.config.mysql.enabled) {
      const [rows] = await this.pool.execute(
        `SELECT room_id, invite_hash, host_user_id, host_name, media_type, media_id,
                media_title, library_title, duration_seconds, stream_options_json,
                playback_state, position_seconds, state_changed_at,
                everyone_can_control, created_at, updated_at, expires_at
         FROM watch_together_rooms
         WHERE expires_at > CURRENT_TIMESTAMP(3)`
      );
      return rows.map(fromMysql);
    }
    const data = await this.readJson();
    return Object.values(data).filter((room) => Date.parse(room.expiresAt) > Date.now());
  }

  async save(room) {
    await this.init();
    if (this.config.mysql.enabled) {
      await this.pool.execute(
        `INSERT INTO watch_together_rooms
          (room_id, invite_hash, host_user_id, host_name, media_type, media_id,
           media_title, library_title, duration_seconds, stream_options_json,
           playback_state, position_seconds, state_changed_at,
           everyone_can_control, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           host_name = VALUES(host_name), media_title = VALUES(media_title),
           library_title = VALUES(library_title), duration_seconds = VALUES(duration_seconds),
           stream_options_json = VALUES(stream_options_json), playback_state = VALUES(playback_state),
           position_seconds = VALUES(position_seconds), state_changed_at = VALUES(state_changed_at),
           everyone_can_control = VALUES(everyone_can_control), expires_at = VALUES(expires_at),
           updated_at = CURRENT_TIMESTAMP(3)`,
        [
          room.id, room.inviteHash, room.hostUserId, room.hostName, room.mediaType, room.mediaId,
          room.mediaTitle, room.libraryTitle, room.durationSeconds, JSON.stringify(room.streamOptions || {}),
          room.playbackState, room.positionSeconds, new Date(room.stateChangedAt),
          room.everyoneCanControl ? 1 : 0, new Date(room.createdAt), new Date(room.expiresAt)
        ]
      );
      return;
    }
    await this.updateJson((data) => {
      data[room.id] = serializable(room);
    });
  }

  async remove(roomId) {
    await this.init();
    if (this.config.mysql.enabled) {
      await this.pool.execute("DELETE FROM watch_together_rooms WHERE room_id = ?", [roomId]);
      return;
    }
    await this.updateJson((data) => {
      delete data[roomId];
    });
  }

  async init() {
    if (this.initialized) return;
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
        CREATE TABLE IF NOT EXISTS watch_together_rooms (
          room_id VARCHAR(40) NOT NULL,
          invite_hash CHAR(64) NOT NULL,
          host_user_id VARCHAR(64) NOT NULL,
          host_name VARCHAR(128) NOT NULL,
          media_type VARCHAR(64) NOT NULL,
          media_id VARCHAR(64) NOT NULL,
          media_title VARCHAR(512) NOT NULL,
          library_title VARCHAR(255) NOT NULL,
          duration_seconds DOUBLE NOT NULL DEFAULT 0,
          stream_options_json LONGTEXT NOT NULL,
          playback_state VARCHAR(16) NOT NULL DEFAULT 'paused',
          position_seconds DOUBLE NOT NULL DEFAULT 0,
          state_changed_at DATETIME(3) NOT NULL,
          everyone_can_control TINYINT(1) NOT NULL DEFAULT 0,
          created_at DATETIME(3) NOT NULL,
          updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
          expires_at DATETIME(3) NOT NULL,
          PRIMARY KEY (room_id),
          UNIQUE KEY idx_watch_together_invite (invite_hash),
          INDEX idx_watch_together_expires (expires_at)
        )
      `);
    }
    this.initialized = true;
  }

  async readJson() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.jsonPath, "utf8"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch (err) {
      if (err.code === "ENOENT") return {};
      throw err;
    }
  }

  async writeJson(data) {
    await fs.mkdir(path.dirname(this.jsonPath), { recursive: true });
    const temporary = `${this.jsonPath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(data, null, 2));
      await fs.rm(this.jsonPath, { force: true });
      await fs.rename(temporary, this.jsonPath);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  }

  updateJson(update) {
    const operation = this.jsonWriteQueue.then(async () => {
      const data = await this.readJson();
      update(data);
      await this.writeJson(data);
    });
    this.jsonWriteQueue = operation.catch(() => {});
    return operation;
  }
}

function fromMysql(row) {
  let streamOptions = {};
  try {
    streamOptions = typeof row.stream_options_json === "string"
      ? JSON.parse(row.stream_options_json)
      : row.stream_options_json || {};
  } catch (err) {
    streamOptions = {};
  }
  return {
    id: row.room_id,
    inviteHash: row.invite_hash,
    hostUserId: row.host_user_id,
    hostName: row.host_name,
    mediaType: row.media_type,
    mediaId: row.media_id,
    mediaTitle: row.media_title,
    libraryTitle: row.library_title,
    durationSeconds: Number(row.duration_seconds) || 0,
    streamOptions,
    playbackState: row.playback_state,
    positionSeconds: Number(row.position_seconds) || 0,
    stateChangedAt: new Date(row.state_changed_at).toISOString(),
    everyoneCanControl: Boolean(row.everyone_can_control),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString()
  };
}

function serializable(room) {
  const { participants, chat, bannedKeys, emptyTimer, ...stored } = room;
  return stored;
}

module.exports = { WatchTogetherStore };
