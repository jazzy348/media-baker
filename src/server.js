const { createApp } = require("./app");
const config = require("./config");
const logger = require("./utils/logger");

logger.configure(config.logging);

createApp()
  .then((app) => {
    app.listen(config.port, () => {
      logger.info(`Media Baker listening on http://localhost:${config.port}`);
    });
  })
  .catch((err) => {
    logger.error("Failed to start Media Baker", err);
    process.exit(1);
  });
