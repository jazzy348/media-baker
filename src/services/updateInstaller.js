const fs = require("fs/promises");
const path = require("path");

const PROTECTED_ENTRIES = new Set([
  ".agents",
  ".codex",
  ".git",
  "bin",
  "cache",
  "config.json",
  "downloads",
  "fallback",
  "logs",
  "media"
]);

async function installRelease(payload, appendLog) {
  const backupPath = path.join(payload.workPath, "backups", `${Date.now()}-${payload.version}`);
  await fs.mkdir(payload.appPath, { recursive: true });
  await fs.mkdir(backupPath, { recursive: true });
  const currentEntries = await managedEntries(payload.appPath);
  const releaseEntries = await managedEntries(payload.releasePath);
  await appendLog(`Backing up ${currentEntries.length} application entries to ${backupPath}`);

  for (const entry of currentEntries) {
    await fs.cp(path.join(payload.appPath, entry), path.join(backupPath, entry), { recursive: true, force: true });
  }

  try {
    for (const entry of currentEntries) {
      await fs.rm(path.join(payload.appPath, entry), { recursive: true, force: true });
    }
    for (const entry of releaseEntries) {
      await fs.cp(path.join(payload.releasePath, entry), path.join(payload.appPath, entry), { recursive: true, force: true });
    }
    await restoreUserIcons(payload.appPath, payload.releasePath, backupPath);
  } catch (err) {
    await appendLog(`Replacement failed; restoring ${backupPath}`);
    await restoreBackup(payload.appPath, backupPath);
    throw err;
  }

  await fs.rm(payload.stagePath, { recursive: true, force: true });
  await appendLog(`Installed Media Baker ${payload.version}`);
}

async function restoreUserIcons(appPath, releasePath, backupPath) {
  const previousIcons = path.join(backupPath, "public", "icons");
  const releaseIcons = path.join(releasePath, "public", "icons");
  const installedIcons = path.join(appPath, "public", "icons");
  for (const relativePath of await filesBelow(previousIcons)) {
    if (await exists(path.join(releaseIcons, relativePath))) continue;
    const destination = path.join(installedIcons, relativePath);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(path.join(previousIcons, relativePath), destination);
  }
}

async function filesBelow(rootPath) {
  const files = [];
  const visit = async (currentPath) => {
    const entries = await fs.readdir(currentPath, { withFileTypes: true }).catch((err) => {
      if (err.code === "ENOENT") return [];
      throw err;
    });
    for (const entry of entries) {
      const entryPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) await visit(entryPath);
      else if (entry.isFile()) files.push(path.relative(rootPath, entryPath));
    }
  };
  await visit(rootPath);
  return files;
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (err) {
    if (err.code === "ENOENT") return false;
    throw err;
  }
}

async function managedEntries(rootPath) {
  const entries = await fs.readdir(rootPath, { withFileTypes: true });
  return entries
    .map((entry) => entry.name)
    .filter((name) => !PROTECTED_ENTRIES.has(name));
}

async function restoreBackup(appPath, backupPath) {
  const currentEntries = await managedEntries(appPath);
  for (const entry of currentEntries) {
    await fs.rm(path.join(appPath, entry), { recursive: true, force: true });
  }
  for (const entry of await managedEntries(backupPath)) {
    await fs.cp(path.join(backupPath, entry), path.join(appPath, entry), { recursive: true, force: true });
  }
}

module.exports = { installRelease };
