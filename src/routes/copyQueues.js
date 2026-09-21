const express = require("express");
const { createAuthMiddleware } = require("../middleware/auth");
const { isClientAbort } = require("../utils/httpErrors");

module.exports = function createCopyQueueRoutes({ accountService, copyQueues }) {
  const router = express.Router();
  const authenticate = createAuthMiddleware(accountService);

  router.get("/stream/:token/master.m3u8", async (req, res, next) => {
    try {
      const playlist = await copyQueues.playlist(req.params.token);
      res.set("Cache-Control", "no-store");
      res.type("application/vnd.apple.mpegurl");
      res.send(playlist);
    } catch (err) {
      next(err);
    }
  });

  router.get("/stream/:token/segments/:sequence.ts", async (req, res, next) => {
    let release = () => {};
    try {
      const result = await copyQueues.segment(req.params.token, req.params.sequence);
      release = once(result.release);
      res.set("Cache-Control", "private, max-age=86400, immutable");
      res.type("video/mp2t");
      res.once("close", release);
      res.sendFile(result.filePath, (err) => {
        release();
        if (err) {
          if (!isClientAbort(err)) next(err);
          return;
        }
        copyQueues.recordDelivery(result.queue, result.entry);
      });
    } catch (err) {
      release();
      next(err);
    }
  });

  router.use(authenticate);

  router.get("/", (req, res, next) => {
    try {
      res.json({ queues: copyQueues.list(req.user) });
    } catch (err) {
      next(err);
    }
  });

  router.post("/", async (req, res, next) => {
    try {
      const created = await copyQueues.create(req.user, req.body || {});
      res.status(201).json({
        queue: created.queue,
        playbackUrl: `${requestOrigin(req)}/api/copy-queues/stream/${encodeURIComponent(created.token)}/master.m3u8`
      });
    } catch (err) {
      next(err);
    }
  });

  router.post("/:queueId/items", async (req, res, next) => {
    try {
      res.status(201).json({ queue: await copyQueues.add(req.user, req.params.queueId, req.body || {}) });
    } catch (err) {
      next(err);
    }
  });

  router.put("/:queueId/order", async (req, res, next) => {
    try {
      res.json({ queue: await copyQueues.reorder(req.user, req.params.queueId, req.body && req.body.itemIds) });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/:queueId/items/:itemId", async (req, res, next) => {
    try {
      res.json({ queue: await copyQueues.removeItem(req.user, req.params.queueId, req.params.itemId) });
    } catch (err) {
      next(err);
    }
  });

  router.post("/:queueId/skip", async (req, res, next) => {
    try {
      res.json({ queue: await copyQueues.skip(req.user, req.params.queueId) });
    } catch (err) {
      next(err);
    }
  });

  router.post("/:queueId/play", async (req, res, next) => {
    try {
      res.json({ queue: await copyQueues.play(req.user, req.params.queueId) });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/:queueId", async (req, res, next) => {
    try {
      await copyQueues.revoke(req.user, req.params.queueId);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  return router;
};

function requestOrigin(req) {
  const protocol = req.get("x-forwarded-proto") || req.protocol;
  return `${protocol}://${req.get("host")}`;
}

function once(callback) {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    callback();
  };
}
