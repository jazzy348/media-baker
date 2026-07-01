const fs = require("fs");
const fsPromises = require("fs/promises");
const path = require("path");
const { fork } = require("child_process");
const { installRelease } = require("./services/updateInstaller");

const imageAppPath = path.resolve(__dirname, "..");
const installedAppPath = "/cache/app/current";
let child = null;
let pendingUpdate = null;
let shuttingDown = false;

startServer();

function startServer() {
  const appPath = selectedAppPath();
  child = fork(path.join(appPath, "src", "server.js"), [], {
    cwd: appPath,
    env: process.env,
    stdio: ["inherit", "inherit", "inherit", "ipc"]
  });
  child.on("message", (message) => {
    if (!message || message.type !== "install-update") {
      return;
    }
    validateUpdatePayload(message.payload);
    pendingUpdate = message.payload;
  });
  child.on("exit", handleServerExit);
}

function selectedAppPath() {
  if (!validAppPath(installedAppPath)) {
    return imageAppPath;
  }
  const installedVersion = appVersion(installedAppPath);
  const imageVersion = appVersion(imageAppPath);
  return compareVersions(installedVersion, imageVersion) > 0 ? installedAppPath : imageAppPath;
}

async function handleServerExit(code, signal) {
  child = null;
  if (shuttingDown) {
    process.exit(code || 0);
    return;
  }
  if (!pendingUpdate) {
    console.error(`[updates] Media Baker exited code=${code} signal=${signal || "none"}`);
    process.exit(code || 1);
    return;
  }

  const payload = pendingUpdate;
  pendingUpdate = null;
  try {
    await installRelease(payload, (message) => appendLog(payload.logPath, message));
    startServer();
  } catch (err) {
    await appendLog(payload.logPath, `Docker update failed: ${err.stack || err.message}`);
    console.error(`[updates] Docker update failed message="${err.message}"`);
    startServer();
  }
}

function validAppPath(appPath) {
  return fs.existsSync(path.join(appPath, "package.json"))
    && fs.existsSync(path.join(appPath, "src", "server.js"));
}

function appVersion(appPath) {
  try {
    return JSON.parse(fs.readFileSync(path.join(appPath, "package.json"), "utf8")).version || "0.0.0";
  } catch (err) {
    return "0.0.0";
  }
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
  if (!payload || path.resolve(payload.appPath || "") !== path.resolve(installedAppPath)) {
    throw new Error("Invalid Docker update target");
  }
  const stagingRoot = path.resolve("/cache/updates/staging");
  if (!path.resolve(payload.releasePath || "").startsWith(`${stagingRoot}${path.sep}`)) {
    throw new Error("Invalid Docker update source");
  }
}

async function appendLog(logPath, message) {
  await fsPromises.mkdir(path.dirname(logPath), { recursive: true });
  await fsPromises.appendFile(logPath, `${new Date().toISOString()} ${message}\n`);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    shuttingDown = true;
    if (child) {
      child.kill(signal);
    } else {
      process.exit(0);
    }
  });
}
