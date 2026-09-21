const { createApp } = require("./app");
const http = require("http");
const config = require("./config");
const logger = require("./utils/logger");

logger.configure(config.logging);

let server = null;
let application = null;
let stopping = false;

if (typeof process.send === "function") {
  process.once("disconnect", stopAfterSupervisorDisconnect);
}

createApp()
  .then((app) => {
    application = app;
    server = http.createServer(app);
    app.locals.services.watchTogether.attach(server);
    server.listen(config.port, () => {
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

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => stop(`received ${signal}`));
}

function stopAfterSupervisorDisconnect() {
  stop("supervisor disconnected");
}

async function stop(reason) {
  if (stopping) {
    return;
  }
  stopping = true;
  logger.info(`Media Baker ${reason}; stopping server child`);
  const forcedExit = setTimeout(() => process.exit(0), 5000);
  forcedExit.unref();

  const services = application?.locals?.services;
  services?.indexScanScheduler?.stop();
  services?.ytdlp?.shutdown();
  services?.ytdlpRelay?.stop();
  services?.updates?.stop();
  services?.backups?.stop();
  services?.optimizer?.requestStop();
  services?.hls?.shutdown();
  services?.skipDetection?.close();

  try {
    await services?.keyframes?.close();
  } catch (error) {
    logger.error(`[keyframes] shutdown flush failed message="${error.message}"`, error);
  }

  try {
    await services?.watchTogether?.close();
  } catch (error) {
    logger.error(`[watch-together] shutdown failed message="${error.message}"`, error);
  }

  if (!server) {
    process.exit(0);
    return;
  }
  server.close(() => process.exit(0));
}
