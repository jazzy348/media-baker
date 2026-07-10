const initialShareToken = new URLSearchParams(window.location.search).get("shareToken") || "";
const navigation = window.MediaBakerNavigation;
const apiClient = window.MediaBakerApi;
const PLAYBACK_PREFERENCES_KEY = "mediaBakerPlaybackPreferences";
const DEFAULT_PLAYBACK_PREFERENCES = {
  audioLanguage: "",
  subtitleLanguage: "",
  subtitleMode: "none",
  quality: "original",
  audioChannels: "stereo"
};

const state = {
  token: initialShareToken ? "" : localStorage.getItem("streamToken") || "",
  shareToken: initialShareToken,
  user: null,
  setupMode: false,
  selected: null,
  options: null,
  playbackPreferences: readLocalPlaybackPreferences(),
  applyingPlaybackPreferences: false,
  metadataMatchTarget: null,
  homeData: null,
  currentView: "home",
  homeMode: "recent",
  libraryView: null,
  iptvEnabled: false,
  iptvGuideStart: null,
  iptvGuide: null,
  iptvBufferSeconds: 180,
  iptvSegmentSeconds: 6,
  iptvGuidePinnedToNow: true,
  iptvChannelMappings: {},
  iptvChannelDeinterlaceModes: {},
  iptvMatchData: null,
  iptvGuideById: new Map(),
  features: {
    iptv: false,
    ytdlp: false
  },
  health: null,
  updateStatus: null,
  dismissedUpdateVersion: null
};

const LIBRARY_PAGE_SIZE = 72;
const LIVE_TV_PERMISSION_KEY = "@live-tv";

const els = {
  brandLink: document.querySelector(".brand"),
  loginOverlay: document.getElementById("loginOverlay"),
  loginForm: document.getElementById("loginForm"),
  loginTitle: document.getElementById("loginTitle"),
  loginPrompt: document.getElementById("loginPrompt"),
  usernameInput: document.getElementById("usernameInput"),
  secretInput: document.getElementById("secretInput"),
  loginError: document.getElementById("loginError"),
  lockButton: document.getElementById("lockButton"),
  accountButton: document.getElementById("accountButton"),
  historyButton: document.getElementById("historyButton"),
  adminPanelButton: document.getElementById("adminPanelButton"),
  liveTvButton: document.getElementById("liveTvButton"),
  downloadButton: document.getElementById("downloadButton"),
  systemBanner: document.getElementById("systemBanner"),
  updateBanner: document.getElementById("updateBanner"),
  updateBannerTitle: document.getElementById("updateBannerTitle"),
  updateBannerMessage: document.getElementById("updateBannerMessage"),
  updateReleaseLink: document.getElementById("updateReleaseLink"),
  installUpdateBanner: document.getElementById("installUpdateBanner"),
  dismissUpdateBanner: document.getElementById("dismissUpdateBanner"),
  homeToolbar: document.getElementById("homeToolbar"),
  homeModeTitle: document.getElementById("homeModeTitle"),
  recentMode: document.getElementById("recentMode"),
  randomMode: document.getElementById("randomMode"),
  homeRows: document.getElementById("homeRows"),
  searchInput: document.getElementById("searchInput"),
  searchResults: document.getElementById("searchResults"),
  searchGrid: document.getElementById("searchGrid"),
  searchCount: document.getElementById("searchCount"),
  liveTvView: document.getElementById("liveTvView"),
  liveTvStatus: document.getElementById("liveTvStatus"),
  liveTvGuide: document.getElementById("liveTvGuide"),
  liveTvFilter: document.getElementById("liveTvFilter"),
  liveTvEarlier: document.getElementById("liveTvEarlier"),
  liveTvNow: document.getElementById("liveTvNow"),
  liveTvLater: document.getElementById("liveTvLater"),
  imageViewer: document.getElementById("imageViewer"),
  imageViewerImage: document.getElementById("imageViewerImage"),
  closeImageViewer: document.getElementById("closeImageViewer"),
  detailsPanel: document.getElementById("detailsPanel"),
  closeDetails: document.getElementById("closeDetails"),
  detailsPoster: document.getElementById("detailsPoster"),
  editPoster: document.getElementById("editPoster"),
  posterForm: document.getElementById("posterForm"),
  posterUrlInput: document.getElementById("posterUrlInput"),
  cancelPosterEdit: document.getElementById("cancelPosterEdit"),
  savePoster: document.getElementById("savePoster"),
  posterStatus: document.getElementById("posterStatus"),
  detailsCategory: document.getElementById("detailsCategory"),
  detailsTitle: document.getElementById("detailsTitle"),
  detailsSubtitle: document.getElementById("detailsSubtitle"),
  detailsProgress: document.getElementById("detailsProgress"),
  detailsProgressFill: document.getElementById("detailsProgressFill"),
  detailsProgressText: document.getElementById("detailsProgressText"),
  hierarchyNav: document.getElementById("hierarchyNav"),
  detailsOverview: document.getElementById("detailsOverview"),
  toggleFilePath: document.getElementById("toggleFilePath"),
  filePathLabel: document.getElementById("filePathLabel"),
  filePath: document.getElementById("filePath"),
  audioSelect: document.getElementById("audioSelect"),
  qualitySelect: document.getElementById("qualitySelect"),
  audioChannelsLabel: document.getElementById("audioChannelsLabel"),
  audioChannelsSelect: document.getElementById("audioChannelsSelect"),
  subtitleSelect: document.getElementById("subtitleSelect"),
  subtitleSearchPanel: document.getElementById("subtitleSearchPanel"),
  subtitleLanguageInput: document.getElementById("subtitleLanguageInput"),
  searchSubtitles: document.getElementById("searchSubtitles"),
  subtitleCandidatesLabel: document.getElementById("subtitleCandidatesLabel"),
  subtitleCandidatesSelect: document.getElementById("subtitleCandidatesSelect"),
  subtitleSyncControls: document.getElementById("subtitleSyncControls"),
  addSubtitle: document.getElementById("addSubtitle"),
  subtitleSearchStatus: document.getElementById("subtitleSearchStatus"),
  proTv3dLabel: document.getElementById("proTv3dLabel"),
  proTv3dSelect: document.getElementById("proTv3dSelect"),
  proTv3dStatus: document.getElementById("proTv3dStatus"),
  playStream: document.getElementById("playStream"),
  pregenerateHls: document.getElementById("pregenerateHls"),
  copyUrl: document.getElementById("copyUrl"),
  rematchMetadata: document.getElementById("rematchMetadata"),
  markWatched: document.getElementById("markWatched"),
  removeOnDeck: document.getElementById("removeOnDeck"),
  copyStatus: document.getElementById("copyStatus"),
  manualCopyBar: document.getElementById("manualCopyBar"),
  manualCopyUrl: document.getElementById("manualCopyUrl"),
  resumeOverlay: document.getElementById("resumeOverlay"),
  resumePrompt: document.getElementById("resumePrompt"),
  resumeFromStart: document.getElementById("resumeFromStart"),
  resumeFromProgress: document.getElementById("resumeFromProgress"),
  resumeCancel: document.getElementById("resumeCancel"),
  metadataMatchOverlay: document.getElementById("metadataMatchOverlay"),
  metadataMatchPrompt: document.getElementById("metadataMatchPrompt"),
  metadataSearchTitle: document.getElementById("metadataSearchTitle"),
  metadataSearchYear: document.getElementById("metadataSearchYear"),
  metadataSearchButton: document.getElementById("metadataSearchButton"),
  metadataProviderId: document.getElementById("metadataProviderId"),
  metadataCandidateSelect: document.getElementById("metadataCandidateSelect"),
  metadataCandidateOverview: document.getElementById("metadataCandidateOverview"),
  metadataApplyMatch: document.getElementById("metadataApplyMatch"),
  metadataCancelMatch: document.getElementById("metadataCancelMatch"),
  metadataMatchStatus: document.getElementById("metadataMatchStatus"),
  playerOverlay: document.getElementById("playerOverlay"),
  closePlayer: document.getElementById("closePlayer"),
  minimizeVideoPlayer: document.getElementById("minimizeVideoPlayer"),
  videoPlayerSlot: document.getElementById("videoPlayerSlot"),
  videoPlaybackSurface: document.getElementById("videoPlaybackSurface"),
  videoControls: document.getElementById("videoControls"),
  videoPlayPause: document.getElementById("videoPlayPause"),
  videoCurrentTime: document.getElementById("videoCurrentTime"),
  videoSeek: document.getElementById("videoSeek"),
  videoDuration: document.getElementById("videoDuration"),
  videoMute: document.getElementById("videoMute"),
  videoVolume: document.getElementById("videoVolume"),
  videoPictureInPicture: document.getElementById("videoPictureInPicture"),
  videoFullscreen: document.getElementById("videoFullscreen"),
  webPlayer: document.getElementById("webPlayer"),
  playerCategory: document.getElementById("playerCategory"),
  playerTitle: document.getElementById("playerTitle"),
  playerStatus: document.getElementById("playerStatus"),
  videoMiniPlayer: document.getElementById("videoMiniPlayer"),
  videoMiniPlayerDrag: document.getElementById("videoMiniPlayerDrag"),
  videoMiniPlayerSlot: document.getElementById("videoMiniPlayerSlot"),
  videoMiniCategory: document.getElementById("videoMiniCategory"),
  videoMiniTitle: document.getElementById("videoMiniTitle"),
  videoMiniStatus: document.getElementById("videoMiniStatus"),
  restoreVideoPlayer: document.getElementById("restoreVideoPlayer"),
  closeVideoMiniPlayer: document.getElementById("closeVideoMiniPlayer"),
  musicPlayer: document.getElementById("musicPlayer"),
  musicPlayerDrag: document.getElementById("musicPlayerDrag"),
  musicPlayerCover: document.getElementById("musicPlayerCover"),
  musicPlayerArtist: document.getElementById("musicPlayerArtist"),
  musicPlayerTitle: document.getElementById("musicPlayerTitle"),
  musicPlayerAlbum: document.getElementById("musicPlayerAlbum"),
  musicPlayerStatus: document.getElementById("musicPlayerStatus"),
  closeMusicPlayer: document.getElementById("closeMusicPlayer"),
  musicPlayPause: document.getElementById("musicPlayPause"),
  musicNext: document.getElementById("musicNext"),
  musicMute: document.getElementById("musicMute"),
  musicSeek: document.getElementById("musicSeek"),
  musicVolume: document.getElementById("musicVolume"),
  musicCurrentTime: document.getElementById("musicCurrentTime"),
  musicDuration: document.getElementById("musicDuration"),
  downloadOverlay: document.getElementById("downloadOverlay"),
  downloadForm: document.getElementById("downloadForm"),
  downloadUrlInput: document.getElementById("downloadUrlInput"),
  startDownload: document.getElementById("startDownload"),
  closeDownloadPanel: document.getElementById("closeDownloadPanel"),
  downloadStatus: document.getElementById("downloadStatus"),
  downloadList: document.getElementById("downloadList"),
  accountOverlay: document.getElementById("accountOverlay"),
  selfAccountForm: document.getElementById("selfAccountForm"),
  selfAccountUsername: document.getElementById("selfAccountUsername"),
  selfAccountCurrentPassword: document.getElementById("selfAccountCurrentPassword"),
  selfAccountNewPassword: document.getElementById("selfAccountNewPassword"),
  selfAccountConfirmPassword: document.getElementById("selfAccountConfirmPassword"),
  saveSelfAccount: document.getElementById("saveSelfAccount"),
  closeAccountPanel: document.getElementById("closeAccountPanel"),
  selfAccountStatus: document.getElementById("selfAccountStatus"),
  iptvMatchOverlay: document.getElementById("iptvMatchOverlay"),
  iptvChannelFilter: document.getElementById("iptvChannelFilter"),
  iptvGuideFilter: document.getElementById("iptvGuideFilter"),
  iptvChannelSelect: document.getElementById("iptvChannelSelect"),
  iptvGuideSelect: document.getElementById("iptvGuideSelect"),
  iptvChannelResults: document.getElementById("iptvChannelResults"),
  iptvGuideResults: document.getElementById("iptvGuideResults"),
  iptvSelectedChannel: document.getElementById("iptvSelectedChannel"),
  iptvDeinterlaceMode: document.getElementById("iptvDeinterlaceMode"),
  iptvMatchStatus: document.getElementById("iptvMatchStatus"),
  saveIptvMatch: document.getElementById("saveIptvMatch"),
  clearIptvMatch: document.getElementById("clearIptvMatch"),
  closeIptvMatch: document.getElementById("closeIptvMatch"),
  libraryForm: document.getElementById("libraryForm"),
  libraryNameInput: document.getElementById("libraryNameInput"),
  libraryTypeSelect: document.getElementById("libraryTypeSelect"),
  libraryPathInput: document.getElementById("libraryPathInput"),
  libraryTrackProgress: document.getElementById("libraryTrackProgress"),
  browseLibraryPath: document.getElementById("browseLibraryPath"),
  folderPicker: document.getElementById("folderPicker"),
  folderPickerPath: document.getElementById("folderPickerPath"),
  folderPickerRoots: document.getElementById("folderPickerRoots"),
  folderPickerParent: document.getElementById("folderPickerParent"),
  selectFolderPath: document.getElementById("selectFolderPath"),
  closeFolderPicker: document.getElementById("closeFolderPicker"),
  folderPickerList: document.getElementById("folderPickerList"),
  addLibraryButton: document.getElementById("addLibraryButton"),
  reindexLibraries: document.getElementById("reindexLibraries"),
  libraryManagerStatus: document.getElementById("libraryManagerStatus"),
  libraryManagerList: document.getElementById("libraryManagerList"),
  refreshDuplicates: document.getElementById("refreshDuplicates"),
  duplicatesStatus: document.getElementById("duplicatesStatus"),
  duplicatesList: document.getElementById("duplicatesList"),
  backupSettingsForm: document.getElementById("backupSettingsForm"),
  backupDirectory: document.getElementById("backupDirectory"),
  browseBackupDirectory: document.getElementById("browseBackupDirectory"),
  backupRetention: document.getElementById("backupRetention"),
  backupScheduleEnabled: document.getElementById("backupScheduleEnabled"),
  backupScheduleBody: document.getElementById("backupScheduleBody"),
  backupTime: document.getElementById("backupTime"),
  backupDays: document.querySelectorAll(".backup-days input[type=checkbox]"),
  createBackup: document.getElementById("createBackup"),
  backupStatus: document.getElementById("backupStatus"),
  backupProgress: document.getElementById("backupProgress"),
  backupProgressFill: document.getElementById("backupProgressFill"),
  backupProgressText: document.getElementById("backupProgressText"),
  backupProgressEta: document.getElementById("backupProgressEta"),
  backupList: document.getElementById("backupList"),
  backupFolderPicker: document.getElementById("backupFolderPicker"),
  backupFolderPath: document.getElementById("backupFolderPath"),
  backupFolderRoots: document.getElementById("backupFolderRoots"),
  backupFolderParent: document.getElementById("backupFolderParent"),
  selectBackupFolder: document.getElementById("selectBackupFolder"),
  closeBackupFolderPicker: document.getElementById("closeBackupFolderPicker"),
  backupFolderList: document.getElementById("backupFolderList"),
  adminPanelOverlay: document.getElementById("adminPanelOverlay"),
  closeAdminPanel: document.getElementById("closeAdminPanel"),
  adminAccountsTab: document.getElementById("adminAccountsTab"),
  adminApiKeysTab: document.getElementById("adminApiKeysTab"),
  adminLibrariesTab: document.getElementById("adminLibrariesTab"),
  adminDuplicatesTab: document.getElementById("adminDuplicatesTab"),
  adminBackupsTab: document.getElementById("adminBackupsTab"),
  adminSettingsTab: document.getElementById("adminSettingsTab"),
  adminHardwareTab: document.getElementById("adminHardwareTab"),
  adminCurrentlyPlayingTab: document.getElementById("adminCurrentlyPlayingTab"),
  adminLogsTab: document.getElementById("adminLogsTab"),
  adminHistoryTab: document.getElementById("adminHistoryTab"),
  adminAccountsPage: document.getElementById("adminAccountsPage"),
  adminApiKeysPage: document.getElementById("adminApiKeysPage"),
  adminLibrariesPage: document.getElementById("adminLibrariesPage"),
  adminDuplicatesPage: document.getElementById("adminDuplicatesPage"),
  adminBackupsPage: document.getElementById("adminBackupsPage"),
  adminSettingsPage: document.getElementById("adminSettingsPage"),
  adminHardwarePage: document.getElementById("adminHardwarePage"),
  adminCurrentlyPlayingPage: document.getElementById("adminCurrentlyPlayingPage"),
  adminLogsPage: document.getElementById("adminLogsPage"),
  adminHistoryPage: document.getElementById("adminHistoryPage"),
  accountForm: document.getElementById("accountForm"),
  accountIdInput: document.getElementById("accountIdInput"),
  accountUsernameInput: document.getElementById("accountUsernameInput"),
  accountPasswordInput: document.getElementById("accountPasswordInput"),
  accountLibrariesSelect: document.getElementById("accountLibrariesSelect"),
  accountIsAdmin: document.getElementById("accountIsAdmin"),
  accountCanCopyUrls: document.getElementById("accountCanCopyUrls"),
  accountCanShare: document.getElementById("accountCanShare"),
  accountCanLibraries: document.getElementById("accountCanLibraries"),
  accountCanMetadata: document.getElementById("accountCanMetadata"),
  accountCanSettings: document.getElementById("accountCanSettings"),
  accountCanApiKeys: document.getElementById("accountCanApiKeys"),
  accountCanBackups: document.getElementById("accountCanBackups"),
  accountCanReindex: document.getElementById("accountCanReindex"),
  accountCanUsers: document.getElementById("accountCanUsers"),
  accountCanHardware: document.getElementById("accountCanHardware"),
  accountCanLogs: document.getElementById("accountCanLogs"),
  accountCanHistory: document.getElementById("accountCanHistory"),
  resetAccountForm: document.getElementById("resetAccountForm"),
  createAccount: document.getElementById("createAccount"),
  updateAccount: document.getElementById("updateAccount"),
  accountStatus: document.getElementById("accountStatus"),
  accountList: document.getElementById("accountList"),
  apiKeyForm: document.getElementById("apiKeyForm"),
  apiKeyUserSelect: document.getElementById("apiKeyUserSelect"),
  apiKeyNameInput: document.getElementById("apiKeyNameInput"),
  createApiKey: document.getElementById("createApiKey"),
  apiKeySecretPanel: document.getElementById("apiKeySecretPanel"),
  apiKeySecretValue: document.getElementById("apiKeySecretValue"),
  copyApiKeySecret: document.getElementById("copyApiKeySecret"),
  apiKeyStatus: document.getElementById("apiKeyStatus"),
  apiKeyList: document.getElementById("apiKeyList"),
  settingsForm: document.getElementById("settingsForm"),
  settingsLogLevel: document.getElementById("settingsLogLevel"),
  settingsLogRetentionDays: document.getElementById("settingsLogRetentionDays"),
  settingsPreferredAudio: document.getElementById("settingsPreferredAudio"),
  settingsEnableGpu: document.getElementById("settingsEnableGpu"),
  settingsUpdatesEnabled: document.getElementById("settingsUpdatesEnabled"),
  updatesSettingsFieldset: document.getElementById("updatesSettingsFieldset"),
  updateSettingsBody: document.getElementById("updateSettingsBody"),
  settingsUpdateIntervalHours: document.getElementById("settingsUpdateIntervalHours"),
  settingsIncludePrereleases: document.getElementById("settingsIncludePrereleases"),
  settingsAutoInstallLabel: document.getElementById("settingsAutoInstallLabel"),
  settingsAutoInstall: document.getElementById("settingsAutoInstall"),
  settingsCheckUpdates: document.getElementById("settingsCheckUpdates"),
  settingsInstallUpdate: document.getElementById("settingsInstallUpdate"),
  settingsUpdateStatus: document.getElementById("settingsUpdateStatus"),
  settingsMetadataEnabled: document.getElementById("settingsMetadataEnabled"),
  metadataSettingsBody: document.getElementById("metadataSettingsBody"),
  settingsTmdbApiKey: document.getElementById("settingsTmdbApiKey"),
  settingsTmdbReadToken: document.getElementById("settingsTmdbReadToken"),
  settingsMetadataLanguage: document.getElementById("settingsMetadataLanguage"),
  settingsPosterSize: document.getElementById("settingsPosterSize"),
  settingsThumbnailSize: document.getElementById("settingsThumbnailSize"),
  settingsPosterLanguages: document.getElementById("settingsPosterLanguages"),
  settingsMetadataDelay: document.getElementById("settingsMetadataDelay"),
  settingsMetadataPreload: document.getElementById("settingsMetadataPreload"),
  settingsSubtitlesEnabled: document.getElementById("settingsSubtitlesEnabled"),
  subtitleSettingsBody: document.getElementById("subtitleSettingsBody"),
  settingsSubtitleProvider: document.getElementById("settingsSubtitleProvider"),
  settingsSubdlApiKey: document.getElementById("settingsSubdlApiKey"),
  settingsSubtitleUserAgent: document.getElementById("settingsSubtitleUserAgent"),
  settingsSubtitleLanguage: document.getElementById("settingsSubtitleLanguage"),
  settingsSubtitleSyncEnabled: document.getElementById("settingsSubtitleSyncEnabled"),
  subtitleSyncSettingsBody: document.getElementById("subtitleSyncSettingsBody"),
  settingsSubtitleMaxOffset: document.getElementById("settingsSubtitleMaxOffset"),
  settingsSubtitleTimeout: document.getElementById("settingsSubtitleTimeout"),
  settingsYtDlpEnabled: document.getElementById("settingsYtDlpEnabled"),
  ytDlpSettingsBody: document.getElementById("ytDlpSettingsBody"),
  settingsYtDlpPath: document.getElementById("settingsYtDlpPath"),
  settingsYtDlpTitle: document.getElementById("settingsYtDlpTitle"),
  settingsYtDlpPlaylists: document.getElementById("settingsYtDlpPlaylists"),
  settingsIptvEnabled: document.getElementById("settingsIptvEnabled"),
  iptvSettingsBody: document.getElementById("iptvSettingsBody"),
  settingsIptvSourceType: document.getElementById("settingsIptvSourceType"),
  settingsIptvPlaylistField: document.getElementById("settingsIptvPlaylistField"),
  settingsIptvPlaylistUrl: document.getElementById("settingsIptvPlaylistUrl"),
  settingsIptvHdHomeRunField: document.getElementById("settingsIptvHdHomeRunField"),
  settingsIptvHdHomeRunUrl: document.getElementById("settingsIptvHdHomeRunUrl"),
  settingsIptvGuideLabel: document.getElementById("settingsIptvGuideLabel"),
  settingsIptvGuideUrl: document.getElementById("settingsIptvGuideUrl"),
  settingsIptvRefreshHours: document.getElementById("settingsIptvRefreshHours"),
  settingsIptvBufferSeconds: document.getElementById("settingsIptvBufferSeconds"),
  settingsIptvSegmentSeconds: document.getElementById("settingsIptvSegmentSeconds"),
  settingsIptvDeinterlaceMode: document.getElementById("settingsIptvDeinterlaceMode"),
  settingsIptvReload: document.getElementById("settingsIptvReload"),
  settingsIptvMatch: document.getElementById("settingsIptvMatch"),
  settingsHlsTtl: document.getElementById("settingsHlsTtl"),
  settingsHlsSegment: document.getElementById("settingsHlsSegment"),
  settingsHlsWait: document.getElementById("settingsHlsWait"),
  settingsForceTranscode: document.getElementById("settingsForceTranscode"),
  settingsOnDeckTtl: document.getElementById("settingsOnDeckTtl"),
  settingsWatchedThreshold: document.getElementById("settingsWatchedThreshold"),
  settingsIndexEnabled: document.getElementById("settingsIndexEnabled"),
  indexSettingsBody: document.getElementById("indexSettingsBody"),
  settingsIndexInterval: document.getElementById("settingsIndexInterval"),
  settingsIndexStartup: document.getElementById("settingsIndexStartup"),
  settingsFallbackEnabled: document.getElementById("settingsFallbackEnabled"),
  fallbackSettingsBody: document.getElementById("fallbackSettingsBody"),
  settingsFallbackSegment: document.getElementById("settingsFallbackSegment"),
  saveSettings: document.getElementById("saveSettings"),
  settingsStatus: document.getElementById("settingsStatus"),
  cpuMeter: document.getElementById("cpuMeter"),
  memoryMeter: document.getElementById("memoryMeter"),
  gpuMeter: document.getElementById("gpuMeter"),
  networkInMeter: document.getElementById("networkInMeter"),
  networkOutMeter: document.getElementById("networkOutMeter"),
  cpuText: document.getElementById("cpuText"),
  memoryText: document.getElementById("memoryText"),
  gpuText: document.getElementById("gpuText"),
  networkInText: document.getElementById("networkInText"),
  networkOutText: document.getElementById("networkOutText"),
  usageChart: document.getElementById("usageChart"),
  networkChart: document.getElementById("networkChart"),
  liveLog: document.getElementById("liveLog"),
  currentlyPlayingList: document.getElementById("currentlyPlayingList"),
  userHistoryList: document.getElementById("userHistoryList")
};

let hlsPlayer = null;
let nativePlayerErrorHandler = null;
let autoAdvanceInFlight = false;
let musicSeeking = false;
let videoSeeking = false;
let videoControlsHideTimer = null;
let floatingPlayerDrag = null;
let libraryObserver = null;
let progressRefreshPromise = null;
let draggedLibraryKey = null;
let adminRefreshTimer = null;
let folderPickerPath = "";
let backupFolderPickerPath = "";
let backupWasRunning = false;
let downloadRefreshTimer = null;
let downloadHomeRefreshPromise = null;
let onDeckRefreshTimer = null;
let onDeckRefreshPromise = null;
let hasActiveDownloads = false;
let liveTvRefreshTimer = null;
let liveTvRefreshPromise = null;
let liveTvRequestId = 0;
let routeRenderDepth = 0;
const downloadStatuses = new Map();

els.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const username = els.usernameInput.value.trim();
  const password = els.secretInput.value;
  if (!username || !password) {
    return;
  }

  try {
    const result = await publicApi(state.setupMode ? "/api/auth/setup" : "/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password })
    });
    state.token = result.token;
    state.user = result.user;
    setPlaybackPreferences(result.user && result.user.preferences);
    applyFeatures(result.features);
    state.shareToken = "";
    state.setupMode = false;
    localStorage.setItem("streamToken", state.token);
    els.loginOverlay.classList.add("hidden");
    updateAdminControls();
    await renderRoute(navigation.readRoute());
    refreshIptvAvailability();
    refreshSystemHealthInBackground();
    refreshUpdateStatusInBackground();
  } catch (err) {
    els.loginError.textContent = state.setupMode
      ? err.message || "Could not create the admin account."
      : err.message || "The username or password was rejected.";
  }
});

els.brandLink.addEventListener("click", (event) => {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return;
  }
  event.preventDefault();
  loadHome();
});

els.lockButton.addEventListener("click", () => {
  publicApi("/api/auth/logout", { method: "POST" }).catch(() => {});
  hideLiveTvView();
  closeAccountPanel();
  closePlayer();
  localStorage.removeItem("streamToken");
  state.token = "";
  state.user = null;
  setPlaybackPreferences(null);
  state.shareToken = "";
  els.usernameInput.value = "";
  els.secretInput.value = "";
  updateAdminControls();
  els.loginOverlay.classList.remove("hidden");
});

els.accountButton.addEventListener("click", openAccountPanel);
els.closeAccountPanel.addEventListener("click", closeAccountPanel);
els.selfAccountForm.addEventListener("submit", saveSelfAccount);
els.accountOverlay.addEventListener("click", (event) => {
  if (event.target === els.accountOverlay) {
    closeAccountPanel();
  }
});
els.downloadButton.addEventListener("click", openDownloadPanel);
els.liveTvButton.addEventListener("click", () => openLiveTv(new Date(), true));
els.liveTvEarlier.addEventListener("click", () => shiftLiveTvGuide(-1));
els.liveTvNow.addEventListener("click", () => openLiveTv(new Date(), true));
els.liveTvLater.addEventListener("click", () => shiftLiveTvGuide(1));
els.liveTvFilter.addEventListener("input", filterLiveTvChannels);
els.closeDownloadPanel.addEventListener("click", closeDownloadPanel);
els.downloadForm.addEventListener("submit", startYtDlpDownload);
els.downloadOverlay.addEventListener("click", (event) => {
  if (event.target === els.downloadOverlay) {
    closeDownloadPanel();
  }
});
els.historyButton.addEventListener("click", openHistoryView);
els.adminPanelButton.addEventListener("click", () => openAdminPanel("accounts"));
els.closeAdminPanel.addEventListener("click", closeAdminPanel);
els.adminPanelOverlay.addEventListener("click", (event) => {
  if (event.target === els.adminPanelOverlay) {
    closeAdminPanel();
  }
});
els.adminAccountsTab.addEventListener("click", () => openAdminPanel("accounts"));
els.adminApiKeysTab.addEventListener("click", () => openAdminPanel("apiKeys"));
els.adminLibrariesTab.addEventListener("click", () => openAdminPanel("libraries"));
els.adminDuplicatesTab.addEventListener("click", () => openAdminPanel("duplicates"));
els.adminBackupsTab.addEventListener("click", () => openAdminPanel("backups"));
els.adminSettingsTab.addEventListener("click", () => openAdminPanel("settings"));
els.adminHardwareTab.addEventListener("click", () => openAdminPanel("hardware"));
els.adminCurrentlyPlayingTab.addEventListener("click", () => openAdminPanel("currentlyPlaying"));
els.adminLogsTab.addEventListener("click", () => openAdminPanel("logs"));
els.adminHistoryTab.addEventListener("click", () => openAdminPanel("history"));
els.accountForm.addEventListener("submit", saveAccount);
els.resetAccountForm.addEventListener("click", resetAccountForm);
els.apiKeyForm.addEventListener("submit", createApiKey);
els.copyApiKeySecret.addEventListener("click", copyNewApiKey);
els.settingsForm.addEventListener("submit", saveSettings);
els.settingsCheckUpdates.addEventListener("click", forceCheckForUpdates);
els.settingsInstallUpdate.addEventListener("click", installAvailableUpdate);
els.installUpdateBanner.addEventListener("click", installAvailableUpdate);
els.dismissUpdateBanner.addEventListener("click", dismissUpdateBanner);
els.settingsIptvReload.addEventListener("click", forceReloadIptvSources);
els.settingsIptvMatch.addEventListener("click", openIptvMatcher);
els.closeIptvMatch.addEventListener("click", closeIptvMatcher);
els.saveIptvMatch.addEventListener("click", saveIptvChannelMatch);
els.clearIptvMatch.addEventListener("click", clearIptvChannelMatch);
els.iptvChannelFilter.addEventListener("input", debounce(renderIptvChannelOptions, 100));
els.iptvGuideFilter.addEventListener("input", debounce(() => renderIptvGuideOptions(false), 100));
els.iptvChannelSelect.addEventListener("change", () => renderIptvGuideOptions(true));
els.iptvMatchOverlay.addEventListener("click", (event) => {
  if (event.target === els.iptvMatchOverlay) {
    closeIptvMatcher();
  }
});
[
  els.settingsUpdatesEnabled,
  els.settingsIncludePrereleases,
  els.settingsAutoInstall,
  els.settingsMetadataEnabled,
  els.settingsSubtitlesEnabled,
  els.settingsSubtitleSyncEnabled,
  els.settingsYtDlpEnabled,
  els.settingsIptvEnabled,
  els.settingsIptvSourceType,
  els.settingsIndexEnabled,
  els.settingsFallbackEnabled
].forEach((element) => element.addEventListener("change", updateSettingsVisibility));
els.libraryForm.addEventListener("submit", addLibrary);
els.browseLibraryPath.addEventListener("click", () => openFolderPicker(els.libraryPathInput.value.trim()));
els.closeFolderPicker.addEventListener("click", closeFolderPicker);
els.folderPickerParent.addEventListener("click", () => {
  if (els.folderPickerParent.dataset.path) {
    loadFolderPicker(els.folderPickerParent.dataset.path);
  }
});
els.selectFolderPath.addEventListener("click", selectFolderPickerPath);
els.reindexLibraries.addEventListener("click", reindexLibraries);
els.refreshDuplicates.addEventListener("click", loadDuplicates);
els.backupSettingsForm.addEventListener("submit", saveBackupSettings);
els.backupScheduleEnabled.addEventListener("change", updateBackupScheduleVisibility);
els.createBackup.addEventListener("click", createBackupNow);
els.browseBackupDirectory.addEventListener("click", openBackupFolderPicker);
els.closeBackupFolderPicker.addEventListener("click", closeBackupFolderPicker);
els.backupFolderParent.addEventListener("click", () => {
  if (els.backupFolderParent.dataset.path) loadBackupFolderPicker(els.backupFolderParent.dataset.path);
});
els.selectBackupFolder.addEventListener("click", selectBackupFolder);
els.closeDetails.addEventListener("click", closeDetails);
els.toggleFilePath.addEventListener("click", toggleFilePath);
els.searchInput.addEventListener("input", debounce(search, 180));
els.recentMode.addEventListener("click", () => loadHome("recent"));
els.randomMode.addEventListener("click", () => loadHome("random"));
els.editPoster.addEventListener("click", openPosterEditor);
els.cancelPosterEdit.addEventListener("click", closePosterEditor);
els.posterForm.addEventListener("submit", savePosterUrl);
els.audioSelect.addEventListener("change", () => {
  updateAudioChannelsControl();
  savePlaybackPreferencesFromControls();
});
els.qualitySelect.addEventListener("change", savePlaybackPreferencesFromControls);
els.audioChannelsSelect.addEventListener("change", savePlaybackPreferencesFromControls);
els.subtitleSelect.addEventListener("change", savePlaybackPreferencesFromControls);
els.searchSubtitles.addEventListener("click", searchSubtitles);
els.addSubtitle.addEventListener("click", addSelectedSubtitle);
els.proTv3dSelect.addEventListener("change", updateProTv3dStatus);
els.playStream.addEventListener("click", playStream);
els.pregenerateHls.addEventListener("click", pregenerateHls);
els.copyUrl.addEventListener("click", copyStreamUrl);
els.rematchMetadata.addEventListener("click", rematchMetadata);
els.metadataSearchButton.addEventListener("click", searchMetadataCandidates);
els.metadataApplyMatch.addEventListener("click", applyMetadataMatch);
els.metadataCancelMatch.addEventListener("click", closeMetadataMatchModal);
els.metadataCandidateSelect.addEventListener("change", updateMetadataCandidateOverview);
els.metadataMatchOverlay.addEventListener("click", (event) => {
  if (event.target === els.metadataMatchOverlay) {
    closeMetadataMatchModal();
  }
});
els.markWatched.addEventListener("click", markSelectedWatched);
els.removeOnDeck.addEventListener("click", removeSelectedOnDeck);
els.closePlayer.addEventListener("click", closePlayer);
els.minimizeVideoPlayer.addEventListener("click", minimizeVideoPlayback);
els.restoreVideoPlayer.addEventListener("click", restoreVideoPlayback);
els.closeVideoMiniPlayer.addEventListener("click", closePlayer);
els.webPlayer.addEventListener("playing", startOnDeckPolling);
els.webPlayer.addEventListener("pause", stopOnDeckPolling);
els.webPlayer.addEventListener("ended", handleWebPlayerEnded);
els.webPlayer.addEventListener("play", updateMusicPlayerControls);
els.webPlayer.addEventListener("pause", updateMusicPlayerControls);
els.webPlayer.addEventListener("timeupdate", updateMusicPlayerControls);
els.webPlayer.addEventListener("loadedmetadata", updateMusicPlayerControls);
els.webPlayer.addEventListener("durationchange", updateMusicPlayerControls);
els.webPlayer.addEventListener("volumechange", updateMusicPlayerControls);
els.webPlayer.addEventListener("play", updateVideoPlayerControls);
els.webPlayer.addEventListener("pause", updateVideoPlayerControls);
els.webPlayer.addEventListener("timeupdate", updateVideoPlayerControls);
els.webPlayer.addEventListener("loadedmetadata", updateVideoPlayerControls);
els.webPlayer.addEventListener("durationchange", updateVideoPlayerControls);
els.webPlayer.addEventListener("volumechange", updateVideoPlayerControls);
els.webPlayer.addEventListener("click", toggleVideoPlayback);
els.webPlayer.addEventListener("dblclick", toggleVideoFullscreen);
els.videoPlayPause.addEventListener("click", toggleVideoPlayback);
els.videoMute.addEventListener("click", toggleVideoMute);
els.videoSeek.addEventListener("pointerdown", () => { videoSeeking = true; });
els.videoSeek.addEventListener("input", seekVideoPlayback);
els.videoSeek.addEventListener("change", () => { videoSeeking = false; updateVideoPlayerControls(); });
els.videoVolume.addEventListener("input", updateVideoVolume);
els.videoPictureInPicture.addEventListener("click", toggleVideoPictureInPicture);
els.videoFullscreen.addEventListener("click", toggleVideoFullscreen);
els.videoPlaybackSurface.addEventListener("pointermove", showVideoControls);
els.videoPlaybackSurface.addEventListener("pointerleave", scheduleVideoControlsHide);
els.videoPlaybackSurface.addEventListener("focusin", showVideoControls);
els.videoPlaybackSurface.addEventListener("focusout", scheduleVideoControlsHide);
document.addEventListener("fullscreenchange", updateVideoFullscreenControl);
document.addEventListener("webkitfullscreenchange", updateVideoFullscreenControl);
els.webPlayer.addEventListener("webkitbeginfullscreen", updateVideoFullscreenControl);
els.webPlayer.addEventListener("webkitendfullscreen", updateVideoFullscreenControl);
els.webPlayer.addEventListener("enterpictureinpicture", updateVideoPictureInPictureControl);
els.webPlayer.addEventListener("leavepictureinpicture", updateVideoPictureInPictureControl);
els.webPlayer.addEventListener("webkitpresentationmodechanged", updateVideoPictureInPictureControl);
els.webPlayer.addEventListener("loadedmetadata", updateVideoPictureInPictureControl);
els.webPlayer.addEventListener("emptied", updateVideoPictureInPictureControl);
els.closeMusicPlayer.addEventListener("click", closePlayer);
els.musicPlayPause.addEventListener("click", toggleMusicPlayback);
els.musicNext.addEventListener("click", handleWebPlayerEnded);
els.musicMute.addEventListener("click", toggleMusicMute);
els.musicSeek.addEventListener("pointerdown", () => { musicSeeking = true; });
els.musicSeek.addEventListener("input", seekMusicPlayback);
els.musicSeek.addEventListener("change", () => { musicSeeking = false; updateMusicPlayerControls(); });
els.musicVolume.addEventListener("input", updateMusicVolume);
els.musicPlayerDrag.addEventListener("pointerdown", startMusicPlayerDrag);
els.musicPlayerDrag.addEventListener("pointermove", moveMusicPlayer);
els.musicPlayerDrag.addEventListener("pointerup", stopMusicPlayerDrag);
els.musicPlayerDrag.addEventListener("pointercancel", stopMusicPlayerDrag);
els.videoMiniPlayerDrag.addEventListener("pointerdown", startVideoPlayerDrag);
els.videoMiniPlayerDrag.addEventListener("pointermove", moveFloatingPlayer);
els.videoMiniPlayerDrag.addEventListener("pointerup", stopFloatingPlayerDrag);
els.videoMiniPlayerDrag.addEventListener("pointercancel", stopFloatingPlayerDrag);
window.addEventListener("resize", clampFloatingPlayersToViewport);
els.playerOverlay.addEventListener("click", (event) => {
  if (event.target === els.playerOverlay) {
    closePlayer();
  }
});
els.closeImageViewer.addEventListener("click", hideImageViewer);
els.imageViewer.addEventListener("click", (event) => {
  if (event.target === els.imageViewer) {
    hideImageViewer();
  }
});
document.addEventListener("pointerdown", (event) => {
  if (!els.detailsPanel.classList.contains("open")) {
    return;
  }
  if (els.detailsPanel.contains(event.target)) {
    return;
  }
  if (event.target.closest(".choice-overlay, .player-overlay, .login-overlay, .music-player, .video-mini-player, .image-viewer")) {
    return;
  }
  closeDetails();
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") {
    return;
  }
  if (!els.iptvMatchOverlay.classList.contains("hidden")) {
    closeIptvMatcher();
    return;
  }
  if (!els.adminPanelOverlay.classList.contains("hidden")) {
    closeAdminPanel();
    return;
  }
  if (!els.playerOverlay.classList.contains("hidden")) {
    closePlayer();
    return;
  }
  if (!els.downloadOverlay.classList.contains("hidden")) {
    closeDownloadPanel();
    return;
  }
  if (!els.accountOverlay.classList.contains("hidden")) {
    closeAccountPanel();
    return;
  }
  if (els.detailsPanel.classList.contains("open")) {
    closeDetails();
    return;
  }
  if (!els.musicPlayer.classList.contains("hidden")) {
    closePlayer();
    return;
  }
  if (!els.videoMiniPlayer.classList.contains("hidden")) {
    closePlayer();
  }
});

navigation.onChange((route) => {
  if (!state.token && !state.shareToken) {
    return;
  }
  renderRoute(route).catch(() => {
    navigation.navigate("/", { replace: true });
    loadHome();
  });
});

boot();

async function boot() {
  let status;
  try {
    status = await publicApi("/api/auth/status");
  } catch (err) {
    els.loginError.textContent = err.message || "Media Baker could not contact the server.";
    els.loginOverlay.classList.remove("hidden");
    revealApp();
    return;
  }
  state.setupMode = Boolean(status.needsSetup);
  applyFeatures(status.features);
  updateLoginMode();
  updateAdminControls();
  if (state.setupMode) {
    els.loginOverlay.classList.remove("hidden");
    revealApp();
    return;
  }

  if (!state.token && !state.shareToken) {
    els.loginOverlay.classList.remove("hidden");
    revealApp();
    return;
  }

  try {
    if (state.token) {
      const me = await api("/api/auth/me");
      state.user = me.user;
      setPlaybackPreferences(me.user && me.user.preferences);
      applyFeatures(me.features);
    }
    els.loginOverlay.classList.add("hidden");
    updateAdminControls();
    await renderRoute(navigation.readRoute());
    refreshIptvAvailability();
    refreshSystemHealthInBackground();
    refreshUpdateStatusInBackground();
  } catch (err) {
    if (!state.shareToken) {
      localStorage.removeItem("streamToken");
    }
    state.token = "";
    state.user = null;
    setPlaybackPreferences(null);
    state.shareToken = "";
    updateAdminControls();
    els.loginOverlay.classList.remove("hidden");
  } finally {
    revealApp();
  }
}

function revealApp() {
  document.documentElement.classList.remove("auth-pending");
}

function applyFeatures(features) {
  state.features = {
    iptv: Boolean(features && features.iptv),
    ytdlp: Boolean(features && features.ytdlp)
  };
  state.iptvEnabled = state.features.iptv;
  updateAdminControls();
}

async function renderRoute(route) {
  routeRenderDepth += 1;
  try {
    if (route.name === "history" && !state.shareToken) {
      await openHistoryView();
      return;
    }
    if (route.name === "live-tv" && !state.shareToken) {
      if (state.iptvEnabled && canAccessLiveTv()) {
        await openLiveTv(route.start, route.pinnedToNow);
        return;
      }
      navigation.navigate("/", { replace: true });
    }
    if (route.name === "library") {
      await openLibraryView(route.libraryKey, route.title || readableRouteName(route.libraryKey), route.folder || "");
      return;
    }
    if (route.name === "show") {
      await openShowView(route.libraryKey, route.showId);
      return;
    }
    if (route.name === "season" && Number.isFinite(route.season)) {
      await openSeasonView(route.libraryKey, route.showId, route.season);
      return;
    }
    if (route.name === "artist") {
      await openArtistView(route.libraryKey, route.artistId);
      return;
    }
    if (route.name === "album") {
      await openAlbumView(route.libraryKey, route.artistId, route.albumId);
      return;
    }
    if (route.name === "search") {
      els.searchInput.value = route.query;
      await search();
      return;
    }

    if (route.name === "not-found") {
      navigation.navigate("/", { replace: true });
    }
    await loadHome(route.mode);
  } finally {
    routeRenderDepth -= 1;
  }
}

function readableRouteName(value) {
  return String(value || "Library")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function recordRoute(path, options = {}) {
  if (routeRenderDepth === 0) {
    navigation.navigate(path, options);
  }
}

function updateLoginMode() {
  els.loginTitle.textContent = state.setupMode ? "Create Admin Account" : "Media Baker";
  els.loginPrompt.textContent = state.setupMode
    ? "No accounts exist yet. Create the first admin account."
    : "Sign in to browse your library.";
  els.secretInput.placeholder = state.setupMode ? "Admin password" : "Password";
}

async function loadHome(mode = state.homeMode) {
  stopLibraryLoading();
  hideLiveTvView();
  state.homeMode = mode === "random" ? "random" : "recent";
  recordRoute(navigation.homePath(state.homeMode));
  updateHomeModeControls();
  const data = await api(`/api/catalog/home?mode=${encodeURIComponent(state.homeMode)}`);
  state.homeData = data;
  state.currentView = "home";
  els.searchInput.value = "";
  els.searchResults.classList.add("hidden");
  els.homeToolbar.classList.remove("hidden");
  els.homeRows.classList.remove("hidden");
  els.homeRows.innerHTML = "";
  const onDeck = await api("/api/progress/on-deck");
  renderOnDeckRow(onDeck.items || []);
  for (const row of data.rows) {
    els.homeRows.appendChild(rowSection(row.title, row.total || row.items.length, row.items, row.key));
  }
}

function renderOnDeckRow(items) {
  const existing = els.homeRows.querySelector('[data-row-kind="onDeck"]');
  if (items.length === 0) {
    existing?.remove();
    return;
  }

  const section = rowSection("On Deck", items.length, items);
  section.dataset.rowKind = "onDeck";
  if (existing) {
    existing.replaceWith(section);
  } else {
    els.homeRows.prepend(section);
  }
}

async function refreshOnDeckRow({ force = false } = {}) {
  if (state.currentView !== "home" || !state.token) {
    return;
  }
  if (onDeckRefreshPromise) {
    if (!force) {
      return onDeckRefreshPromise;
    }
    await onDeckRefreshPromise.catch(() => {});
    if (state.currentView !== "home" || !state.token) {
      return;
    }
  }

  onDeckRefreshPromise = api("/api/progress/on-deck")
    .then((onDeck) => {
      if (state.currentView === "home") {
        renderOnDeckRow(onDeck.items || []);
      }
    })
    .finally(() => {
      onDeckRefreshPromise = null;
    });
  return onDeckRefreshPromise;
}

function startOnDeckPolling() {
  if (onDeckRefreshTimer) {
    return;
  }
  refreshOnDeckRow().catch(() => {});
  onDeckRefreshTimer = window.setInterval(() => {
    refreshOnDeckRow().catch(() => {});
  }, 10_000);
}

function stopOnDeckPolling() {
  if (!onDeckRefreshTimer) {
    return;
  }
  window.clearInterval(onDeckRefreshTimer);
  onDeckRefreshTimer = null;
  refreshOnDeckRow().catch(() => {});
}

async function refreshSystemHealth() {
  state.health = await api("/api/health");
  renderSystemBanner();
  updateAdminControls();
  updatePlaybackControls();
  return state.health;
}

function refreshSystemHealthInBackground() {
  refreshSystemHealth().catch(() => {
    state.health = null;
    els.systemBanner.classList.add("hidden");
    els.systemBanner.innerHTML = "";
    updatePlaybackControls();
  });
}

async function refreshUpdateStatus(force = false) {
  if (!isAdminMode()) {
    state.updateStatus = null;
    renderUpdateBanner();
    renderSettingsUpdateStatus();
    return null;
  }

  try {
    state.updateStatus = await api(
      force ? "/api/admin/updates/check" : "/api/admin/updates/status",
      state.token,
      force ? { method: "POST" } : {}
    );
  } catch (err) {
    state.updateStatus = {
      enabled: true,
      currentVersion: "unknown",
      error: err.message || "Update check failed"
    };
  }
  renderUpdateBanner();
  renderSettingsUpdateStatus();
  return state.updateStatus;
}

function refreshUpdateStatusInBackground() {
  refreshUpdateStatus().catch(() => {});
}

function renderUpdateBanner() {
  const status = state.updateStatus;
  const latest = status && status.latest;
  const visible = Boolean(
    isAdminMode()
    && status
    && status.enabled
    && status.updateAvailable
    && latest
    && state.dismissedUpdateVersion !== latest.version
  );
  els.updateBanner.classList.toggle("hidden", !visible);
  if (!visible) {
    return;
  }

  els.updateBannerTitle.textContent = `Media Baker ${latest.version} is available`;
  els.updateBannerMessage.textContent = `You are running ${status.currentVersion}.${latest.publishedAt ? ` Released ${formatDate(latest.publishedAt)}.` : ""}`;
  els.updateReleaseLink.href = latest.url;
  els.installUpdateBanner.classList.toggle("hidden", !status.autoUpdateSupported);
}

function dismissUpdateBanner() {
  const latest = state.updateStatus && state.updateStatus.latest;
  if (latest) {
    state.dismissedUpdateVersion = latest.version;
  }
  renderUpdateBanner();
}

function renderSettingsUpdateStatus() {
  const status = state.updateStatus;
  const canInstall = Boolean(status && status.autoUpdateSupported && status.updateAvailable && status.latest);
  els.settingsInstallUpdate.disabled = !canInstall;
  els.settingsInstallUpdate.classList.toggle("hidden", !canInstall);
  els.settingsAutoInstallLabel.classList.toggle("hidden", Boolean(status && !status.autoUpdateSupported));
  els.settingsAutoInstall.disabled = Boolean(status && !status.autoUpdateSupported);
  if (!status) {
    els.settingsUpdateStatus.textContent = "";
    return;
  }
  if (!status.enabled) {
    els.settingsUpdateStatus.textContent = "Release checks are disabled.";
    return;
  }
  if (status.error) {
    els.settingsUpdateStatus.textContent = `Last check failed: ${status.error}`;
    return;
  }
  if (status.install && status.install.phase === "failed") {
    els.settingsUpdateStatus.textContent = `Update failed: ${status.install.error}`;
    return;
  }
  if (!status.latest) {
    els.settingsUpdateStatus.textContent = `No published releases found. Current version: ${status.currentVersion}.`;
    return;
  }
  els.settingsUpdateStatus.textContent = status.updateAvailable
    ? `Version ${status.latest.version} is available. Current version: ${status.currentVersion}.`
    : `Media Baker ${status.currentVersion} is current.`;
}

function renderSystemBanner() {
  const warnings = state.health && state.health.warnings || [];
  if (warnings.length === 0) {
    els.systemBanner.classList.add("hidden");
    els.systemBanner.innerHTML = "";
    return;
  }

  const playbackBlocked = !isPlaybackReady();
  els.systemBanner.classList.toggle("system-banner-critical", playbackBlocked);
  els.systemBanner.innerHTML = `
    <strong>${playbackBlocked ? "Playback is disabled" : "Configuration warning"}</strong>
    <div>${warnings.map((warning) => `<p>${escapeHtml(warning.message)}</p>`).join("")}</div>
  `;
  els.systemBanner.classList.remove("hidden");
}

function isPlaybackReady() {
  return !state.health || Boolean(state.health.playbackReady);
}

function playbackDisabledMessage() {
  const warnings = state.health && state.health.warnings || [];
  const blocking = warnings.filter((warning) => warning.code === "ffmpeg_missing" || warning.code === "ffprobe_missing");
  if (blocking.length > 0) {
    return blocking.map((warning) => warning.message).join(" ");
  }

  return "Playback is disabled until FFmpeg and FFprobe are configured.";
}

function updateHomeModeControls() {
  const random = state.homeMode === "random";
  els.homeModeTitle.textContent = random ? "Random" : "Recently Added";
  els.recentMode.classList.toggle("active", !random);
  els.randomMode.classList.toggle("active", random);
}

async function search() {
  stopLibraryLoading();
  hideLiveTvView();
  const query = els.searchInput.value.trim();
  if (!query) {
    recordRoute(navigation.homePath(state.homeMode), { replace: state.currentView === "search" });
    els.searchResults.classList.add("hidden");
    els.homeToolbar.classList.remove("hidden");
    els.homeRows.classList.remove("hidden");
    els.searchGrid.innerHTML = "";
    els.searchCount.textContent = "";
    state.currentView = "home";
    return;
  }

  recordRoute(navigation.searchPath(query), { replace: state.currentView === "search" });
  els.homeRows.classList.add("hidden");
  els.homeToolbar.classList.add("hidden");
  state.currentView = "search";
  const data = await api(`/api/catalog/search?q=${encodeURIComponent(query)}`);
  els.searchResults.classList.remove("hidden");
  els.searchCount.textContent = `${data.results.length} found`;
  els.searchGrid.innerHTML = "";
  if (data.results.length === 0) {
    const empty = document.createElement("p");
    empty.className = "card-subtitle";
    empty.textContent = "No matches found.";
    els.searchGrid.appendChild(empty);
    return;
  }

  data.results.forEach((item) => els.searchGrid.appendChild(card(item)));
}

function card(item, options = {}) {
  const episode = isEpisodeItem(item);
  const showEpisodeThumbnail = episode && options.episodeArtwork === "thumbnail";
  const imageUrl = episode
    ? showEpisodeThumbnail
      ? item.thumbnailUrl || item.seasonPosterUrl || item.posterUrl
      : item.seasonPosterUrl || item.posterUrl
    : imageUrlForItem(item);
  const selectedItem = episode && !showEpisodeThumbnail
    ? { ...item, thumbnailUrl: null, posterUrl: imageUrl || item.posterUrl, preferredArtworkUrl: imageUrl || null }
    : item;
  const button = document.createElement("button");
  button.className = "card";
  button.type = "button";
  button.dataset.mediaKey = mediaKey(item);
  button.classList.toggle("watched-card", isWatchedProgress(item.progress));
  button.innerHTML = `
    <div class="poster">${initials(item.title)}</div>
    <div class="card-progress-slot">${progressBarHtml(item.progress)}</div>
    <div class="card-title">${escapeHtml(item.title)}</div>
    <div class="card-subtitle">${escapeHtml(item.subtitle || item.category)}</div>
  `;
  const poster = button.querySelector(".poster");
  poster.classList.toggle("thumbnail-art", Boolean(showEpisodeThumbnail && item.thumbnailUrl));
  poster.classList.toggle("image-art", item.itemType === "image");
  poster.classList.toggle("image-folder-art", ["image-folder", "media-folder"].includes(item.itemType));
  poster.classList.toggle("playlist-art", item.itemType === "playlist");
  if (imageUrl) {
    setPosterImage(poster, imageUrl);
  }
  setWatchedMarker(poster, isWatchedProgress(item.progress));
  button.addEventListener("click", () => {
    if (["image-folder", "media-folder", "playlist"].includes(item.itemType)) {
      openLibraryView(item.mediaType, item.category, item.folderPath);
      return;
    }
    if (isShowCard(item)) {
      openShowView(item.mediaType, item.showId || item.id);
      return;
    }
    if (isArtistCard(item)) {
      openArtistView(item.mediaType, item.artistId || item.id);
      return;
    }
    if (isAlbumCard(item)) {
      openAlbumView(item.mediaType, item.artistId, item.albumId || item.id);
      return;
    }

    openDetails(selectedItem);
  });
  return button;
}

async function openDetails(item) {
  if (isShowCard(item)) {
    openShowView(item.mediaType, item.showId || item.id);
    return;
  }
  if (isArtistCard(item)) {
    openArtistView(item.mediaType, item.artistId || item.id);
    return;
  }
  if (isAlbumCard(item)) {
    openAlbumView(item.mediaType, item.artistId, item.albumId || item.id);
    return;
  }

  if (item.itemType !== "image") {
    hideImageViewer();
  }

  state.selected = item;
  state.options = null;
  els.copyStatus.textContent = "";
  hideManualCopyUrl();
  els.detailsCategory.textContent = item.category;
  els.detailsTitle.textContent = item.title;
  els.detailsSubtitle.textContent = item.subtitle || "";
  renderDetailsProgress(item.progress);
  updateManagementActions(item.progress);
  updateDetailsAdminControls();
  renderHierarchyNav(item);
  closePosterEditor();
  els.posterStatus.textContent = "";
  els.posterUrlInput.value = "";
  els.detailsPoster.textContent = initials(item.title);
  els.detailsPoster.classList.remove("with-image");
  els.detailsPoster.classList.toggle("thumbnail-art", Boolean(item.thumbnailUrl));
  els.detailsPoster.classList.toggle("image-preview", item.itemType === "image");
  els.detailsPoster.style.removeProperty("--poster-image");
  const detailsImageUrl = imageUrlForItem(item);
  if (detailsImageUrl) {
    setPosterImage(els.detailsPoster, detailsImageUrl);
  }
  setWatchedMarker(els.detailsPoster, isWatchedProgress(item.progress));
  els.detailsOverview.textContent = "";
  setFilePathVisible(false);
  els.filePath.value = "Loading fresh stream options...";
  els.audioSelect.innerHTML = "";
  els.qualitySelect.innerHTML = "";
  els.audioChannelsLabel.classList.add("hidden");
  els.audioChannelsSelect.value = "stereo";
  els.subtitleSelect.innerHTML = "";
  resetSubtitleSearch();
  els.proTv3dLabel.classList.add("hidden");
  els.proTv3dSelect.value = "auto";
  els.proTv3dStatus.textContent = "";
  els.detailsPanel.classList.add("open");
  els.detailsPanel.setAttribute("aria-hidden", "false");
  updatePlaybackControls();

  if (item.itemType === "image") {
    if (detailsImageUrl) {
      showImageViewer(detailsImageUrl, item.title);
    }
    const options = await api(`/api/catalog/${item.mediaType}/${item.id}/options`);
    state.options = options;
    state.selected = {
      ...state.selected,
      ...options.item,
      itemType: "image",
      category: item.category,
      filePath: options.filePath,
      thumbnailUrl: item.thumbnailUrl
    };
    els.filePath.value = options.filePath;
    if (options.originalUrl) {
      setPosterImage(els.detailsPoster, options.originalUrl);
      showImageViewer(options.originalUrl, state.selected.title);
    }
    fillSelect(els.audioSelect, options.audio);
    fillSelect(els.qualitySelect, options.quality);
    fillSelect(els.subtitleSelect, options.subtitles);
    applyPlaybackPreferencesToControls(options);
    updateDetailsAdminControls();
    updatePlaybackControls();
    return;
  }

  loadMetadata(item);

  if (!isPlaybackReady()) {
    const progress = await api(`/api/progress/${item.mediaType}/${item.id}`).catch(() => null);
    state.selected = {
      ...state.selected,
      filePath: item.filePath,
      progress
    };
    if (progress) {
      renderDetailsProgress(progress);
      updateManagementActions(progress);
    }
    els.filePath.value = item.filePath || "Playback tools are not configured.";
    fillSelect(els.audioSelect, [{ id: "default", label: "Unavailable until FFmpeg / FFprobe is configured" }]);
    fillSelect(els.qualitySelect, [{ id: "original", label: "Original" }]);
    fillSelect(els.subtitleSelect, [{ id: "none", label: "None" }]);
    els.copyStatus.textContent = playbackDisabledMessage();
    updatePlaybackControls();
    return;
  }

  const [options, progress] = await Promise.all([
    api(`/api/catalog/${item.mediaType}/${item.id}/options`),
    api(`/api/progress/${item.mediaType}/${item.id}`)
  ]);
  state.options = options;
  const displayTitle = state.selected.title || options.item.title;
  state.selected = {
    ...state.selected,
    ...options.item,
    title: displayTitle,
    category: item.category,
    filePath: options.filePath,
    posterUrl: item.posterUrl,
    thumbnailUrl: item.thumbnailUrl,
    progress
  };
  renderDetailsProgress(progress);
  updateManagementActions(progress);
  els.filePath.value = options.filePath;
  renderHierarchyNav(state.selected);
  fillSelect(els.audioSelect, options.audio);
  fillSelect(els.qualitySelect, options.quality || [{ id: "original", label: "Original" }]);
  fillSelect(els.subtitleSelect, options.subtitles);
  applyPlaybackPreferencesToControls(options);
  updateSubtitleSearchControl();
  updateProTv3dControl();
  updateDetailsAdminControls();
  updatePlaybackControls();
}

function rowSection(title, count, items, libraryKey, options = {}) {
  const section = document.createElement("section");
  section.className = "row";
  section.innerHTML = `
    <div class="section-heading">
      <h2>${escapeHtml(title)}</h2>
      <div class="section-actions">
        <span>${count}</span>
        ${libraryKey ? '<button class="text-button" type="button">View all</button>' : ""}
      </div>
    </div>
    <div class="rail"></div>
  `;
  const viewAll = section.querySelector(".text-button");
  if (viewAll) {
    viewAll.addEventListener("click", () => openLibraryView(libraryKey, title));
  }
  const rail = section.querySelector(".rail");
  items.forEach((item) => rail.appendChild(card(item, options)));
  return section;
}

function appendSectionAction(section, label, onClick) {
  const actions = section.querySelector(".section-actions");
  if (!actions) {
    return;
  }

  const button = document.createElement("button");
  button.className = "text-button";
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", onClick);
  actions.appendChild(button);
}

function renderHierarchyNav(item) {
  els.hierarchyNav.innerHTML = "";
  if (item && item.artistId && item.albumId) {
    els.hierarchyNav.classList.remove("hidden");
    els.hierarchyNav.append(
      hierarchyButton(item.albumName || "Album", () => openAlbumView(item.mediaType, item.artistId, item.albumId)),
      hierarchyButton(item.artistName || "Artist", () => openArtistView(item.mediaType, item.artistId))
    );
    return;
  }
  if (!isEpisodeItem(item)) {
    els.hierarchyNav.classList.add("hidden");
    return;
  }

  els.hierarchyNav.classList.remove("hidden");
  const seasonButton = hierarchyButton(`Season ${pad(item.season)}`, () => openSeasonView(item.mediaType, item.showId, item.season));
  const showButton = hierarchyButton(item.showName || "Show", () => openShowView(item.mediaType, item.showId));
  els.hierarchyNav.append(seasonButton, showButton);
}

function toggleFilePath() {
  setFilePathVisible(els.filePathLabel.classList.contains("hidden"));
}

function setFilePathVisible(visible) {
  els.filePathLabel.classList.toggle("hidden", !visible);
  els.toggleFilePath.textContent = visible ? "Hide file path" : "Show file path";
  els.toggleFilePath.setAttribute("aria-expanded", visible ? "true" : "false");
}

function hierarchyButton(label, onClick) {
  const button = document.createElement("button");
  button.className = "nav-chip";
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

async function openSeasonView(mediaType, showId, seasonNumber) {
  stopLibraryLoading();
  recordRoute(navigation.seasonPath(mediaType, showId, seasonNumber));
  const [show, season] = await Promise.all([
    api(`${tvBasePath(mediaType)}/${showId}`),
    api(`${tvBasePath(mediaType)}/${showId}/seasons/${seasonNumber}`)
  ]);
  state.currentView = "season";
  closeDetails();
  showContentView({
    title: `${show.name} - ${season.name || `Season ${pad(season.season)}`}`,
    subtitle: `${season.episodes.length} episodes`,
    actions: [
      ...(hasPermission("canManageMetadata") ? [{ label: "Match show", onClick: () => rematchShowMetadata(mediaType, show) }] : []),
      ...(state.user && !state.shareToken ? [{ label: seasonWatchedActionLabel(season), onClick: (event) => markSeasonWatched(mediaType, show, season, event.currentTarget) }] : []),
      { label: "Show", onClick: () => openShowView(mediaType, showId) },
      { label: "Home", onClick: () => loadHome() }
    ],
    content: seasonGrid(mediaType, show, season)
  });
}

async function openShowView(mediaType, showId) {
  stopLibraryLoading();
  recordRoute(navigation.showPath(mediaType, showId));
  const show = await api(`${tvBasePath(mediaType)}/${showId}`);
  state.currentView = "show";
  closeDetails();
  const fragment = document.createDocumentFragment();
  for (const season of show.seasons) {
    const section = rowSection(
      season.name || `Season ${pad(season.season)}`,
      `${season.episodes.length} episodes`,
      season.episodes.map((episode) => episodeItem(mediaType, show, episode)),
      null,
      { episodeArtwork: "thumbnail" }
    );
    appendSectionAction(section, "View season", () => openSeasonView(mediaType, showId, season.season));
    if (state.user && !state.shareToken) {
      appendSectionAction(section, seasonWatchedActionLabel(season), (event) => markSeasonWatched(mediaType, show, season, event.currentTarget));
    }
    fragment.appendChild(section);
  }
  showContentView({
    title: show.name,
    subtitle: `${show.seasons.length} seasons`,
    actions: [
      ...(hasPermission("canManageMetadata") ? [{ label: "Match show", onClick: () => rematchShowMetadata(mediaType, show) }] : []),
      { label: "Random episode", onClick: () => openRandomEpisode(mediaType, show) },
      { label: "Home", onClick: () => loadHome() }
    ],
    content: fragment
  });
}

async function openAlbumView(mediaType, artistId, albumId) {
  stopLibraryLoading();
  recordRoute(navigation.albumPath(mediaType, artistId, albumId));
  const [artist, album] = await Promise.all([
    api(`${tvBasePath(mediaType)}/${artistId}`),
    api(`${tvBasePath(mediaType)}/${artistId}/albums/${albumId}`)
  ]);
  state.currentView = "album";
  closeDetails();
  const section = document.createElement("section");
  section.className = "search-results";
  const grid = document.createElement("div");
  grid.className = "grid";
  album.tracks.map((track) => trackItem(mediaType, artist, album, track))
    .forEach((item) => grid.appendChild(card(item)));
  section.appendChild(grid);
  showContentView({
    title: `${artist.name} - ${album.name}`,
    subtitle: `${album.tracks.length} tracks${album.year ? ` - ${album.year}` : ""}`,
    actions: [
      { label: "Artist", onClick: () => openArtistView(mediaType, artistId) },
      { label: "Home", onClick: () => loadHome() }
    ],
    content: section
  });
}

async function openArtistView(mediaType, artistId) {
  stopLibraryLoading();
  recordRoute(navigation.artistPath(mediaType, artistId));
  const artist = await api(`${tvBasePath(mediaType)}/${artistId}`);
  state.currentView = "artist";
  closeDetails();
  const fragment = document.createDocumentFragment();
  for (const album of artist.albums || []) {
    const items = (album.tracks || []).map((track) => trackItem(mediaType, artist, album, track));
    const section = rowSection(album.name, `${items.length} tracks`, items);
    const viewAlbum = hierarchyButton("View album", () => openAlbumView(mediaType, artistId, album.id));
    viewAlbum.className = "text-button";
    section.querySelector(".section-actions").appendChild(viewAlbum);
    fragment.appendChild(section);
  }
  showContentView({
    title: artist.name,
    subtitle: `${artist.albums.length} albums`,
    actions: [{ label: "Home", onClick: () => loadHome() }],
    content: fragment
  });
}

function openRandomEpisode(mediaType, show) {
  const episodes = (show.seasons || []).flatMap((season) => season.episodes || []);
  if (episodes.length === 0) {
    return;
  }

  const episode = episodes[Math.floor(Math.random() * episodes.length)];
  openDetails(episodeItem(mediaType, show, episode));
}

function showContentView({ title, subtitle, actions, content }) {
  hideLiveTvView();
  els.searchInput.value = "";
  els.searchResults.classList.add("hidden");
  els.homeToolbar.classList.add("hidden");
  els.homeRows.classList.remove("hidden");
  els.homeRows.innerHTML = "";
  const header = document.createElement("section");
  header.className = "view-header";
  header.innerHTML = `
    <div>
      <p class="eyebrow">${escapeHtml(subtitle || "")}</p>
      <h2>${escapeHtml(title)}</h2>
    </div>
    <div class="view-actions"></div>
  `;
  const actionShell = header.querySelector(".view-actions");
  for (const action of actions || []) {
    actionShell.appendChild(hierarchyButton(action.label, action.onClick));
  }
  els.homeRows.appendChild(header);
  els.homeRows.appendChild(content);
  window.scrollTo({ top: 0, behavior: "smooth" });
  return { header, content };
}

async function openLibraryView(libraryKey, title, folder = "") {
  stopLibraryLoading();
  closeDetails();
  recordRoute(navigation.libraryPath(libraryKey, folder), { state: { title } });

  const section = document.createElement("section");
  section.className = "library-results";
  const controls = libraryViewControls();
  if (folder && libraryKey === "yt-dlp") {
    controls.classList.add("hidden");
  }
  const grid = document.createElement("div");
  grid.className = "grid";
  const status = document.createElement("p");
  status.className = "status library-status";
  const sentinel = document.createElement("div");
  sentinel.className = "library-sentinel";
  section.append(controls, grid, status, sentinel);

  const view = showContentView({
    title: folder ? catalogFolderName(folder) : title,
    subtitle: "Loading...",
    actions: [
      ...(folder ? [{ label: "Back", onClick: () => openLibraryView(libraryKey, state.libraryView && state.libraryView.title || title, parentFolderPath(folder)) }] : []),
      { label: "Home", onClick: () => loadHome() }
    ],
    content: section
  });

  state.currentView = "library";
  state.libraryView = {
    key: libraryKey,
    title,
    folder,
    sort: "alpha",
    metadataFilter: "all",
    offset: 0,
    total: 0,
    hasMore: true,
    loading: false,
    supportsMetadataMatching: null,
    grid,
    status,
    sentinel,
    requestId: 0,
    subtitle: view.header.querySelector(".eyebrow"),
    heading: view.header.querySelector("h2")
  };

  libraryObserver = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) {
      loadNextLibraryPage();
    }
  }, { rootMargin: "700px 0px" });
  libraryObserver.observe(sentinel);

  await loadNextLibraryPage();
}

function libraryViewControls() {
  const controls = document.createElement("div");
  controls.className = "library-view-controls";
  controls.innerHTML = `
    <div class="segmented-control library-sort-control">
      <button class="active" type="button" data-sort="alpha">Alphabetical</button>
      <button type="button" data-sort="recent">Recently Added</button>
    </div>
    <div class="segmented-control library-filter-control hidden">
      <button class="active" type="button" data-filter="all">All</button>
      <button type="button" data-filter="unmatched">Unmatched</button>
    </div>
  `;

  controls.querySelectorAll("[data-sort]").forEach((button) => {
    button.addEventListener("click", () => setLibrarySort(button.dataset.sort));
  });
  controls.querySelectorAll("[data-filter]").forEach((button) => {
    button.addEventListener("click", () => setLibraryMetadataFilter(button.dataset.filter));
  });
  return controls;
}

function setLibrarySort(sort) {
  const view = state.libraryView;
  if (!view || view.sort === sort) {
    return;
  }
  view.sort = sort === "recent" ? "recent" : "alpha";
  view.grid.closest(".library-results").querySelectorAll("[data-sort]").forEach((button) => {
    button.classList.toggle("active", button.dataset.sort === view.sort);
  });
  resetLibraryPage();
}

function setLibraryMetadataFilter(filter) {
  const view = state.libraryView;
  if (!view || view.supportsMetadataMatching === false || view.metadataFilter === filter) {
    return;
  }
  view.metadataFilter = filter === "unmatched" ? "unmatched" : "all";
  view.grid.closest(".library-results").querySelectorAll("[data-filter]").forEach((button) => {
    button.classList.toggle("active", button.dataset.filter === view.metadataFilter);
  });
  resetLibraryPage();
}

function resetLibraryPage() {
  const view = state.libraryView;
  if (!view) {
    return;
  }
  view.offset = 0;
  view.total = 0;
  view.hasMore = true;
  view.loading = false;
  view.requestId += 1;
  view.grid.innerHTML = "";
  loadNextLibraryPage();
}

async function openHistoryView() {
  stopLibraryLoading();
  closeDetails();
  recordRoute("/history");
  const data = await api("/api/progress/history");
  const section = document.createElement("section");
  section.className = "library-results";
  const grid = document.createElement("div");
  grid.className = "grid";
  section.appendChild(grid);

  if (!data.items || data.items.length === 0) {
    const empty = document.createElement("p");
    empty.className = "status";
    empty.textContent = "No watched history yet.";
    section.appendChild(empty);
  } else {
    data.items.forEach((item) => grid.appendChild(card(item)));
  }

  state.currentView = "history";
  showContentView({
    title: "History",
    subtitle: `${data.items ? data.items.length : 0} items`,
    actions: [{ label: "Home", onClick: () => loadHome() }],
    content: section
  });
}

async function refreshIptvAvailability() {
  if (!state.token || state.shareToken || !canAccessLiveTv()) {
    state.iptvEnabled = false;
    updateAdminControls();
    return;
  }

  try {
    const status = await api("/api/iptv");
    state.iptvEnabled = Boolean(status.enabled);
    state.iptvBufferSeconds = Number(status.bufferSeconds) || 180;
    state.iptvSegmentSeconds = Number(status.segmentSeconds) || 6;
  } catch (err) {
    state.iptvEnabled = false;
  }
  updateAdminControls();
}

async function openLiveTv(start = new Date(), pinnedToNow = true) {
  if (!state.iptvEnabled || !canAccessLiveTv()) {
    return;
  }

  stopLibraryLoading();
  closeDetails();
  state.iptvGuideStart = roundedGuideStart(new Date(start));
  state.iptvGuidePinnedToNow = pinnedToNow;
  recordRoute(navigation.liveTvPath(state.iptvGuideStart, pinnedToNow));
  state.currentView = "iptv";
  document.body.classList.add("live-tv-page");
  els.searchInput.value = "";
  els.searchResults.classList.add("hidden");
  els.homeToolbar.classList.add("hidden");
  els.homeRows.classList.add("hidden");
  els.liveTvView.classList.remove("hidden");
  await refreshLiveTvGuide({ showLoading: true });
  startLiveTvAutoRefresh();
}

async function refreshLiveTvGuide(options = {}) {
  if (state.currentView !== "iptv") {
    return;
  }
  if (state.iptvGuidePinnedToNow) {
    state.iptvGuideStart = roundedGuideStart(new Date());
  }
  const guideStart = state.iptvGuideStart || roundedGuideStart(new Date());
  const requestId = ++liveTvRequestId;
  const previousScroll = options.preserveScroll ? liveTvScrollPosition() : null;
  if (options.showLoading) {
    els.liveTvStatus.textContent = "Loading guide...";
    els.liveTvGuide.innerHTML = "";
  }
  try {
    const guide = await api(`/api/iptv/guide?start=${encodeURIComponent(guideStart.toISOString())}&hours=6`);
    if (requestId !== liveTvRequestId || state.currentView !== "iptv") {
      return;
    }
    state.iptvGuide = guide;
    state.iptvBufferSeconds = Number(guide.bufferSeconds) || 180;
    state.iptvSegmentSeconds = Number(guide.segmentSeconds) || 6;
    filterLiveTvChannels();
    restoreLiveTvScroll(previousScroll);
  } catch (err) {
    els.liveTvStatus.textContent = err.message || "The TV guide could not be loaded.";
  }
}

function shiftLiveTvGuide(hours) {
  const start = state.iptvGuideStart || roundedGuideStart(new Date());
  openLiveTv(new Date(start.getTime() + hours * 60 * 60 * 1000), false);
}

function hideLiveTvView() {
  stopLiveTvAutoRefresh();
  liveTvRequestId += 1;
  document.body.classList.remove("live-tv-page");
  els.liveTvView.classList.add("hidden");
}

function startLiveTvAutoRefresh() {
  stopLiveTvAutoRefresh();
  liveTvRefreshTimer = setInterval(() => {
    if (liveTvRefreshPromise) {
      return;
    }
    liveTvRefreshPromise = refreshLiveTvGuide({ preserveScroll: true })
      .catch(() => {})
      .finally(() => {
        liveTvRefreshPromise = null;
      });
  }, 60 * 1000);
}

function stopLiveTvAutoRefresh() {
  if (liveTvRefreshTimer) {
    clearInterval(liveTvRefreshTimer);
    liveTvRefreshTimer = null;
  }
}

function liveTvScrollPosition() {
  const guide = els.liveTvGuide.querySelector(".guide-scroll");
  return guide ? { left: guide.scrollLeft, top: guide.scrollTop } : null;
}

function restoreLiveTvScroll(position) {
  if (!position) {
    return;
  }
  const guide = els.liveTvGuide.querySelector(".guide-scroll");
  if (guide) {
    guide.scrollLeft = position.left;
    guide.scrollTop = position.top;
  }
}

function filterLiveTvChannels() {
  if (!state.iptvGuide) {
    return;
  }
  const query = normalizeFilterText(els.liveTvFilter.value);
  const channels = query
    ? state.iptvGuide.channels.filter((channel) => normalizeFilterText(`${channel.name} ${channel.number || ""} ${channel.group || ""}`).includes(query))
    : state.iptvGuide.channels;
  renderLiveTvGuide({
    ...state.iptvGuide,
    channels,
    filterApplied: Boolean(query)
  });
  const countText = query ? `${channels.length} of ${state.iptvGuide.channelCount} channels` : `${state.iptvGuide.channelCount} channels`;
  els.liveTvStatus.textContent = state.iptvGuide.refreshedAt
    ? `${countText} - guide refreshed ${formatDate(state.iptvGuide.refreshedAt)}`
    : countText;
}

function normalizeFilterText(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function renderLiveTvGuide(guide) {
  const startMs = Date.parse(guide.start);
  const endMs = Date.parse(guide.end);
  const durationMs = Math.max(1, endMs - startMs);
  const width = Math.max(960, Math.round(durationMs / 60000) * 4);
  const shell = document.createElement("div");
  shell.className = "guide-scroll";
  shell.style.setProperty("--guide-min-width", `${width}px`);

  const timeRow = document.createElement("div");
  timeRow.className = "guide-row guide-time-row";
  timeRow.innerHTML = `<div class="guide-channel-cell guide-time-corner">Channel</div><div class="guide-track guide-time-track">${guideTimeTicks(startMs, endMs)}</div>`;
  shell.appendChild(timeRow);

  for (const channel of guide.channels || []) {
    const row = document.createElement("div");
    row.className = "guide-row";
    const channelCell = document.createElement("button");
    channelCell.className = "guide-channel-cell";
    channelCell.type = "button";
    channelCell.innerHTML = `
      ${channel.logo ? `<img src="${escapeHtml(channel.logo)}" alt="">` : `<span class="guide-channel-initials">${escapeHtml(initials(channel.name))}</span>`}
      <span><strong>${escapeHtml(channel.name)}</strong>${channel.number ? `<small>${escapeHtml(channel.number)}</small>` : ""}</span>
    `;
    channelCell.addEventListener("click", () => playIptvChannel(channel));

    const track = document.createElement("div");
    track.className = "guide-track";
    track.innerHTML = guideProgrammeBlocks(channel, startMs, endMs, durationMs);
    track.querySelectorAll("[data-programme-index]").forEach((button) => {
      const programme = channel.programmes[Number(button.dataset.programmeIndex)];
      button.addEventListener("click", () => playIptvChannel(channel, programme));
    });
    addGuideNowLine(track, startMs, endMs);
    row.append(channelCell, track);
    shell.appendChild(row);
  }

  if (!guide.channels || guide.channels.length === 0) {
    shell.innerHTML = `<p class="guide-empty">${guide.filterApplied ? "No channels match this filter." : "No channels were found in the configured source."}</p>`;
  }
  els.liveTvGuide.replaceChildren(shell);
}

function guideTimeTicks(startMs, endMs) {
  const ticks = [];
  const firstTick = Math.ceil(startMs / (30 * 60 * 1000)) * 30 * 60 * 1000;
  for (let at = firstTick; at < endMs; at += 30 * 60 * 1000) {
    const left = ((at - startMs) / (endMs - startMs)) * 100;
    ticks.push(`<span style="left:${left}%">${escapeHtml(new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }))}</span>`);
  }
  return ticks.join("");
}

function guideProgrammeBlocks(channel, startMs, endMs, durationMs) {
  if (!channel.programmes || channel.programmes.length === 0) {
    return '<button class="guide-programme guide-programme-empty" type="button" data-programme-index="-1" style="left:0;width:100%"><strong>No guide data</strong><span>Play channel</span></button>';
  }

  return channel.programmes.map((programme, index) => {
    const programmeStart = Math.max(startMs, Date.parse(programme.start));
    const programmeEnd = Math.min(endMs, Date.parse(programme.stop));
    const left = ((programmeStart - startMs) / durationMs) * 100;
    const width = Math.max(0.8, ((programmeEnd - programmeStart) / durationMs) * 100);
    const current = Date.now() >= Date.parse(programme.start) && Date.now() < Date.parse(programme.stop);
    return `
      <button class="guide-programme${current ? " current" : ""}" type="button" data-programme-index="${index}" style="left:${left}%;width:${width}%" title="${escapeHtml(programme.description || programme.title)}">
        <strong>${escapeHtml(programme.title)}</strong>
        <span>${escapeHtml(new Date(programme.start).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }))}${programme.category ? ` - ${escapeHtml(programme.category)}` : ""}</span>
      </button>
    `;
  }).join("");
}

function addGuideNowLine(track, startMs, endMs) {
  const now = Date.now();
  if (now < startMs || now >= endMs) {
    return;
  }
  const line = document.createElement("span");
  line.className = "guide-now-line";
  line.style.left = `${((now - startMs) / (endMs - startMs)) * 100}%`;
  track.appendChild(line);
}

function roundedGuideStart(date) {
  const rounded = new Date(date);
  rounded.setMinutes(0, 0, 0);
  return rounded;
}

function playIptvChannel(channel, programme = null) {
  const auth = authQuery();
  const url = new URL(`/api/iptv/channels/${encodeURIComponent(channel.id)}/master.m3u8`, window.location.origin);
  url.searchParams.set(auth.name, auth.value);
  const bufferSeconds = Math.max(10, Number(state.iptvBufferSeconds) || 180);
  const segmentSeconds = Math.max(2, Number(state.iptvSegmentSeconds) || 6);
  const liveSyncSegments = Math.max(2, Math.ceil(Math.min(12, bufferSeconds) / segmentSeconds));
  const liveMaxLatencySegments = Math.max(liveSyncSegments + 4, Math.ceil(Math.max(30, bufferSeconds) / segmentSeconds));
  openWebPlayer(url, {
    category: channel.group || "Live TV",
    title: programme && programme.title ? `${channel.name} - ${programme.title}` : channel.name,
    errorMessage: "The live channel could not be played.",
    fallbackUrl: fallbackWebPlayerUrl(),
    live: true,
    onPlaybackError: (details) => reportIptvPlaybackError(channel, details),
    hlsOptions: {
      lowLatencyMode: false,
      manifestLoadingTimeOut: 30000,
      manifestLoadingMaxRetry: 6,
      manifestLoadingRetryDelay: 1000,
      levelLoadingMaxRetry: 6,
      fragLoadingMaxRetry: 6,
      backBufferLength: Math.max(60, bufferSeconds),
      maxBufferLength: Math.max(30, bufferSeconds),
      maxMaxBufferLength: Math.max(120, bufferSeconds * 2),
      liveSyncDurationCount: liveSyncSegments,
      liveMaxLatencyDurationCount: liveMaxLatencySegments
    }
  });
}

async function openAdminPanel(page = "accounts") {
  if (!hasPermission("canViewAdmin")) {
    return;
  }

  els.adminPanelOverlay.classList.remove("hidden");
  els.adminPanelOverlay.setAttribute("aria-hidden", "false");
  document.body.classList.add("admin-panel-open");
  showAdminPage(page);
}

function closeAdminPanel() {
  closeIptvMatcher();
  closeBackupFolderPicker();
  els.adminPanelOverlay.classList.add("hidden");
  els.adminPanelOverlay.setAttribute("aria-hidden", "true");
  document.body.classList.remove("admin-panel-open");
  stopAdminRefresh();
}

function showAdminPage(page) {
  stopAdminRefresh();
  if (page === "accounts" && !hasPermission("canManageUsers")) {
    page = firstAllowedAdminPage();
  }
  if (page === "apiKeys" && !hasPermission("canManageApiKeys")) {
    page = firstAllowedAdminPage();
  }
  if (page === "settings" && !hasPermission("canManageSettings")) {
    page = firstAllowedAdminPage();
  }
  if (page === "duplicates" && !hasPermission("canManageMetadata")) {
    page = firstAllowedAdminPage();
  }
  if (page === "backups" && !hasPermission("canManageBackups")) {
    page = firstAllowedAdminPage();
  }
  if (page === "hardware" && !hasPermission("canViewHardware")) {
    page = firstAllowedAdminPage();
  }
  if (page === "currentlyPlaying" && !hasPermission("canViewUserHistory")) {
    page = firstAllowedAdminPage();
  }
  if (page === "logs" && !hasPermission("canViewLogs")) {
    page = firstAllowedAdminPage();
  }
  if (page === "history" && !hasPermission("canViewUserHistory")) {
    page = firstAllowedAdminPage();
  }
  const pages = {
    accounts: els.adminAccountsPage,
    apiKeys: els.adminApiKeysPage,
    libraries: els.adminLibrariesPage,
    duplicates: els.adminDuplicatesPage,
    backups: els.adminBackupsPage,
    settings: els.adminSettingsPage,
    hardware: els.adminHardwarePage,
    currentlyPlaying: els.adminCurrentlyPlayingPage,
    logs: els.adminLogsPage,
    history: els.adminHistoryPage
  };
  Object.values(pages).forEach((element) => element.classList.add("hidden"));
  (pages[page] || pages.accounts).classList.remove("hidden");

  els.adminAccountsTab.classList.toggle("hidden", !hasPermission("canManageUsers"));
  els.adminApiKeysTab.classList.toggle("hidden", !hasPermission("canManageApiKeys"));
  els.adminLibrariesTab.classList.toggle("hidden", !canViewLibraryAdmin());
  els.adminDuplicatesTab.classList.toggle("hidden", !hasPermission("canManageMetadata"));
  els.adminBackupsTab.classList.toggle("hidden", !hasPermission("canManageBackups"));
  els.adminSettingsTab.classList.toggle("hidden", !hasPermission("canManageSettings"));
  els.adminHardwareTab.classList.toggle("hidden", !hasPermission("canViewHardware"));
  els.adminCurrentlyPlayingTab.classList.toggle("hidden", !hasPermission("canViewUserHistory"));
  els.adminLogsTab.classList.toggle("hidden", !hasPermission("canViewLogs"));
  els.adminHistoryTab.classList.toggle("hidden", !hasPermission("canViewUserHistory"));
  setAdminNavState(page);

  if (page === "accounts") {
    loadAccounts();
  } else if (page === "apiKeys") {
    loadApiKeys();
  } else if (page === "libraries") {
    loadLibraryManager();
  } else if (page === "duplicates") {
    loadDuplicates();
  } else if (page === "backups") {
    loadBackups();
    adminRefreshTimer = setInterval(() => loadBackups(false), 2000);
  } else if (page === "settings") {
    loadSettings();
  } else if (page === "hardware") {
    refreshHardware();
    adminRefreshTimer = setInterval(refreshHardware, 2000);
  } else if (page === "currentlyPlaying") {
    refreshCurrentlyPlaying();
    adminRefreshTimer = setInterval(refreshCurrentlyPlaying, 5000);
  } else if (page === "logs") {
    refreshLogs();
    adminRefreshTimer = setInterval(refreshLogs, 2000);
  } else if (page === "history") {
    loadUserHistory();
  }
}

function firstAllowedAdminPage() {
  if (hasPermission("canManageUsers")) return "accounts";
  if (hasPermission("canManageApiKeys")) return "apiKeys";
  if (canViewLibraryAdmin()) return "libraries";
  if (hasPermission("canManageMetadata")) return "duplicates";
  if (hasPermission("canManageBackups")) return "backups";
  if (hasPermission("canManageSettings")) return "settings";
  if (hasPermission("canViewHardware")) return "hardware";
  if (hasPermission("canViewUserHistory")) return "currentlyPlaying";
  if (hasPermission("canViewLogs")) return "logs";
  if (hasPermission("canViewUserHistory")) return "history";
  return "libraries";
}

function stopAdminRefresh() {
  if (adminRefreshTimer) {
    clearInterval(adminRefreshTimer);
    adminRefreshTimer = null;
  }
}

async function loadAccounts() {
  if (!hasPermission("canManageUsers")) {
    return;
  }

  try {
    const data = await api("/api/admin/accounts");
    const libraries = (data.libraries || []).map((library) => ({
      id: library.key,
      label: library.title
    }));
    if (data.features && data.features.iptv) {
      libraries.unshift({ id: LIVE_TV_PERMISSION_KEY, label: "Live TV" });
    }
    fillSelect(els.accountLibrariesSelect, libraries);
    els.accountList.innerHTML = "";
    (data.accounts || []).forEach((account) => els.accountList.appendChild(accountCard(account)));
    if (!els.accountStatus.textContent) {
      setAccountFormMode(null);
    }
  } catch (err) {
    els.accountStatus.textContent = "Failed to load accounts.";
  }
}

function accountCard(account) {
  const editing = els.accountIdInput.value === account.id;
  const cardElement = document.createElement("section");
  cardElement.className = `library-manager-card account-card${editing ? " editing" : ""}`;
  cardElement.dataset.accountId = account.id;
  cardElement.innerHTML = `
    <div class="library-manager-heading">
      <div>
        <h3>${escapeHtml(account.username)}</h3>
        <div class="library-path">${account.permissions.isAdmin ? "Admin" : `${account.permissions.libraries.length} libraries`}</div>
      </div>
      <div class="account-card-actions">
        <button class="secondary-button compact-button edit-account" type="button">${editing ? "Stop editing" : "Edit"}</button>
        <button class="secondary-button compact-button delete-account" type="button">Remove</button>
      </div>
    </div>
  `;
  cardElement.querySelector(".edit-account").addEventListener("click", () => {
    if (els.accountIdInput.value === account.id) {
      resetAccountForm();
      return;
    }
    editAccount(account);
  });
  cardElement.querySelector(".delete-account").addEventListener("click", () => deleteAccount(account));
  return cardElement;
}

function editAccount(account) {
  els.accountIdInput.value = account.id;
  els.accountUsernameInput.value = account.username;
  els.accountPasswordInput.value = "";
  els.accountPasswordInput.placeholder = "Leave blank to keep current password";
  const permissions = account.permissions || {};
  els.accountIsAdmin.checked = Boolean(permissions.isAdmin);
  els.accountCanCopyUrls.checked = Boolean(permissions.canCopyStreamUrls);
  els.accountCanShare.checked = Boolean(permissions.canCreateShareLinks);
  els.accountCanLibraries.checked = Boolean(permissions.canManageLibraries);
  els.accountCanMetadata.checked = Boolean(permissions.canManageMetadata);
  els.accountCanSettings.checked = Boolean(permissions.canManageSettings);
  els.accountCanApiKeys.checked = Boolean(permissions.canManageApiKeys);
  els.accountCanBackups.checked = Boolean(permissions.canManageBackups);
  els.accountCanReindex.checked = Boolean(permissions.canReindex);
  els.accountCanUsers.checked = Boolean(permissions.canManageUsers);
  els.accountCanHardware.checked = Boolean(permissions.canViewHardware);
  els.accountCanLogs.checked = Boolean(permissions.canViewLogs);
  els.accountCanHistory.checked = Boolean(permissions.canViewUserHistory);
  Array.from(els.accountLibrariesSelect.options).forEach((option) => {
    option.selected = (permissions.libraries || []).includes(option.value);
  });
  setAccountFormMode(account);
  els.accountStatus.textContent = "";
  refreshAccountCardStates();
}

function resetAccountForm() {
  els.accountIdInput.value = "";
  els.accountUsernameInput.value = "";
  els.accountPasswordInput.value = "";
  els.accountPasswordInput.placeholder = "Required for new accounts";
  els.accountIsAdmin.checked = false;
  els.accountCanCopyUrls.checked = false;
  els.accountCanShare.checked = false;
  els.accountCanLibraries.checked = false;
  els.accountCanMetadata.checked = false;
  els.accountCanSettings.checked = false;
  els.accountCanApiKeys.checked = false;
  els.accountCanBackups.checked = false;
  els.accountCanReindex.checked = false;
  els.accountCanUsers.checked = false;
  els.accountCanHardware.checked = false;
  els.accountCanLogs.checked = false;
  els.accountCanHistory.checked = false;
  Array.from(els.accountLibrariesSelect.options).forEach((option) => {
    option.selected = false;
  });
  setAccountFormMode(null);
  els.accountStatus.textContent = "";
  refreshAccountCardStates();
}

async function saveAccount(event) {
  event.preventDefault();
  const id = els.accountIdInput.value;
  const username = els.accountUsernameInput.value.trim();
  const password = els.accountPasswordInput.value;
  if (!username) {
    els.accountStatus.textContent = "Username is required.";
    return;
  }
  if (!id && !password) {
    els.accountStatus.textContent = "Password is required for new accounts.";
    return;
  }

  const body = {
    username,
    permissions: accountPermissionsFromForm()
  };
  if (password) {
    body.password = password;
  }

  try {
    await api(id ? `/api/admin/accounts/${encodeURIComponent(id)}` : "/api/admin/accounts", state.token, {
      method: id ? "PUT" : "POST",
      body: JSON.stringify(body)
    });
    resetAccountForm();
    await loadAccounts();
    els.accountStatus.textContent = id ? "Account updated." : "Account created.";
  } catch (err) {
    els.accountStatus.textContent = err.message || "Failed to save account.";
  }
}

function setAccountFormMode(account) {
  if (account) {
    els.accountForm.classList.add("editing");
    els.createAccount.classList.add("hidden");
    els.updateAccount.classList.remove("hidden");
    els.resetAccountForm.textContent = "Stop editing";
    return;
  }

  els.accountForm.classList.remove("editing");
  els.createAccount.classList.remove("hidden");
  els.updateAccount.classList.add("hidden");
  els.resetAccountForm.textContent = "Clear form";
}

function refreshAccountCardStates() {
  const editingId = els.accountIdInput.value;
  els.accountList.querySelectorAll(".account-card").forEach((cardElement) => {
    const editing = cardElement.dataset.accountId === editingId;
    cardElement.classList.toggle("editing", editing);
    const editButton = cardElement.querySelector(".edit-account");
    if (editButton) {
      editButton.textContent = editing ? "Stop editing" : "Edit";
    }
  });
}

function setAdminNavState(page) {
  const tabs = {
    accounts: els.adminAccountsTab,
    apiKeys: els.adminApiKeysTab,
    libraries: els.adminLibrariesTab,
    duplicates: els.adminDuplicatesTab,
    backups: els.adminBackupsTab,
    hardware: els.adminHardwareTab,
    currentlyPlaying: els.adminCurrentlyPlayingTab,
    logs: els.adminLogsTab,
    settings: els.adminSettingsTab,
    history: els.adminHistoryTab
  };
  Object.entries(tabs).forEach(([key, tab]) => {
    const active = key === page;
    tab.classList.toggle("active", active);
    if (active) {
      tab.setAttribute("aria-current", "page");
    } else {
      tab.removeAttribute("aria-current");
    }
  });
}

function accountPermissionsFromForm() {
  const canViewAdmin = els.accountIsAdmin.checked
    || els.accountCanShare.checked
    || els.accountCanLibraries.checked
    || els.accountCanMetadata.checked
    || els.accountCanSettings.checked
    || els.accountCanApiKeys.checked
    || els.accountCanBackups.checked
    || els.accountCanReindex.checked
    || els.accountCanUsers.checked
    || els.accountCanHardware.checked
    || els.accountCanLogs.checked
    || els.accountCanHistory.checked;
  return {
    isAdmin: els.accountIsAdmin.checked,
    canCopyStreamUrls: els.accountCanCopyUrls.checked,
    canCreateShareLinks: els.accountCanShare.checked,
    canManageLibraries: els.accountCanLibraries.checked,
    canManageMetadata: els.accountCanMetadata.checked,
    canManageSettings: els.accountCanSettings.checked,
    canManageApiKeys: els.accountCanApiKeys.checked,
    canManageBackups: els.accountCanBackups.checked,
    canReindex: els.accountCanReindex.checked,
    canManageUsers: els.accountCanUsers.checked,
    canViewAdmin,
    canViewHardware: els.accountCanHardware.checked,
    canViewLogs: els.accountCanLogs.checked,
    canViewUserHistory: els.accountCanHistory.checked,
    libraries: Array.from(els.accountLibrariesSelect.selectedOptions).map((option) => option.value)
  };
}

async function loadApiKeys() {
  if (!hasPermission("canManageApiKeys")) {
    return;
  }

  els.apiKeyStatus.textContent = "Loading API keys...";
  els.apiKeyList.innerHTML = "";
  els.apiKeySecretPanel.classList.add("hidden");

  try {
    const data = await api("/api/admin/api-keys");
    fillSelect(els.apiKeyUserSelect, (data.accounts || []).map((account) => ({
      id: account.id,
      label: account.username
    })));
    els.apiKeyList.innerHTML = "";
    (data.apiKeys || []).forEach((apiKey) => els.apiKeyList.appendChild(apiKeyCard(apiKey)));
    els.apiKeyStatus.textContent = (data.apiKeys || []).length === 0 ? "No API keys created yet." : "";
  } catch (err) {
    els.apiKeyStatus.textContent = err.message || "Failed to load API keys.";
  }
}

function apiKeyCard(apiKey) {
  const cardElement = document.createElement("section");
  cardElement.className = `library-manager-card api-key-card${apiKey.revokedAt ? " revoked" : ""}`;
  cardElement.innerHTML = `
    <div class="library-manager-heading">
      <div>
        <h3>${escapeHtml(apiKey.name)}</h3>
        <div class="library-path">${escapeHtml(apiKey.username)} - ${apiKey.revokedAt ? `Revoked ${escapeHtml(formatDate(apiKey.revokedAt))}` : `Created ${escapeHtml(formatDate(apiKey.createdAt))}`}</div>
      </div>
      ${apiKey.revokedAt ? "" : '<button class="secondary-button compact-button revoke-api-key" type="button">Revoke</button>'}
    </div>
  `;
  const revokeButton = cardElement.querySelector(".revoke-api-key");
  if (revokeButton) {
    revokeButton.addEventListener("click", () => revokeApiKey(apiKey));
  }
  return cardElement;
}

async function createApiKey(event) {
  event.preventDefault();
  const userId = els.apiKeyUserSelect.value;
  const name = els.apiKeyNameInput.value.trim();
  if (!userId || !name) {
    els.apiKeyStatus.textContent = "Choose a user and enter a key name.";
    return;
  }

  els.createApiKey.disabled = true;
  els.apiKeyStatus.textContent = "Creating API key...";
  try {
    const result = await api("/api/admin/api-keys", state.token, {
      method: "POST",
      body: JSON.stringify({ userId, name })
    });
    els.apiKeyNameInput.value = "";
    els.apiKeySecretValue.textContent = result.token;
    els.apiKeySecretPanel.classList.remove("hidden");
    await copyText(result.token);
    await loadApiKeys();
    els.apiKeySecretValue.textContent = result.token;
    els.apiKeySecretPanel.classList.remove("hidden");
    els.apiKeyStatus.textContent = "API key created and copied. It will only be shown once.";
  } catch (err) {
    els.apiKeyStatus.textContent = err.message || "Failed to create API key.";
  } finally {
    els.createApiKey.disabled = false;
  }
}

async function copyNewApiKey() {
  const value = els.apiKeySecretValue.textContent;
  if (!value) {
    return;
  }
  await copyText(value);
  els.apiKeyStatus.textContent = "API key copied.";
}

async function revokeApiKey(apiKey) {
  if (!window.confirm(`Revoke API key "${apiKey.name}"?`)) {
    return;
  }

  els.apiKeyStatus.textContent = "Revoking API key...";
  try {
    await api(`/api/admin/api-keys/${encodeURIComponent(apiKey.id)}`, state.token, { method: "DELETE" });
    await loadApiKeys();
    els.apiKeyStatus.textContent = "API key revoked.";
  } catch (err) {
    els.apiKeyStatus.textContent = err.message || "Failed to revoke API key.";
  }
}

async function loadDuplicates() {
  if (!hasPermission("canManageMetadata")) {
    return;
  }

  els.refreshDuplicates.disabled = true;
  els.duplicatesStatus.textContent = "Finding duplicates from matched metadata...";
  els.duplicatesList.innerHTML = "";

  try {
    const data = await api("/api/admin/duplicates");
    renderDuplicates(data);
  } catch (err) {
    els.duplicatesStatus.textContent = err.message || "Failed to load duplicates.";
  } finally {
    els.refreshDuplicates.disabled = false;
  }
}

function renderDuplicates(data) {
  const groups = data.groups || [];
  els.duplicatesList.innerHTML = "";
  els.duplicatesStatus.textContent = `${groups.length} duplicate groups from ${data.matched || 0} matched files (${data.scanned || 0} indexed files scanned).`;

  if (groups.length === 0) {
    const empty = document.createElement("p");
    empty.className = "status";
    empty.textContent = "No metadata-matched duplicates found.";
    els.duplicatesList.appendChild(empty);
    return;
  }

  groups.forEach((group) => {
    const section = document.createElement("section");
    section.className = "duplicate-group";
    section.innerHTML = `
      <div class="duplicate-heading">
        <div>
          <h3>${escapeHtml(group.title || "Untitled")}</h3>
          <p class="library-path">${escapeHtml(group.subtitle || group.kind)} - ${escapeHtml(group.provider)}:${escapeHtml(group.providerId)} - ${group.count} files</p>
        </div>
      </div>
      <div class="duplicate-items"></div>
    `;
    const items = section.querySelector(".duplicate-items");
    (group.items || []).forEach((item) => {
      const row = document.createElement("button");
      row.className = "duplicate-row";
      row.type = "button";
      row.innerHTML = `
        <span>
          <strong>${escapeHtml(item.libraryTitle)}</strong>
          <small>${escapeHtml(item.subtitle || item.title || item.filename)}</small>
        </span>
        <code>${escapeHtml(item.filePath)}</code>
      `;
      row.addEventListener("click", () => {
        els.duplicatesStatus.textContent = item.filePath;
      });
      items.appendChild(row);
    });
    els.duplicatesList.appendChild(section);
  });
}

async function loadBackups(showLoading = true) {
  if (!hasPermission("canManageBackups")) return;
  if (showLoading) {
    els.backupStatus.textContent = "Loading backups...";
  }
  try {
    const data = await api("/api/admin/backups");
    const finishedSinceLastRefresh = backupWasRunning && !data.running;
    backupWasRunning = Boolean(data.running);
    if (showLoading || finishedSinceLastRefresh) {
      fillBackupSettings(data.settings || {});
      renderBackups(data.backups || []);
    }
    renderBackupProgress(data.progress, data.running);
    els.createBackup.disabled = Boolean(data.running || data.restoring);
    if (data.restoring) {
      els.backupStatus.textContent = "A database restore is running.";
    } else if (data.running) {
      els.backupStatus.textContent = "A backup is currently running.";
    } else if (data.lastResult && !data.lastResult.ok) {
      els.backupStatus.textContent = `Last operation failed: ${data.lastResult.error}`;
    } else if (showLoading) {
      els.backupStatus.textContent = "";
    }
  } catch (err) {
    els.backupStatus.textContent = err.message || "Failed to load backups.";
  }
}

function fillBackupSettings(settings) {
  els.backupDirectory.value = settings.directory || "";
  els.backupRetention.value = settings.retentionCount || 7;
  els.backupScheduleEnabled.checked = Boolean(settings.enabled);
  els.backupTime.value = settings.time || "03:00";
  const selectedDays = new Set((settings.days || []).map(Number));
  els.backupDays.forEach((checkbox) => {
    checkbox.checked = selectedDays.has(Number(checkbox.value));
  });
  updateBackupScheduleVisibility();
}

function updateBackupScheduleVisibility() {
  els.backupScheduleBody.classList.toggle("hidden", !els.backupScheduleEnabled.checked);
}

async function saveBackupSettings(event) {
  event.preventDefault();
  const days = [...els.backupDays].filter((checkbox) => checkbox.checked).map((checkbox) => Number(checkbox.value));
  if (els.backupScheduleEnabled.checked && days.length === 0) {
    els.backupStatus.textContent = "Select at least one backup day.";
    return;
  }
  els.backupStatus.textContent = "Saving backup settings...";
  try {
    const data = await api("/api/admin/backups/settings", state.token, {
      method: "PUT",
      body: JSON.stringify({
        enabled: els.backupScheduleEnabled.checked,
        directory: els.backupDirectory.value,
        time: els.backupTime.value,
        days,
        retentionCount: Number.parseInt(els.backupRetention.value, 10) || 7
      })
    });
    fillBackupSettings(data.settings || {});
    renderBackups(data.backups || []);
    els.backupStatus.textContent = "Backup settings saved.";
  } catch (err) {
    els.backupStatus.textContent = err.message || "Failed to save backup settings.";
  }
}

async function createBackupNow() {
  els.createBackup.disabled = true;
  els.backupStatus.textContent = "Backing up the database...";
  try {
    const started = await api("/api/admin/backups", state.token, { method: "POST" });
    renderBackupProgress(started.progress, true);
    await waitForBackupCompletion();
  } catch (err) {
    els.backupStatus.textContent = err.message || "Backup failed.";
  } finally {
    els.createBackup.disabled = false;
  }
}

async function waitForBackupCompletion() {
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const data = await api("/api/admin/backups");
    renderBackupProgress(data.progress, data.running);
    if (data.running) {
      els.backupStatus.textContent = "Backing up the database...";
      continue;
    }
    fillBackupSettings(data.settings || {});
    renderBackups(data.backups || []);
    if (data.lastResult && !data.lastResult.ok) {
      throw new Error(data.lastResult.error || "Backup failed.");
    }
    els.backupStatus.textContent = "Backup completed.";
    return;
  }
}

function renderBackupProgress(progress, running) {
  if (!running || !progress) {
    els.backupProgress.classList.add("hidden");
    els.backupProgress.removeAttribute("aria-valuenow");
    return;
  }

  const percent = Math.max(0, Math.min(100, Number(progress.percent) || 0));
  const phase = String(progress.phase || "preparing").replace(/_/g, " ");
  const current = progress.current ? ` - ${progress.current}` : "";
  els.backupProgress.classList.remove("hidden");
  els.backupProgress.setAttribute("aria-valuenow", String(percent));
  els.backupProgressFill.style.setProperty("--progress", `${percent}%`);
  els.backupProgressText.textContent = `${phase.charAt(0).toUpperCase()}${phase.slice(1)}${current} (${percent.toFixed(percent % 1 ? 1 : 0)}%)`;
  const elapsed = Number(progress.elapsedSeconds) || 0;
  const hasEta = progress.etaSeconds !== null && progress.etaSeconds !== undefined;
  const eta = Number(progress.etaSeconds);
  els.backupProgressEta.textContent = hasEta && Number.isFinite(eta)
    ? `Elapsed ${formatDuration(elapsed)} - ETA ${formatDuration(eta)}`
    : `Elapsed ${formatDuration(elapsed)} - calculating ETA...`;
}

function renderBackups(backups) {
  els.backupList.innerHTML = "";
  if (backups.length === 0) {
    els.backupList.innerHTML = '<p class="status">No backups in this directory.</p>';
    return;
  }
  backups.forEach((backup) => {
    const card = document.createElement("section");
    card.className = "library-manager-card";
    card.innerHTML = `
      <div class="library-manager-heading">
        <div>
          <h3>${escapeHtml(backup.filename)}</h3>
          <div class="backup-card-meta">${escapeHtml(new Date(backup.createdAt).toLocaleString())} - ${formatBytes(backup.size)}</div>
        </div>
        <button class="secondary-button compact-button restore-backup" type="button">Restore</button>
      </div>
    `;
    card.querySelector(".restore-backup").addEventListener("click", () => restoreBackup(backup));
    els.backupList.appendChild(card);
  });
}

async function restoreBackup(backup) {
  if (!window.confirm(`Restore ${backup.filename}? This will completely replace the current database and restart Media Baker.`)) return;
  els.backupStatus.textContent = "Restoring the database...";
  els.backupList.querySelectorAll("button").forEach((button) => { button.disabled = true; });
  try {
    await api(`/api/admin/backups/${encodeURIComponent(backup.filename)}/restore`, state.token, {
      method: "POST",
      body: JSON.stringify({ confirm: true })
    });
    els.backupStatus.textContent = "Restore complete. Media Baker is restarting...";
    setTimeout(() => window.location.reload(), 3500);
  } catch (err) {
    els.backupStatus.textContent = err.message || "Restore failed.";
    els.backupList.querySelectorAll("button").forEach((button) => { button.disabled = false; });
  }
}

async function openBackupFolderPicker() {
  els.backupFolderPicker.classList.remove("hidden");
  await loadBackupFolderPicker(els.backupDirectory.value.trim());
}

function closeBackupFolderPicker() {
  els.backupFolderPicker.classList.add("hidden");
}

async function loadBackupFolderPicker(pathValue) {
  els.backupFolderPath.textContent = "Loading...";
  els.backupFolderList.innerHTML = "";
  els.backupFolderRoots.innerHTML = "";
  els.backupFolderParent.disabled = true;
  els.selectBackupFolder.disabled = true;
  try {
    const params = new URLSearchParams();
    if (pathValue) params.set("path", pathValue);
    const data = await api(`/api/admin/backup-folders${params.toString() ? `?${params}` : ""}`);
    backupFolderPickerPath = data.path || "";
    els.backupFolderPath.textContent = data.error
      ? `${data.attemptedPath || pathValue} - ${data.error}`
      : backupFolderPickerPath;
    els.backupFolderParent.disabled = !data.parent;
    els.backupFolderParent.dataset.path = data.parent || "";
    els.selectBackupFolder.disabled = !backupFolderPickerPath;
    (data.roots || []).forEach((root) => {
      const button = document.createElement("button");
      button.className = "secondary-button compact-button";
      button.type = "button";
      button.textContent = root.name;
      button.addEventListener("click", () => loadBackupFolderPicker(root.path));
      els.backupFolderRoots.appendChild(button);
    });
    if (data.error) {
      els.backupFolderList.innerHTML = '<p class="status">Choose an available root above.</p>';
    } else if (!(data.directories || []).length) {
      els.backupFolderList.innerHTML = '<p class="status">No child folders.</p>';
    }
    (data.directories || []).forEach((directory) => {
      const button = document.createElement("button");
      button.className = "folder-row";
      button.type = "button";
      button.innerHTML = `<span>${escapeHtml(directory.name)}</span><small>${escapeHtml(directory.path)}</small>`;
      button.addEventListener("click", () => loadBackupFolderPicker(directory.path));
      els.backupFolderList.appendChild(button);
    });
  } catch (err) {
    els.backupFolderPath.textContent = "Could not open folder.";
    els.backupFolderList.innerHTML = '<p class="status">This folder could not be read.</p>';
  }
}

function selectBackupFolder() {
  if (!backupFolderPickerPath) return;
  els.backupDirectory.value = backupFolderPickerPath;
  closeBackupFolderPicker();
}

async function loadSettings() {
  if (!hasPermission("canManageSettings")) {
    return;
  }

  els.settingsStatus.textContent = "Loading settings...";
  try {
    const data = await api("/api/admin/settings");
    fillSettingsForm(data.settings || {});
    updateSettingsVisibility();
    await refreshUpdateStatus();
    els.settingsStatus.textContent = "";
  } catch (err) {
    els.settingsStatus.textContent = err.message || "Failed to load settings.";
  }
}

function fillSettingsForm(settings) {
  const logging = settings.logging || {};
  const indexScan = settings.indexScan || {};
  const metadata = settings.metadata || {};
  const subtitles = settings.subtitles || {};
  const sync = subtitles.sync || {};
  const playback = settings.playback || {};
  const hls = settings.hls || {};
  const fallbackStream = settings.fallbackStream || {};
  const ffmpeg = settings.ffmpeg || {};
  const streaming = settings.streaming || {};
  const ytdlp = settings.ytdlp || {};
  const iptv = settings.iptv || {};
  const updates = settings.updates || {};

  els.settingsLogLevel.value = logging.level || "info";
  els.settingsLogRetentionDays.value = logging.retentionDays ?? 5;
  els.settingsPreferredAudio.value = streaming.preferredAudioLanguage || "english";
  els.settingsEnableGpu.checked = ffmpeg.enableGpu !== false;
  els.settingsUpdatesEnabled.checked = updates.enabled !== false;
  els.settingsUpdateIntervalHours.value = Math.max(1, Math.round((updates.checkIntervalSeconds ?? 21600) / 3600));
  els.settingsIncludePrereleases.checked = Boolean(updates.includePrereleases);
  els.settingsAutoInstall.checked = Boolean(updates.autoInstall);
  els.settingsMetadataEnabled.checked = Boolean(metadata.enabled);
  els.settingsTmdbApiKey.value = metadata.tmdbApiKey || "";
  els.settingsTmdbReadToken.value = metadata.tmdbReadAccessToken || "";
  els.settingsMetadataLanguage.value = metadata.language || "en-US";
  els.settingsPosterSize.value = metadata.posterSize || "w500";
  els.settingsThumbnailSize.value = metadata.thumbnailSize || "w300";
  els.settingsPosterLanguages.value = (metadata.posterLanguages || ["en", "null", "ja"]).join(", ");
  els.settingsMetadataDelay.value = metadata.requestDelayMs ?? 250;
  els.settingsMetadataPreload.checked = metadata.preloadOnStartup !== false;
  els.settingsSubtitlesEnabled.checked = Boolean(subtitles.enabled);
  els.settingsSubtitleProvider.value = subtitles.provider || "subdl";
  els.settingsSubdlApiKey.value = subtitles.subdlApiKey || "";
  els.settingsSubtitleUserAgent.value = subtitles.userAgent || "MediaBaker";
  els.settingsSubtitleLanguage.value = subtitles.defaultLanguage || "en";
  els.settingsSubtitleSyncEnabled.checked = sync.enabled !== false;
  els.settingsSubtitleMaxOffset.value = sync.maxOffsetSeconds ?? 900;
  els.settingsSubtitleTimeout.value = sync.timeoutSeconds ?? 900;
  els.settingsYtDlpEnabled.checked = Boolean(ytdlp.enabled);
  els.settingsYtDlpPath.value = ytdlp.downloadPath || "cache/yt-dlp";
  els.settingsYtDlpTitle.value = ytdlp.libraryTitle || "YT-DLP";
  els.settingsYtDlpPlaylists.checked = Boolean(ytdlp.allowPlaylists);
  els.settingsIptvEnabled.checked = Boolean(iptv.enabled);
  els.settingsIptvSourceType.value = iptv.sourceType === "hdhomerun" ? "hdhomerun" : "m3u";
  els.settingsIptvPlaylistUrl.value = iptv.playlistUrl || "";
  els.settingsIptvHdHomeRunUrl.value = iptv.hdHomeRunUrl || "";
  els.settingsIptvGuideUrl.value = iptv.guideUrl || "";
  state.iptvChannelMappings = { ...(iptv.channelMappings || {}) };
  state.iptvChannelDeinterlaceModes = { ...(iptv.channelDeinterlaceModes || {}) };
  els.settingsIptvRefreshHours.value = Math.max(1, Math.round((iptv.refreshIntervalSeconds ?? 86400) / 3600));
  els.settingsIptvBufferSeconds.value = iptv.bufferSeconds ?? 180;
  els.settingsIptvSegmentSeconds.value = iptv.segmentSeconds ?? 6;
  els.settingsIptvDeinterlaceMode.value = ["off", "auto", "force", "smooth"].includes(iptv.deinterlaceMode) ? iptv.deinterlaceMode : "auto";
  els.settingsHlsTtl.value = hls.ttlSeconds ?? 86400;
  els.settingsHlsSegment.value = hls.segmentSeconds ?? 6;
  els.settingsHlsWait.value = hls.segmentWaitTimeoutSeconds ?? 90;
  els.settingsForceTranscode.checked = Boolean(hls.forceTranscodeCompatibleVideo);
  els.settingsOnDeckTtl.value = playback.onDeckTtlSeconds ?? 1209600;
  els.settingsWatchedThreshold.value = playback.watchedThresholdPercent ?? 10;
  els.settingsIndexEnabled.checked = indexScan.enabled !== false;
  els.settingsIndexInterval.value = indexScan.intervalSeconds ?? 900;
  els.settingsIndexStartup.checked = Boolean(indexScan.runOnStartup);
  els.settingsFallbackEnabled.checked = fallbackStream.enabled !== false;
  els.settingsFallbackSegment.value = fallbackStream.segmentSeconds ?? 4;
}

async function saveSettings(event) {
  event.preventDefault();
  els.saveSettings.disabled = true;
  els.settingsStatus.textContent = "Saving settings...";

  try {
    const result = await api("/api/admin/settings", state.token, {
      method: "PUT",
      body: JSON.stringify({ settings: settingsFromForm() })
    });
    fillSettingsForm(result.settings || {});
    applyFeatures({
      iptv: Boolean(result.settings && result.settings.iptv && result.settings.iptv.enabled),
      ytdlp: Boolean(result.settings && result.settings.ytdlp && result.settings.ytdlp.enabled)
    });
    updateSettingsVisibility();
    await refreshIptvAvailability();
    await refreshSystemHealth();
    await refreshUpdateStatus();
    els.settingsStatus.textContent = "Settings saved.";
  } catch (err) {
    els.settingsStatus.textContent = err.message || "Failed to save settings.";
  } finally {
    els.saveSettings.disabled = false;
  }
}

async function forceCheckForUpdates() {
  els.settingsCheckUpdates.disabled = true;
  els.settingsUpdateStatus.textContent = "Checking GitHub releases...";
  try {
    await refreshUpdateStatus(true);
  } finally {
    els.settingsCheckUpdates.disabled = false;
  }
}

async function installAvailableUpdate() {
  const status = state.updateStatus;
  if (!status || !status.latest || !status.updateAvailable || !status.autoUpdateSupported) {
    return;
  }
  if (!window.confirm(`Install Media Baker ${status.latest.version}? Active streams will stop while the server restarts.`)) {
    return;
  }

  els.settingsInstallUpdate.disabled = true;
  els.installUpdateBanner.disabled = true;
  els.settingsUpdateStatus.textContent = `Downloading and preparing Media Baker ${status.latest.version}...`;
  try {
    await api("/api/admin/updates/install", state.token, { method: "POST" });
    els.settingsUpdateStatus.textContent = "Update prepared. Waiting for Media Baker to restart...";
    await waitForUpdatedServer(status.latest.version);
  } catch (err) {
    els.settingsUpdateStatus.textContent = err.message || "Failed to install the update.";
    els.settingsInstallUpdate.disabled = false;
    els.installUpdateBanner.disabled = false;
  }
}

async function waitForUpdatedServer(version) {
  const deadline = Date.now() + 3 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => window.setTimeout(resolve, 2000));
    try {
      const status = await api("/api/admin/updates/status");
      if (status.currentVersion === version) {
        window.location.reload();
        return;
      }
    } catch (err) {
      // The server is expected to be briefly unavailable while files are replaced.
    }
  }
  throw new Error("Media Baker did not return after the update. Check cache/updates/update.log.");
}

async function forceReloadIptvSources() {
  els.settingsIptvReload.disabled = true;
  els.settingsStatus.textContent = "Reloading the saved channel sources...";
  try {
    const result = await api("/api/admin/settings/iptv/refresh", state.token, { method: "POST" });
    const status = result.status || {};
    els.settingsStatus.textContent = `IPTV sources reloaded. ${status.channelCount || 0} channels found.`;
    await refreshIptvAvailability();
    if (state.currentView === "iptv") {
      await refreshLiveTvGuide({ preserveScroll: true });
    }
  } catch (err) {
    els.settingsStatus.textContent = err.message || "Failed to reload IPTV sources.";
  } finally {
    els.settingsIptvReload.disabled = false;
  }
}

async function openIptvMatcher() {
  els.iptvMatchOverlay.classList.remove("hidden");
  els.iptvMatchOverlay.setAttribute("aria-hidden", "false");
  els.iptvChannelFilter.value = "";
  els.iptvGuideFilter.value = "";
  els.iptvChannelSelect.innerHTML = "";
  els.iptvGuideSelect.innerHTML = "";
  els.iptvMatchStatus.textContent = "Loading channel matches...";
  setIptvMatcherBusy(true);
  try {
    state.iptvMatchData = await api("/api/admin/settings/iptv/channel-matches");
    prepareIptvMatchData();
    syncIptvChannelMappings();
    renderIptvChannelOptions();
  } catch (err) {
    state.iptvMatchData = null;
    els.iptvMatchStatus.textContent = err.message || "Failed to load IPTV channel matches.";
  } finally {
    setIptvMatcherBusy(false);
  }
}

function closeIptvMatcher() {
  els.iptvMatchOverlay.classList.add("hidden");
  els.iptvMatchOverlay.setAttribute("aria-hidden", "true");
}

function renderIptvChannelOptions() {
  if (!state.iptvMatchData) {
    return;
  }
  const previous = els.iptvChannelSelect.value;
  const query = normalizeFilterText(els.iptvChannelFilter.value);
  const channels = state.iptvMatchData.channels.filter((channel) => !query
    || channel.searchText.includes(query));
  const visibleChannels = channels.slice(0, 180);
  const selectedChannel = previous && channels.find((channel) => channel.id === previous);
  if (selectedChannel && !visibleChannels.some((channel) => channel.id === previous)) {
    visibleChannels.unshift(selectedChannel);
  }
  els.iptvChannelSelect.replaceChildren(...visibleChannels.map((channel) => {
    const option = document.createElement("option");
    option.value = channel.id;
    const matchType = channel.manualGuideChannelId ? "manual" : channel.guideChannelId ? "automatic" : "unmatched";
    option.textContent = `${channel.number ? `${channel.number} - ` : ""}${channel.name} [${matchType}]`;
    return option;
  }));
  els.iptvChannelResults.textContent = resultCountText(channels.length, visibleChannels.length);
  if (visibleChannels.some((channel) => channel.id === previous)) {
    els.iptvChannelSelect.value = previous;
  } else if (visibleChannels.length > 0) {
    const firstUnmatched = visibleChannels.find((channel) => !channel.guideChannelId);
    els.iptvChannelSelect.value = (firstUnmatched || visibleChannels[0]).id;
  }
  renderIptvGuideOptions(true);
}

function renderIptvGuideOptions(resetSelection = false) {
  const data = state.iptvMatchData;
  const channel = selectedIptvChannel();
  if (!data || !channel) {
    els.iptvGuideSelect.innerHTML = "";
    els.iptvSelectedChannel.textContent = "";
    els.iptvGuideResults.textContent = "";
    els.iptvMatchStatus.textContent = data && data.channels.length ? "No live channels match the filter." : "No live channels are loaded.";
    return;
  }

  const previous = resetSelection ? channel.manualGuideChannelId || "" : els.iptvGuideSelect.value;
  const query = normalizeFilterText(els.iptvGuideFilter.value);
  const matchingGuideChannels = data.guideChannels.filter((guideChannel) => !query || guideChannel.searchText.includes(query));
  const suggestions = channel.guideSuggestions
    .map((suggestion) => ({ ...suggestion, channel: state.iptvGuideById.get(suggestion.id) }))
    .filter((suggestion) => suggestion.channel && (!query || suggestion.channel.searchText.includes(query)));
  const suggestionIds = new Set(suggestions.map((suggestion) => suggestion.id));
  const guideChannels = matchingGuideChannels.filter((guideChannel) => !suggestionIds.has(guideChannel.id)).slice(0, 140);
  const selectedCandidate = previous ? state.iptvGuideById.get(previous) : null;
  if (selectedCandidate && !suggestionIds.has(previous) && !guideChannels.some((guideChannel) => guideChannel.id === previous)) {
    guideChannels.unshift(selectedCandidate);
  }

  const automatic = document.createElement("option");
  automatic.value = "";
  automatic.textContent = `Automatic: ${guideChannelName(channel.automaticGuideChannelId) || "unmatched"}`;
  const suggestionGroup = document.createElement("optgroup");
  suggestionGroup.label = "Best suggestions";
  const suggestionOptions = suggestions.map((suggestion) => {
    const option = document.createElement("option");
    option.value = suggestion.channel.id;
    option.textContent = `${suggestion.channel.name} (${Math.round(suggestion.score * 100)}%) [${suggestion.channel.id}]`;
    return option;
  });
  suggestionGroup.replaceChildren(...suggestionOptions);
  const allGroup = document.createElement("optgroup");
  allGroup.label = query ? "Search results" : "EPG channels";
  const guideOptions = guideChannels.map((guideChannel) => {
    const option = document.createElement("option");
    option.value = guideChannel.id;
    option.textContent = `${guideChannel.name} [${guideChannel.id}]`;
    return option;
  });
  allGroup.replaceChildren(...guideOptions);
  els.iptvGuideSelect.replaceChildren(
    automatic,
    ...(suggestionOptions.length ? [suggestionGroup] : []),
    ...(guideOptions.length ? [allGroup] : [])
  );
  const renderedIds = new Set([...suggestionOptions, ...guideOptions].map((option) => option.value));
  els.iptvGuideSelect.value = renderedIds.has(previous) ? previous : "";
  els.iptvGuideResults.textContent = resultCountText(matchingGuideChannels.length, suggestions.length + guideChannels.length);
  els.iptvSelectedChannel.innerHTML = `<strong>${escapeHtml(`${channel.number ? `${channel.number} - ` : ""}${channel.name}`)}</strong><span>${escapeHtml(automaticMatchDescription(channel))}</span>`;
  const globalOption = els.iptvDeinterlaceMode.querySelector('option[value="default"]');
  if (globalOption) {
    globalOption.textContent = `Use global setting (${deinterlaceModeLabel(data.defaultDeinterlaceMode)})`;
  }
  els.iptvDeinterlaceMode.value = ["default", "off", "auto", "force", "smooth"].includes(channel.deinterlaceMode)
    ? channel.deinterlaceMode
    : "default";
  els.saveIptvMatch.disabled = false;
  els.clearIptvMatch.disabled = !channel.manualGuideChannelId;
  els.iptvMatchStatus.textContent = channel.manualGuideChannelId
    ? `Manual match: ${guideChannelName(channel.manualGuideChannelId) || channel.manualGuideChannelId}`
    : `Using automatic match: ${guideChannelName(channel.automaticGuideChannelId) || "unmatched"}`;
}

async function saveIptvChannelMatch() {
  const channel = selectedIptvChannel();
  if (!channel) {
    return;
  }
  await updateIptvChannelMatch(channel.id, els.iptvGuideSelect.value || null, "Channel settings saved.");
}

async function clearIptvChannelMatch() {
  const channel = selectedIptvChannel();
  if (!channel) {
    return;
  }
  await updateIptvChannelMatch(channel.id, null, "Automatic channel matching restored.");
}

async function updateIptvChannelMatch(channelId, guideChannelId, successMessage) {
  setIptvMatcherBusy(true);
  els.iptvMatchStatus.textContent = "Saving channel settings...";
  try {
    const result = await api(`/api/admin/settings/iptv/channel-matches/${encodeURIComponent(channelId)}`, state.token, {
      method: "PUT",
      body: JSON.stringify({
        guideChannelId,
        deinterlaceMode: els.iptvDeinterlaceMode.value
      })
    });
    state.iptvMatchData = result.data;
    prepareIptvMatchData();
    syncIptvChannelMappings();
    els.iptvChannelSelect.value = channelId;
    renderIptvChannelOptions();
    els.iptvMatchStatus.textContent = successMessage;
  } catch (err) {
    els.iptvMatchStatus.textContent = err.message || "Failed to save the channel settings.";
  } finally {
    setIptvMatcherBusy(false);
  }
}

function selectedIptvChannel() {
  return state.iptvMatchData && state.iptvMatchData.channels.find((channel) => channel.id === els.iptvChannelSelect.value) || null;
}

function guideChannelName(id) {
  const channel = state.iptvGuideById.get(id);
  return channel && channel.name || "";
}

function prepareIptvMatchData() {
  const data = state.iptvMatchData;
  if (!data) {
    state.iptvGuideById = new Map();
    return;
  }
  for (const channel of data.channels) {
    channel.searchText = normalizeFilterText(`${channel.number || ""} ${channel.name}`);
    channel.guideSuggestions = Array.isArray(channel.guideSuggestions) ? channel.guideSuggestions : [];
  }
  for (const guideChannel of data.guideChannels) {
    guideChannel.searchText = normalizeFilterText(`${guideChannel.name} ${guideChannel.names.join(" ")} ${guideChannel.id}`);
  }
  state.iptvGuideById = new Map(data.guideChannels.map((channel) => [channel.id, channel]));
}

function automaticMatchDescription(channel) {
  const name = guideChannelName(channel.automaticGuideChannelId);
  if (!name) {
    return "No confident automatic EPG match";
  }
  const confidence = Number.isFinite(channel.automaticMatchScore)
    ? `, ${Math.round(channel.automaticMatchScore * 100)}% confidence`
    : "";
  return `Automatic ${channel.automaticMatchMethod || ""} match: ${name}${confidence}`;
}

function resultCountText(total, visible) {
  return visible < total ? `${visible} of ${total}` : `${total} result${total === 1 ? "" : "s"}`;
}

function deinterlaceModeLabel(mode) {
  return {
    off: "Off",
    auto: "Auto",
    force: "Force",
    smooth: "Smooth 50/60p"
  }[mode] || "Auto";
}

function syncIptvChannelMappings() {
  const channels = state.iptvMatchData && state.iptvMatchData.channels || [];
  state.iptvChannelMappings = Object.fromEntries(channels
    .filter((channel) => channel.manualGuideChannelId)
    .map((channel) => [channel.id, channel.manualGuideChannelId]));
  state.iptvChannelDeinterlaceModes = Object.fromEntries(channels
    .filter((channel) => channel.deinterlaceMode && channel.deinterlaceMode !== "default")
    .map((channel) => [channel.id, channel.deinterlaceMode]));
}

function setIptvMatcherBusy(busy) {
  const channel = selectedIptvChannel();
  els.saveIptvMatch.disabled = busy || !channel;
  els.clearIptvMatch.disabled = busy || !channel || !channel.manualGuideChannelId;
}

function settingsFromForm() {
  return {
    logging: {
      level: els.settingsLogLevel.value,
      retentionDays: intInput(els.settingsLogRetentionDays, 5)
    },
    updates: {
      enabled: els.settingsUpdatesEnabled.checked,
      checkIntervalSeconds: intInput(els.settingsUpdateIntervalHours, 6) * 3600,
      includePrereleases: els.settingsIncludePrereleases.checked,
      autoInstall: els.settingsAutoInstall.checked
    },
    indexScan: {
      enabled: els.settingsIndexEnabled.checked,
      intervalSeconds: intInput(els.settingsIndexInterval, 900),
      runOnStartup: els.settingsIndexStartup.checked
    },
    metadata: {
      enabled: els.settingsMetadataEnabled.checked,
      provider: "tmdb",
      tmdbApiKey: els.settingsTmdbApiKey.value.trim(),
      tmdbReadAccessToken: els.settingsTmdbReadToken.value.trim(),
      language: els.settingsMetadataLanguage.value.trim(),
      posterSize: els.settingsPosterSize.value.trim(),
      thumbnailSize: els.settingsThumbnailSize.value.trim(),
      posterLanguages: els.settingsPosterLanguages.value.split(",").map((item) => item.trim()).filter(Boolean),
      preloadOnStartup: els.settingsMetadataPreload.checked,
      requestDelayMs: intInput(els.settingsMetadataDelay, 250, 0)
    },
    subtitles: {
      enabled: els.settingsSubtitlesEnabled.checked,
      provider: els.settingsSubtitleProvider.value.trim(),
      subdlApiKey: els.settingsSubdlApiKey.value.trim(),
      userAgent: els.settingsSubtitleUserAgent.value.trim(),
      defaultLanguage: els.settingsSubtitleLanguage.value.trim(),
      sync: {
        enabled: els.settingsSubtitleSyncEnabled.checked,
        maxOffsetSeconds: intInput(els.settingsSubtitleMaxOffset, 900),
        timeoutSeconds: intInput(els.settingsSubtitleTimeout, 900)
      }
    },
    ytdlp: {
      enabled: els.settingsYtDlpEnabled.checked,
      downloadPath: els.settingsYtDlpPath.value.trim(),
      libraryTitle: els.settingsYtDlpTitle.value.trim() || "YT-DLP",
      allowPlaylists: els.settingsYtDlpPlaylists.checked
    },
    iptv: {
      enabled: els.settingsIptvEnabled.checked,
      sourceType: els.settingsIptvSourceType.value === "hdhomerun" ? "hdhomerun" : "m3u",
      playlistUrl: els.settingsIptvPlaylistUrl.value.trim(),
      hdHomeRunUrl: els.settingsIptvHdHomeRunUrl.value.trim(),
      guideUrl: els.settingsIptvGuideUrl.value.trim(),
      channelMappings: { ...state.iptvChannelMappings },
      deinterlaceMode: els.settingsIptvDeinterlaceMode.value,
      channelDeinterlaceModes: { ...state.iptvChannelDeinterlaceModes },
      refreshIntervalSeconds: intInput(els.settingsIptvRefreshHours, 24) * 3600,
      bufferSeconds: intInput(els.settingsIptvBufferSeconds, 180, 10),
      segmentSeconds: intInput(els.settingsIptvSegmentSeconds, 6, 2)
    },
    playback: {
      onDeckTtlSeconds: intInput(els.settingsOnDeckTtl, 1209600),
      watchedThresholdPercent: intInput(els.settingsWatchedThreshold, 10)
    },
    hls: {
      ttlSeconds: intInput(els.settingsHlsTtl, 86400),
      segmentSeconds: intInput(els.settingsHlsSegment, 6),
      segmentWaitTimeoutSeconds: intInput(els.settingsHlsWait, 90),
      forceTranscodeCompatibleVideo: els.settingsForceTranscode.checked
    },
    fallbackStream: {
      enabled: els.settingsFallbackEnabled.checked,
      segmentSeconds: intInput(els.settingsFallbackSegment, 4)
    },
    ffmpeg: {
      enableGpu: els.settingsEnableGpu.checked
    },
    streaming: {
      preferredAudioLanguage: els.settingsPreferredAudio.value.trim()
    }
  };
}

function updateSettingsVisibility() {
  els.updatesSettingsFieldset.classList.toggle("hidden", !isAdminMode());
  setFeatureVisible(els.updateSettingsBody, els.settingsUpdatesEnabled.checked);
  setFeatureVisible(els.metadataSettingsBody, els.settingsMetadataEnabled.checked);
  setFeatureVisible(els.subtitleSettingsBody, els.settingsSubtitlesEnabled.checked);
  setFeatureVisible(els.subtitleSyncSettingsBody, els.settingsSubtitlesEnabled.checked && els.settingsSubtitleSyncEnabled.checked);
  setFeatureVisible(els.ytDlpSettingsBody, els.settingsYtDlpEnabled.checked);
  setFeatureVisible(els.iptvSettingsBody, els.settingsIptvEnabled.checked);
  const hdHomeRun = els.settingsIptvSourceType.value === "hdhomerun";
  setFeatureVisible(els.settingsIptvPlaylistField, !hdHomeRun);
  setFeatureVisible(els.settingsIptvHdHomeRunField, hdHomeRun);
  els.settingsIptvGuideLabel.textContent = hdHomeRun ? "EPG URL or path (optional)" : "EPG URL or path";
  setFeatureVisible(els.indexSettingsBody, els.settingsIndexEnabled.checked);
  setFeatureVisible(els.fallbackSettingsBody, els.settingsFallbackEnabled.checked);
}

function setFeatureVisible(element, visible) {
  if (!element) {
    return;
  }
  element.classList.toggle("hidden", !visible);
}

function intInput(input, fallback, minimum = 1) {
  const value = Number.parseInt(input.value, 10);
  return Number.isFinite(value) && value >= minimum ? value : fallback;
}

function openAccountPanel() {
  if (!state.user || state.shareToken) {
    return;
  }
  els.selfAccountUsername.value = state.user.username || "";
  els.selfAccountCurrentPassword.value = "";
  els.selfAccountNewPassword.value = "";
  els.selfAccountConfirmPassword.value = "";
  els.selfAccountStatus.textContent = "";
  els.accountOverlay.classList.remove("hidden");
  els.accountOverlay.setAttribute("aria-hidden", "false");
}

function closeAccountPanel() {
  els.accountOverlay.classList.add("hidden");
  els.accountOverlay.setAttribute("aria-hidden", "true");
  els.selfAccountCurrentPassword.value = "";
  els.selfAccountNewPassword.value = "";
  els.selfAccountConfirmPassword.value = "";
}

async function saveSelfAccount(event) {
  event.preventDefault();
  const username = els.selfAccountUsername.value.trim();
  const currentPassword = els.selfAccountCurrentPassword.value;
  const password = els.selfAccountNewPassword.value;
  if (!username || !currentPassword) {
    els.selfAccountStatus.textContent = "Username and current password are required.";
    return;
  }
  if (password !== els.selfAccountConfirmPassword.value) {
    els.selfAccountStatus.textContent = "The new passwords do not match.";
    return;
  }

  els.saveSelfAccount.disabled = true;
  els.selfAccountStatus.textContent = "Saving account...";
  try {
    const result = await api("/api/auth/me", state.token, {
      method: "PUT",
      body: JSON.stringify({ username, currentPassword, password })
    });
    state.user = result.user;
    els.selfAccountCurrentPassword.value = "";
    els.selfAccountNewPassword.value = "";
    els.selfAccountConfirmPassword.value = "";
    updateAdminControls();
    els.selfAccountStatus.textContent = "Account updated.";
  } catch (err) {
    els.selfAccountStatus.textContent = err.message || "Failed to update account.";
  } finally {
    els.saveSelfAccount.disabled = false;
  }
}

async function openDownloadPanel() {
  els.downloadOverlay.classList.remove("hidden");
  els.downloadOverlay.setAttribute("aria-hidden", "false");
  els.downloadStatus.textContent = "";
  await refreshYtDlpDownloads();
  startDownloadRefresh();
}

function closeDownloadPanel() {
  els.downloadOverlay.classList.add("hidden");
  els.downloadOverlay.setAttribute("aria-hidden", "true");
  if (!hasActiveDownloads) {
    stopDownloadRefresh();
  }
}

async function startYtDlpDownload(event) {
  event.preventDefault();
  const url = els.downloadUrlInput.value.trim();
  if (!url) {
    return;
  }

  els.startDownload.disabled = true;
  els.downloadStatus.textContent = "Starting download...";
  try {
    const result = await api("/api/ytdlp/downloads", state.token, {
      method: "POST",
      body: JSON.stringify({ url })
    });
    if (result.download && result.download.id) {
      downloadStatuses.set(result.download.id, result.download.status);
    }
    els.downloadUrlInput.value = "";
    els.downloadStatus.textContent = "Download started.";
    await refreshYtDlpDownloads();
    startDownloadRefresh();
  } catch (err) {
    els.downloadStatus.textContent = err.message || "Failed to start download.";
  } finally {
    els.startDownload.disabled = false;
  }
}

function startDownloadRefresh() {
  if (downloadRefreshTimer) {
    return;
  }
  downloadRefreshTimer = setInterval(() => {
    refreshYtDlpDownloads().catch(() => {});
  }, 1500);
  if (typeof downloadRefreshTimer.unref === "function") {
    downloadRefreshTimer.unref();
  }
}

function stopDownloadRefresh() {
  if (downloadRefreshTimer) {
    clearInterval(downloadRefreshTimer);
    downloadRefreshTimer = null;
  }
}

async function refreshYtDlpDownloads() {
  const data = await api("/api/ytdlp/downloads");
  const downloads = data.downloads || [];
  handleYtDlpDownloadUpdates(downloads);
  renderYtDlpDownloads(downloads);
}

function handleYtDlpDownloadUpdates(downloads) {
  let newlyComplete = false;
  for (const download of downloads) {
    const previous = downloadStatuses.get(download.id);
    if (previous && previous !== "complete" && download.status === "complete") {
      newlyComplete = true;
    }
    downloadStatuses.set(download.id, download.status);
  }

  if (newlyComplete) {
    refreshHomeAfterDownload();
  }

  hasActiveDownloads = downloads.some((download) => ["starting", "downloading", "indexing"].includes(download.status));
  if (hasActiveDownloads) {
    startDownloadRefresh();
    return;
  }

  if (els.downloadOverlay.classList.contains("hidden")) {
    stopDownloadRefresh();
  }
}

function refreshHomeAfterDownload() {
  if (state.currentView !== "home" || downloadHomeRefreshPromise) {
    return;
  }

  downloadHomeRefreshPromise = loadHome(state.homeMode)
    .catch(() => {})
    .finally(() => {
      downloadHomeRefreshPromise = null;
    });
}

function renderYtDlpDownloads(downloads) {
  els.downloadList.innerHTML = "";
  if (downloads.length === 0) {
    const empty = document.createElement("p");
    empty.className = "status";
    empty.textContent = "No downloads yet.";
    els.downloadList.appendChild(empty);
    return;
  }

  downloads
    .sort((a, b) => Date.parse(b.startedAt || 0) - Date.parse(a.startedAt || 0))
    .forEach((download) => {
      els.downloadList.appendChild(download.isPlaylist
        ? playlistDownloadView(download)
        : downloadItemView(download));
    });
}

function playlistDownloadView(download) {
  const group = document.createElement("section");
  group.className = `download-group download-${download.status}`;
  const percent = boundedPercent(download.percent);
  const completed = (download.items || []).filter((item) => ["complete", "skipped"].includes(item.status)).length;
  group.innerHTML = `
    <div class="download-heading">
      <strong title="${escapeHtml(download.playlistTitle || download.title || download.url)}">${escapeHtml(download.playlistTitle || download.title || download.url)}</strong>
      <span>${escapeHtml(download.status)}</span>
    </div>
    <div class="progress-track" aria-hidden="true"><span class="progress-fill" style="--progress: ${percent}%"></span></div>
    <div class="download-meta">
      <span>${escapeHtml(`${percentLabel(percent)} overall`)}</span>
      <span>${escapeHtml(`${completed} / ${(download.items || []).length} items`)}</span>
      <span>${escapeHtml(download.eta ? `Current ETA ${download.eta}` : "")}</span>
    </div>
    <p class="status">${escapeHtml(download.error || download.message || "")}</p>
    <div class="playlist-download-items"></div>
  `;
  const itemList = group.querySelector(".playlist-download-items");
  (download.items || [])
    .sort((a, b) => (a.index || 0) - (b.index || 0))
    .forEach((item) => itemList.appendChild(downloadItemView(item, { child: true })));
  return group;
}

function downloadItemView(download, options = {}) {
  const row = document.createElement("section");
  row.className = `${options.child ? "playlist-download-item" : "download-card"} download-${download.status}`;
  const percent = boundedPercent(download.percent);
  const title = options.child
    ? `${String(download.index || 0).padStart(2, "0")} - ${download.title || download.filename || "Playlist item"}`
    : download.title || download.filename || download.url;
  row.innerHTML = `
    <div class="download-heading">
      <strong title="${escapeHtml(title)}">${escapeHtml(title)}</strong>
      <span>${escapeHtml(download.status)}</span>
    </div>
    <div class="progress-track" aria-hidden="true"><span class="progress-fill" style="--progress: ${percent}%"></span></div>
    <div class="download-meta">
      <span>${escapeHtml(percentLabel(percent))}</span>
      <span>${escapeHtml(download.speed || "")}</span>
      <span>${escapeHtml(download.eta ? `ETA ${download.eta}` : "")}</span>
    </div>
    <p class="status">${escapeHtml(download.error || download.message || "")}</p>
  `;
  return row;
}

function boundedPercent(value) {
  return Math.max(0, Math.min(100, Number(value) || 0));
}

function percentLabel(value) {
  return `${value.toFixed(value % 1 ? 1 : 0)}%`;
}

async function deleteAccount(account) {
  if (!window.confirm(`Remove account ${account.username}?`)) {
    return;
  }

  try {
    await api(`/api/admin/accounts/${encodeURIComponent(account.id)}`, state.token, { method: "DELETE" });
    await loadAccounts();
  } catch (err) {
    els.accountStatus.textContent = "Failed to remove account.";
  }
}

async function refreshHardware() {
  try {
    const data = await api("/api/admin/hardware");
    els.cpuMeter.style.setProperty("--meter", `${data.cpuPercent || 0}%`);
    els.cpuText.textContent = `${data.cpuPercent || 0}%`;
    els.memoryMeter.style.setProperty("--meter", `${data.memory.percent || 0}%`);
    els.memoryText.textContent = `${data.memory.percent || 0}%`;
    if (data.gpu.available) {
      els.gpuMeter.style.setProperty("--meter", `${data.gpu.percent || 0}%`);
      const temperature = data.gpu.temperatureC === null ? "" : ` - ${data.gpu.temperatureC}C`;
      els.gpuText.textContent = `${data.gpu.percent || 0}%${temperature}`;
    } else {
      els.gpuMeter.style.setProperty("--meter", "0%");
      els.gpuText.textContent = data.gpu.reason;
    }
    const network = data.network || { available: false, reason: "network usage unavailable" };
    const networkIn = network.rxBytesPerSecond || 0;
    const networkOut = network.txBytesPerSecond || 0;
    const networkMax = Math.max(networkIn, networkOut, 1);
    els.networkInMeter.style.setProperty("--meter", `${Math.min(100, networkIn / networkMax * 100)}%`);
    els.networkOutMeter.style.setProperty("--meter", `${Math.min(100, networkOut / networkMax * 100)}%`);
    els.networkInText.textContent = network.available ? `${formatBytes(networkIn)}/s` : network.reason;
    els.networkOutText.textContent = network.available ? `${formatBytes(networkOut)}/s` : network.reason;
    drawUsageChart(els.usageChart, data.history || []);
    drawNetworkChart(els.networkChart, data.history || []);
  } catch (err) {
    els.gpuText.textContent = "Failed to load hardware usage.";
  }
}

function drawUsageChart(canvas, history) {
  drawLineChart(canvas, history, [
    { key: "cpuPercent", label: "CPU", color: "#00d9ff" },
    { key: "memoryPercent", label: "Memory", color: "#9ce66f" },
    { key: "gpuPercent", label: "GPU", color: "#f1d26a" }
  ], {
    maxValue: 100,
    valueFormatter: (value) => `${Math.round(value)}%`
  });
}

function drawNetworkChart(canvas, history) {
  const maxValue = Math.max(1, ...history.flatMap((entry) => [
    Number(entry.networkInBytesPerSecond) || 0,
    Number(entry.networkOutBytesPerSecond) || 0
  ]));
  drawLineChart(canvas, history, [
    { key: "networkInBytesPerSecond", label: "In", color: "#00d9ff" },
    { key: "networkOutBytesPerSecond", label: "Out", color: "#ff8f70" }
  ], {
    maxValue,
    valueFormatter: formatBytes
  });
}

function drawLineChart(canvas, history, series, options = {}) {
  if (!canvas) {
    return;
  }

  const ctx = canvas.getContext("2d");
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.floor(rect.width || canvas.width));
  const height = Math.max(1, Math.floor(rect.height || canvas.height));
  const ratio = window.devicePixelRatio || 1;
  if (canvas.width !== width * ratio || canvas.height !== height * ratio) {
    canvas.width = width * ratio;
    canvas.height = height * ratio;
  }
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const padding = { top: 18, right: 18, bottom: 28, left: 48 };
  const plotWidth = Math.max(1, width - padding.left - padding.right);
  const plotHeight = Math.max(1, height - padding.top - padding.bottom);
  const maxValue = Math.max(1, Number(options.maxValue) || 1);

  ctx.fillStyle = "rgba(255,255,255,0.04)";
  ctx.fillRect(padding.left, padding.top, plotWidth, plotHeight);
  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i += 1) {
    const y = padding.top + plotHeight * (i / 4);
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(padding.left + plotWidth, y);
    ctx.stroke();
  }

  ctx.fillStyle = "rgba(235,245,250,0.68)";
  ctx.font = "12px system-ui, sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  const valueFormatter = options.valueFormatter || ((value) => String(Math.round(value)));
  ctx.fillText(valueFormatter(maxValue), padding.left - 8, padding.top);
  ctx.fillText(valueFormatter(maxValue / 2), padding.left - 8, padding.top + plotHeight / 2);
  ctx.fillText(valueFormatter(0), padding.left - 8, padding.top + plotHeight);

  if (history.length > 0) {
    const firstTime = Date.parse(history[0].at);
    const lastTime = Math.max(firstTime + 1, Date.parse(history[history.length - 1].at));
    series.forEach((item) => {
      ctx.strokeStyle = item.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      let moved = false;
      history.forEach((entry) => {
        const value = Number(entry[item.key]);
        if (!Number.isFinite(value)) {
          return;
        }
        const x = padding.left + ((Date.parse(entry.at) - firstTime) / (lastTime - firstTime)) * plotWidth;
        const y = padding.top + plotHeight - (Math.max(0, Math.min(maxValue, value)) / maxValue) * plotHeight;
        if (!moved) {
          ctx.moveTo(x, y);
          moved = true;
        } else {
          ctx.lineTo(x, y);
        }
      });
      ctx.stroke();
    });
  }

  let legendX = padding.left;
  series.forEach((item) => {
    ctx.fillStyle = item.color;
    ctx.fillRect(legendX, height - 18, 10, 10);
    ctx.fillStyle = "rgba(235,245,250,0.82)";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(item.label, legendX + 14, height - 13);
    legendX += ctx.measureText(item.label).width + 42;
  });
}

async function refreshLogs() {
  try {
    const data = await api("/api/admin/logs?limit=200");
    els.liveLog.textContent = (data.entries || []).map((entry) => `[${entry.at}] ${entry.level}: ${entry.message}`).join("\n");
    els.liveLog.scrollTop = els.liveLog.scrollHeight;
  } catch (err) {
    els.liveLog.textContent = "Failed to load logs.";
  }
}

async function refreshCurrentlyPlaying() {
  try {
    const data = await api("/api/admin/currently-playing");
    const items = data.items || [];
    if (items.length === 0) {
      els.currentlyPlayingList.innerHTML = '<p class="status">Nothing is currently playing.</p>';
      return;
    }

    els.currentlyPlayingList.innerHTML = "";
    items.forEach((item) => {
      const row = document.createElement("section");
      row.className = "library-manager-card currently-playing-card";
      const progress = item.progress || {};
      const position = Number(progress.positionSeconds) || 0;
      const duration = Number(progress.durationSeconds) || 0;
      const percent = Number(progress.percent) || 0;
      row.innerHTML = `
        <div class="currently-playing-heading">
          <div>
            <strong>${escapeHtml(item.user && item.user.username || "Unknown")}</strong>
            <span>${escapeHtml(item.title || "Unknown media")}</span>
          </div>
          <span>${escapeHtml(formatActiveAgo(item.activeAgoSeconds))}</span>
        </div>
        <div class="progress-track" aria-hidden="true"><span class="progress-fill" style="--progress: ${Math.max(0, Math.min(percent, 100))}%"></span></div>
        <div class="currently-playing-meta">
          <span>${escapeHtml(item.category || item.mediaType || "")}</span>
          <span>${escapeHtml(item.subtitle || "")}</span>
          <span>${escapeHtml(formatDuration(position))} / ${escapeHtml(duration ? formatDuration(duration) : "unknown")}</span>
          <span>${escapeHtml(`${percent}%`)}</span>
        </div>
      `;
      els.currentlyPlayingList.appendChild(row);
    });
  } catch (err) {
    els.currentlyPlayingList.innerHTML = '<p class="status">Failed to load currently playing.</p>';
  }
}

async function loadUserHistory() {
  try {
    const data = await api("/api/admin/history");
    els.userHistoryList.innerHTML = "";
    (data.items || []).forEach((item) => {
      const row = document.createElement("section");
      row.className = "library-manager-card";
      row.innerHTML = `<strong>${escapeHtml(item.user.username)}</strong><span>${escapeHtml(item.title)} - ${escapeHtml(item.progress.status)} - ${escapeHtml(formatDate(item.updatedAt))}</span>`;
      els.userHistoryList.appendChild(row);
    });
  } catch (err) {
    els.userHistoryList.innerHTML = '<p class="status">Failed to load user history.</p>';
  }
}

function formatActiveAgo(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  if (value < 5) {
    return "now";
  }
  return `${value}s ago`;
}

async function loadLibraryManager() {
  els.libraryManagerStatus.textContent = "Loading libraries...";
  els.libraryManagerList.innerHTML = "";
  els.libraryForm.classList.toggle("hidden", !hasPermission("canManageLibraries"));
  els.reindexLibraries.classList.toggle("hidden", !hasPermission("canReindex"));
  closeFolderPicker();

  try {
    const data = await api("/api/libraries");
    const libraries = data.libraries || [];
    if (libraries.length === 0) {
      els.libraryManagerStatus.textContent = "No libraries configured yet.";
      return;
    }

    els.libraryManagerStatus.textContent = "";
    libraries.forEach((library) => els.libraryManagerList.appendChild(libraryManagerCard(library)));
    if (hasPermission("canManageLibraries")) {
      enableLibraryDragDrop();
    }
  } catch (err) {
    els.libraryManagerStatus.textContent = "Failed to load libraries.";
  }
}

function canViewLibraryAdmin() {
  return hasPermission("canManageLibraries")
    || hasPermission("canCreateShareLinks")
    || hasPermission("canReindex");
}

function libraryManagerCard(library) {
  const cardElement = document.createElement("section");
  cardElement.className = "library-manager-card";
  cardElement.draggable = hasPermission("canManageLibraries") && !library.managed;
  cardElement.dataset.libraryKey = library.key;
  cardElement.dataset.managed = library.managed ? "true" : "false";
  cardElement.innerHTML = `
    <div class="library-manager-heading">
      <div>
        <h3><span class="drag-handle" aria-hidden="true">::</span>${escapeHtml(library.title)}</h3>
        <div class="library-path">${escapeHtml(library.key)} - ${escapeHtml(library.rawType || library.type)} - ${escapeHtml(library.path)}</div>
      </div>
      <div class="library-card-actions">
        ${hasPermission("canCreateShareLinks") ? '<button class="secondary-button compact-button create-share" type="button">Create share URL</button>' : ""}
        ${hasPermission("canReindex") ? '<button class="secondary-button compact-button reindex-library" type="button">Re-index</button>' : ""}
        ${hasPermission("canManageLibraries") && !library.managed ? '<button class="secondary-button compact-button delete-library" type="button">Remove</button>' : ""}
      </div>
    </div>
    ${hasPermission("canManageLibraries") && !library.managed ? `
      <label class="library-progress-toggle">
        <input class="track-library-progress" type="checkbox" ${library.trackProgress === false ? "" : "checked"}>
        Store playback progress
      </label>
    ` : ""}
    <div class="share-list"></div>
  `;

  const progressToggle = cardElement.querySelector(".track-library-progress");
  if (progressToggle) {
    progressToggle.addEventListener("change", () => updateLibraryProgress(library, progressToggle));
  }

  const shareButton = cardElement.querySelector(".create-share");
  if (shareButton) {
    shareButton.addEventListener("click", () => createLibraryShare(library.key));
  }
  const reindexButton = cardElement.querySelector(".reindex-library");
  if (reindexButton) {
    reindexButton.addEventListener("click", () => reindexLibrary(library.key, library.title, reindexButton));
  }
  const deleteButton = cardElement.querySelector(".delete-library");
  if (deleteButton) {
    deleteButton.addEventListener("click", () => deleteLibrary(library.key, library.title));
  }
  const shareList = cardElement.querySelector(".share-list");
  renderShares(shareList, library);
  return cardElement;
}

function enableLibraryDragDrop() {
  Array.from(els.libraryManagerList.querySelectorAll(".library-manager-card")).forEach((cardElement) => {
    cardElement.addEventListener("dragstart", (event) => {
      draggedLibraryKey = cardElement.dataset.libraryKey;
      cardElement.classList.add("dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", draggedLibraryKey);
    });

    cardElement.addEventListener("dragend", () => {
      draggedLibraryKey = null;
      cardElement.classList.remove("dragging");
      clearLibraryDropTargets();
    });

    cardElement.addEventListener("dragover", (event) => {
      if (!draggedLibraryKey || draggedLibraryKey === cardElement.dataset.libraryKey) {
        return;
      }

      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      clearLibraryDropTargets();
      cardElement.classList.add("drop-target");
    });

    cardElement.addEventListener("dragleave", () => {
      cardElement.classList.remove("drop-target");
    });

    cardElement.addEventListener("drop", async (event) => {
      event.preventDefault();
      const sourceKey = draggedLibraryKey || event.dataTransfer.getData("text/plain");
      const targetKey = cardElement.dataset.libraryKey;
      clearLibraryDropTargets();
      if (!sourceKey || !targetKey || sourceKey === targetKey) {
        return;
      }

      await moveLibraryCard(sourceKey, targetKey, event.clientY);
    });
  });
}

async function moveLibraryCard(sourceKey, targetKey, clientY) {
  const source = els.libraryManagerList.querySelector(`.library-manager-card[data-library-key="${cssEscape(sourceKey)}"]`);
  const target = els.libraryManagerList.querySelector(`.library-manager-card[data-library-key="${cssEscape(targetKey)}"]`);
  if (!source || !target) {
    return;
  }

  const targetRect = target.getBoundingClientRect();
  const insertAfter = Number(clientY) > targetRect.top + targetRect.height / 2;
  els.libraryManagerList.insertBefore(source, insertAfter ? target.nextSibling : target);
  await saveLibraryOrder();
}

async function saveLibraryOrder() {
  const keys = Array.from(els.libraryManagerList.querySelectorAll(".library-manager-card"))
    .filter((cardElement) => cardElement.dataset.managed !== "true")
    .map((cardElement) => cardElement.dataset.libraryKey)
    .filter(Boolean);

  els.libraryManagerStatus.textContent = "Saving library order...";
  try {
    await api("/api/libraries/order", state.token, {
      method: "PUT",
      body: JSON.stringify({ keys })
    });
    els.libraryManagerStatus.textContent = "Library order saved.";
    await loadHome();
  } catch (err) {
    els.libraryManagerStatus.textContent = "Failed to save library order.";
    await loadLibraryManager();
  }
}

function clearLibraryDropTargets() {
  els.libraryManagerList.querySelectorAll(".drop-target").forEach((cardElement) => {
    cardElement.classList.remove("drop-target");
  });
}

function renderShares(container, library) {
  const activeShares = (library.shares || []).filter((share) => !share.revokedAt);
  if (activeShares.length === 0) {
    const empty = document.createElement("p");
    empty.className = "status";
    empty.textContent = "No active share URLs.";
    container.appendChild(empty);
    return;
  }

  activeShares.forEach((share) => {
    const row = document.createElement("div");
    row.className = "share-row";
    const canCopy = Boolean(share.url);
    row.innerHTML = `
      <span class="status">${canCopy ? "Created" : "Legacy share"} ${escapeHtml(formatDate(share.createdAt))}</span>
      <button class="secondary-button compact-button copy-share" type="button" ${canCopy ? "" : "disabled"}>${canCopy ? "Copy" : "Unavailable"}</button>
      <button class="secondary-button compact-button revoke-share" type="button">Revoke</button>
    `;
    const copyButton = row.querySelector(".copy-share");
    if (canCopy) {
      copyButton.addEventListener("click", async () => {
        await copyText(share.url);
        els.libraryManagerStatus.textContent = "Share URL copied.";
      });
    }
    row.querySelector(".revoke-share").addEventListener("click", () => revokeLibraryShare(library.key, share.id));
    container.appendChild(row);
  });
}

async function addLibrary(event) {
  event.preventDefault();
  els.addLibraryButton.disabled = true;
  els.libraryManagerStatus.textContent = "Adding library...";

  try {
    await api("/api/libraries", state.token, {
      method: "POST",
      body: JSON.stringify({
        title: els.libraryNameInput.value.trim(),
        type: els.libraryTypeSelect.value,
        path: els.libraryPathInput.value.trim(),
        trackProgress: els.libraryTrackProgress.checked
      })
    });
    els.libraryForm.reset();
    els.libraryTrackProgress.checked = true;
    await loadLibraryManager();
    await loadHome();
    els.libraryManagerStatus.textContent = "Library added. Re-index running in the background.";
  } catch (err) {
    els.libraryManagerStatus.textContent = "Failed to add library.";
  } finally {
    els.addLibraryButton.disabled = false;
  }
}

async function updateLibraryProgress(library, toggle) {
  toggle.disabled = true;
  els.libraryManagerStatus.textContent = "Saving playback progress setting...";
  try {
    const result = await api(`/api/libraries/${encodeURIComponent(library.key)}`, state.token, {
      method: "PUT",
      body: JSON.stringify({ trackProgress: toggle.checked })
    });
    library.trackProgress = result.library.trackProgress;
    els.libraryManagerStatus.textContent = result.library.trackProgress
      ? "Playback progress enabled."
      : "Playback progress disabled.";
    await refreshOnDeckRow({ force: true }).catch(() => {});
  } catch (err) {
    toggle.checked = library.trackProgress !== false;
    els.libraryManagerStatus.textContent = "Failed to save playback progress setting.";
  } finally {
    toggle.disabled = false;
  }
}

async function openFolderPicker(initialPath) {
  els.folderPicker.classList.remove("hidden");
  await loadFolderPicker(initialPath);
}

function closeFolderPicker() {
  els.folderPicker.classList.add("hidden");
}

async function loadFolderPicker(pathValue) {
  els.folderPickerPath.textContent = "Loading...";
  els.folderPickerList.innerHTML = "";
  els.folderPickerRoots.innerHTML = "";
  els.folderPickerParent.disabled = true;
  els.selectFolderPath.disabled = true;

  try {
    const params = new URLSearchParams();
    if (pathValue) {
      params.set("path", pathValue);
    }
    const data = await api(`/api/admin/folders${params.toString() ? `?${params.toString()}` : ""}`);
    folderPickerPath = data.path || "";
    els.folderPickerPath.textContent = data.error
      ? `${data.attemptedPath || pathValue} - ${data.error}`
      : folderPickerPath;
    els.folderPickerParent.disabled = !data.parent;
    els.folderPickerParent.dataset.path = data.parent || "";
    els.selectFolderPath.disabled = !folderPickerPath;
    renderFolderRoots(data.roots || []);
    renderFolderList(data.directories || [], data.error);
  } catch (err) {
    els.folderPickerPath.textContent = "Could not open folder.";
    els.folderPickerList.innerHTML = '<p class="status">This folder could not be read.</p>';
  }
}

function renderFolderRoots(roots) {
  roots.forEach((root) => {
    const button = document.createElement("button");
    button.className = "secondary-button compact-button";
    button.type = "button";
    button.textContent = root.name;
    button.addEventListener("click", () => loadFolderPicker(root.path));
    els.folderPickerRoots.appendChild(button);
  });
}

function renderFolderList(directories, error = null) {
  if (error) {
    els.folderPickerList.innerHTML = '<p class="status">Choose an available root above.</p>';
    return;
  }
  if (directories.length === 0) {
    els.folderPickerList.innerHTML = '<p class="status">No child folders.</p>';
    return;
  }

  directories.forEach((directory) => {
    const button = document.createElement("button");
    button.className = "folder-row";
    button.type = "button";
    button.innerHTML = `<span>${escapeHtml(directory.name)}</span><small>${escapeHtml(directory.path)}</small>`;
    button.addEventListener("click", () => loadFolderPicker(directory.path));
    els.folderPickerList.appendChild(button);
  });
}

function selectFolderPickerPath() {
  if (!folderPickerPath) {
    return;
  }

  els.libraryPathInput.value = folderPickerPath;
  closeFolderPicker();
}

async function reindexLibraries() {
  if (!window.confirm("Rebuild the media index now? This can take a while on large libraries.")) {
    return;
  }

  els.reindexLibraries.disabled = true;
  els.libraryManagerStatus.textContent = "Starting re-index...";
  try {
    await api("/api/admin/reindex", state.token, { method: "POST" });
    await loadLibraryManager();
    await loadHome();
    els.libraryManagerStatus.textContent = "Re-index started in the background.";
  } catch (err) {
    els.libraryManagerStatus.textContent = "Failed to re-index libraries.";
  } finally {
    els.reindexLibraries.disabled = false;
  }
}

async function reindexLibrary(key, title, button) {
  if (!window.confirm(`Re-index ${title}? This will run in the background.`)) {
    return;
  }

  if (button) {
    button.disabled = true;
  }
  els.libraryManagerStatus.textContent = `Re-indexing ${title} in the background...`;
  try {
    await api(`/api/libraries/${encodeURIComponent(key)}/reindex`, state.token, { method: "POST" });
    els.libraryManagerStatus.textContent = `${title} re-index started. You can keep using the app while it runs.`;
  } catch (err) {
    els.libraryManagerStatus.textContent = err.message || `Failed to re-index ${title}.`;
  } finally {
    if (button) {
      button.disabled = false;
    }
  }
}

async function deleteLibrary(key, title) {
  if (!window.confirm(`Remove ${title} from Media Baker? Files on disk are not deleted.`)) {
    return;
  }

  els.libraryManagerStatus.textContent = "Removing library...";
  try {
    await api(`/api/libraries/${encodeURIComponent(key)}`, state.token, { method: "DELETE" });
    await loadLibraryManager();
    await loadHome();
    els.libraryManagerStatus.textContent = "Library removed. Re-index running in the background.";
  } catch (err) {
    els.libraryManagerStatus.textContent = "Failed to remove library.";
  }
}

async function createLibraryShare(key) {
  els.libraryManagerStatus.textContent = "Creating share URL...";
  try {
    const result = await api(`/api/libraries/${encodeURIComponent(key)}/shares`, state.token, { method: "POST" });
    const url = result.share && result.share.url;
    if (url) {
      await copyText(url);
      els.libraryManagerStatus.textContent = "Share URL copied. You can copy it again from this list later.";
    } else {
      els.libraryManagerStatus.textContent = "Share created.";
    }
    await loadLibraryManager();
  } catch (err) {
    els.libraryManagerStatus.textContent = "Failed to create share URL.";
  }
}

async function copyText(value) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }
  } catch (err) {
    // Fall through to the prompt fallback.
  }

  window.prompt("Copy share URL", value);
}

async function revokeLibraryShare(libraryKey, shareId) {
  els.libraryManagerStatus.textContent = "Revoking share URL...";
  try {
    await api(`/api/libraries/${encodeURIComponent(libraryKey)}/shares/${encodeURIComponent(shareId)}`, state.token, { method: "DELETE" });
    await loadLibraryManager();
    els.libraryManagerStatus.textContent = "Share URL revoked.";
  } catch (err) {
    els.libraryManagerStatus.textContent = "Failed to revoke share URL.";
  }
}

async function loadNextLibraryPage() {
  const view = state.libraryView;
  if (!view || view.loading || !view.hasMore) {
    return;
  }

  view.loading = true;
  const requestId = view.requestId;
  view.status.textContent = view.offset === 0 ? "Loading library..." : "Loading more...";

  try {
    const params = new URLSearchParams({
      offset: String(view.offset),
      limit: String(LIBRARY_PAGE_SIZE),
      sort: view.sort || "alpha",
      metadata: view.metadataFilter || "all"
    });
    if (view.folder) {
      params.set("folder", view.folder);
    }
    const data = await api(`/api/catalog/libraries/${encodeURIComponent(view.key)}/items?${params.toString()}`);
    if (state.libraryView !== view || requestId !== view.requestId) {
      return;
    }

    view.supportsMetadataMatching = data.supportsMetadataMatching !== false;
    view.grid.closest(".library-results").querySelector(".library-filter-control")
      .classList.toggle("hidden", !view.supportsMetadataMatching || !hasPermission("canManageMetadata"));
    view.total = data.total;
    view.offset = data.nextOffset;
    view.hasMore = data.hasMore;
    view.title = data.title || view.title;
    view.heading.textContent = view.folder ? catalogFolderName(view.folder) : view.title;
    view.subtitle.textContent = `${data.total} items`;
    data.items.forEach((item) => view.grid.appendChild(card(item)));

    if (data.total === 0) {
      view.status.textContent = "No items found.";
    } else if (view.hasMore) {
      view.status.textContent = "";
    } else {
      view.status.textContent = `${view.grid.children.length} items loaded.`;
    }
  } catch (err) {
    if (state.libraryView === view) {
      view.status.textContent = "Failed to load more items.";
    }
  } finally {
    if (state.libraryView === view && requestId === view.requestId) {
      view.loading = false;
    }
  }
}

function stopLibraryLoading() {
  if (libraryObserver) {
    libraryObserver.disconnect();
    libraryObserver = null;
  }

  state.libraryView = null;
}

function seasonGrid(mediaType, show, season) {
  const section = document.createElement("section");
  section.className = "search-results";
  const grid = document.createElement("div");
  grid.className = "grid";
  season.episodes.map((episode) => episodeItem(mediaType, show, episode))
    .forEach((item) => grid.appendChild(card(item, { episodeArtwork: "thumbnail" })));
  section.appendChild(grid);
  return section;
}

function episodeItem(mediaType, show, episode) {
  return {
    id: episode.id,
    mediaType,
    category: libraryTitle(mediaType),
    title: episode.title || episode.filename,
    subtitle: `${show.name} S${pad(episode.season)}E${pad(episode.episode)}`,
    showId: show.id,
    showName: show.name,
    season: episode.season,
    episode: episode.episode,
    filePath: episode.filePath,
    thumbnailUrl: thumbnailUrlForEpisode(mediaType, episode.id),
    progress: episode.progress || null,
    searchText: `${show.name} ${episode.title || ""} ${episode.filename || ""}`
  };
}

function trackItem(mediaType, artist, album, track) {
  return {
    id: track.id,
    mediaType,
    category: libraryTitle(mediaType),
    itemType: "track",
    title: track.title || track.filename,
    subtitle: `${artist.name} - ${album.name}`,
    artistId: artist.id,
    artistName: artist.name,
    albumId: album.id,
    albumName: album.name,
    disc: track.disc,
    track: track.track,
    filePath: track.filePath,
    posterUrl: album.posterUrl || null,
    progress: track.progress || null,
    searchText: `${artist.name} ${album.name} ${track.title || ""}`
  };
}

function isEpisodeItem(item) {
  return item && item.showId && item.season !== undefined;
}

function isShowCard(item) {
  return Boolean(item)
    && (item.itemType === "show"
      || item.kind === "show"
      || item.type === "show"
      || (item.showId && item.id === item.showId && item.season === undefined && item.episode === undefined && !item.filePath));
}

function isArtistCard(item) {
  return Boolean(item) && (item.itemType === "artist" || item.kind === "artist" || item.type === "artist");
}

function isAlbumCard(item) {
  return Boolean(item) && (item.itemType === "album" || item.kind === "album" || item.type === "album");
}

function tvBasePath(mediaType) {
  return `/api/libraries/${encodeURIComponent(mediaType)}`;
}

function libraryTitle(mediaType) {
  const row = state.homeData && state.homeData.rows
    ? state.homeData.rows.find((entry) => entry.key === mediaType)
    : null;
  return row ? row.title : mediaType;
}

async function loadMetadata(item) {
  const selectedKey = mediaKey(item);
  try {
    const metadata = await api(`/api/catalog/${item.mediaType}/${item.id}/metadata`);
    if (!isSelectedKey(selectedKey) || !metadata.available) {
      return;
    }

    if (metadata.overview) {
      els.detailsOverview.textContent = metadata.overview;
    }

    if (metadata.title) {
      els.detailsTitle.textContent = metadata.title;
      if (!els.detailsPoster.classList.contains("with-image")) {
        els.detailsPoster.textContent = initials(metadata.title);
      }
      state.selected = {
        ...state.selected,
        title: metadata.title
      };
    }

    if (metadata.posterUrl) {
      if (!state.selected.thumbnailUrl) {
        setPosterImage(els.detailsPoster, metadata.posterUrl);
      }
      state.selected = {
        ...state.selected,
        posterUrl: metadata.posterUrl
      };
    }
  } catch (err) {
    if (isSelectedKey(selectedKey)) {
      els.detailsOverview.textContent = "";
    }
  }
}

function openPosterEditor() {
  if (!state.selected) {
    return;
  }

  els.posterForm.classList.remove("hidden");
  els.editPoster.classList.add("hidden");
  els.posterUrlInput.focus();
}

function closePosterEditor() {
  els.posterForm.classList.add("hidden");
  els.editPoster.classList.remove("hidden");
  els.posterUrlInput.value = "";
  els.posterStatus.textContent = "";
}

async function savePosterUrl(event) {
  event.preventDefault();
  if (!state.selected) {
    return;
  }

  const posterUrl = els.posterUrlInput.value.trim();
  if (!posterUrl) {
    els.posterStatus.textContent = "Enter a poster URL.";
    return;
  }

  try {
    new URL(posterUrl);
  } catch (err) {
    els.posterStatus.textContent = "Enter a valid URL.";
    return;
  }

  els.savePoster.disabled = true;
  els.posterStatus.textContent = "Saving poster...";

  try {
    const selectedKey = mediaKey(state.selected);
    const result = await api(`/api/catalog/${state.selected.mediaType}/${state.selected.id}/metadata/poster`, state.token, {
      method: "POST",
      body: JSON.stringify({ posterUrl })
    });

    if (!isSelectedKey(selectedKey)) {
      return;
    }

    if (result.posterUrl) {
      setPosterImage(els.detailsPoster, result.posterUrl);
      state.selected = {
        ...state.selected,
        posterUrl: result.posterUrl
      };
    }

    els.posterStatus.textContent = "Poster saved.";
    setTimeout(() => {
      if (isSelectedKey(selectedKey)) {
        closePosterEditor();
      }
    }, 650);
  } catch (err) {
    els.posterStatus.textContent = "Failed to save poster.";
  } finally {
    els.savePoster.disabled = false;
  }
}

async function rematchMetadata() {
  if (!state.selected) {
    return;
  }

  els.rematchMetadata.disabled = true;
  els.copyStatus.textContent = "Loading metadata search...";
  openMetadataMatchModal(metadataTargetFromItem(state.selected));

  try {
    await searchMetadataCandidates();
    els.copyStatus.textContent = "";
  } catch (err) {
    els.metadataMatchStatus.textContent = "Failed to load metadata search.";
    els.copyStatus.textContent = "Failed to load metadata search.";
  } finally {
    els.rematchMetadata.disabled = false;
  }
}

async function rematchShowMetadata(mediaType, show) {
  openMetadataMatchModal({
    mediaType,
    id: show.id,
    title: show.name,
    isShow: true
  });
  await searchMetadataCandidates();
}

function openMetadataMatchModal(target) {
  state.metadataMatchTarget = target || null;
  els.metadataMatchOverlay.classList.remove("hidden");
  els.metadataMatchOverlay.setAttribute("aria-hidden", "false");
  els.metadataMatchPrompt.textContent = target ? target.title : state.selected ? state.selected.title : "";
  els.metadataSearchTitle.value = "";
  els.metadataSearchYear.value = "";
  els.metadataProviderId.value = "";
  els.metadataProviderId.placeholder = target && target.itemType === "track" ? "MusicBrainz release ID" : "TMDb ID";
  els.metadataCandidateSelect.innerHTML = "";
  els.metadataCandidateOverview.textContent = "";
  els.metadataMatchStatus.textContent = "";
}

function closeMetadataMatchModal() {
  els.metadataMatchOverlay.classList.add("hidden");
  els.metadataMatchOverlay.setAttribute("aria-hidden", "true");
  state.metadataMatchTarget = null;
}

async function searchMetadataCandidates() {
  const target = state.metadataMatchTarget || metadataTargetFromItem(state.selected);
  if (!target) {
    return;
  }

  els.metadataSearchButton.disabled = true;
  els.metadataMatchStatus.textContent = "Searching metadata...";

  try {
    const params = new URLSearchParams();
    if (els.metadataSearchTitle.value.trim()) {
      params.set("title", els.metadataSearchTitle.value.trim());
    }
    if (els.metadataSearchYear.value.trim()) {
      params.set("year", els.metadataSearchYear.value.trim());
    }

    const suffix = params.toString() ? `?${params.toString()}` : "";
    const result = await api(`/api/catalog/${target.mediaType}/${target.id}/metadata/search${suffix}`, state.token);
    if (result.query) {
      els.metadataSearchTitle.value = result.query.title || "";
      els.metadataSearchYear.value = result.query.year || "";
    }

    renderMetadataCandidates(result.candidates || []);
    els.metadataMatchStatus.textContent = result.available === false
      ? result.reason || "Metadata search is unavailable."
      : `${(result.candidates || []).length} candidates found.`;
  } catch (err) {
    els.metadataMatchStatus.textContent = "Metadata search failed.";
  } finally {
    els.metadataSearchButton.disabled = false;
  }
}

function renderMetadataCandidates(candidates) {
  els.metadataCandidateSelect.innerHTML = "";
  for (const candidate of candidates) {
    const option = document.createElement("option");
    option.value = candidate.providerId;
    option.textContent = metadataCandidateLabel(candidate);
    option.dataset.overview = candidate.overview || "";
    els.metadataCandidateSelect.appendChild(option);
  }

  if (els.metadataCandidateSelect.options.length > 0) {
    els.metadataCandidateSelect.selectedIndex = 0;
  }
  updateMetadataCandidateOverview();
}

function metadataCandidateLabel(candidate) {
  const bits = [
    candidate.title,
    candidate.year || null,
    candidate.originalTitle && candidate.originalTitle !== candidate.title ? candidate.originalTitle : null,
    candidate.score ? `score ${candidate.score}` : null
  ].filter(Boolean);
  return bits.join(" - ");
}

function updateMetadataCandidateOverview() {
  const option = els.metadataCandidateSelect.selectedOptions[0];
  els.metadataCandidateOverview.textContent = option ? option.dataset.overview || "" : "";
  if (option) {
    els.metadataProviderId.value = option.value;
  }
}

async function applyMetadataMatch() {
  const target = state.metadataMatchTarget || metadataTargetFromItem(state.selected);
  if (!target) {
    return;
  }

  const providerId = els.metadataProviderId.value.trim()
    || els.metadataCandidateSelect.value;
  if (!providerId) {
    els.metadataMatchStatus.textContent = "Enter a provider ID or select a result.";
    return;
  }

  const selectedKey = state.selected ? mediaKey(state.selected) : null;
  els.metadataApplyMatch.disabled = true;
  els.metadataMatchStatus.textContent = "Applying metadata match...";

  try {
    const result = await api(`/api/catalog/${target.mediaType}/${target.id}/metadata/match`, state.token, {
      method: "POST",
      body: JSON.stringify({ providerId })
    });
    if (target.isShow) {
      closeMetadataMatchModal();
      els.copyStatus.textContent = "Show metadata match applied.";
      if (state.currentView === "show") {
        openShowView(target.mediaType, target.id);
      }
      return;
    }
    if (selectedKey && !isSelectedKey(selectedKey)) {
      return;
    }

    applyMetadataResult(result);
    if (state.libraryView && state.libraryView.metadataFilter === "unmatched") {
      resetLibraryPage();
    }
    closeMetadataMatchModal();
    els.copyStatus.textContent = "Metadata match applied.";
  } catch (err) {
    els.metadataMatchStatus.textContent = "Failed to apply metadata match.";
  } finally {
    els.metadataApplyMatch.disabled = false;
  }
}

function metadataTargetFromItem(item) {
  return item ? {
    mediaType: item.mediaType,
    id: item.id,
    title: item.title,
    itemType: item.itemType
  } : null;
}

function applyMetadataResult(result) {
  if (!result.available) {
    return;
  }

  const title = result.title || state.selected.title;
  els.detailsTitle.textContent = title;
  els.detailsOverview.textContent = result.overview || "";
  state.selected = {
    ...state.selected,
    title,
    posterUrl: result.posterUrl || null
  };

  if (state.selected.preferredArtworkUrl && !state.selected.thumbnailUrl) {
    setPosterImage(els.detailsPoster, state.selected.preferredArtworkUrl);
  } else if (result.posterUrl && !state.selected.thumbnailUrl) {
    setPosterImage(els.detailsPoster, result.posterUrl);
  } else if (!state.selected.thumbnailUrl) {
    els.detailsPoster.classList.remove("with-image");
    els.detailsPoster.style.removeProperty("--poster-image");
    els.detailsPoster.textContent = initials(title);
  }
  setWatchedMarker(els.detailsPoster, isWatchedProgress(state.selected.progress));
}

function setPosterImage(element, url) {
  [...element.childNodes]
    .filter((child) => child.nodeType === Node.TEXT_NODE)
    .forEach((child) => child.remove());
  element.style.setProperty("--poster-image", `url("${url.replace(/"/g, "%22")}")`);
  element.classList.add("with-image");
}

function imageUrlForItem(item) {
  return item && (item.collageUrl || item.thumbnailUrl || item.posterUrl) || null;
}

function showImageViewer(url, title) {
  els.imageViewerImage.src = url;
  els.imageViewerImage.alt = title || "Image preview";
  els.imageViewer.classList.remove("hidden");
  els.imageViewer.setAttribute("aria-hidden", "false");
  document.body.classList.add("image-viewer-open");
}

function hideImageViewer() {
  els.imageViewer.classList.add("hidden");
  els.imageViewer.setAttribute("aria-hidden", "true");
  els.imageViewerImage.removeAttribute("src");
  els.imageViewerImage.alt = "";
  document.body.classList.remove("image-viewer-open");
}

function catalogFolderName(folder) {
  const parts = String(folder || "").split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || "Images";
}

function parentFolderPath(folder) {
  const parts = String(folder || "").replace(/\\/g, "/").split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

function thumbnailUrlForEpisode(mediaType, id) {
  const url = new URL(`/api/catalog/${encodeURIComponent(mediaType)}/${encodeURIComponent(id)}/metadata/thumbnail`, window.location.origin);
  const auth = authQuery();
  url.searchParams.set(auth.name, auth.value);
  return url.toString();
}

function progressBarHtml(progress) {
  if (!progress || !progress.percent || progress.status === "watched") {
    return "";
  }

  return `<div class="progress-track" aria-hidden="true"><span class="progress-fill" style="--progress: ${Math.max(0, Math.min(progress.percent, 100))}%"></span></div>`;
}

function updateRenderedCardsProgress(item, progress) {
  const key = mediaKey(item);
  if (!key) {
    return;
  }
  document.querySelectorAll(`.card[data-media-key="${cssEscape(key)}"]`).forEach((cardElement) => {
    cardElement.classList.toggle("watched-card", isWatchedProgress(progress));
    const poster = cardElement.querySelector(".poster");
    setWatchedMarker(poster, isWatchedProgress(progress));
    const progressSlot = cardElement.querySelector(".card-progress-slot");
    if (progressSlot) {
      progressSlot.innerHTML = progressBarHtml(progress);
    }
  });
}

function isWatchedProgress(progress) {
  return Boolean(progress && progress.status === "watched");
}

function setWatchedMarker(element, watched) {
  if (!element) {
    return;
  }
  let marker = element.querySelector(".watched-marker");
  if (!watched) {
    marker?.remove();
    element.classList.remove("is-watched");
    return;
  }
  if (!marker) {
    marker = document.createElement("span");
    marker.className = "watched-marker";
    marker.setAttribute("aria-label", "Watched");
    marker.title = "Watched";
    element.appendChild(marker);
  }
  element.classList.add("is-watched");
}

function renderDetailsProgress(progress) {
  setWatchedMarker(els.detailsPoster, isWatchedProgress(progress));
  if (!progress || !progress.percent || progress.status === "watched") {
    els.detailsProgress.classList.add("hidden");
    els.detailsProgressFill.style.removeProperty("--progress");
    els.detailsProgressText.textContent = "";
    return;
  }

  els.detailsProgress.classList.remove("hidden");
  els.detailsProgressFill.style.setProperty("--progress", `${Math.max(0, Math.min(progress.percent, 100))}%`);
  els.detailsProgressText.textContent = `${progress.percent}% watched - resume from ${formatDuration(progress.resumeSeconds || progress.positionSeconds || 0)}`;
}

function updateManagementActions(progress) {
  const onDeck = progress && progress.status === "in_progress" && Number(progress.positionSeconds) > 0;
  els.removeOnDeck.classList.toggle("hidden", !onDeck);
}

function updateAdminControls() {
  els.accountButton.classList.toggle("hidden", !state.user || Boolean(state.shareToken));
  els.accountButton.title = state.user ? `Account settings for ${state.user.username}` : "Account settings";
  els.adminPanelButton.classList.toggle("hidden", !hasPermission("canViewAdmin"));
  els.liveTvButton.classList.toggle("hidden", !state.token || Boolean(state.shareToken) || !state.iptvEnabled || !canAccessLiveTv());
  const ytdlp = state.health && state.health.binaries && state.health.binaries.ytdlp;
  const ytdlpUnavailable = Boolean(state.features.ytdlp && ytdlp && !ytdlp.ok);
  els.downloadButton.classList.toggle("hidden", !state.token || Boolean(state.shareToken) || !state.features.ytdlp);
  els.downloadButton.disabled = ytdlpUnavailable;
  els.downloadButton.title = ytdlpUnavailable ? "YT-DLP is enabled but not available on the server." : "Download URL";
  renderUpdateBanner();
}

function canAccessLiveTv() {
  if (!state.user || state.shareToken) {
    return false;
  }
  const permissions = state.user.permissions || {};
  return Boolean(permissions.isAdmin || (permissions.libraries || []).includes(LIVE_TV_PERMISSION_KEY));
}

function updateDetailsAdminControls() {
  const signedIn = Boolean(state.user);
  const canManageMetadata = hasPermission("canManageMetadata");
  const image = Boolean(state.selected && state.selected.itemType === "image");
  els.editPoster.classList.toggle("hidden", image || !canManageMetadata);
  els.pregenerateHls.classList.toggle("hidden", image || !isAdminMode());
  els.rematchMetadata.classList.toggle("hidden", image || !canManageMetadata);
  els.markWatched.classList.toggle("hidden", image || !signedIn);
  els.removeOnDeck.classList.toggle("hidden", image || !signedIn || !(state.selected && state.selected.progress && state.selected.progress.status === "in_progress" && Number(state.selected.progress.positionSeconds) > 0));
  els.playStream.classList.toggle("hidden", image);
  els.copyUrl.classList.toggle("hidden", !hasPermission("canCopyStreamUrls"));
  els.copyUrl.textContent = image ? "Copy image URL" : "Copy URL";
  for (const select of [els.audioSelect, els.qualitySelect, els.subtitleSelect]) {
    select.closest("label").classList.toggle("hidden", image);
  }
}

function updatePlaybackControls() {
  const disabled = !isPlaybackReady();
  for (const button of [els.playStream, els.copyUrl, els.pregenerateHls]) {
    button.disabled = disabled;
    button.title = disabled ? playbackDisabledMessage() : "";
  }
}

function isAdminMode() {
  return Boolean(state.user && state.user.permissions && state.user.permissions.isAdmin);
}

function hasPermission(permission) {
  if (!state.user || state.shareToken) {
    return false;
  }
  const permissions = state.user.permissions || {};
  return Boolean(permissions.isAdmin || permissions[permission]);
}

async function refreshSelectedProgress() {
  if (!state.selected || els.detailsPanel.getAttribute("aria-hidden") === "true") {
    return null;
  }
  if (progressRefreshPromise) {
    return progressRefreshPromise;
  }

  const selectedKey = mediaKey(state.selected);
  progressRefreshPromise = api(`/api/progress/${state.selected.mediaType}/${state.selected.id}`)
    .then((progress) => {
      if (!isSelectedKey(selectedKey)) {
        return null;
      }

      state.selected = {
        ...state.selected,
        progress
      };
      renderDetailsProgress(progress);
      updateManagementActions(progress);
      updateRenderedCardsProgress(state.selected, progress);
      return progress;
    })
    .catch(() => null)
    .finally(() => {
      progressRefreshPromise = null;
    });

  return progressRefreshPromise;
}

function formatDuration(secondsValue) {
  const total = Math.max(0, Math.floor(Number(secondsValue) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  const units = ["B", "KB", "MB", "GB", "TB"];
  let selected = bytes;
  let unit = 0;
  while (selected >= 1024 && unit < units.length - 1) {
    selected /= 1024;
    unit += 1;
  }
  const precision = selected >= 100 || unit === 0 ? 0 : selected >= 10 ? 1 : 2;
  return `${selected.toFixed(precision)} ${units[unit]}`;
}

function fillSelect(select, options) {
  select.innerHTML = "";
  for (const option of options) {
    const element = document.createElement("option");
    element.value = option.id;
    element.textContent = option.label;
    select.appendChild(element);
  }
}

function updateAudioChannelsControl() {
  const selected = selectedAudioOption();
  if (selected && selected.surround51) {
    els.audioChannelsLabel.classList.remove("hidden");
    if (!els.audioChannelsSelect.value) {
      els.audioChannelsSelect.value = "stereo";
    }
    return;
  }

  els.audioChannelsLabel.classList.add("hidden");
  els.audioChannelsSelect.value = "stereo";
}

function selectedAudioOption() {
  if (!state.options || !Array.isArray(state.options.audio)) {
    return null;
  }

  return state.options.audio.find((entry) => entry.id === els.audioSelect.value) || null;
}

function selectedAudioChannels() {
  if (state.selected && state.selected.itemType === "track") {
    return "preserve";
  }
  return els.audioChannelsLabel.classList.contains("hidden")
    ? "preserve"
    : els.audioChannelsSelect.value;
}

function selectedQuality() {
  return els.qualitySelect.value || "original";
}

function applyPlaybackPreferencesToControls(options) {
  const preferences = normalizePlaybackPreferences(state.playbackPreferences);
  state.applyingPlaybackPreferences = true;
  try {
    selectPreferredOption(els.qualitySelect, preferredQualityValue(els.qualitySelect, preferences.quality));
    selectPreferredOption(els.audioSelect, preferredAudioValue(options.audio || [], preferences.audioLanguage));
    updateAudioChannelsControl();
    if (!els.audioChannelsLabel.classList.contains("hidden")) {
      selectPreferredOption(els.audioChannelsSelect, preferences.audioChannels || "stereo");
    }
    selectPreferredOption(els.subtitleSelect, preferredSubtitleValue(options.subtitles || [], preferences));
  } finally {
    state.applyingPlaybackPreferences = false;
  }
}

function preferredQualityValue(select, quality) {
  const requested = quality || "original";
  if (hasSelectValue(select, requested)) {
    return requested;
  }
  return hasSelectValue(select, "original") ? "original" : firstSelectValue(select);
}

function preferredAudioValue(audioOptions, language) {
  const playable = audioOptions.filter((option) => option && option.id && option.id !== "none" && option.id !== "default");
  if (!language) {
    return playable[0] && playable[0].id || audioOptions[0] && audioOptions[0].id || "";
  }
  const normalized = normalizePreferenceText(language);
  const preferred = playable.find((option) => normalizePreferenceText(option.language) === normalized)
    || playable.find((option) => normalizePreferenceText(option.label).includes(normalized));
  return preferred && preferred.id || playable[0] && playable[0].id || audioOptions[0] && audioOptions[0].id || "";
}

function preferredSubtitleValue(subtitleOptions, preferences) {
  const none = subtitleOptions.find((option) => option && option.id === "none");
  const available = subtitleOptions.filter((option) => option && option.id && option.id !== "none");
  if (preferences.subtitleMode === "none") {
    return none && none.id || subtitleOptions[0] && subtitleOptions[0].id || "";
  }
  if (available.length === 0) {
    return none && none.id || "";
  }

  const language = normalizePreferenceText(preferences.subtitleLanguage);
  const languageMatches = language
    ? available.filter((option) => normalizePreferenceText(option.language) === language
      || normalizePreferenceText(option.label).includes(language))
    : available;
  const candidates = languageMatches.length > 0 ? languageMatches : available;
  if (preferences.subtitleMode === "forced") {
    const forced = candidates.find((option) => option.forced);
    return forced && forced.id || candidates[0].id;
  }

  const nonForced = candidates.filter((option) => !option.forced);
  const preferred = nonForced.find((option) => /full|english/i.test(option.label || ""))
    || nonForced[0]
    || candidates[0];
  return preferred && preferred.id || none && none.id || "";
}

function selectPreferredOption(select, value) {
  if (value && hasSelectValue(select, value)) {
    select.value = value;
    return;
  }
  const first = firstSelectValue(select);
  if (first) {
    select.value = first;
  }
}

function hasSelectValue(select, value) {
  return Array.from(select.options).some((option) => option.value === value);
}

function firstSelectValue(select) {
  return select.options.length > 0 ? select.options[0].value : "";
}

function savePlaybackPreferencesFromControls() {
  if (state.applyingPlaybackPreferences || !state.options) {
    return;
  }
  const audio = selectedAudioOption();
  const subtitle = (state.options.subtitles || []).find((entry) => entry.id === els.subtitleSelect.value) || null;
  const preferences = normalizePlaybackPreferences({
    ...state.playbackPreferences,
    audioLanguage: audio && audio.id !== "none" && audio.id !== "default" ? audio.language || "" : "",
    subtitleLanguage: subtitle && subtitle.id !== "none" ? subtitle.language || "" : "",
    subtitleMode: subtitleModeForOption(subtitle),
    quality: selectedQuality(),
    audioChannels: els.audioChannelsLabel.classList.contains("hidden")
      ? state.playbackPreferences.audioChannels
      : els.audioChannelsSelect.value
  });
  setPlaybackPreferences(preferences);
  persistPlaybackPreferences(preferences);
}

function subtitleModeForOption(option) {
  if (!option || option.id === "none") {
    return "none";
  }
  return option.forced ? "forced" : "preferred";
}

function setPlaybackPreferences(preferences) {
  state.playbackPreferences = normalizePlaybackPreferences(preferences);
  localStorage.setItem(PLAYBACK_PREFERENCES_KEY, JSON.stringify(state.playbackPreferences));
}

function readLocalPlaybackPreferences() {
  try {
    return normalizePlaybackPreferences(JSON.parse(localStorage.getItem(PLAYBACK_PREFERENCES_KEY) || "{}"));
  } catch (err) {
    return { ...DEFAULT_PLAYBACK_PREFERENCES };
  }
}

let savePlaybackPreferencesTimer = null;
function persistPlaybackPreferences(preferences) {
  if (!state.token || state.shareToken || !state.user) {
    return;
  }
  window.clearTimeout(savePlaybackPreferencesTimer);
  savePlaybackPreferencesTimer = window.setTimeout(() => {
    api("/api/auth/me/preferences", state.token, {
      method: "PUT",
      body: JSON.stringify({ preferences })
    }).then((result) => {
      if (result && result.user) {
        state.user = result.user;
      }
      if (result && result.preferences) {
        setPlaybackPreferences(result.preferences);
      }
    }).catch(() => {});
  }, 250);
}

function normalizePlaybackPreferences(value = {}) {
  const preferences = {
    ...DEFAULT_PLAYBACK_PREFERENCES,
    ...(value || {})
  };
  const subtitleMode = normalizePreferenceText(preferences.subtitleMode);
  const quality = normalizePreferenceText(preferences.quality);
  const audioChannels = normalizePreferenceText(preferences.audioChannels);
  return {
    audioLanguage: normalizePreferenceText(preferences.audioLanguage),
    subtitleLanguage: normalizePreferenceText(preferences.subtitleLanguage),
    subtitleMode: ["none", "preferred", "forced", "any"].includes(subtitleMode) ? subtitleMode : "none",
    quality: ["original", "medium", "low"].includes(quality) ? quality : "original",
    audioChannels: ["stereo", "surround51", "stabby51", "preserve"].includes(audioChannels) ? audioChannels : "stereo"
  };
}

function normalizePreferenceText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "");
}

function resetSubtitleSearch() {
  els.subtitleSearchPanel.classList.add("hidden");
  els.subtitleLanguageInput.value = "en";
  els.subtitleCandidatesLabel.classList.add("hidden");
  els.subtitleCandidatesSelect.innerHTML = "";
  els.subtitleSyncControls.classList.add("hidden");
  els.subtitleSearchStatus.textContent = "";
}

function updateSubtitleSearchControl() {
  const enabled = isAdminMode() && state.options && state.options.subtitleSearch && state.options.subtitleSearch.enabled;
  els.subtitleSearchPanel.classList.toggle("hidden", !enabled);
}

async function searchSubtitles() {
  if (!state.selected) {
    return;
  }

  els.searchSubtitles.disabled = true;
  els.subtitleSearchStatus.textContent = "Searching subtitles...";
  els.subtitleCandidatesLabel.classList.add("hidden");
  els.subtitleCandidatesSelect.innerHTML = "";
  els.subtitleSyncControls.classList.add("hidden");

  try {
    const language = els.subtitleLanguageInput.value.trim() || "en";
    const result = await api(`/api/catalog/${state.selected.mediaType}/${state.selected.id}/subtitles/search?language=${encodeURIComponent(language)}`);
    if (!result.enabled) {
      els.subtitleSearchStatus.textContent = result.reason || "Subtitle search is disabled.";
      return;
    }

    if (!result.candidates || result.candidates.length === 0) {
      els.subtitleSearchStatus.textContent = "No subtitle matches found.";
      return;
    }

    fillSelect(els.subtitleCandidatesSelect, result.candidates.map((candidate) => ({
      id: candidate.id,
      label: candidate.label
    })));
    els.subtitleCandidatesLabel.classList.remove("hidden");
    els.subtitleSyncControls.classList.remove("hidden");
    els.subtitleSearchStatus.textContent = `${result.candidates.length} matches found. Choose one to download and auto-sync.`;
  } catch (err) {
    els.subtitleSearchStatus.textContent = "Subtitle search failed.";
  } finally {
    els.searchSubtitles.disabled = false;
  }
}

async function addSelectedSubtitle() {
  if (!state.selected || !els.subtitleCandidatesSelect.value) {
    return;
  }

  els.addSubtitle.disabled = true;
  els.subtitleSearchStatus.textContent = "Downloading and syncing selected subtitle...";

  try {
    const result = await api(`/api/catalog/${state.selected.mediaType}/${state.selected.id}/subtitles/select`, state.token, {
      method: "POST",
      body: JSON.stringify({
        candidateId: els.subtitleCandidatesSelect.value
      })
    });

    const option = result.subtitle;
    if (option) {
      appendOrReplaceOption(els.subtitleSelect, option.id, option.label);
      els.subtitleSelect.value = option.id;
      savePlaybackPreferencesFromControls();
      els.subtitleSearchStatus.textContent = "Subtitle synced, added, and selected.";
    }
  } catch (err) {
    els.subtitleSearchStatus.textContent = "Failed to add or sync subtitle. Check subtitle provider and sync settings.";
  } finally {
    els.addSubtitle.disabled = false;
  }
}

function appendOrReplaceOption(select, value, label) {
  const existing = Array.from(select.options).find((option) => option.value === value);
  if (existing) {
    existing.textContent = label;
    return;
  }

  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  select.appendChild(option);
}

function updateProTv3dControl() {
  const proTv3d = state.options && state.options.proTv3d;
  if (!proTv3d || !proTv3d.enabled) {
    els.proTv3dLabel.classList.add("hidden");
    els.proTv3dSelect.value = "auto";
    els.proTv3dStatus.textContent = "";
    return;
  }

  els.proTv3dLabel.classList.remove("hidden");
  els.proTv3dSelect.value = "auto";
  updateProTv3dStatus();
}

function updateProTv3dStatus() {
  if (els.proTv3dLabel.classList.contains("hidden")) {
    return;
  }

  const proTv3d = state.options && state.options.proTv3d;
  const selected = els.proTv3dSelect.value;
  if (selected === "off") {
    els.proTv3dStatus.textContent = "3D parameters will not be added.";
    return;
  }

  if (selected !== "auto") {
    els.proTv3dStatus.textContent = `Override: ${proTv3dModeLabel(selected)}.`;
    return;
  }

  const mode = proTv3d && proTv3d.mode;
  const source = proTv3d && proTv3d.source === "library" ? "library fallback" : "filename";
  els.proTv3dStatus.textContent = `Auto: ${proTv3dModeLabel(mode)} (${source}).`;
}

function selectedProTv3dMode() {
  if (els.proTv3dLabel.classList.contains("hidden")) {
    return null;
  }

  const selected = els.proTv3dSelect.value;
  if (selected === "off") {
    return null;
  }
  if (selected !== "auto") {
    return selected;
  }

  const proTv3d = state.options && state.options.proTv3d;
  return proTv3d && proTv3d.enabled ? proTv3d.mode : null;
}

async function copyStreamUrl() {
  if (!state.selected) {
    return;
  }
  if (!hasPermission("canCopyStreamUrls")) {
    els.copyStatus.textContent = "Your account cannot copy playback URLs.";
    return;
  }
  if (!isPlaybackReady()) {
    els.copyStatus.textContent = playbackDisabledMessage();
    return;
  }

  const resumeSeconds = state.selected.itemType === "image" ? 0 : await selectedResumeSeconds("copy");
  if (resumeSeconds === null) {
    return;
  }

  let copyToken;
  try {
    const result = await api(`/api/catalog/${encodeURIComponent(state.selected.mediaType)}/${encodeURIComponent(state.selected.id)}/copy-token`, state.token, {
      method: "POST"
    });
    copyToken = result.playbackToken;
  } catch (err) {
    els.copyStatus.textContent = err.message || "Could not create a playback URL.";
    return;
  }

  const url = selectedStreamUrl({ surface: "copy", playbackToken: copyToken, includeProTv3d: true, resumeSeconds });
  if (!url) {
    return;
  }

  const value = url.toString();
  try {
    await writeClipboard(value);
    hideManualCopyUrl();
    els.copyStatus.textContent = "Copied stream URL.";
  } catch (err) {
    showManualCopyUrl(value);
    els.copyStatus.textContent = "Clipboard access failed.";
  }
}

async function writeClipboard(value) {
  if (!navigator.clipboard || !navigator.clipboard.writeText) {
    throw new Error("Clipboard API unavailable");
  }
  await navigator.clipboard.writeText(value);
}

function showManualCopyUrl(value) {
  els.manualCopyUrl.value = value;
  els.manualCopyBar.classList.remove("hidden");
  window.setTimeout(() => {
    els.manualCopyUrl.focus();
    els.manualCopyUrl.select();
  }, 0);
}

function hideManualCopyUrl() {
  els.manualCopyUrl.value = "";
  els.manualCopyBar.classList.add("hidden");
}

async function playStream() {
  if (!state.selected) {
    return;
  }
  if (!isPlaybackReady()) {
    els.copyStatus.textContent = playbackDisabledMessage();
    return;
  }

  const resumeSeconds = await selectedResumeSeconds("play");
  if (resumeSeconds === null) {
    return;
  }

  const url = selectedStreamUrl({ surface: "web", includeProTv3d: false });
  if (!url) {
    return;
  }

  await openWebPlayer(url, {
    category: state.selected.category || "",
    title: state.selected.title || "Playback",
    audioOnly: state.selected.itemType === "track",
    audioMetadata: state.selected.itemType === "track" ? {
      title: state.selected.title,
      artist: state.selected.artistName,
      album: state.selected.albumName,
      artwork: state.selected.posterUrl || state.selected.thumbnailUrl || null
    } : null,
    resumeSeconds,
    errorMessage: "Playback failed. Try pre-generating HLS or check the stream logs.",
    fallbackUrl: fallbackWebPlayerUrl(),
    autoAdvance: Boolean(state.options && state.options.nextItem),
    hlsOptions: {
      lowLatencyMode: false,
      backBufferLength: 90
    }
  });
}

async function openWebPlayer(url, options = {}) {
  closePlayer();
  const resumeSeconds = Math.max(0, Number(options.resumeSeconds) || 0);
  const fallbackUrl = options.fallbackUrl ? options.fallbackUrl.toString() : "";
  const audioOnly = Boolean(options.audioOnly);
  let fallbackStarted = false;
  els.playerCategory.textContent = options.category || "";
  els.playerTitle.textContent = options.title || "Playback";
  setPlayerStatus("Preparing stream...");
  els.playerOverlay.classList.toggle("live-player", Boolean(options.live));
  els.playerOverlay.classList.toggle("hidden", audioOnly);
  els.playerOverlay.setAttribute("aria-hidden", audioOnly ? "true" : "false");
  if (audioOnly) {
    showMusicPlayer(options.audioMetadata || {}, Boolean(options.autoAdvance));
  }

  const video = els.webPlayer;
  video.controls = false;
  video.autoplay = true;
  video.playsInline = true;
  video.dataset.autoAdvance = options.autoAdvance ? "true" : "false";
  els.videoPlaybackSurface.classList.toggle("audio-only", audioOnly);
  updateVideoPlayerControls();
  updateVideoPictureInPictureControl();

  const startFallback = () => {
    if (!fallbackUrl || fallbackStarted) {
      return false;
    }
    fallbackStarted = true;
    video.dataset.autoAdvance = "false";
    els.musicNext.disabled = true;
    setPlayerStatus("The requested stream failed. Playing the fallback stream.");
    return true;
  };

  try {
    const hlsJsSupported = Boolean(window.Hls && window.Hls.isSupported());
    if (!hlsJsSupported && video.canPlayType("application/vnd.apple.mpegurl")) {
      nativePlayerErrorHandler = () => {
        if (!fallbackStarted) {
          options.onPlaybackError?.({
            source: "native-hls",
            message: video.error && video.error.message || "Native HLS playback error"
          });
        }
        if (startFallback()) {
          video.src = fallbackUrl;
          video.play().catch(() => {
            setPlayerStatus("The fallback stream could not be played.");
          });
          return;
        }
        setPlayerStatus(fallbackStarted
          ? "The fallback stream could not be played."
          : options.errorMessage || "Playback failed.");
      };
      video.addEventListener("error", nativePlayerErrorHandler);
      video.src = url.toString();
      await seekNativeVideo(video, resumeSeconds);
      await video.play();
      setPlayerStatus("");
      return;
    }

    if (!hlsJsSupported) {
      setPlayerStatus("This browser cannot play HLS.");
      return;
    }

    const startHls = (source, isFallback = false) => {
      const player = new window.Hls(isFallback ? {} : options.hlsOptions || {});
      let liveRecoveryAttempts = 0;
      hlsPlayer = player;
      player.on(window.Hls.Events.ERROR, (event, data) => {
        if (!data || !data.fatal) {
          return;
        }
        if (!isFallback) {
          options.onPlaybackError?.({
            source: "hls.js",
            type: data.type || "",
            details: data.details || "",
            reason: data.reason || "",
            responseCode: data.response && data.response.code || null
          });
        }
        if (!isFallback && options.live && liveRecoveryAttempts < 3) {
          if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) {
            liveRecoveryAttempts += 1;
            setPlayerStatus("Reconnecting live stream...");
            player.startLoad(-1);
            return;
          }
          if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) {
            liveRecoveryAttempts += 1;
            setPlayerStatus("Recovering live playback...");
            player.recoverMediaError();
            return;
          }
        }
        if (!isFallback && startFallback()) {
          player.destroy();
          if (hlsPlayer === player) {
            hlsPlayer = null;
          }
          startHls(fallbackUrl, true);
          return;
        }
        setPlayerStatus(isFallback
          ? "The fallback stream could not be played."
          : options.errorMessage || "Playback failed.");
      });
      player.on(window.Hls.Events.FRAG_BUFFERED, () => {
        liveRecoveryAttempts = 0;
        if (!isFallback) {
          setPlayerStatus("");
        }
      });
      player.on(window.Hls.Events.MANIFEST_PARSED, async () => {
        try {
          if (!isFallback && resumeSeconds > 0) {
            video.currentTime = resumeSeconds;
          }
          await video.play();
          if (!isFallback) {
            setPlayerStatus("");
          }
        } catch (err) {
          setPlayerStatus("Press play to start playback.");
        }
      });
      player.loadSource(source);
      player.attachMedia(video);
    };
    startHls(url.toString());
  } catch (err) {
    if (startFallback()) {
      video.src = fallbackUrl;
      video.play().catch(() => {
        setPlayerStatus("The fallback stream could not be played.");
      });
    } else {
      setPlayerStatus(options.errorMessage || "Playback failed to start.");
    }
  }
}

function closePlayer() {
  stopOnDeckPolling();
  exitVideoPictureInPicture();
  clearTimeout(videoControlsHideTimer);
  videoControlsHideTimer = null;
  if (hlsPlayer) {
    hlsPlayer.destroy();
    hlsPlayer = null;
  }

  if (els.webPlayer) {
    if (nativePlayerErrorHandler) {
      els.webPlayer.removeEventListener("error", nativePlayerErrorHandler);
      nativePlayerErrorHandler = null;
    }
    els.webPlayer.pause();
    if (els.videoPlaybackSurface.parentElement !== els.videoPlayerSlot) {
      els.videoPlayerSlot.appendChild(els.videoPlaybackSurface);
    }
    els.webPlayer.dataset.autoAdvance = "false";
    els.webPlayer.removeAttribute("src");
    els.webPlayer.load();
  }

  els.playerOverlay.classList.add("hidden");
  els.playerOverlay.classList.remove("live-player");
  els.playerOverlay.setAttribute("aria-hidden", "true");
  els.musicPlayer.classList.add("hidden");
  els.musicPlayer.setAttribute("aria-hidden", "true");
  els.videoMiniPlayer.classList.add("hidden");
  els.videoMiniPlayer.setAttribute("aria-hidden", "true");
  setPlayerStatus("");
}

function minimizeVideoPlayback() {
  if (els.playerOverlay.classList.contains("hidden") || els.videoPlaybackSurface.parentElement !== els.videoPlayerSlot) {
    return;
  }
  els.videoMiniCategory.textContent = els.playerCategory.textContent;
  els.videoMiniTitle.textContent = els.playerTitle.textContent;
  els.videoMiniPlayer.classList.remove("hidden");
  els.videoMiniPlayer.setAttribute("aria-hidden", "false");
  moveActiveWebPlayer(els.videoMiniPlayerSlot);
  els.playerOverlay.classList.add("hidden");
  els.playerOverlay.setAttribute("aria-hidden", "true");
  restoreVideoPlayerPosition();
}

function restoreVideoPlayback() {
  if (els.videoMiniPlayer.classList.contains("hidden")) {
    return;
  }
  els.playerOverlay.classList.remove("hidden");
  els.playerOverlay.setAttribute("aria-hidden", "false");
  moveActiveWebPlayer(els.videoPlayerSlot);
  els.videoMiniPlayer.classList.add("hidden");
  els.videoMiniPlayer.setAttribute("aria-hidden", "true");
}

function moveActiveWebPlayer(target) {
  const wasPlaying = !els.webPlayer.paused;
  target.appendChild(els.videoPlaybackSurface);
  if (wasPlaying && els.webPlayer.paused) {
    els.webPlayer.play().catch(() => setPlayerStatus("Press play to continue playback."));
  }
}

function toggleVideoPlayback() {
  if (els.videoPlaybackSurface.classList.contains("audio-only")) {
    return;
  }
  if (els.webPlayer.paused) {
    els.webPlayer.play().catch(() => setPlayerStatus("Playback could not be resumed."));
  } else {
    els.webPlayer.pause();
  }
}

function seekVideoPlayback() {
  const duration = Number(els.webPlayer.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    return;
  }
  els.webPlayer.currentTime = duration * (Number(els.videoSeek.value) || 0) / 1000;
  els.videoCurrentTime.textContent = formatMediaTime(els.webPlayer.currentTime);
}

function updateVideoVolume() {
  els.webPlayer.muted = false;
  els.webPlayer.volume = Math.max(0, Math.min(1, Number(els.videoVolume.value) || 0));
}

function toggleVideoMute() {
  els.webPlayer.muted = !els.webPlayer.muted;
}

function updateVideoPlayerControls() {
  const duration = Number(els.webPlayer.duration);
  const currentTime = Number(els.webPlayer.currentTime) || 0;
  const paused = els.webPlayer.paused;
  const muted = els.webPlayer.muted || els.webPlayer.volume === 0;
  els.videoPlayPause.innerHTML = paused ? "&#9654;" : "&#10074;&#10074;";
  els.videoPlayPause.title = paused ? "Play" : "Pause";
  els.videoPlayPause.setAttribute("aria-label", paused ? "Play" : "Pause");
  els.videoMute.innerHTML = muted ? "&#128263;" : "&#128266;";
  els.videoMute.title = muted ? "Unmute" : "Mute";
  els.videoMute.setAttribute("aria-label", muted ? "Unmute" : "Mute");
  els.videoVolume.value = String(els.webPlayer.volume);
  els.videoCurrentTime.textContent = formatMediaTime(currentTime);
  els.videoDuration.textContent = formatMediaTime(duration);
  if (!videoSeeking) {
    els.videoSeek.value = Number.isFinite(duration) && duration > 0
      ? String(Math.round(currentTime / duration * 1000))
      : "0";
  }
  if (paused) {
    showVideoControls(false);
  } else if (!videoControlsHideTimer && !els.videoPlaybackSurface.classList.contains("controls-hidden")) {
    scheduleVideoControlsHide();
  }
}

function toggleVideoPictureInPicture() {
  const video = els.webPlayer;
  try {
    if (document.pictureInPictureElement === video && typeof document.exitPictureInPicture === "function") {
      handlePictureInPictureResult(document.exitPictureInPicture());
      return;
    }
    if (video.webkitPresentationMode === "picture-in-picture" && typeof video.webkitSetPresentationMode === "function") {
      video.webkitSetPresentationMode("inline");
      return;
    }
    if (typeof video.requestPictureInPicture === "function" && document.pictureInPictureEnabled !== false) {
      handlePictureInPictureResult(video.requestPictureInPicture());
      return;
    }
    if (typeof video.webkitSetPresentationMode === "function"
      && typeof video.webkitSupportsPresentationMode === "function"
      && video.webkitSupportsPresentationMode("picture-in-picture")) {
      video.webkitSetPresentationMode("picture-in-picture");
      return;
    }
  } catch (err) {
    setPlayerStatus("Picture in Picture is unavailable for this video.");
    return;
  }
  setPlayerStatus("Picture in Picture is unavailable in this browser.");
}

function handlePictureInPictureResult(result) {
  if (result && typeof result.catch === "function") {
    result.catch(() => setPlayerStatus("Picture in Picture is unavailable for this video."));
  }
}

function exitVideoPictureInPicture() {
  const video = els.webPlayer;
  try {
    if (document.pictureInPictureElement === video && typeof document.exitPictureInPicture === "function") {
      document.exitPictureInPicture().catch(() => {});
    } else if (video.webkitPresentationMode === "picture-in-picture" && typeof video.webkitSetPresentationMode === "function") {
      video.webkitSetPresentationMode("inline");
    }
  } catch (err) {
    // Closing playback should continue even if the browser already dismissed PiP.
  }
}

function updateVideoPictureInPictureControl() {
  const video = els.webPlayer;
  const active = document.pictureInPictureElement === video || video.webkitPresentationMode === "picture-in-picture";
  const standardSupported = typeof video.requestPictureInPicture === "function" && document.pictureInPictureEnabled !== false;
  let webkitSupported = false;
  try {
    webkitSupported = typeof video.webkitSupportsPresentationMode === "function"
      && video.webkitSupportsPresentationMode("picture-in-picture");
  } catch (err) {
    webkitSupported = false;
  }
  els.videoPictureInPicture.disabled = !active && !standardSupported && !webkitSupported;
  els.videoPictureInPicture.title = active ? "Exit Picture in Picture" : "Picture in Picture";
  els.videoPictureInPicture.setAttribute("aria-label", active ? "Exit Picture in Picture" : "Picture in Picture");
}

function showVideoControls(scheduleHide = true) {
  clearTimeout(videoControlsHideTimer);
  videoControlsHideTimer = null;
  els.videoPlaybackSurface.classList.remove("controls-hidden");
  if (scheduleHide && !els.webPlayer.paused) {
    scheduleVideoControlsHide();
  }
}

function scheduleVideoControlsHide() {
  clearTimeout(videoControlsHideTimer);
  if (els.webPlayer.paused || videoSeeking) {
    return;
  }
  videoControlsHideTimer = window.setTimeout(() => {
    videoControlsHideTimer = null;
    if (els.videoControls.matches(":hover")) {
      scheduleVideoControlsHide();
      return;
    }
    els.videoPlaybackSurface.classList.add("controls-hidden");
  }, 3000);
}

function toggleVideoFullscreen() {
  const video = els.webPlayer;
  const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement;
  if (video.webkitDisplayingFullscreen && typeof video.webkitExitFullscreen === "function") {
    video.webkitExitFullscreen();
    return;
  }
  if (fullscreenElement) {
    const exitFullscreen = document.exitFullscreen || document.webkitExitFullscreen;
    if (typeof exitFullscreen === "function") {
      handleFullscreenResult(exitFullscreen.call(document));
    }
    return;
  }

  try {
    if (typeof els.videoPlaybackSurface.requestFullscreen === "function") {
      handleFullscreenResult(els.videoPlaybackSurface.requestFullscreen());
      return;
    }
    if (typeof video.webkitEnterFullscreen === "function" && video.webkitSupportsFullscreen !== false) {
      video.webkitEnterFullscreen();
      return;
    }
    if (typeof els.videoPlaybackSurface.webkitRequestFullscreen === "function") {
      handleFullscreenResult(els.videoPlaybackSurface.webkitRequestFullscreen());
      return;
    }
  } catch (err) {
    setPlayerStatus("Fullscreen is unavailable in this browser.");
    return;
  }
  setPlayerStatus("Fullscreen is unavailable in this browser.");
}

function handleFullscreenResult(result) {
  if (result && typeof result.catch === "function") {
    result.catch(() => setPlayerStatus("Fullscreen is unavailable in this browser."));
  }
}

function updateVideoFullscreenControl() {
  const fullscreen = document.fullscreenElement === els.videoPlaybackSurface
    || document.webkitFullscreenElement === els.videoPlaybackSurface
    || Boolean(els.webPlayer.webkitDisplayingFullscreen);
  els.videoFullscreen.title = fullscreen ? "Exit fullscreen" : "Fullscreen";
  els.videoFullscreen.setAttribute("aria-label", fullscreen ? "Exit fullscreen" : "Fullscreen");
  showVideoControls();
}

function setPlayerStatus(message) {
  const text = String(message || "");
  els.playerStatus.textContent = text;
  els.musicPlayerStatus.textContent = text;
  els.videoMiniStatus.textContent = text;
}

function showMusicPlayer(metadata, hasNext) {
  els.musicPlayerArtist.textContent = metadata.artist || "Unknown Artist";
  els.musicPlayerTitle.textContent = metadata.title || "Untitled";
  els.musicPlayerAlbum.textContent = metadata.album || "Unknown Album";
  els.musicPlayerCover.classList.remove("with-image");
  els.musicPlayerCover.style.removeProperty("--poster-image");
  els.musicPlayerCover.textContent = initials(metadata.album || metadata.title || "Music");
  if (metadata.artwork) {
    setPosterImage(els.musicPlayerCover, metadata.artwork);
  }
  els.musicNext.disabled = !hasNext;
  els.musicPlayer.classList.remove("hidden");
  els.musicPlayer.setAttribute("aria-hidden", "false");
  restoreMusicPlayerPosition();
  updateMusicPlayerControls();
}

function toggleMusicPlayback() {
  if (els.webPlayer.paused) {
    els.webPlayer.play().catch(() => setPlayerStatus("Playback could not be resumed."));
  } else {
    els.webPlayer.pause();
  }
}

function seekMusicPlayback() {
  const duration = Number(els.webPlayer.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    return;
  }
  els.webPlayer.currentTime = duration * (Number(els.musicSeek.value) || 0) / 1000;
  els.musicCurrentTime.textContent = formatMediaTime(els.webPlayer.currentTime);
}

function updateMusicVolume() {
  els.webPlayer.muted = false;
  els.webPlayer.volume = Math.max(0, Math.min(1, Number(els.musicVolume.value) || 0));
}

function toggleMusicMute() {
  els.webPlayer.muted = !els.webPlayer.muted;
}

function updateMusicPlayerControls() {
  const duration = Number(els.webPlayer.duration);
  const currentTime = Number(els.webPlayer.currentTime) || 0;
  els.musicPlayPause.textContent = els.webPlayer.paused ? "Play" : "Pause";
  els.musicMute.textContent = els.webPlayer.muted ? "Unmute" : "Mute";
  els.musicVolume.value = String(els.webPlayer.volume);
  els.musicCurrentTime.textContent = formatMediaTime(currentTime);
  els.musicDuration.textContent = formatMediaTime(Number.isFinite(duration) ? duration : 0);
  if (!musicSeeking) {
    els.musicSeek.value = Number.isFinite(duration) && duration > 0
      ? String(Math.round(currentTime / duration * 1000))
      : "0";
  }
}

function formatMediaTime(value) {
  const seconds = Math.max(0, Math.floor(Number(value) || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  const remainder = seconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function startMusicPlayerDrag(event) {
  startFloatingPlayerDrag(event, els.musicPlayer, els.musicPlayerDrag, "musicPlayerPosition");
}

function moveMusicPlayer(event) {
  moveFloatingPlayer(event);
}

function stopMusicPlayerDrag(event) {
  stopFloatingPlayerDrag(event);
}

function startVideoPlayerDrag(event) {
  startFloatingPlayerDrag(event, els.videoMiniPlayer, els.videoMiniPlayerDrag, "videoPlayerPosition");
}

function startFloatingPlayerDrag(event, element, handle, storageKey) {
  if (window.innerWidth <= 760 || event.button !== 0 || event.target.closest("button, input")) {
    return;
  }
  const rect = element.getBoundingClientRect();
  floatingPlayerDrag = {
    pointerId: event.pointerId,
    offsetX: event.clientX - rect.left,
    offsetY: event.clientY - rect.top,
    element,
    handle,
    storageKey
  };
  element.style.right = "auto";
  element.style.bottom = "auto";
  element.style.left = `${rect.left}px`;
  element.style.top = `${rect.top}px`;
  handle.setPointerCapture(event.pointerId);
}

function moveFloatingPlayer(event) {
  if (!floatingPlayerDrag || event.pointerId !== floatingPlayerDrag.pointerId) {
    return;
  }
  const { element, offsetX, offsetY } = floatingPlayerDrag;
  const left = Math.max(8, Math.min(event.clientX - offsetX, window.innerWidth - element.offsetWidth - 8));
  const top = Math.max(8, Math.min(event.clientY - offsetY, window.innerHeight - element.offsetHeight - 8));
  element.style.left = `${left}px`;
  element.style.top = `${top}px`;
}

function stopFloatingPlayerDrag(event) {
  if (!floatingPlayerDrag || event.pointerId !== floatingPlayerDrag.pointerId) {
    return;
  }
  const { element, handle, storageKey } = floatingPlayerDrag;
  floatingPlayerDrag = null;
  try {
    handle.releasePointerCapture(event.pointerId);
  } catch (err) {
    // The browser may release capture before pointercancel is delivered.
  }
  sessionStorage.setItem(storageKey, JSON.stringify({
    left: Number.parseFloat(element.style.left) || 0,
    top: Number.parseFloat(element.style.top) || 0
  }));
}

function restoreMusicPlayerPosition() {
  restoreFloatingPlayerPosition(els.musicPlayer, "musicPlayerPosition");
}

function restoreVideoPlayerPosition() {
  restoreFloatingPlayerPosition(els.videoMiniPlayer, "videoPlayerPosition");
}

function restoreFloatingPlayerPosition(element, storageKey) {
  if (window.innerWidth <= 760) {
    return;
  }
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey) || "null");
    if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
      element.style.right = "auto";
      element.style.bottom = "auto";
      element.style.left = `${saved.left}px`;
      element.style.top = `${saved.top}px`;
    }
  } catch (err) {
    sessionStorage.removeItem(storageKey);
  }
  requestAnimationFrame(() => clampFloatingPlayerToViewport(element));
}

function clampFloatingPlayerToViewport(element) {
  if (window.innerWidth <= 760 || element.classList.contains("hidden") || !element.style.left) {
    return;
  }
  const rect = element.getBoundingClientRect();
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - rect.width - 8));
  const top = Math.max(8, Math.min(rect.top, window.innerHeight - rect.height - 8));
  element.style.left = `${left}px`;
  element.style.top = `${top}px`;
}

function clampFloatingPlayersToViewport() {
  clampFloatingPlayerToViewport(els.musicPlayer);
  clampFloatingPlayerToViewport(els.videoMiniPlayer);
}

async function handleWebPlayerEnded() {
  stopOnDeckPolling();
  await refreshSelectedProgress().catch(() => null);
  const nextItem = els.webPlayer.dataset.autoAdvance === "true" && state.options && state.options.nextItem;
  if (!nextItem || autoAdvanceInFlight) {
    return;
  }

  autoAdvanceInFlight = true;
  try {
    const currentArtwork = state.selected && state.selected.itemType === "track"
      ? state.selected.posterUrl || state.selected.thumbnailUrl || null
      : null;
    closePlayer();
    await openDetails({
      ...nextItem,
      category: libraryTitle(nextItem.mediaType),
      posterUrl: nextItem.posterUrl || currentArtwork
    });
    await playStream();
  } finally {
    autoAdvanceInFlight = false;
  }
}

async function selectedResumeSeconds(action) {
  await refreshSelectedProgress();
  const progress = state.selected && state.selected.progress;
  const resumeSeconds = progress && progress.status === "in_progress" ? Number(progress.resumeSeconds) || 0 : 0;
  if (resumeSeconds <= 0) {
    return 0;
  }

  return askResumeChoice(action, resumeSeconds);
}

function askResumeChoice(action, resumeSeconds) {
  return new Promise((resolve) => {
    const minutes = Math.floor(resumeSeconds / 60);
    const seconds = Math.floor(resumeSeconds % 60);
    els.resumePrompt.textContent = `${action === "copy" ? "Copy" : "Play"} from ${minutes}:${String(seconds).padStart(2, "0")} or start from the beginning?`;
    els.resumeOverlay.classList.remove("hidden");
    els.resumeOverlay.setAttribute("aria-hidden", "false");

    const finish = (value) => {
      els.resumeOverlay.classList.add("hidden");
      els.resumeOverlay.setAttribute("aria-hidden", "true");
      els.resumeFromStart.removeEventListener("click", start);
      els.resumeFromProgress.removeEventListener("click", resume);
      els.resumeCancel.removeEventListener("click", cancel);
      els.resumeOverlay.removeEventListener("click", overlayCancel);
      resolve(value);
    };
    const start = () => finish(0);
    const resume = () => finish(resumeSeconds);
    const cancel = () => finish(null);
    const overlayCancel = (event) => {
      if (event.target === els.resumeOverlay) {
        finish(null);
      }
    };

    els.resumeFromStart.addEventListener("click", start);
    els.resumeFromProgress.addEventListener("click", resume);
    els.resumeCancel.addEventListener("click", cancel);
    els.resumeOverlay.addEventListener("click", overlayCancel);
  });
}

function seekNativeVideo(video, resumeSeconds) {
  if (resumeSeconds <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const seek = () => {
      video.currentTime = resumeSeconds;
      resolve();
    };
    if (video.readyState >= 1) {
      seek();
      return;
    }
    video.addEventListener("loadedmetadata", seek, { once: true });
  });
}

function selectedStreamUrl(options = {}) {
  const surface = options.surface === "copy" ? "copy" : "web";
  const playbackToken = options.playbackToken || state.options && state.options.webPlaybackToken;
  if (!playbackToken) {
    els.copyStatus.textContent = "Stream options are still loading.";
    return null;
  }

  if (state.selected.itemType === "image") {
    const imageUrl = new URL(`/api/${surface === "web" ? "web-streams" : "streams"}/${state.selected.mediaType}/${state.selected.id}/image`, window.location.origin);
    imageUrl.searchParams.set("playbackToken", playbackToken);
    return imageUrl;
  }

  const url = new URL(`/api/${surface === "web" ? "web-streams" : "streams"}/${state.selected.mediaType}/${state.selected.id}/master.m3u8`, window.location.origin);
  url.searchParams.set("audio", els.audioSelect.value);
  url.searchParams.set("subtitle", els.subtitleSelect.value);
  url.searchParams.set("audioChannels", selectedAudioChannels());
  url.searchParams.set("quality", selectedQuality());
  url.searchParams.set("playbackToken", playbackToken);
  if (options.includeProTv3d) {
    applyProTv3dParams(url);
  }
  if (options.resumeSeconds > 0) {
    url.searchParams.set("t", String(Math.floor(options.resumeSeconds)));
  }
  return url;
}

function applyProTv3dParams(url) {
  const mode = selectedProTv3dMode();
  if (!mode) {
    return;
  }

  url.searchParams.set("3d", mode);
}

async function pregenerateHls() {
  if (!state.selected) {
    return;
  }
  if (!isPlaybackReady()) {
    els.copyStatus.textContent = playbackDisabledMessage();
    return;
  }

  els.pregenerateHls.disabled = true;
  els.copyStatus.textContent = "Starting HLS generation...";

  try {
    const result = await api(`/api/catalog/${state.selected.mediaType}/${state.selected.id}/pregenerate`, state.token, {
      method: "POST",
      body: JSON.stringify({
        audio: els.audioSelect.value,
        subtitle: els.subtitleSelect.value,
        audioChannels: selectedAudioChannels(),
        quality: selectedQuality()
      })
    });
    els.copyStatus.textContent = `HLS generation started. Cache key: ${result.cacheKey}`;
  } catch (err) {
    els.copyStatus.textContent = "Failed to start HLS generation.";
  } finally {
    els.pregenerateHls.disabled = !isPlaybackReady();
  }
}

async function markSelectedWatched() {
  if (!state.selected) {
    return;
  }

  els.markWatched.disabled = true;
  els.copyStatus.textContent = "Marking watched...";
  try {
    const result = await api(`/api/progress/${state.selected.mediaType}/${state.selected.id}/watched`, state.token, {
      method: "POST",
      body: JSON.stringify({
        durationSeconds: state.selected.progress && state.selected.progress.durationSeconds
      })
    });
    state.selected = {
      ...state.selected,
      progress: result.progress
    };
    renderDetailsProgress(result.progress);
    updateManagementActions(result.progress);
    updateRenderedCardsProgress(state.selected, result.progress);
    removeOnDeckCard(state.selected);
    await refreshOnDeckRow({ force: true }).catch(() => {});
    els.copyStatus.textContent = "Marked watched.";
  } catch (err) {
    els.copyStatus.textContent = "Failed to mark watched.";
  } finally {
    els.markWatched.disabled = false;
  }
}

async function markSeasonWatched(mediaType, show, season, button = null) {
  const episodes = season && Array.isArray(season.episodes) ? season.episodes : [];
  if (!state.user || state.shareToken || episodes.length === 0) {
    return;
  }
  const watched = seasonFullyWatched(season);
  const nextWatched = !watched;
  const action = nextWatched ? "watched" : "unwatched";
  if (!window.confirm(`Mark ${season.name || `Season ${pad(season.season)}`} as ${action}?`)) {
    return;
  }

  if (button) {
    button.disabled = true;
  }
  try {
    const result = await api(
      `/api/progress/${encodeURIComponent(mediaType)}/shows/${encodeURIComponent(show.id)}/seasons/${encodeURIComponent(season.season)}/${nextWatched ? "watched" : "unwatched"}`,
      state.token,
      { method: "POST", body: JSON.stringify({}) }
    );
    for (const episode of episodes) {
      const item = episodeItem(mediaType, show, episode);
      const progress = result.progress && result.progress[episode.id];
      if (!progress) {
        continue;
      }
      episode.progress = progress;
      updateRenderedCardsProgress(item, progress);
      removeOnDeckCard(item);
      if (state.selected && state.selected.mediaType === mediaType && state.selected.id === episode.id) {
        state.selected = { ...state.selected, progress };
        renderDetailsProgress(progress);
        updateManagementActions(progress);
      }
    }
    if (button) {
      button.textContent = seasonWatchedActionLabel(season);
    }
    await refreshOnDeckRow({ force: true }).catch(() => {});
  } catch (err) {
    els.copyStatus.textContent = err.message || `Failed to mark season ${action}.`;
  } finally {
    if (button) {
      button.disabled = false;
    }
  }
}

function seasonWatchedActionLabel(season) {
  return seasonFullyWatched(season) ? "Mark unwatched" : "Mark watched";
}

function seasonFullyWatched(season) {
  const episodes = season && Array.isArray(season.episodes) ? season.episodes : [];
  return episodes.length > 0 && episodes.every((episode) => isWatchedProgress(episode.progress));
}

async function removeSelectedOnDeck() {
  if (!state.selected) {
    return;
  }

  els.removeOnDeck.disabled = true;
  els.copyStatus.textContent = "Removing from On Deck...";
  try {
    const result = await api(`/api/progress/${state.selected.mediaType}/${state.selected.id}/remove`, state.token, {
      method: "POST",
      body: JSON.stringify({})
    });
    state.selected = {
      ...state.selected,
      progress: result.progress
    };
    renderDetailsProgress(result.progress);
    updateManagementActions(result.progress);
    updateRenderedCardsProgress(state.selected, result.progress);
    removeOnDeckCard(state.selected);
    await refreshOnDeckRow({ force: true }).catch(() => {});
    els.copyStatus.textContent = "Removed from On Deck.";
  } catch (err) {
    els.copyStatus.textContent = "Failed to remove from On Deck.";
  } finally {
    els.removeOnDeck.disabled = false;
  }
}

function removeOnDeckCard(item) {
  const section = els.homeRows.querySelector('[data-row-kind="onDeck"]');
  if (!section) {
    return;
  }

  const key = mediaKey(item);
  const cardElement = section.querySelector(`.card[data-media-key="${cssEscape(key)}"]`);
  if (cardElement) {
    cardElement.remove();
  }

  const remaining = section.querySelectorAll(".card").length;
  if (remaining === 0) {
    section.remove();
    return;
  }

  const count = section.querySelector(".section-actions span");
  if (count) {
    count.textContent = String(remaining);
  }
}

function closeDetails() {
  els.detailsPanel.classList.remove("open");
  els.detailsPanel.setAttribute("aria-hidden", "true");
  hideImageViewer();
  closePosterEditor();
  hideManualCopyUrl();
}

async function api(path, token = state.token, options = {}) {
  const headers = {
    "Content-Type": "application/json"
  };
  if (token) {
    headers["X-Session-Token"] = token;
  } else if (state.shareToken) {
    headers["X-Share-Token"] = state.shareToken;
  }

  return apiClient.requestJson(path, {
    ...options,
    headers,
    body: options.body
  });
}

async function publicApi(path, options = {}) {
  return apiClient.requestJson(path, options);
}

function authQuery() {
  if (state.shareToken && !state.token) {
    return { name: "shareToken", value: state.shareToken };
  }

  return { name: "authToken", value: state.token };
}

function fallbackWebPlayerUrl() {
  const auth = authQuery();
  const url = new URL("/api/fallback/master.m3u8", window.location.origin);
  if (auth.value) {
    url.searchParams.set(auth.name, auth.value);
  }
  return url;
}

function reportIptvPlaybackError(channel, details) {
  api("/api/iptv/client-events", state.token, {
    method: "POST",
    body: JSON.stringify({
      channelId: channel.id,
      channelName: channel.name,
      event: "playback-error",
      details
    })
  }).catch(() => {});
}

function formatDate(value) {
  if (!value) {
    return "unknown";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return date.toLocaleString();
}

function initials(value) {
  return String(value || "?")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join("");
}

function pad(value) {
  return String(value || 0).padStart(2, "0");
}

function proTv3dModeLabel(mode) {
  if (mode === "1") {
    return "Side by side";
  }
  if (mode === "2") {
    return "Side by side swapped";
  }
  if (mode === "3") {
    return "Over under";
  }
  if (mode === "4") {
    return "Over under swapped";
  }

  return "Side by side";
}

function mediaKey(item) {
  return item ? `${item.mediaType}:${item.id}` : "";
}

function isSelectedKey(key) {
  return Boolean(state.selected) && mediaKey(state.selected) === key;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function cssEscape(value) {
  if (window.CSS && typeof window.CSS.escape === "function") {
    return window.CSS.escape(String(value || ""));
  }

  return String(value || "").replace(/["\\]/g, "\\$&");
}

function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}
