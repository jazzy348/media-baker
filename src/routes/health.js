const express = require("express");

module.exports = function createHealthRoutes({ config, indexStore, mediaIndex, ffmpeg, indexScanScheduler, subtitles, ytdlp }) {
  const router = express.Router();

  router.get("/", async (req, res, next) => {
    try {
      const binaries = await ffmpeg.validate();
      const subtitleTools = subtitles && typeof subtitles.validateTools === "function"
        ? await subtitles.validateTools()
        : { required: false, ok: true };
      const ytdlpTools = ytdlp && config.ytdlp && config.ytdlp.enabled
        ? await ytdlp.validate()
        : { enabled: false, ok: true };
      const playbackReady = Boolean(binaries.ffmpeg.ok && binaries.ffprobe.ok);
      const libraries = config.libraries.filter((library) => canAccessLibrary(req, library.key));
      const counts = await mediaIndex.counts();
      res.json({
        ok: playbackReady && subtitleTools.ok,
        playbackReady,
        warnings: healthWarnings(binaries, subtitleTools, ytdlpTools),
        libraries,
        indexStore: indexStore.type,
        index: {
          generatedAt: mediaIndex.index.generatedAt,
          libraries: indexCounts(mediaIndex.index, counts, req)
        },
        indexScan: indexScanScheduler.getStatus(),
        binaries: {
          ...binaries,
          subtitles: subtitleTools,
          ytdlp: ytdlpTools
        }
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
};

function indexCounts(index, counts, req) {
  return (index.libraries || [])
    .filter((library) => canAccessLibrary(req, library.key))
    .map((library) => {
    return {
      key: library.key,
      title: library.title,
      type: library.type,
      count: counts[library.key] || 0
    };
  });
}

function canAccessLibrary(req, libraryKey) {
  if (req.allowedLibraryKey) {
    return req.allowedLibraryKey === libraryKey;
  }
  if (Array.isArray(req.allowedLibraryKeys)) {
    return req.allowedLibraryKeys.includes(libraryKey);
  }
  return true;
}

function healthWarnings(binaries, subtitleTools, ytdlpTools) {
  const warnings = [];
  if (!binaries.ffmpeg || !binaries.ffmpeg.ok) {
    warnings.push({
      code: "ffmpeg_missing",
      severity: "error",
      message: `FFmpeg is not available at "${binaries.ffmpeg && binaries.ffmpeg.path || "ffmpeg"}". Playback is disabled until it is installed or configured.`
    });
  }
  if (!binaries.ffprobe || !binaries.ffprobe.ok) {
    warnings.push({
      code: "ffprobe_missing",
      severity: "error",
      message: `FFprobe is not available at "${binaries.ffprobe && binaries.ffprobe.path || "ffprobe"}". Playback is disabled until it is installed or configured.`
    });
  }
  if (subtitleTools && subtitleTools.required && !subtitleTools.ok) {
    warnings.push({
      code: "ffsubsync_missing",
      severity: "warning",
      message: `Subtitle auto-sync is enabled, but ffsubsync is not available at "${subtitleTools.ffsubsync && subtitleTools.ffsubsync.path || "ffsubsync"}".`
    });
  }
  if (ytdlpTools && ytdlpTools.enabled && !ytdlpTools.ok) {
    warnings.push({
      code: "ytdlp_missing",
      severity: "warning",
      message: `YT-DLP is enabled, but yt-dlp is not available at "${ytdlpTools.path || "yt-dlp"}". Downloads are disabled until it is installed.`
    });
  }

  return warnings;
}
