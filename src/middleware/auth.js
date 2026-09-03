function createAuthMiddleware(accountService) {
  return async (req, res, next) => {
    const libraryViewToken = extractLibraryViewToken(req);
    if (libraryViewToken && accountService) {
      try {
        const libraryView = await accountService.verifyLibraryViewToken(libraryViewToken);
        if (libraryView) {
          req.authMode = "library-view";
          req.authToken = libraryViewToken;
          req.authParamName = "viewToken";
          req.libraryView = libraryView;
          req.allowedLibraryKeys = libraryView.libraryKeys;
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
          req.progressUserId = user.id;
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
          req.progressUserId = user.id;
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

function createWatchTogetherStreamMiddleware(watchTogether) {
  return (req, res, next) => {
    if (!watchTogether.authorizePlayback(req.playbackTokenPayload)) {
      next(unauthorizedError());
      return;
    }
    next();
  };
}

function createOptionalAuthMiddleware(accountService) {
  const authenticate = createAuthMiddleware(accountService);
  return (req, res, next) => authenticate(req, res, (err) => {
    if (err && err.status === 401) {
      next();
      return;
    }
    next(err);
  });
}

function createApiKeyAuthMiddleware(accountService) {
  return async (req, res, next) => {
    const apiKey = extractApiKey(req);
    if (!apiKey || !accountService) return next(unauthorizedError());
    try {
      const principal = typeof accountService.verifyApiKeyPrincipal === "function"
        ? await accountService.verifyApiKeyPrincipal(apiKey)
        : null;
      const user = principal && principal.user;
      if (!user) return next(unauthorizedError());
      req.apiKeyId = principal.apiKeyId;
      req.authMode = user.permissions.isAdmin ? "admin" : "user";
      req.user = user;
      req.progressUserId = user.id;
      req.authToken = apiKey;
      req.authParamName = "apiKey";
      req.allowedLibraryKeys = user.permissions.isAdmin ? null : user.permissions.libraries;
      next();
    } catch (err) {
      next(err);
    }
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

function extractLibraryViewToken(req) {
  const headerToken = req.get("x-library-view-token");
  if (headerToken) {
    return headerToken;
  }

  if (typeof req.query.viewToken === "string") {
    return req.query.viewToken;
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
  if ((req.authMode === "user" || req.authMode === "admin") && req.authParamName === "authToken" && req.authToken) {
    res.cookie("media_baker_web_session", req.authToken, options);
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
  createOptionalAuthMiddleware,
  createApiKeyAuthMiddleware,
  createStreamAuthMiddleware,
  createWatchTogetherStreamMiddleware,
  establishWebStreamAuthCookie,
  clearWebStreamAuthCookies
};
