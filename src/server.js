const { createApp } = require("./app");
const config = require("./config");
const logger = require("./utils/logger");

logger.configure(config.logging);

let server = null;
let stopping = false;

if (typeof process.send === "function") {
  process.once("disconnect", stopAfterSupervisorDisconnect);
}

createApp()
  .then((app) => {
    server = app.listen(config.port, () => {
      logger.info(`Media Baker listening on http://localhost:${config.port}`);
    });
    server.once("error", (err) => {
      if (err.code === "EADDRINUSE") {
        logger.error(`Port ${config.port} is already in use.`);
      } else {
        logger.error("Media Baker server failed", err);
      }
      process.exit(1);
    });
  })
  .catch((err) => {
    logger.error("Failed to start Media Baker", err);
    process.exit(1);
  });

function stopAfterSupervisorDisconnect() {
  if (stopping) {
    return;
  }
  stopping = true;
  logger.info("Media Baker supervisor disconnected; stopping server child");
  if (!server) {
    process.exit(0);
    return;
  }
  const forcedExit = setTimeout(() => process.exit(0), 5000);
  forcedExit.unref();
  server.close(() => process.exit(0));
}
