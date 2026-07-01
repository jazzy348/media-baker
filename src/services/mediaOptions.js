const fs = require("fs/promises");
const path = require("path");
const { SUBTITLE_EXTENSIONS } = require("../utils/mediaParsers");
const { detectProTv3d } = require("./protv3d");
const { qualityOptionsForProbe } = require("./qualityProfiles");

async function getMediaPlaybackOptions(mediaFile, ffmpeg, options = {}) {
  const probe = await ffmpeg.probe(mediaFile.filePath);
  const streams = probe.streams || [];
  const subtitlesEnabled = !options.library || !options.library.noSubtitles;
  const fetchedSubtitles = subtitlesEnabled && options.subtitles
    ? await options.subtitles.cachedOptions(options.mediaType, mediaFile.id)
    : [];

  return {
    filePath: mediaFile.filePath,
    proTv3d: detectProTv3d(mediaFile, options.library),
    subtitleSearch: {
      enabled: Boolean(subtitlesEnabled && options.subtitles && options.subtitles.config.enabled),
      provider: options.subtitles ? options.subtitles.config.provider : null
    },
    quality: qualityOptionsForProbe(probe),
    audio: streams
      .filter((stream) => stream.codec_type === "audio")
      .map((stream) => ({
        id: `stream:${stream.index}`,
        index: stream.index,
        language: normalizedLanguage(stream),
        label: streamLabel(stream),
        channels: stream.channels || null,
        channelLayout: stream.channel_layout || null,
        surround51: isSurround51(stream)
      })),
    subtitles: [
      {
        id: "none",
        index: null,
        language: "none",
        label: "No subtitles",
        source: "none"
      },
      ...fetchedSubtitles,
      ...await externalSubtitleOptions(mediaFile.filePath),
      ...streams
        .filter((stream) => stream.codec_type === "subtitle")
        .map((stream) => ({
          id: `stream:${stream.index}`,
          index: stream.index,
          language: normalizedLanguage(stream),
          label: streamLabel(stream),
          source: "embedded",
          forced: isForced(stream)
        }))
    ]
  };
}

async function externalSubtitleOptions(filePath) {
  const parsed = path.parse(filePath);
  const dir = parsed.dir || ".";
  const entries = await fs.readdir(dir, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isFile() && SUBTITLE_EXTENSIONS.includes(path.extname(entry.name).toLowerCase()))
    .filter((entry) => isSubtitleForVideo(parsed.name, entry.name))
    .map((entry) => ({
      id: `external:${entry.name}`,
      index: null,
      language: subtitleLanguageFromName(parsed.name, entry.name),
      label: sidecarLabel(parsed.name, entry.name),
      source: "sidecar",
      forced: /forced/i.test(entry.name)
    }));
}

function isSubtitleForVideo(videoName, subtitleName) {
  const subtitleBase = path.basename(subtitleName, path.extname(subtitleName));
  return subtitleBase.toLowerCase() === videoName.toLowerCase()
    || subtitleBase.toLowerCase().startsWith(`${videoName.toLowerCase()}.`)
    || subtitleBase.toLowerCase().startsWith(`${videoName.toLowerCase()} `)
    || subtitleBase.toLowerCase().startsWith(`${videoName.toLowerCase()}_`)
    || subtitleBase.toLowerCase().startsWith(`${videoName.toLowerCase()}-`);
}

function sidecarLabel(videoName, subtitleName) {
  const subtitleBase = path.basename(subtitleName, path.extname(subtitleName));
  const suffix = subtitleBase.slice(videoName.length).replace(/^[ ._-]+/, "");
  return suffix ? `Sidecar ${suffix}` : `Sidecar ${path.extname(subtitleName).slice(1).toUpperCase()}`;
}

function subtitleLanguageFromName(videoName, subtitleName) {
  const suffix = path.basename(subtitleName, path.extname(subtitleName)).slice(videoName.length);
  if (/(^|[^a-z])(eng|en|english)([^a-z]|$)/i.test(suffix)) {
    return "english";
  }
  if (/(^|[^a-z])(jpn|ja|japanese)([^a-z]|$)/i.test(suffix)) {
    return "japanese";
  }

  return "unknown";
}

function normalizedLanguage(stream) {
  const tags = stream.tags || {};
  const text = `${tags.language || ""} ${tags.title || ""} ${tags.handler_name || ""}`;

  if (/(^|[^a-z])(jpn|ja|japanese)([^a-z]|$)/i.test(text)) {
    return "japanese";
  }
  if (/(^|[^a-z])(eng|en|english)([^a-z]|$)/i.test(text)) {
    return "english";
  }

  return tags.language || "unknown";
}

function streamLabel(stream) {
  const tags = stream.tags || {};
  const language = displayLanguage(normalizedLanguage(stream));
  const details = [stream.codec_name, channelLabel(stream), tags.title].filter(Boolean).join(" - ");
  return details ? `${language} - ${details}` : language;
}

function channelLabel(stream) {
  const channels = Number.parseInt(stream.channels, 10);
  if (!Number.isFinite(channels) || channels <= 0) {
    return null;
  }

  const layout = stream.channel_layout ? ` ${stream.channel_layout}` : "";
  return `${channels}ch${layout}`;
}

function displayLanguage(language) {
  if (language === "japanese") {
    return "Japanese";
  }
  if (language === "english") {
    return "English";
  }
  if (language === "none") {
    return "No subtitles";
  }

  return language.charAt(0).toUpperCase() + language.slice(1);
}

function isForced(stream) {
  const disposition = stream.disposition || {};
  const tags = stream.tags || {};
  return disposition.forced === 1 || /forced/i.test(`${tags.title || ""} ${tags.handler_name || ""}`);
}

function isSurround51(stream) {
  const channels = Number.parseInt(stream.channels, 10);
  const layout = String(stream.channel_layout || "").toLowerCase();
  return channels === 6 || /^5\.1/.test(layout);
}

module.exports = { getMediaPlaybackOptions };
