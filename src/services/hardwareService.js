const os = require("os");
const fs = require("fs");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

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
    const gpu = sampleGpu(this.nvidiaSmiPath);
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

function sampleGpu(nvidiaSmiPath) {
  if (os.platform() === "win32") {
    return sampleWindowsGpu(nvidiaSmiPath);
  }
  if (os.platform() === "linux") {
    return sampleLinuxGpu(nvidiaSmiPath);
  }
  if (os.platform() === "darwin") {
    return sampleMacGpu();
  }
  return unavailableGpu(null, null, "GPU usage is unsupported on this operating system");
}

function sampleWindowsGpu(nvidiaSmiPath) {
  const nvidia = sampleNvidiaGpu(nvidiaSmiPath);
  if (nvidia.available) {
    return nvidia;
  }

  const script = [
    "$ErrorActionPreference='Stop'",
    "$controllers=@(Get-CimInstance Win32_VideoController | Where-Object { $_.Name -notmatch 'Microsoft Basic|Remote Display|Hyper-V Video' } | ForEach-Object { [pscustomobject]@{name=$_.Name;vendor=$_.AdapterCompatibility} })",
    "$engines=@(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine)",
    "$samples=@($engines | Where-Object { $_.Name -match 'engtype_(3D|Compute|VideoEncode|VideoDecode|Copy)' } | ForEach-Object { [double]$_.UtilizationPercentage })",
    "$percent=if($samples.Count){($samples | Measure-Object -Maximum).Maximum}else{$null}",
    "[pscustomobject]@{percent=$percent;controllers=$controllers}|ConvertTo-Json -Compress -Depth 4"
  ].join("; ");

  try {
    const parsed = JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      timeout: 3000,
      windowsHide: true
    }).trim());
    const controllers = arrayValue(parsed.controllers);
    const device = preferredGpuDevice(controllers.map((entry) => ({
      vendor: normalizeGpuVendor(entry.vendor || entry.name),
      name: String(entry.name || "").trim()
    })));
    if (!device) {
      return unavailableGpu(null, null, "No supported GPU was detected");
    }
    const percent = parsed.percent === null || parsed.percent === undefined ? null : Number(parsed.percent);
    if (Number.isFinite(percent)) {
      return availableGpu(percent, device);
    }
    return unavailableGpu(device && device.vendor, device && device.name, "GPU performance counters are unavailable");
  } catch (err) {
    return unavailableGpu(null, null, "GPU performance counters are unavailable");
  }
}

function sampleLinuxGpu(nvidiaSmiPath) {
  const nvidia = sampleNvidiaGpu(nvidiaSmiPath);
  if (nvidia.available) {
    return nvidia;
  }

  const devices = linuxDrmDevices();
  const intelDevice = devices.find((device) => device.vendor === "intel" && !Number.isFinite(device.percent));
  if (intelDevice) {
    intelDevice.percent = sampleIntelGpuTop();
  }
  const samples = devices.filter((device) => Number.isFinite(device.percent));
  if (samples.length > 0) {
    const busiest = samples.reduce((selected, device) => device.percent > selected.percent ? device : selected);
    const result = availableGpu(busiest.percent, busiest);
    if (Number.isFinite(busiest.memoryUsedMb)) result.memoryUsedMb = busiest.memoryUsedMb;
    if (Number.isFinite(busiest.memoryTotalMb)) result.memoryTotalMb = busiest.memoryTotalMb;
    if (Number.isFinite(busiest.memoryPercent)) result.memoryPercent = clampPercent(busiest.memoryPercent);
    if (Number.isFinite(busiest.temperatureC)) result.temperatureC = busiest.temperatureC;
    return result;
  }

  const device = preferredGpuDevice(devices);
  if (device) {
    return unavailableGpu(device.vendor, device.name, `${gpuLabel(device)} usage is unavailable`);
  }
  return unavailableGpu(null, null, "No supported GPU was detected");
}

function sampleIntelGpuTop() {
  const result = spawnSync("intel_gpu_top", ["-J", "-s", "250", "-o", "-"], {
    encoding: "utf8",
    timeout: 1200,
    killSignal: "SIGINT",
    windowsHide: true
  });
  const values = [...String(result.stdout || "").matchAll(/["']busy["']\s*:\s*(-?\d+(?:\.\d+)?)/gi)]
    .map((match) => Number(match[1]))
    .filter(Number.isFinite);
  return values.length > 0 ? Math.max(...values) : null;
}

function sampleMacGpu() {
  const outputs = [];
  for (const className of ["AGXAccelerator", "IOAccelerator"]) {
    try {
      outputs.push(execFileSync("ioreg", ["-r", "-d", "1", "-w", "0", "-c", className], {
        encoding: "utf8",
        timeout: 2000,
        windowsHide: true
      }));
    } catch (err) {
      // Some Macs expose only one of these accelerator classes.
    }
  }
  const text = outputs.join("\n");
  const values = [...text.matchAll(/["']Device Utilization %["']\s*=\s*(\d+(?:\.\d+)?)/gi)]
    .map((match) => Number(match[1]))
    .filter(Number.isFinite);
  if (values.length > 0) {
    return availableGpu(Math.max(...values), { vendor: "apple", name: "Apple GPU" });
  }
  return unavailableGpu("apple", "Apple GPU", "Apple GPU usage is unavailable");
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
    return unavailableGpu("nvidia", null, "NVIDIA telemetry is unavailable");
  }

  try {
    const output = execFileSync(nvidiaSmiPath, [
      "--query-gpu=name,utilization.gpu,utilization.memory,memory.used,memory.total,temperature.gpu",
      "--format=csv,noheader,nounits"
    ], {
      encoding: "utf8",
      timeout: 2000,
      windowsHide: true
    });
    const samples = output.trim().split(/\r?\n/).map((line) => {
      const [name, ...values] = String(line || "").split(",").map((value) => value.trim());
      const [gpuPercent, memoryPercent, memoryUsedMb, memoryTotalMb, temperatureC] = values.map(Number.parseFloat);
      return {
        available: Number.isFinite(gpuPercent),
        vendor: "nvidia",
        name: name || "NVIDIA GPU",
        percent: clampPercent(gpuPercent),
        memoryPercent: Number.isFinite(memoryPercent) ? clampPercent(memoryPercent) : null,
        memoryUsedMb: Number.isFinite(memoryUsedMb) ? memoryUsedMb : null,
        memoryTotalMb: Number.isFinite(memoryTotalMb) ? memoryTotalMb : null,
        temperatureC: Number.isFinite(temperatureC) ? temperatureC : null
      };
    }).filter((sample) => sample.available);
    if (samples.length === 0) {
      return unavailableGpu("nvidia", null, "NVIDIA GPU usage is unavailable");
    }
    return samples.reduce((selected, sample) => sample.percent > selected.percent ? sample : selected);
  } catch (err) {
    return unavailableGpu("nvidia", null, "NVIDIA telemetry is unavailable");
  }
}

function findNvidiaSmiPath() {
  const candidates = [
    process.platform === "win32" ? path.join(process.env.WINDIR || "C:\\Windows", "System32", "nvidia-smi.exe") : "/usr/bin/nvidia-smi",
    process.platform === "win32" ? path.join(process.env.ProgramFiles || "C:\\Program Files", "NVIDIA Corporation", "NVSMI", "nvidia-smi.exe") : "/usr/local/bin/nvidia-smi",
    "C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe"
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || (commandExists("nvidia-smi") ? "nvidia-smi" : null);
}

function linuxDrmDevices() {
  const drmRoot = "/sys/class/drm";
  let entries;
  try {
    entries = fs.readdirSync(drmRoot, { withFileTypes: true });
  } catch (err) {
    return [];
  }

  return entries
    .filter((entry) => /^card\d+$/.test(entry.name))
    .map((entry) => linuxDrmDevice(path.join(drmRoot, entry.name, "device")))
    .filter(Boolean);
}

function linuxDrmDevice(devicePath) {
  const vendorId = readText(path.join(devicePath, "vendor"));
  const driver = driverName(devicePath);
  const vendor = vendorFromPciId(vendorId) || normalizeGpuVendor(driver);
  if (!vendor) return null;

  const percent = readFirstNumber([
    path.join(devicePath, "gpu_busy_percent"),
    path.join(devicePath, "gt_busy_percent")
  ]);
  const memoryUsedBytes = readNumber(path.join(devicePath, "mem_info_vram_used"));
  const memoryTotalBytes = readNumber(path.join(devicePath, "mem_info_vram_total"));
  const temperatureMillidegrees = findDrmTemperature(devicePath);
  return {
    vendor,
    name: gpuName(vendor, driver),
    percent,
    memoryUsedMb: bytesToMb(memoryUsedBytes),
    memoryTotalMb: bytesToMb(memoryTotalBytes),
    memoryPercent: Number.isFinite(memoryUsedBytes) && Number.isFinite(memoryTotalBytes) && memoryTotalBytes > 0
      ? memoryUsedBytes / memoryTotalBytes * 100
      : null,
    temperatureC: Number.isFinite(temperatureMillidegrees) ? Math.round(temperatureMillidegrees / 100) / 10 : null
  };
}

function findDrmTemperature(devicePath) {
  const hwmonPath = path.join(devicePath, "hwmon");
  try {
    for (const entry of fs.readdirSync(hwmonPath)) {
      const value = readNumber(path.join(hwmonPath, entry, "temp1_input"));
      if (Number.isFinite(value)) return value;
    }
  } catch (err) {
    return null;
  }
  return null;
}

function driverName(devicePath) {
  try {
    return path.basename(fs.realpathSync(path.join(devicePath, "driver")));
  } catch (err) {
    return "";
  }
}

function readFirstNumber(paths) {
  for (const filePath of paths) {
    const value = readNumber(filePath);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function readNumber(filePath) {
  const text = readText(filePath);
  if (text === null || text === "") return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8").trim();
  } catch (err) {
    return null;
  }
}

function commandExists(command) {
  try {
    execFileSync(process.platform === "win32" ? "where.exe" : "which", [command], {
      stdio: "ignore",
      timeout: 1000,
      windowsHide: true
    });
    return true;
  } catch (err) {
    return false;
  }
}

function preferredGpuDevice(devices) {
  return devices.find((device) => ["nvidia", "amd", "intel", "apple"].includes(device.vendor)) || devices[0] || null;
}

function availableGpu(percent, device = null) {
  return {
    available: true,
    vendor: device && device.vendor || null,
    name: device && device.name || null,
    percent: clampPercent(percent),
    memoryPercent: null,
    memoryUsedMb: null,
    memoryTotalMb: null,
    temperatureC: null
  };
}

function unavailableGpu(vendor, name, reason) {
  return {
    available: false,
    vendor: vendor || null,
    name: name || null,
    reason
  };
}

function normalizeGpuVendor(value) {
  const text = String(value || "").toLowerCase();
  if (text.includes("nvidia")) return "nvidia";
  if (text.includes("advanced micro devices") || text.includes("amd") || text.includes("ati") || text === "amdgpu") return "amd";
  if (text.includes("intel") || text === "i915" || text === "xe") return "intel";
  if (text.includes("apple") || text === "agx") return "apple";
  return null;
}

function vendorFromPciId(value) {
  const id = String(value || "").toLowerCase().replace(/^0x/, "");
  if (id === "10de") return "nvidia";
  if (id === "1002") return "amd";
  if (id === "8086") return "intel";
  if (id === "106b") return "apple";
  return null;
}

function gpuName(vendor, driver) {
  const labels = { nvidia: "NVIDIA GPU", amd: "AMD GPU", intel: "Intel GPU", apple: "Apple GPU" };
  return labels[vendor] || driver || "GPU";
}

function gpuLabel(device) {
  return device.name || gpuName(device.vendor, "");
}

function arrayValue(value) {
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}

function bytesToMb(value) {
  return Number.isFinite(value) ? Math.round(value / 1024 / 1024 * 10) / 10 : null;
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
