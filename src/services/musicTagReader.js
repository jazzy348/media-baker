const path = require("path");

let musicMetadataPromise = null;

class MusicTagReader {
  async read(filePath, options = {}) {
    const { parseFile } = await musicMetadata();
    const metadata = await parseFile(filePath, {
      duration: false,
      skipCovers: options.includeArtwork !== true
    });
    return normalizeTags(metadata.common || {});
  }

  async cover(filePath) {
    const tags = await this.read(filePath, { includeArtwork: true });
    return tags.picture || null;
  }
}

async function musicMetadata() {
  if (!musicMetadataPromise) {
    musicMetadataPromise = import("music-metadata");
  }
  return musicMetadataPromise;
}

function normalizeTags(common) {
  const year = positiveInt(common.year) || positiveInt(String(common.date || "").slice(0, 4));
  const artistIds = textList(common.musicbrainz_artistid);
  const pictures = Array.isArray(common.picture) ? common.picture : [];
  const picture = pictures.find((item) => /front|cover/i.test(String(item.type || ""))) || pictures[0] || null;
  return {
    title: text(common.title),
    artist: text(common.artist),
    artists: textList(common.artists),
    albumArtist: text(common.albumartist),
    album: text(common.album),
    year,
    date: text(common.date),
    disc: positiveInt(common.disk && common.disk.no),
    discTotal: positiveInt(common.disk && common.disk.of),
    track: positiveInt(common.track && common.track.no),
    trackTotal: positiveInt(common.track && common.track.of),
    compilation: common.compilation === true,
    musicBrainzArtistIds: artistIds,
    musicBrainzAlbumArtistId: text(common.musicbrainz_albumartistid) || artistIds[0] || null,
    musicBrainzReleaseId: text(common.musicbrainz_albumid),
    musicBrainzReleaseGroupId: text(common.musicbrainz_releasegroupid),
    musicBrainzRecordingId: text(common.musicbrainz_recordingid),
    musicBrainzTrackId: text(common.musicbrainz_releasetrackid),
    hasEmbeddedArtwork: pictures.length > 0,
    picture: picture && Buffer.isBuffer(picture.data)
      ? { data: picture.data, format: text(picture.format) || "image/jpeg" }
      : null
  };
}

function text(value) {
  const result = String(value || "").trim();
  return result || null;
}

function textList(value) {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return [...new Set(values.map(text).filter(Boolean))];
}

function positiveInt(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function inferredAlbumDirectory(filePath) {
  const directory = path.dirname(filePath);
  return /^(?:cd|disc|disk)\s*0*\d+$/i.test(path.basename(directory).trim())
    ? path.dirname(directory)
    : directory;
}

module.exports = { MusicTagReader, inferredAlbumDirectory };
