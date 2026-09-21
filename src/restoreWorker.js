const config = require("./config");
const { AppSettingsService } = require("./services/appSettingsService");
const { BackupService } = require("./services/backupService");

async function main() {
  const filename = process.argv[2];
  const appSettings = new AppSettingsService(config);
  await appSettings.init();
  await appSettings.applyToConfig();
  const backups = new BackupService(config, appSettings);
  await backups.restore(filename);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(`[restore] ${err.stack || err.message}`);
  process.exit(1);
});
