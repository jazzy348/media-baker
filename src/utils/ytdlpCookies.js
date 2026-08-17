const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const COOKIE_HEADER = "# Netscape HTTP Cookie File";
const HTTP_ONLY_PREFIX = "#HttpOnly_";

function cookieFilePath(config) {
  return path.join(path.dirname(config.hls.cachePath), "yt-dlp", "youtube-cookies.txt");
}

async function cookieArgs(config) {
  const filePath = cookieFilePath(config);
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() && stat.size > 0 ? ["--cookies", filePath] : [];
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

function sanitiseYoutubeCookies(contents) {
  const lines = String(contents || "").replace(/^\uFEFF/, "").split(/\r?\n/);
  const firstContentLine = lines.find((line) => line.trim());
  if (!firstContentLine || !/^# (?:Netscape HTTP|HTTP) Cookie File\b/i.test(firstContentLine.trim())) {
    throw httpError(400, "The cookie file must use Netscape cookies.txt format.");
  }

  const cookieLines = lines.filter((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") && !trimmed.startsWith(HTTP_ONLY_PREFIX)) return false;
    const fields = trimmed.split("\t");
    if (fields.length < 7) return false;
    const domain = fields[0].replace(HTTP_ONLY_PREFIX, "").replace(/^\./, "").toLowerCase();
    return domain === "youtube.com" || domain.endsWith(".youtube.com");
  });

  if (cookieLines.length === 0) {
    throw httpError(400, "The cookie file does not contain any YouTube cookies.");
  }

  return [
    COOKIE_HEADER,
    "# Stored by Media Baker. Contains YouTube cookies only.",
    ...cookieLines,
    ""
  ].join(os.EOL);
}

function cookieCount(contents) {
  return String(contents || "").split(/\r?\n/).filter((line) => {
    const trimmed = line.trim();
    return trimmed && (!trimmed.startsWith("#") || trimmed.startsWith(HTTP_ONLY_PREFIX));
  }).length;
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

module.exports = {
  cookieArgs,
  cookieCount,
  cookieFilePath,
  sanitiseYoutubeCookies
};
