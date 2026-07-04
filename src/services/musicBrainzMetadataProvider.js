const fs = require("fs/promises");
const path = require("path");

const API_BASE = "https://musicbrainz.org/ws/2";
const COVER_ART_BASE = "https://coverartarchive.org";
const USER_AGENT = "MediaBaker/0.2.0 (https://github.com/jazzy348/media-baker)";

class MusicBrainzMetadataProvider {
  constructor(posterDir, cachedImages) {
    this.posterDir = posterDir;
    this.cachedImages = cachedImages;
    this.requestQueue = Promise.resolve();
    this.lastRequestAt = 0;
  }

  async find(mediaFile, input = {}) {
    const candidates = await this.search(mediaFile, input);
    return candidates[0] || null;
  }

  async search(mediaFile, input = {}) {
    const album = String(input.title || input.album || mediaFile.albumName || "").trim();
    const artist = String(input.artist || mediaFile.artistName || "").trim();
    const year = Number.parseInt(input.year || mediaFile.year, 10) || null;
    if (isUnknownAlbum(album)) {
      return this.searchRecordings(mediaFile, artist);
    }
    if (!album) {
      return [];
    }

    const clauses = [`release:\"${escapeLucene(album)}\"`];
    if (artist && artist !== "Unknown Artist") {
      clauses.push(`artist:\"${escapeLucene(artist)}\"`);
    }
    const params = new URLSearchParams({ query: clauses.join(" AND "), fmt: "json", limit: "12" });
    const data = await this.fetchJson(`${API_BASE}/release/?${params.toString()}`);
    return (data.releases || [])
      .map((release) => ({ release, score: releaseScore(release, { album, artist, year }) }))
      .sort((a, b) => b.score - a.score)
      .map(({ release }) => release);
  }

  async searchRecordings(mediaFile, artist) {
    const title = String(mediaFile.title || mediaFile.filename || "").trim();
    if (!title) {
      return [];
    }
    const clauses = [`recording:\"${escapeLucene(title)}\"`];
    if (artist && artist !== "Unknown Artist") {
      clauses.push(`artist:\"${escapeLucene(artist)}\"`);
    }
    const params = new URLSearchParams({ query: clauses.join(" AND "), fmt: "json", limit: "12" });
    const data = await this.fetchJson(`${API_BASE}/recording/?${params.toString()}`);
    const releases = new Map();
    for (const recording of data.recordings || []) {
      for (const release of recording.releases || []) {
        const candidate = {
          ...release,
          score: Number(recording.score) || 0,
          "artist-credit": release["artist-credit"] || recording["artist-credit"] || []
        };
        const current = releases.get(candidate.id);
        if (!current || candidate.score > current.score) {
          releases.set(candidate.id, candidate);
        }
      }
    }
    return [...releases.values()].sort((a, b) => (
      b.score - a.score
      || releaseStatusScore(b.status) - releaseStatusScore(a.status)
      || String(a.date || "").localeCompare(String(b.date || ""))
    )).slice(0, 12);
  }

  async lookup(providerId) {
    const params = new URLSearchParams({ inc: "artist-credits+release-groups+recordings", fmt: "json" });
    return this.fetchJson(`${API_BASE}/release/${encodeURIComponent(providerId)}?${params.toString()}`);
  }

  async createRecord(mediaType, mediaFile, release) {
    const providerId = String(release.id || "");
    const artistName = artistCredit(release) || mediaFile.artistName;
    const posterPath = providerId ? `${COVER_ART_BASE}/release/${providerId}/front-500` : null;
    const posterFilename = posterPath ? await this.cacheCover(providerId, posterPath) : null;
    const date = release.date || release["release-group"] && release["release-group"]["first-release-date"];
    return {
      mediaType,
      mediaId: mediaFile.id,
      found: true,
      provider: "musicbrainz",
      providerId: providerId || null,
      title: mediaFile.title || mediaFile.filename,
      releaseYear: date ? Number.parseInt(String(date).slice(0, 4), 10) || null : mediaFile.year || null,
      overview: [release.title, artistName].filter(Boolean).join(" by "),
      posterPath,
      posterFilename,
      posterUnavailable: !posterFilename,
      posterUnavailableReason: posterFilename ? null : "no-cover-art",
      sourceJson: JSON.stringify({
        ...release,
        artistName,
        albumName: release.title || mediaFile.albumName,
        trackTitle: mediaFile.title,
        aliases: [mediaFile.artistName, mediaFile.albumName].filter(Boolean)
      })
    };
  }

  async ensurePoster(record) {
    if (!record.providerId || record.posterFilename) {
      return record;
    }
    const posterPath = `${COVER_ART_BASE}/release/${record.providerId}/front-500`;
    const posterFilename = await this.cacheCover(record.providerId, posterPath);
    return {
      ...record,
      posterPath,
      posterFilename,
      posterUnavailable: !posterFilename,
      posterUnavailableReason: posterFilename ? null : "no-cover-art"
    };
  }

  candidate(release) {
    const date = release.date || release["release-group"] && release["release-group"]["first-release-date"];
    return {
      provider: "musicbrainz",
      providerId: release.id || null,
      title: release.title || "Untitled album",
      originalTitle: null,
      year: date ? Number.parseInt(String(date).slice(0, 4), 10) || null : null,
      overview: [artistCredit(release), release.country, release.status].filter(Boolean).join(" - "),
      posterPath: release.id ? `${COVER_ART_BASE}/release/${release.id}/front-250` : null,
      posterUrl: release.id ? `${COVER_ART_BASE}/release/${release.id}/front-250` : null,
      score: Number(release.score) || 0,
      popularity: 0,
      voteCount: 0
    };
  }

  async cacheCover(providerId, url) {
    const filename = `musicbrainz-release-${providerId}-500.webp`;
    const filePath = path.join(this.posterDir, filename);
    try {
      await fs.access(filePath);
      return filename;
    } catch (err) {
      if (err.code !== "ENOENT") {
        throw err;
      }
    }

    const response = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new Error(`Cover Art Archive lookup failed with HTTP ${response.status}`);
    }
    return this.cachedImages.cacheBuffer(Buffer.from(await response.arrayBuffer()), this.posterDir, filename, ".jpg");
  }

  fetchJson(url) {
    const task = this.requestQueue.then(async () => {
      const waitMs = Math.max(0, 1000 - (Date.now() - this.lastRequestAt));
      if (waitMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
      const response = await fetch(url, {
        headers: {
          Accept: "application/json",
          "User-Agent": USER_AGENT
        }
      });
      this.lastRequestAt = Date.now();
      if (!response.ok) {
        throw new Error(`MusicBrainz metadata lookup failed with HTTP ${response.status}`);
      }
      return response.json();
    });
    this.requestQueue = task.catch(() => {});
    return task;
  }
}

function artistCredit(release) {
  return (release["artist-credit"] || []).map((credit) => credit.name || credit.artist && credit.artist.name).filter(Boolean).join("");
}

function releaseScore(release, query) {
  const album = similarity(release.title, query.album) * 100;
  const artist = query.artist && query.artist !== "Unknown Artist"
    ? similarity(artistCredit(release), query.artist) * 80
    : 0;
  const releaseYear = Number.parseInt(String(release.date || "").slice(0, 4), 10) || null;
  const year = query.year && releaseYear ? Math.max(0, 20 - Math.abs(query.year - releaseYear) * 5) : 0;
  return album + artist + year + (Number(release.score) || 0) / 10;
}

function similarity(left, right) {
  const a = normalize(left);
  const b = normalize(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.8;
  const leftWords = new Set(a.split(" "));
  const rightWords = new Set(b.split(" "));
  const common = [...leftWords].filter((word) => rightWords.has(word)).length;
  return common / Math.max(leftWords.size, rightWords.size);
}

function normalize(value) {
  return String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function escapeLucene(value) {
  return String(value || "").replace(/([+\-!(){}\[\]^"~*?:\\/])/g, "\\$1");
}

function isUnknownAlbum(value) {
  return !String(value || "").trim() || /^unknown album$/i.test(String(value).trim());
}

function releaseStatusScore(value) {
  return String(value || "").toLowerCase() === "official" ? 1 : 0;
}

module.exports = { MusicBrainzMetadataProvider };
