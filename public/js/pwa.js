(function initialiseMediaBakerPwa(global) {
  const loadedVersion = document.querySelector('meta[name="media-baker-version"]')?.content || "";
  const installButton = document.getElementById("installAppButton");
  const installOverlay = document.getElementById("installAppOverlay");
  const installInstructions = document.getElementById("installAppInstructions");
  const closeInstallButton = document.getElementById("closeInstallApp");
  const reloadBanner = document.getElementById("appReloadBanner");
  const reloadMessage = document.getElementById("appReloadMessage");
  const reloadButton = document.getElementById("reloadUpdatedApp");
  const dismissReloadButton = document.getElementById("dismissAppReload");
  const VERSION_CHECK_INTERVAL_MS = 30 * 1000;

  let deferredInstallPrompt = null;
  let lastVersionCheckAt = 0;
  let versionCheckPromise = null;
  let pendingVersion = "";
  let dismissedVersion = "";
  let serviceWorkerRegistration = null;

  setup();

  function setup() {
    installButton?.addEventListener("click", installApp);
    closeInstallButton?.addEventListener("click", closeInstallInstructions);
    installOverlay?.addEventListener("click", (event) => {
      if (event.target === installOverlay) {
        closeInstallInstructions();
      }
    });
    reloadButton?.addEventListener("click", reloadForUpdate);
    dismissReloadButton?.addEventListener("click", dismissReload);

    global.addEventListener("beforeinstallprompt", (event) => {
      if (!canAdvertiseInstallation()) {
        return;
      }
      event.preventDefault();
      deferredInstallPrompt = event;
      updateInstallButton();
    });
    global.addEventListener("appinstalled", () => {
      deferredInstallPrompt = null;
      updateInstallButton();
    });
    global.addEventListener("media-baker:server-version", (event) => {
      observeServerVersion(event.detail && event.detail.version);
    });
    global.addEventListener("pageshow", () => checkVersion());
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        checkVersion();
      }
    });

    updateInstallButton();
    registerServiceWorker();
    checkVersion({ force: true });
  }

  async function registerServiceWorker() {
    if (!canAdvertiseInstallation() || !("serviceWorker" in navigator)) {
      return null;
    }
    try {
      serviceWorkerRegistration = await navigator.serviceWorker.register("/service-worker.js", {
        scope: "/",
        updateViaCache: "none"
      });
      await serviceWorkerRegistration.update();
      return serviceWorkerRegistration;
    } catch (err) {
      return null;
    }
  }

  function canAdvertiseInstallation() {
    return global.location.protocol === "https:";
  }

  function installedDisplayMode() {
    return global.matchMedia("(display-mode: standalone)").matches
      || global.navigator.standalone === true;
  }

  function isAppleInstallTarget() {
    const userAgent = global.navigator.userAgent || "";
    const ios = /iPad|iPhone|iPod/i.test(userAgent);
    const safari = /Safari/i.test(userAgent) && !/Chrome|Chromium|CriOS|Edg|OPR|Android/i.test(userAgent);
    return ios || safari;
  }

  function updateInstallButton() {
    const visible = canAdvertiseInstallation()
      && !installedDisplayMode()
      && Boolean(deferredInstallPrompt || isAppleInstallTarget());
    installButton?.classList.toggle("hidden", !visible);
  }

  async function installApp() {
    if (deferredInstallPrompt) {
      const prompt = deferredInstallPrompt;
      deferredInstallPrompt = null;
      await prompt.prompt();
      await prompt.userChoice.catch(() => null);
      updateInstallButton();
      return;
    }
    if (!isAppleInstallTarget()) {
      return;
    }
    const ios = /iPad|iPhone|iPod/i.test(global.navigator.userAgent || "");
    installInstructions.textContent = ios
      ? "Open the browser Share menu, choose Add to Home Screen, then confirm Add."
      : "Choose Add to Dock from Safari's File menu.";
    installOverlay.classList.remove("hidden");
    installOverlay.setAttribute("aria-hidden", "false");
  }

  function closeInstallInstructions() {
    installOverlay?.classList.add("hidden");
    installOverlay?.setAttribute("aria-hidden", "true");
  }

  async function checkVersion(options = {}) {
    const now = Date.now();
    if (!options.force && now - lastVersionCheckAt < VERSION_CHECK_INTERVAL_MS) {
      return null;
    }
    if (versionCheckPromise) {
      return versionCheckPromise;
    }
    lastVersionCheckAt = now;
    versionCheckPromise = fetch("/api/app/version", {
      cache: "no-store",
      headers: { Accept: "application/json" }
    })
      .then((response) => response.ok ? response.json() : null)
      .then((status) => {
        observeServerVersion(status && status.version);
        return status;
      })
      .catch(() => null)
      .finally(() => {
        versionCheckPromise = null;
      });
    return versionCheckPromise;
  }

  function observeServerVersion(version) {
    const serverVersion = String(version || "");
    if (loadedVersion && serverVersion && serverVersion !== loadedVersion) {
      showReload(serverVersion);
    }
  }

  function showReload(serverVersion) {
    pendingVersion = serverVersion;
    if (dismissedVersion === serverVersion) {
      return;
    }
    const video = document.getElementById("webPlayer");
    const playbackWarning = video && !video.paused && !video.ended
      ? " Reloading will stop current playback."
      : "";
    reloadMessage.textContent = `Version ${serverVersion} is ready.${playbackWarning}`;
    reloadBanner.classList.remove("hidden");
  }

  function dismissReload() {
    dismissedVersion = pendingVersion;
    reloadBanner?.classList.add("hidden");
  }

  async function reloadForUpdate() {
    reloadButton.disabled = true;
    const registration = serviceWorkerRegistration
      || await navigator.serviceWorker?.getRegistration?.("/");
    if (registration?.waiting) {
      await activateWaitingWorker(registration.waiting);
    }
    global.location.reload();
  }

  function activateWaitingWorker(worker) {
    return new Promise((resolve) => {
      const timeout = global.setTimeout(resolve, 3000);
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        global.clearTimeout(timeout);
        resolve();
      }, { once: true });
      worker.postMessage({ type: "SKIP_WAITING" });
    });
  }

  global.MediaBakerPwa = Object.freeze({
    checkVersion,
    loadedVersion,
    observeServerVersion,
    reloadForUpdate
  });
})(window);
