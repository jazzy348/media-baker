const DEINTERLACE_MODES = new Set(["off", "auto", "force", "smooth"]);

function normalizeDeinterlaceMode(value, fallback = "auto") {
  const mode = String(value || "").trim().toLowerCase();
  return DEINTERLACE_MODES.has(mode) ? mode : fallback;
}

function normalizeDeinterlaceModeMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(Object.entries(value)
    .map(([channelId, mode]) => [String(channelId).trim(), normalizeDeinterlaceMode(mode, "")])
    .filter(([channelId, mode]) => channelId && mode));
}

function effectiveDeinterlaceMode(config, channelId) {
  const overrides = config.channelDeinterlaceModes || {};
  return overrides[channelId] || normalizeDeinterlaceMode(config.deinterlaceMode, "auto");
}

module.exports = {
  DEINTERLACE_MODES,
  effectiveDeinterlaceMode,
  normalizeDeinterlaceMode,
  normalizeDeinterlaceModeMap
};
