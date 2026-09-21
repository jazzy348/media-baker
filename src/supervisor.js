const fs = require("fs");
const fsPromises = require("fs/promises");
const path = require("path");
const { fork } = require("child_process");
const { installRelease } = require("./services/updateInstaller");

const sourceAppPath = path.resolve(__dirname, "..");
const installedAppPath = dockerMode() ? "/cache/app/current" : sourceAppPath;
let child = null;
let pendingUpdate = null;
let pendingRestore = null;
let shuttingDown = false;
let childStartedAt = 0;
let consecutiveCrashes = 0;
let restartTimer = null;

const STABLE_UPTIME_MS = 30 * 1000;
const MAX_RESTART_DELAY_MS = 30 * 1000;

startServer();

function startServer() {
  const appPath = selectedAppPath();
  childStartedAt = Date.now();
  child = fork(path.join(appPath, "src", "server.js"), [], {
    cwd: appPath,
    env: process.env,
    stdio: ["inherit", "inherit", "inherit", "ipc"]
  });
  console.log(`[supervisor] started server child pid=${child.pid} app="${appPath}"`);
  child.once("error", failSupervisor);
  child.on("message", handleServerMessage);
  child.on("exit", handleServerExit);
}

function handleServerMessage(message) {
  if (!message) return;
  if (message.type === "restore-backup") {
    try {
      validateRestorePayload(message.payload);
      pendingRestore = message.payload;
      replyToServer({ type: "restore-backup-response", requestId: message.requestId, accepted: true });
    } catch (err) {
      replyToServer({ type: "restore-backup-response", requestId: message.requestId, accepted: false, error: err.message });
    }
    return;
  }
  if (message.type !== "install-update") return;
  try {
    validateUpdatePayload(message.payload);
    pendingUpdate = message.payload;
    replyToServer({ type: "install-update-response", requestId: message.requestId, accepted: true });
  } catch (err) {
    replyToServer({ type: "install-update-response", requestId: message.requestId, accepted: false, error: err.message });
  }
}

function replyToServer(message) {
  if (child && child.connected) {
    child.send(message, (err) => {
      if (err && !shuttingDown) {
        console.error(`[supervisor] IPC response failed message="${err.message}"`);
      }
    });
  }
}

async function handleServerExit(code, signal) {
  child = null;
  if (shuttingDown) {
    process.exit(code || 0);
    return;
  }
  if (pendingRestore) {
    const payload = pendingRestore;
    pendingRestore = null;
    try {
      await runRestore(selectedAppPath(), payload.filename);
    } catch (err) {
      console.error(`[supervisor] backup restore failed message="${err.message}"`);
    }
    startServer();
    return;
  }
  if (!pendingUpdate) {
    const uptimeMs = Math.max(0, Date.now() - childStartedAt);
    consecutiveCrashes = uptimeMs >= STABLE_UPTIME_MS ? 0 : consecutiveCrashes + 1;
    const delayMs = Math.min(1000 * (2 ** Math.max(0, consecutiveCrashes - 1)), MAX_RESTART_DELAY_MS);
    console.error(`[supervisor] Media Baker exited code=${code} signal=${signal || "none"}; restarting in ${delayMs}ms`);
    scheduleServerRestart(delayMs);
    return;
  }

  const payload = pendingUpdate;
  pendingUpdate = null;
  try {
    await installRelease(payload, (message) => appendLog(payload.logPath, message));
  } catch (err) {
    await appendLog(payload.logPath, `Update failed: ${err.stack || err.message}`);
    console.error(`[supervisor] update failed message="${err.message}"`);
  }
  startServer();
}

function runRestore(appPath, filename) {
  return new Promise((resolve, reject) => {
    const worker = fork(path.join(appPath, "src", "restoreWorker.js"), [filename], {
      cwd: appPath,
      env: process.env,
      stdio: ["inherit", "inherit", "inherit", "ipc"]
    });
    worker.once("error", reject);
    worker.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Restore worker exited with code ${code} signal ${signal || "none"}`));
    });
  });
}

function scheduleServerRestart(delayMs) {
  if (shuttingDown || restartTimer) {
    return;
  }
  restartTimer = setTimeout(() => {
    restartTimer = null;
    startServer();
  }, delayMs);
}

function selectedAppPath() {
  if (!dockerMode() || !validAppPath(installedAppPath)) {
    return sourceAppPath;
  }
  return compareVersions(appVersion(installedAppPath), appVersion(sourceAppPath)) > 0
    ? installedAppPath
    : sourceAppPath;
}

function validAppPath(appPath) {
  return fs.existsSync(path.join(appPath, "package.json"))
    && fs.existsSync(path.join(appPath, "src", "server.js"))
    && fs.existsSync(path.join(appPath, "src", "supervisor.js"));
}

function appVersion(appPath) {
  try {
    return JSON.parse(fs.readFileSync(path.join(appPath, "package.json"), "utf8")).version || "0.0.0";
  } catch (err) {
    return "0.0.0";
  }
}

function failSupervisor(err) {
  console.error(`[supervisor] ${err.message}`);
  process.exit(1);
}

function compareVersions(left, right) {
  const parse = (value) => String(value || "0.0.0").replace(/^v/, "").split("-", 1)[0].split(".").map((part) => Number(part) || 0);
  const leftParts = parse(left);
  const rightParts = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if ((leftParts[index] || 0) !== (rightParts[index] || 0)) {
      return (leftParts[index] || 0) > (rightParts[index] || 0) ? 1 : -1;
    }
  }
  return 0;
}

function validateUpdatePayload(payload) {
  if (pendingRestore || pendingUpdate) throw new Error("Another maintenance operation is already pending");
  if (!payload || !payload.version || path.resolve(payload.appPath || "") !== path.resolve(installedAppPath)) {
    throw new Error("Invalid update target");
  }
  const stagingRoot = path.resolve(payload.workPath || "", "staging");
  if (!isWithin(stagingRoot, payload.stagePath)
    || !isWithin(payload.stagePath, payload.releasePath)
    || !isWithin(payload.workPath, payload.logPath)) {
    throw new Error("Invalid update source");
  }
}

function validateRestorePayload(payload) {
  if (!payload || !/^media-baker-\d{8}-\d{6}\.mbbackup\.gz$/.test(String(payload.filename || ""))) {
    throw new Error("Invalid backup restore request");
  }
  if (pendingUpdate || pendingRestore) throw new Error("Another maintenance operation is already pending");
}

function isWithin(rootPath, candidatePath) {
  const relative = path.relative(rootPath, path.resolve(candidatePath || ""));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function appendLog(logPath, message) {
  try {
    await fsPromises.mkdir(path.dirname(logPath), { recursive: true });
    await fsPromises.appendFile(logPath, `${new Date().toISOString()} ${message}\n`);
  } catch (err) {
    console.error(`[supervisor] update log failed message="${err.message}"`);
  }
}

function dockerMode() {
  return process.env.MEDIA_BAKER_DOCKER === "1";
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    shuttingDown = true;
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    if (child) {
      child.kill(signal);
    } else {
      process.exit(0);
    }
  });
}

process.on("exit", () => {
  if (child && !child.killed) {
    child.kill();
  }
});
