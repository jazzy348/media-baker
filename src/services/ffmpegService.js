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
    const analyzeduration = options.analyzeduration || "100M";
    const probesize = options.probesize || "100M";
    const args = [
      "-v",
      "error",
      "-analyzeduration",
      String(analyzeduration),
      "-probesize",
      String(probesize),
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      filePath
    ];

    const stdout = await this.exec(this.ffprobePath, args);
    const result = JSON.parse(stdout);
    logger.full(`[ffprobe] found ${result.streams ? result.streams.length : 0} streams for file="${filePath}"`);
    return result;
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

  async detectHardwareEncoder() {
    if (!this.enableGpu) {
      logger.info("[ffmpeg] GPU disabled by config; using CPU encoder when transcoding is required");
      this.cachedHardwareEncoder = "";
      return null;
    }

    if (this.cachedHardwareEncoder !== null) {
      logger.info(`[ffmpeg] cached hardware encoder=${this.cachedHardwareEncoder || "none"}`);
      return this.cachedHardwareEncoder || null;
    }

    try {
      const output = await this.exec(this.ffmpegPath, ["-hide_banner", "-encoders"]);
      const preferred = ["h264_nvenc", "h264_qsv", "h264_vaapi", "h264_amf", "h264_videotoolbox"];
      const listed = preferred.filter((encoder) => output.includes(encoder));
      logger.full(`[ffmpeg] listed hardware encoders=${listed.length ? listed.join(",") : "none"}`);
      this.cachedHardwareEncoder = await this.firstUsableEncoder(listed) || "";
      logger.info(`[ffmpeg] selected hardware encoder=${this.cachedHardwareEncoder || "none"} vendor=${hardwareVendor(this.cachedHardwareEncoder) || "none"}`);
      return this.cachedHardwareEncoder || null;
    } catch (err) {
      logger.info(`[ffmpeg] failed to inspect hardware encoders: ${err.message}`);
      this.cachedHardwareEncoder = "";
      return null;
    }
  }

  async detectHardwareProfile() {
    if (this.cachedHardwareProfile) {
      return this.cachedHardwareProfile;
    }

    const encoder = await this.detectHardwareEncoder();
    this.cachedHardwareProfile = hardwareProfileForEncoder(encoder, {
      vaapiDevice: this.cachedVaapiDevice || null
    });
    logger.info(`[ffmpeg] hardware profile vendor=${this.cachedHardwareProfile.vendor || "none"} encoder=${this.cachedHardwareProfile.encoder || "none"} decoder=${this.cachedHardwareProfile.decoder || "software"} hwaccelArgs=${this.cachedHardwareProfile.hwaccelArgs.length ? this.cachedHardwareProfile.hwaccelArgs.join(" ") : "none"}`);
    return this.cachedHardwareProfile;
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
    if (encoder === "h264_vaapi") {
      return Boolean(await this.findUsableVaapiDevice());
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

  async findUsableVaapiDevice() {
    if (this.cachedVaapiDevice !== null) {
      return this.cachedVaapiDevice || null;
    }

    const devices = await this.listVaapiDevices();
    if (devices.length === 0) {
      logger.full("[ffmpeg] no VAAPI render devices found under /dev/dri");
      this.cachedVaapiDevice = "";
      return null;
    }

    for (const device of devices) {
      try {
        logger.full(`[ffmpeg] testing VAAPI device=${device}`);
        await this.exec(this.ffmpegPath, hardwareEncoderTestArgs("h264_vaapi", device));
        logger.info(`[ffmpeg] selected VAAPI device=${device}`);
        this.cachedVaapiDevice = device;
        return device;
      } catch (err) {
        logger.full(`[ffmpeg] VAAPI device failed=${device} error="${summarizeProcessError(err.message)}"`);
      }
    }

    this.cachedVaapiDevice = "";
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

function hardwareEncoderTestArgs(encoder, vaapiDevice = "/dev/dri/renderD128") {
  if (encoder === "h264_vaapi") {
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
      "format=nv12,hwupload",
      "-frames:v",
      "1",
      "-c:v",
      encoder,
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
    "-f",
    "null",
    "-"
  ];
}

function hardwareProfileForEncoder(encoder, options = {}) {
  if (encoder === "h264_nvenc") {
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

  if (encoder === "h264_qsv") {
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

  if (encoder === "h264_vaapi") {
    const vaapiDevice = options.vaapiDevice || "/dev/dri/renderD128";
    return {
      vendor: "vaapi",
      encoder,
      decoder: null,
      inputArgs: ["-vaapi_device", vaapiDevice],
      hwaccelArgs: [],
      uploadFilter: "format=nv12,hwupload",
      hardwareFrames: null
    };
  }

  if (encoder === "h264_amf") {
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

  if (encoder === "h264_videotoolbox") {
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

module.exports = { FFmpegService };
