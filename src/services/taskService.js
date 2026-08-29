class TaskService {
  constructor(services) {
    this.services = services;
  }

  async snapshot() {
    const [skip, backup] = await Promise.all([
      safeStatus(() => this.services.skipDetection && this.services.skipDetection.getTaskStatus()),
      safeStatus(() => this.services.backups && this.services.backups.taskStatus())
    ]);
    const tasks = [
      ...indexTasks(this.services.indexScanScheduler, this.services.mediaIndex),
      ...metadataTasks(this.services.metadata),
      ...hlsTasks(this.services.hls),
      ...optimiserTasks(this.services.optimizer),
      ...skipDetectionTasks(skip),
      ...backupTasks(backup),
      ...downloadTasks(this.services.ytdlp),
      ...relayTasks(this.services.ytdlpRelay),
      ...liveTvTasks(this.services.iptv),
      ...updateTasks(this.services.updates)
    ].filter(Boolean);

    return {
      generatedAt: new Date().toISOString(),
      summary: taskSummary(tasks),
      types: [...new Set(tasks.map((task) => task.type))].sort(),
      tasks
    };
  }

  async queue(taskId, offset = 0, limit = 50) {
    if (taskId === "metadata:preload" && this.services.metadata) {
      return this.services.metadata.taskQueue("preload", offset, limit);
    }
    if (taskId === "keyframes:backfill" && this.services.hls) {
      return this.services.hls.taskQueue("keyframes", offset, limit);
    }
    if (taskId === "optimiser:run" && this.services.optimizer) {
      return this.services.optimizer.taskQueue(offset, limit);
    }
    const downloadId = String(taskId || "").match(/^yt-dlp:download:(.+)$/);
    if (downloadId && this.services.ytdlp) {
      const download = this.services.ytdlp.status().downloads.find((entry) => entry.id === downloadId[1]);
      return pagedItems(download && download.items || [], offset, limit, downloadQueueItem);
    }
    return { total: 0, offset: 0, items: [] };
  }
}

function indexTasks(indexScanScheduler, mediaIndex) {
  const scheduled = indexScanScheduler && indexScanScheduler.getStatus();
  const direct = mediaIndex && typeof mediaIndex.taskStatus === "function" ? mediaIndex.taskStatus() : null;
  if (!scheduled && !direct) return [];
  const activeLibraries = direct && direct.libraryReindexes || [];
  const pendingLibraries = direct && direct.pendingLibraries || [];
  const scanProgress = direct && direct.libraryProgress && direct.libraryProgress[0] || null;
  const running = Boolean(scheduled && scheduled.running || direct && direct.fullReindex || activeLibraries.length);
  const failed = scheduled && scheduled.lastError;
  return [task({
    id: "index:scan",
    type: "index",
    title: "Library index scan",
    subtitle: activeLibraries.length ? `Re-indexing ${activeLibraries.join(", ")}` : scheduled && scheduled.pendingReason ? `Queued: ${scheduled.pendingReason}` : null,
    state: failed && !running ? "failed" : running ? "running" : pendingLibraries.length || scheduled && scheduled.queued ? "queued" : "idle",
    phase: scanProgress && scanProgress.phase
      || (direct && direct.fullReindex ? "Full library scan" : activeLibraries.length ? "Scanning library" : "Waiting"),
    startedAt: scanProgress && scanProgress.startedAt || scheduled && scheduled.lastStartedAt,
    updatedAt: scanProgress && scanProgress.updatedAt || scheduled && scheduled.lastFinishedAt,
    current: scanProgress && scanProgress.current,
    total: scanProgress && scanProgress.total,
    etaSeconds: scanProgress && scanProgress.etaSeconds,
    detail: scanProgress && scanProgress.detail,
    filePath: scanProgress && scanProgress.filePath,
    error: failed || null,
    queueTotal: pendingLibraries.length
  })];
}

function metadataTasks(metadata) {
  if (!metadata || typeof metadata.taskStatus !== "function") return [];
  const status = metadata.taskStatus();
  const preload = status.preload;
  const result = [];
  if (preload) {
    result.push(task({
      id: "metadata:preload",
      type: "metadata",
      title: "Metadata preload",
      subtitle: preload.current && preload.current.title,
      filePath: preload.current && preload.current.filePath,
      state: preload.running ? "running" : "completed",
      phase: preload.running ? "Fetching and caching metadata" : "Complete",
      startedAt: preload.startedAt,
      updatedAt: preload.finishedAt,
      current: preload.processed,
      total: preload.total,
      queueTotal: Math.max(0, Number(preload.total || 0) - Number(preload.processed || 0)),
      detail: `${preload.fetched || 0} fetched, ${preload.cached || 0} cached, ${preload.failed || 0} failed`
    }));
  }
  const recheck = status.missingRecheck;
  if (recheck && (recheck.running || recheck.last)) {
    const last = recheck.last || {};
    result.push(task({
      id: "metadata:missing-recheck",
      type: "metadata",
      title: "Missing metadata recheck",
      state: recheck.running ? "running" : last.error ? "failed" : "completed",
      phase: recheck.running ? "Checking unmatched media" : "Complete",
      startedAt: last.startedAt,
      updatedAt: last.finishedAt,
      current: last.checked,
      total: last.limit,
      error: last.error || null,
      detail: last.checked != null ? `${last.matched || 0} matched, ${last.stillMissing || 0} still missing` : null
    }));
  }
  return result;
}

function hlsTasks(hls) {
  if (!hls || typeof hls.taskStatus !== "function") return [];
  const status = hls.taskStatus();
  const result = [];
  if (status.keyframes.running || status.keyframes.pending) {
    result.push(task({
      id: "keyframes:backfill",
      type: "keyframes",
      title: "Keyframe discovery",
      subtitle: status.keyframes.current && status.keyframes.current.title,
      filePath: status.keyframes.current && status.keyframes.current.filePath,
      state: status.keyframes.running ? "running" : "queued",
      phase: status.keyframes.running ? "Reading keyframe timeline" : "Waiting",
      current: status.keyframes.processed,
      total: status.keyframes.total,
      queueTotal: status.keyframes.pending
    }));
  }
  for (const transcode of status.transcodes) {
    result.push(task({
      id: `hls:transcode:${transcode.cacheKey}`,
      type: "hls",
      title: "HLS generation",
      subtitle: transcode.inputPath ? basename(transcode.inputPath) : transcode.cacheKey,
      filePath: transcode.inputPath,
      state: transcode.completed ? "completed" : "running",
      phase: transcode.prioritySegment != null ? `Generating around segment ${transcode.prioritySegment}` : "Generating segments",
      startedAt: transcode.startedAt,
      updatedAt: transcode.lastAccessAt,
      detail: transcode.stopReason ? `Stop reason: ${transcode.stopReason}` : null
    }));
  }
  for (const setup of status.setups) {
    if (status.transcodes.some((entry) => entry.cacheKey === setup.cacheKey)) continue;
    result.push(task({ id: `hls:setup:${setup.cacheKey}`, type: "hls", title: "HLS setup", subtitle: setup.cacheKey, state: "starting", phase: "Preparing FFmpeg" }));
  }
  return result;
}

function optimiserTasks(optimizer) {
  if (!optimizer) return [];
  const status = optimizer.status();
  if (!status.running && !status.lastRun && !status.queue.remaining) return [];
  const current = status.current;
  return [task({
    id: "optimiser:run",
    type: "optimiser",
    title: "Media optimiser",
    subtitle: current && current.title || status.queue.libraryTitle,
    filePath: current && current.filePath,
    state: status.running ? "running" : status.lastRun && status.lastRun.status === "failed" ? "failed" : "completed",
    phase: current && current.stageLabel || (status.running ? "Preparing queue" : "Complete"),
    startedAt: current && current.startedAt || status.lastRun && status.lastRun.startedAt,
    updatedAt: status.lastRun && (status.lastRun.finishedAt || status.lastRun.at),
    percent: current && current.percent,
    queueTotal: status.queue.remaining,
    detail: `${status.currentJobs.length} active, ${status.queue.pending} queued, ${status.failures.length} failed`
  })];
}

function skipDetectionTasks(status) {
  if (!status || (!status.running && !status.finishedAt && !status.lastError)) return [];
  return [task({
    id: "skip-detection:analysis",
    type: "skip-detection",
    title: "Intro and credits detection",
    subtitle: status.current && [status.current.libraryTitle, status.current.showTitle, status.current.seasonTitle].filter(Boolean).join(" - "),
    filePath: status.current && status.current.filePath,
    state: status.lastError && !status.running ? "failed" : status.running ? "running" : status.queued ? "queued" : "completed",
    phase: status.phase,
    startedAt: status.startedAt,
    updatedAt: status.finishedAt,
    current: status.completed && status.completed.episodes,
    total: status.totals && status.totals.episodes,
    etaSeconds: status.etaSeconds,
    queueTotal: Math.max(0, Number(status.totals && status.totals.episodes || 0) - Number(status.completed && status.completed.episodes || 0)),
    error: status.lastError,
    detail: `${status.markers && status.markers.intros || 0} intros, ${status.markers && status.markers.credits || 0} credits, ${status.failedEpisodes || 0} failures`
  })];
}

function backupTasks(status) {
  if (!status || (!status.progress && !status.lastResult)) return [];
  const progress = status.progress || {};
  const last = status.lastResult || {};
  const running = status.running || status.restoring;
  return [task({
    id: "backup:database",
    type: "backup",
    title: status.restoring ? "Database restore" : "Database backup",
    subtitle: progress.current || last.filename,
    state: running ? "running" : last.ok === false ? "failed" : "completed",
    phase: progress.phase || "Complete",
    startedAt: progress.startedAt,
    updatedAt: progress.updatedAt || last.createdAt,
    percent: progress.percent,
    current: progress.completedUnits,
    total: progress.totalUnits,
    etaSeconds: progress.etaSeconds,
    error: progress.error || last.error
  })];
}

function downloadTasks(ytdlp) {
  if (!ytdlp) return [];
  const status = ytdlp.status();
  const result = [];
  if (status.updating) result.push(task({ id: "yt-dlp:update", type: "yt-dlp", title: "YT-DLP update", state: "running", phase: "Updating binary" }));
  for (const download of status.downloads || []) {
    result.push(task({
      id: `yt-dlp:download:${download.id}`,
      type: "yt-dlp",
      title: download.title || download.playlistTitle || "Media download",
      subtitle: download.filename,
      filePath: download.outputPath,
      state: download.status === "failed" ? "failed" : download.status === "complete" ? "completed" : "running",
      phase: download.message || download.status,
      startedAt: download.startedAt,
      updatedAt: download.finishedAt,
      percent: download.percent,
      etaSeconds: numeric(download.eta),
      queueTotal: (download.items || []).filter((item) => !["complete", "failed"].includes(item.status)).length,
      error: download.error
    }));
  }
  return result;
}

function relayTasks(relayService) {
  if (!relayService || typeof relayService.taskStatus !== "function") return [];
  return relayService.taskStatus().map((relay) => task({
    id: `yt-dlp:relay:${relay.id}`,
    type: "live-relay",
    title: relay.title || "Live relay",
    state: relay.status === "failed" ? "failed" : relay.status === "ready" ? "running" : "starting",
    phase: relay.status,
    startedAt: relay.startedAt,
    updatedAt: relay.lastAccessAt,
    error: relay.error
  }));
}

function liveTvTasks(iptv) {
  if (!iptv || typeof iptv.taskStatus !== "function") return [];
  const status = iptv.taskStatus();
  const result = [];
  if (status.refreshing) result.push(task({ id: "iptv:refresh", type: "live-tv", title: "Live TV guide refresh", state: "running", phase: "Refreshing channels and EPG" }));
  for (const stream of status.streams) {
    result.push(task({
      id: `iptv:stream:${stream.channelId}`,
      type: "live-tv",
      title: stream.channelName,
      state: stream.exited ? "failed" : stream.starting ? "starting" : "running",
      phase: stream.starting ? "Starting live stream" : "Relaying live stream",
      updatedAt: stream.lastAccessAt
    }));
  }
  return result;
}

function updateTasks(updates) {
  if (!updates || typeof updates.publicStatus !== "function") return [];
  const status = updates.publicStatus();
  const install = status.install;
  if (!install || !install.status || install.status === "idle") return [];
  return [task({
    id: "updates:install",
    type: "updates",
    title: "Media Baker update",
    subtitle: install.version || status.latest && status.latest.version,
    state: install.status === "failed" ? "failed" : install.status === "complete" ? "completed" : "running",
    phase: install.message || install.status,
    startedAt: install.startedAt,
    updatedAt: install.finishedAt,
    percent: install.percent,
    error: install.error
  })];
}

function task(input) {
  const current = numeric(input.current);
  const total = numeric(input.total);
  const percent = numeric(input.percent) != null
    ? clamp(numeric(input.percent), 0, 100)
    : total > 0 && current != null ? clamp((current / total) * 100, 0, 100) : null;
  return {
    id: input.id,
    type: input.type,
    title: input.title,
    subtitle: input.subtitle || null,
    state: input.state || "idle",
    phase: input.phase || null,
    progress: { percent, current, total, etaSeconds: numeric(input.etaSeconds) },
    startedAt: input.startedAt || null,
    updatedAt: input.updatedAt || null,
    filePath: input.filePath || null,
    queue: { total: Math.max(0, Number(input.queueTotal) || 0) },
    detail: input.detail || null,
    error: input.error || null
  };
}

function taskSummary(tasks) {
  const summary = { running: 0, queued: 0, failed: 0, completed: 0, idle: 0, total: tasks.length };
  for (const entry of tasks) {
    if (["running", "starting"].includes(entry.state)) summary.running += 1;
    else if (Object.prototype.hasOwnProperty.call(summary, entry.state)) summary[entry.state] += 1;
  }
  return summary;
}

function pagedItems(items, offset, limit, mapper) {
  const start = Math.max(0, Number.parseInt(offset, 10) || 0);
  const size = Math.max(1, Math.min(Number.parseInt(limit, 10) || 50, 200));
  return { total: items.length, offset: start, items: items.slice(start, start + size).map(mapper) };
}

function downloadQueueItem(item) {
  return { title: item.title || item.id || "Download item", filePath: item.outputPath || null, status: item.status || null };
}

async function safeStatus(getter) {
  try {
    return getter ? await getter() : null;
  } catch (error) {
    return { lastError: error.message };
  }
}

function basename(filePath) {
  return String(filePath || "").split(/[\\/]/).pop();
}

function numeric(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

module.exports = { TaskService };
