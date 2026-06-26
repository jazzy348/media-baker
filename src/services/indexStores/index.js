const { JsonIndexStore } = require("./jsonIndexStore");
const { MysqlIndexStore } = require("./mysqlIndexStore");

function createIndexStore(config) {
  if (config.mysql.enabled) {
    return new MysqlIndexStore(config);
  }

  return new JsonIndexStore(config.indexPath);
}

module.exports = { createIndexStore };
