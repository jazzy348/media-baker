const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const logger = require("../utils/logger");

async function loadOrCreatePlaybackSecret(secretPath) {
  const existing = await readExistingSecret(secretPath);
  if (existing) {
    logger.info(`[auth] loaded generated playback secret path="${secretPath}"`);
    return existing;
  }

  const secret = crypto.randomBytes(32).toString("hex");
  await fs.mkdir(path.dirname(secretPath), { recursive: true });
  await fs.writeFile(secretPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    secret
  }, null, 2));
  logger.info(`[auth] generated playback secret path="${secretPath}"`);
  return secret;
}

async function readExistingSecret(secretPath) {
  try {
    const data = JSON.parse(await fs.readFile(secretPath, "utf8"));
    return typeof data.secret === "string" && data.secret.length > 0 ? data.secret : null;
  } catch (err) {
    if (err.code === "ENOENT") {
      return null;
    }

    throw err;
  }
}

module.exports = { loadOrCreatePlaybackSecret };
