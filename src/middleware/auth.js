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

  return null;
}

function unauthorizedError() {
  const err = new Error("Unauthorized");
  err.status = 401;
  return err;
}

module.exports = { createAuthMiddleware, createStreamAuthMiddleware };
