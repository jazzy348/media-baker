const crypto = require("crypto");
const path = require("path");

const VIDEO_EXTENSIONS = new Set([".mp4", ".mkv", ".mov", ".m4v", ".avi", ".webm"]);
const SUBTITLE_EXTENSIONS = [".srt", ".ass", ".ssa", ".vtt"];

function createId(value) {
  return crypto.createHash("sha1").update(value).digest("hex").slice(0, 16);
}

function isVideoFile(filePath) {
  return VIDEO_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function parseEpisodeFile(filePath) {
  const filename = path.basename(filePath, path.extname(filePath));
  const match = episodeMatch(filename);
  const parsedTitle = match ? cleanEpisodeTitle(filename.slice(match.index + match[0].length)) : "";

  return {
    season: match ? match.season : null,
    episode: match ? match.episode : null,
    title: match ? parsedTitle || defaultEpisodeTitle(match) : cleanReleaseName(filename),
    showName: match ? cleanShowName(filename.slice(0, match.index)) : null,
    matchType: match ? match.type : null
  };
}

function episodeMatch(filename) {
  const patterns = [
    { regex: /\bS\s*(\d{1,4})\s*E\s*(\d{1,3})\b/i, type: "seasonEpisode" },
    { regex: /(?:^|[\s._-])(\d{1,2})x(\d{1,3})(?=$|[\s._-])/i, type: "seasonEpisode" },
    { regex: /\bSeason\s*(\d{1,4})\s*(?:Episode|Ep)\s*(\d{1,3})\b/i, type: "seasonEpisode" },
    { regex: /(?:^|[\s._-])[-_][_\s-]*(\d{1,3})(?=$|[\s._\-[\(])/i, type: "animeNumber", season: 1 },
    { regex: /\bOVA\s*0*(\d{1,3})\b/i, type: "ova", season: 0 }
  ];

  for (const pattern of patterns) {
    const match = filename.match(pattern.regex);
    if (match) {
      return normalizeEpisodeMatch(match, pattern);
    }
  }

  return null;
}

function normalizeEpisodeMatch(match, pattern) {
  if (!match[0][0].match(/\d/)) {
    match.index += match[0].length - match[0].trimStart().length;
    match[0] = match[0].trimStart();
  }

  const season = pattern.season === undefined ? Number.parseInt(match[1], 10) : pattern.season;
  const episode = Number.parseInt(pattern.season === undefined ? match[2] : match[1], 10);
  return {
    index: match.index,
    0: match[0],
    season,
    episode,
    type: pattern.type
  };
}

function parseMovieFolder(folderName) {
  const normalized = normalizeSeparators(folderName);
  const match = normalized.match(/^(.*?)(?:\s+|\[|\()((?:19|20)\d{2})(?:\)|\]|\s+|$)/);
  const year = match ? match[2] : null;

  return {
    title: cleanReleaseName(match ? match[1] : folderName),
    year: year ? Number.parseInt(year, 10) : null
  };
}

function cleanEpisodeTitle(value) {
  const title = cleanReleaseName(String(value || "")
    .replace(/^[\s._-]+/, "")
    .replace(/\[[^\]]+\]$/g, "")
    .replace(/\([^)]+\)$/g, ""));
  return isReleaseOnlyTitle(title) ? "" : title;
}

function cleanShowName(value) {
  return cleanReleaseName(String(value || "")
    .replace(/^\[[^\]]+\]/, "")
    .replace(/(?:www\.)?[^.\s]+\.com\s*[-_]\s*/i, "")
    .replace(/[\s._-]+$/g, ""));
}

function cleanReleaseName(value) {
  const normalized = normalizeSeparators(value)
    .replace(/^\[[^\]]+\]\s*/, "")
    .replace(/\b(?:1080p|720p|480p|2160p|4k|uhd|hdr|webrip|web-dl|web|bluray|brrip|bdrip|dvdrip|hdtv|x264|x265|h264|h265|hevc|av1|aac|ac3|ddp5|dual audio|multi subs|10bit|8bit)\b.*$/i, "")
    .replace(/\[[^\]]+\]/g, " ")
    .replace(/\([^)]+\)$/g, " ")
    .replace(/^[\s._-]+|[\s._-]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return normalized || normalizeSeparators(value).trim() || String(value || "").trim();
}

function defaultEpisodeTitle(match) {
  if (match.type === "ova") {
    return `OVA ${String(match.episode).padStart(2, "0")}`;
  }

  return `Episode ${String(match.episode).padStart(2, "0")}`;
}

function isReleaseOnlyTitle(value) {
  const text = String(value || "").trim();
  return !text
    || /^[()[\]\s._-]+$/.test(text)
    || /^(?:1080p|720p|480p|2160p|web|webrip|web-dl|bluray|brrip|hdtv|x264|x265|h264|h265|hevc|av1)\b/i.test(text);
}

function normalizeSeparators(value) {
  return String(value || "")
    .replace(/[._]+/g, " ")
    .replace(/\s+-\s+/g, " - ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeAudioPreference(value, fallback) {
  const selected = String(value || fallback || "english").toLowerCase();
  if (["japanese", "jpn", "ja"].includes(selected)) {
    return "japanese";
  }
  if (["english", "eng", "en"].includes(selected)) {
    return "english";
  }

  return selected;
}

module.exports = {
  SUBTITLE_EXTENSIONS,
  createId,
  isVideoFile,
  normalizeAudioPreference,
  parseEpisodeFile,
  parseMovieFolder
};
