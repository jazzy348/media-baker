const REDACTED_QUERY_KEYS = new Set([
  "secret",
  "sharetoken",
  "authtoken",
  "apikey",
  "playbacksecret",
  "playbacktoken"
]);

function safeRequestUrl(req) {
  const original = String(req && (req.originalUrl || req.url) || "/");
  const queryIndex = original.indexOf("?");
  const rawPath = queryIndex >= 0 ? original.slice(0, queryIndex) : original;
  const rawQuery = queryIndex >= 0 ? original.slice(queryIndex + 1) : "";
  const safePath = sanitizeLogValue(rawPath || "/");
  if (!rawQuery) {
    return safePath;
  }

  try {
    const params = new URLSearchParams(rawQuery);
    for (const key of [...params.keys()]) {
      if (REDACTED_QUERY_KEYS.has(key.toLowerCase())) {
        params.set(key, "[redacted]");
      }
    }
    const query = params.toString();
    return query ? `${safePath}?${query}` : safePath;
  } catch (err) {
    return `${safePath}?${sanitizeLogValue(rawQuery)}`;
  }
}

function sanitizeLogValue(value) {
  return String(value || "")
    .replace(/[\r\n\t]/g, " ")
    .slice(0, 4096);
}

module.exports = { safeRequestUrl };
