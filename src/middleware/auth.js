function createAuthMiddleware(accountService, libraryService = null) {
  return async (req, res, next) => {
    const shareToken = extractShareToken(req);
    if (shareToken && libraryService) {
      try {
        const share = await libraryService.verifyShareToken(shareToken);
        if (share) {
          req.authMode = "share";
          req.authToken = shareToken;
          req.authParamName = "shareToken";
          req.authFromCookie = req.authCookieType === "share";
          req.shareToken = shareToken;
          req.allowedLibraryKey = share.library.key;
          req.allowedLibrary = share.library;
          next();
          return;
        }
      } catch (err) {
        next(err);
        return;
      }
    }

    const sessionToken = extractSessionToken(req);
    if (sessionToken && accountService) {
      try {
        const user = await accountService.verifySession(sessionToken);
        if (user) {
          req.authMode = user.permissions.isAdmin ? "admin" : "user";
          req.user = user;
          req.authToken = sessionToken;
          req.authParamName = "authToken";
          req.authFromCookie = req.authCookieType === "session";
          req.allowedLibraryKeys = user.permissions.isAdmin ? null : user.permissions.libraries;
          next();
          return;
        }
      } catch (err) {
        next(err);
        return;
      }
    }

    const apiKey = extractApiKey(req);
    if (apiKey && accountService) {
      try {
        const user = await accountService.verifyApiKey(apiKey);
        if (user) {
          req.authMode = user.permissions.isAdmin ? "admin" : "user";
          req.user = user;
          req.authToken = apiKey;
          req.authParamName = "apiKey";
          req.allowedLibraryKeys = user.permissions.isAdmin ? null : user.permissions.libraries;
          next();
          return;
        }
      } catch (err) {
        next(err);
        return;
      }
    }

    next(unauthorizedError());
  };
}

function createStreamAuthMiddleware(playbackTokens) {
  return (req, res, next) => {
    const provided = extractPlaybackToken(req);
    const payload = provided ? playbackTokens.verify(provided) : null;

    if (!payload) {
      return next(unauthorizedError());
    }

    req.playbackToken = provided;
    req.playbackTokenPayload = payload;
    next();
  };
}

function extractPlaybackToken(req) {
  const headerToken = req.get("x-playback-token");
  if (headerToken) {
    return headerToken;
  }

  if (typeof req.query.playbackToken === "string") {
    return req.query.playbackToken;
  }

  return null;
}

function extractSessionToken(req) {
  const headerToken = req.get("x-session-token");
  if (headerToken) {
    return headerToken;
  }

  const authorization = req.get("authorization");
  if (authorization && authorization.toLowerCase().startsWith("bearer ")) {
    return authorization.slice("bearer ".length).trim();
  }

  if (typeof req.query.authToken === "string") {
    return req.query.authToken;
  }

  const cookieToken = cookieValue(req, "media_baker_web_session");
  if (cookieToken) {
    req.authCookieType = "session";
    return cookieToken;
  }

  return null;
}

function extractApiKey(req) {
  const headerToken = req.get("x-api-key");
  if (headerToken) {
    return headerToken;
  }

  if (typeof req.query.apiKey === "string") {
    return req.query.apiKey;
  }

  return null;
}

function extractShareToken(req) {
  const headerToken = req.get("x-share-token");
  if (headerToken) {
    return headerToken;
  }

  if (typeof req.query.shareToken === "string") {
    return req.query.shareToken;
  }

  const cookieToken = cookieValue(req, "media_baker_web_share");
  if (cookieToken) {
    req.authCookieType = "share";
    return cookieToken;
  }

  return null;
}

function establishWebStreamAuthCookie(req, res) {
  const options = {
    httpOnly: true,
    sameSite: "lax",
    secure: req.secure || req.get("x-forwarded-proto") === "https",
    path: "/api/web-streams"
  };
  if (req.authMode === "share" && req.authToken) {
    res.cookie("media_baker_web_share", req.authToken, options);
    res.clearCookie("media_baker_web_session", options);
    return;
  }
  if ((req.authMode === "user" || req.authMode === "admin") && req.authParamName === "authToken" && req.authToken) {
    res.cookie("media_baker_web_session", req.authToken, options);
    res.clearCookie("media_baker_web_share", options);
  }
}

function clearWebStreamAuthCookies(req, res) {
  const options = {
    httpOnly: true,
    sameSite: "lax",
    secure: req.secure || req.get("x-forwarded-proto") === "https",
    path: "/api/web-streams"
  };
  res.clearCookie("media_baker_web_session", options);
  res.clearCookie("media_baker_web_share", options);
}

function cookieValue(req, name) {
  const cookies = String(req.get("cookie") || "").split(";");
  for (const cookie of cookies) {
    const separator = cookie.indexOf("=");
    if (separator < 0 || cookie.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(cookie.slice(separator + 1).trim());
    } catch (err) {
      return null;
    }
  }
  return null;
}

function unauthorizedError() {
  const err = new Error("Unauthorized");
  err.status = 401;
  return err;
}

module.exports = {
  createAuthMiddleware,
  createStreamAuthMiddleware,
  establishWebStreamAuthCookie,
  clearWebStreamAuthCookies
};
