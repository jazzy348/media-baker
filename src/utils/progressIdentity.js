const SHARE_PROGRESS_PREFIX = "share:";

function shareProgressUserId(shareId) {
  const id = String(shareId || "").trim();
  return id ? `${SHARE_PROGRESS_PREFIX}${id}` : null;
}

module.exports = { SHARE_PROGRESS_PREFIX, shareProgressUserId };
