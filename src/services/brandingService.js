const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");

const ICON_SIZES = new Set([180, 192, 512]);
const CLASSIC_ICON_ID = "classic-square";
const ICON_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CLASSIC_ICON_PATH = path.resolve(__dirname, "..", "assets", "branding", "classic-square.svg");

class BrandingService {
  constructor({ appSettings, cachePath, imageProcessor, publicPath }) {
    this.appSettings = appSettings;
    this.cachePath = cachePath;
    this.imageProcessor = imageProcessor;
    this.iconSourcePath = path.join(publicPath, "icons");
    this.icons = [];
    this.current = null;
  }

  async init() {
    this.icons = await discoverIcons(this.iconSourcePath);
    if (this.icons.length === 0) {
      throw new Error(`No Media Baker icons were found in ${this.iconSourcePath}`);
    }

    const settings = await this.appSettings.get();
    const configuredIcon = settings.branding && settings.branding.icon;
    const iconId = this.hasIcon(configuredIcon)
      ? configuredIcon
      : this.icons[crypto.randomInt(this.icons.length)].id;

    await this.activate(iconId);
    if (iconId !== configuredIcon) {
      await this.appSettings.save({ branding: { icon: iconId } });
    }
  }

  hasIcon(iconId) {
    return this.icons.some((icon) => icon.id === iconId);
  }

  validateSelection(iconId) {
    if (!this.hasIcon(iconId)) {
      const err = new Error("Unknown app icon");
      err.status = 400;
      throw err;
    }
  }

  async activate(iconId) {
    const icon = await this.ensureSelection(iconId);
    this.current = icon;
    return this.status();
  }

  async ensureSelection(iconId) {
    this.validateSelection(iconId);
    return this.prepareIcon(this.icons.find((entry) => entry.id === iconId));
  }

  async prepareIcon(icon) {
    const source = await fs.readFile(icon.sourcePath);
    const revision = crypto.createHash("sha256")
      .update("media-baker-branding-v1\0")
      .update(source)
      .digest("hex")
      .slice(0, 16);
    const revisionPath = path.join(this.cachePath, icon.id, revision);

    await Promise.all([...ICON_SIZES].map(async (size) => {
      const outputPath = path.join(revisionPath, iconFilename(icon.id, size));
      if (!await fileExists(outputPath)) {
        await this.imageProcessor.resizePngIcon(icon.sourcePath, outputPath, size);
      }
    }));

    return { ...icon, revision, revisionPath };
  }

  status() {
    if (!this.current) {
      throw new Error("Branding service is not initialized");
    }
    return {
      icon: this.current.id,
      revision: this.current.revision,
      options: this.icons.map((icon) => ({ id: icon.id, title: icon.title })),
      urls: {
        interface: this.immutableUrl(this.current.id, this.current.revision, 512),
        favicon: this.immutableUrl(this.current.id, this.current.revision, 192),
        appleTouch: this.immutableUrl(this.current.id, this.current.revision, 180),
        pwa192: this.immutableUrl(this.current.id, this.current.revision, 192),
        pwa512: this.immutableUrl(this.current.id, this.current.revision, 512)
      }
    };
  }

  manifest() {
    const branding = this.status();
    return {
      id: "/",
      name: "Media Baker",
      short_name: "Media Baker",
      description: "Browse and play media from your Media Baker server.",
      start_url: "/",
      scope: "/",
      display: "standalone",
      background_color: "#05090d",
      theme_color: "#061014",
      icons: [
        {
          src: branding.urls.pwa192,
          sizes: "192x192",
          type: "image/png",
          purpose: "any maskable"
        },
        {
          src: branding.urls.pwa512,
          sizes: "512x512",
          type: "image/png",
          purpose: "any maskable"
        }
      ]
    };
  }

  currentAsset(size) {
    return this.asset(this.current.id, this.current.revision, size);
  }

  asset(iconId, revision, size) {
    const parsedSize = Number.parseInt(size, 10);
    if (!ICON_ID_PATTERN.test(String(iconId || ""))
      || !/^[a-f0-9]{16}$/.test(String(revision || ""))
      || !ICON_SIZES.has(parsedSize)) {
      return null;
    }
    return path.join(this.cachePath, iconId, revision, iconFilename(iconId, parsedSize));
  }

  immutableUrl(iconId, revision, size) {
    return `/app-icons/${encodeURIComponent(iconId)}/${revision}/${iconFilename(iconId, size)}`;
  }
}

async function discoverIcons(iconSourcePath) {
  const icons = [{
    id: CLASSIC_ICON_ID,
    title: "Classic Square",
    sourcePath: CLASSIC_ICON_PATH
  }];
  const entries = (await fs.readdir(iconSourcePath, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    if (!entry.isFile()
      || !entry.name.toLowerCase().endsWith(".png")
      || /^media-baker-\d+\.png$/i.test(entry.name)) continue;
    const name = entry.name.replace(/\.png$/i, "");
    addIcon(icons, name, path.join(iconSourcePath, entry.name));
  }

  return icons;
}

function addIcon(icons, name, sourcePath) {
  const id = slug(name);
  if (!id || icons.some((icon) => icon.id === id)) return;
  icons.push({
    id,
    title: titleCase(name).replace(/^Racoon$/i, "Raccoon"),
    sourcePath
  });
}

function slug(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function titleCase(value) {
  return String(value || "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function iconFilename(iconId, size) {
  return `media-baker-${iconId}-${size}.png`;
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

module.exports = { BrandingService, ICON_SIZES };
