const fs = require("fs/promises");
const path = require("path");
const logger = require("../../utils/logger");

class JsonIndexStore {
  constructor(indexPath) {
    this.indexPath = indexPath;
    this.type = "json";
  }

  async load() {
    try {
      const raw = await fs.readFile(this.indexPath, "utf8");
      logger.info(`[index] loaded JSON index="${this.indexPath}"`);
      return JSON.parse(raw);
    } catch (err) {
      if (err.code === "ENOENT") {
        logger.info(`[index] JSON index missing; will reindex path="${this.indexPath}"`);
        return null;
      }

      throw err;
    }
  }

  async save(index) {
    await fs.mkdir(path.dirname(this.indexPath), { recursive: true });
    await fs.writeFile(this.indexPath, JSON.stringify(index, null, 2));
    logger.info(`[index] saved JSON index="${this.indexPath}"`);
  }
}

module.exports = { JsonIndexStore };
