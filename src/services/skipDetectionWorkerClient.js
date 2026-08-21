const path = require("path");
const { fork } = require("child_process");
const logger = require("../utils/logger");
const { episodeMarkerId } = require("./skipDetectionService");

const REQUEST_TIMEOUT_MS = 60 * 1000;
const RESTART_DELAY_MS = 1000;

class SkipDetectionWorkerClient {
  constructor(config, store, options = {}) {
    this.config = config;
    this.store = store;
    this.workerPath = options.workerPath || path.resolve(__dirname, "..", "skipDetectionWorker.js");
    this.child = null;
    this.ready = false;
    this.started = false;
    this.closing = false;
    this.nextRequestId = 1;
    this.pending = new Map();
    this.outbox = [];
    this.restartTimer = null;
    this.handleParentExit = () => this.close();
    process.once("exit", this.handleParentExit);
  }

  start() {
    this.started = true;
    this.ensureWorker();
    this.notify("start");
  }

  stop() {
    this.notify("stop");
  }

  restart() {
    this.notify("restart");
  }

  enabled() {
    return Boolean(this.config.skipDetection && this.config.skipDetection.enabled);
  }

  schedule(reason = "index-scan") {
    if (this.enabled()) {
      this.notify("schedule", { reason });
    }
  }

  getStatus() {
    return this.request("getStatus");
  }

  getTaskStatus() {
    return this.request("getTaskStatus");
  }

  retryFailures() {
    return this.request("retryFailures");
  }

  reanalyse(options = {}) {
    return this.request("reanalyse", options);
  }

  markerReviews(limit = 200) {
    return this.request("markerReviews", { limit });
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

  close() {
    if (this.closing) {
      return;
    }
    this.closing = true;
    this.started = false;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.rejectPending(new Error("Skip-detection worker stopped"));
    this.outbox = [];
    if (this.child && !this.child.killed) {
      this.child.kill();
    }
    this.child = null;
    this.ready = false;
  }

  ensureWorker() {
    if (this.closing || this.child) {
      return;
    }
    const child = fork(this.workerPath, [], {
      cwd: path.resolve(__dirname, "..", ".."),
      env: process.env,
      stdio: ["inherit", "inherit", "inherit", "ipc"]
    });
    this.child = child;
    this.ready = false;
    logger.info(`[skip-detection] started analysis worker pid=${child.pid}`);
    child.on("message", (message) => this.handleMessage(message));
    child.once("error", (err) => {
      logger.error(`[skip-detection] analysis worker error message="${err.message}"`, err);
    });
    child.once("exit", (code, signal) => this.handleExit(child, code, signal));
  }

  handleMessage(message) {
    if (!message || typeof message !== "object") {
      return;
    }
    if (message.type === "skip-detection-ready") {
      this.ready = true;
      this.flushOutbox();
      return;
    }
    if (message.type !== "skip-detection-response") {
      return;
    }
    const pending = this.pending.get(message.requestId);
    if (!pending) {
      return;
    }
    this.pending.delete(message.requestId);
    clearTimeout(pending.timeout);
    if (message.ok) {
      pending.resolve(message.result);
    } else {
      pending.reject(new Error(message.error || "Skip-detection worker request failed"));
    }
  }

  handleExit(child, code, signal) {
    if (this.child !== child) {
      return;
    }
    this.child = null;
    this.ready = false;
    this.outbox = this.outbox.filter((message) => !message.requestId);
    this.rejectPending(new Error("Skip-detection worker exited"));
    if (this.closing) {
      return;
    }
    logger.error(
      `[skip-detection] analysis worker exited code=${code == null ? "none" : code}`
      + ` signal=${signal || "none"}; restarting in ${RESTART_DELAY_MS}ms`
    );
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.ensureWorker();
      if (this.started) {
        this.notify("restart");
      }
    }, RESTART_DELAY_MS);
    this.restartTimer.unref?.();
  }

  request(command, payload = {}) {
    if (this.closing) {
      return Promise.reject(new Error("Skip-detection worker is stopped"));
    }
    this.ensureWorker();
    const requestId = String(this.nextRequestId++);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Skip-detection worker timed out command=${command}`));
      }, REQUEST_TIMEOUT_MS);
      timeout.unref?.();
      this.pending.set(requestId, { resolve, reject, timeout });
      this.sendOrQueue({
        type: "skip-detection-request",
        requestId,
        command,
        payload
      });
    });
  }

  notify(command, payload = {}) {
    if (this.closing) {
      return;
    }
    this.ensureWorker();
    this.sendOrQueue({
      type: "skip-detection-request",
      requestId: null,
      command,
      payload
    });
  }

  sendOrQueue(message) {
    if (!this.child || !this.ready || !this.child.connected) {
      this.outbox.push(message);
      return;
    }
    this.send(message);
  }

  flushOutbox() {
    const messages = this.outbox;
    this.outbox = [];
    for (const message of messages) {
      this.send(message);
    }
  }

  send(message) {
    if (!this.child || !this.child.connected) {
      this.outbox.push(message);
      return;
    }
    this.child.send(message, (err) => {
      if (err && !this.closing) {
        logger.error(`[skip-detection] worker IPC send failed message="${err.message}"`, err);
      }
    });
  }

  rejectPending(err) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(err);
    }
    this.pending.clear();
  }
}

module.exports = { SkipDetectionWorkerClient };
