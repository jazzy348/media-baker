const express = require("express");

module.exports = function createAppInfoRoutes(options) {
  const router = express.Router();
  const version = String(options.version);
  const revision = String(options.revision || options.version);

  router.get("/version", (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({ version, revision });
  });

  return router;
};
