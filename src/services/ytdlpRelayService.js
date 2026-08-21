const { execFile, spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const logger = require("../utils/logger");
const { cookieArgsForUrl } = require("../utils/ytdlpCookies");

const RELAY_IDLE_MS = 60 * 1000;
const RELAY_START_TIMEOUT_MS = 30 * 1000;
const RELAY_SEGMENT_SECONDS = 4;
const RELAY_LIST_SIZE = 30;
const RELAY_FORMAT = "bv*[vcodec^=avc1]+ba[acodec^=mp4a]/b[vcodec^=avc1][acodec^=mp4a]/bv*+ba/b";

class YtDlpRelayService {
  constructor(config, ffmpeg) {
    this.config = config;
    this.ytdlp = config.ytdlp;
    this.ffmpeg = ffmpeg;
    this.cacheRoot = path.join(path.dirname(config.hls.cachePath), "yt-dlp-live");
    this.relays = new Map();
    this.idleTimer = null;
  }

  start() {
    this.stop();
    if (!this.ytdlp.enabled) return;
    this.idleTimer = setInterval(() => this.stopIdleRelays(), 10 * 1000);
    this.idleTimer.unref?.();
  }

  restart() {
    this.start();
  }

  stop() {
    clearInterval(this.idleTimer);
    this.idleTimer = null;
    for (const relay of this.relays.values()) {
      this.stopRelay(relay, false);
    }
    this.relays.clear();
  }

  async startRelay(url, userId, title) {
    if (!this.ytdlp.enabled) {
      throw httpError(400, "YT-DLP support is disabled.");
    }
    const inputUrl = validInputUrl(url);
    const existing = [...this.relays.values()].find((relay) => relay.url === inputUrl
      && relay.userId === userId
      && ["starting", "live"].includes(relay.status)
      && !relay.stopped);
    if (existing) {
      existing.lastAccessAt = Date.now();
      await existing.startPromise;
      return publicRelay(existing);
    }

    await fs.mkdir(this.cacheRoot, { recursive: true });
    const id = crypto.randomBytes(12).toString("hex");
    const cacheDir = path.join(this.cacheRoot, id);
    const relay = {
      id,
      url: inputUrl,
      userId,
      title: title || "Live relay",
      cacheDir,
      playlistPath: path.join(cacheDir, "master.m3u8"),
      status: "starting",
      error: null,
      startedAt: new Date().toISOString(),
      lastAccessAt: Date.now(),
      ffmpegProcess: null,
      startPromise: null,
      stopped: false,
      stderr: []
    };
    this.relays.set(id, relay);
    relay.startPromise = this.launch(relay)
      .catch((err) => {
        relay.status = "failed";
        relay.error = err.message;
        throw err;
      });
    relay.startPromise.catch(() => {});
    await relay.startPromise;
    relay.lastAccessAt = Date.now();
    return publicRelay(relay);
  }

  taskStatus() {
    return [...this.relays.values()].map((relay) => ({
      ...publicRelay(relay),
      lastAccessAt: relay.lastAccessAt ? new Date(relay.lastAccessAt).toISOString() : null
    }));
  }

  async playlist(id) {
    const relay = this.getRelay(id);
    relay.lastAccessAt = Date.now();
    await relay.startPromise;
    return fs.readFile(relay.playlistPath, "utf8");
  }

  async streamFile(id, filename) {
    const relay = this.getRelay(id);
    relay.lastAccessAt = Date.now();
    const safeName = path.basename(String(filename || ""));
    if (!/^segment_\d+\.ts$/i.test(safeName)) {
      return null;
    }
    const filePath = path.join(relay.cacheDir, safeName);
    try {
      const stat = await fs.stat(filePath);
      return stat.isFile() ? filePath : null;
    } catch (err) {
      return null;
    }
  }

  getRelay(id) {
    const relay = this.relays.get(String(id || ""));
    if (!relay) throw httpError(404, "Live relay not found.");
    if (relay.status === "failed") throw httpError(502, relay.error || "Live relay failed.");
    return relay;
  }

  assertAccess(id, user) {
    const relay = this.getRelay(id);
    if (!user || !user.permissions || !user.permissions.isAdmin && relay.userId !== user.id) {
      throw httpError(403, "This live relay belongs to another user.");
    }
    return relay;
  }

  async launch(relay) {
    await fs.rm(relay.cacheDir, { recursive: true, force: true });
    await fs.mkdir(relay.cacheDir, { recursive: true });
    const sources = await resolveRelaySources(
      this.ytdlp.binaryPath,
      relay.url,
      await cookieArgsForUrl(this.config, relay.url)
    );
    const hardware = isH264Codec(sources.videoCodec)
      ? {}
      : await this.ffmpeg.detectHardwareProfile();
    const encoder = sources.videoIndex === null
      ? null
      : isH264Codec(sources.videoCodec) ? "copy" : hardware.encoder || "libx264";
    try {
      await this.launchAttempt(relay, sources, encoder, hardware);
    } catch (err) {
      if (!encoder || encoder === "copy" || encoder === "libx264" || relay.stopped) throw err;
      logger.info(`[yt-dlp] relay hardware start failed id=${relay.id} encoder=${encoder} message="${err.message}"; retrying video=libx264`);
      await this.stopProcesses(relay);
      await fs.rm(relay.cacheDir, { recursive: true, force: true });
      await fs.mkdir(relay.cacheDir, { recursive: true });
      await this.launchAttempt(relay, sources, "libx264", {});
    }
    relay.status = "live";
    logger.info(`[yt-dlp] relay ready id=${relay.id} title="${relay.title}"`);
  }

  async launchAttempt(relay, sources, encoder, hardware) {
    const ffmpegArgs = relayFfmpegArgs(relay.cacheDir, relay.playlistPath, sources, encoder, hardware);
    logger.info(`[yt-dlp] relay starting id=${relay.id} title="${relay.title}" video=${sources.videoCodec || "none"}->${encoder || "none"} audio=${sources.audioCodec || "none"}->${sources.audioIndex === null ? "none" : "aac"}`);
    logger.full(`[yt-dlp] relay ffmpeg ${this.ffmpeg.ffmpegPath} ${safeRelayArgs(ffmpegArgs, sources.inputs).map(quoteArg).join(" ")}`);

    const transcoder = spawn(this.ffmpeg.ffmpegPath, ffmpegArgs, {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"]
    });
    relay.ffmpegProcess = transcoder;
    relay.stderr = [];
    transcoder.stderr.on("data", (chunk) => rememberStderr(relay, "ffmpeg", chunk));
    transcoder.once("error", (err) => rememberStderr(relay, "ffmpeg", err.message));

    transcoder.once("exit", (code) => this.handleProcessExit(relay, transcoder, "ffmpeg", code));
    await waitForPlaylist(relay.playlistPath, transcoder, RELAY_START_TIMEOUT_MS, relay);
    if (transcoder.exitCode !== null) {
      throw new Error(`Live relay exited during startup: ${stderrSummary(relay)}`);
    }
  }

  handleProcessExit(relay, child, name, code) {
    if (relay.ffmpegProcess !== child || relay.stopped || relay.status === "starting") return;
    relay.status = code === 0 ? "ended" : "failed";
    relay.error = code === 0 ? null : `${name} exited with code ${code}: ${stderrSummary(relay)}`;
    logger[code === 0 ? "info" : "error"](`[yt-dlp] relay ${relay.status} id=${relay.id} process=${name} code=${code}`);
  }

  stopIdleRelays() {
    const now = Date.now();
    for (const relay of this.relays.values()) {
      if (now - relay.lastAccessAt >= RELAY_IDLE_MS) {
        this.stopRelay(relay, true);
      }
    }
  }

  async stopRelay(relay, remove = true) {
    if (!relay || relay.stopped) return;
    relay.stopped = true;
    relay.status = "stopped";
    await this.stopProcesses(relay);
    if (remove) this.relays.delete(relay.id);
    await fs.rm(relay.cacheDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
    logger.info(`[yt-dlp] relay stopped id=${relay.id} reason=idle`);
  }

  async stopProcesses(relay) {
    const processes = [relay.ffmpegProcess].filter(Boolean);
    relay.ffmpegProcess = null;
    await Promise.all(processes.map(stopProcessAndWait));
  }
}

function relayFfmpegArgs(cacheDir, playlistPath, sources, encoder, hardware) {
  const args = [
    "-hide_banner", "-loglevel", "warning", "-y",
    "-fflags", "+genpts+discardcorrupt"
  ];
  for (const source of sources.inputs) {
    const headers = httpHeaders(source.httpHeaders);
    args.push(
      "-rw_timeout", "15000000",
      "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "10"
    );
    if (headers) args.push("-headers", headers);
    args.push("-i", source.url);
  }
  if (sources.videoIndex !== null) args.push("-map", `${sources.videoIndex}:v:0?`);
  if (sources.audioIndex !== null) args.push("-map", `${sources.audioIndex}:a:0?`);
  args.push("-sn", "-dn");
  if (encoder) {
    args.push("-c:v", encoder, ...relayVideoArgs(encoder, hardware));
    if (encoder !== "copy") {
      args.push("-force_key_frames", `expr:gte(t,n_forced*${RELAY_SEGMENT_SECONDS})`);
    }
  }
  if (sources.audioIndex !== null) {
    args.push(
      "-c:a", "aac", "-b:a", "192k",
      "-af", "aresample=48000:async=1000:first_pts=0", "-ar", "48000"
    );
  }
  args.push(
    "-f", "hls",
    "-hls_time", String(RELAY_SEGMENT_SECONDS),
    "-hls_list_size", String(RELAY_LIST_SIZE),
    "-hls_delete_threshold", "5",
    "-hls_start_number_source", "epoch",
    "-hls_flags", "delete_segments+append_list+omit_endlist+independent_segments+temp_file",
    "-hls_segment_filename", path.join(cacheDir, "segment_%010d.ts"),
    playlistPath
  );
  return args;
}

function relayVideoArgs(encoder, hardware) {
  if (encoder === "copy") return [];
  if (encoder === "h264_nvenc") {
    return ["-preset", "p1", "-tune", "ll", "-rc", "vbr", "-cq", "24", "-spatial-aq", "1", "-pix_fmt", "yuv420p"];
  }
  if (encoder === "h264_vaapi") {
    return ["-vf", hardware.uploadFilter || "format=nv12,hwupload", "-qp", "24"];
  }
  if (encoder === "h264_qsv") {
    return ["-preset", "veryfast", "-global_quality", "24", "-pix_fmt", "yuv420p"];
  }
  if (encoder === "h264_amf") {
    return ["-quality", "speed", "-rc", "cqp", "-qp_i", "24", "-qp_p", "24", "-pix_fmt", "yuv420p"];
  }
  if (encoder === "h264_videotoolbox") {
    return ["-q:v", "65", "-pix_fmt", "yuv420p"];
  }
  return ["-preset", "veryfast", "-tune", "zerolatency", "-crf", "23", "-pix_fmt", "yuv420p"];
}

async function waitForPlaylist(filePath, transcoder, timeoutMs, relay) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (transcoder.exitCode !== null) {
      throw new Error(`Live relay exited before the first segment: ${stderrSummary(relay)}`);
    }
    try {
      const playlist = await fs.readFile(filePath, "utf8");
      const segments = playlist.split(/\r?\n/).filter((line) => line && !line.startsWith("#"));
      if (segments.length > 0 && await fileExists(path.join(path.dirname(filePath), path.basename(segments.at(-1))))) {
        return;
      }
    } catch (err) {
      // The first complete segment has not been written yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for the live relay to start: ${stderrSummary(relay)}`);
}

async function resolveRelaySources(binaryPath, url, authenticationArgs) {
  const stdout = await execOutput(binaryPath, [
    "--dump-single-json", "--skip-download", "--no-warnings", "--no-playlist",
    "-f", RELAY_FORMAT,
    ...authenticationArgs,
    url
  ], 120000);
  const data = JSON.parse(stdout);
  const selected = Array.isArray(data.requested_formats) && data.requested_formats.length > 0
    ? data.requested_formats
    : [data];
  const inputs = selected
    .filter((format) => format && /^https?:\/\//i.test(format.url || ""))
    .map((format) => ({
      url: format.url,
      vcodec: format.vcodec || "none",
      acodec: format.acodec || "none",
      httpHeaders: format.http_headers || data.http_headers || {}
    }));
  if (inputs.length === 0) {
    throw new Error("YT-DLP did not return a playable live stream URL.");
  }
  const videoIndex = inputs.findIndex((input) => input.vcodec && input.vcodec !== "none");
  const audioIndex = inputs.findIndex((input) => input.acodec && input.acodec !== "none");
  if (videoIndex < 0 && audioIndex < 0) {
    throw new Error("YT-DLP did not identify any playable audio or video streams.");
  }
  return {
    inputs,
    videoIndex: videoIndex < 0 ? null : videoIndex,
    audioIndex: audioIndex < 0 ? null : audioIndex,
    videoCodec: videoIndex < 0 ? null : inputs[videoIndex].vcodec,
    audioCodec: audioIndex < 0 ? null : inputs[audioIndex].acodec
  };
}

function execOutput(binaryPath, args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(binaryPath, args, {
      windowsHide: true,
      maxBuffer: 20 * 1024 * 1024,
      timeout
    }, (err, stdout, stderr) => {
      if (err) {
        err.message = stderr ? `${err.message}: ${stderr}` : err.message;
        reject(err);
        return;
      }
      resolve(stdout);
    });
  });
}

function httpHeaders(values) {
  const blocked = new Set(["accept-encoding", "connection", "content-length", "host"]);
  const lines = Object.entries(values || {})
    .filter(([name, value]) => name && !blocked.has(name.toLowerCase()) && value !== undefined && value !== null)
    .map(([name, value]) => `${name}: ${value}`)
    .join("\r\n");
  return lines ? `${lines}\r\n` : "";
}

function isH264Codec(value) {
  return /^(?:avc1|avc|h264)/i.test(String(value || ""));
}

function safeRelayArgs(args, inputs) {
  const secrets = new Set(inputs.flatMap((input) => [input.url, httpHeaders(input.httpHeaders)]).filter(Boolean));
  return args.map((arg) => secrets.has(arg) ? "[redacted-live-source]" : arg);
}

function rememberStderr(relay, source, chunk) {
  const lines = String(chunk || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  relay.stderr.push(...lines.map((line) => `${source}: ${line}`));
  if (relay.stderr.length > 30) relay.stderr.splice(0, relay.stderr.length - 30);
}

function stderrSummary(relay) {
  return relay.stderr.slice(-8).join(" | ").slice(-2000) || "no process output";
}

function stopProcessAndWait(child) {
  if (!child || child.exitCode !== null || child.killed) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
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

async function fileExists(filePath) {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch (err) {
    return false;
  }
}

function publicRelay(relay) {
  return {
    id: relay.id,
    title: relay.title,
    status: relay.status,
    error: relay.error,
    startedAt: relay.startedAt
  };
}

function validInputUrl(value) {
  const inputUrl = String(value || "").trim();
  if (!/^https?:\/\//i.test(inputUrl)) throw httpError(400, "A valid http(s) URL is required.");
  return inputUrl;
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function quoteArg(value) {
  const text = String(value || "");
  return /\s/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
}

module.exports = { YtDlpRelayService };
