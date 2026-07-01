const fs = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");
const { installRelease } = require("./updateInstaller");

main().catch(async (err) => {
  await appendLog(`Update failed: ${err.stack || err.message}`);
  process.exitCode = 1;
});

async function main() {
  const payload = readPayload(process.argv[2]);
  global.updateLogPath = payload.logPath;
  await appendLog(`Waiting for Media Baker process ${payload.parentPid} to stop`);
  await waitForProcessExit(payload.parentPid, 60_000);

  await installRelease(payload, appendLog);
  await appendLog("Starting Media Baker server");
  const child = spawn(process.execPath, [path.join(payload.appPath, "src", "server.js")], {
    cwd: payload.appPath,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
}

function readPayload(value) {
  const payload = JSON.parse(Buffer.from(String(value || ""), "base64url").toString("utf8"));
  for (const key of ["appPath", "releasePath", "stagePath", "workPath", "logPath", "version", "parentPid"]) {
    if (!payload[key]) {
      throw new Error(`Missing update payload field: ${key}`);
    }
  }
  return payload;
}

async function waitForProcessExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(pid)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Media Baker process ${pid} did not stop within ${timeoutMs / 1000} seconds`);
}

function processExists(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

async function appendLog(message) {
  if (!global.updateLogPath) {
    return;
  }
  await fs.mkdir(path.dirname(global.updateLogPath), { recursive: true });
  await fs.appendFile(global.updateLogPath, `${new Date().toISOString()} ${message}\n`);
}
