const crypto = require("crypto");

const TOKEN_VERSION = 1;
const DEFAULT_TTL_SECONDS = 24 * 60 * 60;

class PlaybackTokenService {
  constructor(secret, ttlSeconds = DEFAULT_TTL_SECONDS) {
    this.secret = Buffer.from(secret);
    this.ttlSeconds = ttlSeconds;
  }

  createStreamToken(mediaType, mediaId, userId = null) {
    return this.sign({
      scope: "stream",
      mediaType,
      mediaId,
      userId
    });
  }

  createHlsToken(cacheKey, mediaType = null, mediaId = null, userId = null) {
    return this.sign({
      scope: "hls",
      cacheKey,
      mediaType,
      mediaId,
      userId
    });
  }

  verify(token) {
    const parts = String(token || "").split(".");
    if (parts.length !== 2) {
      return null;
    }

    const [payloadText, signature] = parts;
    const expected = this.signature(payloadText);
    if (!timingSafeTextEqual(signature, expected)) {
      return null;
    }

    let payload;
    try {
      payload = JSON.parse(Buffer.from(payloadText, "base64url").toString("utf8"));
    } catch (err) {
      return null;
    }

    if (payload.v !== TOKEN_VERSION || !payload.exp || payload.exp < unixTime()) {
      return null;
    }

    return payload;
  }

  sign(payload) {
    const body = {
      v: TOKEN_VERSION,
      iat: unixTime(),
      exp: unixTime() + this.ttlSeconds,
      jti: crypto.randomBytes(12).toString("hex"),
      ...payload
    };
    const payloadText = Buffer.from(JSON.stringify(body)).toString("base64url");
    return `${payloadText}.${this.signature(payloadText)}`;
  }

  signature(payloadText) {
    return crypto
      .createHmac("sha256", this.secret)
      .update(payloadText)
      .digest("base64url");
  }
}

function unixTime() {
  return Math.floor(Date.now() / 1000);
}

function timingSafeTextEqual(provided, expected) {
  const providedBuffer = Buffer.from(String(provided || ""));
  const expectedBuffer = Buffer.from(String(expected || ""));
  return providedBuffer.length === expectedBuffer.length
    && crypto.timingSafeEqual(providedBuffer, expectedBuffer);
}

module.exports = { PlaybackTokenService };
