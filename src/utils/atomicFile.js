const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

async function atomicWriteFile(filePath, contents, options = {}) {
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`
  );
  await fs.mkdir(directory, { recursive: true });
  try {
    await fs.writeFile(temporaryPath, contents, options);
    await fs.rename(temporaryPath, filePath);
  } catch (err) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw err;
  }
}

async function atomicWriteJson(filePath, value) {
  await atomicWriteFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

module.exports = { atomicWriteFile, atomicWriteJson };
