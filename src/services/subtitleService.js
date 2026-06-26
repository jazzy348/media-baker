const AdmZip = require("adm-zip");
const { execFile } = require("child_process");
const fs = require("fs/promises");
const path = require("path");
const util = require("util");
const { createId } = require("../utils/mediaParsers");
const logger = require("../utils/logger");

const SUBDL_API_URL = "https://api.subdl.com/api/v1/subtitles";
const SUBDL_DOWNLOAD_HOST = "https://dl.subdl.com";
const execFileAsync = util.promisify(execFile);

class SubtitleService {
  constructor(config) {
    this.rootConfig = config;
    this.config = config.subtitles;
  }

  async search(mediaType, mediaFile, options = {}) {
    if (!this.config.enabled) {
      return {
        enabled: false,
        reason: "Subtitle search is disabled.",
        candidates: []
      };
    }

    if (this.config.provider !== "subdl") {
      return {
        enabled: false,
        reason: `Unsupported subtitle provider: ${this.config.provider}`,
        candidates: []
      };
    }

    if (!this.config.subdlApiKey) {
      return {
        enabled: false,
        reason: "SubDL API key is not configured.",
        candidates: []
      };
    }

    const language = normalizeSubtitleLanguage(options.language || this.config.defaultLanguage);
    const plans = subdlSearchPlans(this.config.subdlApiKey, mediaType, mediaFile, language, options.metadata);
    const resultSets = [];

    for (const plan of plans) {
      logger.full(`[subtitles] SubDL search strategy=${plan.strategy} mediaType=${mediaType} id=${mediaFile.id} query="${subdlQueryLog(plan.params)}"`);
      try {
        const results = await this.searchSubdl(plan.params);
        const count = Array.isArray(results.subtitles) ? results.subtitles.length : 0;
        logger.full(`[subtitles] SubDL search result strategy=${plan.strategy} subtitles=${count}`);
        resultSets.push({ plan, results });
      } catch (err) {
        logger.full(`[subtitles] SubDL search failed strategy=${plan.strategy} message="${err.message}"`);
      }
    }

    const candidates = candidatesFromResultSets(resultSets, mediaFile);

    return {
      enabled: true,
      provider: "subdl",
      language,
      query: plans.map((plan) => subdlQueryLog(plan.params)),
      candidates
    };
  }

  async download(mediaType, mediaFile, candidateId, options = {}) {
    if (!this.config.enabled) {
      throw new Error("Subtitle search is disabled.");
    }
    if (!this.config.subdlApiKey) {
      throw new Error("SubDL API key is required to download subtitles.");
    }

    const candidate = decodeCandidateId(candidateId);
    if (!candidate || !candidate.downloadUrl) {
      throw new Error("Invalid subtitle candidate.");
    }

    const subtitle = await this.downloadSubtitle(candidate.downloadUrl);
    const filename = cachedSubtitleFilename(mediaType, mediaFile.id, candidate, subtitle.extension);
    const filePath = path.join(this.config.cachePath, filename);
    const syncResult = await this.writeSyncedSubtitle(mediaFile, filePath, subtitle);

    await fs.mkdir(this.config.cachePath, { recursive: true });
    await fs.writeFile(`${filePath}.json`, JSON.stringify({
      mediaType,
      mediaId: mediaFile.id,
      provider: "subdl",
      fileId: candidate.fileId,
      sourceFileName: subtitle.fileName || candidate.fileName,
      language: candidate.language || this.config.defaultLanguage,
      release: candidate.release || null,
      sync: syncResult,
      cachedAt: new Date().toISOString()
    }, null, 2));

    return cachedSubtitleOption(filename, {
      language: candidate.language || this.config.defaultLanguage,
      sourceFileName: subtitle.fileName || candidate.fileName,
      sync: syncResult
    });
  }

  async cachedOptions(mediaType, mediaId) {
    try {
      const entries = await fs.readdir(this.config.cachePath, { withFileTypes: true });
      const prefix = cachedSubtitlePrefix(mediaType, mediaId);
      const files = entries
        .filter((entry) => entry.isFile() && entry.name.startsWith(prefix) && isSubtitleFile(entry.name))
        .map((entry) => entry.name);

      return Promise.all(files.map(async (filename) => {
        const meta = await this.readCachedMetadata(filename);
        return cachedSubtitleOption(filename, meta);
      }));
    } catch (err) {
      if (err.code === "ENOENT") {
        return [];
      }

      throw err;
    }
  }

  cachedSubtitlePath(filename) {
    if (!filename || filename.includes("/") || filename.includes("\\") || filename.includes("..")) {
      return null;
    }

    return path.join(this.config.cachePath, path.basename(filename));
  }

  async validateTools() {
    const syncRequired = Boolean(this.config.enabled && this.config.sync && this.config.sync.enabled !== false);
    const ffsubsyncPath = this.config.sync && this.config.sync.ffsubsyncPath || "ffsubsync";
    if (!syncRequired) {
      return {
        required: false,
        ok: true,
        ffsubsync: {
          ok: true,
          path: ffsubsyncPath,
          skipped: true
        }
      };
    }

    try {
      const stdout = await toolOutput(ffsubsyncPath, ["--version"])
        .catch(() => toolOutput(ffsubsyncPath, ["--help"]));
      return {
        required: true,
        ok: true,
        ffsubsync: {
          ok: true,
          path: ffsubsyncPath,
          version: String(stdout || "").split(/\r?\n/)[0] || "ffsubsync"
        }
      };
    } catch (err) {
      return {
        required: true,
        ok: false,
        ffsubsync: {
          ok: false,
          path: ffsubsyncPath,
          error: err.message
        }
      };
    }
  }

  async readCachedMetadata(filename) {
    try {
      return JSON.parse(await fs.readFile(path.join(this.config.cachePath, `${filename}.json`), "utf8"));
    } catch (err) {
      if (err.code === "ENOENT") {
        return {};
      }

      throw err;
    }
  }

  async searchSubdl(params) {
    const url = new URL(SUBDL_API_URL);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }

    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": this.config.userAgent
      }
    });
    if (!response.ok) {
      throw new Error(`SubDL request failed with HTTP ${response.status}`);
    }

    const result = await response.json();
    if (result && result.status === false) {
      throw new Error(`SubDL search failed: ${result.error || result.message || "unknown error"}`);
    }

    return result;
  }

  async downloadSubtitle(downloadUrl) {
    const response = await fetch(downloadUrl, {
      headers: {
        "User-Agent": this.config.userAgent
      }
    });
    if (!response.ok) {
      throw new Error(`SubDL subtitle download failed with HTTP ${response.status}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (isZipBuffer(buffer) || /\.zip(?:$|\?)/i.test(downloadUrl)) {
      return subtitleFromZip(buffer);
    }

    const extension = subtitleExtension(downloadUrl);
    return {
      fileName: path.basename(new URL(downloadUrl).pathname) || `subtitle${extension}`,
      extension,
      text: buffer.toString("utf8")
    };
  }

  async writeSyncedSubtitle(mediaFile, outputPath, subtitle) {
    await fs.mkdir(this.config.cachePath, { recursive: true });
    if (!this.config.sync || this.config.sync.enabled === false) {
      await fs.writeFile(outputPath, subtitle.text);
      return {
        status: "disabled",
        synced: false
      };
    }

    if (subtitle.extension !== ".srt") {
      throw new Error(`Automatic subtitle sync requires SRT subtitles. SubDL returned ${subtitle.extension}.`);
    }

    const inputPath = `${outputPath}.unsynced${subtitle.extension}`;
    await fs.writeFile(inputPath, subtitle.text);
    try {
      await this.syncSubtitle(mediaFile.filePath, inputPath, outputPath);
      return {
        status: "synced",
        synced: true,
        tool: "ffsubsync"
      };
    } finally {
      await fs.rm(inputPath, { force: true });
    }
  }

  async syncSubtitle(mediaPath, inputPath, outputPath) {
    const args = [
      mediaPath,
      "-i",
      inputPath,
      "-o",
      outputPath,
      "--max-offset-seconds",
      String(this.config.sync.maxOffsetSeconds)
    ];

    if (this.rootConfig.ffmpeg && this.rootConfig.ffmpeg.ffmpegPath) {
      args.push("--ffmpeg-path", this.rootConfig.ffmpeg.ffmpegPath);
    }

    logger.info(`[subtitles] auto-sync starting tool="${this.config.sync.ffsubsyncPath}" media="${mediaPath}" subtitle="${inputPath}"`);
    try {
      await execFileAsync(this.config.sync.ffsubsyncPath, args, {
        windowsHide: true,
        timeout: this.config.sync.timeoutSeconds * 1000,
        maxBuffer: 1024 * 1024
      });
      logger.info(`[subtitles] auto-sync complete output="${outputPath}"`);
    } catch (err) {
      const detail = err.stderr || err.stdout || err.message || "unknown error";
      throw new Error(`Automatic subtitle sync failed. Install ffsubsync, put it in bin, or make it available on PATH. ${String(detail).trim()}`);
    }
  }
}

async function toolOutput(binaryPath, args) {
  const { stdout } = await execFileAsync(binaryPath, args, {
    windowsHide: true,
    timeout: 5000
  });
  return stdout;
}

function subdlSearchPlans(apiKey, mediaType, mediaFile, language, metadata) {
  const tv = Boolean(mediaFile.showName);
  const base = {
    api_key: apiKey,
    type: tv ? "tv" : "movie",
    season_number: tv ? mediaFile.season : null,
    episode_number: tv ? mediaFile.episode : null,
    languages: language,
    subs_per_page: 30
  };
  const plans = [];
  const addPlan = (strategy, params) => {
    const cleaned = cleanParams({
      ...base,
      ...params
    });
    const signature = JSON.stringify(cleaned);
    if (!plans.some((plan) => plan.signature === signature)) {
      plans.push({ strategy, params: cleaned, signature });
    }
  };

  if (metadata && metadata.provider === "tmdb" && metadata.providerId) {
    addPlan("tmdb-id", { tmdb_id: metadata.providerId });
  }

  for (const title of titleCandidates(mediaFile, metadata)) {
    addPlan("title-year", {
      film_name: title,
      year: tv ? null : mediaFile.year || metadata && metadata.releaseYear || titleYear(title)
    });
    addPlan("title", {
      film_name: stripYear(title)
    });
  }

  const cleanedFilename = cleanReleaseTitle(mediaFile.filename);
  if (cleanedFilename) {
    addPlan("clean-filename-title", {
      film_name: cleanedFilename,
      year: tv ? null : mediaFile.year || titleYear(mediaFile.filename)
    });
  }

  if (mediaFile.filename) {
    addPlan("filename", {
      file_name: mediaFile.filename
    });
  }

  return plans;
}

function candidatesFromResultSets(resultSets, mediaFile) {
  const seen = new Set();
  const candidates = [];

  for (const { plan, results } of resultSets) {
    for (const candidate of candidatesFromResults(results, mediaFile, plan.strategy)) {
      const key = candidate.downloadUrl || candidate.fileId;
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      candidates.push(candidate);
    }
  }

  return candidates.slice(0, 25);
}

function candidatesFromResults(results, mediaFile, matchType) {
  const subtitles = Array.isArray(results.subtitles) ? results.subtitles : [];
  return subtitles
    .filter((entry) => subtitleMatchesEpisode(entry, mediaFile))
    .map((entry) => {
      const downloadUrl = absoluteSubdlDownloadUrl(entry.download_link || entry.url);
      const candidate = {
        fileId: entry.sd_id || entry.id || entry.url || downloadUrl,
        fileName: entry.name || entry.release_name || path.basename(downloadUrl || ""),
        downloadUrl,
        language: normalizeProviderLanguage(entry.lang || entry.language),
        release: entry.release_name || entry.name,
        matchType,
        hearingImpaired: valueIsTrue(entry.hi || entry.hearing_impaired),
        foreignPartsOnly: false,
        aiTranslated: false,
        machineTranslated: false,
        ratings: Number.parseFloat(entry.rating || 0) || 0,
        downloadCount: Number.parseInt(entry.download_count || entry.downloads || 0, 10) || 0,
        author: entry.author || entry.uploader || null,
        season: entry.season || null,
        episode: entry.episode || null
      };
      return {
        id: encodeCandidateId(candidate),
        ...candidate,
        label: candidateLabel(candidate)
      };
    })
    .filter((candidate) => candidate.downloadUrl)
    .slice(0, 25);
}

function subtitleMatchesEpisode(entry, mediaFile) {
  if (!mediaFile.showName) {
    return true;
  }

  const season = numberOrNull(entry.season);
  if (season && mediaFile.season && season !== mediaFile.season) {
    return false;
  }

  const episode = numberOrNull(entry.episode);
  if (episode && mediaFile.episode && episode !== mediaFile.episode) {
    return false;
  }

  const episodeFrom = numberOrNull(entry.episode_from);
  const episodeEnd = numberOrNull(entry.episode_end);
  if (episodeFrom && episodeEnd && mediaFile.episode) {
    return episodeFrom <= mediaFile.episode && mediaFile.episode <= episodeEnd;
  }

  return true;
}

function absoluteSubdlDownloadUrl(value) {
  const text = String(value || "").trim();
  if (!text) {
    return null;
  }
  if (/^https?:\/\//i.test(text)) {
    return text;
  }

  return `${SUBDL_DOWNLOAD_HOST}${text.startsWith("/") ? "" : "/"}${text}`;
}

function subtitleFromZip(buffer) {
  const zip = new AdmZip(buffer);
  const selected = zip.getEntries()
    .filter((entry) => !entry.isDirectory && isSubtitleFile(entry.entryName))
    .sort((a, b) => subtitleRank(a.entryName) - subtitleRank(b.entryName))[0];

  if (!selected) {
    throw new Error("SubDL ZIP did not contain a supported subtitle file.");
  }

  return {
    fileName: path.basename(selected.entryName),
    extension: subtitleExtension(selected.entryName),
    text: selected.getData().toString("utf8")
  };
}

function subtitleRank(fileName) {
  const extension = path.extname(fileName).toLowerCase();
  if (extension === ".srt") {
    return 0;
  }
  if (extension === ".vtt") {
    return 1;
  }
  if (extension === ".ass") {
    return 2;
  }
  if (extension === ".ssa") {
    return 3;
  }

  return 99;
}

function isZipBuffer(buffer) {
  return buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b;
}

function encodeCandidateId(candidate) {
  return Buffer.from(JSON.stringify(candidate)).toString("base64url");
}

function decodeCandidateId(candidateId) {
  try {
    return JSON.parse(Buffer.from(String(candidateId || ""), "base64url").toString("utf8"));
  } catch (err) {
    return null;
  }
}

function candidateLabel(candidate) {
  const flags = [
    `SubDL ${candidate.matchType || "query"}`,
    candidate.author ? `by ${candidate.author}` : null,
    candidate.hearingImpaired ? "HI" : null
  ].filter(Boolean).join(", ");
  return `${candidate.release || candidate.fileName}${flags ? ` (${flags})` : ""}`;
}

function titleCandidates(mediaFile, metadata) {
  const values = [
    metadata && metadata.title,
    mediaFile.showName,
    mediaFile.title,
    mediaFile.folder,
    cleanReleaseTitle(mediaFile.filename)
  ];

  return [...new Set(values
    .map((value) => stripYear(value))
    .map((value) => String(value || "").trim())
    .filter(Boolean))];
}

function cleanParams(params) {
  return Object.fromEntries(Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => [key, String(value)]));
}

function subdlQueryLog(params) {
  return Object.entries(params)
    .filter(([key]) => key !== "api_key")
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
}

function stripYear(value) {
  return String(value || "")
    .replace(/\.[a-z0-9]{2,5}$/i, "")
    .replace(/\s*(?:\((\d{4})\)|\[(\d{4})\])\s*$/i, "")
    .trim();
}

function titleYear(value) {
  const match = String(value || "").match(/(?:^|[^\d])(\d{4})(?:[^\d]|$)/);
  if (!match) {
    return null;
  }

  const year = Number.parseInt(match[1], 10);
  return year >= 1880 && year <= 2200 ? year : null;
}

function cleanReleaseTitle(value) {
  const name = stripYear(path.basename(String(value || ""), path.extname(String(value || ""))));
  return name
    .replace(/[._]+/g, " ")
    .replace(/\b(480p|576p|720p|1080p|2160p|4k|uhd|bluray|blu ray|bdrip|webrip|web dl|webdl|hdtv|dvdrip|x264|x265|h264|h265|hevc|aac|dts|truehd|flac|multi|dual audio)\b/gi, " ")
    .replace(/\[[^\]]+\]|\([^\)]*(?:rip|x26[45]|h26[45]|hevc|aac|dts|dual|multi|sub|dub)[^\)]*\)/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cachedSubtitlePrefix(mediaType, mediaId) {
  return `${safeFilename(mediaType)}-${safeFilename(mediaId)}-`;
}

function cachedSubtitleFilename(mediaType, mediaId, candidate, extension) {
  const id = createId(`${candidate.fileId}:${candidate.fileName}:autosync`);
  return `${cachedSubtitlePrefix(mediaType, mediaId)}${id}${extension}`;
}

function cachedSubtitleOption(filename, metadata = {}) {
  const syncStatus = metadata.sync && metadata.sync.synced ? ", auto-synced" : "";
  return {
    id: `cached:${filename}`,
    index: null,
    language: metadata.language || "unknown",
    label: `Fetched ${metadata.language || "subtitle"} - ${metadata.sourceFileName || filename}${syncStatus}`,
    source: "fetched",
    forced: false,
    sync: metadata.sync || null
  };
}

function subtitleExtension(fileName) {
  const pathname = safeUrlPath(fileName);
  const extension = path.extname(pathname).toLowerCase();
  return [".srt", ".vtt", ".ass", ".ssa"].includes(extension) ? extension : ".srt";
}

function isSubtitleFile(fileName) {
  return [".srt", ".vtt", ".ass", ".ssa"].includes(path.extname(fileName).toLowerCase());
}

function normalizeSubtitleLanguage(value) {
  const text = String(value || "eng").trim().toLowerCase();
  const map = {
    english: "en",
    eng: "en",
    japanese: "ja",
    jpn: "ja",
    french: "fr",
    fre: "fr",
    spanish: "es",
    spa: "es",
    german: "de",
    deu: "de",
    ger: "de",
    portuguese: "pt",
    por: "pt",
    italian: "it",
    ita: "it"
  };

  return map[text] || text.slice(0, 2) || "en";
}

function normalizeProviderLanguage(value) {
  const text = String(value || "").trim().toLowerCase();
  const map = {
    english: "eng",
    en: "eng",
    japanese: "jpn",
    ja: "jpn",
    french: "fre",
    fr: "fre",
    spanish: "spa",
    es: "spa",
    german: "deu",
    de: "deu",
    portuguese: "por",
    pt: "por",
    italian: "ita",
    it: "ita"
  };

  return map[text] || text || "unknown";
}

function safeUrlPath(value) {
  try {
    return new URL(value).pathname;
  } catch (err) {
    return String(value || "");
  }
}

function numberOrNull(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function valueIsTrue(value) {
  return value === true || value === 1 || value === "1" || /^true$/i.test(String(value || ""));
}

function safeFilename(value) {
  return String(value || "").replace(/[^a-z0-9._-]/gi, "_");
}

module.exports = { SubtitleService };
