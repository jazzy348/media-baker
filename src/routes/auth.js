const express = require("express");
const { httpError } = require("../utils/httpErrors");
const { clearWebStreamAuthCookies } = require("../middleware/auth");

module.exports = function createAuthRoutes({ accountService, config }) {
  const router = express.Router();

  router.get("/status", async (req, res, next) => {
    try {
      res.json({
        needsSetup: await accountService.needsSetup(),
        features: publicFeatures(config)
      });
    } catch (err) {
      next(err);
    }
  });

  router.post("/setup", async (req, res, next) => {
    try {
      const user = await accountService.setupAdmin(req.body || {});
      const session = await accountService.authenticate(req.body.username, req.body.password);
      res.status(201).json({ user, token: session.token, features: publicFeatures(config) });
    } catch (err) {
      next(err);
    }
  });

  router.post("/login", async (req, res, next) => {
    try {
      const session = await accountService.authenticate(req.body && req.body.username, req.body && req.body.password);
      res.json({ ...session, features: publicFeatures(config) });
    } catch (err) {
      next(err);
    }
  });

  router.get("/me", async (req, res, next) => {
    try {
      const token = extractSessionToken(req);
      const user = token ? await accountService.verifySession(token) : null;
      res.json({
        user,
        authMode: user && user.permissions.isAdmin ? "admin" : user ? "user" : null,
        features: publicFeatures(config)
      });
    } catch (err) {
      next(err);
    }
  });

  router.put("/me", async (req, res, next) => {
    try {
      const token = extractSessionToken(req);
      const user = token ? await accountService.verifySession(token) : null;
      if (!user) {
        next(httpError(401, "Unauthorized"));
        return;
      }

      const body = req.body || {};
      if (!await accountService.verifyAccountPassword(user.id, body.currentPassword)) {
        next(httpError(401, "Current password is incorrect"));
        return;
      }

      const updated = await accountService.update(user.id, {
        username: body.username === undefined ? user.username : body.username,
        password: body.password || undefined
      });
      res.json({ user: updated });
    } catch (err) {
      next(err);
    }
  });

  router.post("/logout", (req, res) => {
    clearWebStreamAuthCookies(req, res);
    res.json({ ok: true });
  });

  return router;
};

function publicFeatures(config) {
  return {
    iptv: Boolean(config.iptv && config.iptv.enabled),
    ytdlp: Boolean(config.ytdlp && config.ytdlp.enabled)
  };
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
