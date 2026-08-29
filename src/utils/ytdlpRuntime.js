function ytdlpRuntimeArgs() {
  return ["--js-runtimes", `node:${process.execPath}`];
}

module.exports = { ytdlpRuntimeArgs };
