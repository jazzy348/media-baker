const config = require("./config");
const logger = require("./utils/logger");
const { createIndexStore } = require("./services/indexStores");
const { MediaIndex } = require("./services/mediaIndex");
const { FFmpegService } = require("./services/ffmpegService");
const { LibraryService } = require("./services/libraryService");
const { AppSettingsService } = require("./services/appSettingsService");
const { SkipMarkerStore } = require("./services/skipMarkerStore");
const { SkipDetectionService } = require("./services/skipDetectionService");
const { syncYtDlpLibrary } = require("./services/ytdlpService");

logger.configure(config.logging);

let context = null;
let commandChain = Promise.resolve();
let stopping = false;

initialize()
  .then((created) => {
    context = created;
    send({ type: "skip-detection-ready" });
  })
  .catch((err) => {
    logger.error(`[skip-detection] analysis worker initialization failed message="${err.message}"`, err);
    process.exit(1);
  });

process.on("message", (message) => {
  if (!message || message.type !== "skip-detection-request") {
    return;
  }
  commandChain = commandChain
    .then(() => handleCommand(message))
    .catch((err) => {
      logger.error(`[skip-detection] worker command failed command=${message.command} message="${err.message}"`, err);
      respond(message, false, null, err.message);
    });
});

async function initialize() {
  const libraryService = new LibraryService(config);
  const appSettings = new AppSettingsService(config);
  await refreshConfig(libraryService, appSettings);

  const indexStore = createIndexStore(config);
  const mediaIndex = new MediaIndex(config, indexStore);
  await mediaIndex.load();
  const ffmpeg = new FFmpegService(config.ffmpeg);
  await ffmpeg.validate();
  const store = new SkipMarkerStore(config);
  const created = {
    libraryService,
    appSettings,
    mediaIndex,
    ffmpeg,
    store,
    service: null
  };
  created.service = new SkipDetectionService(config, mediaIndex, ffmpeg, store, {
    prepareRun: () => prepareRun(created)
  });
  return created;
}

async function refreshConfig(libraryService, appSettings) {
  config.libraries = await libraryService.list();
  await appSettings.applyToConfig();
  syncYtDlpLibrary(config);
  logger.configure(config.logging);
}

async function prepareRun(created) {
  await refreshConfig(created.libraryService, created.appSettings);
  created.ffmpeg.reloadConfig(config.ffmpeg);
  await created.mediaIndex.load();
}

async function handleCommand(message) {
  if (!context) {
    throw new Error("Skip-detection worker is not ready");
  }
  const payload = message.payload || {};
  let result = null;
  switch (message.command) {
    case "start":
      await refreshConfig(context.libraryService, context.appSettings);
      context.service.start();
      break;
    case "stop":
      context.service.stop();
      break;
    case "restart":
      await refreshConfig(context.libraryService, context.appSettings);
      context.service.restart();
      break;
    case "schedule":
      context.service.schedule(payload.reason || "index-scan");
      break;
    case "getStatus":
      result = await context.service.getStatus();
      break;
    case "getTaskStatus":
      result = context.service.getTaskStatus();
      break;
    case "retryFailures":
      result = await context.service.retryFailures();
      break;
    case "reanalyse":
      result = await context.service.reanalyse(payload);
      break;
    case "markerReviews":
      result = await context.service.markerReviews(payload.limit);
      break;
    default:
      throw new Error(`Unknown skip-detection worker command: ${message.command}`);
  }
  respond(message, true, result);
}

function respond(message, ok, result = null, error = null) {
  if (!message.requestId) {
    return;
  }
  send({
    type: "skip-detection-response",
    requestId: message.requestId,
    ok,
    result,
    error
  });
}

function send(message) {
  if (typeof process.send === "function" && process.connected) {
    process.send(message);
  }
}

function stop() {
  if (stopping) {
    return;
  }
  stopping = true;
  if (context && context.service) {
    context.service.stop();
  }
  process.exit(0);
}

process.once("disconnect", stop);
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
