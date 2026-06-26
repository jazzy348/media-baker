function normalizeQualityPreference(value) {
  const selected = String(value || "original").toLowerCase();
  if (["medium", "med", "1080p", "720p-mid"].includes(selected)) {
    return "medium";
  }
  if (["low", "480p", "720p-low"].includes(selected)) {
    return "low";
  }

  return "original";
}

function qualityProfileForProbe(probe, preference) {
  const quality = normalizeQualityPreference(preference);
  const videoStream = selectVideoStream(probe);
  const sourceHeight = Number.parseInt(videoStream && videoStream.height, 10) || null;
  const sourceBitrate = videoBitrate(probe, videoStream);
  const target = qualityTarget(sourceHeight, quality);

  return {
    id: quality,
    label: qualityLabel(quality, sourceHeight, target.height, target.bitrateFactor, sourceBitrate),
    sourceHeight,
    targetHeight: target.height,
    targetBitrate: target.bitrateFactor ? Math.max(250000, Math.round(sourceBitrate * target.bitrateFactor)) : null,
    bitrateFactor: target.bitrateFactor,
    forceTranscode: quality !== "original"
  };
}

function qualityOptionsForProbe(probe) {
  return ["original", "medium", "low"].map((quality) => {
    const profile = qualityProfileForProbe(probe, quality);
    return {
      id: profile.id,
      label: profile.label,
      height: profile.targetHeight,
      bitrate: profile.targetBitrate,
      sourceHeight: profile.sourceHeight
    };
  });
}

function qualityTarget(sourceHeight, quality) {
  if (quality === "original") {
    return {
      height: null,
      bitrateFactor: null
    };
  }

  if (!sourceHeight) {
    return {
      height: quality === "medium" ? 1080 : 720,
      bitrateFactor: quality === "medium" ? 0.5 : 0.25
    };
  }

  if (sourceHeight > 1080) {
    return {
      height: quality === "medium" ? 1080 : 720,
      bitrateFactor: quality === "medium" ? 0.5 : 0.25
    };
  }

  return {
    height: Math.min(sourceHeight, quality === "medium" ? 720 : 480),
    bitrateFactor: quality === "medium" ? 0.5 : 0.25
  };
}

function qualityLabel(quality, sourceHeight, targetHeight, bitrateFactor, sourceBitrate) {
  if (quality === "original") {
    const details = [
      sourceHeight ? heightLabel(sourceHeight) : null,
      sourceBitrate ? `~${formatBitrate(sourceBitrate)}` : null
    ].filter(Boolean);
    return details.length ? `Original (${details.join(", ")})` : "Original";
  }

  const name = quality === "medium" ? "Medium" : "Low";
  const details = [
    targetHeight ? heightLabel(targetHeight) : null,
    bitrateFactor ? `${Math.round(bitrateFactor * 100)}% bitrate` : null,
    sourceBitrate ? `~${formatBitrate(Math.round(sourceBitrate * bitrateFactor))}` : null
  ].filter(Boolean);

  return details.length ? `${name} (${details.join(", ")})` : name;
}

function heightLabel(height) {
  return `${height}p`;
}

function formatBitrate(bitsPerSecond) {
  if (!bitsPerSecond || bitsPerSecond <= 0) {
    return null;
  }

  if (bitsPerSecond >= 1000000) {
    const mbps = bitsPerSecond / 1000000;
    return `${mbps >= 10 ? Math.round(mbps) : mbps.toFixed(1)} Mbps`;
  }

  return `${Math.max(1, Math.round(bitsPerSecond / 1000))} Kbps`;
}

function videoBitrate(probe, videoStream) {
  const candidates = [
    videoStream && videoStream.bit_rate,
    videoStream && videoStream.tags && videoStream.tags.BPS,
    videoStream && videoStream.tags && videoStream.tags.NUMBER_OF_BYTES && videoStream.tags.DURATION
      ? bitrateFromBytesAndDuration(videoStream.tags.NUMBER_OF_BYTES, videoStream.tags.DURATION)
      : null,
    probe && probe.format && probe.format.bit_rate
  ];

  for (const candidate of candidates) {
    const parsed = Number.parseInt(candidate, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return fallbackBitrate(videoStream);
}

function bitrateFromBytesAndDuration(bytes, duration) {
  const parsedBytes = Number.parseInt(bytes, 10);
  const seconds = durationSeconds(duration);
  if (!Number.isFinite(parsedBytes) || parsedBytes <= 0 || !seconds) {
    return null;
  }

  return Math.round(parsedBytes * 8 / seconds);
}

function durationSeconds(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  const text = String(value || "");
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const direct = Number.parseFloat(text);
    if (Number.isFinite(direct) && direct > 0) {
      return direct;
    }
  }

  const match = text.match(/^(\d+):(\d+):(\d+(?:\.\d+)?)$/);
  if (!match) {
    return null;
  }

  return Number.parseInt(match[1], 10) * 3600
    + Number.parseInt(match[2], 10) * 60
    + Number.parseFloat(match[3]);
}

function fallbackBitrate(videoStream) {
  const height = Number.parseInt(videoStream && videoStream.height, 10) || 1080;
  if (height > 1080) {
    return 24000000;
  }
  if (height >= 1080) {
    return 8000000;
  }
  if (height >= 720) {
    return 5000000;
  }
  return 2500000;
}

function selectVideoStream(probe) {
  return probe && Array.isArray(probe.streams)
    ? probe.streams.find((stream) => stream.codec_type === "video")
    : null;
}

module.exports = {
  normalizeQualityPreference,
  qualityOptionsForProbe,
  qualityProfileForProbe
};
