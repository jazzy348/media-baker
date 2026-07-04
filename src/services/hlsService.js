const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const { SUBTITLE_EXTENSIONS, isAudioFile, normalizeAudioPreference } = require("../utils/mediaParsers");
const { normalizeQualityPreference, qualityProfileForProbe } = require("./qualityProfiles");
const logger = require("../utils/logger");

class HlsService {
  constructor(config, ffmpeg, progress = null) {
    this.config = config;
    this.ffmpeg = ffmpeg;
    this.progress = progress;
    this.activeSetups = new Map();
  }

  async prepare(mediaFile, options = {}) {
    const normalizedOptions = {
      audio: normalizeAudioPreference(options.audio, this.config.streaming.preferredAudioLanguage),
      subtitle: normalizeSubtitlePreference(options.subtitle),
      audioChannels: normalizeAudioChannelPreference(options.audioChannels || options.audioMode || options.channelMode),
      quality: normalizeQualityPreference(options.quality)
    };
    logger.info(`[hls] prepare file="${mediaFile.filePath}" requestedAudio=${options.audio || "default"} selectedAudio=${normalizedOptions.audio} subtitle=${normalizedOptions.subtitle} audioChannels=${normalizedOptions.audioChannels} quality=${normalizedOptions.quality}`);
    const cacheKey = await this.buildCacheKey(mediaFile.filePath, normalizedOptions);
    const cacheDir = path.join(this.config.hls.cachePath, cacheKey);
    const playlistPath = path.join(cacheDir, "master.m3u8");
    const manifestPath = path.join(cacheDir, "stream.json");

    if (this.activeSetups.has(cacheKey)) {
      logger.info(`[hls] joining active ffmpeg setup cacheKey=${cacheKey}`);
      await this.activeSetups.get(cacheKey);
      return this.result(cacheKey, cacheDir, playlistPath);
    }

    if (await this.isUsableCache(manifestPath)) {
      logger.info(`[hls] cache hit cacheKey=${cacheKey} playlist="${playlistPath}"`);
      return this.result(cacheKey, cacheDir, playlistPath);
    }

    logger.info(`[hls] cache miss cacheKey=${cacheKey}; starting ffmpeg setup`);
    const setup = this.startHls(mediaFile, normalizedOptions, cacheDir, playlistPath)
      .finally(() => this.activeSetups.delete(cacheKey));
    this.activeSetups.set(cacheKey, setup);

    await this.activeSetups.get(cacheKey);
    return this.result(cacheKey, cacheDir, playlistPath);
  }

  getCachedFilePath(cacheKey, filename) {
    if (!/^[a-f0-9]{24}$/.test(cacheKey) || filename.includes("/") || filename.includes("\\") || filename.includes("..")) {
      return null;
    }

    return path.join(this.config.hls.cachePath, cacheKey, filename);
  }

  async getPlaylist(cacheKey) {
    const manifest = await this.readManifest(cacheKey);
    const publishedPlaylist = await readPublishedPlaylist(cacheKey, this.config.hls.cachePath);
    if (publishedPlaylist && isCompletePlaylist(publishedPlaylist)) {
      return publishedPlaylist;
    }

    return buildVodPlaylist(manifest);
  }

  async waitForCachedFile(cacheKey, filename) {
    const filePath = this.getCachedFilePath(cacheKey, filename);
    if (!filePath) {
      return null;
    }

    const manifestPath = path.join(this.config.hls.cachePath, cacheKey, "stream.json");
    const timeoutMs = this.config.hls.segmentWaitTimeoutSeconds * 1000;
    const startedAt = Date.now();
    const segmentIndex = segmentFilenameIndex(filename);
    const manifest = segmentIndex === null ? null : await this.readManifestIfPresent(cacheKey);
    if (segmentIndex !== null && !manifest) {
      return {
        status: "missing",
        reason: "manifest-removed"
      };
    }
    if (manifest && segmentIndex >= manifest.segmentCount) {
      return {
        status: "missing",
        reason: "outside-manifest"
      };
    }

    while (Date.now() - startedAt < timeoutMs) {
      if (await isPublishedSegment(cacheKey, filename, this.config.hls.cachePath)) {
        return {
          status: "ready",
          filePath
        };
      }

      if (!await fileExists(manifestPath)) {
        return {
          status: "missing",
          reason: "manifest-removed"
        };
      }

      const publishedPlaylist = await readPublishedPlaylist(cacheKey, this.config.hls.cachePath);
      if (publishedPlaylist && isCompletePlaylist(publishedPlaylist)) {
        return {
          status: "missing",
          reason: "completed-playlist-missing-segment"
        };
      }

      await delay(300);
    }

    return {
      status: "pending",
      reason: "not-ready"
    };
  }

  async cleanupExpired() {
    await fs.mkdir(this.config.hls.cachePath, { recursive: true });
    const entries = await fs.readdir(this.config.hls.cachePath, { withFileTypes: true });
    const now = Date.now();
    const ttlMs = this.config.hls.ttlSeconds * 1000;

    await Promise.all(entries.map(async (entry) => {
      if (!entry.isDirectory()) {
        return;
      }

      const dirPath = path.join(this.config.hls.cachePath, entry.name);
      if (this.progress && await this.progress.isCacheProtected(entry.name)) {
        return;
      }

      const stat = await fs.stat(dirPath);
      const releaseBaseMs = this.progress ? await this.progress.cacheReleaseBaseMs(entry.name) : 0;
      const ageBaseMs = Math.max(stat.mtimeMs, releaseBaseMs);
      if (now - ageBaseMs > ttlMs) {
        await fs.rm(dirPath, { recursive: true, force: true });
      }
    }));
  }

  async segmentProgress(cacheKey, filename) {
    const segmentIndex = segmentFilenameIndex(filename);
    if (segmentIndex === null) {
      return null;
    }

    const manifest = await this.readManifestIfPresent(cacheKey);
    if (!manifest || segmentIndex >= manifest.segmentCount) {
      return null;
    }

    return {
      index: segmentIndex,
      startSeconds: segmentIndex * Number(manifest.segmentSeconds || this.config.hls.segmentSeconds),
      durationSeconds: segmentDuration(manifest, segmentIndex),
      mediaDurationSeconds: Number(manifest.duration) || 0
    };
  }

  result(cacheKey, cacheDir, playlistPath) {
    return {
      cacheKey,
      cacheDir,
      playlistPath
    };
  }

  async buildCacheKey(filePath, options) {
    const stat = await fs.stat(filePath);
    return crypto
      .createHash("sha1")
      .update(JSON.stringify({
        hlsFormatVersion: "synthetic-vod-h264-compat-v15-audio-progressive",
        filePath,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        segmentSeconds: this.config.hls.segmentSeconds,
        options
      }))
      .digest("hex")
      .slice(0, 24);
  }

  async isUsableCache(playlistPath) {
    try {
      const stat = await fs.stat(playlistPath);
      const ttlMs = this.config.hls.ttlSeconds * 1000;
      return Date.now() - stat.mtimeMs <= ttlMs;
    } catch (err) {
      if (err.code === "ENOENT") {
        return false;
      }

      throw err;
    }
  }

  async startHls(mediaFile, options, cacheDir, playlistPath) {
    const inputPath = mediaFile.filePath;
    logger.info(`[hls] start input="${inputPath}" cacheDir="${cacheDir}" playlist="${playlistPath}" audio=${options.audio} audioChannels=${options.audioChannels} quality=${options.quality}`);
    await this.cleanupExpired();
    await fs.rm(cacheDir, { recursive: true, force: true });
    await fs.mkdir(cacheDir, { recursive: true });

    const probe = await this.ffmpeg.probe(inputPath, isAudioFile(inputPath)
      ? { analyzeduration: "1M", probesize: "1M" }
      : {});
    const hlsBuild = await this.buildFfmpegArgs(inputPath, probe, options, playlistPath);
    const manifest = buildManifest(probe, hlsBuild.segmentSeconds || this.config.hls.segmentSeconds, {
      independentSegments: hlsBuild.independentSegments,
      splitByTime: hlsBuild.splitByTime
    });
    await fs.writeFile(path.join(cacheDir, "stream.json"), JSON.stringify(manifest, null, 2));
    const args = hlsBuild.args;
    logger.full(`[ffmpeg] command ${quoteCommand(this.ffmpeg.ffmpegPath, args)}`);
    const child = this.ffmpeg.spawn(args);
    let stderr = "";

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (stderr.length > 20000) {
        stderr = stderr.slice(-20000);
      }
    });

    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });

    const exitPromise = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => {
        logger.full(`[ffmpeg] exit code=${code} input="${inputPath}"`);
        if (code === 0) {
          resolve();
          return;
        }

        reject(new Error(`ffmpeg exited with code ${code}: ${summarizeFfmpegOutput(stderr)}`));
      });
    });

    logger.info(`[hls] transcode launched input="${inputPath}" playlist="${playlistPath}"`);
    if (hlsBuild.audioOnly) {
      try {
        await waitForInitialHlsSegment(
          path.join(cacheDir, "segment_00000.ts"),
          exitPromise,
          this.config.hls.segmentWaitTimeoutSeconds * 1000
        );
        logger.info(`[hls] audio HLS started input="${inputPath}" playlist="${playlistPath}"`);
      } catch (err) {
        logger.error(`[hls] audio ffmpeg failed before playback input="${inputPath}" error="${summarizeFfmpegOutput(err.message)}"; removing cacheDir="${cacheDir}"`);
        await fs.rm(cacheDir, { recursive: true, force: true });
        throw err;
      }
      exitPromise.catch(async (err) => {
        logger.error(`[hls] audio ffmpeg failed after launch input="${inputPath}" error="${summarizeFfmpegOutput(err.message)}"; removing cacheDir="${cacheDir}"`);
        await fs.rm(cacheDir, { recursive: true, force: true });
      });
      return;
    }

    exitPromise.catch(async (err) => {
      logger.error(`[hls] ffmpeg failed after launch input="${inputPath}" error="${summarizeFfmpegOutput(err.message)}"; removing cacheDir="${cacheDir}"`);
      await fs.rm(cacheDir, { recursive: true, force: true });
    });
  }

  async buildFfmpegArgs(inputPath, probe, options, playlistPath) {
    const videoStream = isAudioFile(inputPath) ? null : selectVideoStream(probe);
    const audioStream = selectAudioStream(probe, options.audio);
    const audioMode = selectAudioMode(audioStream, options.audioChannels);
    if (!videoStream) {
      return this.buildAudioOnlyFfmpegArgs(inputPath, audioStream, audioMode, playlistPath);
    }
    const subtitle = await this.selectSubtitle(inputPath, probe, options, audioStream);
    const qualityProfile = qualityProfileForProbe(probe, options.quality);
    const scaleFilter = transcodeScaleFilter(videoStream, qualityProfile.targetHeight);
    const compatibleH264 = isCompatibleH264Stream(videoStream);
    const forceCompatibleTranscode = this.config.hls.forceTranscodeCompatibleVideo && compatibleH264 && !scaleFilter;
    const needsTranscode = {
      video: !compatibleH264 || Boolean(scaleFilter) || forceCompatibleTranscode || qualityProfile.forceTranscode,
      audio: audioStream.codec_name !== "aac" || audioMode.forceTranscode
    };
    const hardwareProfile = await this.ffmpeg.detectHardwareProfile();
    const hardwareEncoder = hardwareProfile.encoder;
    const videoCodec = needsTranscode.video || subtitle
      ? hardwareEncoder || "libx264"
      : "copy";
    const audioCodec = needsTranscode.audio ? "aac" : "copy";
    const useHardwareFrames = hardwareProfile.hardwareFrames === "cuda" && videoCodec === hardwareProfile.encoder && Boolean(scaleFilter || subtitle);
    const hardwareDownloadFilter = useHardwareFrames ? hardwareFrameDownloadFilter(hardwareProfile.hardwareFrames, videoStream) : null;
    const hardwareUploadFilter = videoCodec === hardwareProfile.encoder ? hardwareProfile.uploadFilter : null;
    logger.full(`[hls] selected video=${streamLog(videoStream)} compatibleH264=${compatibleH264} audio=${streamLog(audioStream)} audioMode=${audioMode.id} subtitle=${subtitleLog(subtitle)} quality=${qualityProfile.id} targetHeight=${qualityProfile.targetHeight || "original"} targetBitrate=${qualityProfile.targetBitrate || "auto"} scale=${scaleFilter || "none"} needsTranscode=${JSON.stringify(needsTranscode)} forceCompatibleTranscode=${Boolean(forceCompatibleTranscode)} hardwareVendor=${hardwareProfile.vendor || "none"} hardwareEncoder=${hardwareEncoder || "none"} hardwareDecoder=${hardwareProfile.decoder || "software"} videoCodec=${videoCodec} audioCodec=${audioCodec} hardwareFrames=${hardwareProfile.hardwareFrames || "none"} hardwareDownloadFilter=${hardwareDownloadFilter || "none"} hardwareUploadFilter=${hardwareUploadFilter || "none"}`);
    const args = [
      "-hide_banner",
      "-y",
      "-analyzeduration",
      "100M",
      "-probesize",
      "100M"
    ];

    if (subtitle && subtitle.needsSubtitleDurationFix) {
      args.push("-fix_sub_duration");
    }

    if (videoCodec === hardwareProfile.encoder && hardwareProfile.inputArgs.length > 0) {
      args.push(...hardwareProfile.inputArgs);
    }

    if (useHardwareFrames && hardwareProfile.hwaccelArgs.length > 0) {
      args.push(...hardwareProfile.hwaccelArgs);
    }

    args.push("-i", inputPath);

    const bitmapSubtitleFilter = subtitle && subtitle.bitmapSubtitleIndex !== undefined
      ? bitmapSubtitleFilterComplex(subtitle.bitmapSubtitleIndex, scaleFilter, hardwareDownloadFilter, hardwareUploadFilter)
      : null;

    if (bitmapSubtitleFilter) {
      args.push(
        "-filter_complex",
        bitmapSubtitleFilter,
        "-map",
        "[v]"
      );
    } else {
      args.push(
        "-map",
        "0:v:0"
      );
    }

    args.push(
      "-map",
      `0:${audioStream.index}`,
      "-sn",
      "-c:v",
      videoCodec,
      "-c:a",
      audioCodec
    );

    const videoFilter = bitmapSubtitleFilter ? null : composeFilters([
      useHardwareFrames && (scaleFilter || subtitle && subtitle.videoFilter) ? hardwareDownloadFilter : null,
      scaleFilter,
      useHardwareFrames && (scaleFilter || subtitle && subtitle.videoFilter) ? "format=yuv420p" : null,
      subtitle && subtitle.videoFilter,
      hardwareUploadFilter
    ]);
    if (videoFilter) {
      args.push("-vf", videoFilter);
    }

    if (subtitle && subtitle.type === "embedded" && !subtitle.burnable) {
      throw new Error(`English subtitle stream ${subtitle.index} uses unsupported codec ${subtitle.codecName}`);
    }

    if (audioCodec === "aac") {
      if (audioMode.filter) {
        args.push("-af", audioMode.filter);
      }
      if (audioMode.channels) {
        args.push("-ac", String(audioMode.channels));
      }
      args.push("-b:a", audioBitrate(audioMode));
    }

    if (videoCodec === "libx264") {
      args.push("-preset", "veryfast");
      if (qualityProfile.targetBitrate) {
        args.push(...videoBitrateArgs(qualityProfile.targetBitrate));
      } else {
        args.push("-crf", "21");
      }
    }

    args.push(...hardwareEncoderArgs(videoCodec, qualityProfile.targetBitrate));

    if (videoCodec !== "copy") {
      const gopSize = outputGopSize(videoStream, this.config.hls.segmentSeconds);
      if (videoCodec !== "h264_vaapi") {
        args.push("-pix_fmt", "yuv420p");
      }
      args.push(
        "-profile:v",
        "high",
        "-g",
        String(gopSize),
        "-keyint_min",
        String(gopSize),
        "-sc_threshold",
        "0",
        "-force_key_frames",
        `expr:gte(t,n_forced*${this.config.hls.segmentSeconds})`
      );
    }

    const hlsFlags = videoCodec === "copy"
      ? ["split_by_time", "temp_file"]
      : ["independent_segments", "temp_file"];

    args.push(
      "-f",
      "hls",
      "-hls_time",
      String(this.config.hls.segmentSeconds),
      "-hls_list_size",
      "0",
      "-hls_flags",
      hlsFlags.join("+"),
      "-hls_segment_filename",
      path.join(path.dirname(playlistPath), "segment_%05d.ts"),
      playlistPath
    );

    return {
      args,
      independentSegments: hlsFlags.includes("independent_segments"),
      splitByTime: hlsFlags.includes("split_by_time")
    };
  }

  buildAudioOnlyFfmpegArgs(inputPath, audioStream, audioMode, playlistPath) {
    const audioCodec = audioStream.codec_name === "aac" && !audioMode.forceTranscode ? "copy" : "aac";
    const segmentSeconds = Math.min(2, this.config.hls.segmentSeconds);
    const args = [
      "-hide_banner", "-y",
      "-analyzeduration", "1M",
      "-probesize", "1M",
      "-i", inputPath,
      "-map", `0:${audioStream.index}`,
      "-vn", "-sn",
      "-c:a", audioCodec
    ];
    if (audioCodec === "aac") {
      if (audioMode.filter) {
        args.push("-af", audioMode.filter);
      }
      if (audioMode.channels) {
        args.push("-ac", String(audioMode.channels));
      }
      const channels = audioMode.channels || Number.parseInt(audioStream.channels, 10) || 2;
      args.push("-b:a", channels > 2 ? "512k" : "320k");
    }
    args.push(
      "-muxdelay", "0",
      "-f", "hls",
      "-hls_time", String(segmentSeconds),
      "-hls_list_size", "0",
      "-hls_flags", "split_by_time+temp_file",
      "-hls_segment_filename", path.join(path.dirname(playlistPath), "segment_%05d.ts"),
      playlistPath
    );
    logger.full(`[hls] selected audio-only audio=${streamLog(audioStream)} audioMode=${audioMode.id} audioCodec=${audioCodec} segmentSeconds=${segmentSeconds}`);
    return { args, independentSegments: false, splitByTime: true, segmentSeconds, audioOnly: true };
  }

  async selectSubtitle(inputPath, probe, options, audioStream) {
    if (options.subtitle === "none") {
      logger.full("[hls] subtitles skipped because subtitle=none");
      return null;
    }

    const explicitExternal = externalSubtitleName(options.subtitle);
    if (explicitExternal) {
      const external = await findExternalSubtitleByName(inputPath, explicitExternal);
      if (!external) {
        throw new Error(`Requested sidecar subtitle was not found: ${explicitExternal}`);
      }

      logger.full(`[hls] selected requested external subtitle="${external}"`);
      return {
        type: "external",
        path: external,
        videoFilter: `subtitles=${escapeSubtitleFilterPath(external)}`
      };
    }

    const explicitCached = cachedSubtitleName(options.subtitle);
    if (explicitCached) {
      const cached = this.cachedSubtitlePath(explicitCached);
      if (!cached || !await fileExists(cached)) {
        throw new Error(`Requested cached subtitle was not found: ${explicitCached}`);
      }

      logger.full(`[hls] selected cached subtitle="${cached}"`);
      return {
        type: "cached",
        path: cached,
        videoFilter: `subtitles=${escapeSubtitleFilterPath(cached)}`
      };
    }

    const subtitles = (probe.streams || []).filter((stream) => stream.codec_type === "subtitle");
    const explicitSubtitle = streamIndex(options.subtitle);
    if (explicitSubtitle !== null) {
      const subtitleIndex = subtitles.findIndex((stream) => stream.index === explicitSubtitle);
      if (subtitleIndex === -1) {
        throw new Error(`Requested subtitle stream was not found: ${explicitSubtitle}`);
      }

      return subtitleFromStream(inputPath, subtitles[subtitleIndex], subtitleIndex);
    }

    if (options.subtitle === "auto" && !isJapaneseStream(audioStream)) {
      logger.full(`[hls] subtitles skipped because selected audio is not Japanese: ${streamLog(audioStream)}`);
      return null;
    }

    const external = await findEnglishExternalSubtitle(inputPath);
    if (external) {
      logger.full(`[hls] selected external English subtitle="${external}"`);
      return {
        type: "external",
        path: external,
        videoFilter: `subtitles=${escapeSubtitleFilterPath(external)}`
      };
    }

    const subtitleIndex = selectEnglishSubtitleIndex(subtitles);
    if (subtitleIndex === -1) {
      logger.full(`[hls] no English subtitle found; subtitleStreams=${JSON.stringify(subtitles.map(streamLog))}`);
      if (subtitles.length > 0) {
        throw new Error("Japanese audio was requested, but no English subtitle stream was found.");
      }

      throw new Error("Japanese audio was requested, but this media has no subtitles.");
    }

    const subtitleStream = subtitles[subtitleIndex];
    return subtitleFromStream(inputPath, subtitleStream, subtitleIndex);
  }

  async readManifest(cacheKey) {
    if (!/^[a-f0-9]{24}$/.test(cacheKey)) {
      throw new Error("Invalid HLS cache key");
    }

    const raw = await fs.readFile(path.join(this.config.hls.cachePath, cacheKey, "stream.json"), "utf8");
    return JSON.parse(raw);
  }

  async readManifestIfPresent(cacheKey) {
    try {
      return await this.readManifest(cacheKey);
    } catch (err) {
      if (err.code === "ENOENT") {
        return null;
      }

      throw err;
    }
  }

  cachedSubtitlePath(filename) {
    if (!filename || filename.includes("/") || filename.includes("\\") || filename.includes("..")) {
      return null;
    }

    return path.join(this.config.subtitles.cachePath, path.basename(filename));
  }
}

function subtitleFromStream(inputPath, subtitleStream, subtitleIndex) {
    const codecName = subtitleStream.codec_name || "unknown";
    if (isTextSubtitleCodec(codecName)) {
      logger.full(`[hls] selected embedded text English subtitle=${streamLog(subtitleStream)} relativeIndex=${subtitleIndex}`);
      return {
        type: "embedded",
        index: subtitleStream.index,
        relativeIndex: subtitleIndex,
        codecName,
        burnable: true,
        videoFilter: `subtitles=${escapeSubtitleFilterPath(inputPath)}:si=${subtitleIndex}`
      };
    }

    if (isBitmapSubtitleCodec(codecName)) {
      logger.full(`[hls] selected embedded bitmap English subtitle=${streamLog(subtitleStream)} relativeIndex=${subtitleIndex}`);
      return {
        type: "embedded",
        index: subtitleStream.index,
        relativeIndex: subtitleIndex,
        codecName,
        burnable: true,
        bitmapSubtitleIndex: subtitleIndex,
        needsSubtitleDurationFix: true
      };
    }

    logger.full(`[hls] selected English subtitle has unsupported codec=${codecName} stream=${streamLog(subtitleStream)}`);
    return {
      type: "embedded",
      index: subtitleStream.index,
      relativeIndex: subtitleIndex,
      codecName,
      burnable: false
    };
}

function quoteCommand(binaryPath, args) {
  return [binaryPath, ...args].map(quoteArg).join(" ");
}

function quoteArg(value) {
  const text = String(value);
  if (!text || /[\s"'[\];,()]/.test(text)) {
    return `"${text.replace(/"/g, '\\"')}"`;
  }

  return text;
}

function streamLog(stream) {
  if (!stream) {
    return "none";
  }

  const tags = stream.tags || {};
  const parts = [
    `index=${stream.index}`,
    `type=${stream.codec_type}`,
    `codec=${stream.codec_name || "unknown"}`
  ];

  if (tags.language) {
    parts.push(`lang=${tags.language}`);
  }
  if (tags.title) {
    parts.push(`title="${tags.title}"`);
  }
  if (stream.width && stream.height) {
    parts.push(`size=${stream.width}x${stream.height}`);
  }
  if (stream.pix_fmt) {
    parts.push(`pix_fmt=${stream.pix_fmt}`);
  }
  if (stream.bits_per_raw_sample) {
    parts.push(`bits=${stream.bits_per_raw_sample}`);
  }
  if (stream.profile) {
    parts.push(`profile="${stream.profile}"`);
  }

  return parts.join(" ");
}

function summarizeFfmpegOutput(output) {
  return String(output || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("frame="))
    .slice(-12)
    .join(" | ");
}

function subtitleLog(subtitle) {
  if (!subtitle) {
    return "none";
  }

  if (subtitle.type === "external") {
    return `external path="${subtitle.path}"`;
  }

  return `embedded index=${subtitle.index} relativeIndex=${subtitle.relativeIndex} codec=${subtitle.codecName} burnable=${subtitle.burnable}`;
}

function selectVideoStream(probe) {
  return (probe.streams || []).find((stream) => (
    stream.codec_type === "video"
    && Number(stream.disposition && stream.disposition.attached_pic) !== 1
  ));
}

function isCompatibleH264Stream(stream) {
  if (!stream || stream.codec_name !== "h264") {
    return false;
  }

  const pixelFormat = String(stream.pix_fmt || "").toLowerCase();
  const bitsPerRawSample = Number.parseInt(stream.bits_per_raw_sample || "8", 10);
  const compatiblePixelFormat = pixelFormat === "yuv420p" || pixelFormat === "nv12";
  const compatibleBitDepth = !Number.isFinite(bitsPerRawSample) || bitsPerRawSample <= 8;

  return compatiblePixelFormat && compatibleBitDepth;
}

function selectAudioStream(probe, preference) {
  const audioStreams = (probe.streams || []).filter((stream) => stream.codec_type === "audio");
  if (audioStreams.length === 0) {
    throw new Error("No audio stream found");
  }

  const requestedStream = streamIndex(preference);
  if (requestedStream !== null) {
    const audioStream = audioStreams.find((stream) => stream.index === requestedStream);
    if (!audioStream) {
      throw new Error(`Requested audio stream was not found: ${requestedStream}`);
    }

    return audioStream;
  }

  const languageAliases = preference === "japanese" ? ["jpn", "ja", "japanese"] : ["eng", "en", "english"];
  return audioStreams.find((stream) => languageAliases.includes(String(stream.tags && stream.tags.language || "").toLowerCase()))
    || audioStreams[0];
}

function normalizeSubtitlePreference(value) {
  if (!value || value === "auto") {
    return "auto";
  }

  const selected = String(value);
  if (["none", "off", "false", "0"].includes(selected.toLowerCase())) {
    return "none";
  }

  return selected;
}

function normalizeAudioChannelPreference(value) {
  const selected = String(value || "preserve").toLowerCase();
  if (["stereo", "mixdown", "stereo-mixdown", "stereomixdown"].includes(selected)) {
    return "stereo";
  }
  if (["5.1", "51", "surround", "surround51", "surround-5.1", "six-channel"].includes(selected)) {
    return "surround51";
  }
  if (["stabby", "stabby51", "stabby-5.1", "stabby5.1"].includes(selected)) {
    return "stabby51";
  }

  return "preserve";
}

function selectAudioMode(audioStream, preference) {
  if (preference === "stereo") {
    return {
      id: "stereo",
      forceTranscode: true,
      channels: 2,
      filter: null
    };
  }

  if (preference === "surround51") {
    return {
      id: "surround51",
      forceTranscode: false,
      channels: audioStream.codec_name === "aac" ? null : 6,
      filter: null
    };
  }

  if (preference === "stabby51") {
    return {
      id: "stabby51",
      forceTranscode: true,
      channels: null,
      filter: "channelmap=0|1|4|5|2|3"
    };
  }

  return {
    id: "preserve",
    forceTranscode: false,
    channels: null,
    filter: null
  };
}

function audioBitrate(audioMode) {
  return audioMode.id === "stereo" ? "160k" : "384k";
}

function streamIndex(value) {
  const match = String(value || "").match(/^stream:(\d+)$/);
  return match ? Number.parseInt(match[1], 10) : null;
}

function externalSubtitleName(value) {
  const match = String(value || "").match(/^external:(.+)$/);
  if (!match || match[1].includes("/") || match[1].includes("\\") || match[1].includes("..")) {
    return null;
  }

  return match[1];
}

function cachedSubtitleName(value) {
  const match = String(value || "").match(/^cached:(.+)$/);
  if (!match || match[1].includes("/") || match[1].includes("\\") || match[1].includes("..")) {
    return null;
  }

  return match[1];
}

function isJapaneseStream(stream) {
  if (!stream) {
    return false;
  }

  const tags = stream.tags || {};
  return /(^|[^a-z])(jpn|ja|japanese)([^a-z]|$)/i.test(`${tags.language || ""} ${tags.title || ""} ${tags.handler_name || ""}`);
}

function hardwareEncoderArgs(videoCodec, targetBitrate) {
  if (videoCodec === "h264_nvenc") {
    const args = [
      "-forced-idr",
      "1",
      "-no-scenecut",
      "1",
      "-preset",
      "p1",
      "-tune",
      "ll",
      "-rc",
      "vbr",
      "-cq",
      "24"
    ];
    if (targetBitrate) {
      args.push(...videoBitrateArgs(targetBitrate));
    } else {
      args.push(
        "-b:v",
        "0",
        "-maxrate",
        "16M",
        "-bufsize",
        "32M"
      );
    }

    args.push("-spatial-aq", "1");
    return args;
  }

  if (videoCodec === "h264_vaapi") {
    return ["-qp", vaapiQpForTargetBitrate(targetBitrate)];
  }

  if (videoCodec === "h264_qsv" || videoCodec === "h264_amf") {
    return targetBitrate ? videoBitrateArgs(targetBitrate) : ["-b:v", "5M", "-maxrate", "7M", "-bufsize", "10M"];
  }

  if (videoCodec === "h264_videotoolbox") {
    return targetBitrate ? ["-b:v", bitrateValue(targetBitrate)] : ["-b:v", "5M"];
  }

  return [];
}

function videoBitrateArgs(targetBitrate) {
  return [
    "-b:v",
    bitrateValue(targetBitrate),
    "-maxrate",
    bitrateValue(Math.round(targetBitrate * 1.4)),
    "-bufsize",
    bitrateValue(Math.round(targetBitrate * 2))
  ];
}

function vaapiQpForTargetBitrate(targetBitrate) {
  if (!targetBitrate) {
    return "24";
  }

  if (targetBitrate >= 10_000_000) {
    return "22";
  }
  if (targetBitrate >= 5_000_000) {
    return "24";
  }
  if (targetBitrate >= 2_500_000) {
    return "27";
  }
  return "30";
}

function bitrateValue(bitsPerSecond) {
  return `${Math.max(1, Math.round(bitsPerSecond / 1000))}k`;
}

function transcodeScaleFilter(videoStream, maxHeight) {
  if (!videoStream || !maxHeight || !videoStream.height || videoStream.height <= maxHeight) {
    return null;
  }

  return `scale=-2:${maxHeight}`;
}

function outputGopSize(videoStream, segmentSeconds) {
  const fps = frameRate(videoStream);
  return Math.max(1, Math.round(fps * segmentSeconds));
}

function frameRate(videoStream) {
  if (!videoStream) {
    return 24;
  }

  return parseFrameRate(videoStream.avg_frame_rate)
    || parseFrameRate(videoStream.r_frame_rate)
    || 24;
}

function parseFrameRate(value) {
  const text = String(value || "");
  const fraction = text.match(/^(\d+)\/(\d+)$/);
  if (fraction) {
    const numerator = Number.parseInt(fraction[1], 10);
    const denominator = Number.parseInt(fraction[2], 10);
    return denominator > 0 ? numerator / denominator : null;
  }

  const parsed = Number.parseFloat(text);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function composeFilters(filters) {
  return filters.filter(Boolean).join(",") || null;
}

function hardwareFrameDownloadFilter(frameType, videoStream) {
  if (frameType === "cuda") {
    return cudaFrameDownloadFilter(videoStream);
  }

  return null;
}

function cudaFrameDownloadFilter(videoStream) {
  return isTenBitVideo(videoStream) ? "hwdownload,format=p010le" : "hwdownload,format=nv12";
}

function isTenBitVideo(stream) {
  const pixelFormat = String(stream && stream.pix_fmt || "").toLowerCase();
  const bitsPerRawSample = Number.parseInt(stream && stream.bits_per_raw_sample || "", 10);
  const profile = String(stream && stream.profile || "").toLowerCase();

  return pixelFormat.includes("10") || pixelFormat.includes("p010") || bitsPerRawSample > 8 || profile.includes("10");
}

function bitmapSubtitleFilterComplex(subtitleIndex, scaleFilter, frameDownloadFilter, frameUploadFilter) {
  const uploadFilter = frameUploadFilter ? `,${frameUploadFilter}` : "";
  if (!scaleFilter && !frameDownloadFilter && !frameUploadFilter) {
    return `[0:v:0][0:s:${subtitleIndex}]overlay[v]`;
  }

  const baseFilter = composeFilters([
    frameDownloadFilter,
    scaleFilter,
    frameDownloadFilter ? "format=yuv420p" : null
  ]);

  if (!baseFilter) {
    return `[0:v:0][0:s:${subtitleIndex}]overlay${uploadFilter}[v]`;
  }

  if (!scaleFilter) {
    return `[0:v:0]${baseFilter}[base];[base][0:s:${subtitleIndex}]overlay${uploadFilter}[v]`;
  }

  return `[0:v:0]${baseFilter}[base];[0:s:${subtitleIndex}]${scaleFilter}[sub];[base][sub]overlay${uploadFilter}[v]`;
}

function isEnglishStream(stream) {
  const tags = stream.tags || {};
  return isEnglishText(tags.language) || isEnglishText(tags.title) || isEnglishText(tags.handler_name);
}

function selectEnglishSubtitleIndex(subtitles) {
  const scored = subtitles
    .map((stream, index) => ({ index, score: englishSubtitleScore(stream) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);

  return scored.length > 0 ? scored[0].index : -1;
}

function englishSubtitleScore(stream) {
  if (!isEnglishStream(stream)) {
    return 0;
  }

  const tags = stream.tags || {};
  const text = `${tags.language || ""} ${tags.title || ""} ${tags.handler_name || ""}`;
  let score = 10;

  if (/\b(full|dialogue|dialog|sdh|cc)\b/i.test(text)) {
    score += 5;
  }

  if (/\b(forced|signs?|songs?)\b/i.test(text)) {
    score -= 7;
  }

  return score;
}

function isTextSubtitleCodec(codecName) {
  return ["ass", "ssa", "subrip", "webvtt", "mov_text", "text"].includes(codecName);
}

function isBitmapSubtitleCodec(codecName) {
  return ["dvd_subtitle", "dvb_subtitle", "hdmv_pgs_subtitle", "xsub"].includes(codecName);
}

async function findEnglishExternalSubtitle(inputPath) {
  const parsed = path.parse(inputPath);
  const subtitleDir = parsed.dir || ".";
  const entries = await fs.readdir(subtitleDir, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isFile() && SUBTITLE_EXTENSIONS.includes(path.extname(entry.name).toLowerCase()))
    .map((entry) => subtitleCandidate(parsed, entry.name))
    .filter(Boolean);

  const english = candidates
    .filter((candidate) => candidate.language === "english")
    .sort((a, b) => b.score - a.score)[0];
  if (english) {
    return english.path;
  }

  const exact = candidates.filter((candidate) => candidate.language === "unknown" && candidate.exactBasename);
  if (candidates.length === 1 && exact.length === 1) {
    return exact[0].path;
  }

  return null;
}

async function findExternalSubtitleByName(inputPath, filename) {
  const parsed = path.parse(inputPath);
  const subtitleDir = parsed.dir || ".";
  const candidate = path.join(subtitleDir, filename);

  if (!SUBTITLE_EXTENSIONS.includes(path.extname(candidate).toLowerCase())) {
    return null;
  }

  try {
    await fs.access(candidate);
    return candidate;
  } catch (err) {
    if (err.code === "ENOENT") {
      return null;
    }

    throw err;
  }
}

function subtitleCandidate(video, filename) {
  const videoDir = video.dir || ".";
  const extension = path.extname(filename);
  const basename = path.basename(filename, extension);

  if (basename.toLowerCase() === video.name.toLowerCase()) {
    return {
      path: path.join(videoDir, filename),
      language: "unknown",
      score: 1,
      exactBasename: true
    };
  }

  const prefix = `${video.name}`.toLowerCase();
  if (!basename.toLowerCase().startsWith(prefix)) {
    return null;
  }

  const suffix = basename.slice(video.name.length);
  if (!/^[ ._-]+/.test(suffix)) {
    return null;
  }

  return {
    path: path.join(videoDir, filename),
    language: isEnglishText(suffix) ? "english" : "other",
    score: englishSubtitleTextScore(suffix),
    exactBasename: false
  };
}

function isEnglishText(value) {
  return /(^|[^a-z])(eng|en|english)([^a-z]|$)/i.test(String(value || ""));
}

function englishSubtitleTextScore(value) {
  let score = 10;
  const text = String(value || "");

  if (/\b(full|dialogue|dialog|sdh|cc)\b/i.test(text)) {
    score += 5;
  }

  if (/\b(forced|signs?|songs?)\b/i.test(text)) {
    score -= 7;
  }

  return score;
}

function buildManifest(probe, segmentSeconds, options = {}) {
  const duration = mediaDurationSeconds(probe);
  if (!duration) {
    throw new Error("Unable to determine media duration for synthetic HLS playlist");
  }

  const segmentCount = Math.max(1, Math.ceil(duration / segmentSeconds));
  return {
    version: 1,
    type: "synthetic-vod",
    duration,
    segmentSeconds,
    segmentCount,
    targetDuration: Math.ceil(segmentSeconds),
    independentSegments: Boolean(options.independentSegments),
    splitByTime: Boolean(options.splitByTime)
  };
}

function buildVodPlaylist(manifest) {
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:6",
    "#EXT-X-PLAYLIST-TYPE:VOD",
    ...(manifest.independentSegments ? ["#EXT-X-INDEPENDENT-SEGMENTS"] : []),
    `#EXT-X-TARGETDURATION:${Math.ceil(manifest.targetDuration || manifest.segmentSeconds)}`,
    "#EXT-X-MEDIA-SEQUENCE:0"
  ];

  for (let index = 0; index < manifest.segmentCount; index += 1) {
    lines.push(`#EXTINF:${segmentDuration(manifest, index).toFixed(3)},`);
    lines.push(`segment_${String(index).padStart(5, "0")}.ts`);
  }

  lines.push("#EXT-X-ENDLIST");
  return lines.join("\n");
}

function segmentDuration(manifest, index) {
  const segmentSeconds = Number(manifest.segmentSeconds) || 6;
  const duration = Number(manifest.duration) || segmentSeconds;
  const elapsed = index * segmentSeconds;
  const remaining = duration - elapsed;
  if (remaining <= 0) {
    return segmentSeconds;
  }

  return Math.min(segmentSeconds, remaining);
}

function mediaDurationSeconds(probe) {
  const candidates = [
    probe && probe.format && probe.format.duration,
    ...(probe && Array.isArray(probe.streams) ? probe.streams.map((stream) => stream.duration) : [])
  ];

  for (const candidate of candidates) {
    const parsed = Number.parseFloat(candidate);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return null;
}

function escapeSubtitleFilterPath(filePath) {
  return filePath
    .replace(/\\/g, "/")
    .replace(/:/g, "\\\\:")
    .replace(/'/g, `${"\\".repeat(3)}'`)
    .replace(/([,;[\]])/g, "\\$1");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForInitialHlsSegment(filePath, exitPromise, timeoutMs) {
  const exitState = { settled: false, error: null };
  exitPromise.then(
    () => { exitState.settled = true; },
    (err) => {
      exitState.settled = true;
      exitState.error = err;
    }
  );

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await fileExists(filePath)) {
      return;
    }
    if (exitState.error) {
      throw exitState.error;
    }
    if (exitState.settled) {
      throw new Error("FFmpeg exited without publishing an audio HLS segment");
    }
    await delay(50);
  }

  throw new Error("Timed out waiting for the first audio HLS segment");
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (err) {
    if (err.code === "ENOENT") {
      return false;
    }

    throw err;
  }
}

async function isPublishedSegment(cacheKey, filename, hlsCachePath) {
  return fileExists(path.join(hlsCachePath, cacheKey, filename));
}

async function readPublishedPlaylist(cacheKey, hlsCachePath) {
  try {
    return await fs.readFile(path.join(hlsCachePath, cacheKey, "master.m3u8"), "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      return null;
    }

    throw err;
  }
}

function isCompletePlaylist(playlist) {
  return String(playlist || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .includes("#EXT-X-ENDLIST");
}

function segmentFilenameIndex(filename) {
  const match = String(filename || "").match(/^segment_(\d{5})\.ts$/);
  return match ? Number.parseInt(match[1], 10) : null;
}

module.exports = { HlsService };
