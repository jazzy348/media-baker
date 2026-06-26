const os = require("os");
const fs = require("fs");
const { execFileSync } = require("child_process");

class HardwareService {
  constructor() {
    this.previousCpu = cpuTotals();
    this.nvidiaSmiPath = findNvidiaSmiPath();
    this.previousNetwork = null;
    this.history = [];
  }

  sample() {
    const sampledAt = Date.now();
    const currentCpu = cpuTotals();
    const cpu = cpuPercent(this.previousCpu, currentCpu);
    this.previousCpu = currentCpu;

    const totalMemory = os.totalmem();
    const freeMemory = os.freemem();
    const usedMemory = totalMemory - freeMemory;
    const gpu = sampleNvidiaGpu(this.nvidiaSmiPath);
    const network = this.sampleNetwork(sampledAt);
    const sample = {
      at: new Date(sampledAt).toISOString(),
      cpuPercent: cpu,
      memory: {
        total: totalMemory,
        used: usedMemory,
        free: freeMemory,
        percent: totalMemory > 0 ? Math.round((usedMemory / totalMemory) * 1000) / 10 : 0
      },
      gpu,
      network
    };
    this.recordHistory(sample);
    return {
      ...sample,
      history: this.history
    };
  }

  sampleNetwork(sampledAt) {
    const totals = networkTotals();
    if (!totals) {
      return {
        available: false,
        reason: "network usage unavailable",
        rxBytesPerSecond: 0,
        txBytesPerSecond: 0
      };
    }

    const previous = this.previousNetwork;
    this.previousNetwork = {
      ...totals,
      sampledAt
    };
    if (!previous) {
      return {
        available: true,
        rxBytes: totals.rxBytes,
        txBytes: totals.txBytes,
        rxBytesPerSecond: 0,
        txBytesPerSecond: 0
      };
    }

    const seconds = Math.max(0.001, (sampledAt - previous.sampledAt) / 1000);
    return {
      available: true,
      rxBytes: totals.rxBytes,
      txBytes: totals.txBytes,
      rxBytesPerSecond: ratePerSecond(totals.rxBytes, previous.rxBytes, seconds),
      txBytesPerSecond: ratePerSecond(totals.txBytes, previous.txBytes, seconds)
    };
  }

  recordHistory(sample) {
    this.history.push({
      at: sample.at,
      cpuPercent: sample.cpuPercent,
      memoryPercent: sample.memory.percent,
      gpuPercent: sample.gpu.available ? sample.gpu.percent : null,
      networkInBytesPerSecond: sample.network.rxBytesPerSecond || 0,
      networkOutBytesPerSecond: sample.network.txBytesPerSecond || 0
    });
    const cutoff = Date.now() - 5 * 60 * 1000;
    this.history = this.history.filter((entry) => Date.parse(entry.at) >= cutoff);
  }
}

function cpuTotals() {
  return os.cpus().reduce((totals, cpu) => {
    const idle = cpu.times.idle;
    const total = Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
    return {
      idle: totals.idle + idle,
      total: totals.total + total
    };
  }, { idle: 0, total: 0 });
}

function cpuPercent(previous, current) {
  const idleDelta = current.idle - previous.idle;
  const totalDelta = current.total - previous.total;
  if (totalDelta <= 0) {
    return 0;
  }

  return Math.max(0, Math.min(100, Math.round((1 - idleDelta / totalDelta) * 1000) / 10));
}

function sampleNvidiaGpu(nvidiaSmiPath) {
  if (!nvidiaSmiPath) {
    return {
      available: false,
      reason: "nvidia-smi not found"
    };
  }

  try {
    const output = execFileSync(nvidiaSmiPath, [
      "--query-gpu=utilization.gpu,utilization.memory,memory.used,memory.total,temperature.gpu",
      "--format=csv,noheader,nounits"
    ], {
      encoding: "utf8",
      timeout: 2000,
      windowsHide: true
    });
    const [line] = output.trim().split(/\r?\n/);
    const [gpuPercent, memoryPercent, memoryUsedMb, memoryTotalMb, temperatureC] = String(line || "")
      .split(",")
      .map((value) => Number.parseFloat(value.trim()));

    if (!Number.isFinite(gpuPercent)) {
      return {
        available: false,
        reason: "GPU usage unavailable"
      };
    }

    return {
      available: true,
      percent: clampPercent(gpuPercent),
      memoryPercent: clampPercent(memoryPercent),
      memoryUsedMb: Number.isFinite(memoryUsedMb) ? memoryUsedMb : null,
      memoryTotalMb: Number.isFinite(memoryTotalMb) ? memoryTotalMb : null,
      temperatureC: Number.isFinite(temperatureC) ? temperatureC : null
    };
  } catch (err) {
    return {
      available: false,
      reason: "nvidia-smi failed"
    };
  }
}

function findNvidiaSmiPath() {
  const candidates = [
    "nvidia-smi",
    "C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe"
  ];
  return candidates.find((candidate) => candidate === "nvidia-smi" || fs.existsSync(candidate)) || null;
}

function clampPercent(value) {
  return Math.max(0, Math.min(100, Math.round((Number(value) || 0) * 10) / 10));
}

function networkTotals() {
  return os.platform() === "win32" ? windowsNetworkTotals() : procNetworkTotals();
}

function windowsNetworkTotals() {
  try {
    const output = execFileSync("powershell.exe", [
      "-NoProfile",
      "-Command",
      "$s=Get-NetAdapterStatistics; [pscustomobject]@{rx=($s|Measure-Object -Property ReceivedBytes -Sum).Sum;tx=($s|Measure-Object -Property SentBytes -Sum).Sum}|ConvertTo-Json -Compress"
    ], {
      encoding: "utf8",
      timeout: 2000,
      windowsHide: true
    }).trim();
    const parsed = JSON.parse(output);
    const rxBytes = Number(parsed.rx);
    const txBytes = Number(parsed.tx);
    if (!Number.isFinite(rxBytes) || !Number.isFinite(txBytes)) {
      return null;
    }
    return {
      rxBytes,
      txBytes
    };
  } catch (err) {
    return null;
  }
}

function procNetworkTotals() {
  try {
    const text = fs.readFileSync("/proc/net/dev", "utf8");
    return text.split(/\r?\n/).reduce((totals, line) => {
      const match = line.match(/^\s*([^:]+):\s*(.+)$/);
      if (!match) {
        return totals;
      }
      const name = match[1].trim();
      if (name === "lo") {
        return totals;
      }
      const values = match[2].trim().split(/\s+/).map(Number);
      return {
        rxBytes: totals.rxBytes + (values[0] || 0),
        txBytes: totals.txBytes + (values[8] || 0)
      };
    }, { rxBytes: 0, txBytes: 0 });
  } catch (err) {
    return null;
  }
}

function ratePerSecond(current, previous, seconds) {
  const delta = Number(current) - Number(previous);
  if (!Number.isFinite(delta) || delta < 0) {
    return 0;
  }
  return Math.round(delta / seconds);
}

module.exports = { HardwareService };
