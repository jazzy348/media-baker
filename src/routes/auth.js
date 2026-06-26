const express = require("express");

module.exports = function createAuthRoutes({ accountService }) {
  const router = express.Router();

  router.get("/status", async (req, res, next) => {
    try {
      res.json({ needsSetup: await accountService.needsSetup() });
    } catch (err) {
      next(err);
    }
  });

  router.post("/setup", async (req, res, next) => {
    try {
      const user = await accountService.setupAdmin(req.body || {});
      const session = await accountService.authenticate(req.body.username, req.body.password);
      res.status(201).json({ user, token: session.token });
    } catch (err) {
      next(err);
    }
  });

  router.post("/login", async (req, res, next) => {
    try {
      res.json(await accountService.authenticate(req.body && req.body.username, req.body && req.body.password));
    } catch (err) {
      next(err);
    }
  });

  router.get("/me", async (req, res, next) => {
    try {
      const token = extractSessionToken(req);
      const user = token ? await accountService.verifySession(token) : null;
      res.json({ user, authMode: user && user.permissions.isAdmin ? "admin" : user ? "user" : null });
    } catch (err) {
      next(err);
    }
  });

  return router;
};

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
