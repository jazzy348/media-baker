const fs = require("fs/promises");
const path = require("path");
const { randomUUID } = require("crypto");
const { spawn } = require("child_process");
const { Readable, Transform } = require("stream");
const { pipeline } = require("stream/promises");
const packageJson = require("../../package.json");
const logger = require("../utils/logger");

const GITHUB_REPOSITORY = "jazzy348/media-baker";
const GITHUB_API_VERSION = "2022-11-28";
const MAX_ARCHIVE_BYTES = 500 * 1024 * 1024;

class UpdateService {
  constructor(config, request = global.fetch) {
    this.config = config;
    this.request = request;
    this.timer = null;
    this.checkPromise = null;
    this.installPromise = null;
    this.autoInstallQueued = false;
    this.lastAttemptAt = 0;
    this.checkedAt = null;
    this.latest = null;
    this.error = null;
    this.etag = null;
    this.etagUrl = null;
    this.installState = null;
  }

  start() {
    this.restart();
  }

  restart() {
    this.stop();
    if (!this.config.updates.enabled) {
      return;
    }
    this.check(true).catch(() => {});
    this.timer = setInterval(() => {
      this.check().catch(() => {});
    }, this.config.updates.checkIntervalSeconds * 1000);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async status(options = {}) {
    if (this.config.updates.enabled && (options.force || this.isStale())) {
      await this.check(Boolean(options.force));
    }
    return this.publicStatus();
  }

  async check(force = false) {
    if (!this.config.updates.enabled) {
      return this.publicStatus();
    }
    if (this.checkPromise) {
      await this.checkPromise;
      this.maybeAutoInstall();
      return this.publicStatus();
    }
    if (!force && !this.isStale()) {
      this.maybeAutoInstall();
      return this.publicStatus();
    }

    this.lastAttemptAt = Date.now();
    this.checkPromise = this.fetchLatestRelease()
      .catch((err) => {
        this.error = err.message || "GitHub release check failed";
        logger.info(`[updates] release check failed repository=${GITHUB_REPOSITORY} message="${this.error}"`);
      })
      .finally(() => {
        this.checkPromise = null;
      });
    await this.checkPromise;
    this.maybeAutoInstall();
    return this.publicStatus();
  }

  isStale() {
    const intervalMs = this.config.updates.checkIntervalSeconds * 1000;
    return !this.lastAttemptAt || Date.now() - this.lastAttemptAt >= intervalMs;
  }

  async fetchLatestRelease() {
    const includePrereleases = Boolean(this.config.updates.includePrereleases);
    const apiUrl = includePrereleases
      ? `https://api.github.com/repos/${GITHUB_REPOSITORY}/releases?per_page=20`
      : `https://api.github.com/repos/${GITHUB_REPOSITORY}/releases/latest`;
    const headers = githubHeaders(packageJson.version);
    if (this.etag && this.etagUrl === apiUrl) {
      headers["If-None-Match"] = this.etag;
    }

    const response = await this.request(apiUrl, { headers });
    this.checkedAt = new Date().toISOString();
    if (response.status === 304) {
      this.error = null;
      return;
    }
    if (response.status === 404) {
      this.latest = null;
      this.error = null;
      logger.info(`[updates] no published releases repository=${GITHUB_REPOSITORY}`);
      return;
    }
    if (!response.ok) {
      throw new Error(`GitHub returned HTTP ${response.status}`);
    }

    const payload = await response.json();
    const release = includePrereleases ? selectHighestVersion(payload) : payload;
    if (!release) {
      this.latest = null;
      this.error = null;
      return;
    }

    const version = normalizeVersion(release.tag_name);
    if (!version || !release.html_url || !release.zipball_url) {
      throw new Error("The latest GitHub release does not have a valid version tag, URL, and source archive");
    }

    this.etag = response.headers.get("etag") || null;
    this.etagUrl = apiUrl;
    this.latest = {
      version,
      tag: String(release.tag_name),
      name: String(release.name || release.tag_name),
      url: String(release.html_url),
      archiveUrl: String(release.zipball_url),
      prerelease: Boolean(release.prerelease),
      publishedAt: release.published_at || null
    };
    this.error = null;
    logger.info(`[updates] release check complete current=${packageJson.version} latest=${version} prerelease=${this.latest.prerelease} available=${this.updateAvailable()}`);
  }

  async installLatest() {
    if (this.installPromise) {
      return this.installPromise;
    }
    this.installPromise = this.installLatestUnlocked()
      .finally(() => {
        this.installPromise = null;
      });
    return this.installPromise;
  }

  async installLatestUnlocked() {
    if (!this.autoUpdateSupported()) {
      throw httpError(409, "Automatic updates are unavailable in the current process configuration");
    }
    await this.status();
    if (!this.latest || !this.updateAvailable()) {
      throw httpError(409, "No newer release is available");
    }

    try {
      return await this.prepareAndLaunch(this.latest);
    } catch (err) {
      this.installState = {
        phase: "failed",
        version: this.latest && this.latest.version || null,
        error: err.message || "Update installation failed"
      };
      throw err;
    }
  }

  async prepareAndLaunch(release) {
    this.installState = { phase: "downloading", version: release.version, error: null };
    const { releasePath, stagePath } = await this.prepareRelease(release);
    this.installState = { phase: "restarting", version: release.version, error: null };
    const appPath = dockerMode() ? "/cache/app/current" : path.resolve(__dirname, "../..");
    const logPath = path.join(this.config.updates.workPath, "update.log");
    const payload = {
      appPath,
      releasePath,
      stagePath,
      workPath: this.config.updates.workPath,
      logPath,
      version: release.version
    };
    try {
      await requestSupervisorInstall(payload);
    } catch (err) {
      await fs.rm(stagePath, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
    logger.info(`[updates] release staged version=${release.version}; restarting Media Baker`);
    setTimeout(() => process.exit(0), 750).unref();
    return { accepted: true, version: release.version, restarting: true };
  }

  async prepareRelease(release) {
    const stagePath = path.join(this.config.updates.workPath, "staging", `${Date.now()}-${release.version}`);
    const archivePath = path.join(stagePath, "release.zip");
    const extractPath = path.join(stagePath, "source");
    try {
      await fs.rm(stagePath, { recursive: true, force: true });
      await fs.mkdir(extractPath, { recursive: true });
      await downloadArchive(this.request, release.archiveUrl, archivePath);
      extractArchive(archivePath, extractPath);

      const roots = (await fs.readdir(extractPath, { withFileTypes: true })).filter((entry) => entry.isDirectory());
      if (roots.length !== 1) {
        throw new Error("The GitHub source archive does not contain one application root folder");
      }
      const releasePath = path.join(extractPath, roots[0].name);
      const releasePackage = JSON.parse(await fs.readFile(path.join(releasePath, "package.json"), "utf8"));
      const packagedVersion = normalizeVersion(releasePackage.version);
      if (releasePackage.name !== packageJson.name) {
        throw new Error(`The release package is "${releasePackage.name || "unknown"}", expected "${packageJson.name}"`);
      }
      if (packagedVersion !== release.version) {
        throw new Error(`Release tag ${release.tag} resolves to ${release.version}, but package.json contains ${releasePackage.version}`);
      }
      if (!releasePackage.scripts || releasePackage.scripts.start !== "node src/supervisor.js") {
        throw new Error("The release package does not start Media Baker through src/supervisor.js");
      }
      await requireReleaseFile(releasePath, "src/server.js");
      await requireReleaseFile(releasePath, "src/supervisor.js");
      await requireReleaseFile(releasePath, "src/services/updateInstaller.js");

      this.installState = { phase: "installing-dependencies", version: release.version, error: null };
      await runNpmInstall(releasePath);
      await fs.rm(archivePath, { force: true });
      return { releasePath, stagePath };
    } catch (err) {
      await fs.rm(stagePath, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
  }

  maybeAutoInstall() {
    if (!this.config.updates.autoInstall || !this.updateAvailable() || !this.autoUpdateSupported() || this.autoInstallQueued || this.installPromise) {
      return;
    }
    this.autoInstallQueued = true;
    setTimeout(() => {
      this.autoInstallQueued = false;
      this.installLatest().catch((err) => {
        logger.error(`[updates] automatic install failed message="${err.message}"`, err);
      });
    }, 0);
  }

  updateAvailable() {
    return Boolean(this.latest && compareVersions(this.latest.version, packageJson.version) > 0);
  }

  autoUpdateSupported() {
    return typeof process.send === "function";
  }

  publicStatus() {
    return {
      enabled: Boolean(this.config.updates.enabled),
      repository: GITHUB_REPOSITORY,
      currentVersion: packageJson.version,
      checkedAt: this.checkedAt,
      latest: this.latest ? {
        version: this.latest.version,
        tag: this.latest.tag,
        name: this.latest.name,
        url: this.latest.url,
        prerelease: this.latest.prerelease,
        publishedAt: this.latest.publishedAt
      } : null,
      updateAvailable: this.updateAvailable(),
      error: this.error,
      autoUpdateSupported: this.autoUpdateSupported(),
      install: this.installState
    };
  }
}

function githubHeaders(version) {
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": `Media-Baker/${version}`,
    "X-GitHub-Api-Version": GITHUB_API_VERSION
  };
}

async function downloadArchive(request, url, destination) {
  const response = await request(url, { headers: githubHeaders(packageJson.version) });
  if (!response.ok || !response.body) {
    throw new Error(`GitHub archive download returned HTTP ${response.status}`);
  }
  const declaredLength = Number(response.headers.get("content-length")) || 0;
  if (declaredLength > MAX_ARCHIVE_BYTES) {
    throw new Error("The GitHub release archive is larger than 500 MB");
  }

  let received = 0;
  const limiter = new Transform({
    transform(chunk, encoding, callback) {
      received += chunk.length;
      callback(received > MAX_ARCHIVE_BYTES ? new Error("The GitHub release archive exceeded 500 MB") : null, chunk);
    }
  });
  const file = require("fs").createWriteStream(destination);
  await pipeline(Readable.fromWeb(response.body), limiter, file);
}

function extractArchive(archivePath, destination) {
  const AdmZip = require("adm-zip");
  const archive = new AdmZip(archivePath);
  for (const entry of archive.getEntries()) {
    const normalized = path.posix.normalize(entry.entryName.replace(/\\/g, "/"));
    if (normalized.startsWith("../") || path.posix.isAbsolute(normalized)) {
      throw new Error(`Unsafe path in release archive: ${entry.entryName}`);
    }
  }
  archive.extractAllTo(destination, true);
}

function runCommand(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    const errors = [];
    child.stderr.on("data", (chunk) => errors.push(String(chunk).trim()));
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`npm install failed with code ${code}: ${errors.slice(-5).join(" | ")}`));
    });
  });
}

function runNpmInstall(cwd) {
  if (process.platform === "win32") {
    return runCommand(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "npm ci --omit=dev"], cwd);
  }
  return runCommand("npm", ["ci", "--omit=dev"], cwd);
}

async function requireReleaseFile(releasePath, relativePath) {
  try {
    await fs.access(path.join(releasePath, ...relativePath.split("/")));
  } catch (err) {
    throw new Error(`The release is missing required file ${relativePath}`);
  }
}

function requestSupervisorInstall(payload) {
  if (typeof process.send !== "function") {
    return Promise.reject(new Error("Media Baker must be started with npm start so the update supervisor is available"));
  }
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("The update supervisor did not respond"));
    }, 5000);
    const onMessage = (message) => {
      if (!message || message.type !== "install-update-response" || message.requestId !== requestId) {
        return;
      }
      cleanup();
      if (message.accepted) {
        resolve();
      } else {
        reject(new Error(message.error || "The update supervisor rejected the update"));
      }
    };
    const cleanup = () => {
      clearTimeout(timeout);
      process.off("message", onMessage);
    };
    process.on("message", onMessage);
    process.send({ type: "install-update", requestId, payload }, (err) => {
      if (err) {
        cleanup();
        reject(err);
      }
    });
  });
}

function dockerMode() {
  return process.env.MEDIA_BAKER_DOCKER === "1";
}

function normalizeVersion(value) {
  const match = String(value || "").trim().match(/^v?(\d+)\.(\d+)(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) {
    return null;
  }
  return `${Number(match[1])}.${Number(match[2])}.${Number(match[3] || 0)}${match[4] ? `-${match[4]}` : ""}`;
}

function selectHighestVersion(releases) {
  if (!Array.isArray(releases)) {
    return null;
  }
  return releases
    .filter((release) => release && !release.draft && normalizeVersion(release.tag_name))
    .sort((left, right) => compareVersions(normalizeVersion(right.tag_name), normalizeVersion(left.tag_name)))[0] || null;
}

function compareVersions(left, right) {
  const leftVersion = versionParts(left);
  const rightVersion = versionParts(right);
  if (!leftVersion || !rightVersion) {
    return 0;
  }
  for (let index = 0; index < 3; index += 1) {
    if (leftVersion.numbers[index] !== rightVersion.numbers[index]) {
      return leftVersion.numbers[index] > rightVersion.numbers[index] ? 1 : -1;
    }
  }
  if (leftVersion.prerelease === rightVersion.prerelease) return 0;
  if (!leftVersion.prerelease) return 1;
  if (!rightVersion.prerelease) return -1;
  return leftVersion.prerelease.localeCompare(rightVersion.prerelease, undefined, { numeric: true });
}

function versionParts(value) {
  const normalized = normalizeVersion(value);
  if (!normalized) {
    return null;
  }
  const [numbers, prerelease = ""] = normalized.split("-", 2);
  return { numbers: numbers.split(".").map(Number), prerelease };
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

module.exports = {
  GITHUB_REPOSITORY,
  UpdateService,
  compareVersions,
  normalizeVersion
};
