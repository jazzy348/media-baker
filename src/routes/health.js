const express = require("express");

module.exports = function createHealthRoutes({ config, indexStore, mediaIndex, ffmpeg, indexScanScheduler, subtitles }) {
  const router = express.Router();

  router.get("/", async (req, res, next) => {
    try {
      const binaries = await ffmpeg.validate();
      const subtitleTools = subtitles && typeof subtitles.validateTools === "function"
        ? await subtitles.validateTools()
        : { required: false, ok: true };
      const playbackReady = Boolean(binaries.ffmpeg.ok && binaries.ffprobe.ok);
      const libraries = config.libraries.filter((library) => canAccessLibrary(req, library.key));
      res.json({
        ok: playbackReady && subtitleTools.ok,
        playbackReady,
        warnings: healthWarnings(binaries, subtitleTools),
        libraries,
        indexStore: indexStore.type,
        index: {
          generatedAt: mediaIndex.index.generatedAt,
          libraries: indexCounts(mediaIndex.index, req)
        },
        indexScan: indexScanScheduler.getStatus(),
        binaries: {
          ...binaries,
          subtitles: subtitleTools
        }
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
};

function indexCounts(index, req) {
  return (index.libraries || [])
    .filter((library) => canAccessLibrary(req, library.key))
    .map((library) => {
    const collection = index[library.key] || {};
    return {
      key: library.key,
      title: library.title,
      type: library.type,
      count: library.type === "tv"
        ? (collection.shows || []).reduce((total, show) => total + show.seasons.reduce((seasonTotal, season) => seasonTotal + season.episodes.length, 0), 0) + (collection.items || []).length
        : (collection.items || []).length
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

function healthWarnings(binaries, subtitleTools) {
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

  return warnings;
}
