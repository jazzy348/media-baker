const crypto = require("crypto");
const { resolveMediaFile } = require("./mediaResolver");
const { httpError } = require("../utils/httpErrors");

const MAX_QUEUE_ITEMS = 1000;

async function createMediaQueueItem({ mediaIndex, skipDetection, actor, mediaType, mediaId, streamOptions = {} }) {
  const library = mediaIndex.libraryForKey(mediaType);
  if (!library || library.type === "images") throw httpError(400, "This media cannot be queued");
  assertLibraryAccess(actor, mediaType);
  const mediaFile = await resolveMediaFile(mediaIndex, mediaType, mediaId);
  const markers = library.type === "tv" && skipDetection
    ? await skipDetection.getMarkers(mediaType, mediaFile)
    : [];
  const credits = markers.find((marker) => marker.type === "credits");
  return {
    id: crypto.randomBytes(10).toString("hex"),
    mediaType,
    mediaId: mediaFile.id,
    libraryTitle: library.title,
    title: mediaFile.title || mediaFile.episodeName || mediaFile.filename,
    durationSeconds: Number(mediaFile.durationSeconds || mediaFile.duration) || 0,
    streamOptions: normalizeStreamOptions(streamOptions),
    skipMarkers: markers,
    completionStartSeconds: credits && Number(credits.startSeconds) || null,
    addedByUserId: actor.id,
    addedByName: actor.username || actor.name || "User",
    addedAt: new Date().toISOString()
  };
}

function assertLibraryAccess(actor, mediaType) {
  const permissions = actor && actor.permissions || {};
  if (!actor) throw httpError(401, "Authentication required");
  if (permissions.isAdmin || actor.isAdmin) return;
  const libraries = Array.isArray(permissions.libraries)
    ? permissions.libraries
    : Array.isArray(actor.allowedLibraryKeys) ? actor.allowedLibraryKeys : [];
  if (!libraries.includes(mediaType)) throw httpError(403, "Library access denied");
}

function normalizeStreamOptions(options) {
  return {
    audio: String(options.audio || ""),
    subtitle: String(options.subtitle || "none"),
    audioChannels: ["preserve", "stereo", "surround51", "stabby51"].includes(options.audioChannels)
      ? options.audioChannels
      : "preserve",
    quality: String(options.quality || "original")
  };
}

function publicQueueItem(item, position, currentIndex) {
  return {
    id: item.id,
    mediaType: item.mediaType,
    mediaId: item.mediaId,
    libraryTitle: item.libraryTitle,
    title: item.title,
    durationSeconds: item.durationSeconds,
    skipMarkers: item.skipMarkers || [],
    addedByName: item.addedByName,
    addedAt: item.addedAt,
    position,
    status: position < currentIndex ? "played" : position === currentIndex ? "current" : "queued"
  };
}

module.exports = {
  MAX_QUEUE_ITEMS,
  createMediaQueueItem,
  normalizeStreamOptions,
  publicQueueItem,
  assertLibraryAccess
};
