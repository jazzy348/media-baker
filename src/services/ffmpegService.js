const { execFile, spawn } = require("child_process");
const fs = require("fs/promises");
const path = require("path");
const logger = require("../utils/logger");

const VALIDATION_TTL_MS = 60 * 1000;
const VERSION_CHECK_TIMEOUT_MS = 3000;

class FFmpegService {
  constructor(options) {
    this.ffmpegPath = options.ffmpegPath;
    this.ffprobePath = options.ffprobePath;
    this.enableGpu = options.enableGpu;
    this.cachedHardwareEncoder = null;
    this.cachedHardwareProfile = null;
    this.cachedHevcHardwareEncoder = null;
    this.cachedHevcHardwareProfile = null;
    this.cachedVaapiDevice = null;
    this.cachedValidation = null;
    this.cachedValidationAt = 0;
    this.validationPromise = null;
  }

  reloadConfig(options) {
    this.ffmpegPath = options.ffmpegPath;
    this.ffprobePath = options.ffprobePath;
    this.enableGpu = options.enableGpu;
    this.cachedHardwareEncoder = null;
    this.cachedHardwareProfile = null;
    this.cachedHevcHardwareEncoder = null;
    this.cachedHevcHardwareProfile = null;
    this.cachedVaapiDevice = null;
    this.cachedValidation = null;
    this.cachedValidationAt = 0;
    this.validationPromise = null;
    logger.info(`[ffmpeg] config reloaded ffmpeg=${this.ffmpegPath} ffprobe=${this.ffprobePath} enableGpu=${this.enableGpu}`);
  }

  async validate() {
    const now = Date.now();
    if (this.cachedValidation && now - this.cachedValidationAt < VALIDATION_TTL_MS) {
      return this.cachedValidation;
    }
    if (this.validationPromise) {
      return this.validationPromise;
    }

    this.validationPromise = this.runValidation()
      .then((result) => {
        this.cachedValidation = result;
        this.cachedValidationAt = Date.now();
        return result;
      })
      .finally(() => {
        this.validationPromise = null;
      });

    return this.validationPromise;
  }

  async runValidation() {
    logger.info(`[ffmpeg] validate ffmpeg=${this.ffmpegPath} ffprobe=${this.ffprobePath} enableGpu=${this.enableGpu}`);
    const [ffmpeg, ffprobe] = await Promise.all([
      this.getVersion(this.ffmpegPath),
      this.getVersion(this.ffprobePath)
    ]);

    const hardwareProfile = ffmpeg.ok ? await this.detectHardwareProfile() : hardwareProfileForEncoder(null);
    return {
      ffmpeg,
      ffprobe,
      hardwareEncoder: hardwareProfile.encoder,
      hardwareProfile
    };
  }

  async probe(filePath, options = {}) {
    logger.full(`[ffprobe] probing file="${filePath}"`);
    const analyzeduration = Object.prototype.hasOwnProperty.call(options, "analyzeduration")
      ? options.analyzeduration
      : options.useDefaultProbeLimits ? null : "100M";
    const probesize = Object.prototype.hasOwnProperty.call(options, "probesize")
      ? options.probesize
      : options.useDefaultProbeLimits ? null : "100M";
    const args = [
      "-v",
      "error",
      ...(analyzeduration == null ? [] : ["-analyzeduration", String(analyzeduration)]),
      ...(probesize == null ? [] : ["-probesize", String(probesize)]),
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      ...(options.showChapters ? ["-show_chapters"] : []),
      filePath
    ];

    const stdout = await this.exec(this.ffprobePath, args, { timeoutMs: options.timeoutMs });
    const result = JSON.parse(stdout);
    logger.full(`[ffprobe] found ${result.streams ? result.streams.length : 0} streams for file="${filePath}"`);
    return result;
  }

  async probeVideoKeyframes(filePath, streamIndex, options = {}) {
    const inactivityTimeoutMs = Math.max(5000, Number(options.inactivityTimeoutMs) || 30000);
    const args = [
      "-v", "error",
      "-select_streams", String(streamIndex),
      "-show_packets",
      "-show_entries", "packet=pts_time,dts_time,flags",
      "-of", "csv=p=0",
      filePath
    ];
    logger.full(`[ffprobe] indexing video keyframes file="${filePath}" stream=${streamIndex}`);

    return new Promise((resolve, reject) => {
      const child = spawn(this.ffprobePath, args, {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });
      const keyframes = [];
      const errors = [];
      let buffered = "";
      let inactive = false;
      let settled = false;
      let inactivityTimer = null;
      const resetInactivityTimer = () => {
        clearTimeout(inactivityTimer);
        inactivityTimer = setTimeout(() => {
          inactive = true;
          child.kill();
        }, inactivityTimeoutMs);
        inactivityTimer.unref?.();
      };
      const consumeLines = (text, flush = false) => {
        buffered += text;
        const lines = buffered.split(/\r?\n/);
        buffered = flush ? "" : lines.pop() || "";
        if (flush && buffered) lines.push(buffered);
        lines.forEach((line) => addKeyframeCsvLine(keyframes, line));
      };

      resetInactivityTimer();
      child.stdout.on("data", (chunk) => {
        resetInactivityTimer();
        consumeLines(chunk.toString());
      });
      child.stderr.on("data", (chunk) => {
        resetInactivityTimer();
        errors.push(chunk.toString());
        if (errors.length > 8) errors.shift();
      });
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(inactivityTimer);
        reject(error);
      });
      child.once("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(inactivityTimer);
        consumeLines("\n", true);
        if (inactive) {
          reject(new Error(`FFprobe produced no output for ${Math.round(inactivityTimeoutMs / 1000)} seconds while indexing video keyframes`));
          return;
        }
        if (code !== 0) {
          reject(new Error(`FFprobe keyframe scan exited with code ${code}: ${errors.join("").trim()}`));
          return;
        }
        logger.full(`[ffprobe] indexed video keyframes file="${filePath}" stream=${streamIndex} keyframes=${keyframes.length}`);
        resolve(keyframes);
      });
    });
  }

  async probePacketTimeline(filePath, streamSpecifier, expectedDurationSeconds, options = {}) {
    const expectedDuration = Math.max(1, Number(expectedDurationSeconds) || 1);
    const edgeWindowSeconds = Math.min(120, Math.max(30, expectedDuration / 4));
    const inactivityTimeoutMs = options.inactivityTimeoutMs || 2 * 60 * 1000;
    if (expectedDuration <= edgeWindowSeconds * 2) {
      const timeline = await this.probePacketWindow(
        filePath,
        streamSpecifier,
        0,
        expectedDuration + 5,
        inactivityTimeoutMs,
        { onProgress: options.onProgress }
      );
      if (!timeline) {
        throw new Error(`No packet timestamps were returned for stream ${streamSpecifier}`);
      }
      options.onProgress?.({ percent: 100, packetCount: timeline.packetCount });
      return timeline;
    }

    const beginningTimeline = await this.probePacketWindow(
      filePath,
      streamSpecifier,
      0,
      edgeWindowSeconds,
      inactivityTimeoutMs,
      { onProgress: rangedProgress(options.onProgress, 0, 50) }
    );
    const endingTimeline = await this.probeEndingPacketWindow(
      filePath,
      streamSpecifier,
      expectedDuration,
      edgeWindowSeconds,
      inactivityTimeoutMs,
      { onProgress: rangedProgress(options.onProgress, 50, 100) }
    );
    const timeline = combinePacketTimelines(beginningTimeline, endingTimeline);
    if (!timeline) {
      throw new Error(`No packet timestamps were returned for stream ${streamSpecifier}`);
    }
    options.onProgress?.({ percent: 100, packetCount: timeline.packetCount });
    return timeline;
  }

  async probePacketContentTimeline(filePath, streamSpecifier, options = {}) {
    const inactivityTimeoutMs = options.inactivityTimeoutMs || 10 * 60 * 1000;
    const timeline = await this.probePacketWindow(
      filePath,
      streamSpecifier,
      0,
      0,
      inactivityTimeoutMs,
      {
        fullFile: true,
        expectedDurationSeconds: options.expectedDurationSeconds,
        onProgress: options.onProgress
      }
    );
    if (!timeline || timeline.packetDurationSeconds <= 0) {
      throw new Error(`Could not determine packet content duration for stream ${streamSpecifier}`);
    }
    options.onProgress?.({ percent: 100, packetCount: timeline.packetCount });
    return timeline;
  }

  async probeEndingPacketWindow(
    filePath,
    streamSpecifier,
    expectedDuration,
    edgeWindowSeconds,
    inactivityTimeoutMs,
    options = {}
  ) {
    const searchStepSeconds = Math.max(
      edgeWindowSeconds * 2,
      Math.min(15 * 60, expectedDuration / 8)
    );
    const maximumAttempts = Math.min(16, Math.ceil(expectedDuration / searchStepSeconds) + 1);
    let windowStartSeconds = Math.max(0, expectedDuration - edgeWindowSeconds);
    const reportProgress = monotonicProgress(options.onProgress);

    for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
      const windowDurationSeconds = attempt === 0
        ? edgeWindowSeconds * 2
        : searchStepSeconds + edgeWindowSeconds;
      const timeline = await this.probePacketWindow(
        filePath,
        streamSpecifier,
        windowStartSeconds,
        windowDurationSeconds,
        inactivityTimeoutMs,
        {
          onProgress: reportProgress,
          expectedDurationSeconds: expectedDuration
        }
      );
      if (timeline) {
        return timeline;
      }
      if (windowStartSeconds === 0) {
        break;
      }
      windowStartSeconds = Math.max(0, windowStartSeconds - searchStepSeconds);
    }

    throw new Error(`Could not find the end packets for stream ${streamSpecifier}`);
  }

  async probePacketWindow(
    filePath,
    streamSpecifier,
    startSeconds,
    durationSeconds,
    inactivityTimeoutMs,
    options = {}
  ) {
    const args = [
      "-v", "error",
      ...(options.fullFile
        ? []
        : ["-read_intervals", `${Math.max(0, startSeconds)}%+${Math.ceil(durationSeconds)}`]),
      "-select_streams", String(streamSpecifier),
      "-show_packets",
      "-show_entries", "packet=pts_time,dts_time,duration_time",
      "-of", "compact=p=0:nk=0",
      filePath
    ];
    return new Promise((resolve, reject) => {
      const child = spawn(this.ffprobePath, args, {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });
      const accumulator = createPacketTimelineAccumulator();
      const errors = [];
      let buffered = "";
      let inactive = false;
      let settled = false;
      let inactivityTimer = null;
      let lastProgressAt = 0;
      const resetInactivityTimer = () => {
        clearTimeout(inactivityTimer);
        inactivityTimer = setTimeout(() => {
          inactive = true;
          child.kill();
        }, inactivityTimeoutMs);
        inactivityTimer.unref?.();
      };
      const reportProgress = (force = false) => {
        if (!options.onProgress || accumulator.packetCount === 0) {
          return;
        }
        const now = Date.now();
        if (!force && now - lastProgressAt < 250) {
          return;
        }
        lastProgressAt = now;
        options.onProgress(packetWindowProgress(
          accumulator,
          startSeconds,
          durationSeconds,
          options.expectedDurationSeconds,
          options.fullFile
        ));
      };
      resetInactivityTimer();

      child.stdout.on("data", (chunk) => {
        resetInactivityTimer();
        buffered += chunk.toString();
        const lines = buffered.split(/\r?\n/);
        buffered = lines.pop() || "";
        lines.forEach((line) => addCompactPacketLine(accumulator, line));
        reportProgress();
      });
      child.stderr.on("data", (chunk) => {
        resetInactivityTimer();
        errors.push(chunk.toString());
        if (errors.length > 8) {
          errors.shift();
        }
      });
      child.once("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(inactivityTimer);
        reject(err);
      });
      child.once("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(inactivityTimer);
        addCompactPacketLine(accumulator, buffered);
        reportProgress(true);
        if (inactive) {
          reject(new Error(
            `FFprobe produced no output for ${Math.round(inactivityTimeoutMs / 1000)} seconds `
            + `while reading stream ${streamSpecifier} near ${Math.max(0, startSeconds).toFixed(3)} seconds`
          ));
          return;
        }
        if (code !== 0) {
          reject(new Error(
            errors.join("").trim()
            || `FFprobe exited with code ${code} while reading packet timestamps for stream ${streamSpecifier}`
          ));
          return;
        }
        resolve(packetTimelineFromAccumulator(accumulator));
      });
    });
  }

  async probeStream(source, timeoutMs = 3500) {
    logger.info(`[ffprobe] probing live stream source="${redactSource(source)}"`);
    const networkArgs = /^https?:\/\//i.test(source)
      ? ["-rw_timeout", String(Math.max(1000, timeoutMs - 500) * 1000)]
      : [];
    const args = [
      "-v",
      "error",
      "-analyzeduration",
      "1M",
      "-probesize",
      "1M",
      ...networkArgs,
      "-print_format",
      "json",
      "-show_streams",
      source
    ];
    const stdout = await this.exec(this.ffprobePath, args, { timeoutMs });
    return JSON.parse(stdout);
  }

  async generateThumbnail(filePath, outputPath, options = {}) {
    const seekSeconds = await this.thumbnailSeekSeconds(filePath);
    const scaleWidth = Number.parseInt(options.width, 10) || 640;
    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-ss",
      String(seekSeconds),
      "-i",
      filePath,
      "-map",
      "0:v:0",
      "-frames:v",
      "1",
      "-vf",
      `thumbnail,scale='min(${scaleWidth},iw)':'min(1024,ih)':force_original_aspect_ratio=decrease`,
      ...imageEncodingArgs(outputPath, 80),
      outputPath
    ];

    logger.full(`[ffmpeg] thumbnail input="${filePath}" output="${outputPath}" seek=${seekSeconds}`);
    await this.exec(this.ffmpegPath, args);
  }

  async resizeImage(filePath, outputPath, maxDimension) {
    const limit = Math.max(1, Number.parseInt(maxDimension, 10) || 1024);
    const args = [
      "-hide_banner",
      "-loglevel", "error",
      "-y",
      "-i", filePath,
      "-map", "0:v:0",
      "-frames:v", "1",
      "-map_metadata", "0",
      "-vf", `scale='min(${limit},iw)':'min(${limit},ih)':force_original_aspect_ratio=decrease`,
      ...imageEncodingArgs(outputPath, 82),
      outputPath
    ];
    logger.full(`[ffmpeg] image resize input="${filePath}" output="${outputPath}" max=${limit}`);
    await this.exec(this.ffmpegPath, args);
  }

  async resizeImageBuffer(filePath, dimensions) {
    const width = positiveImageDimension(dimensions && dimensions.width);
    const height = positiveImageDimension(dimensions && dimensions.height);
    if (!width && !height) {
      throw new Error("A width or height is required to resize an image");
    }
    const widthExpression = width ? `min(${width},iw)` : "iw";
    const heightExpression = height ? `min(${height},ih)` : "ih";
    const args = [
      "-hide_banner",
      "-loglevel", "error",
      "-i", filePath,
      "-map", "0:v:0",
      "-frames:v", "1",
      "-vf", `scale='${widthExpression}':'${heightExpression}':force_original_aspect_ratio=decrease`,
      "-c:v", "libwebp",
      "-quality", "82",
      "-compression_level", "4",
      "-f", "webp",
      "pipe:1"
    ];
    logger.full(`[ffmpeg] image memory resize input="${filePath}" width=${width || "original"} height=${height || "original"}`);
    const child = this.spawnWithOutput(args);
    return collectProcessBuffer(child, 32 * 1024 * 1024);
  }

  async createImageCollage(inputPaths, outputPath) {
    const sources = inputPaths.slice(0, 4);
    if (sources.length === 0) {
      throw new Error("At least one image is required to create a collage");
    }

    const twoColumns = sources.length > 1;
    const twoRows = sources.length > 2;
    const tileWidth = twoColumns ? 512 : 1024;
    const tileHeight = twoRows ? 512 : 1024;
    const filters = sources.map((_, index) =>
      `[${index}:v]scale=${tileWidth}:${tileHeight}:force_original_aspect_ratio=increase,crop=${tileWidth}:${tileHeight},setsar=1[v${index}]`
    );
    if (sources.length === 1) {
      filters.push("[v0]null[outv]");
    } else {
      const layout = sources.map((_, index) => `${index % 2 * tileWidth}_${Math.floor(index / 2) * tileHeight}`).join("|");
      filters.push(`${sources.map((_, index) => `[v${index}]`).join("")}xstack=inputs=${sources.length}:layout=${layout}:fill=black[outv]`);
    }

    const args = [
      "-hide_banner",
      "-loglevel", "error",
      "-y",
      ...sources.flatMap((filePath) => ["-i", filePath]),
      "-filter_complex", filters.join(";"),
      "-map", "[outv]",
      "-frames:v", "1",
      ...imageEncodingArgs(outputPath, 82),
      outputPath
    ];
    logger.full(`[ffmpeg] image collage inputs=${sources.length} output="${outputPath}"`);
    await this.exec(this.ffmpegPath, args);
  }

  async thumbnailSeekSeconds(filePath) {
    try {
      const probe = await this.probe(filePath);
      const duration = Number(probe.format && probe.format.duration);
      if (Number.isFinite(duration) && duration > 0) {
        return Math.max(3, Math.min(Math.floor(duration * 0.12), 120));
      }
    } catch (err) {
      logger.full(`[ffmpeg] thumbnail duration probe failed input="${filePath}" message="${summarizeProcessError(err.message)}"`);
    }

    return 30;
  }

  async detectHardwareEncoder(codec = "h264") {
    const hevc = codec === "hevc";
    const cachedEncoderKey = hevc ? "cachedHevcHardwareEncoder" : "cachedHardwareEncoder";
    if (!this.enableGpu) {
      logger.info("[ffmpeg] GPU disabled by config; using CPU encoder when transcoding is required");
      this[cachedEncoderKey] = "";
      return null;
    }

    if (this[cachedEncoderKey] !== null) {
      logger.info(`[ffmpeg] cached ${codec} hardware encoder=${this[cachedEncoderKey] || "none"}`);
      return this[cachedEncoderKey] || null;
    }

    try {
      const output = await this.exec(this.ffmpegPath, ["-hide_banner", "-encoders"]);
      const preferred = hevc
        ? ["hevc_nvenc", "hevc_qsv", "hevc_vaapi", "hevc_amf", "hevc_videotoolbox"]
        : ["h264_nvenc", "h264_qsv", "h264_vaapi", "h264_amf", "h264_videotoolbox"];
      const listed = preferred.filter((encoder) => output.includes(encoder));
      logger.full(`[ffmpeg] listed ${codec} hardware encoders=${listed.length ? listed.join(",") : "none"}`);
      this[cachedEncoderKey] = await this.firstUsableEncoder(listed) || "";
      logger.info(`[ffmpeg] selected ${codec} hardware encoder=${this[cachedEncoderKey] || "none"} vendor=${hardwareVendor(this[cachedEncoderKey]) || "none"}`);
      return this[cachedEncoderKey] || null;
    } catch (err) {
      logger.info(`[ffmpeg] failed to inspect hardware encoders: ${err.message}`);
      this[cachedEncoderKey] = "";
      return null;
    }
  }

  async detectHardwareProfile(codec = "h264") {
    const hevc = codec === "hevc";
    const cachedProfileKey = hevc ? "cachedHevcHardwareProfile" : "cachedHardwareProfile";
    if (this[cachedProfileKey]) {
      return this[cachedProfileKey];
    }

    const encoder = await this.detectHardwareEncoder(codec);
    this[cachedProfileKey] = hardwareProfileForEncoder(encoder, {
      vaapiDevice: this.cachedVaapiDevice || null
    });
    const profile = this[cachedProfileKey];
    logger.info(`[ffmpeg] ${codec} hardware profile vendor=${profile.vendor || "none"} encoder=${profile.encoder || "none"} decoder=${profile.decoder || "software"} hwaccelArgs=${profile.hwaccelArgs.length ? profile.hwaccelArgs.join(" ") : "none"}`);
    return profile;
  }

  async firstUsableEncoder(encoders) {
    for (const encoder of encoders) {
      if (await this.canEncodeWith(encoder)) {
        return encoder;
      }
    }

    return null;
  }

  async canEncodeWith(encoder) {
    if (encoder.endsWith("_vaapi")) {
      return Boolean(await this.findUsableVaapiDevice(encoder));
    }

    try {
      logger.full(`[ffmpeg] testing hardware encoder=${encoder}`);
      await this.exec(this.ffmpegPath, hardwareEncoderTestArgs(encoder));
      logger.full(`[ffmpeg] hardware encoder usable=${encoder}`);
      return true;
    } catch (err) {
      logger.full(`[ffmpeg] hardware encoder failed=${encoder} error="${summarizeProcessError(err.message)}"`);
      return false;
    }
  }

  async findUsableVaapiDevice(encoder = "h264_vaapi") {
    const discovered = await this.listVaapiDevices();
    const devices = this.cachedVaapiDevice
      ? [this.cachedVaapiDevice, ...discovered.filter((device) => device !== this.cachedVaapiDevice)]
      : discovered;
    if (devices.length === 0) {
      logger.full("[ffmpeg] no VAAPI render devices found under /dev/dri");
      this.cachedVaapiDevice = "";
      return null;
    }

    for (const device of devices) {
      try {
        logger.full(`[ffmpeg] testing VAAPI device=${device}`);
        await this.exec(this.ffmpegPath, hardwareEncoderTestArgs(encoder, device));
        logger.info(`[ffmpeg] selected VAAPI device=${device}`);
        this.cachedVaapiDevice = device;
        return device;
      } catch (err) {
        logger.full(`[ffmpeg] VAAPI device failed=${device} error="${summarizeProcessError(err.message)}"`);
      }
    }

    if (encoder === "h264_vaapi") {
      this.cachedVaapiDevice = "";
    }
    return null;
  }

  async listVaapiDevices() {
    try {
      const entries = await fs.readdir("/dev/dri");
      return entries
        .filter((entry) => /^renderD\d+$/.test(entry))
        .sort((a, b) => Number(a.replace(/\D/g, "")) - Number(b.replace(/\D/g, "")))
        .map((entry) => `/dev/dri/${entry}`);
    } catch (err) {
      return [];
    }
  }

  spawn(args) {
    return spawn(this.ffmpegPath, args, {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"]
    });
  }

  spawnWithOutput(args) {
    return spawn(this.ffmpegPath, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
  }

  getVersion(binaryPath) {
    return this.exec(binaryPath, ["-version"], { timeoutMs: VERSION_CHECK_TIMEOUT_MS })
      .then((stdout) => ({
        ok: true,
        path: binaryPath,
        version: stdout.split(/\r?\n/)[0]
      }))
      .catch((err) => ({
        ok: false,
        path: binaryPath,
        error: err.message
      }));
  }

  exec(binaryPath, args, options = {}) {
    return new Promise((resolve, reject) => {
      execFile(binaryPath, args, {
        windowsHide: true,
        maxBuffer: 20 * 1024 * 1024,
        timeout: options.timeoutMs || 0
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
}

function createPacketTimelineAccumulator() {
  return {
    startSeconds: Number.POSITIVE_INFINITY,
    endSeconds: Number.NEGATIVE_INFINITY,
    maximumPacketDurationSeconds: 0,
    packetDurationSeconds: 0,
    packetCount: 0
  };
}

function addKeyframeCsvLine(keyframes, line) {
  const fields = String(line || "").trim().split(",");
  if (fields.length < 2 || !fields.some((field) => field.includes("K"))) {
    return;
  }
  const timestamp = finiteNumber(fields[0], fields[1]);
  if (!Number.isFinite(timestamp)) {
    return;
  }
  const previous = keyframes[keyframes.length - 1];
  if (!Number.isFinite(previous) || Math.abs(timestamp - previous) > 0.000001) {
    keyframes.push(timestamp);
  }
}

function addCompactPacketLine(accumulator, line) {
  const values = {};
  for (const field of String(line || "").trim().split("|")) {
    const separator = field.indexOf("=");
    if (separator > 0) {
      values[field.slice(0, separator)] = field.slice(separator + 1);
    }
  }
  const timestamp = finiteNumber(values.pts_time, values.dts_time);
  if (!Number.isFinite(timestamp)) {
    return;
  }
  const packetDuration = Math.max(0, finiteNumber(values.duration_time, 0));
  accumulator.startSeconds = Math.min(accumulator.startSeconds, timestamp);
  accumulator.endSeconds = Math.max(accumulator.endSeconds, timestamp + packetDuration);
  accumulator.maximumPacketDurationSeconds = Math.max(
    accumulator.maximumPacketDurationSeconds,
    packetDuration
  );
  accumulator.packetDurationSeconds += packetDuration;
  accumulator.packetCount += 1;
}

function packetTimelineFromAccumulator(accumulator) {
  if (!Number.isFinite(accumulator.startSeconds)
    || !Number.isFinite(accumulator.endSeconds)
    || accumulator.endSeconds <= accumulator.startSeconds) {
    return null;
  }
  return {
    startSeconds: accumulator.startSeconds,
    endSeconds: accumulator.endSeconds,
    durationSeconds: accumulator.endSeconds - accumulator.startSeconds,
    maximumPacketDurationSeconds: accumulator.maximumPacketDurationSeconds,
    packetDurationSeconds: accumulator.packetDurationSeconds,
    packetCount: accumulator.packetCount
  };
}

function combinePacketTimelines(first, second) {
  if (!first) return second || null;
  if (!second) return first;
  const startSeconds = Math.min(first.startSeconds, second.startSeconds);
  const endSeconds = Math.max(first.endSeconds, second.endSeconds);
  return {
    startSeconds,
    endSeconds,
    durationSeconds: endSeconds - startSeconds,
    maximumPacketDurationSeconds: Math.max(
      first.maximumPacketDurationSeconds,
      second.maximumPacketDurationSeconds
    ),
    packetDurationSeconds: first.packetDurationSeconds + second.packetDurationSeconds,
    packetCount: first.packetCount + second.packetCount
  };
}

function packetWindowProgress(
  accumulator,
  startSeconds,
  durationSeconds,
  expectedDurationSeconds,
  fullFile
) {
  const processedSeconds = Math.max(
    0,
    accumulator.endSeconds - accumulator.startSeconds
  );
  const expectedSeconds = fullFile
    ? Math.max(0, Number(expectedDurationSeconds) || 0)
    : Math.max(0, Number(durationSeconds) || 0);
  const percent = expectedSeconds > 0
    ? Math.max(0, Math.min(100, processedSeconds / expectedSeconds * 100))
    : 0;
  return {
    percent: Math.round(percent * 10) / 10,
    processedSeconds,
    expectedSeconds,
    packetCount: accumulator.packetCount,
    startSeconds: Math.max(0, Number(startSeconds) || 0)
  };
}

function rangedProgress(onProgress, rangeStart, rangeEnd) {
  if (typeof onProgress !== "function") {
    return null;
  }
  const report = monotonicProgress(onProgress);
  const start = Number(rangeStart) || 0;
  const width = Math.max(0, (Number(rangeEnd) || 0) - start);
  return (progress) => report({
    ...progress,
    percent: start + Math.max(0, Math.min(Number(progress && progress.percent) || 0, 100)) / 100 * width
  });
}

function monotonicProgress(onProgress) {
  if (typeof onProgress !== "function") {
    return null;
  }
  let lastPercent = 0;
  return (progress) => {
    const percent = Math.max(lastPercent, Math.max(0, Math.min(Number(progress && progress.percent) || 0, 100)));
    lastPercent = percent;
    onProgress({ ...progress, percent });
  };
}

function finiteNumber(...values) {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return Number.NaN;
}

function hardwareEncoderTestArgs(encoder, vaapiDevice = "/dev/dri/renderD128") {
  const hevc = encoder.startsWith("hevc_");
  if (encoder.endsWith("_vaapi")) {
    return [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "nullsrc=s=640x360:d=0.1",
      "-vaapi_device",
      vaapiDevice,
      "-vf",
      `format=${hevc ? "p010le" : "nv12"},hwupload`,
      "-frames:v",
      "1",
      "-c:v",
      encoder,
      ...(hevc ? ["-profile:v", "main10"] : []),
      "-f",
      "null",
      "-"
    ];
  }

  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "nullsrc=s=640x360:d=0.1",
    "-frames:v",
    "1",
    "-c:v",
    encoder,
    ...(hevc ? ["-pix_fmt", "p010le", "-profile:v", "main10"] : []),
    "-f",
    "null",
    "-"
  ];
}

function hardwareProfileForEncoder(encoder, options = {}) {
  const hevc = String(encoder || "").startsWith("hevc_");
  if (encoder === "h264_nvenc" || encoder === "hevc_nvenc") {
    return {
      vendor: "nvidia",
      encoder,
      decoder: "nvdec",
      inputArgs: [],
      hwaccelArgs: ["-hwaccel", "nvdec", "-hwaccel_output_format", "cuda"],
      uploadFilter: null,
      hardwareFrames: "cuda"
    };
  }

  if (encoder === "h264_qsv" || encoder === "hevc_qsv") {
    return {
      vendor: "intel",
      encoder,
      decoder: null,
      inputArgs: [],
      hwaccelArgs: [],
      uploadFilter: null,
      hardwareFrames: null
    };
  }

  if (encoder === "h264_vaapi" || encoder === "hevc_vaapi") {
    const vaapiDevice = options.vaapiDevice || "/dev/dri/renderD128";
    return {
      vendor: "vaapi",
      encoder,
      decoder: null,
      inputArgs: ["-vaapi_device", vaapiDevice],
      hwaccelArgs: [],
      uploadFilter: `format=${hevc ? "p010le" : "nv12"},hwupload`,
      hardwareFrames: null
    };
  }

  if (encoder === "h264_amf" || encoder === "hevc_amf") {
    return {
      vendor: "amd",
      encoder,
      decoder: null,
      inputArgs: [],
      hwaccelArgs: [],
      uploadFilter: null,
      hardwareFrames: null
    };
  }

  if (encoder === "h264_videotoolbox" || encoder === "hevc_videotoolbox") {
    return {
      vendor: "apple",
      encoder,
      decoder: null,
      inputArgs: [],
      hwaccelArgs: [],
      uploadFilter: null,
      hardwareFrames: null
    };
  }

  return {
    vendor: null,
    encoder: null,
    decoder: null,
    inputArgs: [],
    hwaccelArgs: [],
    uploadFilter: null,
    hardwareFrames: null
  };
}

function hardwareVendor(encoder) {
  return hardwareProfileForEncoder(encoder).vendor;
}

function summarizeProcessError(message) {
  return String(message || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(" | ");
}

function redactSource(source) {
  try {
    const url = new URL(source);
    url.username = "";
    url.password = "";
    url.search = "";
    return url.toString();
  } catch (err) {
    return String(source || "");
  }
}

function imageEncodingArgs(outputPath, quality) {
  if (path.extname(outputPath).toLowerCase() === ".webp") {
    return ["-c:v", "libwebp", "-quality", String(quality), "-compression_level", "4"];
  }
  return ["-q:v", "3"];
}

function positiveImageDimension(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function collectProcessBuffer(child, maximumBytes) {
  return new Promise((resolve, reject) => {
    const output = [];
    const errors = [];
    let outputBytes = 0;
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };
    child.stdout.on("data", (chunk) => {
      if (settled) return;
      outputBytes += chunk.length;
      if (outputBytes > maximumBytes) {
        child.kill();
        finish(reject, new Error("Resized image exceeded the in-memory output limit"));
        return;
      }
      output.push(chunk);
    });
    child.stderr.on("data", (chunk) => errors.push(chunk));
    child.on("error", (err) => finish(reject, err));
    child.on("close", (code) => {
      if (code !== 0) {
        const detail = Buffer.concat(errors).toString("utf8").trim();
        finish(reject, new Error(detail || `FFmpeg image resize exited with code ${code}`));
        return;
      }
      const image = Buffer.concat(output);
      if (image.length === 0) {
        finish(reject, new Error("FFmpeg produced no resized image data"));
        return;
      }
      finish(resolve, image);
    });
  });
}

module.exports = { FFmpegService };
