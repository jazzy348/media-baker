const initialLibraryViewToken = new URLSearchParams(window.location.search).get("viewToken") || "";
const navigation = window.MediaBakerNavigation;
const apiClient = window.MediaBakerApi;
const appRevision = document.querySelector('meta[name="media-baker-revision"]')?.content || "";
const hlsScriptUrl = `/vendor/hls.js/hls.min.js${appRevision ? `?v=${encodeURIComponent(appRevision)}` : ""}`;
const PLAYBACK_PREFERENCES_KEY = "mediaBakerPlaybackPreferences";
const LIBRARY_SIDEBAR_PREFERENCE_KEY = "mediaBakerLibrarySidebarExpanded";
const HOME_ROW_PAGE_SIZE = 18;
const DEFAULT_PLAYBACK_PREFERENCES = {
  audioLanguage: "",
  subtitleLanguage: "",
  subtitleMode: "none",
  quality: "original",
  audioChannels: "stereo",
  themeColour: "#00d9ff"
};

const THEME_PRESET_COLOURS = new Set([
  "#00d9ff",
  "#ff4d5e",
  "#ffd23f",
  "#ff5fb7",
  "#35d07f",
  "#ff8a3d",
  "#a970ff"
]);

const state = {
  token: initialLibraryViewToken ? "" : localStorage.getItem("streamToken") || "",
  libraryViewToken: initialLibraryViewToken,
  user: null,
  setupMode: false,
  selected: null,
  options: null,
  playbackPreferences: readLocalPlaybackPreferences(),
  applyingPlaybackPreferences: false,
  metadataMatchTarget: null,
  seriesPosterTarget: null,
  homeData: null,
  homeCache: new Map(),
  homeRequestId: 0,
  homeRows: new Map(),
  homeSeed: "",
  currentView: "home",
  homeMode: "recent",
  libraries: [],
  librarySidebarExpanded: readLibrarySidebarPreference(),
  librarySidebarMobileOpen: false,
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
  ytdlpAdminStatus: null,
  branding: null,
  dismissedUpdateVersion: null,
  selectedPlaybackShuffle: null
};

const LIBRARY_PAGE_SIZE = 72;
const LIVE_TV_PERMISSION_KEY = "@live-tv";

const els = {
  brandLink: document.querySelector(".brand"),
  appLayout: document.getElementById("appLayout"),
  librarySidebar: document.getElementById("librarySidebar"),
  librarySidebarNav: document.getElementById("librarySidebarNav"),
  librarySidebarToggle: document.getElementById("librarySidebarToggle"),
  librarySidebarScrim: document.getElementById("librarySidebarScrim"),
  libraryMobileToggle: document.getElementById("libraryMobileToggle"),
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
  streamQueuesButton: document.getElementById("streamQueuesButton"),
  systemBanner: document.getElementById("systemBanner"),
  updateBanner: document.getElementById("updateBanner"),
  updateBannerTitle: document.getElementById("updateBannerTitle"),
  updateBannerMeta: document.getElementById("updateBannerMeta"),
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
  streamQueuesView: document.getElementById("streamQueuesView"),
  newStreamQueue: document.getElementById("newStreamQueue"),
  streamQueueEmpty: document.getElementById("streamQueueEmpty"),
  streamQueueDraft: document.getElementById("streamQueueDraft"),
  cancelStreamQueueDraft: document.getElementById("cancelStreamQueueDraft"),
  copyQueueSelected: document.getElementById("copyQueueSelected"),
  streamQueueCurrent: document.getElementById("streamQueueCurrent"),
  streamQueueOwner: document.getElementById("streamQueueOwner"),
  streamQueueTitle: document.getElementById("streamQueueTitle"),
  streamQueueMeta: document.getElementById("streamQueueMeta"),
  copyCurrentStreamUrl: document.getElementById("copyCurrentStreamUrl"),
  playCurrentStream: document.getElementById("playCurrentStream"),
  skipCurrentStreamItem: document.getElementById("skipCurrentStreamItem"),
  stopCurrentStream: document.getElementById("stopCurrentStream"),
  streamQueueItems: document.getElementById("streamQueueItems"),
  streamQueueMediaPicker: document.getElementById("streamQueueMediaPicker"),
  streamQueueMediaBrowserBack: document.getElementById("streamQueueMediaBrowserBack"),
  streamQueueMediaBrowserContext: document.getElementById("streamQueueMediaBrowserContext"),
  streamQueueSearchTitle: document.getElementById("streamQueueSearchTitle"),
  streamQueueSelectionHint: document.getElementById("streamQueueSelectionHint"),
  streamQueueSearchForm: document.getElementById("streamQueueSearchForm"),
  streamQueueSearchInput: document.getElementById("streamQueueSearchInput"),
  streamQueueSearchResults: document.getElementById("streamQueueSearchResults"),
  streamQueueAudioSelect: document.getElementById("streamQueueAudioSelect"),
  streamQueueSubtitleSelect: document.getElementById("streamQueueSubtitleSelect"),
  addStreamQueueMedia: document.getElementById("addStreamQueueMedia"),
  createStreamQueue: document.getElementById("createStreamQueue"),
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
  startWatchTogether: document.getElementById("startWatchTogether"),
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
  seriesPosterOverlay: document.getElementById("seriesPosterOverlay"),
  seriesPosterForm: document.getElementById("seriesPosterForm"),
  seriesPosterPrompt: document.getElementById("seriesPosterPrompt"),
  seriesPosterUrl: document.getElementById("seriesPosterUrl"),
  seriesPosterStatus: document.getElementById("seriesPosterStatus"),
  saveSeriesPoster: document.getElementById("saveSeriesPoster"),
  cancelSeriesPoster: document.getElementById("cancelSeriesPoster"),
  playerOverlay: document.getElementById("playerOverlay"),
  closePlayer: document.getElementById("closePlayer"),
  minimizeVideoPlayer: document.getElementById("minimizeVideoPlayer"),
  videoPlayerSlot: document.getElementById("videoPlayerSlot"),
  watchTogetherPreviewDrag: document.getElementById("watchTogetherPreviewDrag"),
  videoPlaybackSurface: document.getElementById("videoPlaybackSurface"),
  videoSkipPrompt: document.getElementById("videoSkipPrompt"),
  videoSkipPromptText: document.getElementById("videoSkipPromptText"),
  videoSkipMarker: document.getElementById("videoSkipMarker"),
  videoContinueMarker: document.getElementById("videoContinueMarker"),
  videoControls: document.getElementById("videoControls"),
  videoPlayPause: document.getElementById("videoPlayPause"),
  videoCurrentTime: document.getElementById("videoCurrentTime"),
  videoSeek: document.getElementById("videoSeek"),
  videoDuration: document.getElementById("videoDuration"),
  videoMute: document.getElementById("videoMute"),
  videoVolume: document.getElementById("videoVolume"),
  videoTrackControls: document.getElementById("videoTrackControls"),
  videoAudioTrackLabel: document.getElementById("videoAudioTrackLabel"),
  videoAudioTrack: document.getElementById("videoAudioTrack"),
  videoSubtitleTrackLabel: document.getElementById("videoSubtitleTrackLabel"),
  videoSubtitleTrack: document.getElementById("videoSubtitleTrack"),
  videoTrackSettings: document.getElementById("videoTrackSettings"),
  videoShuffle: document.getElementById("videoShuffle"),
  videoPictureInPicture: document.getElementById("videoPictureInPicture"),
  videoFullscreen: document.getElementById("videoFullscreen"),
  webPlayer: document.getElementById("webPlayer"),
  playerCategory: document.getElementById("playerCategory"),
  playerTitle: document.getElementById("playerTitle"),
  playerStatus: document.getElementById("playerStatus"),
  toggleWatchTogetherPanel: document.getElementById("toggleWatchTogetherPanel"),
  watchTogetherPanel: document.getElementById("watchTogetherPanel"),
  watchTogetherRoomTab: document.getElementById("watchTogetherRoomTab"),
  openWatchTogetherMediaBrowser: document.getElementById("openWatchTogetherMediaBrowser"),
  closeWatchTogetherMediaBrowser: document.getElementById("closeWatchTogetherMediaBrowser"),
  watchTogetherMediaBrowser: document.getElementById("watchTogetherMediaBrowser"),
  watchTogetherMediaBrowserBack: document.getElementById("watchTogetherMediaBrowserBack"),
  watchTogetherMediaBrowserContext: document.getElementById("watchTogetherMediaBrowserContext"),
  watchTogetherMediaBrowserTitle: document.getElementById("watchTogetherMediaBrowserTitle"),
  closeWatchTogetherPanel: document.getElementById("closeWatchTogetherPanel"),
  watchTogetherRoomStatus: document.getElementById("watchTogetherRoomStatus"),
  watchTogetherHostControls: document.getElementById("watchTogetherHostControls"),
  watchTogetherEveryoneControls: document.getElementById("watchTogetherEveryoneControls"),
  watchTogetherEveryoneQueues: document.getElementById("watchTogetherEveryoneQueues"),
  copyWatchTogetherInvite: document.getElementById("copyWatchTogetherInvite"),
  watchTogetherInviteFallback: document.getElementById("watchTogetherInviteFallback"),
  closeWatchTogetherRoom: document.getElementById("closeWatchTogetherRoom"),
  watchTogetherParticipants: document.getElementById("watchTogetherParticipants"),
  watchTogetherQueue: document.getElementById("watchTogetherQueue"),
  watchTogetherSkipQueueItem: document.getElementById("watchTogetherSkipQueueItem"),
  watchTogetherQueueSearchForm: document.getElementById("watchTogetherQueueSearchForm"),
  watchTogetherQueueSearch: document.getElementById("watchTogetherQueueSearch"),
  watchTogetherQueueSearchResults: document.getElementById("watchTogetherQueueSearchResults"),
  watchTogetherChat: document.getElementById("watchTogetherChat"),
  watchTogetherChatForm: document.getElementById("watchTogetherChatForm"),
  watchTogetherChatInput: document.getElementById("watchTogetherChatInput"),
  watchTogetherJoinOverlay: document.getElementById("watchTogetherJoinOverlay"),
  watchTogetherJoinForm: document.getElementById("watchTogetherJoinForm"),
  watchTogetherJoinPrompt: document.getElementById("watchTogetherJoinPrompt"),
  watchTogetherGuestName: document.getElementById("watchTogetherGuestName"),
  watchTogetherJoinStatus: document.getElementById("watchTogetherJoinStatus"),
  copyQueueSelectedTitle: document.getElementById("copyQueueSelectedTitle"),
  copyQueueName: document.getElementById("copyQueueName"),
  copyQueueExpiry: document.getElementById("copyQueueExpiry"),
  copyQueueCreatedUrl: document.getElementById("copyQueueCreatedUrl"),
  copyQueueUrl: document.getElementById("copyQueueUrl"),
  copyCopyQueueUrl: document.getElementById("copyCopyQueueUrl"),
  copyQueueStatus: document.getElementById("copyQueueStatus"),
  copyQueueCount: document.getElementById("copyQueueCount"),
  copyQueueList: document.getElementById("copyQueueList"),
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
  channelDownloadChoice: document.getElementById("channelDownloadChoice"),
  channelDownloadTitle: document.getElementById("channelDownloadTitle"),
  downloadChannel: document.getElementById("downloadChannel"),
  subscribeChannel: document.getElementById("subscribeChannel"),
  cancelChannelChoice: document.getElementById("cancelChannelChoice"),
  liveDownloadChoice: document.getElementById("liveDownloadChoice"),
  liveDownloadTitle: document.getElementById("liveDownloadTitle"),
  recordLiveStream: document.getElementById("recordLiveStream"),
  relayLiveStream: document.getElementById("relayLiveStream"),
  cancelLiveChoice: document.getElementById("cancelLiveChoice"),
  liveRelayReady: document.getElementById("liveRelayReady"),
  liveRelayTitle: document.getElementById("liveRelayTitle"),
  playLiveRelay: document.getElementById("playLiveRelay"),
  copyLiveRelay: document.getElementById("copyLiveRelay"),
  closeLiveRelay: document.getElementById("closeLiveRelay"),
  relayManualCopyBar: document.getElementById("relayManualCopyBar"),
  relayManualCopyUrl: document.getElementById("relayManualCopyUrl"),
  closeDownloadPanel: document.getElementById("closeDownloadPanel"),
  downloadStatus: document.getElementById("downloadStatus"),
  downloadList: document.getElementById("downloadList"),
  accountOverlay: document.getElementById("accountOverlay"),
  selfAccountForm: document.getElementById("selfAccountForm"),
  selfAccountUsername: document.getElementById("selfAccountUsername"),
  selfAccountCurrentPassword: document.getElementById("selfAccountCurrentPassword"),
  selfAccountNewPassword: document.getElementById("selfAccountNewPassword"),
  selfAccountConfirmPassword: document.getElementById("selfAccountConfirmPassword"),
  selfAccountThemePreset: document.getElementById("selfAccountThemePreset"),
  selfAccountThemeColour: document.getElementById("selfAccountThemeColour"),
  openThemeColourPicker: document.getElementById("openThemeColourPicker"),
  themeColourSwatch: document.getElementById("themeColourSwatch"),
  themeColourValue: document.getElementById("themeColourValue"),
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
  optimizerForm: document.getElementById("optimizerForm"),
  optimizerEnabled: document.getElementById("optimizerEnabled"),
  optimizerScanInterval: document.getElementById("optimizerScanInterval"),
  optimizerParallelJobs: document.getElementById("optimizerParallelJobs"),
  optimizerLibraryList: document.getElementById("optimizerLibraryList"),
  optimizerStatus: document.getElementById("optimizerStatus"),
  toggleOptimizerWork: document.getElementById("toggleOptimizerWork"),
  optimizerWorkPanel: document.getElementById("optimizerWorkPanel"),
  optimizerQueueSummary: document.getElementById("optimizerQueueSummary"),
  optimizerCurrentJobs: document.getElementById("optimizerCurrentJobs"),
  optimizerQueueList: document.getElementById("optimizerQueueList"),
  toggleOptimizerFailures: document.getElementById("toggleOptimizerFailures"),
  clearOptimizerFailures: document.getElementById("clearOptimizerFailures"),
  optimizerFailuresPanel: document.getElementById("optimizerFailuresPanel"),
  optimizerFailuresList: document.getElementById("optimizerFailuresList"),
  retrySkipDetectionFailures: document.getElementById("retrySkipDetectionFailures"),
  reanalyseSkipDetection: document.getElementById("reanalyseSkipDetection"),
  rebuildSkipDetection: document.getElementById("rebuildSkipDetection"),
  refreshSkipDetectionMarkers: document.getElementById("refreshSkipDetectionMarkers"),
  skipDetectionSeasonProgress: document.getElementById("skipDetectionSeasonProgress"),
  skipDetectionEpisodeProgress: document.getElementById("skipDetectionEpisodeProgress"),
  skipDetectionCachedCount: document.getElementById("skipDetectionCachedCount"),
  skipDetectionMarkerCount: document.getElementById("skipDetectionMarkerCount"),
  skipDetectionFailureCount: document.getElementById("skipDetectionFailureCount"),
  skipDetectionPhase: document.getElementById("skipDetectionPhase"),
  skipDetectionCurrent: document.getElementById("skipDetectionCurrent"),
  skipDetectionEta: document.getElementById("skipDetectionEta"),
  skipDetectionProgressFill: document.getElementById("skipDetectionProgressFill"),
  skipDetectionStatus: document.getElementById("skipDetectionStatus"),
  skipDetectionFailures: document.getElementById("skipDetectionFailures"),
  skipDetectionMarkers: document.getElementById("skipDetectionMarkers"),
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
  adminOptimizerTab: document.getElementById("adminOptimizerTab"),
  adminSkipDetectionTab: document.getElementById("adminSkipDetectionTab"),
  adminSettingsTab: document.getElementById("adminSettingsTab"),
  adminTasksTab: document.getElementById("adminTasksTab"),
  adminHardwareTab: document.getElementById("adminHardwareTab"),
  adminCurrentlyPlayingTab: document.getElementById("adminCurrentlyPlayingTab"),
  adminLogsTab: document.getElementById("adminLogsTab"),
  adminHistoryTab: document.getElementById("adminHistoryTab"),
  adminAccountsPage: document.getElementById("adminAccountsPage"),
  adminApiKeysPage: document.getElementById("adminApiKeysPage"),
  adminLibrariesPage: document.getElementById("adminLibrariesPage"),
  adminDuplicatesPage: document.getElementById("adminDuplicatesPage"),
  adminBackupsPage: document.getElementById("adminBackupsPage"),
  adminOptimizerPage: document.getElementById("adminOptimizerPage"),
  adminSkipDetectionPage: document.getElementById("adminSkipDetectionPage"),
  adminSettingsPage: document.getElementById("adminSettingsPage"),
  adminTasksPage: document.getElementById("adminTasksPage"),
  adminHardwarePage: document.getElementById("adminHardwarePage"),
  adminCurrentlyPlayingPage: document.getElementById("adminCurrentlyPlayingPage"),
  currentlyPlayingPlaybackTab: document.getElementById("currentlyPlayingPlaybackTab"),
  currentlyPlayingRoomsTab: document.getElementById("currentlyPlayingRoomsTab"),
  currentlyPlayingStreamsTab: document.getElementById("currentlyPlayingStreamsTab"),
  watchTogetherAdminList: document.getElementById("watchTogetherAdminList"),
  streamQueuesAdminList: document.getElementById("streamQueuesAdminList"),
  adminLogsPage: document.getElementById("adminLogsPage"),
  adminHistoryPage: document.getElementById("adminHistoryPage"),
  accountForm: document.getElementById("accountForm"),
  accountIdInput: document.getElementById("accountIdInput"),
  accountUsernameInput: document.getElementById("accountUsernameInput"),
  accountPasswordInput: document.getElementById("accountPasswordInput"),
  accountLibrariesSelect: document.getElementById("accountLibrariesSelect"),
  accountIsAdmin: document.getElementById("accountIsAdmin"),
  accountCanCopyUrls: document.getElementById("accountCanCopyUrls"),
  accountCanStreamQueues: document.getElementById("accountCanStreamQueues"),
  accountCanLibraries: document.getElementById("accountCanLibraries"),
  accountCanMetadata: document.getElementById("accountCanMetadata"),
  accountCanSettings: document.getElementById("accountCanSettings"),
  accountCanApiKeys: document.getElementById("accountCanApiKeys"),
  accountCanBackups: document.getElementById("accountCanBackups"),
  accountCanOptimizer: document.getElementById("accountCanOptimizer"),
  accountCanReindex: document.getElementById("accountCanReindex"),
  accountCanUsers: document.getElementById("accountCanUsers"),
  accountCanHardware: document.getElementById("accountCanHardware"),
  accountCanTasks: document.getElementById("accountCanTasks"),
  accountCanLogs: document.getElementById("accountCanLogs"),
  accountCanHistory: document.getElementById("accountCanHistory"),
  resetAccountForm: document.getElementById("resetAccountForm"),
  createAccount: document.getElementById("createAccount"),
  updateAccount: document.getElementById("updateAccount"),
  accountStatus: document.getElementById("accountStatus"),
  accountList: document.getElementById("accountList"),
  taskUpdatedAt: document.getElementById("taskUpdatedAt"),
  taskRunningCount: document.getElementById("taskRunningCount"),
  taskQueuedCount: document.getElementById("taskQueuedCount"),
  taskFailedCount: document.getElementById("taskFailedCount"),
  taskCompletedCount: document.getElementById("taskCompletedCount"),
  taskStateFilter: document.getElementById("taskStateFilter"),
  taskTypeFilter: document.getElementById("taskTypeFilter"),
  taskSearchFilter: document.getElementById("taskSearchFilter"),
  taskStatus: document.getElementById("taskStatus"),
  taskList: document.getElementById("taskList"),
  apiKeyForm: document.getElementById("apiKeyForm"),
  apiKeyUserSelect: document.getElementById("apiKeyUserSelect"),
  apiKeyNameInput: document.getElementById("apiKeyNameInput"),
  createApiKey: document.getElementById("createApiKey"),
  apiKeySecretPanel: document.getElementById("apiKeySecretPanel"),
  apiKeySecretValue: document.getElementById("apiKeySecretValue"),
  copyApiKeySecret: document.getElementById("copyApiKeySecret"),
  apiKeyStatus: document.getElementById("apiKeyStatus"),
  apiKeyList: document.getElementById("apiKeyList"),
  libraryViewForm: document.getElementById("libraryViewForm"),
  libraryViewNameInput: document.getElementById("libraryViewNameInput"),
  libraryViewLibraries: document.getElementById("libraryViewLibraries"),
  libraryViewSelectionCount: document.getElementById("libraryViewSelectionCount"),
  libraryViewSelectAll: document.getElementById("libraryViewSelectAll"),
  libraryViewClearAll: document.getElementById("libraryViewClearAll"),
  libraryViewExpirySelect: document.getElementById("libraryViewExpirySelect"),
  libraryViewCustomExpiryLabel: document.getElementById("libraryViewCustomExpiryLabel"),
  libraryViewCustomExpiryInput: document.getElementById("libraryViewCustomExpiryInput"),
  createLibraryView: document.getElementById("createLibraryView"),
  libraryViewSecretPanel: document.getElementById("libraryViewSecretPanel"),
  libraryViewSecretValue: document.getElementById("libraryViewSecretValue"),
  copyLibraryViewSecret: document.getElementById("copyLibraryViewSecret"),
  libraryViewStatus: document.getElementById("libraryViewStatus"),
  libraryViewList: document.getElementById("libraryViewList"),
  settingsForm: document.getElementById("settingsForm"),
  settingsLogLevel: document.getElementById("settingsLogLevel"),
  settingsLogRetentionDays: document.getElementById("settingsLogRetentionDays"),
  settingsAppIcon: document.getElementById("settingsAppIcon"),
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
  settingsMetadataProvidersMode: document.getElementById("settingsMetadataProvidersMode"),
  settingsMetadataCustomMode: document.getElementById("settingsMetadataCustomMode"),
  providerMetadataSettings: document.getElementById("providerMetadataSettings"),
  customMetadataSettings: document.getElementById("customMetadataSettings"),
  settingsCustomMetadataUrl: document.getElementById("settingsCustomMetadataUrl"),
  settingsCustomMetadataApiKey: document.getElementById("settingsCustomMetadataApiKey"),
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
  settingsYtDlpSubscriptionHours: document.getElementById("settingsYtDlpSubscriptionHours"),
  settingsYtDlpUpdate: document.getElementById("settingsYtDlpUpdate"),
  settingsYtDlpUploadCookies: document.getElementById("settingsYtDlpUploadCookies"),
  settingsYtDlpCookieHelp: document.getElementById("settingsYtDlpCookieHelp"),
  settingsYtDlpRemoveCookies: document.getElementById("settingsYtDlpRemoveCookies"),
  settingsYtDlpCookieFile: document.getElementById("settingsYtDlpCookieFile"),
  ytdlpCookieGuideOverlay: document.getElementById("ytdlpCookieGuideOverlay"),
  closeYtDlpCookieGuideIcon: document.getElementById("closeYtDlpCookieGuideIcon"),
  selectYtDlpCookiesFromGuide: document.getElementById("selectYtDlpCookiesFromGuide"),
  closeYtDlpCookieGuide: document.getElementById("closeYtDlpCookieGuide"),
  settingsYtDlpStatus: document.getElementById("settingsYtDlpStatus"),
  settingsYtDlpSubscriptionUrl: document.getElementById("settingsYtDlpSubscriptionUrl"),
  settingsYtDlpAddSubscription: document.getElementById("settingsYtDlpAddSubscription"),
  settingsYtDlpSubscriptionStatus: document.getElementById("settingsYtDlpSubscriptionStatus"),
  settingsYtDlpSubscriptions: document.getElementById("settingsYtDlpSubscriptions"),
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
  settingsHlsMinimumFreeSpace: document.getElementById("settingsHlsMinimumFreeSpace"),
  settingsForceTranscode: document.getElementById("settingsForceTranscode"),
  settingsOnDeckExpirationDays: document.getElementById("settingsOnDeckExpirationDays"),
  settingsWatchedThreshold: document.getElementById("settingsWatchedThreshold"),
  settingsSkipDetectionEnabled: document.getElementById("settingsSkipDetectionEnabled"),
  settingsOpenMovieEnabled: document.getElementById("settingsOpenMovieEnabled"),
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
  userHistoryList: document.getElementById("userHistoryList"),
  userHistoryUserFilter: document.getElementById("userHistoryUserFilter"),
  userHistoryTimespanFilter: document.getElementById("userHistoryTimespanFilter"),
  userHistoryCustomRange: document.getElementById("userHistoryCustomRange"),
  userHistoryStartDate: document.getElementById("userHistoryStartDate"),
  userHistoryEndDate: document.getElementById("userHistoryEndDate"),
  userHistoryStatus: document.getElementById("userHistoryStatus"),
  loadMoreUserHistory: document.getElementById("loadMoreUserHistory")
};

let hlsPlayer = null;
let pendingHlsAudioSwitch = null;
let nativePlayerErrorHandler = null;
let autoAdvanceInFlight = false;
let musicSeeking = false;
let videoSeeking = false;
let videoLastSeekAt = 0;
let videoControlsHideTimer = null;
let videoSubtitlePositionFrame = null;
let videoSubtitleResizeObserver = null;
const boundVideoSubtitleTracks = new WeakSet();
const positionedVideoSubtitleCues = new WeakSet();
const AUDIO_SWITCH_PREFETCH_SECONDS = 18;
const AUDIO_SWITCH_PREFETCH_ATTEMPTS = 4;
let playerStatusHideTimer = null;
let activeSkipMarkers = [];
let dismissedSkipMarkers = new Set();
let activePlaybackMedia = null;
let activeWebPlaybackRequest = null;
let webPlaybackRestartPromise = null;
let webPlaybackNeedsRenewal = false;
let webPlaybackSessionId = 0;
let activePlaybackShuffle = null;
let webProgressLastReportedAt = 0;
let webProgressRequest = null;
let seekEndRecoveryAttempted = false;
let videoLastObservedAt = 0;
let videoLastObservedSeconds = 0;
let videoRecoverableSeconds = 0;
let videoNaturalEndSeconds = 0;
let videoEndSkipRequested = false;
let floatingPlayerDrag = null;
let libraryObserver = null;
const libraryViewCache = new Map();
let progressRefreshPromise = null;
let draggedLibraryKey = null;
let adminRefreshTimer = null;
let taskSnapshot = null;
let taskRefreshInFlight = false;
const taskQueuePages = new Map();
const expandedTaskQueues = new Set();
let folderPickerPath = "";
let backupFolderPickerPath = "";
let backupWasRunning = false;
let downloadRefreshTimer = null;
let downloadHomeRefreshPromise = null;
let onDeckRefreshTimer = null;
let onDeckRefreshPromise = null;
let hasActiveDownloads = false;
let pendingChannelDownload = null;
let pendingLiveDownload = null;
let pendingLiveRelay = null;
let liveTvRefreshTimer = null;
let liveTvRefreshPromise = null;
let liveTvRequestId = 0;
let searchRequestId = 0;
let searchAbortController = null;
let routeRenderDepth = 0;
let userHistoryItems = [];
let userHistoryNextOffset = null;
let userHistoryLoading = false;
let watchTogetherSession = null;
let pendingWatchTogetherInvite = null;
let pendingWatchTogetherState = null;
let watchTogetherSuppressControlsUntil = 0;
let watchTogetherPanelView = "chat";
let watchTogetherPreviewDragState = null;
let watchTogetherMediaBrowserTrail = [];
let watchTogetherMediaBrowserRequestId = 0;
let copyQueueSelectedItem = null;
let copyQueues = [];
let selectedCopyQueueId = null;
let streamQueueMediaBrowserTrail = [];
let streamQueueMediaBrowserRequestId = 0;
let currentlyPlayingAdminView = "playback";
const downloadStatuses = new Map();
let librarySidebarGesture = null;
let hlsLibraryPromise = null;

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
    state.homeRequestId += 1;
    state.homeCache.clear();
    state.homeData = null;
    state.token = result.token;
    state.user = result.user;
    setPlaybackPreferences(result.user && result.user.preferences);
    applyFeatures(result.features);
    state.libraryViewToken = "";
    state.setupMode = false;
    localStorage.setItem("streamToken", state.token);
    els.loginOverlay.classList.add("hidden");
    updateAdminControls();
    await Promise.all([
      loadLibrarySidebar(true),
      renderRoute(navigation.readRoute())
    ]);
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

els.librarySidebarToggle.addEventListener("click", toggleLibrarySidebar);
els.libraryMobileToggle.addEventListener("click", () => setLibrarySidebarMobileOpen(true));
els.librarySidebarScrim.addEventListener("click", () => setLibrarySidebarMobileOpen(false));
window.addEventListener("resize", handleLibrarySidebarResize);
document.addEventListener("touchstart", beginLibrarySidebarGesture, { passive: true });
document.addEventListener("touchend", finishLibrarySidebarGesture, { passive: true });
document.addEventListener("touchcancel", () => {
  librarySidebarGesture = null;
}, { passive: true });
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.librarySidebarMobileOpen) {
    setLibrarySidebarMobileOpen(false);
  }
});

els.lockButton.addEventListener("click", () => {
  api("/api/auth/logout", state.token, { method: "POST" }).catch(() => {});
  hideLiveTvView();
  closeAccountPanel();
  closePlayer();
  localStorage.removeItem("streamToken");
  state.token = "";
  state.user = null;
  setPlaybackPreferences(null);
  state.libraryViewToken = "";
  state.libraries = [];
  state.homeRequestId += 1;
  state.homeCache.clear();
  state.homeData = null;
  renderLibrarySidebar();
  libraryViewCache.clear();
  els.usernameInput.value = "";
  els.secretInput.value = "";
  updateAdminControls();
  els.loginOverlay.classList.remove("hidden");
});

els.accountButton.addEventListener("click", openAccountPanel);
els.closeAccountPanel.addEventListener("click", closeAccountPanel);
els.selfAccountForm.addEventListener("submit", saveSelfAccount);
els.selfAccountThemePreset.addEventListener("change", previewThemePreset);
els.selfAccountThemeColour.addEventListener("input", previewCustomThemeColour);
els.openThemeColourPicker.addEventListener("click", openThemeColourPicker);
els.accountOverlay.addEventListener("click", (event) => {
  if (event.target === els.accountOverlay) {
    closeAccountPanel();
  }
});
els.downloadButton.addEventListener("click", openDownloadPanel);
els.liveTvButton.addEventListener("click", () => openLiveTv(new Date(), true));
els.streamQueuesButton.addEventListener("click", () => openStreamQueuesView());
els.liveTvEarlier.addEventListener("click", () => shiftLiveTvGuide(-1));
els.liveTvNow.addEventListener("click", () => openLiveTv(new Date(), true));
els.liveTvLater.addEventListener("click", () => shiftLiveTvGuide(1));
els.liveTvFilter.addEventListener("input", filterLiveTvChannels);
els.closeDownloadPanel.addEventListener("click", closeDownloadPanel);
els.downloadForm.addEventListener("submit", startYtDlpDownload);
els.downloadChannel.addEventListener("click", downloadYtDlpChannel);
els.subscribeChannel.addEventListener("click", subscribeYtDlpChannel);
els.cancelChannelChoice.addEventListener("click", clearYtDlpDownloadChoice);
els.recordLiveStream.addEventListener("click", recordYtDlpLiveStream);
els.relayLiveStream.addEventListener("click", relayYtDlpLiveStream);
els.cancelLiveChoice.addEventListener("click", clearYtDlpDownloadChoice);
els.playLiveRelay.addEventListener("click", playYtDlpLiveRelay);
els.copyLiveRelay.addEventListener("click", copyYtDlpLiveRelay);
els.closeLiveRelay.addEventListener("click", closeDownloadPanel);
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
els.adminOptimizerTab.addEventListener("click", () => openAdminPanel("optimizer"));
els.adminSkipDetectionTab.addEventListener("click", () => openAdminPanel("skipDetection"));
els.adminSettingsTab.addEventListener("click", () => openAdminPanel("settings"));
els.adminTasksTab.addEventListener("click", () => openAdminPanel("tasks"));
els.adminHardwareTab.addEventListener("click", () => openAdminPanel("hardware"));
els.adminCurrentlyPlayingTab.addEventListener("click", () => openAdminPanel("currentlyPlaying"));
els.adminLogsTab.addEventListener("click", () => openAdminPanel("logs"));
els.adminHistoryTab.addEventListener("click", () => openAdminPanel("history"));
els.userHistoryUserFilter.addEventListener("change", () => loadUserHistory());
els.userHistoryTimespanFilter.addEventListener("change", handleUserHistoryTimespanChange);
els.userHistoryStartDate.addEventListener("change", () => loadUserHistory());
els.userHistoryEndDate.addEventListener("change", () => loadUserHistory());
els.taskStateFilter.addEventListener("change", renderTasks);
els.taskTypeFilter.addEventListener("change", renderTasks);
els.taskSearchFilter.addEventListener("input", renderTasks);
els.loadMoreUserHistory.addEventListener("click", () => loadUserHistory({ append: true }));
els.accountForm.addEventListener("submit", saveAccount);
els.resetAccountForm.addEventListener("click", resetAccountForm);
els.apiKeyForm.addEventListener("submit", createApiKey);
els.copyApiKeySecret.addEventListener("click", copyNewApiKey);
els.libraryViewForm.addEventListener("submit", createLibraryView);
els.libraryViewLibraries.addEventListener("change", updateLibraryViewSelectionCount);
els.libraryViewSelectAll.addEventListener("click", () => setAllLibraryViewSelections(true));
els.libraryViewClearAll.addEventListener("click", () => setAllLibraryViewSelections(false));
els.libraryViewExpirySelect.addEventListener("change", updateLibraryViewExpiryControl);
els.copyLibraryViewSecret.addEventListener("click", copyNewLibraryViewUrl);
els.settingsForm.addEventListener("submit", saveSettings);
els.retrySkipDetectionFailures.addEventListener("click", retrySkipDetectionFailures);
els.reanalyseSkipDetection.addEventListener("click", () => reanalyseSkipDetection(false));
els.rebuildSkipDetection.addEventListener("click", () => reanalyseSkipDetection(true));
els.refreshSkipDetectionMarkers.addEventListener("click", loadSkipDetectionMarkers);
els.settingsCheckUpdates.addEventListener("click", forceCheckForUpdates);
els.settingsInstallUpdate.addEventListener("click", installAvailableUpdate);
els.settingsYtDlpUpdate.addEventListener("click", forceYtDlpUpdate);
els.settingsYtDlpUploadCookies.addEventListener("click", () => els.settingsYtDlpCookieFile.click());
els.settingsYtDlpCookieHelp.addEventListener("click", openYtDlpCookieGuide);
els.closeYtDlpCookieGuideIcon.addEventListener("click", closeYtDlpCookieGuide);
els.closeYtDlpCookieGuide.addEventListener("click", closeYtDlpCookieGuide);
els.selectYtDlpCookiesFromGuide.addEventListener("click", () => {
  closeYtDlpCookieGuide();
  els.settingsYtDlpCookieFile.click();
});
els.ytdlpCookieGuideOverlay.addEventListener("click", (event) => {
  if (event.target === els.ytdlpCookieGuideOverlay) {
    closeYtDlpCookieGuide();
  }
});
els.settingsYtDlpCookieFile.addEventListener("change", uploadYtDlpCookies);
els.settingsYtDlpRemoveCookies.addEventListener("click", removeYtDlpCookies);
els.settingsYtDlpAddSubscription.addEventListener("click", addYtDlpSubscription);
els.settingsYtDlpSubscriptionUrl.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    addYtDlpSubscription();
  }
});
els.settingsYtDlpSubscriptions.addEventListener("click", (event) => {
  const button = event.target.closest("[data-remove-ytdlp-subscription]");
  if (button) removeYtDlpSubscription(button.dataset.removeYtdlpSubscription);
});
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
els.settingsMetadataProvidersMode.addEventListener("click", () => setMetadataSource("providers"));
els.settingsMetadataCustomMode.addEventListener("click", () => setMetadataSource("custom"));
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
els.optimizerForm.addEventListener("submit", saveOptimizerSettings);
els.optimizerLibraryList.addEventListener("click", handleOptimizerLibraryAction);
els.optimizerLibraryList.addEventListener("change", handleOptimizerLibrarySettingChange);
els.toggleOptimizerWork.addEventListener("click", toggleOptimizerWorkPanel);
els.toggleOptimizerFailures.addEventListener("click", toggleOptimizerFailuresPanel);
els.clearOptimizerFailures.addEventListener("click", clearOptimizerFailures);
els.browseBackupDirectory.addEventListener("click", openBackupFolderPicker);
els.closeBackupFolderPicker.addEventListener("click", closeBackupFolderPicker);
els.backupFolderParent.addEventListener("click", () => {
  if (els.backupFolderParent.dataset.path) loadBackupFolderPicker(els.backupFolderParent.dataset.path);
});
els.selectBackupFolder.addEventListener("click", selectBackupFolder);
els.closeDetails.addEventListener("click", closeDetails);
els.toggleFilePath.addEventListener("click", toggleFilePath);
els.searchInput.addEventListener("input", debounce(search, 300));
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
els.startWatchTogether.addEventListener("click", startWatchTogether);
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
els.seriesPosterForm.addEventListener("submit", saveSeriesPoster);
els.cancelSeriesPoster.addEventListener("click", closeSeriesPosterEditor);
els.seriesPosterOverlay.addEventListener("click", (event) => {
  if (event.target === els.seriesPosterOverlay) {
    closeSeriesPosterEditor();
  }
});
els.markWatched.addEventListener("click", markSelectedWatched);
els.removeOnDeck.addEventListener("click", removeSelectedOnDeck);
els.closePlayer.addEventListener("click", closePlayer);
els.toggleWatchTogetherPanel.addEventListener("click", () => {
  setWatchTogetherPanelOpen(els.watchTogetherPanel.classList.contains("hidden"));
});
els.closeWatchTogetherPanel.addEventListener("click", () => setWatchTogetherPanelOpen(false));
els.watchTogetherPanel.addEventListener("click", selectWatchTogetherPanelView);
els.openWatchTogetherMediaBrowser.addEventListener("click", openWatchTogetherMediaBrowser);
els.closeWatchTogetherMediaBrowser.addEventListener("click", closeWatchTogetherMediaBrowser);
els.watchTogetherMediaBrowserBack.addEventListener("click", navigateBackWatchTogetherMediaBrowser);
els.watchTogetherPreviewDrag.addEventListener("pointerdown", beginWatchTogetherPreviewDrag);
window.addEventListener("pointermove", moveWatchTogetherPreview);
window.addEventListener("pointerup", endWatchTogetherPreviewDrag);
window.addEventListener("pointercancel", endWatchTogetherPreviewDrag);
window.addEventListener("resize", resetWatchTogetherPreviewPosition);
els.watchTogetherJoinForm.addEventListener("submit", submitWatchTogetherGuestName);
els.watchTogetherChatForm.addEventListener("submit", sendWatchTogetherChat);
els.watchTogetherEveryoneControls.addEventListener("change", changeWatchTogetherControls);
els.watchTogetherEveryoneQueues.addEventListener("change", changeWatchTogetherControls);
els.copyWatchTogetherInvite.addEventListener("click", copyWatchTogetherInvite);
els.closeWatchTogetherRoom.addEventListener("click", closeWatchTogetherRoom);
els.watchTogetherParticipants.addEventListener("click", kickWatchTogetherParticipant);
els.watchTogetherQueue.addEventListener("click", handleWatchTogetherQueueAction);
els.watchTogetherSkipQueueItem.addEventListener("click", () => sendWatchTogether({ type: "queue-skip" }));
els.watchTogetherQueueSearchForm.addEventListener("submit", searchWatchTogetherQueueMedia);
els.newStreamQueue.addEventListener("click", () => beginStreamQueueDraft());
els.cancelStreamQueueDraft.addEventListener("click", cancelStreamQueueDraft);
els.streamQueueMediaBrowserBack.addEventListener("click", navigateBackStreamQueueMediaBrowser);
els.streamQueueSearchForm.addEventListener("submit", searchStreamQueueMedia);
els.addStreamQueueMedia.addEventListener("click", addSelectedStreamQueueMedia);
els.createStreamQueue.addEventListener("click", createCopyStreamQueue);
els.copyCopyQueueUrl.addEventListener("click", copyCreatedQueueUrl);
els.copyQueueList.addEventListener("click", handleCopyQueueAction);
els.streamQueueItems.addEventListener("click", handleCopyQueueAction);
els.copyCurrentStreamUrl.addEventListener("click", copyCurrentStreamUrl);
els.playCurrentStream.addEventListener("click", () => updateSelectedCopyQueue("play"));
els.skipCurrentStreamItem.addEventListener("click", () => updateSelectedCopyQueue("skip"));
els.stopCurrentStream.addEventListener("click", stopSelectedCopyQueue);
els.currentlyPlayingPlaybackTab.addEventListener("click", () => setCurrentlyPlayingAdminView("playback"));
els.currentlyPlayingRoomsTab.addEventListener("click", () => setCurrentlyPlayingAdminView("rooms"));
els.currentlyPlayingStreamsTab.addEventListener("click", () => setCurrentlyPlayingAdminView("streams"));
els.watchTogetherAdminList.addEventListener("click", closeAdminWatchTogetherRoom);
els.streamQueuesAdminList.addEventListener("click", stopAdminStreamQueue);
els.minimizeVideoPlayer.addEventListener("click", minimizeVideoPlayback);
els.restoreVideoPlayer.addEventListener("click", restoreVideoPlayback);
els.closeVideoMiniPlayer.addEventListener("click", closePlayer);
els.webPlayer.addEventListener("playing", startOnDeckPolling);
els.webPlayer.addEventListener("playing", () => clearPlayerStatus("Press play to allow synchronized playback."));
els.webPlayer.addEventListener("pause", stopOnDeckPolling);
els.webPlayer.addEventListener("ended", handleWebPlayerEnded);
els.webPlayer.addEventListener("play", handleWebPlayerReplay);
els.webPlayer.addEventListener("play", updateMusicPlayerControls);
els.webPlayer.addEventListener("pause", updateMusicPlayerControls);
els.webPlayer.addEventListener("timeupdate", updateMusicPlayerControls);
els.webPlayer.addEventListener("timeupdate", trackVideoPlaybackContinuity);
els.webPlayer.addEventListener("timeupdate", () => reportWebPlaybackProgress());
els.webPlayer.addEventListener("timeupdate", () => reportWatchTogetherProgress());
els.webPlayer.addEventListener("loadedmetadata", updateMusicPlayerControls);
els.webPlayer.addEventListener("loadedmetadata", notifyWatchTogetherReady);
els.webPlayer.addEventListener("progress", notifyWatchTogetherReady);
els.webPlayer.addEventListener("canplay", notifyWatchTogetherReady);
els.webPlayer.addEventListener("canplaythrough", notifyWatchTogetherReady);
els.webPlayer.addEventListener("waiting", notifyWatchTogetherReady);
els.webPlayer.addEventListener("stalled", notifyWatchTogetherReady);
els.webPlayer.addEventListener("seeking", notifyWatchTogetherReady);
els.webPlayer.addEventListener("seeked", notifyWatchTogetherReady);
els.webPlayer.addEventListener("durationchange", updateMusicPlayerControls);
els.webPlayer.addEventListener("volumechange", updateMusicPlayerControls);
els.webPlayer.addEventListener("play", updateVideoPlayerControls);
els.webPlayer.addEventListener("pause", updateVideoPlayerControls);
els.webPlayer.addEventListener("play", () => sendWatchTogetherLocalState("play"));
els.webPlayer.addEventListener("pause", () => sendWatchTogetherLocalState("pause"));
els.webPlayer.addEventListener("timeupdate", updateVideoPlayerControls);
els.webPlayer.addEventListener("loadedmetadata", updateVideoPlayerControls);
els.webPlayer.addEventListener("loadedmetadata", updateNativeTrackControls);
if (els.webPlayer.textTracks && typeof els.webPlayer.textTracks.addEventListener === "function") {
  els.webPlayer.textTracks.addEventListener("addtrack", (event) => {
    bindVideoSubtitleTrack(event.track);
    scheduleVideoSubtitlePositionUpdate();
  });
}
bindVideoSubtitleTracks();
if (typeof window.ResizeObserver === "function") {
  videoSubtitleResizeObserver = new window.ResizeObserver(scheduleVideoSubtitlePositionUpdate);
  videoSubtitleResizeObserver.observe(els.videoPlaybackSurface);
} else {
  window.addEventListener("resize", scheduleVideoSubtitlePositionUpdate);
}
els.webPlayer.addEventListener("durationchange", updateVideoPlayerControls);
els.webPlayer.addEventListener("volumechange", updateVideoPlayerControls);
els.webPlayer.addEventListener("seeking", handleVideoSeeking);
els.webPlayer.addEventListener("seeked", () => reportWebPlaybackProgress(true));
els.webPlayer.addEventListener("click", toggleVideoPlayback);
els.webPlayer.addEventListener("dblclick", toggleVideoFullscreen);
els.videoPlayPause.addEventListener("click", toggleVideoPlayback);
els.videoMute.addEventListener("click", toggleVideoMute);
els.videoSeek.addEventListener("pointerdown", () => { videoSeeking = true; });
els.videoSeek.addEventListener("input", seekVideoPlayback);
els.videoSeek.addEventListener("change", finishVideoSeek);
els.videoVolume.addEventListener("input", updateVideoVolume);
els.videoAudioTrack.addEventListener("change", changeVideoAudioTrack);
els.videoSubtitleTrack.addEventListener("change", changeVideoSubtitleTrack);
els.videoTrackSettings.addEventListener("click", toggleVideoTrackSettings);
els.videoShuffle.addEventListener("click", toggleVideoShuffle);
els.videoPictureInPicture.addEventListener("click", toggleVideoPictureInPicture);
els.videoFullscreen.addEventListener("click", toggleVideoFullscreen);
els.videoSkipMarker.addEventListener("click", skipCurrentMarker);
els.videoContinueMarker.addEventListener("click", dismissCurrentMarker);
const revealVideoControls = () => showVideoControls();
els.videoPlaybackSurface.addEventListener("pointermove", revealVideoControls);
els.videoPlaybackSurface.addEventListener("pointerdown", revealVideoControls);
els.videoPlaybackSurface.addEventListener("mousemove", revealVideoControls);
els.videoPlaybackSurface.addEventListener("touchstart", revealVideoControls, { passive: true });
els.videoPlaybackSurface.addEventListener("pointerleave", scheduleVideoControlsHide);
els.videoPlaybackSurface.addEventListener("focusin", revealVideoControls);
els.videoPlaybackSurface.addEventListener("focusout", scheduleVideoControlsHide);
document.addEventListener("pointermove", () => {
  if (document.fullscreenElement === els.videoPlaybackSurface
    || document.webkitFullscreenElement === els.videoPlaybackSurface) {
    revealVideoControls();
  }
});
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
  if (!els.videoTrackControls.classList.contains("hidden")
    && !els.videoTrackControls.contains(event.target)
    && !els.videoTrackSettings.contains(event.target)) {
    closeVideoTrackSettings();
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
  if (!els.videoTrackControls.classList.contains("hidden")) {
    closeVideoTrackSettings();
    els.videoTrackSettings.focus({ preventScroll: true });
    return;
  }
  if (!els.ytdlpCookieGuideOverlay.classList.contains("hidden")) {
    closeYtDlpCookieGuide();
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
  if (!state.token && !state.libraryViewToken && route.name !== "watch") {
    return;
  }
  renderRoute(route).catch(() => {
    navigation.navigate("/", { replace: true });
    loadHome();
  });
});

boot();

async function boot() {
  const initialRoute = navigation.readRoute();
  let status;
  try {
    status = await api("/api/auth/status");
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

  if (!state.token && !state.libraryViewToken && initialRoute.name !== "watch") {
    els.loginOverlay.classList.remove("hidden");
    revealApp();
    return;
  }

  try {
    if (state.token) {
      if (!status.user) {
        throw new Error("The saved session is no longer valid.");
      }
      state.user = status.user;
      setPlaybackPreferences(status.user.preferences);
    }
    els.loginOverlay.classList.add("hidden");
    updateAdminControls();
    revealApp();
    const initialLoads = [renderRoute(initialRoute)];
    if (initialRoute.name !== "watch" || state.token || state.libraryViewToken) {
      initialLoads.push(loadLibrarySidebar(true));
    }
    await Promise.all(initialLoads);
    refreshIptvAvailability();
    if (!state.libraryViewToken) {
      refreshSystemHealthInBackground();
      refreshUpdateStatusInBackground();
    }
  } catch (err) {
    const libraryViewFailed = Boolean(state.libraryViewToken);
    if (!state.libraryViewToken) {
      localStorage.removeItem("streamToken");
    }
    state.token = "";
    state.user = null;
    setPlaybackPreferences(null);
    state.libraryViewToken = "";
    updateAdminControls();
    if (initialRoute.name === "watch") {
      els.loginOverlay.classList.add("hidden");
      await renderRoute(initialRoute).catch((routeError) => {
        els.watchTogetherJoinStatus.textContent = routeError.message || "This Watch Together room is unavailable.";
      });
    } else {
      if (libraryViewFailed) {
        els.loginError.textContent = "This library view URL is invalid, expired, or has been revoked.";
      }
      els.loginOverlay.classList.remove("hidden");
    }
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
  updateLibrarySidebarSelection(route);
  setLibrarySidebarMobileOpen(false);
  try {
    if (route.name === "watch") {
      await openWatchTogether(route.inviteToken);
      return;
    }
    if (watchTogetherSession) {
      closePlayer({ navigate: false });
    }
    if (route.name === "history" && !state.libraryViewToken) {
      await openHistoryView();
      return;
    }
    if (route.name === "live-tv" && !state.libraryViewToken) {
      if (state.iptvEnabled && canAccessLiveTv()) {
        await openLiveTv(route.start, route.pinnedToNow);
        return;
      }
      navigation.navigate("/", { replace: true });
    }
    if (route.name === "stream-queues" && !state.libraryViewToken) {
      if (hasPermission("canManageStreamQueues")) {
        await openStreamQueuesView({ record: false });
        return;
      }
      navigation.navigate("/", { replace: true });
    }
    if (route.name === "library") {
      await openLibraryView(route.libraryKey, route.title || readableRouteName(route.libraryKey), route.folder || "", { restore: true });
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

async function loadLibrarySidebar(force = false) {
  if ((!state.token && !state.libraryViewToken) || state.libraries.length > 0 && !force) {
    renderLibrarySidebar();
    return;
  }

  try {
    const data = await api("/api/catalog/libraries");
    state.libraries = Array.isArray(data.libraries) ? data.libraries : [];
  } catch (err) {
    state.libraries = [];
  }
  renderLibrarySidebar();
}

function renderLibrarySidebar() {
  const available = state.libraries.length > 0;
  els.librarySidebarNav.replaceChildren();
  els.librarySidebar.classList.toggle("hidden", !available);
  els.libraryMobileToggle.classList.toggle("hidden", !available);
  els.appLayout.classList.toggle("sidebar-hidden", !available);
  if (!available) {
    setLibrarySidebarMobileOpen(false);
    return;
  }

  const homeButton = document.createElement("button");
  homeButton.className = "library-nav-item";
  homeButton.type = "button";
  homeButton.dataset.navigationTarget = "home";
  homeButton.title = "Home";
  homeButton.setAttribute("aria-label", "Home");
  homeButton.innerHTML = `
    <span class="library-nav-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m3 11 9-8 9 8"/><path d="M5 10v11h14V10"/><path d="M9 21v-7h6v7"/></svg></span>
    <span class="library-nav-label">Home</span>
  `;
  homeButton.addEventListener("click", () => {
    setLibrarySidebarMobileOpen(false);
    loadHome();
  });
  els.librarySidebarNav.appendChild(homeButton);

  for (const library of state.libraries) {
    const button = document.createElement("button");
    button.className = "library-nav-item";
    button.type = "button";
    button.dataset.libraryKey = library.key;
    button.title = library.title;
    button.setAttribute("aria-label", library.title);
    button.innerHTML = `
      <span class="library-nav-icon" aria-hidden="true">${libraryTypeIcon(library.type)}</span>
      <span class="library-nav-label">${escapeHtml(library.title)}</span>
    `;
    button.addEventListener("click", () => {
      setLibrarySidebarMobileOpen(false);
      openLibraryView(library.key, library.title, "", { restore: true });
    });
    els.librarySidebarNav.appendChild(button);
  }
  applyLibrarySidebarState();
  updateLibrarySidebarSelection(navigation.readRoute());
}

function toggleLibrarySidebar() {
  if (isLibrarySidebarMobile()) {
    setLibrarySidebarMobileOpen(false);
    return;
  }
  state.librarySidebarExpanded = !state.librarySidebarExpanded;
  try {
    localStorage.setItem(LIBRARY_SIDEBAR_PREFERENCE_KEY, state.librarySidebarExpanded ? "true" : "false");
  } catch (err) {
    // The current page can still retain the preference when storage is unavailable.
  }
  applyLibrarySidebarState();
}

function applyLibrarySidebarState() {
  const mobile = isLibrarySidebarMobile();
  els.appLayout.classList.toggle("sidebar-collapsed", !state.librarySidebarExpanded);
  els.librarySidebarToggle.setAttribute("aria-expanded", mobile
    ? String(state.librarySidebarMobileOpen)
    : String(state.librarySidebarExpanded));
  els.librarySidebarToggle.setAttribute("aria-label", mobile
    ? "Close libraries"
    : state.librarySidebarExpanded ? "Collapse libraries" : "Expand libraries");
  els.librarySidebarToggle.title = mobile
    ? "Close libraries"
    : state.librarySidebarExpanded ? "Collapse libraries" : "Expand libraries";
  els.librarySidebarToggle.innerHTML = mobile
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h4M14 9l-3 3 3 3M21 3v18"/></svg>';
}

function setLibrarySidebarMobileOpen(open) {
  const nextOpen = Boolean(open && isLibrarySidebarMobile() && state.libraries.length > 0);
  state.librarySidebarMobileOpen = nextOpen;
  els.appLayout.classList.toggle("sidebar-mobile-open", nextOpen);
  els.librarySidebarScrim.classList.toggle("hidden", !nextOpen);
  els.libraryMobileToggle.setAttribute("aria-expanded", String(nextOpen));
  els.libraryMobileToggle.setAttribute("aria-label", nextOpen ? "Close libraries" : "Open libraries");
  els.libraryMobileToggle.title = nextOpen ? "Close libraries" : "Open libraries";
  document.body.classList.toggle("library-sidebar-open", nextOpen);
  applyLibrarySidebarState();
}

function handleLibrarySidebarResize() {
  if (!isLibrarySidebarMobile() && state.librarySidebarMobileOpen) {
    setLibrarySidebarMobileOpen(false);
  } else {
    applyLibrarySidebarState();
  }
}

function beginLibrarySidebarGesture(event) {
  if (!isLibrarySidebarMobile() || event.touches.length !== 1 || state.libraries.length === 0) {
    return;
  }
  const touch = event.touches[0];
  const canOpen = !state.librarySidebarMobileOpen && touch.clientX <= 28;
  const canClose = state.librarySidebarMobileOpen && els.librarySidebar.contains(event.target);
  if (!canOpen && !canClose) return;
  librarySidebarGesture = {
    x: touch.clientX,
    y: touch.clientY,
    opening: canOpen
  };
}

function finishLibrarySidebarGesture(event) {
  if (!librarySidebarGesture || event.changedTouches.length === 0) {
    librarySidebarGesture = null;
    return;
  }
  const touch = event.changedTouches[0];
  const deltaX = touch.clientX - librarySidebarGesture.x;
  const deltaY = touch.clientY - librarySidebarGesture.y;
  const horizontalSwipe = Math.abs(deltaX) >= 56 && Math.abs(deltaX) > Math.abs(deltaY) * 1.25;
  if (horizontalSwipe) {
    if (librarySidebarGesture.opening && deltaX > 0) {
      setLibrarySidebarMobileOpen(true);
    } else if (!librarySidebarGesture.opening && deltaX < 0) {
      setLibrarySidebarMobileOpen(false);
    }
  }
  librarySidebarGesture = null;
}

function updateLibrarySidebarSelection(route) {
  const libraryKey = route && ["library", "show", "season", "artist", "album"].includes(route.name)
    ? route.libraryKey
    : "";
  els.librarySidebarNav.querySelectorAll(".library-nav-item").forEach((button) => {
    const active = button.dataset.navigationTarget === "home"
      ? route && route.name === "home"
      : Boolean(libraryKey) && button.dataset.libraryKey === libraryKey;
    button.classList.toggle("active", active);
    if (active) {
      button.setAttribute("aria-current", "page");
    } else {
      button.removeAttribute("aria-current");
    }
  });
}

function readLibrarySidebarPreference() {
  try {
    return localStorage.getItem(LIBRARY_SIDEBAR_PREFERENCE_KEY) !== "false";
  } catch (err) {
    return true;
  }
}

function isLibrarySidebarMobile() {
  return window.matchMedia("(max-width: 900px)").matches;
}

function libraryTypeIcon(type) {
  if (type === "tv") {
    return '<svg viewBox="0 0 24 24"><path d="m17 2-5 5-5-5"/><rect width="20" height="15" x="2" y="7" rx="2"/></svg>';
  }
  if (type === "music") {
    return '<svg viewBox="0 0 24 24"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';
  }
  if (type === "images") {
    return '<svg viewBox="0 0 24 24"><rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/></svg>';
  }
  return '<svg viewBox="0 0 24 24"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M7 3v18M17 3v18M3 7.5h4M3 12h18M3 16.5h4M17 7.5h4M17 16.5h4"/></svg>';
}

function recordRoute(path, options = {}) {
  if (routeRenderDepth === 0) {
    navigation.navigate(path, options);
    updateLibrarySidebarSelection(navigation.readRoute());
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
  stopHomeRowLoading();
  hideLiveTvView();
  state.homeMode = mode === "random" ? "random" : "recent";
  const requestId = ++state.homeRequestId;
  recordRoute(navigation.homePath(state.homeMode));
  updateHomeModeControls();
  prepareHomeView();

  const cached = state.homeCache.get(state.homeMode);
  if (cached) {
    renderHomeSnapshot(cached.data, cached.onDeckItems);
  } else {
    const status = document.createElement("p");
    status.className = "status";
    status.textContent = "Loading home...";
    els.homeRows.replaceChildren(status);
  }

  const params = new URLSearchParams({
    mode: state.homeMode,
    limit: String(HOME_ROW_PAGE_SIZE)
  });
  const homeRequest = api(`/api/catalog/home?${params.toString()}`);
  const onDeckRequest = state.libraryViewToken
    ? Promise.resolve(null)
    : api("/api/progress/on-deck").catch(() => null);

  let data;
  let onDeck;
  try {
    [data, onDeck] = await Promise.all([homeRequest, onDeckRequest]);
  } catch (err) {
    if (cached) {
      return;
    }
    throw err;
  }

  if (state.homeRequestId !== requestId || state.currentView !== "home" || data.mode !== state.homeMode) {
    return;
  }

  const onDeckItems = onDeck
    ? onDeck.items || []
    : cached ? cached.onDeckItems : [];
  state.homeCache.set(state.homeMode, { data, onDeckItems });
  renderHomeSnapshot(data, onDeckItems);
}

function prepareHomeView() {
  hideStreamQueuesView();
  state.currentView = "home";
  els.searchInput.value = "";
  els.searchResults.classList.add("hidden");
  els.homeToolbar.classList.remove("hidden");
  els.homeRows.classList.remove("hidden");
}

function renderHomeSnapshot(data, onDeckItems) {
  stopHomeRowLoading();
  state.homeData = data;
  state.homeSeed = data.seed || "";
  els.homeRows.innerHTML = "";
  renderOnDeckRow(onDeckItems || []);
  for (const row of data.rows) {
    els.homeRows.appendChild(homeLibraryRowSection(row));
  }
}

function homeLibraryRowSection(row) {
  const section = rowSection(row.title, row.total || row.items.length, row.items, row.key);
  const rail = section.querySelector(".rail");
  const rowState = {
    key: row.key,
    title: row.title,
    rail,
    offset: Number.isFinite(Number(row.nextOffset)) ? Number(row.nextOffset) : row.items.length,
    hasMore: Boolean(row.hasMore),
    loading: false,
    requestId: 0,
    itemKeys: new Set(row.items.map(homeRowItemKey))
  };
  rail.addEventListener("scroll", () => {
    rowState.failed = false;
    scheduleHomeRowLoad(rowState);
  }, { passive: true });
  state.homeRows.set(row.key, rowState);
  requestAnimationFrame(() => scheduleHomeRowLoad(rowState));
  return section;
}

function scheduleHomeRowLoad(rowState) {
  if (state.currentView !== "home" || state.homeRows.get(rowState.key) !== rowState || rowState.scrollFrame) {
    return;
  }
  rowState.scrollFrame = requestAnimationFrame(() => {
    rowState.scrollFrame = null;
    if (homeRailNearEnd(rowState.rail)) {
      loadNextHomeRowPage(rowState);
    }
  });
}

function homeRailNearEnd(rail) {
  return rail.scrollWidth - rail.scrollLeft - rail.clientWidth < 720;
}

async function loadNextHomeRowPage(rowState) {
  if (rowState.loading || !rowState.hasMore || state.homeRows.get(rowState.key) !== rowState) {
    return;
  }

  rowState.loading = true;
  const requestId = ++rowState.requestId;
  const loader = document.createElement("div");
  loader.className = "rail-load-indicator";
  loader.setAttribute("aria-label", `Loading more ${rowState.title}`);
  rowState.rail.appendChild(loader);

  try {
    const params = new URLSearchParams({
      mode: state.homeMode,
      library: rowState.key,
      offset: String(rowState.offset),
      limit: String(HOME_ROW_PAGE_SIZE),
      seed: state.homeSeed
    });
    const data = await api(`/api/catalog/home?${params.toString()}`);
    const row = data.rows && data.rows[0];
    if (!row || state.homeRows.get(rowState.key) !== rowState || rowState.requestId !== requestId) {
      return;
    }

    loader.remove();
    for (const item of row.items || []) {
      const key = homeRowItemKey(item);
      if (rowState.itemKeys.has(key)) continue;
      rowState.itemKeys.add(key);
      rowState.rail.appendChild(card(item));
    }
    rowState.offset = Number.isFinite(Number(row.nextOffset))
      ? Number(row.nextOffset)
      : rowState.offset + (row.items || []).length;
    rowState.hasMore = Boolean(row.hasMore) && (row.items || []).length > 0;
  } catch (err) {
    rowState.failed = true;
  } finally {
    loader.remove();
    if (state.homeRows.get(rowState.key) === rowState && rowState.requestId === requestId) {
      rowState.loading = false;
      if (rowState.hasMore && !rowState.failed) {
        requestAnimationFrame(() => scheduleHomeRowLoad(rowState));
      }
    }
  }
}

function homeRowItemKey(item) {
  return `${item.mediaType || ""}:${item.itemType || item.kind || "item"}:${item.id || item.filePath || item.title || ""}`;
}

function stopHomeRowLoading() {
  for (const rowState of state.homeRows.values()) {
    rowState.requestId += 1;
    if (rowState.scrollFrame) {
      cancelAnimationFrame(rowState.scrollFrame);
    }
  }
  state.homeRows.clear();
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
        const items = onDeck.items || [];
        renderOnDeckRow(items);
        const cached = state.homeCache.get(state.homeMode);
        if (cached) {
          cached.onDeckItems = items;
        }
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
  els.updateBannerMeta.textContent = `You are running ${status.currentVersion}.${latest.publishedAt ? ` Released ${formatDate(latest.publishedAt)}.` : ""}`;
  els.updateBannerMessage.textContent = latest.changelog || "No changelog was provided for this release.";
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
  hideStreamQueuesView();
  const query = els.searchInput.value.trim();
  const requestId = ++searchRequestId;
  if (searchAbortController) {
    searchAbortController.abort();
    searchAbortController = null;
  }
  if (!query) {
    if (state.currentView === "search") {
      await loadHome(state.homeMode);
      return;
    }
    recordRoute(navigation.homePath(state.homeMode), { replace: state.currentView === "search" });
    els.searchResults.classList.add("hidden");
    els.homeToolbar.classList.remove("hidden");
    els.homeRows.classList.remove("hidden");
    els.searchGrid.innerHTML = "";
    els.searchCount.textContent = "";
    state.currentView = "home";
    return;
  }

  stopHomeRowLoading();
  recordRoute(navigation.searchPath(query), { replace: state.currentView === "search" });
  els.homeRows.classList.add("hidden");
  els.homeToolbar.classList.add("hidden");
  state.currentView = "search";
  const controller = new AbortController();
  searchAbortController = controller;
  let data;
  try {
    data = await api(
      `/api/catalog/search?q=${encodeURIComponent(query)}`,
      state.token,
      { signal: controller.signal }
    );
  } catch (err) {
    if (err && err.name === "AbortError") {
      return;
    }
    throw err;
  } finally {
    if (searchAbortController === controller) {
      searchAbortController = null;
    }
  }
  if (requestId !== searchRequestId
    || state.currentView !== "search"
    || els.searchInput.value.trim() !== query) {
    return;
  }
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
  if (options.browserCard) button.classList.add("media-browser-card");
  button.type = "button";
  button.dataset.mediaKey = mediaKey(item);
  if (isShowCard(item)) {
    button.dataset.showCard = "true";
  }
  if (isShowCard(item) || item.itemType === "episode-bundle") {
    button.dataset.seriesArtwork = "true";
  }
  if (item.showId) {
    button.dataset.showKey = `${item.mediaType}:${item.showId}`;
  }
  if (item.itemType === "season") {
    button.dataset.seasonCard = "true";
    button.dataset.seasonEpisodeIds = (item.seasonEpisodeIds || []).join(",");
    button.dataset.watchedEpisodeIds = (item.watchedEpisodeIds || []).join(",");
  }
  if (episode && Number.isFinite(Number(item.season))) {
    button.dataset.season = String(Number(item.season));
  }
  if (Array.isArray(item.bundledEpisodeIds)) {
    button.dataset.bundleEpisodeIds = item.bundledEpisodeIds.join(",");
    button.dataset.bundleTotalCount = String(item.bundledEpisodeIds.length);
  }
  if (Array.isArray(item.bundledWatchedEpisodeIds)) {
    button.dataset.watchedEpisodeIds = item.bundledWatchedEpisodeIds.join(",");
  }
  if (Number.isFinite(Number(item.newEpisodeCount))) {
    button.dataset.newEpisodeCount = String(Number(item.newEpisodeCount) || 0);
  }
  const watched = cardWatchedState(item);
  button.classList.toggle("watched-card", watched);
  const subtitleText = item.itemType === "episode-bundle" ? "" : item.subtitle || item.category;
  button.innerHTML = `
    <div class="poster">${initials(item.title)}</div>
    <div class="card-progress-slot">${progressBarHtml(item.progress)}</div>
    <div class="card-title">${escapeHtml(item.title)}</div>
    <div class="card-subtitle">${escapeHtml(subtitleText)}</div>
  `;
  const poster = button.querySelector(".poster");
  poster.classList.toggle("thumbnail-art", Boolean(showEpisodeThumbnail && item.thumbnailUrl));
  poster.classList.toggle("image-art", item.itemType === "image");
  poster.classList.toggle("image-folder-art", ["image-folder", "media-folder"].includes(item.itemType));
  poster.classList.toggle("playlist-art", item.itemType === "playlist");
  if (imageUrl) {
    setPosterImage(poster, imageUrl);
  }
  setWatchedMarker(poster, watched);
  setNewEpisodeMarker(poster, cardNewEpisodeCount(item));
  if (item.itemType === "season") {
    setSeasonProgressMarker(poster, item.watchedEpisodeIds.length, item.seasonEpisodeIds.length);
  }
  if (options.actionLabel) {
    const action = document.createElement("span");
    action.className = "media-browser-card-action";
    action.textContent = options.actionLabel;
    poster.appendChild(action);
  }
  button.addEventListener("click", () => {
    if (typeof options.onActivate === "function") {
      options.onActivate(item, button);
      return;
    }
    if (item.itemType === "season") {
      openSeasonView(item.mediaType, item.showId, item.season);
      return;
    }
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

async function openDetails(item, detailOptions = {}) {
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
  state.selectedPlaybackShuffle = detailOptions.shuffle && isShufflePlayableItem(item)
    ? createPlaybackShuffle(item, detailOptions.shuffleItems)
    : null;
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
  clearPosterImage(els.detailsPoster);
  els.detailsPoster.classList.toggle("thumbnail-art", Boolean(item.thumbnailUrl));
  els.detailsPoster.classList.toggle("image-preview", item.itemType === "image");
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

  if (state.libraryViewToken) {
    if (item.itemType === "image" && detailsImageUrl) {
      showImageViewer(detailsImageUrl, item.title);
    } else {
      loadMetadata(item);
    }
    els.filePath.value = "";
    updateDetailsAdminControls();
    return;
  }

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
  if (libraryKey) {
    section.dataset.libraryKey = libraryKey;
  }
  section.innerHTML = `
    <div class="section-heading">
      <h2>${escapeHtml(title)}</h2>
      <div class="section-actions">
        <span>${count}</span>
      </div>
    </div>
    <div class="rail"></div>
  `;
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
      hierarchyButton(item.albumArtist || item.artistName || "Artist", () => openArtistView(item.mediaType, item.artistId))
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

async function openSeasonView(mediaType, showId, seasonNumber, options = {}) {
  stopLibraryLoading();
  recordRoute(navigation.seasonPath(mediaType, showId, seasonNumber));
  const [show, seasonResponse] = await Promise.all([
    api(`${tvBasePath(mediaType)}/${showId}`),
    api(`${tvBasePath(mediaType)}/${showId}/seasons/${seasonNumber}`)
  ]);
  const seasonMetadata = (show.seasons || []).find((entry) => Number(entry.season) === Number(seasonNumber)) || {};
  const season = {
    ...seasonMetadata,
    ...seasonResponse,
    name: seasonMetadata.name || seasonResponse.name,
    overview: seasonMetadata.overview || seasonResponse.overview || "",
    posterUrl: seasonMetadata.posterUrl || seasonResponse.posterUrl || show.posterUrl || null,
    airDate: seasonMetadata.airDate || seasonResponse.airDate || null,
    year: seasonMetadata.year || seasonResponse.year || null
  };
  if (options.seasonArtworkVersion) {
    season.posterUrl = withCacheVersion(season.posterUrl, options.seasonArtworkVersion);
  }
  state.currentView = "season";
  closeDetails();
  const content = document.createDocumentFragment();
  content.appendChild(seriesSummary(show, season));
  const episodes = document.createElement("section");
  episodes.className = "season-episodes";
  episodes.innerHTML = `
    <div class="section-heading">
      <h2>Episodes</h2>
      <span>${season.episodes.length}</span>
    </div>
  `;
  episodes.appendChild(seasonGrid(mediaType, show, season));
  content.appendChild(episodes);
  showContentView({
    title: show.name,
    subtitle: season.name || defaultSeasonTitle(season.season),
    actions: [
      ...(hasPermission("canManageMetadata") ? [{ label: "Match show", onClick: () => rematchShowMetadata(mediaType, show) }] : []),
      ...(hasPermission("canManageMetadata") ? [{ label: "Edit poster", onClick: () => openSeriesPosterEditor(mediaType, show) }] : []),
      ...(hasPermission("canManageMetadata") ? [{ label: "Refresh season posters", onClick: (event) => refreshSeasonArtwork(mediaType, show, event.currentTarget, seasonNumber) }] : []),
      ...(state.user && !state.libraryViewToken ? [{ label: seasonWatchedActionLabel(season), onClick: (event) => markSeasonWatched(mediaType, show, season, event.currentTarget) }] : []),
      { label: "Show", onClick: () => openShowView(mediaType, showId) }
    ],
    content
  });
}

async function openShowView(mediaType, showId, options = {}) {
  stopLibraryLoading();
  recordRoute(navigation.showPath(mediaType, showId));
  const show = await api(`${tvBasePath(mediaType)}/${showId}`);
  if (options.seasonArtworkVersion) {
    for (const season of show.seasons || []) {
      season.posterUrl = withCacheVersion(season.posterUrl, options.seasonArtworkVersion);
    }
  }
  state.currentView = "show";
  closeDetails();
  const fragment = document.createDocumentFragment();
  fragment.appendChild(seriesSummary(show));
  fragment.appendChild(seasonBrowser(mediaType, show));
  showContentView({
    title: show.name,
    subtitle: `${show.seasons.length} seasons`,
    actions: [
      ...(hasPermission("canManageMetadata") ? [{ label: "Match show", onClick: () => rematchShowMetadata(mediaType, show) }] : []),
      ...(hasPermission("canManageMetadata") ? [{ label: "Edit poster", onClick: () => openSeriesPosterEditor(mediaType, show) }] : []),
      ...(hasPermission("canManageMetadata") ? [{ label: "Refresh season posters", onClick: (event) => refreshSeasonArtwork(mediaType, show, event.currentTarget) }] : []),
      { label: "Random episode", onClick: () => openRandomEpisode(mediaType, show) }
    ],
    content: fragment
  });
}

async function refreshSeasonArtwork(mediaType, show, button, seasonNumber = null) {
  button.disabled = true;
  button.textContent = "Refreshing...";
  try {
    const result = await api(`/api/catalog/${encodeURIComponent(mediaType)}/shows/${encodeURIComponent(show.id)}/metadata/season-posters/refresh`, state.token, { method: "POST" });
    const seasonArtworkVersion = result.refreshedAt || Date.now();
    if (seasonNumber === null) {
      await openShowView(mediaType, show.id, { seasonArtworkVersion });
    } else {
      await openSeasonView(mediaType, show.id, seasonNumber, { seasonArtworkVersion });
    }
  } catch (err) {
    button.disabled = false;
    button.textContent = "Refresh failed";
  }
}

function withCacheVersion(url, version) {
  if (!url) return url;
  const parsed = new URL(url, window.location.origin);
  parsed.searchParams.set("v", String(version));
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

function seriesSummary(show, season = null) {
  const selected = season || show;
  const title = season ? season.name || defaultSeasonTitle(season.season) : show.name;
  const posterUrl = season && season.posterUrl || show.posterUrl || null;
  const episodeCount = season
    ? (season.episodes || []).length
    : (show.seasons || []).reduce((total, entry) => total + (entry.episodes || []).length, 0);
  const facts = [
    selected.year || selected.releaseYear || null,
    season ? `${episodeCount} ${episodeCount === 1 ? "episode" : "episodes"}` : `${show.seasons.length} seasons`,
    !season ? `${episodeCount} episodes` : null
  ].filter(Boolean);
  const section = document.createElement("section");
  section.className = "series-summary";
  section.innerHTML = `
    <div class="series-summary-art">${escapeHtml(initials(title))}</div>
    <div class="series-summary-copy">
      <p class="series-summary-facts">${escapeHtml(facts.join(" | "))}</p>
      <p class="series-summary-overview">${escapeHtml((season ? season.overview : show.overview) || "No description is available.")}</p>
    </div>
  `;
  if (posterUrl) {
    setPosterImage(section.querySelector(".series-summary-art"), posterUrl);
  }
  return section;
}

function seasonBrowser(mediaType, show) {
  const section = document.createElement("section");
  section.className = "season-browser";
  section.innerHTML = `
    <div class="section-heading">
      <h2>Seasons</h2>
      <span>${show.seasons.length}</span>
    </div>
    <div class="season-grid"></div>
  `;
  const grid = section.querySelector(".season-grid");
  for (const season of show.seasons) {
    grid.appendChild(card(seasonItem(mediaType, show, season)));
  }
  return section;
}

function seasonItem(mediaType, show, season) {
  const episodeCount = (season.episodes || []).length;
  const watchedEpisodeIds = (season.episodes || [])
    .filter((episode) => isWatchedProgress(episode.progress))
    .map((episode) => episode.id);
  const metadata = [
    `${episodeCount} ${episodeCount === 1 ? "episode" : "episodes"}`,
    season.year || null
  ].filter(Boolean).join(" | ");
  return {
    id: `${show.id}:season:${season.season}`,
    itemType: "season",
    mediaType,
    showId: show.id,
    season: season.season,
    title: season.name || defaultSeasonTitle(season.season),
    subtitle: metadata,
    posterUrl: season.posterUrl || show.posterUrl || null,
    seasonEpisodeIds: (season.episodes || []).map((episode) => episode.id),
    watchedEpisodeIds,
    progress: seasonFullyWatched(season) ? { status: "watched", percent: 100 } : null
  };
}

function defaultSeasonTitle(seasonNumber) {
  return Number(seasonNumber) === 0 ? "Specials" : `Season ${seasonNumber}`;
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
      { label: "Artist", onClick: () => openArtistView(mediaType, artistId) }
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
    actions: [],
    content: fragment
  });
}

function openRandomEpisode(mediaType, show) {
  const episodes = (show.seasons || []).flatMap((season) => season.episodes || []);
  if (episodes.length === 0) {
    return;
  }

  const shuffleItems = episodes.map((episode) => episodeItem(mediaType, show, episode));
  const episode = shuffleItems[Math.floor(Math.random() * shuffleItems.length)];
  openDetails(episode, { shuffle: true, shuffleItems });
}

async function openRandomCollectionItem(mediaType, folder, button = null) {
  const originalLabel = button && button.textContent;
  if (button) {
    button.disabled = true;
    button.textContent = "Choosing...";
  }
  try {
    const params = new URLSearchParams({ folder });
    const response = await api(`/api/catalog/libraries/${encodeURIComponent(mediaType)}/random-item?${params.toString()}`);
    if (!response.item) {
      if (button) button.textContent = "No videos";
      return;
    }
    await openDetails(response.item, { shuffle: true });
  } catch (err) {
    if (button) button.textContent = "Try again";
  } finally {
    if (button) {
      window.setTimeout(() => {
        button.disabled = false;
        button.textContent = originalLabel;
      }, 1200);
    }
  }
}

function showContentView({ title, subtitle, actions, content }) {
  stopHomeRowLoading();
  hideLiveTvView();
  hideStreamQueuesView();
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

async function openLibraryView(libraryKey, title, folder = "", options = {}) {
  stopLibraryLoading();
  stopHomeRowLoading();
  closeDetails();
  recordRoute(navigation.libraryPath(libraryKey, folder), { state: { title } });

  const cacheKey = libraryViewCacheKey(libraryKey, folder);
  if (options.restore && restoreLibraryView(cacheKey)) {
    return;
  }
  libraryViewCache.delete(cacheKey);

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
      ...(folder && libraryKey === "yt-dlp" && !state.libraryViewToken
        ? [{ label: "Random video", onClick: (event) => openRandomCollectionItem(libraryKey, folder, event.currentTarget) }]
        : []),
      ...(folder ? [{ label: "Back", onClick: () => openLibraryView(libraryKey, state.libraryView && state.libraryView.title || title, parentFolderPath(folder), { restore: true }) }] : [])
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

  state.libraryView.header = view.header;
  state.libraryView.section = section;
  startLibraryObserver(state.libraryView);

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
    actions: [],
    content: section
  });
}

async function refreshIptvAvailability() {
  if (!state.token || state.libraryViewToken || !canAccessLiveTv()) {
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
  stopHomeRowLoading();
  closeDetails();
  hideStreamQueuesView();
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
  if (page === "optimizer" && !hasPermission("canManageOptimizer")) {
    page = firstAllowedAdminPage();
  }
  if (page === "skipDetection" && !hasPermission("canManageSettings")) {
    page = firstAllowedAdminPage();
  }
  if (page === "tasks" && !hasPermission("canViewTasks")) {
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
    optimizer: els.adminOptimizerPage,
    skipDetection: els.adminSkipDetectionPage,
    settings: els.adminSettingsPage,
    tasks: els.adminTasksPage,
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
  els.adminOptimizerTab.classList.toggle("hidden", !hasPermission("canManageOptimizer"));
  els.adminSkipDetectionTab.classList.toggle("hidden", !hasPermission("canManageSettings"));
  els.adminSettingsTab.classList.toggle("hidden", !hasPermission("canManageSettings"));
  els.adminTasksTab.classList.toggle("hidden", !hasPermission("canViewTasks"));
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
  } else if (page === "optimizer") {
    loadOptimizer();
    adminRefreshTimer = setInterval(() => loadOptimizer(false), 3000);
  } else if (page === "skipDetection") {
    loadSkipDetection(true);
    adminRefreshTimer = setInterval(() => loadSkipDetection(false), 2000);
  } else if (page === "settings") {
    loadSettings();
  } else if (page === "tasks") {
    loadTasks(true);
    adminRefreshTimer = setInterval(() => loadTasks(false), 2000);
  } else if (page === "hardware") {
    refreshHardware();
    adminRefreshTimer = setInterval(refreshHardware, 2000);
  } else if (page === "currentlyPlaying") {
    setCurrentlyPlayingAdminView(currentlyPlayingAdminView);
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
  if (hasPermission("canManageOptimizer")) return "optimizer";
  if (hasPermission("canManageSettings")) return "settings";
  if (hasPermission("canViewTasks")) return "tasks";
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

async function loadTasks(showLoading = false) {
  if (!hasPermission("canViewTasks")) return;
  if (taskRefreshInFlight) return;
  taskRefreshInFlight = true;
  if (showLoading && !taskSnapshot) {
    els.taskStatus.textContent = "Loading tasks...";
  }
  try {
    taskSnapshot = await api("/api/admin/tasks");
    const activeTaskIds = new Set((taskSnapshot.tasks || []).map((entry) => entry.id));
    for (const taskId of expandedTaskQueues) {
      if (!activeTaskIds.has(taskId)) {
        expandedTaskQueues.delete(taskId);
        taskQueuePages.delete(taskId);
      }
    }
    updateTaskTypeFilter(taskSnapshot.types || []);
    await Promise.all([...expandedTaskQueues].map((taskId) => {
      const cached = taskQueuePages.get(taskId);
      return loadTaskQueue(taskId, 0, Math.max(50, cached && cached.items.length || 0), false);
    }));
    els.taskStatus.textContent = "";
    renderTasks();
  } catch (err) {
    els.taskStatus.textContent = err.message || "Failed to load tasks.";
  } finally {
    taskRefreshInFlight = false;
  }
}

function updateTaskTypeFilter(types) {
  const selected = els.taskTypeFilter.value;
  const options = ['<option value="">All types</option>'];
  for (const type of types) {
    options.push(`<option value="${escapeHtml(type)}">${escapeHtml(taskTypeLabel(type))}</option>`);
  }
  els.taskTypeFilter.innerHTML = options.join("");
  if (types.includes(selected)) els.taskTypeFilter.value = selected;
}

function renderTasks() {
  if (!taskSnapshot) return;
  const summary = taskSnapshot.summary || {};
  els.taskRunningCount.textContent = summary.running || 0;
  els.taskQueuedCount.textContent = summary.queued || 0;
  els.taskFailedCount.textContent = summary.failed || 0;
  els.taskCompletedCount.textContent = summary.completed || 0;
  els.taskUpdatedAt.textContent = taskSnapshot.generatedAt
    ? `Updated ${new Date(taskSnapshot.generatedAt).toLocaleTimeString()}`
    : "";

  const stateFilter = els.taskStateFilter.value;
  const typeFilter = els.taskTypeFilter.value;
  const query = normaliseTaskSearch(els.taskSearchFilter.value);
  const tasks = (taskSnapshot.tasks || [])
    .filter((entry) => taskMatchesState(entry, stateFilter))
    .filter((entry) => !typeFilter || entry.type === typeFilter)
    .filter((entry) => !query || normaliseTaskSearch([
      entry.title,
      entry.subtitle,
      entry.phase,
      entry.filePath,
      entry.detail,
      entry.error
    ].filter(Boolean).join(" ")).includes(query))
    .sort(compareTasks);

  els.taskList.innerHTML = "";
  if (tasks.length === 0) {
    els.taskList.innerHTML = '<div class="task-empty">No tasks match these filters.</div>';
    return;
  }
  for (const entry of tasks) {
    els.taskList.appendChild(taskRow(entry));
  }
}

function taskRow(entry) {
  const element = document.createElement("section");
  element.className = `task-row state-${entry.state}`;
  const progress = entry.progress || {};
  const percent = progress.percent != null && Number.isFinite(Number(progress.percent))
    ? Math.round(Number(progress.percent) * 10) / 10
    : null;
  const queueTotal = Number(entry.queue && entry.queue.total) || 0;
  const expanded = expandedTaskQueues.has(entry.id);
  const queue = taskQueuePages.get(entry.id);
  const timing = [
    entry.startedAt ? `Started ${formatTimestamp(entry.startedAt)}` : null,
    progress.etaSeconds != null ? `About ${formatDuration(progress.etaSeconds)} remaining` : null
  ].filter(Boolean).join(" - ");
  const progressText = progress.current != null && progress.total != null
    ? `${Number(progress.current).toLocaleString()} / ${Number(progress.total).toLocaleString()}`
    : percent != null ? `${percent}%` : "";

  element.innerHTML = `
    <div class="task-row-heading">
      <div>
        <span class="task-type">${escapeHtml(taskTypeLabel(entry.type))}</span>
        <h3>${escapeHtml(entry.title)}</h3>
        ${entry.subtitle ? `<p>${escapeHtml(entry.subtitle)}</p>` : ""}
      </div>
      <span class="task-state">${escapeHtml(taskStateLabel(entry.state))}</span>
    </div>
    <div class="task-row-status">
      <strong>${escapeHtml(entry.phase || taskStateLabel(entry.state))}</strong>
      ${timing ? `<span>${escapeHtml(timing)}</span>` : ""}
    </div>
    ${percent != null ? `<div class="task-progress"><span style="width:${Math.max(0, Math.min(100, percent))}%"></span></div>` : ""}
    ${progressText || entry.detail ? `<div class="task-row-detail"><span>${escapeHtml(progressText)}</span><span>${escapeHtml(entry.detail || "")}</span></div>` : ""}
    ${entry.filePath ? `<code class="task-path">${escapeHtml(entry.filePath)}</code>` : ""}
    ${entry.error ? `<p class="task-error">${escapeHtml(entry.error)}</p>` : ""}
    ${queueTotal > 0 || expanded ? `<button class="secondary-button compact-button task-queue-toggle" type="button">${expanded ? "Hide queue" : `View queue (${queueTotal.toLocaleString()})`}</button>` : ""}
    ${expanded ? taskQueueMarkup(queue) : ""}
  `;
  const toggle = element.querySelector(".task-queue-toggle");
  if (toggle) toggle.addEventListener("click", () => toggleTaskQueue(entry.id));
  const more = element.querySelector(".task-queue-more");
  if (more) more.addEventListener("click", () => loadMoreTaskQueue(entry.id));
  return element;
}

function taskQueueMarkup(queue) {
  if (!queue) return '<div class="task-queue"><p class="status">Loading queue...</p></div>';
  if (queue.error) return `<div class="task-queue"><p class="task-error">${escapeHtml(queue.error)}</p></div>`;
  const rows = (queue.items || []).map((item) => `
    <div class="task-queue-item">
      <strong>${escapeHtml(item.title || item.id || "Queued item")}</strong>
      ${item.status ? `<span>${escapeHtml(item.status)}</span>` : ""}
      ${item.filePath ? `<code>${escapeHtml(item.filePath)}</code>` : ""}
    </div>
  `).join("");
  const loaded = (queue.items || []).length;
  return `
    <div class="task-queue">
      <div class="task-queue-heading"><strong>Queue</strong><span>${loaded.toLocaleString()} of ${Number(queue.total || 0).toLocaleString()}</span></div>
      ${rows || '<p class="status">No queued items.</p>'}
      ${loaded < Number(queue.total || 0) ? '<button class="secondary-button compact-button task-queue-more" type="button">Load more</button>' : ""}
    </div>
  `;
}

async function toggleTaskQueue(taskId) {
  if (expandedTaskQueues.has(taskId)) {
    expandedTaskQueues.delete(taskId);
    renderTasks();
    return;
  }
  expandedTaskQueues.add(taskId);
  renderTasks();
  await loadTaskQueue(taskId, 0, 50, true);
}

async function loadMoreTaskQueue(taskId) {
  const current = taskQueuePages.get(taskId) || { items: [] };
  await loadTaskQueue(taskId, current.items.length, 50, true);
}

async function loadTaskQueue(taskId, offset, limit, renderAfter) {
  try {
    const page = await api(`/api/admin/tasks/${encodeURIComponent(taskId)}/queue?offset=${offset}&limit=${limit}`);
    const previous = offset > 0 ? taskQueuePages.get(taskId) : null;
    taskQueuePages.set(taskId, {
      ...page,
      items: offset > 0 ? [...previous && previous.items || [], ...page.items || []] : page.items || []
    });
  } catch (err) {
    taskQueuePages.set(taskId, { total: 0, items: [], error: err.message || "Failed to load queue." });
  }
  if (renderAfter) renderTasks();
}

function taskMatchesState(entry, filter) {
  if (filter === "all") return true;
  if (filter === "active") return ["running", "starting", "queued", "failed"].includes(entry.state);
  if (filter === "running") return ["running", "starting"].includes(entry.state);
  return entry.state === filter;
}

function compareTasks(left, right) {
  const order = { running: 0, starting: 1, queued: 2, failed: 3, completed: 4, idle: 5 };
  const stateDifference = (order[left.state] ?? 9) - (order[right.state] ?? 9);
  if (stateDifference) return stateDifference;
  return String(right.updatedAt || right.startedAt || "").localeCompare(String(left.updatedAt || left.startedAt || ""));
}

function taskTypeLabel(type) {
  return ({
    index: "Indexing",
    metadata: "Metadata",
    keyframes: "Keyframes",
    optimiser: "Optimiser",
    "skip-detection": "Skip Detection",
    hls: "Streaming",
    "yt-dlp": "YT-DLP",
    "live-relay": "Live Relay",
    "live-tv": "Live TV",
    backup: "Backup",
    updates: "Updates"
  })[type] || String(type || "Task");
}

function taskStateLabel(stateValue) {
  return ({ running: "Running", starting: "Starting", queued: "Queued", failed: "Failed", completed: "Completed", idle: "Idle" })[stateValue] || stateValue;
}

function normaliseTaskSearch(value) {
  return String(value || "").trim().toLocaleLowerCase();
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
  els.accountCanStreamQueues.checked = Boolean(permissions.canManageStreamQueues);
  els.accountCanLibraries.checked = Boolean(permissions.canManageLibraries);
  els.accountCanMetadata.checked = Boolean(permissions.canManageMetadata);
  els.accountCanSettings.checked = Boolean(permissions.canManageSettings);
  els.accountCanApiKeys.checked = Boolean(permissions.canManageApiKeys);
  els.accountCanBackups.checked = Boolean(permissions.canManageBackups);
  els.accountCanOptimizer.checked = Boolean(permissions.canManageOptimizer);
  els.accountCanReindex.checked = Boolean(permissions.canReindex);
  els.accountCanUsers.checked = Boolean(permissions.canManageUsers);
  els.accountCanHardware.checked = Boolean(permissions.canViewHardware);
  els.accountCanTasks.checked = Boolean(permissions.canViewTasks);
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
  els.accountCanStreamQueues.checked = false;
  els.accountCanLibraries.checked = false;
  els.accountCanMetadata.checked = false;
  els.accountCanSettings.checked = false;
  els.accountCanApiKeys.checked = false;
  els.accountCanBackups.checked = false;
  els.accountCanOptimizer.checked = false;
  els.accountCanReindex.checked = false;
  els.accountCanUsers.checked = false;
  els.accountCanHardware.checked = false;
  els.accountCanTasks.checked = false;
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
    optimizer: els.adminOptimizerTab,
    skipDetection: els.adminSkipDetectionTab,
    tasks: els.adminTasksTab,
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
    || els.accountCanLibraries.checked
    || els.accountCanMetadata.checked
    || els.accountCanSettings.checked
    || els.accountCanApiKeys.checked
    || els.accountCanBackups.checked
    || els.accountCanOptimizer.checked
    || els.accountCanReindex.checked
    || els.accountCanUsers.checked
    || els.accountCanHardware.checked
    || els.accountCanTasks.checked
    || els.accountCanLogs.checked
    || els.accountCanHistory.checked;
  return {
    isAdmin: els.accountIsAdmin.checked,
    canCopyStreamUrls: els.accountCanCopyUrls.checked,
    canManageStreamQueues: els.accountCanStreamQueues.checked,
    canManageLibraries: els.accountCanLibraries.checked,
    canManageMetadata: els.accountCanMetadata.checked,
    canManageSettings: els.accountCanSettings.checked,
    canManageApiKeys: els.accountCanApiKeys.checked,
    canManageBackups: els.accountCanBackups.checked,
    canManageOptimizer: els.accountCanOptimizer.checked,
    canReindex: els.accountCanReindex.checked,
    canManageUsers: els.accountCanUsers.checked,
    canViewAdmin,
    canViewHardware: els.accountCanHardware.checked,
    canViewTasks: els.accountCanTasks.checked,
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
  els.libraryViewStatus.textContent = "Loading library view URLs...";
  els.apiKeyList.innerHTML = "";
  els.libraryViewList.innerHTML = "";
  els.apiKeySecretPanel.classList.add("hidden");
  els.libraryViewSecretPanel.classList.add("hidden");

  try {
    const [apiKeyData, libraryViewData] = await Promise.all([
      api("/api/admin/api-keys"),
      api("/api/admin/library-views")
    ]);
    fillSelect(els.apiKeyUserSelect, (apiKeyData.accounts || []).map((account) => ({
      id: account.id,
      label: account.username
    })));
    els.libraryViewLibraries.innerHTML = (libraryViewData.libraries || []).map((library) => `
      <label class="library-view-library-option">
        <input type="checkbox" value="${escapeHtml(library.key)}">
        <span>${escapeHtml(library.title)}</span>
      </label>
    `).join("");
    updateLibraryViewSelectionCount();
    els.apiKeyList.innerHTML = "";
    (apiKeyData.apiKeys || []).forEach((apiKey) => els.apiKeyList.appendChild(apiKeyCard(apiKey)));
    els.apiKeyStatus.textContent = (apiKeyData.apiKeys || []).length === 0 ? "No API keys created yet." : "";
    const libraryTitles = new Map((libraryViewData.libraries || []).map((library) => [library.key, library.title]));
    (libraryViewData.links || []).forEach((link) => els.libraryViewList.appendChild(libraryViewCard(link, libraryTitles)));
    els.libraryViewStatus.textContent = (libraryViewData.links || []).length === 0 ? "No library view URLs created yet." : "";
    updateLibraryViewExpiryControl();
  } catch (err) {
    els.apiKeyStatus.textContent = err.message || "Failed to load API keys.";
    els.libraryViewStatus.textContent = err.message || "Failed to load library view URLs.";
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

function libraryViewCard(link, libraryTitles) {
  const inactive = Boolean(link.revokedAt || link.expired);
  const cardElement = document.createElement("section");
  cardElement.className = `library-manager-card api-key-card${inactive ? " revoked" : ""}`;
  const libraries = (link.libraryKeys || []).map((key) => libraryTitles.get(key) || key).join(", ");
  const stateLabel = link.revokedAt
    ? `Revoked ${formatDate(link.revokedAt)}`
    : link.expired
      ? `Expired ${formatDate(link.expiresAt)}`
      : link.expiresAt
        ? `Expires ${formatDate(link.expiresAt)}`
        : "Never expires";
  cardElement.innerHTML = `
    <div class="library-manager-heading">
      <div>
        <h3>${escapeHtml(link.name)}</h3>
        <div class="library-path">${escapeHtml(libraries)} - ${escapeHtml(stateLabel)} - Created ${escapeHtml(formatDate(link.createdAt))}</div>
      </div>
      <div class="library-card-actions">
        ${link.url ? '<button class="secondary-button compact-button copy-library-view" type="button">Copy URL</button>' : ""}
        ${inactive ? "" : '<button class="secondary-button compact-button revoke-library-view" type="button">Revoke</button>'}
      </div>
    </div>
  `;
  const copyButton = cardElement.querySelector(".copy-library-view");
  if (copyButton) {
    copyButton.addEventListener("click", async () => {
      await copyText(link.url);
      els.libraryViewStatus.textContent = "Library view URL copied.";
    });
  }
  const revokeButton = cardElement.querySelector(".revoke-library-view");
  if (revokeButton) {
    revokeButton.addEventListener("click", () => revokeLibraryView(link));
  }
  return cardElement;
}

function updateLibraryViewExpiryControl() {
  const custom = els.libraryViewExpirySelect.value === "custom";
  els.libraryViewCustomExpiryLabel.classList.toggle("hidden", !custom);
  els.libraryViewCustomExpiryInput.required = custom;
  const minimum = new Date(Date.now() + 60 * 1000);
  els.libraryViewCustomExpiryInput.min = localDateTimeInputValue(minimum);
  if (custom && !els.libraryViewCustomExpiryInput.value) {
    els.libraryViewCustomExpiryInput.value = localDateTimeInputValue(new Date(Date.now() + 24 * 60 * 60 * 1000));
  }
}

function libraryViewExpiry() {
  const mode = els.libraryViewExpirySelect.value;
  if (mode === "unlimited") {
    return null;
  }
  if (mode === "custom") {
    const custom = new Date(els.libraryViewCustomExpiryInput.value);
    if (!els.libraryViewCustomExpiryInput.value || Number.isNaN(custom.getTime()) || custom.getTime() <= Date.now()) {
      throw new Error("Choose a future expiry date and time.");
    }
    return custom.toISOString();
  }
  const expiresAt = new Date();
  if (mode === "hour") expiresAt.setHours(expiresAt.getHours() + 1);
  if (mode === "day") expiresAt.setDate(expiresAt.getDate() + 1);
  if (mode === "week") expiresAt.setDate(expiresAt.getDate() + 7);
  if (mode === "month") expiresAt.setMonth(expiresAt.getMonth() + 1);
  return expiresAt.toISOString();
}

function localDateTimeInputValue(date) {
  const offset = date.getTimezoneOffset() * 60 * 1000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function updateLibraryViewSelectionCount() {
  const inputs = Array.from(els.libraryViewLibraries.querySelectorAll('input[type="checkbox"]'));
  const selected = inputs.filter((input) => input.checked).length;
  els.libraryViewSelectionCount.textContent = inputs.length > 0
    ? `${selected} of ${inputs.length} selected`
    : "No libraries available";
  els.libraryViewSelectAll.disabled = inputs.length === 0 || selected === inputs.length;
  els.libraryViewClearAll.disabled = selected === 0;
}

function setAllLibraryViewSelections(checked) {
  els.libraryViewLibraries.querySelectorAll('input[type="checkbox"]').forEach((input) => {
    input.checked = checked;
  });
  updateLibraryViewSelectionCount();
}

async function createLibraryView(event) {
  event.preventDefault();
  const name = els.libraryViewNameInput.value.trim();
  const libraryKeys = Array.from(els.libraryViewLibraries.querySelectorAll('input[type="checkbox"]:checked'))
    .map((input) => input.value);
  if (!name || libraryKeys.length === 0) {
    els.libraryViewStatus.textContent = "Enter a name and choose at least one library.";
    return;
  }

  let expiresAt;
  try {
    expiresAt = libraryViewExpiry();
  } catch (err) {
    els.libraryViewStatus.textContent = err.message;
    return;
  }

  els.createLibraryView.disabled = true;
  els.libraryViewStatus.textContent = "Creating library view URL...";
  try {
    const result = await api("/api/admin/library-views", state.token, {
      method: "POST",
      body: JSON.stringify({ name, libraryKeys, expiresAt })
    });
    const url = result.link && result.link.url;
    els.libraryViewNameInput.value = "";
    els.libraryViewLibraries.querySelectorAll('input[type="checkbox"]').forEach((input) => {
      input.checked = false;
    });
    updateLibraryViewSelectionCount();
    await loadApiKeys();
    if (url) {
      els.libraryViewSecretValue.textContent = url;
      els.libraryViewSecretPanel.classList.remove("hidden");
      await copyText(url);
      els.libraryViewStatus.textContent = "Library view URL created and copied.";
    }
  } catch (err) {
    els.libraryViewStatus.textContent = err.message || "Failed to create library view URL.";
  } finally {
    els.createLibraryView.disabled = false;
  }
}

async function copyNewLibraryViewUrl() {
  const url = els.libraryViewSecretValue.textContent;
  if (!url) return;
  await copyText(url);
  els.libraryViewStatus.textContent = "Library view URL copied.";
}

async function revokeLibraryView(link) {
  if (!window.confirm(`Revoke library view "${link.name}"?`)) {
    return;
  }
  els.libraryViewStatus.textContent = "Revoking library view URL...";
  try {
    await api(`/api/admin/library-views/${encodeURIComponent(link.id)}`, state.token, { method: "DELETE" });
    await loadApiKeys();
    els.libraryViewStatus.textContent = "Library view URL revoked.";
  } catch (err) {
    els.libraryViewStatus.textContent = err.message || "Failed to revoke library view URL.";
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

async function loadOptimizer(showLoading = true) {
  if (!hasPermission("canManageOptimizer")) return;
  if (showLoading) {
    els.optimizerStatus.textContent = "Loading optimiser...";
  }
  try {
    const data = await api("/api/admin/optimizer");
    if (showLoading) {
      renderOptimizer(data);
    }
    renderOptimizerWork(data);
    renderOptimizerFailures(data.failures || []);
    els.optimizerStatus.textContent = optimizerStatusText(data);
  } catch (err) {
    els.optimizerStatus.textContent = err.message || "Failed to load optimiser.";
  }
}

function renderOptimizer(data) {
  els.optimizerEnabled.checked = Boolean(data.enabled);
  els.optimizerScanInterval.value = String(Math.max(10, Number.parseInt(data.scanIntervalSeconds, 10) || 60));
  els.optimizerParallelJobs.value = String(Math.max(1, Math.min(Number.parseInt(data.parallelJobs, 10) || 1, 8)));
  els.optimizerLibraryList.innerHTML = "";
  renderOptimizerWork(data);
  renderOptimizerFailures(data.failures || []);
  const preferredAudioLanguage = String(data.preferredAudioLanguage || "English").trim() || "English";
  (data.libraries || []).forEach((library) => {
    const row = document.createElement("section");
    row.className = "library-manager-card optimizer-library-card";
    row.dataset.libraryKey = library.key;
    row.dataset.lastCheckedMs = String(Number(library.lastCheckedMs) || 0);
    row.innerHTML = `
      <div class="library-manager-heading">
        <div>
          <h3>${escapeHtml(library.title)}</h3>
          <p class="library-path">${escapeHtml(library.key)} - ${escapeHtml(library.type)}</p>
          <p class="library-path">${optimizerCheckpointText(library.lastCheckedMs)}</p>
        </div>
        <div class="optimizer-library-actions">
          <button class="secondary-button compact-button optimizer-library-full-scan" type="button">Check all files</button>
          <label class="settings-toggle"><input class="optimizer-library-enabled" type="checkbox"${library.enabled ? " checked" : ""}> Enabled</label>
        </div>
      </div>
      <div class="settings-grid optimizer-library-settings">
        ${optimizerAudioLanguagePicker(library, preferredAudioLanguage)}
        <label class="settings-toggle"><input class="optimizer-library-downmix" type="checkbox"${library.downmixToStereo ? " checked" : ""}> Downmix to stereo</label>
        <label class="settings-toggle"><input class="optimizer-library-preserve-hdr" type="checkbox"${library.preserveHdr ? " checked" : ""}> Preserve HDR</label>
        <label class="settings-toggle"><input class="optimizer-library-preserve-subtitles" type="checkbox"${library.preserveSubtitles ? " checked" : ""}> Preserve subtitles</label>
        <label class="settings-toggle"><input class="optimizer-library-all-day" type="checkbox"${library.allDay ? " checked" : ""}> Run all the time</label>
        <label>Start time<input class="optimizer-library-start" type="time" value="${escapeHtml(library.startTime || "01:00")}"></label>
        <label>End time<input class="optimizer-library-end" type="time" value="${escapeHtml(library.endTime || "06:00")}"></label>
      </div>
    `;
    els.optimizerLibraryList.appendChild(row);
  });
}

function handleOptimizerLibrarySettingChange(event) {
  if (!event.target.matches(".optimizer-library-additional-language")) return;
  const row = event.target.closest(".optimizer-library-card");
  updateOptimizerLanguageSummary(row);
}

function optimizerAudioLanguagePicker(library, preferredLanguage) {
  const preferredKey = optimizerLanguageKey(preferredLanguage);
  const selectedLanguages = Array.isArray(library.additionalAudioLanguages)
    ? library.additionalAudioLanguages.map((language) => String(language || "").trim()).filter(Boolean)
    : [];
  const selectedKeys = new Set(selectedLanguages.map(optimizerLanguageKey));
  const choices = [];
  const seen = new Set([preferredKey]);
  [...document.querySelectorAll("#languageOptions option")]
    .map((option) => String(option.value || "").trim())
    .concat(selectedLanguages)
    .forEach((language) => {
      const key = optimizerLanguageKey(language);
      if (!key || seen.has(key)) return;
      seen.add(key);
      choices.push(language);
    });
  const options = choices.map((language) => `
    <label class="optimizer-language-option">
      <input class="optimizer-library-additional-language" type="checkbox" data-language="${escapeHtml(language)}"${selectedKeys.has(optimizerLanguageKey(language)) ? " checked" : ""}>
      ${escapeHtml(language)}
    </label>
  `).join("");
  return `
    <div class="optimizer-language-field">
      <span>Audio languages</span>
      <details class="optimizer-language-picker" data-preferred-language="${escapeHtml(preferredLanguage)}">
        <summary>${escapeHtml(optimizerLanguageSummary(preferredLanguage, selectedLanguages.length))}</summary>
        <div class="optimizer-language-options">
          <label class="optimizer-language-option preferred">
            <input type="checkbox" checked disabled>
            ${escapeHtml(preferredLanguage)} (preferred)
          </label>
          ${options}
        </div>
      </details>
    </div>
  `;
}

function updateOptimizerLanguageSummary(row) {
  const picker = row && row.querySelector(".optimizer-language-picker");
  const summary = picker && picker.querySelector("summary");
  if (!summary) return;
  const count = picker.querySelectorAll(".optimizer-library-additional-language:checked").length;
  summary.textContent = optimizerLanguageSummary(picker.dataset.preferredLanguage, count);
}

function optimizerLanguageSummary(preferredLanguage, additionalCount) {
  const preferred = String(preferredLanguage || "English").trim() || "English";
  const count = Math.max(0, Number(additionalCount) || 0);
  return count > 0 ? `${preferred} + ${count} additional` : `${preferred} (preferred)`;
}

function optimizerLanguageKey(language) {
  return String(language || "").trim().toLowerCase();
}

function renderOptimizerWork(data) {
  const queue = data && data.queue || {};
  const currentJobs = Array.isArray(data && data.currentJobs) ? data.currentJobs : [];
  const pending = Number(queue.pending) || 0;
  const active = currentJobs.length || Number(queue.active) || 0;
  const completed = Number(queue.completed) || 0;
  const total = Number(queue.total) || 0;
  els.toggleOptimizerWork.textContent = active > 0 || pending > 0
    ? `Current work (${active} active, ${pending} queued)`
    : "Current work";
  els.optimizerQueueSummary.textContent = data && data.running
    ? `${queue.libraryTitle || "Optimiser"} - ${completed} complete, ${active} active, ${pending} queued, ${total} total`
    : "No optimiser work is currently running.";

  els.optimizerCurrentJobs.innerHTML = "";
  if (currentJobs.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = data && data.running ? "Preparing the next file..." : "No active optimiser jobs.";
    els.optimizerCurrentJobs.appendChild(empty);
  } else {
    currentJobs.forEach((job) => {
      els.optimizerCurrentJobs.appendChild(optimizerWorkCard(job, true));
    });
  }

  els.optimizerQueueList.innerHTML = "";
  const nextItems = Array.isArray(queue.next) ? queue.next : [];
  if (nextItems.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = pending > 0 ? `${pending} queued files not shown.` : "No queued files.";
    els.optimizerQueueList.appendChild(empty);
    return;
  }

  nextItems.forEach((item) => {
    els.optimizerQueueList.appendChild(optimizerWorkCard(item, false));
  });
  if (pending > nextItems.length) {
    const more = document.createElement("p");
    more.className = "empty-state";
    more.textContent = `${pending - nextItems.length} more queued files.`;
    els.optimizerQueueList.appendChild(more);
  }
}

function optimizerWorkCard(item, active) {
  const row = document.createElement("section");
  row.className = `library-manager-card optimizer-work-card${active ? " active" : ""}`;
  const percent = Math.max(0, Math.min(Number(item.percent) || 0, 100));
  const stagePercent = Math.max(0, Math.min(Number(item.stagePercent) || 0, 100));
  const stageIndex = Math.max(0, Number(item.stageIndex) || 0);
  const stageCount = Math.max(0, Number(item.stageCount) || 0);
  const remainingStages = Math.max(0, Number(item.remainingStages) || 0);
  const stageDetail = stageIndex > 0 && stageCount > 0
    ? `Stage ${stageIndex} of ${stageCount} - ${remainingStages} ${remainingStages === 1 ? "stage" : "stages"} remaining - ${stagePercent}% this stage`
    : "Preparing stages";
  row.innerHTML = `
    <div class="optimizer-work-art">${escapeHtml(initials(item.title || item.filePath || "MB"))}</div>
    <div class="optimizer-work-body">
      <div class="optimizer-work-heading">
        <h3>${escapeHtml(item.title || "Unknown file")}</h3>
        ${active ? `<span>${escapeHtml(percent > 0 ? `${percent}% overall` : "Starting")}</span>` : "<span>Queued</span>"}
      </div>
      ${active ? `<div class="optimizer-work-stage"><strong>${escapeHtml(item.stageLabel || "Preparing")}</strong><span>${escapeHtml(stageDetail)}</span></div>` : ""}
      <div class="optimizer-work-location">
        ${item.libraryTitle ? `<span>${escapeHtml(item.libraryTitle)}</span>` : ""}
        <span class="library-path">${escapeHtml(item.filePath || "")}</span>
      </div>
      ${active ? `<div class="progress-track" aria-hidden="true"><span class="progress-fill" style="--progress: ${percent}%"></span></div>` : ""}
    </div>
  `;
  const art = row.querySelector(".optimizer-work-art");
  if (item.artworkUrl) {
    setPosterImage(art, item.artworkUrl);
  }
  return row;
}

function renderOptimizerFailures(failures) {
  const items = Array.isArray(failures) ? failures : [];
  els.toggleOptimizerFailures.textContent = `Failures (${items.length})`;
  els.clearOptimizerFailures.disabled = items.length === 0;
  els.optimizerFailuresList.innerHTML = "";
  if (items.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No optimiser failures recorded.";
    els.optimizerFailuresList.appendChild(empty);
    return;
  }

  items.forEach((failure) => {
    const row = document.createElement("section");
    row.className = "library-manager-card optimizer-failure-card";
    row.innerHTML = `
      <div class="optimizer-failure-heading">
        <div>
          <h3>${escapeHtml(failure.title || "Unknown file")}</h3>
          <p class="library-path">${escapeHtml(failure.libraryTitle || failure.libraryKey || "Unknown library")}</p>
        </div>
        <span>${escapeHtml(formatTimestamp(failure.at))}</span>
      </div>
      <p class="optimizer-failure-message">${escapeHtml(failure.message || "Optimiser failed")}</p>
      <p class="library-path optimizer-failure-path">${escapeHtml(failure.filePath || "")}</p>
    `;
    els.optimizerFailuresList.appendChild(row);
  });
}

function formatTimestamp(value) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : "";
}

function toggleOptimizerWorkPanel() {
  els.optimizerWorkPanel.classList.toggle("hidden");
}

function toggleOptimizerFailuresPanel() {
  els.optimizerFailuresPanel.classList.toggle("hidden");
}

async function clearOptimizerFailures() {
  els.clearOptimizerFailures.disabled = true;
  els.optimizerStatus.textContent = "Queueing optimiser failures for retry...";
  try {
    const data = await api("/api/admin/optimizer/failures", state.token, { method: "DELETE" });
    renderOptimizerFailures(data.failures || []);
    const retryCount = Number(data.retryQueued) || 0;
    els.optimizerStatus.textContent = `${retryCount} optimiser failure${retryCount === 1 ? "" : "s"} queued for retry.`;
  } catch (err) {
    els.optimizerStatus.textContent = err.message || "Failed to queue optimiser failures for retry.";
    els.clearOptimizerFailures.disabled = false;
  }
}

function optimizerCheckpointText(value) {
  const timestamp = Number(value) || 0;
  return timestamp > 0
    ? `New-file scan since ${new Date(timestamp).toLocaleString()}`
    : "New-file scan has not run yet";
}

function optimizerStatusText(data) {
  const currentJobs = Array.isArray(data.currentJobs) ? data.currentJobs : [];
  const pending = Number(data.queue && data.queue.pending) || 0;
  const pendingFullScans = Array.isArray(data.pendingFullScans) ? data.pendingFullScans.length : 0;
  const fullScanSuffix = pendingFullScans > 0
    ? ` ${pendingFullScans} full library ${pendingFullScans === 1 ? "check is" : "checks are"} queued next.`
    : "";
  if (data.running && currentJobs.length > 1) {
    return `Optimising ${currentJobs.length} files; ${pending} more ${pending === 1 ? "file" : "files"} queued.${fullScanSuffix}`;
  }
  if (data.running && data.current) {
    const current = data.current;
    const percent = Number(current.percent) > 0 ? `, ${current.percent}% overall` : "";
    const stage = Number(current.stageIndex) > 0
      ? `${current.stageLabel || "Processing"} - stage ${current.stageIndex} of ${current.stageCount}, ${current.remainingStages} remaining${percent}`
      : "Preparing stages";
    return `Optimising ${current.title || current.filePath}: ${stage}; ${pending} more ${pending === 1 ? "file" : "files"} queued.${fullScanSuffix}`;
  }
  if (data.running) {
    return `Optimiser is running.${fullScanSuffix}`;
  }
  const retryQueued = Number(data.retryQueued) || 0;
  if (retryQueued > 0) {
    return `${retryQueued} failed ${retryQueued === 1 ? "file is" : "files are"} queued for the next optimiser run.`;
  }
  if (data.lastRun) {
    if (data.lastRun.message) {
      return `Last run ${data.lastRun.status}: ${data.lastRun.message}.`;
    }
    return `Last run ${data.lastRun.status}: ${data.lastRun.processed || 0} processed, ${data.lastRun.skipped || 0} skipped, ${data.lastRun.failed || 0} failed.`;
  }
  return data.enabled ? "Optimiser enabled." : "Optimiser disabled.";
}

async function loadSkipDetection(loadMarkers = false) {
  try {
    const data = await api("/api/admin/skip-detection");
    renderSkipDetection(data);
    if (loadMarkers) {
      await loadSkipDetectionMarkers();
    }
  } catch (err) {
    els.skipDetectionStatus.textContent = err.message || "Failed to load skip detection status.";
  }
}

function renderSkipDetection(data) {
  const totals = data.totals || {};
  const completed = data.completed || {};
  const checkpointed = data.checkpointed || completed;
  const markers = data.markers || {};
  const failures = Array.isArray(data.failures) ? data.failures : [];
  const totalEpisodes = Number(totals.episodes) || 0;
  const checkpointedEpisodes = Number(checkpointed.episodes) || 0;
  const percent = totalEpisodes > 0 ? Math.min(100, Math.round(checkpointedEpisodes / totalEpisodes * 100)) : 0;

  els.skipDetectionSeasonProgress.textContent = `${Number(checkpointed.seasons) || 0} / ${Number(totals.seasons) || 0}`;
  els.skipDetectionEpisodeProgress.textContent = `${checkpointedEpisodes} / ${totalEpisodes}`;
  els.skipDetectionCachedCount.textContent = String(Number(data.cachedEpisodes) || 0);
  els.skipDetectionMarkerCount.textContent = String((Number(markers.intros) || 0) + (Number(markers.credits) || 0));
  els.skipDetectionFailureCount.textContent = String(failures.length);
  els.skipDetectionProgressFill.style.setProperty("--progress", `${percent}%`);
  els.skipDetectionPhase.textContent = skipDetectionPhaseLabel(data.phase);
  els.skipDetectionCurrent.textContent = skipDetectionCurrentText(data);
  els.skipDetectionEta.textContent = data.running && Number(data.etaSeconds) > 0
    ? `About ${formatDuration(data.etaSeconds)} remaining`
    : "";
  els.skipDetectionStatus.textContent = skipDetectionStatusText(data);
  els.retrySkipDetectionFailures.disabled = failures.length === 0;
  els.reanalyseSkipDetection.disabled = data.running;
  els.rebuildSkipDetection.disabled = data.running;
  renderSkipDetectionFailures(failures);
}

function renderSkipDetectionFailures(failures) {
  els.skipDetectionFailures.innerHTML = "";
  if (failures.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No skip detection failures.";
    els.skipDetectionFailures.appendChild(empty);
    return;
  }

  failures.forEach((failure) => {
    const row = document.createElement("section");
    row.className = "library-manager-card skip-detection-failure-card";
    row.innerHTML = `
      <div class="library-manager-heading">
        <div>
          <h3>${escapeHtml(fileNameFromPath(failure.filePath) || failure.mediaId || "Unknown episode")}</h3>
          <p class="library-path">${escapeHtml(failure.mediaType || "")} - ${escapeHtml(formatTimestamp(failure.lastFailedAt))} - ${Number(failure.attempts) || 1} attempts</p>
        </div>
        <button class="secondary-button compact-button" type="button">Retry season</button>
      </div>
      <p class="optimizer-failure-message">${escapeHtml(failure.message || "Skip detection failed")}</p>
      <p class="library-path optimizer-failure-path">${escapeHtml(failure.filePath || "")}</p>
    `;
    row.querySelector("button").addEventListener("click", () => reanalyseSkipDetectionGroup(
      failure.mediaType,
      failure.groupId,
      false
    ));
    els.skipDetectionFailures.appendChild(row);
  });
}

async function loadSkipDetectionMarkers() {
  els.refreshSkipDetectionMarkers.disabled = true;
  try {
    const result = await api("/api/admin/skip-detection/markers?limit=400");
    renderSkipDetectionMarkers(result.items || []);
  } catch (err) {
    els.skipDetectionStatus.textContent = err.message || "Failed to load detected markers.";
  } finally {
    els.refreshSkipDetectionMarkers.disabled = false;
  }
}

function renderSkipDetectionMarkers(items) {
  els.skipDetectionMarkers.innerHTML = "";
  if (items.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No intro or credits markers have been detected yet.";
    els.skipDetectionMarkers.appendChild(empty);
    return;
  }

  items.forEach((review) => {
    const row = document.createElement("section");
    row.className = "library-manager-card skip-detection-marker-card";
    const heading = document.createElement("div");
    heading.className = "library-manager-heading";
    heading.innerHTML = `
      <div>
        <h3>${escapeHtml(review.item && review.item.title || review.markerId)}</h3>
        <p class="library-path">${escapeHtml(review.libraryTitle || review.mediaType)}${review.showName ? ` - ${escapeHtml(review.showName)} S${pad(review.season)}E${pad(review.episode)}` : ""}</p>
      </div>
      <button class="secondary-button compact-button" type="button">Reanalyse season</button>
    `;
    heading.querySelector("button").disabled = !review.groupId;
    heading.querySelector("button").addEventListener("click", () => reanalyseSkipDetectionGroup(
      review.mediaType,
      review.groupId,
      false
    ));
    const markerList = document.createElement("div");
    markerList.className = "skip-detection-marker-list";
    (review.markers || []).forEach((detectedMarker) => {
      const markerRow = document.createElement("div");
      markerRow.className = "skip-detection-marker-row";
      markerRow.innerHTML = `
        <div>
          <strong>${escapeHtml(detectedMarker.type === "credits" ? "Credits" : "Intro")}</strong>
          <span>${escapeHtml(formatDuration(detectedMarker.startSeconds))} - ${escapeHtml(formatDuration(detectedMarker.endSeconds))}</span>
        </div>
        <span>${Math.round((Number(detectedMarker.confidence) || 0) * 100)}% - ${escapeHtml(detectedMarker.source || "unknown")}</span>
      `;
      const preview = document.createElement("button");
      preview.className = "secondary-button compact-button";
      preview.type = "button";
      preview.textContent = "Preview";
      preview.disabled = !review.item;
      preview.addEventListener("click", () => previewSkipDetectionMarker(review, detectedMarker));
      markerRow.appendChild(preview);
      markerList.appendChild(markerRow);
    });
    row.append(heading, markerList);
    els.skipDetectionMarkers.appendChild(row);
  });
}

async function retrySkipDetectionFailures() {
  els.retrySkipDetectionFailures.disabled = true;
  els.skipDetectionStatus.textContent = "Queueing failed episodes...";
  try {
    const result = await api("/api/admin/skip-detection/retry-failures", state.token, {
      method: "POST",
      body: JSON.stringify({})
    });
    els.skipDetectionStatus.textContent = `${Number(result.count) || 0} failed episodes queued for another attempt.`;
    await loadSkipDetection(false);
  } catch (err) {
    els.skipDetectionStatus.textContent = err.message || "Failed to retry skip detection.";
  }
}

async function reanalyseSkipDetection(includeFingerprints) {
  const action = includeFingerprints
    ? "discard all cached fingerprints and analyse every TV episode again"
    : "recalculate all markers using the cached fingerprints";
  if (!window.confirm(`This will ${action}. Continue?`)) {
    return;
  }
  await reanalyseSkipDetectionGroup(null, null, includeFingerprints);
}

async function reanalyseSkipDetectionGroup(mediaType, groupId, includeFingerprints) {
  els.skipDetectionStatus.textContent = includeFingerprints
    ? "Queueing a complete fingerprint rebuild..."
    : "Queueing marker reanalysis...";
  try {
    await api("/api/admin/skip-detection/reanalyse", state.token, {
      method: "POST",
      body: JSON.stringify({ mediaType, groupId, includeFingerprints })
    });
    await loadSkipDetection(false);
  } catch (err) {
    els.skipDetectionStatus.textContent = err.message || "Failed to queue skip detection.";
  }
}

async function previewSkipDetectionMarker(review, detectedMarker) {
  if (!review.item) {
    return;
  }
  try {
    closeAdminPanel();
    await openDetails(review.item);
    const url = selectedStreamUrl({ surface: "web", includeProTv3d: false });
    if (!url) {
      return;
    }
    await openWebPlayer(url, {
      mediaType: review.item.mediaType,
      mediaId: review.item.id,
      category: review.item.category || "",
      title: `${review.item.title} - ${detectedMarker.type === "credits" ? "Credits" : "Intro"} preview`,
      resumeSeconds: Math.max(0, Number(detectedMarker.startSeconds) - 5),
      skipMarkers: [detectedMarker],
      errorMessage: "The marker preview could not be played.",
      fallbackUrl: fallbackWebPlayerUrl(),
      autoAdvance: false,
      hlsOptions: {
        lowLatencyMode: false,
        backBufferLength: 90
      }
    });
  } catch (err) {
    els.copyStatus.textContent = err.message || "The marker preview could not be opened.";
  }
}

function skipDetectionCurrentText(data) {
  const current = data.current;
  if (!current) {
    return data.running ? "Discovering TV seasons..." : "No analysis is running.";
  }
  const episode = current.episode
    ? `E${pad(current.episode)}${current.title ? ` ${current.title}` : ""}`
    : "";
  const location = `${current.libraryTitle || current.libraryKey} - ${current.showName} - Season ${current.season}${episode ? ` - ${episode}` : ""}`;
  return current.filePath ? `${location} - ${current.filePath}` : location;
}

function skipDetectionStatusText(data) {
  if (!data.enabled) {
    return "Skip detection is disabled in Settings.";
  }
  if (data.running) {
    return `Algorithm v${data.algorithmVersion} is running. ${Number(data.analysedEpisodes) || 0} episodes analysed and ${Number(data.cachedEpisodes) || 0} resumed from checkpoints.`;
  }
  if (data.lastError) {
    return `Last run stopped with an error: ${data.lastError}`;
  }
  if (data.finishedAt) {
    return `Last completed ${formatTimestamp(data.finishedAt)} using algorithm v${data.algorithmVersion}.`;
  }
  return `Algorithm v${data.algorithmVersion} is ready.`;
}

function skipDetectionPhaseLabel(value) {
  const phase = String(value || "idle").split(":")[0];
  const labels = {
    idle: "Idle",
    discovering: "Discovering seasons",
    "checking-season": "Checking season",
    "loading-checkpoint": "Loading checkpoint",
    probing: "Probing episode",
    "fingerprinting-head": "Fingerprinting opening",
    "fingerprinting-tail": "Fingerprinting ending",
    comparing: "Comparing episodes",
    saving: "Saving markers",
    complete: "Complete",
    cancelled: "Cancelled"
  };
  return labels[phase] || "Working";
}

function fileNameFromPath(value) {
  return String(value || "").split(/[\\/]/).pop();
}

async function saveOptimizerSettings(event) {
  event.preventDefault();
  els.optimizerStatus.textContent = "Saving optimiser settings...";
  try {
    const libraries = {};
    els.optimizerLibraryList.querySelectorAll(".optimizer-library-card").forEach((row) => {
      libraries[row.dataset.libraryKey] = {
        enabled: row.querySelector(".optimizer-library-enabled").checked,
        downmixToStereo: row.querySelector(".optimizer-library-downmix").checked,
        preserveHdr: row.querySelector(".optimizer-library-preserve-hdr").checked,
        preserveSubtitles: row.querySelector(".optimizer-library-preserve-subtitles").checked,
        additionalAudioLanguages: [...row.querySelectorAll(".optimizer-library-additional-language:checked")]
          .map((input) => input.dataset.language)
          .filter(Boolean),
        allDay: row.querySelector(".optimizer-library-all-day").checked,
        startTime: row.querySelector(".optimizer-library-start").value || "01:00",
        endTime: row.querySelector(".optimizer-library-end").value || "06:00",
        lastCheckedMs: Number(row.dataset.lastCheckedMs) || 0
      };
    });
    const data = await api("/api/admin/optimizer", state.token, {
      method: "PUT",
      body: JSON.stringify({
        enabled: els.optimizerEnabled.checked,
        scanIntervalSeconds: Number.parseInt(els.optimizerScanInterval.value, 10) || 60,
        parallelJobs: Number.parseInt(els.optimizerParallelJobs.value, 10) || 1,
        libraries
      })
    });
    renderOptimizer(data.status || {});
    els.optimizerStatus.textContent = "Optimiser settings saved.";
  } catch (err) {
    els.optimizerStatus.textContent = err.message || "Failed to save optimiser settings.";
  }
}

async function handleOptimizerLibraryAction(event) {
  const button = event.target.closest(".optimizer-library-full-scan");
  if (!button) {
    return;
  }

  const row = button.closest(".optimizer-library-card");
  const libraryKey = row && row.dataset.libraryKey;
  if (!libraryKey) {
    return;
  }

  button.disabled = true;
  els.optimizerStatus.textContent = "Starting full library check...";
  try {
    const data = await api(`/api/admin/optimizer/libraries/${encodeURIComponent(libraryKey)}/full-scan`, state.token, { method: "POST" });
    els.optimizerStatus.textContent = optimizerStatusText(data);
  } catch (err) {
    els.optimizerStatus.textContent = err.message || "Failed to start full library check.";
  } finally {
    button.disabled = false;
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
    els.backupStatus.textContent = "Backup validated. Media Baker is restarting to restore it...";
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
    fillSettingsForm(data.settings || {}, data.branding || null);
    updateSettingsVisibility();
    await Promise.all([refreshUpdateStatus(), refreshYtDlpAdminStatus()]);
    els.settingsStatus.textContent = "";
  } catch (err) {
    els.settingsStatus.textContent = err.message || "Failed to load settings.";
  }
}

function fillSettingsForm(settings, branding = null) {
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
  const skipDetection = settings.skipDetection || {};
  const openMovie = settings.openMovie || {};
  const brandingSettings = settings.branding || {};

  if (branding) {
    state.branding = branding;
    els.settingsAppIcon.innerHTML = (branding.options || [])
      .map((option) => `<option value="${escapeHtml(option.id)}">${escapeHtml(option.title)}</option>`)
      .join("");
    applyBranding(branding);
  }
  if (brandingSettings.icon && [...els.settingsAppIcon.options].some((option) => option.value === brandingSettings.icon)) {
    els.settingsAppIcon.value = brandingSettings.icon;
  }

  els.settingsLogLevel.value = logging.level || "info";
  els.settingsLogRetentionDays.value = logging.retentionDays ?? 5;
  els.settingsPreferredAudio.value = streaming.preferredAudioLanguage || "english";
  els.settingsEnableGpu.checked = ffmpeg.enableGpu !== false;
  els.settingsUpdatesEnabled.checked = updates.enabled !== false;
  els.settingsUpdateIntervalHours.value = Math.max(1, Math.round((updates.checkIntervalSeconds ?? 21600) / 3600));
  els.settingsIncludePrereleases.checked = Boolean(updates.includePrereleases);
  els.settingsAutoInstall.checked = Boolean(updates.autoInstall);
  els.settingsMetadataEnabled.checked = Boolean(metadata.enabled);
  const customMetadata = metadata.customService || {};
  setMetadataSource(metadata.source === "custom" ? "custom" : "providers", false);
  els.settingsCustomMetadataUrl.value = customMetadata.baseUrl || "";
  els.settingsCustomMetadataApiKey.value = customMetadata.apiKey || "";
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
  els.settingsYtDlpSubscriptionHours.value = Math.max(1, Math.round((ytdlp.subscriptionCheckIntervalSeconds ?? 86400) / 3600));
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
  els.settingsHlsMinimumFreeSpace.value = hls.minimumFreeSpaceMiB ?? 1024;
  els.settingsForceTranscode.checked = Boolean(hls.forceTranscodeCompatibleVideo);
  els.settingsOnDeckExpirationDays.value = Math.max(1, Math.round((playback.onDeckTtlSeconds ?? 1209600) / 86400));
  els.settingsWatchedThreshold.value = playback.watchedThresholdPercent ?? 10;
  els.settingsSkipDetectionEnabled.checked = Boolean(skipDetection.enabled);
  els.settingsOpenMovieEnabled.checked = Boolean(openMovie.enabled);
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
    fillSettingsForm(result.settings || {}, result.branding || null);
    applyFeatures({
      iptv: Boolean(result.settings && result.settings.iptv && result.settings.iptv.enabled),
      ytdlp: Boolean(result.settings && result.settings.ytdlp && result.settings.ytdlp.enabled)
    });
    updateSettingsVisibility();
    await refreshIptvAvailability();
    await refreshSystemHealth();
    await refreshUpdateStatus();
    await refreshYtDlpAdminStatus();
    els.settingsStatus.textContent = "Settings saved.";
  } catch (err) {
    els.settingsStatus.textContent = err.message || "Failed to save settings.";
  } finally {
    els.saveSettings.disabled = false;
  }
}

async function refreshYtDlpAdminStatus() {
  if (!hasPermission("canManageSettings")) return;
  try {
    const result = await api("/api/admin/ytdlp");
    renderYtDlpAdminStatus(result.status || {});
  } catch (err) {
    state.ytdlpAdminStatus = null;
    els.settingsYtDlpStatus.textContent = err.message || "Could not load YT-DLP status.";
    els.settingsYtDlpUpdate.disabled = true;
    els.settingsYtDlpRemoveCookies.disabled = true;
  }
}

function renderYtDlpAdminStatus(status) {
  state.ytdlpAdminStatus = status;
  const cookies = status.cookies || {};
  const version = status.validation && status.validation.version;
  const details = [];
  if (version) details.push(`YT-DLP ${version}.`);
  if (cookies.configured) {
    details.push(`${cookies.cookieCount || 0} YouTube cookie${cookies.cookieCount === 1 ? "" : "s"} installed${cookies.updatedAt ? ` (${formatDate(cookies.updatedAt)})` : ""}.`);
  } else {
    details.push("No YouTube cookies installed.");
  }
  if (status.lastUpdateError) {
    details.push(`Last update failed: ${status.lastUpdateError}`);
  } else if (status.lastUpdateMessage) {
    details.push(status.lastUpdateMessage);
  }
  els.settingsYtDlpStatus.textContent = details.join(" ");
  els.settingsYtDlpUpdate.disabled = !status.enabled || !status.available || Boolean(status.updating);
  els.settingsYtDlpRemoveCookies.disabled = !cookies.configured;
  els.settingsYtDlpAddSubscription.disabled = !status.enabled || !status.available || Boolean(status.checkingSubscriptions);
  renderYtDlpSubscriptions(status.subscriptions || []);
}

function renderYtDlpSubscriptions(subscriptions) {
  if (subscriptions.length === 0) {
    els.settingsYtDlpSubscriptions.innerHTML = '<p class="empty-state">No channel subscriptions.</p>';
    return;
  }
  els.settingsYtDlpSubscriptions.innerHTML = subscriptions.map((subscription) => {
    const activity = subscription.lastError
      ? `<span class="ytdlp-subscription-error">Last check failed: ${escapeHtml(subscription.lastError)}</span>`
      : subscription.lastDownloadedAt
        ? `<span>Last new video: ${escapeHtml(formatDate(subscription.lastDownloadedAt))}</span>`
        : subscription.lastCheckedAt
          ? `<span>Last checked: ${escapeHtml(formatDate(subscription.lastCheckedAt))}</span>`
          : "<span>Waiting for the first check.</span>";
    return `
      <div class="ytdlp-subscription-row">
        <div class="ytdlp-subscription-details">
          <strong>${escapeHtml(subscription.title)}</strong>
          <span>${escapeHtml(subscription.folderName)}</span>
          ${activity}
        </div>
        <button class="secondary-button" type="button" data-remove-ytdlp-subscription="${escapeHtml(subscription.id)}">Remove</button>
      </div>`;
  }).join("");
}

async function addYtDlpSubscription() {
  const url = els.settingsYtDlpSubscriptionUrl.value.trim();
  if (!url) return;
  els.settingsYtDlpAddSubscription.disabled = true;
  els.settingsYtDlpSubscriptionStatus.textContent = "Adding channel and starting its full download...";
  try {
    const result = await api("/api/admin/ytdlp/subscriptions", state.token, {
      method: "POST",
      body: JSON.stringify({ url })
    });
    els.settingsYtDlpSubscriptionUrl.value = "";
    els.settingsYtDlpSubscriptionStatus.textContent = `${result.subscription.title} added. Existing videos are downloading.`;
    renderYtDlpAdminStatus(result.status || {});
  } catch (err) {
    els.settingsYtDlpSubscriptionStatus.textContent = err.message || "Could not add the channel.";
    els.settingsYtDlpAddSubscription.disabled = false;
  }
}

async function removeYtDlpSubscription(id) {
  const subscription = (state.ytdlpAdminStatus && state.ytdlpAdminStatus.subscriptions || [])
    .find((entry) => entry.id === id);
  if (!subscription || !window.confirm(`Stop downloading new videos from ${subscription.title}? Downloaded files will be kept.`)) return;
  els.settingsYtDlpSubscriptionStatus.textContent = `Removing ${subscription.title}...`;
  try {
    const result = await api(`/api/admin/ytdlp/subscriptions/${encodeURIComponent(id)}`, state.token, { method: "DELETE" });
    els.settingsYtDlpSubscriptionStatus.textContent = `${subscription.title} removed.`;
    renderYtDlpAdminStatus(result.status || {});
  } catch (err) {
    els.settingsYtDlpSubscriptionStatus.textContent = err.message || "Could not remove the channel.";
  }
}

async function forceYtDlpUpdate() {
  els.settingsYtDlpUpdate.disabled = true;
  els.settingsYtDlpStatus.textContent = "Updating YT-DLP...";
  try {
    const result = await api("/api/admin/ytdlp/update", state.token, { method: "POST" });
    renderYtDlpAdminStatus(result.status || {});
  } catch (err) {
    els.settingsYtDlpStatus.textContent = err.message || "YT-DLP update failed.";
    els.settingsYtDlpUpdate.disabled = false;
  }
}

function openYtDlpCookieGuide() {
  els.ytdlpCookieGuideOverlay.classList.remove("hidden");
  els.ytdlpCookieGuideOverlay.setAttribute("aria-hidden", "false");
  els.closeYtDlpCookieGuideIcon.focus({ preventScroll: true });
}

function closeYtDlpCookieGuide() {
  els.ytdlpCookieGuideOverlay.classList.add("hidden");
  els.ytdlpCookieGuideOverlay.setAttribute("aria-hidden", "true");
  els.settingsYtDlpCookieHelp.focus({ preventScroll: true });
}

async function uploadYtDlpCookies(event) {
  const file = event.target.files && event.target.files[0];
  event.target.value = "";
  if (!file) return;
  els.settingsYtDlpUploadCookies.disabled = true;
  els.settingsYtDlpStatus.textContent = "Reading YouTube cookies...";
  try {
    if (file.size > 10 * 1024 * 1024) {
      throw new Error("The selected cookies file is too large.");
    }
    const contents = youtubeCookiesForUpload(await file.text());
    const result = await api("/api/admin/ytdlp/cookies", state.token, {
      method: "PUT",
      body: JSON.stringify({ contents })
    });
    renderYtDlpAdminStatus({
      ...(state.ytdlpAdminStatus || {}),
      cookies: result.cookies
    });
  } catch (err) {
    els.settingsYtDlpStatus.textContent = err.message || "Could not install the cookie file.";
  } finally {
    els.settingsYtDlpUploadCookies.disabled = false;
  }
}

async function removeYtDlpCookies() {
  if (!window.confirm("Remove the stored YouTube cookies?")) return;
  els.settingsYtDlpRemoveCookies.disabled = true;
  els.settingsYtDlpStatus.textContent = "Removing YouTube cookies...";
  try {
    const result = await api("/api/admin/ytdlp/cookies", state.token, { method: "DELETE" });
    renderYtDlpAdminStatus({
      ...(state.ytdlpAdminStatus || {}),
      cookies: result.cookies
    });
  } catch (err) {
    els.settingsYtDlpStatus.textContent = err.message || "Could not remove the cookie file.";
    els.settingsYtDlpRemoveCookies.disabled = false;
  }
}

function youtubeCookiesForUpload(contents) {
  const lines = String(contents || "").replace(/^\uFEFF/, "").split(/\r?\n/);
  const header = lines.find((line) => /^# (?:Netscape HTTP|HTTP) Cookie File\b/i.test(line.trim()));
  const cookies = lines.filter((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") && !trimmed.startsWith("#HttpOnly_")) return false;
    const fields = trimmed.split("\t");
    if (fields.length < 7) return false;
    const domain = fields[0].replace("#HttpOnly_", "").replace(/^\./, "").toLowerCase();
    return domain === "youtube.com" || domain.endsWith(".youtube.com");
  });
  if (!header) throw new Error("Select a Netscape-format cookies.txt file.");
  if (cookies.length === 0) throw new Error("The selected file does not contain YouTube cookies.");
  return `${header.trim()}\n${cookies.join("\n")}\n`;
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
        if (window.MediaBakerPwa && typeof window.MediaBakerPwa.reloadForUpdate === "function") {
          await window.MediaBakerPwa.reloadForUpdate();
        } else {
          window.location.reload();
        }
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
    branding: {
      icon: els.settingsAppIcon.value
    },
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
      source: metadataSource(),
      provider: "tmdb",
      tmdbApiKey: els.settingsTmdbApiKey.value.trim(),
      tmdbReadAccessToken: els.settingsTmdbReadToken.value.trim(),
      language: els.settingsMetadataLanguage.value.trim(),
      posterSize: els.settingsPosterSize.value.trim(),
      thumbnailSize: els.settingsThumbnailSize.value.trim(),
      posterLanguages: els.settingsPosterLanguages.value.split(",").map((item) => item.trim()).filter(Boolean),
      preloadOnStartup: els.settingsMetadataPreload.checked,
      requestDelayMs: intInput(els.settingsMetadataDelay, 250, 0),
      customService: {
        baseUrl: els.settingsCustomMetadataUrl.value.trim(),
        apiKey: els.settingsCustomMetadataApiKey.value.trim()
      }
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
      allowPlaylists: els.settingsYtDlpPlaylists.checked,
      subscriptionCheckIntervalSeconds: intInput(els.settingsYtDlpSubscriptionHours, 24, 1) * 3600
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
      onDeckTtlSeconds: intInput(els.settingsOnDeckExpirationDays, 14, 1) * 86400,
      watchedThresholdPercent: intInput(els.settingsWatchedThreshold, 10)
    },
    skipDetection: {
      enabled: els.settingsSkipDetectionEnabled.checked
    },
    openMovie: {
      enabled: els.settingsOpenMovieEnabled.checked
    },
    hls: {
      ttlSeconds: intInput(els.settingsHlsTtl, 86400),
      segmentSeconds: intInput(els.settingsHlsSegment, 6),
      segmentWaitTimeoutSeconds: intInput(els.settingsHlsWait, 90),
      minimumFreeSpaceMiB: intInput(els.settingsHlsMinimumFreeSpace, 1024, 0),
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

function applyBranding(branding) {
  if (!branding || !branding.urls) return;
  const interfaceUrl = branding.urls.interface || branding.urls.favicon;
  if (interfaceUrl) {
    document.querySelectorAll(".brand-mark, .login-mark").forEach((image) => {
      image.src = interfaceUrl;
    });
  }

  const favicon = document.querySelector('link[rel="icon"]');
  if (favicon && branding.urls.favicon) favicon.href = branding.urls.favicon;
  const appleTouchIcon = document.querySelector('link[rel="apple-touch-icon"]');
  if (appleTouchIcon && branding.urls.appleTouch) appleTouchIcon.href = branding.urls.appleTouch;
  const manifest = document.querySelector('link[rel="manifest"]');
  if (manifest && branding.revision) {
    manifest.href = `/manifest.webmanifest?icon=${encodeURIComponent(branding.revision)}`;
  }
}

function updateSettingsVisibility() {
  els.updatesSettingsFieldset.classList.toggle("hidden", !isAdminMode());
  setFeatureVisible(els.updateSettingsBody, els.settingsUpdatesEnabled.checked);
  setFeatureVisible(els.metadataSettingsBody, els.settingsMetadataEnabled.checked);
  const customMetadataActive = metadataSource() === "custom";
  setFeatureVisible(els.customMetadataSettings, customMetadataActive);
  setFeatureVisible(els.providerMetadataSettings, !customMetadataActive);
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

function setMetadataSource(source, refresh = true) {
  const custom = source === "custom";
  els.settingsMetadataProvidersMode.classList.toggle("active", !custom);
  els.settingsMetadataProvidersMode.setAttribute("aria-pressed", String(!custom));
  els.settingsMetadataCustomMode.classList.toggle("active", custom);
  els.settingsMetadataCustomMode.setAttribute("aria-pressed", String(custom));
  if (refresh) updateSettingsVisibility();
}

function metadataSource() {
  return els.settingsMetadataCustomMode.classList.contains("active") ? "custom" : "providers";
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
  if (!state.user || state.libraryViewToken) {
    return;
  }
  els.selfAccountUsername.value = state.user.username || "";
  els.selfAccountCurrentPassword.value = "";
  els.selfAccountNewPassword.value = "";
  els.selfAccountConfirmPassword.value = "";
  setAccountThemeControls(state.user.preferences && state.user.preferences.themeColour);
  els.selfAccountStatus.textContent = "";
  els.accountOverlay.classList.remove("hidden");
  els.accountOverlay.setAttribute("aria-hidden", "false");
}

function closeAccountPanel() {
  applyThemeColour(state.user && state.user.preferences && state.user.preferences.themeColour);
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
  const accountDetailsChanged = username !== state.user.username || Boolean(password);
  if (!username) {
    els.selfAccountStatus.textContent = "Username is required.";
    return;
  }
  if (accountDetailsChanged && !currentPassword) {
    els.selfAccountStatus.textContent = "Current password is required when changing the username or password.";
    return;
  }
  if (password !== els.selfAccountConfirmPassword.value) {
    els.selfAccountStatus.textContent = "The new passwords do not match.";
    return;
  }

  els.saveSelfAccount.disabled = true;
  els.selfAccountStatus.textContent = "Saving account...";
  try {
    if (accountDetailsChanged) {
      const result = await api("/api/auth/me", state.token, {
        method: "PUT",
        body: JSON.stringify({ username, currentPassword, password })
      });
      state.user = result.user;
      if (result.token) {
        state.token = result.token;
        localStorage.setItem("streamToken", result.token);
      }
    }

    const preferences = normalizePlaybackPreferences({
      ...state.playbackPreferences,
      themeColour: els.selfAccountThemeColour.value
    });
    window.clearTimeout(savePlaybackPreferencesTimer);
    const preferenceResult = await api("/api/auth/me/preferences", state.token, {
      method: "PUT",
      body: JSON.stringify({ preferences })
    });
    state.user = preferenceResult.user;
    setPlaybackPreferences(preferenceResult.preferences);
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

function previewThemePreset() {
  const selected = els.selfAccountThemePreset.value;
  if (selected === "custom") {
    openThemeColourPicker();
    return;
  }
  setAccountThemeControls(selected);
  applyThemeColour(selected);
}

function openThemeColourPicker() {
  if (typeof els.selfAccountThemeColour.showPicker === "function") {
    try {
      els.selfAccountThemeColour.showPicker();
      return;
    } catch (err) {
      // The click fallback covers browsers that expose but restrict showPicker().
    }
  }
  els.selfAccountThemeColour.click();
}

function previewCustomThemeColour() {
  const colour = normalizeThemeColour(els.selfAccountThemeColour.value);
  setAccountThemeControls(colour, true);
  applyThemeColour(colour);
}

function setAccountThemeControls(value, forceCustom = false) {
  const colour = normalizeThemeColour(value);
  els.selfAccountThemeColour.value = colour;
  els.selfAccountThemePreset.value = !forceCustom && THEME_PRESET_COLOURS.has(colour) ? colour : "custom";
  els.themeColourSwatch.style.backgroundColor = colour;
  els.themeColourValue.textContent = colour.toUpperCase();
}

async function openDownloadPanel() {
  els.downloadOverlay.classList.remove("hidden");
  els.downloadOverlay.setAttribute("aria-hidden", "false");
  els.downloadStatus.textContent = "";
  clearYtDlpDownloadChoice();
  await refreshYtDlpDownloads();
  startDownloadRefresh();
}

function closeDownloadPanel() {
  els.downloadOverlay.classList.add("hidden");
  els.downloadOverlay.setAttribute("aria-hidden", "true");
  clearYtDlpDownloadChoice();
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
  clearYtDlpDownloadChoice();
  els.downloadStatus.textContent = "Checking URL...";
  try {
    const result = await api("/api/ytdlp/inspect", state.token, {
      method: "POST",
      body: JSON.stringify({ url })
    });
    if (result.media && result.media.isChannel) {
      pendingChannelDownload = result.media;
      els.channelDownloadTitle.textContent = result.media.title || url;
      els.channelDownloadChoice.classList.remove("hidden");
      els.downloadStatus.textContent = "Choose whether to download once or subscribe.";
      return;
    }
    if (result.media && result.media.isLive) {
      pendingLiveDownload = result.media;
      els.liveDownloadTitle.textContent = result.media.title || url;
      els.liveDownloadChoice.classList.remove("hidden");
      els.downloadStatus.textContent = "Choose how to handle this live stream.";
      return;
    }
    await queueYtDlpDownload(url, "download");
  } catch (err) {
    els.downloadStatus.textContent = err.message || "Failed to inspect the URL.";
  } finally {
    els.startDownload.disabled = false;
  }
}

async function downloadYtDlpChannel() {
  if (!pendingChannelDownload) return;
  setChannelChoiceDisabled(true);
  els.downloadStatus.textContent = "Starting full channel download...";
  try {
    await queueYtDlpDownload(pendingChannelDownload.url, "channel-download");
    clearYtDlpDownloadChoice();
  } catch (err) {
    els.downloadStatus.textContent = err.message || "Failed to start the channel download.";
  } finally {
    setChannelChoiceDisabled(false);
  }
}

async function subscribeYtDlpChannel() {
  if (!pendingChannelDownload) return;
  setChannelChoiceDisabled(true);
  els.downloadStatus.textContent = "Subscribing and starting full channel download...";
  try {
    await queueYtDlpDownload(pendingChannelDownload.url, "channel-subscribe");
    clearYtDlpDownloadChoice();
  } catch (err) {
    els.downloadStatus.textContent = err.message || "Failed to subscribe to the channel.";
  } finally {
    setChannelChoiceDisabled(false);
  }
}

async function recordYtDlpLiveStream() {
  if (!pendingLiveDownload) return;
  setLiveChoiceDisabled(true);
  els.downloadStatus.textContent = "Starting live recording...";
  try {
    await queueYtDlpDownload(pendingLiveDownload.url, "record");
    clearYtDlpDownloadChoice();
  } catch (err) {
    els.downloadStatus.textContent = err.message || "Failed to start the live recording.";
  } finally {
    setLiveChoiceDisabled(false);
  }
}

async function relayYtDlpLiveStream() {
  if (!pendingLiveDownload) return;
  const media = pendingLiveDownload;
  setLiveChoiceDisabled(true);
  els.downloadStatus.textContent = "Starting live relay...";
  try {
    const result = await api("/api/ytdlp/relays", state.token, {
      method: "POST",
      body: JSON.stringify({ url: media.url })
    });
    pendingLiveRelay = result.relay;
    els.liveDownloadChoice.classList.add("hidden");
    els.liveRelayTitle.textContent = result.relay.title || media.title || "Live stream";
    els.liveRelayReady.classList.remove("hidden");
    els.copyLiveRelay.classList.toggle("hidden", !hasPermission("canCopyStreamUrls"));
    els.downloadStatus.textContent = "Live relay is ready.";
  } catch (err) {
    els.downloadStatus.textContent = err.message || "Failed to start the live relay.";
  } finally {
    setLiveChoiceDisabled(false);
  }
}

async function playYtDlpLiveRelay() {
  if (!pendingLiveRelay) return;
  const relay = pendingLiveRelay;
  const auth = authQuery();
  const url = new URL(`/api/ytdlp/relays/${encodeURIComponent(relay.id)}/master.m3u8`, window.location.origin);
  url.searchParams.set(auth.name, auth.value);
  closeDownloadPanel();
  await openWebPlayer(url, {
    category: "Live relay",
    title: relay.title || "Live stream",
    live: true,
    errorMessage: "The live relay could not be played.",
    fallbackUrl: fallbackWebPlayerUrl(),
    hlsOptions: {
      lowLatencyMode: false,
      manifestLoadingTimeOut: 35000,
      manifestLoadingMaxRetry: 6,
      fragLoadingMaxRetry: 6,
      backBufferLength: 90,
      maxBufferLength: 60,
      liveSyncDurationCount: 3,
      liveMaxLatencyDurationCount: 10
    }
  });
}

async function copyYtDlpLiveRelay() {
  if (!pendingLiveRelay || !hasPermission("canCopyStreamUrls")) return;
  els.copyLiveRelay.disabled = true;
  els.downloadStatus.textContent = "Creating relay URL...";
  try {
    const result = await api(`/api/ytdlp/relays/${encodeURIComponent(pendingLiveRelay.id)}/copy-token`, state.token, {
      method: "POST"
    });
    try {
      await writeClipboard(result.url);
      hideRelayManualCopyUrl();
      els.downloadStatus.textContent = "Copied relay URL.";
    } catch (err) {
      showRelayManualCopyUrl(result.url);
      els.downloadStatus.textContent = "Clipboard access failed.";
    }
  } catch (err) {
    els.downloadStatus.textContent = err.message || "Could not create a relay URL.";
  } finally {
    els.copyLiveRelay.disabled = false;
  }
}

async function queueYtDlpDownload(url, mode) {
  const result = await api("/api/ytdlp/downloads", state.token, {
    method: "POST",
    body: JSON.stringify({ url, mode })
  });
  if (result.download && result.download.id) {
    downloadStatuses.set(result.download.id, result.download.status);
  }
  els.downloadUrlInput.value = "";
  els.downloadStatus.textContent = mode === "record"
    ? "Live recording started."
    : mode === "channel-subscribe"
      ? "Channel subscribed. Downloading existing videos now."
      : mode === "channel-download"
        ? "Channel download started."
        : "Download started.";
  await refreshYtDlpDownloads();
  startDownloadRefresh();
}

function clearYtDlpDownloadChoice() {
  pendingChannelDownload = null;
  pendingLiveDownload = null;
  pendingLiveRelay = null;
  els.channelDownloadChoice.classList.add("hidden");
  els.liveDownloadChoice.classList.add("hidden");
  els.liveRelayReady.classList.add("hidden");
  els.channelDownloadTitle.textContent = "";
  els.liveDownloadTitle.textContent = "";
  els.liveRelayTitle.textContent = "";
  hideRelayManualCopyUrl();
  setLiveChoiceDisabled(false);
  setChannelChoiceDisabled(false);
}

function showRelayManualCopyUrl(value) {
  els.relayManualCopyUrl.value = value;
  els.relayManualCopyBar.classList.remove("hidden");
  window.setTimeout(() => {
    els.relayManualCopyUrl.focus();
    els.relayManualCopyUrl.select();
  }, 0);
}

function hideRelayManualCopyUrl() {
  els.relayManualCopyUrl.value = "";
  els.relayManualCopyBar.classList.add("hidden");
}

function setLiveChoiceDisabled(disabled) {
  els.recordLiveStream.disabled = disabled;
  els.relayLiveStream.disabled = disabled;
  els.cancelLiveChoice.disabled = disabled;
}

function setChannelChoiceDisabled(disabled) {
  els.downloadChannel.disabled = disabled;
  els.subscribeChannel.disabled = disabled;
  els.cancelChannelChoice.disabled = disabled;
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

  hasActiveDownloads = downloads.some((download) => ["starting", "downloading", "processing", "indexing"].includes(download.status));
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
      const gpuName = data.gpu.name ? `${data.gpu.name} - ` : "";
      els.gpuText.textContent = `${gpuName}${data.gpu.percent || 0}%${temperature}`;
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
    { key: "cpuPercent", label: "CPU", color: currentThemeColour() },
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
    { key: "networkInBytesPerSecond", label: "In", color: currentThemeColour() },
    { key: "networkOutBytesPerSecond", label: "Out", color: "#ff8f70" }
  ], {
    maxValue,
    valueFormatter: formatBytes
  });
}

function currentThemeColour() {
  return getComputedStyle(document.documentElement).getPropertyValue("--accent").trim()
    || DEFAULT_PLAYBACK_PREFERENCES.themeColour;
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
  if (currentlyPlayingAdminView === "rooms") {
    await refreshWatchTogetherRooms();
    return;
  }
  if (currentlyPlayingAdminView === "streams") {
    await refreshAdminStreamQueues();
    return;
  }
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

function setCurrentlyPlayingAdminView(view) {
  currentlyPlayingAdminView = view === "rooms" ? "rooms" : view === "streams" && isAdminMode() ? "streams" : "playback";
  const rooms = currentlyPlayingAdminView === "rooms";
  const streams = currentlyPlayingAdminView === "streams";
  els.currentlyPlayingPlaybackTab.classList.toggle("active", !rooms && !streams);
  els.currentlyPlayingRoomsTab.classList.toggle("active", rooms);
  els.currentlyPlayingStreamsTab.classList.toggle("hidden", !isAdminMode());
  els.currentlyPlayingStreamsTab.classList.toggle("active", streams);
  els.currentlyPlayingList.classList.toggle("hidden", rooms || streams);
  els.watchTogetherAdminList.classList.toggle("hidden", !rooms);
  els.streamQueuesAdminList.classList.toggle("hidden", !streams);
  refreshCurrentlyPlaying();
}

async function refreshAdminStreamQueues() {
  if (!isAdminMode()) return;
  try {
    const data = await api("/api/admin/stream-queues");
    const queues = data.queues || [];
    els.streamQueuesAdminList.replaceChildren();
    if (queues.length === 0) {
      els.streamQueuesAdminList.innerHTML = '<p class="status">No streams are active.</p>';
      return;
    }
    for (const queue of queues) {
      const card = document.createElement("section");
      card.className = "library-manager-card currently-playing-card";
      const current = queue.items && queue.items.find((item) => item.status === "current" || item.status === "ready");
      card.innerHTML = `<div class="currently-playing-heading"><div><strong>${escapeHtml(queue.name)}</strong><span>Owned by ${escapeHtml(queue.ownerName || "Unknown")}</span></div><button class="danger-button compact-button" data-admin-stream-queue-id="${escapeHtml(queue.id)}" type="button">Stop stream</button></div><div class="currently-playing-meta"><span>${escapeHtml(current ? current.title : "Waiting for media")}</span><span>${queue.itemCount} item${queue.itemCount === 1 ? "" : "s"}</span><span>${escapeHtml(streamQueueStateLabel(queue))}</span></div>`;
      els.streamQueuesAdminList.appendChild(card);
    }
  } catch (err) {
    els.streamQueuesAdminList.innerHTML = '<p class="status">Failed to load streams.</p>';
  }
}

async function stopAdminStreamQueue(event) {
  const button = event.target.closest("[data-admin-stream-queue-id]");
  if (!button || !isAdminMode() || !window.confirm("Stop this stream? Its playback URL will stop working.")) return;
  button.disabled = true;
  try {
    await api(`/api/admin/stream-queues/${encodeURIComponent(button.dataset.adminStreamQueueId)}`, state.token, { method: "DELETE" });
    await refreshAdminStreamQueues();
  } catch (err) {
    button.disabled = false;
    window.alert(err.message || "Could not stop the stream.");
  }
}

async function refreshWatchTogetherRooms() {
  try {
    const data = await api("/api/admin/watch-together");
    const rooms = data.rooms || [];
    if (rooms.length === 0) {
      els.watchTogetherAdminList.innerHTML = '<p class="status">No Watch Together rooms are active.</p>';
      return;
    }
    els.watchTogetherAdminList.innerHTML = "";
    rooms.forEach((room) => {
      const card = document.createElement("section");
      card.className = "library-manager-card currently-playing-card";
      const roomState = room.state || {};
      const position = Number(roomState.positionSeconds) || 0;
      const duration = Number(room.durationSeconds) || 0;
      const percent = duration > 0 ? Math.min(100, position / duration * 100) : 0;
      const participantNames = (room.participants || []).map((participant) => participant.name).join(", ") || "No one connected";
      const queueCount = Array.isArray(room.queue) ? room.queue.length : 0;
      const queuePosition = queueCount > 0 ? Math.min(Number(room.currentQueueIndex) + 1, queueCount) : 0;
      card.innerHTML = `
        <div class="currently-playing-heading">
          <div>
            <strong>${escapeHtml(room.mediaTitle || "Unknown media")}</strong>
            <span>Hosted by ${escapeHtml(room.hostName || "Unknown")}</span>
          </div>
          ${isAdminMode() ? `<button class="secondary-button compact-button close-admin-watch-room" data-room-id="${escapeHtml(room.id)}" type="button">Close room</button>` : ""}
        </div>
        <div class="progress-track" aria-hidden="true"><span class="progress-fill" style="--progress: ${percent}%"></span></div>
        <div class="currently-playing-meta">
          <span>${escapeHtml(room.libraryTitle || room.mediaType || "")}</span>
          <span>${escapeHtml(`${room.connected || 0} connected`)}</span>
          <span>${escapeHtml(`Queue ${queuePosition} of ${queueCount}`)}</span>
          <span>${escapeHtml(`${roomState.state === "playing" ? "Playing" : "Paused"} at ${formatDuration(position)}`)}</span>
          <span>${escapeHtml(participantNames)}</span>
        </div>
      `;
      els.watchTogetherAdminList.appendChild(card);
    });
  } catch (err) {
    els.watchTogetherAdminList.innerHTML = '<p class="status">Failed to load Watch Together rooms.</p>';
  }
}

async function closeAdminWatchTogetherRoom(event) {
  const button = event.target.closest(".close-admin-watch-room");
  if (!button || !isAdminMode()) return;
  if (!window.confirm("Close this Watch Together room for everyone?")) return;
  button.disabled = true;
  try {
    await api(`/api/admin/watch-together/${encodeURIComponent(button.dataset.roomId)}`, state.token, { method: "DELETE" });
    await refreshWatchTogetherRooms();
  } catch (err) {
    button.disabled = false;
    window.alert(err.message || "Could not close the room.");
  }
}

async function loadUserHistory({ append = false } = {}) {
  if (userHistoryLoading || append && userHistoryNextOffset === null) {
    return;
  }
  const timespan = els.userHistoryTimespanFilter.value || "7d";
  const customRange = timespan === "custom" ? userHistoryDateRange() : null;
  if (timespan === "custom" && !customRange) {
    userHistoryItems = [];
    userHistoryNextOffset = null;
    els.userHistoryList.innerHTML = "";
    els.loadMoreUserHistory.classList.add("hidden");
    els.userHistoryStatus.textContent = "Choose a valid start and end date.";
    return;
  }
  userHistoryLoading = true;
  const offset = append ? userHistoryNextOffset : 0;
  const params = new URLSearchParams({
    timespan,
    limit: "100",
    offset: String(offset || 0)
  });
  if (customRange) {
    params.set("from", customRange.from);
    params.set("to", customRange.to);
  }
  if (els.userHistoryUserFilter.value) {
    params.set("userId", els.userHistoryUserFilter.value);
  }
  els.userHistoryUserFilter.disabled = true;
  els.userHistoryTimespanFilter.disabled = true;
  els.userHistoryStartDate.disabled = true;
  els.userHistoryEndDate.disabled = true;
  els.loadMoreUserHistory.disabled = true;
  els.userHistoryStatus.textContent = append ? "Loading more activity..." : "Loading watch history...";
  if (!append) {
    userHistoryItems = [];
    userHistoryNextOffset = null;
    els.userHistoryList.innerHTML = "";
  }

  try {
    const data = await api(`/api/admin/history?${params}`);
    populateUserHistoryUsers(data.users || []);
    const items = data.items || [];
    userHistoryItems = append ? [...userHistoryItems, ...items] : items;
    userHistoryNextOffset = data.hasMore ? Number(data.nextOffset) : null;
    renderUserHistoryTimeline(userHistoryItems);
    els.loadMoreUserHistory.classList.toggle("hidden", userHistoryNextOffset === null);
    els.userHistoryStatus.textContent = userHistoryItems.length === 0
      ? "No activity matches these filters."
      : `${userHistoryItems.length} ${userHistoryItems.length === 1 ? "activity" : "activities"} shown${data.hasMore ? "." : " - end of history."}`;
  } catch (err) {
    if (!append) {
      els.userHistoryList.innerHTML = '<p class="status">Failed to load user history.</p>';
    }
    els.userHistoryStatus.textContent = err.message || "Failed to load user history.";
  } finally {
    userHistoryLoading = false;
    els.userHistoryUserFilter.disabled = false;
    els.userHistoryTimespanFilter.disabled = false;
    els.userHistoryStartDate.disabled = false;
    els.userHistoryEndDate.disabled = false;
    els.loadMoreUserHistory.disabled = false;
  }
}

function handleUserHistoryTimespanChange() {
  const custom = els.userHistoryTimespanFilter.value === "custom";
  els.userHistoryCustomRange.classList.toggle("hidden", !custom);
  if (custom && (!els.userHistoryStartDate.value || !els.userHistoryEndDate.value)) {
    const end = new Date();
    const start = new Date(end);
    start.setDate(start.getDate() - 7);
    els.userHistoryStartDate.value = historyDateInputValue(start);
    els.userHistoryEndDate.value = historyDateInputValue(end);
  }
  loadUserHistory();
}

function userHistoryDateRange() {
  const start = localDateFromInput(els.userHistoryStartDate.value);
  const end = localDateFromInput(els.userHistoryEndDate.value);
  if (!start || !end || start > end) {
    return null;
  }
  const afterEnd = new Date(end);
  afterEnd.setDate(afterEnd.getDate() + 1);
  return {
    from: start.toISOString(),
    to: afterEnd.toISOString()
  };
}

function localDateFromInput(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return null;
  }
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

function historyDateInputValue(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function populateUserHistoryUsers(users) {
  const selected = els.userHistoryUserFilter.value;
  els.userHistoryUserFilter.innerHTML = '<option value="">All users</option>';
  for (const user of users) {
    const option = document.createElement("option");
    option.value = user.id;
    option.textContent = user.username;
    els.userHistoryUserFilter.appendChild(option);
  }
  els.userHistoryUserFilter.value = [...els.userHistoryUserFilter.options]
    .some((option) => option.value === selected) ? selected : "";
}

function renderUserHistoryTimeline(items) {
  els.userHistoryList.innerHTML = "";
  if (items.length === 0) {
    return;
  }
  let activeDay = "";
  let dayList = null;
  for (const item of items) {
    const date = new Date(item.updatedAt || 0);
    const dayKey = Number.isNaN(date.getTime()) ? "unknown" : date.toDateString();
    if (dayKey !== activeDay) {
      activeDay = dayKey;
      const group = document.createElement("section");
      group.className = "history-day";
      group.innerHTML = `<h3>${escapeHtml(historyDayLabel(date))}</h3><div class="history-day-items"></div>`;
      dayList = group.querySelector(".history-day-items");
      els.userHistoryList.appendChild(group);
    }
    dayList.appendChild(userHistoryTimelineItem(item, date));
  }
}

function userHistoryTimelineItem(item, date) {
  const progress = item.progress || {};
  const status = String(progress.status || "unknown");
  const percent = Math.max(0, Math.min(Number(progress.percent) || 0, 100));
  const row = document.createElement("article");
  row.className = `history-timeline-item history-status-${status.replace(/[^a-z0-9_-]/gi, "")}`;
  row.innerHTML = `
    <span class="history-timeline-dot" aria-hidden="true"></span>
    <div class="history-artwork">${escapeHtml(initials(item.title || "Unknown media"))}</div>
    <div class="history-entry-content">
      <div class="history-entry-heading">
        <div>
          <strong>${escapeHtml(item.title || "Unknown media")}</strong>
          ${item.subtitle ? `<span>${escapeHtml(item.subtitle)}</span>` : ""}
        </div>
        <time datetime="${escapeHtml(item.updatedAt || "")}">${escapeHtml(historyTimeLabel(date))}</time>
      </div>
      <div class="history-entry-meta">
        <span class="history-user">${escapeHtml(item.user && item.user.username || "Unknown user")}</span>
        <span>${escapeHtml(item.category || item.mediaType || "")}</span>
        <span>${escapeHtml(historyStatusLabel(status, percent))}</span>
      </div>
      ${status === "in_progress" ? `<div class="progress-track" aria-label="${escapeHtml(`${percent}% watched`)}"><span class="progress-fill" style="--progress: ${percent}%"></span></div>` : ""}
    </div>
  `;
  const artwork = row.querySelector(".history-artwork");
  const specialEpisode = isEpisodeItem(item) && Number(item.season) === 0;
  const imageUrl = specialEpisode
    ? item.seasonPosterUrl || item.posterUrl || item.thumbnailUrl
    : item.thumbnailUrl || item.seasonPosterUrl || item.posterUrl;
  if (imageUrl) {
    setPosterImage(artwork, imageUrl);
  }
  return row;
}

function historyDayLabel(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return "Unknown date";
  }
  const today = new Date();
  const startToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const startDate = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const dayDifference = Math.round((startToday - startDate) / (24 * 60 * 60 * 1000));
  if (dayDifference === 0) return "Today";
  if (dayDifference === 1) return "Yesterday";
  return date.toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: date.getFullYear() === today.getFullYear() ? undefined : "numeric"
  });
}

function historyTimeLabel(date) {
  return date instanceof Date && !Number.isNaN(date.getTime())
    ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : "Unknown time";
}

function historyStatusLabel(status, percent) {
  if (status === "watched") return "Watched";
  if (status === "in_progress") return `${percent}% watched`;
  return status.replace(/_/g, " ");
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
        ${hasPermission("canReindex") ? '<button class="secondary-button compact-button reindex-library" type="button">Re-index</button>' : ""}
        ${hasPermission("canManageLibraries") && !library.managed ? '<button class="secondary-button compact-button delete-library" type="button">Remove</button>' : ""}
      </div>
    </div>
    ${hasPermission("canManageLibraries") && (!library.managed || library.rawType === "yt-dlp") ? `
      <label class="library-progress-toggle">
        <input class="track-library-progress" type="checkbox" ${library.trackProgress === false ? "" : "checked"}>
        Store playback progress
      </label>
    ` : ""}
  `;

  const progressToggle = cardElement.querySelector(".track-library-progress");
  if (progressToggle) {
    progressToggle.addEventListener("change", () => updateLibraryProgress(library, progressToggle));
  }

  const reindexButton = cardElement.querySelector(".reindex-library");
  if (reindexButton) {
    reindexButton.addEventListener("click", () => reindexLibrary(library.key, library.title, reindexButton));
  }
  const deleteButton = cardElement.querySelector(".delete-library");
  if (deleteButton) {
    deleteButton.addEventListener("click", () => deleteLibrary(library.key, library.title));
  }
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
    await loadLibrarySidebar(true);
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
    await loadLibrarySidebar(true);
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
    await loadLibrarySidebar(true);
    await loadHome();
    els.libraryManagerStatus.textContent = "Library removed. Re-index running in the background.";
  } catch (err) {
    els.libraryManagerStatus.textContent = "Failed to remove library.";
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

  window.prompt("Copy value", value);
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

  if (state.libraryView) {
    const view = state.libraryView;
    view.scrollY = window.scrollY;
    view.requestId += 1;
    view.loading = false;
    if (view.hasMore && view.status.textContent === "Loading more...") {
      view.status.textContent = "";
    }
    cacheLibraryView(view);
  }

  state.libraryView = null;
}

function libraryViewCacheKey(libraryKey, folder = "") {
  return `${libraryKey}\0${folder}`;
}

function cacheLibraryView(view) {
  const key = libraryViewCacheKey(view.key, view.folder);
  libraryViewCache.delete(key);
  libraryViewCache.set(key, view);
  while (libraryViewCache.size > 6) {
    libraryViewCache.delete(libraryViewCache.keys().next().value);
  }
}

function restoreLibraryView(cacheKey) {
  const view = libraryViewCache.get(cacheKey);
  if (!view || !view.header || !view.section) {
    return false;
  }

  libraryViewCache.delete(cacheKey);
  hideLiveTvView();
  els.searchInput.value = "";
  els.searchResults.classList.add("hidden");
  els.homeToolbar.classList.add("hidden");
  els.homeRows.classList.remove("hidden");
  els.homeRows.replaceChildren(view.header, view.section);
  state.currentView = "library";
  state.libraryView = view;
  startLibraryObserver(view);

  const scrollY = Number(view.scrollY) || 0;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => window.scrollTo({ top: scrollY, left: 0, behavior: "auto" }));
  });
  return true;
}

function startLibraryObserver(view) {
  libraryObserver = new IntersectionObserver((entries) => {
    if (state.libraryView === view && entries.some((entry) => entry.isIntersecting)) {
      loadNextLibraryPage();
    }
  }, { rootMargin: "700px 0px" });
  libraryObserver.observe(view.sentinel);
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
  const special = Number(episode.season) === 0;
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
    thumbnailUrl: special ? null : thumbnailUrlForEpisode(mediaType, episode.id),
    seasonPosterUrl: special ? show.posterUrl || null : null,
    posterUrl: special ? show.posterUrl || null : null,
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

function shuffleCollectionForItem(item) {
  const collection = item && item.shuffleCollection;
  if (!collection || collection.type !== "folder" || !collection.id) {
    return null;
  }
  return {
    type: "folder",
    id: String(collection.id),
    title: String(collection.title || "")
  };
}

function isShufflePlayableItem(item) {
  return Boolean(item && (item.showId || shuffleCollectionForItem(item)));
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
      applyItemPoster(state.selected, result.posterUrl);
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

function openSeriesPosterEditor(mediaType, show) {
  state.seriesPosterTarget = {
    mediaType,
    id: show.id,
    title: show.name
  };
  els.seriesPosterPrompt.textContent = show.name;
  els.seriesPosterUrl.value = "";
  els.seriesPosterStatus.textContent = "";
  els.seriesPosterOverlay.classList.remove("hidden");
  els.seriesPosterOverlay.setAttribute("aria-hidden", "false");
  els.seriesPosterUrl.focus();
}

function closeSeriesPosterEditor() {
  state.seriesPosterTarget = null;
  els.seriesPosterOverlay.classList.add("hidden");
  els.seriesPosterOverlay.setAttribute("aria-hidden", "true");
  els.seriesPosterUrl.value = "";
  els.seriesPosterStatus.textContent = "";
}

async function saveSeriesPoster(event) {
  event.preventDefault();
  const target = state.seriesPosterTarget;
  if (!target) {
    return;
  }

  const posterUrl = els.seriesPosterUrl.value.trim();
  try {
    new URL(posterUrl);
  } catch (err) {
    els.seriesPosterStatus.textContent = "Enter a valid poster URL.";
    return;
  }

  els.saveSeriesPoster.disabled = true;
  els.seriesPosterStatus.textContent = "Saving poster...";
  try {
    const result = await api(`/api/catalog/${target.mediaType}/${target.id}/metadata/poster`, state.token, {
      method: "POST",
      body: JSON.stringify({ posterUrl })
    });
    if (result.posterUrl) {
      applySeriesPoster(target, result.posterUrl);
    }
    els.seriesPosterStatus.textContent = "Poster saved.";
    setTimeout(() => {
      if (state.seriesPosterTarget === target) {
        closeSeriesPosterEditor();
      }
    }, 650);
  } catch (err) {
    els.seriesPosterStatus.textContent = err.message || "Failed to save poster.";
  } finally {
    els.saveSeriesPoster.disabled = false;
  }
}

function applySeriesPoster(target, posterUrl) {
  for (const row of state.homeData && state.homeData.rows || []) {
    for (const item of row.items || []) {
      if (item.mediaType === target.mediaType
        && (isShowCard(item) || item.itemType === "episode-bundle")
        && (item.showId || item.id) === target.id) {
        item.posterUrl = posterUrl;
        if (item.itemType === "episode-bundle") {
          item.seasonPosterUrl = posterUrl;
        }
      }
    }
  }

  const showKey = `${target.mediaType}:${target.id}`;
  document.querySelectorAll('.card[data-series-artwork="true"]').forEach((cardElement) => {
    if (cardElement.dataset.showKey === showKey) {
      const poster = cardElement.querySelector(".poster");
      if (poster) {
        setPosterImage(poster, posterUrl);
      }
    }
  });
  document.querySelectorAll(`.card[data-show-key="${cssEscape(showKey)}"][data-season="0"]`).forEach((cardElement) => {
    const poster = cardElement.querySelector(".poster");
    if (poster) {
      poster.classList.remove("thumbnail-art");
      setPosterImage(poster, posterUrl);
    }
  });
}

function applyItemPoster(target, posterUrl) {
  const key = mediaKey(target);
  if (!key) {
    return;
  }

  for (const row of state.homeData && state.homeData.rows || []) {
    for (const item of row.items || []) {
      if (mediaKey(item) === key) {
        item.posterUrl = posterUrl;
      }
    }
  }

  document.querySelectorAll(`.card[data-media-key="${cssEscape(key)}"]`).forEach((cardElement) => {
    const poster = cardElement.querySelector(".poster");
    if (poster) {
      setPosterImage(poster, posterUrl);
    }
  });
}

function openMetadataMatchModal(target) {
  state.metadataMatchTarget = target || null;
  els.metadataMatchOverlay.classList.remove("hidden");
  els.metadataMatchOverlay.setAttribute("aria-hidden", "false");
  els.metadataMatchPrompt.textContent = target ? target.title : state.selected ? state.selected.title : "";
  els.metadataSearchTitle.value = "";
  els.metadataSearchYear.value = "";
  els.metadataProviderId.value = "";
  els.metadataProviderId.placeholder = target && target.itemType === "track" ? "Deezer album ID" : "TMDb ID";
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
      const matchedEpisodes = Number.parseInt(result.matchedEpisodes, 10);
      const unmatchedEpisodes = Number.parseInt(result.unmatchedEpisodes, 10);
      els.copyStatus.textContent = Number.isFinite(matchedEpisodes) && Number.isFinite(unmatchedEpisodes)
        ? `Show metadata match applied: ${matchedEpisodes} matched, ${unmatchedEpisodes} hidden.`
        : "Show metadata match applied.";
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

  if (result.posterUrl) {
    applyItemPoster(state.selected, result.posterUrl);
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
    clearPosterImage(els.detailsPoster);
    els.detailsPoster.textContent = initials(title);
  }
  setWatchedMarker(els.detailsPoster, isWatchedProgress(state.selected.progress));
}

function setPosterImage(element, url) {
  const imageUrl = String(url || "").trim();
  if (!imageUrl) {
    return;
  }

  posterImageSources.set(element, imageUrl);
  if (posterImageObserver) {
    posterImageObserver.observe(element);
    return;
  }
  loadPosterImage(element, imageUrl);
}

const posterImageSources = new WeakMap();
const posterImageObserver = typeof window.IntersectionObserver === "function"
  ? new window.IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      posterImageObserver.unobserve(entry.target);
      const imageUrl = posterImageSources.get(entry.target);
      if (imageUrl) loadPosterImage(entry.target, imageUrl);
    }
  }, { rootMargin: "500px" })
  : null;

function loadPosterImage(element, imageUrl) {
  const requestId = `${Date.now()}-${Math.random()}`;
  element.dataset.posterRequest = requestId;
  const image = new Image();
  image.decoding = "async";
  image.fetchPriority = "low";
  image.addEventListener("load", () => {
    if (element.dataset.posterRequest !== requestId || posterImageSources.get(element) !== imageUrl) {
      return;
    }
    [...element.childNodes]
      .filter((child) => child.nodeType === Node.TEXT_NODE)
      .forEach((child) => child.remove());
    element.style.setProperty("--poster-image", `url("${imageUrl.replace(/"/g, "%22")}")`);
    element.classList.add("with-image");
  }, { once: true });
  image.addEventListener("error", () => {
    if (element.dataset.posterRequest === requestId) {
      delete element.dataset.posterRequest;
    }
  }, { once: true });
  image.src = imageUrl;
}

function clearPosterImage(element) {
  posterImageObserver?.unobserve(element);
  posterImageSources.delete(element);
  delete element.dataset.posterRequest;
  element.classList.remove("with-image");
  element.style.removeProperty("--poster-image");
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
  if (!progress || progress.status !== "in_progress" || !progress.percent) {
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
  updateRenderedEpisodeBundles(item, progress);
  updateRenderedSeasonCards(item, progress);
}

function updateRenderedSeasonCards(item, progress) {
  if (!item || !item.showId || item.season === undefined || !item.id) {
    return;
  }
  const showKey = `${item.mediaType}:${item.showId}`;
  document.querySelectorAll(`.card[data-season-card="true"][data-show-key="${cssEscape(showKey)}"][data-season="${cssEscape(String(Number(item.season)))}"]`)
    .forEach((cardElement) => {
      const episodeIds = String(cardElement.dataset.seasonEpisodeIds || "").split(",").filter(Boolean);
      if (!episodeIds.includes(String(item.id))) return;
      const watchedIds = new Set(String(cardElement.dataset.watchedEpisodeIds || "").split(",").filter(Boolean));
      if (isWatchedProgress(progress)) {
        watchedIds.add(String(item.id));
      } else {
        watchedIds.delete(String(item.id));
      }
      cardElement.dataset.watchedEpisodeIds = [...watchedIds].join(",");
      const poster = cardElement.querySelector(".poster");
      const watched = episodeIds.length > 0 && watchedIds.size >= episodeIds.length;
      cardElement.classList.toggle("watched-card", watched);
      setWatchedMarker(poster, watched);
      setSeasonProgressMarker(poster, watchedIds.size, episodeIds.length);
    });
}

function setSeasonProgressMarker(poster, watched, total) {
  if (!poster) return;
  let marker = poster.querySelector(".season-progress-marker");
  if (!Number.isFinite(Number(total)) || Number(total) <= 0) {
    if (marker) marker.remove();
    return;
  }
  if (!marker) {
    marker = document.createElement("span");
    marker.className = "season-progress-marker";
    poster.appendChild(marker);
  }
  const completed = Math.max(0, Math.min(Number(watched) || 0, Number(total)));
  marker.textContent = `${completed}/${Number(total)}`;
  marker.title = `${completed} of ${Number(total)} episodes watched`;
  marker.setAttribute("aria-label", marker.title);
}

function updateRenderedEpisodeBundles(item, progress) {
  if (!item || !item.showId || !item.id) {
    return;
  }
  const showKey = `${item.mediaType}:${item.showId}`;
  document.querySelectorAll(`.card[data-show-key="${cssEscape(showKey)}"][data-bundle-episode-ids]`).forEach((cardElement) => {
    const ids = String(cardElement.dataset.bundleEpisodeIds || "").split(",").filter(Boolean);
    if (!ids.includes(String(item.id))) {
      return;
    }
    const watchedIds = new Set(String(cardElement.dataset.watchedEpisodeIds || "").split(",").filter(Boolean));
    if (isWatchedProgress(progress)) {
      watchedIds.add(String(item.id));
    } else {
      watchedIds.delete(String(item.id));
    }
    cardElement.dataset.watchedEpisodeIds = [...watchedIds].join(",");
    const total = Number.parseInt(cardElement.dataset.bundleTotalCount || "", 10) || ids.length;
    const nextCount = Math.max(0, Math.min(total, total - watchedIds.size));
    const watched = total > 0 && nextCount === 0;
    cardElement.dataset.newEpisodeCount = String(nextCount);
    cardElement.classList.toggle("watched-card", watched);
    setWatchedMarker(cardElement.querySelector(".poster"), watched);
    setNewEpisodeMarker(cardElement.querySelector(".poster"), nextCount);
    const subtitle = cardElement.querySelector(".card-subtitle");
    if (subtitle) {
      subtitle.textContent = "";
    }
  });
}

function cardWatchedState(item) {
  return isWatchedProgress(item.progress) || episodeBundleWatched(item);
}

function episodeBundleWatched(item) {
  if (!item || item.itemType !== "episode-bundle" || !Array.isArray(item.bundledEpisodeIds)) {
    return false;
  }

  const total = item.bundledEpisodeIds.length;
  if (total === 0) {
    return false;
  }

  if (Number.isFinite(Number(item.newEpisodeCount))) {
    return Number(item.newEpisodeCount) <= 0;
  }

  const watched = Array.isArray(item.bundledWatchedEpisodeIds)
    ? new Set(item.bundledWatchedEpisodeIds.map(String))
    : new Set();
  return item.bundledEpisodeIds.every((id) => watched.has(String(id)));
}

function cardNewEpisodeCount(item) {
  if (!item || item.itemType !== "episode-bundle") {
    return item && item.newEpisodeCount;
  }

  if (Number.isFinite(Number(item.newEpisodeCount))) {
    return Number(item.newEpisodeCount);
  }

  const ids = Array.isArray(item.bundledEpisodeIds) ? item.bundledEpisodeIds : [];
  const watched = Array.isArray(item.bundledWatchedEpisodeIds)
    ? new Set(item.bundledWatchedEpisodeIds.map(String))
    : new Set();
  return Math.max(0, ids.length - watched.size);
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

function setNewEpisodeMarker(element, count) {
  if (!element) {
    return;
  }
  const value = Math.max(0, Number.parseInt(count, 10) || 0);
  let marker = element.querySelector(".new-episode-marker");
  if (value <= 0) {
    marker?.remove();
    return;
  }
  if (!marker) {
    marker = document.createElement("span");
    marker.className = "new-episode-marker";
    element.appendChild(marker);
  }
  marker.textContent = `${value} new`;
  marker.title = `${value} new episode${value === 1 ? "" : "s"}`;
}

function renderDetailsProgress(progress) {
  setWatchedMarker(els.detailsPoster, isWatchedProgress(progress));
  if (!progress || progress.status !== "in_progress" || !progress.percent) {
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
  const onDeck = selectedItemIsOnDeck(progress);
  els.removeOnDeck.classList.toggle("hidden", !onDeck);
  els.markWatched.textContent = isWatchedProgress(progress) ? "Mark unwatched" : "Mark watched";
}

function selectedItemIsOnDeck(progress = state.selected && state.selected.progress) {
  if (!state.selected || state.selected.onDeckRemoved) {
    return false;
  }
  return ["resume", "next"].includes(state.selected.onDeckReason)
    || Boolean(progress && progress.status === "in_progress" && Number(progress.positionSeconds) > 0);
}

function updateAdminControls() {
  els.lockButton.classList.toggle("hidden", Boolean(state.libraryViewToken));
  els.accountButton.classList.toggle("hidden", !state.user || Boolean(state.libraryViewToken));
  els.accountButton.title = state.user ? `Account settings for ${state.user.username}` : "Account settings";
  els.adminPanelButton.classList.toggle("hidden", !hasPermission("canViewAdmin"));
  els.liveTvButton.classList.toggle("hidden", !state.token || Boolean(state.libraryViewToken) || !state.iptvEnabled || !canAccessLiveTv());
  const ytdlp = state.health && state.health.binaries && state.health.binaries.ytdlp;
  const ytdlpUnavailable = Boolean(state.features.ytdlp && ytdlp && !ytdlp.ok);
  els.downloadButton.classList.toggle("hidden", !state.token || Boolean(state.libraryViewToken) || !state.features.ytdlp);
  els.downloadButton.disabled = ytdlpUnavailable;
  els.downloadButton.title = ytdlpUnavailable ? "YT-DLP is enabled but not available on the server." : "Download URL";
  els.streamQueuesButton.classList.toggle("hidden", !hasPermission("canManageStreamQueues"));
  renderUpdateBanner();
}

function canAccessLiveTv() {
  if (!state.user || state.libraryViewToken) {
    return false;
  }
  const permissions = state.user.permissions || {};
  return Boolean(permissions.isAdmin || (permissions.libraries || []).includes(LIVE_TV_PERMISSION_KEY));
}

function updateDetailsAdminControls() {
  const signedIn = Boolean(state.user);
  const canManageMetadata = hasPermission("canManageMetadata");
  const image = Boolean(state.selected && state.selected.itemType === "image");
  const libraryView = Boolean(state.libraryViewToken);
  els.editPoster.classList.toggle("hidden", image || !canManageMetadata);
  els.pregenerateHls.classList.toggle("hidden", image || !isAdminMode());
  els.rematchMetadata.classList.toggle("hidden", image || !canManageMetadata);
  els.markWatched.classList.toggle("hidden", image || !signedIn);
  els.removeOnDeck.classList.toggle("hidden", image || !signedIn || !selectedItemIsOnDeck());
  els.playStream.classList.toggle("hidden", image || libraryView);
  els.copyUrl.classList.toggle("hidden", !hasPermission("canCopyStreamUrls"));
  els.startWatchTogether.classList.toggle("hidden", image || !hasPermission("canCopyStreamUrls"));
  els.toggleFilePath.closest(".file-path-block").classList.toggle("hidden", libraryView);
  els.copyUrl.textContent = image ? "Copy image URL" : "Copy URL";
  for (const select of [els.audioSelect, els.qualitySelect, els.subtitleSelect]) {
    select.closest("label").classList.toggle("hidden", image || libraryView);
  }
  if (libraryView) {
    els.audioChannelsLabel.classList.add("hidden");
  }
}

function updatePlaybackControls() {
  const disabled = !isPlaybackReady();
  for (const button of [els.playStream, els.copyUrl, els.pregenerateHls, els.startWatchTogether]) {
    button.disabled = disabled;
    button.title = disabled ? playbackDisabledMessage() : "";
  }
}

function isAdminMode() {
  return Boolean(state.user && state.user.permissions && state.user.permissions.isAdmin);
}

function hasPermission(permission) {
  if (!state.user || state.libraryViewToken) {
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
  applyThemeColour(state.playbackPreferences.themeColour);
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
  if (!state.token || state.libraryViewToken || !state.user) {
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
    audioChannels: ["stereo", "surround51", "stabby51", "preserve"].includes(audioChannels) ? audioChannels : "stereo",
    themeColour: normalizeThemeColour(preferences.themeColour)
  };
}

function normalizeThemeColour(value) {
  const colour = String(value || "").trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(colour) ? colour : DEFAULT_PLAYBACK_PREFERENCES.themeColour;
}

function applyThemeColour(value) {
  const colour = normalizeThemeColour(value);
  const red = Number.parseInt(colour.slice(1, 3), 16);
  const green = Number.parseInt(colour.slice(3, 5), 16);
  const blue = Number.parseInt(colour.slice(5, 7), 16);
  const root = document.documentElement;
  root.style.setProperty("--accent", colour);
  root.style.setProperty("--accent-rgb", `${red}, ${green}, ${blue}`);
  root.style.setProperty("--accent-contrast", readableAccentText(red, green, blue));
}

function readableAccentText(red, green, blue) {
  const luminance = (0.2126 * linearColourChannel(red))
    + (0.7152 * linearColourChannel(green))
    + (0.0722 * linearColourChannel(blue));
  return luminance > 0.38 ? "#061014" : "#f7fbfd";
}

function linearColourChannel(value) {
  const channel = value / 255;
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
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

async function openStreamQueuesView(options = {}) {
  if (!hasPermission("canManageStreamQueues")) return;
  stopLibraryLoading();
  stopHomeRowLoading();
  hideLiveTvView();
  closeDetails();
  if (options.record !== false) recordRoute(navigation.streamQueuesPath());
  state.currentView = "stream-queues";
  els.searchInput.value = "";
  els.searchResults.classList.add("hidden");
  els.homeToolbar.classList.add("hidden");
  els.homeRows.classList.add("hidden");
  els.streamQueuesView.classList.remove("hidden");
  els.copyQueueStatus.textContent = "Loading streams...";
  await loadCopyQueues();
  if (selectedCopyQueueId && copyQueues.some((queue) => queue.id === selectedCopyQueueId)) {
    selectCopyQueue(selectedCopyQueueId);
  } else if (copyQueues.length > 0) {
    selectCopyQueue(copyQueues[0].id);
  } else {
    beginStreamQueueDraft();
  }
}

function hideStreamQueuesView() {
  streamQueueMediaBrowserRequestId += 1;
  els.streamQueuesView.classList.add("hidden");
}

async function loadCopyQueues() {
  try {
    const result = await api("/api/copy-queues", state.token);
    copyQueues = result.queues || [];
    renderCopyQueues();
    els.copyQueueStatus.textContent = "";
  } catch (err) {
    els.copyQueueStatus.textContent = err.message || "Could not load streams.";
  }
}

function beginStreamQueueDraft() {
  selectedCopyQueueId = null;
  clearStreamQueueMediaSelection();
  els.streamQueueEmpty.classList.add("hidden");
  els.streamQueueCurrent.classList.add("hidden");
  els.streamQueueDraft.classList.remove("hidden");
  els.streamQueueMediaPicker.classList.remove("hidden");
  els.copyQueueName.value = "";
  resetStreamQueueMediaBrowser("New stream", "Choose the first item");
  renderCopyQueues();
}

function cancelStreamQueueDraft() {
  copyQueueSelectedItem = null;
  if (copyQueues.length > 0) selectCopyQueue(copyQueues[0].id);
  else showEmptyStreamQueueEditor();
}

function showEmptyStreamQueueEditor() {
  selectedCopyQueueId = null;
  clearStreamQueueMediaSelection();
  streamQueueMediaBrowserRequestId += 1;
  streamQueueMediaBrowserTrail = [];
  els.streamQueueEmpty.classList.remove("hidden");
  els.streamQueueDraft.classList.add("hidden");
  els.streamQueueCurrent.classList.add("hidden");
  els.streamQueueMediaPicker.classList.add("hidden");
  renderCopyQueues();
}

async function createCopyStreamQueue() {
  if (!copyQueueSelectedItem) return;
  els.copyQueueStatus.textContent = "Creating stream...";
  try {
    const expiry = els.copyQueueExpiry.value;
    const result = await api("/api/copy-queues", state.token, {
      method: "POST",
      body: JSON.stringify({
        ...selectedStreamQueueMediaPayload(),
        name: els.copyQueueName.value.trim(),
        expiresInSeconds: expiry === "unlimited" ? null : Number(expiry)
      })
    });
    rememberCopyQueueUrl(result.queue.id, result.playbackUrl);
    els.copyQueueUrl.value = result.playbackUrl;
    copyQueues.unshift(result.queue);
    copyQueueSelectedItem = null;
    selectCopyQueue(result.queue.id, { revealUrl: result.playbackUrl });
    els.copyQueueStatus.textContent = "Stream created and waiting. Open the URL, then press Play stream when ready.";
  } catch (err) {
    els.copyQueueStatus.textContent = err.message || "Could not create the stream.";
  }
}

async function copyCreatedQueueUrl() {
  if (!els.copyQueueUrl.value) return;
  try {
    await writeClipboard(els.copyQueueUrl.value);
    els.copyQueueStatus.textContent = "Stream URL copied.";
  } catch (err) {
    els.copyQueueUrl.focus();
    els.copyQueueUrl.select();
    els.copyQueueStatus.textContent = "Select the URL to copy it manually.";
  }
}

function renderCopyQueues() {
  els.copyQueueList.replaceChildren();
  els.copyQueueCount.textContent = String(copyQueues.length);
  for (const queue of copyQueues) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `stream-queue-selector-item${queue.id === selectedCopyQueueId ? " active" : ""}`;
    button.dataset.copyQueueAction = "select";
    button.dataset.queueId = queue.id;
    const owner = isAdminMode() ? `<small>${escapeHtml(queue.ownerName || "Unknown owner")}</small>` : "";
    button.innerHTML = `<strong>${escapeHtml(queue.name)}</strong><span>${escapeHtml(streamQueueStateLabel(queue))} - ${queue.itemCount} item${queue.itemCount === 1 ? "" : "s"}</span>${owner}`;
    els.copyQueueList.appendChild(button);
  }
}

function selectCopyQueue(queueId, options = {}) {
  const queue = copyQueues.find((entry) => entry.id === queueId);
  if (!queue) return;
  selectedCopyQueueId = queue.id;
  clearStreamQueueMediaSelection();
  els.streamQueueEmpty.classList.add("hidden");
  els.streamQueueDraft.classList.add("hidden");
  els.streamQueueCurrent.classList.remove("hidden");
  els.streamQueueMediaPicker.classList.remove("hidden");
  els.streamQueueTitle.textContent = queue.name;
  els.streamQueueOwner.textContent = isAdminMode() ? `Owned by ${queue.ownerName || "Unknown"}` : "Your stream";
  const expiry = queue.expiresAt ? `Expires ${new Date(queue.expiresAt).toLocaleString()}` : "No expiration";
  els.streamQueueMeta.textContent = `${streamQueueStateLabel(queue)} - ${expiry} - ${queue.itemCount} item${queue.itemCount === 1 ? "" : "s"}`;
  if (!options.preservePicker) resetStreamQueueMediaBrowser(queue.name, "Add media");
  const knownUrl = options.revealUrl || rememberedCopyQueueUrls()[queue.id] || "";
  els.copyQueueUrl.value = knownUrl;
  els.copyQueueCreatedUrl.classList.toggle("hidden", !options.revealUrl);
  els.copyCurrentStreamUrl.classList.toggle("hidden", !knownUrl);
  const readyItem = queue.items.some((item) => item.status === "ready");
  els.playCurrentStream.classList.toggle("hidden", queue.state === "playing" || !readyItem);
  els.skipCurrentStreamItem.classList.toggle("hidden", queue.state !== "playing");
  renderStreamQueueItems(queue);
  renderCopyQueues();
}

function renderStreamQueueItems(queue) {
  els.streamQueueItems.replaceChildren();
  const future = queue.items.filter((item) => item.status === "ready" || item.status === "queued");
  queue.items.forEach((item, itemIndex) => {
    const row = document.createElement("div");
    row.className = `copy-queue-item ${item.status}`;
    const futureIndex = future.findIndex((entry) => entry.id === item.id);
    const status = item.status === "current" ? "Playing now" : item.status === "ready" ? "Ready to play" : item.status === "queued" ? "Up next" : "Played";
    const editable = item.status === "ready" || item.status === "queued";
    row.innerHTML = `<div class="copy-queue-item-label"><span>${itemIndex + 1}</span><div><strong title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</strong><small>${status}</small></div></div>${editable ? `<div class="copy-queue-actions"><button class="music-icon-button" type="button" title="Move up" data-copy-queue-action="up" data-queue-id="${escapeHtml(queue.id)}" data-item-id="${escapeHtml(item.id)}" ${futureIndex <= 0 ? "disabled" : ""}>&#8593;</button><button class="music-icon-button" type="button" title="Move down" data-copy-queue-action="down" data-queue-id="${escapeHtml(queue.id)}" data-item-id="${escapeHtml(item.id)}" ${futureIndex >= future.length - 1 ? "disabled" : ""}>&#8595;</button><button class="music-icon-button" type="button" title="Remove" data-copy-queue-action="remove" data-queue-id="${escapeHtml(queue.id)}" data-item-id="${escapeHtml(item.id)}">x</button></div>` : ""}`;
    els.streamQueueItems.appendChild(row);
  });
}

function streamQueueStateLabel(queue) {
  if (queue.state === "playing") return "Playing";
  if (queue.items && queue.items.some((item) => item.status === "ready")) return "Waiting to start";
  return "Waiting for media";
}

async function searchStreamQueueMedia(event) {
  event.preventDefault();
  const query = els.streamQueueSearchInput.value.trim();
  if (!query) return;
  const requestId = ++streamQueueMediaBrowserRequestId;
  els.streamQueueMediaBrowserContext.textContent = selectedCopyQueueId ? "Stream" : "New stream";
  els.streamQueueSearchTitle.textContent = `Search: ${query}`;
  els.streamQueueMediaBrowserBack.classList.add("hidden");
  els.streamQueueSearchResults.innerHTML = '<p class="status">Searching...</p>';
  try {
    const result = await api(`/api/catalog/search?q=${encodeURIComponent(query)}`, state.token);
    if (requestId !== streamQueueMediaBrowserRequestId || els.streamQueuesView.classList.contains("hidden")) return;
    showStreamQueueMediaBrowserScreen({
      context: "Search results",
      title: query,
      items: catalogBrowserSearchResults(result.results)
    }, { replace: true });
  } catch (err) {
    if (requestId !== streamQueueMediaBrowserRequestId) return;
    els.streamQueueSearchResults.innerHTML = `<p class="status error">${escapeHtml(err.message || "Search failed.")}</p>`;
  }
}

function resetStreamQueueMediaBrowser(context, title) {
  streamQueueMediaBrowserRequestId += 1;
  streamQueueMediaBrowserTrail = [];
  els.streamQueueMediaBrowserBack.classList.add("hidden");
  els.streamQueueMediaBrowserContext.textContent = context;
  els.streamQueueSearchTitle.textContent = title;
  els.streamQueueSearchResults.replaceChildren();
  els.streamQueueSearchInput.value = "";
}

function showStreamQueueMediaBrowserScreen(screen, options = {}) {
  clearStreamQueueMediaSelection();
  streamQueueMediaBrowserTrail = options.replace
    ? [screen]
    : [...streamQueueMediaBrowserTrail, screen];
  renderStreamQueueMediaBrowserScreen(screen);
}

function renderStreamQueueMediaBrowserScreen(screen) {
  els.streamQueueMediaBrowserContext.textContent = screen.context || "Stream";
  els.streamQueueSearchTitle.textContent = screen.title || "Add media";
  els.streamQueueMediaBrowserBack.classList.toggle("hidden", streamQueueMediaBrowserTrail.length < 2);
  els.streamQueueSearchResults.replaceChildren();
  if (!screen.items || screen.items.length === 0) {
    els.streamQueueSearchResults.innerHTML = '<p class="status">No media found.</p>';
    return;
  }
  for (const item of screen.items) {
    const navigable = catalogBrowserItemIsNavigable(item);
    els.streamQueueSearchResults.appendChild(card(item, {
      browserCard: true,
      episodeArtwork: "thumbnail",
      actionLabel: navigable ? "Open" : "Choose",
      onActivate: activateStreamQueueMediaBrowserItem
    }));
  }
}

function navigateBackStreamQueueMediaBrowser() {
  if (streamQueueMediaBrowserTrail.length < 2) return;
  streamQueueMediaBrowserRequestId += 1;
  clearStreamQueueMediaSelection();
  streamQueueMediaBrowserTrail.pop();
  renderStreamQueueMediaBrowserScreen(streamQueueMediaBrowserTrail[streamQueueMediaBrowserTrail.length - 1]);
}

async function activateStreamQueueMediaBrowserItem(item, button) {
  if (button.disabled) return;
  if (!catalogBrowserItemIsNavigable(item)) {
    await selectStreamQueueMediaItem(item, button);
    return;
  }

  button.disabled = true;
  const requestId = ++streamQueueMediaBrowserRequestId;
  els.streamQueueSearchResults.innerHTML = '<p class="status">Loading...</p>';
  try {
    const screen = await catalogBrowserScreenForItem(item);
    if (requestId !== streamQueueMediaBrowserRequestId || els.streamQueuesView.classList.contains("hidden")) return;
    showStreamQueueMediaBrowserScreen(screen);
  } catch (err) {
    if (requestId !== streamQueueMediaBrowserRequestId) return;
    renderStreamQueueMediaBrowserScreen(streamQueueMediaBrowserTrail[streamQueueMediaBrowserTrail.length - 1]);
    const error = document.createElement("p");
    error.className = "status error catalog-browser-error";
    error.textContent = err.message || "The collection could not be opened.";
    els.streamQueueSearchResults.prepend(error);
  }
}

async function selectStreamQueueMediaItem(item, button) {
  button.disabled = true;
  const requestId = ++streamQueueMediaBrowserRequestId;
  els.copyQueueStatus.textContent = "Loading audio and subtitle options...";
  try {
    const mediaId = item.mediaId || item.id;
    const options = await api(`/api/catalog/${encodeURIComponent(item.mediaType)}/${encodeURIComponent(mediaId)}/options`, state.token);
    if (requestId !== streamQueueMediaBrowserRequestId || els.streamQueuesView.classList.contains("hidden")) return;
    const audio = Array.isArray(options.audio) && options.audio.length > 0
      ? options.audio
      : [{ id: "none", label: "No audio" }];
    const subtitles = Array.isArray(options.subtitles) && options.subtitles.length > 0
      ? options.subtitles
      : [{ id: "none", label: "No subtitles" }];
    copyQueueSelectedItem = {
      mediaType: item.mediaType,
      mediaId,
      title: item.title || "Media",
      artworkUrl: item.artworkUrl || imageUrlForItem(item),
      audioChannels: state.playbackPreferences.audioChannels,
      quality: state.playbackPreferences.quality
    };
    fillSelect(els.streamQueueAudioSelect, audio);
    fillSelect(els.streamQueueSubtitleSelect, subtitles);
    selectPreferredOption(els.streamQueueAudioSelect, preferredAudioValue(audio, state.playbackPreferences.audioLanguage));
    selectPreferredOption(els.streamQueueSubtitleSelect, preferredSubtitleValue(subtitles, state.playbackPreferences));
    els.copyQueueSelected.classList.remove("hidden");
    els.copyQueueSelectedTitle.textContent = copyQueueSelectedItem.title;
    if (!selectedCopyQueueId && !els.copyQueueName.value.trim()) {
      els.copyQueueName.value = `${copyQueueSelectedItem.title} stream`;
    }
    els.streamQueueSelectionHint.textContent = "Choose the tracks to bake into this item";
    els.addStreamQueueMedia.classList.toggle("hidden", !selectedCopyQueueId);
    els.createStreamQueue.classList.toggle("hidden", Boolean(selectedCopyQueueId));
    els.copyQueueStatus.textContent = "";
    setCatalogBrowserCardFeedback(button, "Selected");
  } catch (err) {
    if (requestId !== streamQueueMediaBrowserRequestId) return;
    els.copyQueueStatus.textContent = err.message || "Could not load audio and subtitle options.";
  } finally {
    if (button.isConnected) button.disabled = false;
  }
}

function selectedStreamQueueMediaPayload() {
  return copyQueueSelectedItem && {
    ...copyQueueSelectedItem,
    audio: els.streamQueueAudioSelect.value,
    subtitle: els.streamQueueSubtitleSelect.value
  };
}

function clearStreamQueueMediaSelection() {
  copyQueueSelectedItem = null;
  els.copyQueueSelected.classList.add("hidden");
  els.copyQueueSelectedTitle.textContent = "";
  els.streamQueueAudioSelect.replaceChildren();
  els.streamQueueSubtitleSelect.replaceChildren();
  els.streamQueueSelectionHint.textContent = "";
  els.addStreamQueueMedia.classList.add("hidden");
  els.createStreamQueue.classList.add("hidden");
}

async function addSelectedStreamQueueMedia() {
  if (!selectedCopyQueueId || !copyQueueSelectedItem) return;
  els.addStreamQueueMedia.disabled = true;
  try {
    await addItemToCopyQueue(selectedCopyQueueId, selectedStreamQueueMediaPayload());
  } finally {
    els.addStreamQueueMedia.disabled = false;
  }
}

async function addItemToCopyQueue(queueId, payload) {
  els.copyQueueStatus.textContent = "Adding media...";
  try {
    const result = await api(`/api/copy-queues/${encodeURIComponent(queueId)}/items`, state.token, { method: "POST", body: JSON.stringify(payload) });
    replaceCopyQueue(result.queue);
    selectCopyQueue(queueId, { preservePicker: true });
    els.copyQueueStatus.textContent = "Added to the stream.";
    return true;
  } catch (err) {
    els.copyQueueStatus.textContent = err.message || "The media could not be added.";
    return false;
  }
}

function setCatalogBrowserCardFeedback(button, label) {
  const action = button.querySelector(".media-browser-card-action");
  if (action) action.textContent = label;
  button.classList.add("media-browser-card-added");
  window.setTimeout(() => {
    if (!button.isConnected) return;
    if (action) action.textContent = "Choose";
    button.classList.remove("media-browser-card-added");
  }, 1600);
}

async function handleCopyQueueAction(event) {
  const button = event.target.closest("[data-copy-queue-action]");
  if (!button) return;
  const queue = copyQueues.find((entry) => entry.id === button.dataset.queueId);
  if (!queue) return;
  const action = button.dataset.copyQueueAction;
  if (action === "select") {
    selectCopyQueue(queue.id);
    return;
  }
  try {
    let result;
    if (action === "remove") {
      result = await api(`/api/copy-queues/${encodeURIComponent(queue.id)}/items/${encodeURIComponent(button.dataset.itemId)}`, state.token, { method: "DELETE" });
    } else if (action === "up" || action === "down") {
      const future = queue.items.filter((item) => item.status === "ready" || item.status === "queued");
      const index = future.findIndex((item) => item.id === button.dataset.itemId);
      const target = action === "up" ? index - 1 : index + 1;
      if (index < 0 || target < 0 || target >= future.length) return;
      [future[index], future[target]] = [future[target], future[index]];
      result = await api(`/api/copy-queues/${encodeURIComponent(queue.id)}/order`, state.token, {
        method: "PUT",
        body: JSON.stringify({ itemIds: future.map((item) => item.id) })
      });
    }
    if (result && result.queue) {
      replaceCopyQueue(result.queue);
      selectCopyQueue(result.queue.id);
    }
  } catch (err) {
    els.copyQueueStatus.textContent = err.message || "The stream could not be updated.";
  }
}

function replaceCopyQueue(queue) {
  copyQueues = copyQueues.map((entry) => entry.id === queue.id ? queue : entry);
}

async function updateSelectedCopyQueue(action) {
  const queue = copyQueues.find((entry) => entry.id === selectedCopyQueueId);
  if (!queue) return;
  try {
    const result = await api(`/api/copy-queues/${encodeURIComponent(queue.id)}/${action}`, state.token, { method: "POST" });
    replaceCopyQueue(result.queue);
    selectCopyQueue(result.queue.id);
  } catch (err) {
    els.copyQueueStatus.textContent = err.message || "The stream could not be updated.";
  }
}

async function stopSelectedCopyQueue() {
  const queue = copyQueues.find((entry) => entry.id === selectedCopyQueueId);
  if (!queue || !window.confirm(`Stop ${queue.name}? Its playback URL will stop working.`)) return;
  try {
    await api(`/api/copy-queues/${encodeURIComponent(queue.id)}`, state.token, { method: "DELETE" });
    forgetCopyQueueUrl(queue.id);
    copyQueues = copyQueues.filter((entry) => entry.id !== queue.id);
    if (copyQueues.length > 0) selectCopyQueue(copyQueues[0].id);
    else showEmptyStreamQueueEditor();
  } catch (err) {
    els.copyQueueStatus.textContent = err.message || "The stream could not be stopped.";
  }
}

async function copyCurrentStreamUrl() {
  const url = rememberedCopyQueueUrls()[selectedCopyQueueId];
  if (!url) return;
  try {
    await writeClipboard(url);
    els.copyQueueStatus.textContent = "Playback URL copied.";
  } catch (err) {
    els.copyQueueUrl.value = url;
    els.copyQueueCreatedUrl.classList.remove("hidden");
  }
}

function rememberedCopyQueueUrls() {
  try { return JSON.parse(localStorage.getItem("mediaBakerCopyQueueUrls") || "{}"); } catch (err) { return {}; }
}

function rememberCopyQueueUrl(queueId, url) {
  const urls = rememberedCopyQueueUrls();
  urls[queueId] = url;
  localStorage.setItem("mediaBakerCopyQueueUrls", JSON.stringify(urls));
}

function forgetCopyQueueUrl(queueId) {
  const urls = rememberedCopyQueueUrls();
  delete urls[queueId];
  localStorage.setItem("mediaBakerCopyQueueUrls", JSON.stringify(urls));
}

async function startWatchTogether() {
  if (!state.selected || !hasPermission("canCopyStreamUrls")) return;
  els.startWatchTogether.disabled = true;
  els.copyStatus.textContent = "Creating Watch Together room...";
  try {
    const result = await api("/api/watch-together/rooms", state.token, {
      method: "POST",
      body: JSON.stringify({
        mediaType: state.selected.mediaType,
        mediaId: state.selected.id,
        audio: els.audioSelect.value,
        subtitle: els.subtitleSelect.value,
        audioChannels: selectedAudioChannels(),
        quality: selectedQuality()
      })
    });
    closeDetails();
    navigation.navigate(navigation.watchPath(result.inviteToken));
    await joinWatchTogether(result.inviteToken);
  } catch (err) {
    els.copyStatus.textContent = err.message || "Could not create the Watch Together room.";
  } finally {
    els.startWatchTogether.disabled = false;
  }
}

async function openWatchTogether(inviteToken) {
  if (watchTogetherSession && watchTogetherSession.inviteToken === inviteToken) return;
  pendingWatchTogetherInvite = inviteToken;
  els.loginOverlay.classList.add("hidden");
  if (state.user) {
    await joinWatchTogether(inviteToken);
    return;
  }
  els.watchTogetherJoinStatus.textContent = "";
  els.watchTogetherGuestName.value = sessionStorage.getItem("mediaBakerWatchTogetherName") || "";
  els.watchTogetherJoinOverlay.classList.remove("hidden");
  els.watchTogetherJoinOverlay.setAttribute("aria-hidden", "false");
  window.setTimeout(() => els.watchTogetherGuestName.focus(), 0);
}

async function submitWatchTogetherGuestName(event) {
  event.preventDefault();
  const name = els.watchTogetherGuestName.value.trim();
  if (!name || !pendingWatchTogetherInvite) return;
  sessionStorage.setItem("mediaBakerWatchTogetherName", name);
  els.watchTogetherJoinStatus.textContent = "Joining...";
  try {
    await joinWatchTogether(pendingWatchTogetherInvite, name);
  } catch (err) {
    els.watchTogetherJoinStatus.textContent = err.message || "Could not join this room.";
  }
}

async function joinWatchTogether(inviteToken, name = "") {
  const clientId = watchTogetherClientId();
  const joined = await api("/api/watch-together/join", state.token, {
    method: "POST",
    body: JSON.stringify({ inviteToken, name, clientId })
  });
  els.watchTogetherJoinOverlay.classList.add("hidden");
  els.watchTogetherJoinOverlay.setAttribute("aria-hidden", "true");
  pendingWatchTogetherInvite = null;
  const initialState = joined.state || {
    state: "paused",
    positionSeconds: 0,
    changedAt: new Date().toISOString(),
    serverTime: new Date().toISOString(),
    readinessRevision: 0
  };
  const initialPosition = watchTogetherStatePosition(initialState);

  const playbackOpening = openWebPlayer(new URL(joined.streamUrl, window.location.origin), {
    category: joined.category || joined.room.libraryTitle,
    title: joined.title || joined.room.mediaTitle,
    autoplay: false,
    resumeSeconds: initialPosition,
    startAtBeginning: initialPosition <= 0.25,
    autoAdvance: false,
    skipMarkers: joined.skipMarkers || joined.room.skipMarkers,
    errorMessage: "The Watch Together stream could not be played.",
    hlsOptions: { lowLatencyMode: false, backBufferLength: 90, startPosition: initialPosition }
  });
  activePlaybackMedia = null;
  watchTogetherSession = {
    inviteToken,
    inviteUrl: `${window.location.origin}${navigation.watchPath(inviteToken)}`,
    ...joined,
    socket: null,
    reconnectTimer: null,
    closed: false,
    lastProgressAt: 0,
    participants: [],
    bufferReady: null
  };
  watchTogetherPanelView = "chat";
  els.playerOverlay.classList.add("watch-together-player");
  els.toggleWatchTogetherPanel.classList.remove("hidden");
  els.minimizeVideoPlayer.classList.add("hidden");
  setWatchTogetherPanelOpen(true);
  renderWatchTogetherRoom(joined.room);
  connectWatchTogetherSocket();
  try {
    await playbackOpening;
  } catch (err) {
    leaveWatchTogether({ navigate: false });
    throw err;
  }
}

function setWatchTogetherPanelOpen(open) {
  const isOpen = Boolean(open && watchTogetherSession);
  els.watchTogetherPanel.classList.toggle("hidden", !isOpen);
  els.playerOverlay.classList.toggle("watch-together-panel-open", isOpen);
  els.toggleWatchTogetherPanel.setAttribute("aria-expanded", String(isOpen));
  if (isOpen) updateWatchTogetherPanelView();
}

function selectWatchTogetherPanelView(event) {
  if (event.target.closest("[data-watch-panel-close]")) {
    watchTogetherPanelView = "chat";
    updateWatchTogetherPanelView();
    return;
  }
  const button = event.target.closest("[data-watch-panel-view]");
  if (!button || button.classList.contains("hidden")) return;
  watchTogetherPanelView = watchTogetherPanelView === button.dataset.watchPanelView
    ? "chat"
    : button.dataset.watchPanelView;
  updateWatchTogetherPanelView();
}

function updateWatchTogetherPanelView() {
  const session = watchTogetherSession;
  const isHost = Boolean(session && session.participant && session.participant.isHost);
  if (watchTogetherPanelView === "room" && !isHost) watchTogetherPanelView = "chat";
  for (const button of els.watchTogetherPanel.querySelectorAll("[data-watch-panel-view]")) {
    const active = button.dataset.watchPanelView === watchTogetherPanelView;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  }
  for (const section of els.watchTogetherPanel.querySelectorAll("[data-watch-panel-content]")) {
    section.classList.toggle("hidden", section.dataset.watchPanelContent !== watchTogetherPanelView);
  }
}

function openWatchTogetherMediaBrowser() {
  if (!watchTogetherSession || els.openWatchTogetherMediaBrowser.classList.contains("hidden")) return;
  resetWatchTogetherPreviewPosition();
  resetWatchTogetherMediaBrowser();
  watchTogetherPanelView = "chat";
  updateWatchTogetherPanelView();
  els.watchTogetherMediaBrowser.classList.remove("hidden");
  els.playerOverlay.classList.add("watch-together-search-open");
  window.setTimeout(() => els.watchTogetherQueueSearch.focus(), 0);
}

function closeWatchTogetherMediaBrowser() {
  resetWatchTogetherPreviewPosition();
  watchTogetherMediaBrowserRequestId += 1;
  watchTogetherMediaBrowserTrail = [];
  els.watchTogetherMediaBrowser.classList.add("hidden");
  els.playerOverlay.classList.remove("watch-together-search-open");
  els.watchTogetherQueueSearchResults.replaceChildren();
  els.watchTogetherQueueSearch.value = "";
}

function resetWatchTogetherMediaBrowser() {
  watchTogetherMediaBrowserRequestId += 1;
  watchTogetherMediaBrowserTrail = [];
  els.watchTogetherMediaBrowserBack.classList.add("hidden");
  els.watchTogetherMediaBrowserContext.textContent = "Watch Together";
  els.watchTogetherMediaBrowserTitle.textContent = "Add media";
  els.watchTogetherQueueSearchResults.replaceChildren();
  els.watchTogetherQueueSearch.value = "";
}

function beginWatchTogetherPreviewDrag(event) {
  if (event.button !== 0 || !els.playerOverlay.classList.contains("watch-together-search-open")) return;
  const previewRect = els.videoPlayerSlot.getBoundingClientRect();
  watchTogetherPreviewDragState = {
    pointerId: event.pointerId,
    offsetX: event.clientX - previewRect.left,
    offsetY: event.clientY - previewRect.top
  };
  els.watchTogetherPreviewDrag.setPointerCapture?.(event.pointerId);
  els.videoPlayerSlot.classList.add("dragging");
  event.preventDefault();
  event.stopPropagation();
}

function moveWatchTogetherPreview(event) {
  const drag = watchTogetherPreviewDragState;
  if (!drag || drag.pointerId !== event.pointerId) return;
  const shell = els.videoPlayerSlot.closest(".player-shell");
  if (!shell) return;
  const shellRect = shell.getBoundingClientRect();
  const maxLeft = Math.max(0, shellRect.width - els.videoPlayerSlot.offsetWidth);
  const maxTop = Math.max(0, shellRect.height - els.videoPlayerSlot.offsetHeight);
  const left = Math.min(maxLeft, Math.max(0, event.clientX - shellRect.left - drag.offsetX));
  const top = Math.min(maxTop, Math.max(0, event.clientY - shellRect.top - drag.offsetY));
  els.videoPlayerSlot.style.left = `${Math.round(left)}px`;
  els.videoPlayerSlot.style.top = `${Math.round(top)}px`;
  els.videoPlayerSlot.style.right = "auto";
  event.preventDefault();
}

function endWatchTogetherPreviewDrag(event) {
  const drag = watchTogetherPreviewDragState;
  if (!drag || drag.pointerId !== event.pointerId) return;
  if (els.watchTogetherPreviewDrag.hasPointerCapture?.(event.pointerId)) {
    els.watchTogetherPreviewDrag.releasePointerCapture(event.pointerId);
  }
  watchTogetherPreviewDragState = null;
  els.videoPlayerSlot.classList.remove("dragging");
}

function resetWatchTogetherPreviewPosition() {
  watchTogetherPreviewDragState = null;
  els.videoPlayerSlot.classList.remove("dragging");
  els.videoPlayerSlot.style.removeProperty("left");
  els.videoPlayerSlot.style.removeProperty("top");
  els.videoPlayerSlot.style.removeProperty("right");
}

function watchTogetherClientId() {
  let value = sessionStorage.getItem("mediaBakerWatchTogetherClientId");
  if (!value) {
    const bytes = new Uint8Array(18);
    crypto.getRandomValues(bytes);
    value = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    sessionStorage.setItem("mediaBakerWatchTogetherClientId", value);
  }
  return value;
}

function connectWatchTogetherSocket() {
  const session = watchTogetherSession;
  if (!session || session.closed) return;
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${window.location.host}/api/watch-together/socket?ticket=${encodeURIComponent(session.ticket)}`);
  session.socket = socket;
  socket.addEventListener("open", () => clearPlayerStatus("Connection interrupted. Reconnecting..."));
  socket.addEventListener("message", (event) => handleWatchTogetherMessage(event.data));
  socket.addEventListener("close", (event) => {
    if (!watchTogetherSession || watchTogetherSession !== session || session.closed) return;
    if (event.code === 4003) return;
    setPlayerStatus("Connection interrupted. Reconnecting...");
    clearTimeout(session.reconnectTimer);
    session.reconnectTimer = window.setTimeout(connectWatchTogetherSocket, 2000);
  });
}

function handleWatchTogetherMessage(raw) {
  let message;
  try { message = JSON.parse(raw); } catch (err) { return; }
  const session = watchTogetherSession;
  if (!session) return;
  if (message.type === "welcome") {
    session.room = message.room;
    session.participant = message.self;
    session.participants = message.participants || [];
    session.bufferReady = null;
    renderWatchTogetherRoom(message.room);
    renderWatchTogetherParticipants(message.participants || []);
    els.watchTogetherChat.innerHTML = "";
    (message.chat || []).forEach(renderWatchTogetherMessage);
    applyWatchTogetherState(message.state, true);
    notifyWatchTogetherReady();
    clearPlayerStatus("Connection interrupted. Reconnecting...");
    return;
  }
  if (message.type === "state") {
    if (message.reason === "seek") session.bufferReady = null;
    applyWatchTogetherState(message.state, message.reason !== "sync");
    if (message.reason === "seek") window.setTimeout(notifyWatchTogetherReady, 0);
    return;
  }
  if (message.type === "participants") {
    session.participants = message.participants || [];
    renderWatchTogetherParticipants(message.participants || []);
    return;
  }
  if (message.type === "room") {
    session.room = message.room;
    renderWatchTogetherRoom(message.room);
    return;
  }
  if (message.type === "item") {
    switchWatchTogetherPlayback(message.playback, message.room).catch(() => {
      setPlayerStatus("The next queued item could not be loaded.");
    });
    return;
  }
  if (message.type === "chat") {
    renderWatchTogetherMessage(message.message);
    return;
  }
  if (message.type === "error") {
    setTemporaryPlayerStatus(message.message || "The room action could not be completed.");
    return;
  }
  if (message.type === "kicked") {
    showWatchTogetherEndedPage();
    return;
  }
  if (message.type === "room-closed") {
    showWatchTogetherEndedPage();
  }
}

function showWatchTogetherEndedPage() {
  closePlayer({ navigate: false });
  window.location.replace(navigation.watchEndedPath());
}

async function switchWatchTogetherPlayback(playback, room) {
  const session = watchTogetherSession;
  if (!session || !playback || !playback.streamUrl) return;
  if (session.queueItemId === playback.queueItemId
    && Number(session.queueRevision) === Number(playback.queueRevision)) return;
  reportWatchTogetherProgress(true);
  session.queueItemId = playback.queueItemId;
  session.queueRevision = playback.queueRevision;
  session.bufferReady = null;
  session.trackSwitching = false;
  session.room = room || session.room;
  session.state = {
    state: "paused",
    positionSeconds: 0,
    changedAt: new Date().toISOString(),
    serverTime: new Date().toISOString()
  };
  pendingWatchTogetherState = session.state;
  renderWatchTogetherRoom(session.room);
  await openWebPlayer(new URL(playback.streamUrl, window.location.origin), {
    preserveWatchTogether: true,
    category: playback.category || session.room.libraryTitle,
    title: playback.title || session.room.mediaTitle,
    autoplay: false,
    resumeSeconds: 0,
    startAtBeginning: true,
    autoAdvance: false,
    skipMarkers: playback.skipMarkers || [],
    errorMessage: "The queued Watch Together item could not be played.",
    hlsOptions: { lowLatencyMode: false, backBufferLength: 90 }
  });
}

function renderWatchTogetherRoom(room) {
  if (!watchTogetherSession) return;
  watchTogetherSession.room = room;
  const isHost = Boolean(watchTogetherSession.participant && watchTogetherSession.participant.isHost);
  els.watchTogetherHostControls.classList.toggle("hidden", !isHost);
  els.watchTogetherRoomTab.classList.toggle("hidden", !isHost);
  els.watchTogetherEveryoneControls.checked = Boolean(room.everyoneCanControl);
  els.watchTogetherEveryoneQueues.checked = Boolean(room.everyoneCanQueue);
  const canAdd = Boolean(state.user && (isHost || room.everyoneCanQueue));
  els.openWatchTogetherMediaBrowser.classList.toggle("hidden", !canAdd);
  if (!canAdd) closeWatchTogetherMediaBrowser();
  updateWatchTogetherPanelView();
  renderWatchTogetherQueue(room);
  updateSkipMarkerControl();
  updateWatchTogetherRoomStatus();
}

function renderWatchTogetherQueue(room) {
  const session = watchTogetherSession;
  if (!session) return;
  const isHost = Boolean(session.participant && session.participant.isHost);
  const canControl = watchTogetherCanControl();
  els.watchTogetherSkipQueueItem.classList.toggle("hidden", !canControl || !room.currentQueueItemId);
  els.watchTogetherQueue.innerHTML = "";
  const future = (room.queue || []).filter((item) => item.status === "queued");
  for (const item of room.queue || []) {
    const row = document.createElement("div");
    row.className = `watch-together-queue-item ${item.status}`;
    const futureIndex = future.findIndex((entry) => entry.id === item.id);
    const stateLabel = item.status === "current" ? "Playing now" : item.status === "queued" ? "Up next" : "Played";
    row.innerHTML = `
      <div class="watch-together-queue-label" title="${escapeHtml(item.title)}">
        <strong>${escapeHtml(item.title)}</strong>
        <small>${escapeHtml(item.libraryTitle || stateLabel)} - ${stateLabel}</small>
      </div>
      ${isHost && item.status === "queued" ? `<div class="watch-together-queue-actions">
        <button class="music-icon-button" type="button" title="Move up" data-watch-queue-action="up" data-item-id="${escapeHtml(item.id)}" ${futureIndex <= 0 ? "disabled" : ""}>&#8593;</button>
        <button class="music-icon-button" type="button" title="Move down" data-watch-queue-action="down" data-item-id="${escapeHtml(item.id)}" ${futureIndex >= future.length - 1 ? "disabled" : ""}>&#8595;</button>
        <button class="music-icon-button" type="button" title="Remove" data-watch-queue-action="remove" data-item-id="${escapeHtml(item.id)}">x</button>
      </div>` : ""}`;
    els.watchTogetherQueue.appendChild(row);
  }
}

function handleWatchTogetherQueueAction(event) {
  const button = event.target.closest("[data-watch-queue-action]");
  const session = watchTogetherSession;
  if (!button || !session || !session.participant || !session.participant.isHost) return;
  const action = button.dataset.watchQueueAction;
  if (action === "remove") {
    sendWatchTogether({ type: "queue-remove", itemId: button.dataset.itemId });
    return;
  }
  const future = (session.room.queue || []).filter((item) => item.status === "queued");
  const index = future.findIndex((item) => item.id === button.dataset.itemId);
  const target = action === "up" ? index - 1 : index + 1;
  if (index < 0 || target < 0 || target >= future.length) return;
  [future[index], future[target]] = [future[target], future[index]];
  sendWatchTogether({ type: "queue-order", itemIds: future.map((item) => item.id) });
}

async function searchWatchTogetherQueueMedia(event) {
  event.preventDefault();
  const query = els.watchTogetherQueueSearch.value.trim();
  if (!query || !watchTogetherSession || !state.user) return;
  const requestId = ++watchTogetherMediaBrowserRequestId;
  els.watchTogetherMediaBrowserContext.textContent = "Watch Together";
  els.watchTogetherMediaBrowserTitle.textContent = `Search: ${query}`;
  els.watchTogetherMediaBrowserBack.classList.add("hidden");
  els.watchTogetherQueueSearchResults.innerHTML = '<p class="status">Searching...</p>';
  try {
    const result = await api(`/api/catalog/search?q=${encodeURIComponent(query)}`, state.token);
    if (requestId !== watchTogetherMediaBrowserRequestId || els.watchTogetherMediaBrowser.classList.contains("hidden")) return;
    const items = catalogBrowserSearchResults(result.results);
    showWatchTogetherMediaBrowserScreen({
      context: "Search results",
      title: query,
      items
    }, { replace: true });
  } catch (err) {
    if (requestId !== watchTogetherMediaBrowserRequestId) return;
    els.watchTogetherQueueSearchResults.innerHTML = `<p class="status error">${escapeHtml(err.message || "Search failed.")}</p>`;
  }
}

function catalogBrowserSearchResults(results) {
  return (results || []).filter((item) => item && item.id && item.mediaType
    && !["image", "image-folder", "media-folder", "playlist"].includes(item.itemType)).slice(0, 60);
}

function showWatchTogetherMediaBrowserScreen(screen, options = {}) {
  watchTogetherMediaBrowserTrail = options.replace
    ? [screen]
    : [...watchTogetherMediaBrowserTrail, screen];
  renderWatchTogetherMediaBrowserScreen(screen);
}

function renderWatchTogetherMediaBrowserScreen(screen) {
  els.watchTogetherMediaBrowserContext.textContent = screen.context || "Watch Together";
  els.watchTogetherMediaBrowserTitle.textContent = screen.title || "Add media";
  els.watchTogetherMediaBrowserBack.classList.toggle("hidden", watchTogetherMediaBrowserTrail.length < 2);
  els.watchTogetherQueueSearchResults.replaceChildren();
  if (!screen.items || screen.items.length === 0) {
    els.watchTogetherQueueSearchResults.innerHTML = '<p class="status">No media found.</p>';
    return;
  }
  for (const item of screen.items) {
    const navigable = catalogBrowserItemIsNavigable(item);
    els.watchTogetherQueueSearchResults.appendChild(card(item, {
      browserCard: true,
      episodeArtwork: "thumbnail",
      actionLabel: navigable ? "Open" : "Add",
      onActivate: activateWatchTogetherMediaBrowserItem
    }));
  }
}

function navigateBackWatchTogetherMediaBrowser() {
  if (watchTogetherMediaBrowserTrail.length < 2) return;
  watchTogetherMediaBrowserRequestId += 1;
  watchTogetherMediaBrowserTrail.pop();
  renderWatchTogetherMediaBrowserScreen(watchTogetherMediaBrowserTrail[watchTogetherMediaBrowserTrail.length - 1]);
}

function catalogBrowserItemIsNavigable(item) {
  return isShowCard(item)
    || (item.itemType === "season" && item.showId)
    || isArtistCard(item)
    || (isAlbumCard(item) && item.artistId);
}

async function activateWatchTogetherMediaBrowserItem(item, button) {
  if (!watchTogetherSession || button.disabled) return;
  if (!catalogBrowserItemIsNavigable(item)) {
    addWatchTogetherMediaBrowserItem(item, button);
    return;
  }

  button.disabled = true;
  const requestId = ++watchTogetherMediaBrowserRequestId;
  els.watchTogetherQueueSearchResults.innerHTML = '<p class="status">Loading...</p>';
  try {
    const screen = await catalogBrowserScreenForItem(item);
    if (requestId !== watchTogetherMediaBrowserRequestId || els.watchTogetherMediaBrowser.classList.contains("hidden")) return;
    showWatchTogetherMediaBrowserScreen(screen);
  } catch (err) {
    if (requestId !== watchTogetherMediaBrowserRequestId) return;
    renderWatchTogetherMediaBrowserScreen(watchTogetherMediaBrowserTrail[watchTogetherMediaBrowserTrail.length - 1]);
    const error = document.createElement("p");
    error.className = "status error watch-together-browser-error";
    error.textContent = err.message || "The collection could not be opened.";
    els.watchTogetherQueueSearchResults.prepend(error);
  }
}

async function catalogBrowserScreenForItem(item) {
  if (isShowCard(item)) return catalogShowBrowserScreen(item);
  if (item.itemType === "season") return catalogSeasonBrowserScreen(item);
  if (isArtistCard(item)) return catalogArtistBrowserScreen(item);
  return catalogAlbumBrowserScreen(item);
}

async function catalogShowBrowserScreen(item) {
  const show = await api(`${tvBasePath(item.mediaType)}/${encodeURIComponent(item.showId || item.id)}`, state.token);
  return {
    context: "Show",
    title: show.name || item.title,
    items: (show.seasons || []).map((season) => seasonItem(item.mediaType, show, season))
  };
}

async function catalogSeasonBrowserScreen(item) {
  const showId = item.showId;
  const [show, seasonResponse] = await Promise.all([
    api(`${tvBasePath(item.mediaType)}/${encodeURIComponent(showId)}`, state.token),
    api(`${tvBasePath(item.mediaType)}/${encodeURIComponent(showId)}/seasons/${encodeURIComponent(item.season)}`, state.token)
  ]);
  const seasonMetadata = (show.seasons || []).find((entry) => Number(entry.season) === Number(item.season)) || {};
  const season = { ...seasonMetadata, ...seasonResponse };
  return {
    context: show.name || "Show",
    title: season.name || defaultSeasonTitle(season.season),
    items: (season.episodes || []).map((episode) => episodeItem(item.mediaType, show, episode))
  };
}

async function catalogArtistBrowserScreen(item) {
  const artist = await api(`${tvBasePath(item.mediaType)}/${encodeURIComponent(item.artistId || item.id)}`, state.token);
  return {
    context: "Artist",
    title: artist.name || item.title,
    items: (artist.albums || []).map((album) => ({
      id: album.id,
      itemType: "album",
      mediaType: item.mediaType,
      artistId: artist.id,
      title: album.name || "Album",
      subtitle: `${(album.tracks || []).length} tracks`,
      posterUrl: album.posterUrl || artist.posterUrl || null
    }))
  };
}

async function catalogAlbumBrowserScreen(item) {
  const [artist, album] = await Promise.all([
    api(`${tvBasePath(item.mediaType)}/${encodeURIComponent(item.artistId)}`, state.token),
    api(`${tvBasePath(item.mediaType)}/${encodeURIComponent(item.artistId)}/albums/${encodeURIComponent(item.albumId || item.id)}`, state.token)
  ]);
  return {
    context: artist.name || "Artist",
    title: album.name || item.title,
    items: (album.tracks || []).map((track) => trackItem(item.mediaType, artist, album, track))
  };
}

function addWatchTogetherMediaBrowserItem(item, button) {
  const sent = sendWatchTogether({
    type: "queue-add",
    mediaType: item.mediaType,
    mediaId: item.mediaId || item.id,
    streamOptions: {
      audioChannels: state.playbackPreferences.audioChannels,
      quality: state.playbackPreferences.quality,
      subtitle: "none"
    }
  });
  const action = button.querySelector(".media-browser-card-action");
  if (!sent) {
    if (action) action.textContent = "Try again";
    return;
  }
  if (action) action.textContent = "Added";
  button.classList.add("media-browser-card-added");
  window.setTimeout(() => {
    if (!button.isConnected) return;
    if (action) action.textContent = "Add";
    button.classList.remove("media-browser-card-added");
  }, 1600);
}

function renderWatchTogetherParticipants(participants) {
  els.watchTogetherParticipants.innerHTML = "";
  const session = watchTogetherSession;
  for (const participant of participants) {
    const row = document.createElement("div");
    row.className = "watch-together-participant";
    const details = document.createElement("div");
    const connectionState = participant.connected
      ? participant.ready ? "Ready" : "Buffering"
      : participant.blocksPlayback ? "Joining" : "Offline";
    details.innerHTML = `<strong>${escapeHtml(participant.name)}</strong><div class="watch-together-participant-meta">${participant.isHost ? "Host" : participant.loggedIn ? "Signed in" : "Guest"} - ${connectionState}</div>`;
    row.appendChild(details);
    if (session && session.participant && session.participant.isHost && !participant.isHost) {
      const kick = document.createElement("button");
      kick.className = "secondary-button compact-button";
      kick.type = "button";
      kick.dataset.participantId = participant.id;
      kick.textContent = "Kick";
      row.appendChild(kick);
    }
    els.watchTogetherParticipants.appendChild(row);
  }
  updateWatchTogetherRoomStatus();
  updateVideoPlayerControls();
}

function watchTogetherWaitingParticipants() {
  const participants = watchTogetherSession && watchTogetherSession.participants || [];
  return participants.filter((participant) => participant.blocksPlayback && !participant.ready);
}

function watchTogetherCanStart() {
  const participants = watchTogetherSession && watchTogetherSession.participants || [];
  const required = participants.filter((participant) => participant.blocksPlayback);
  return required.length > 0 && required.every((participant) => participant.ready);
}

function updateWatchTogetherRoomStatus() {
  const session = watchTogetherSession;
  if (!session || !session.room) return;
  const waiting = watchTogetherWaitingParticipants();
  if (session.state && session.state.state === "playing") {
    els.watchTogetherRoomStatus.textContent = "Playing";
    return;
  }
  if (waiting.length > 0) {
    els.watchTogetherRoomStatus.textContent = `Waiting for ${waiting.length} participant${waiting.length === 1 ? "" : "s"} to buffer`;
    return;
  }
  els.watchTogetherRoomStatus.textContent = session.room.everyoneCanControl
    ? "Everyone can control playback"
    : `Hosted by ${session.room.hostName}`;
}

function renderWatchTogetherMessage(message) {
  if (!message) return;
  const row = document.createElement("div");
  row.className = `watch-together-message${message.type === "system" ? " system" : ""}`;
  if (message.type === "system") {
    row.textContent = message.text;
  } else {
    row.innerHTML = `<strong>${escapeHtml(message.name || "Guest")}</strong>${escapeHtml(message.text || "")}`;
  }
  els.watchTogetherChat.appendChild(row);
  els.watchTogetherChat.scrollTop = els.watchTogetherChat.scrollHeight;
}

function sendWatchTogetherChat(event) {
  event.preventDefault();
  const text = els.watchTogetherChatInput.value.trim();
  if (!text || !sendWatchTogether({ type: "chat", text })) return;
  els.watchTogetherChatInput.value = "";
}

function kickWatchTogetherParticipant(event) {
  const button = event.target.closest("[data-participant-id]");
  if (button) sendWatchTogether({ type: "kick", participantId: button.dataset.participantId });
}

function changeWatchTogetherControls() {
  sendWatchTogether({
    type: "permissions",
    everyoneCanControl: els.watchTogetherEveryoneControls.checked,
    everyoneCanQueue: els.watchTogetherEveryoneQueues.checked
  });
}

async function copyWatchTogetherInvite() {
  const session = watchTogetherSession;
  if (!session) return;
  const inviteUrl = session.inviteUrl || `${window.location.origin}${navigation.watchPath(session.inviteToken)}`;
  try {
    await writeClipboard(inviteUrl);
    els.watchTogetherInviteFallback.classList.add("hidden");
    els.watchTogetherRoomStatus.textContent = "Invite link copied";
  } catch (err) {
    els.watchTogetherInviteFallback.value = inviteUrl;
    els.watchTogetherInviteFallback.classList.remove("hidden");
    els.watchTogetherInviteFallback.focus();
    els.watchTogetherInviteFallback.select();
    els.watchTogetherRoomStatus.textContent = "Select the invite link to copy it";
  }
}

function closeWatchTogetherRoom() {
  if (window.confirm("Close this Watch Together room for everyone?")) sendWatchTogether({ type: "close-room" });
}

function sendWatchTogether(message) {
  const socket = watchTogetherSession && watchTogetherSession.socket;
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(message));
  return true;
}

function watchTogetherCanControl() {
  const session = watchTogetherSession;
  return Boolean(session && session.participant && (session.participant.isHost || session.room.everyoneCanControl));
}

function sendWatchTogetherLocalState(action) {
  if (!watchTogetherSession || Date.now() < watchTogetherSuppressControlsUntil) return;
  if (!watchTogetherCanControl()) {
    if (watchTogetherSession.state) {
      window.setTimeout(() => applyWatchTogetherState(watchTogetherSession && watchTogetherSession.state, true), 0);
    }
    return;
  }
  const roomPlaying = watchTogetherSession.state && watchTogetherSession.state.state === "playing";
  if ((action === "play" && roomPlaying) || (action === "pause" && !roomPlaying)) return;
  if (action === "play" && !watchTogetherCanStart()) {
    watchTogetherSuppressControlsUntil = Date.now() + 1000;
    els.webPlayer.pause();
    return;
  }
  const positionSeconds = action === "play"
    ? watchTogetherStatePosition(watchTogetherSession.state)
    : Number(els.webPlayer.currentTime) || 0;
  sendWatchTogether({ type: "control", action, positionSeconds });
}

function applyWatchTogetherState(roomState, force = false) {
  if (!watchTogetherSession || !roomState) return;
  watchTogetherSession.state = roomState;
  watchTogetherSession.readinessRevision = Number(roomState.readinessRevision) || 0;
  updateWatchTogetherRoomStatus();
  updateVideoPlayerControls();
  if (!Number.isFinite(Number(els.webPlayer.duration)) || Number(els.webPlayer.duration) <= 0) {
    pendingWatchTogetherState = roomState;
    return;
  }
  pendingWatchTogetherState = null;
  const expected = watchTogetherStatePosition(roomState);
  const drift = expected - (Number(els.webPlayer.currentTime) || 0);
  watchTogetherSuppressControlsUntil = Date.now() + 1000;
  if (watchTogetherSession.trackSwitching) {
    els.webPlayer.playbackRate = 1;
    if (roomState.state !== "playing") els.webPlayer.pause();
    updateWatchTogetherRoomStatus();
    return;
  }
  if (force || Math.abs(drift) > 1.5) {
    els.webPlayer.currentTime = expected;
    els.webPlayer.playbackRate = 1;
  } else if (roomState.state === "playing" && Math.abs(drift) > 0.3) {
    els.webPlayer.playbackRate = drift > 0 ? 1.03 : 0.97;
  } else {
    els.webPlayer.playbackRate = 1;
  }
  if (roomState.state === "playing") {
    els.webPlayer.play().catch(() => setPlayerStatus("Press play to allow synchronized playback."));
  } else {
    els.webPlayer.pause();
  }
  updateWatchTogetherRoomStatus();
  window.setTimeout(() => {
    if (els.webPlayer.playbackRate !== 1 && Math.abs(expected - (Number(els.webPlayer.currentTime) || 0)) < 0.3) {
      els.webPlayer.playbackRate = 1;
    }
  }, 3000);
}

function watchTogetherStatePosition(roomState) {
  if (!roomState) return 0;
  const transportSeconds = roomState.state === "playing"
    ? Math.max(0, Date.now() - Date.parse(roomState.serverTime || new Date())) / 1000
    : 0;
  return Math.max(0, (Number(roomState.positionSeconds) || 0) + transportSeconds);
}

function notifyWatchTogetherReady() {
  if (!watchTogetherSession) return;
  const video = els.webPlayer;
  const playerDuration = Number(video.duration);
  const roomDuration = Number(watchTogetherSession.room && watchTogetherSession.room.durationSeconds);
  const durationSeconds = Number.isFinite(playerDuration) && playerDuration > 0
    ? playerDuration
    : Number.isFinite(roomDuration) && roomDuration > 0 ? roomDuration : 0;
  const positionSeconds = Number(video.currentTime) || 0;
  const remainingSeconds = Math.max(0, durationSeconds - positionSeconds);
  const requiredSeconds = Math.min(18, remainingSeconds);
  const bufferedSeconds = bufferedAheadSeconds(video, positionSeconds);
  const hasPlayableData = video.readyState >= 3; // HTMLMediaElement.HAVE_FUTURE_DATA
  const ready = durationSeconds > 0
    && (remainingSeconds <= 0.25
      || bufferedSeconds >= Math.max(0, requiredSeconds - 0.25)
      || hasPlayableData);
  if (watchTogetherSession.bufferReady !== ready) {
    watchTogetherSession.bufferReady = ready;
    sendWatchTogether({
      type: "ready",
      ready,
      durationSeconds,
      bufferedSeconds,
      queueRevision: watchTogetherSession.queueRevision,
      readinessRevision: watchTogetherSession.readinessRevision
    });
  }
  if (pendingWatchTogetherState) applyWatchTogetherState(pendingWatchTogetherState, true);
}

function bufferedAheadSeconds(video, positionSeconds) {
  const ranges = video && video.buffered;
  if (!ranges) return 0;
  for (let index = 0; index < ranges.length; index += 1) {
    const start = ranges.start(index);
    const end = ranges.end(index);
    if (positionSeconds >= start - 0.25 && positionSeconds <= end + 0.05) {
      return Math.max(0, end - Math.max(positionSeconds, start));
    }
  }
  return 0;
}

function reportWatchTogetherProgress(force = false) {
  const session = watchTogetherSession;
  if (!session || !state.user || !force && Date.now() - session.lastProgressAt < 5000) return;
  const durationSeconds = Number(els.webPlayer.duration);
  const positionSeconds = Number(els.webPlayer.currentTime);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || !Number.isFinite(positionSeconds)) return;
  session.lastProgressAt = Date.now();
  sendWatchTogether({ type: "progress", positionSeconds, durationSeconds });
}

function leaveWatchTogether(options = {}) {
  const session = watchTogetherSession;
  if (!session) return;
  session.closed = true;
  clearTimeout(session.reconnectTimer);
  session.socket?.close(1000, "Left room");
  watchTogetherSession = null;
  pendingWatchTogetherState = null;
  watchTogetherPanelView = "chat";
  closeWatchTogetherMediaBrowser();
  els.playerOverlay.classList.remove("watch-together-player");
  setWatchTogetherPanelOpen(false);
  els.toggleWatchTogetherPanel.classList.add("hidden");
  els.minimizeVideoPlayer.classList.remove("hidden");
  els.watchTogetherInviteFallback.classList.add("hidden");
  els.watchTogetherInviteFallback.value = "";
  if (options.navigate !== false && navigation.readRoute().name === "watch") navigation.navigate("/");
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
    mediaType: state.selected.mediaType,
    mediaId: state.selected.id,
    showId: state.selected.showId || null,
    shuffleCollection: shuffleCollectionForItem(state.selected),
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
    skipMarkers: state.options && state.options.skipMarkers || [],
    errorMessage: "Playback failed. Try pre-generating HLS or check the stream logs.",
    fallbackUrl: fallbackWebPlayerUrl(),
    autoAdvance: Boolean(state.options && state.options.nextItem) || Boolean(state.selectedPlaybackShuffle),
    hasSequentialNext: Boolean(state.options && state.options.nextItem),
    nextItem: state.options && state.options.nextItem || null,
    shuffle: state.selectedPlaybackShuffle,
    hlsOptions: {
      lowLatencyMode: false,
      backBufferLength: 90
    }
  });
}

async function openWebPlayer(url, options = {}) {
  if (options.preserveWatchTogether) {
    resetWebPlaybackSourceForTransition();
  } else {
    closePlayer({ navigate: false });
  }
  webPlaybackNeedsRenewal = false;
  activeWebPlaybackRequest = options.mediaType && options.mediaId && !options.live
    ? {
      sessionId: webPlaybackSessionId,
      url: url.toString(),
      options: { ...options },
      fallbackStarted: false
    }
    : null;
  activePlaybackMedia = options.mediaType && options.mediaId
    ? {
      mediaType: options.mediaType,
      mediaId: options.mediaId,
      audioOnly: Boolean(options.audioOnly),
      showId: options.showId || null,
      shuffleCollection: shuffleCollectionForItem(options),
      hasSequentialNext: Boolean(options.hasSequentialNext),
      nextItem: options.nextItem || null
    }
    : null;
  activePlaybackShuffle = options.shuffle && isShufflePlayableItem(activePlaybackMedia)
    ? createPlaybackShuffle(activePlaybackMedia, options.shuffle.items)
    : null;
  webProgressLastReportedAt = 0;
  resetVideoEndTracking();
  const resumeSeconds = Math.max(0, Number(options.resumeSeconds) || 0);
  const fallbackUrl = options.fallbackUrl ? options.fallbackUrl.toString() : "";
  const audioOnly = Boolean(options.audioOnly);
  activeSkipMarkers = audioOnly || options.live
    ? []
    : normalizeSkipMarkers(options.skipMarkers);
  dismissedSkipMarkers = new Set();
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
  const autoplay = options.autoplay !== false;
  video.autoplay = autoplay;
  video.playsInline = true;
  video.dataset.autoAdvance = options.autoAdvance ? "true" : "false";
  els.videoPlaybackSurface.classList.toggle("audio-only", audioOnly);
  updateVideoShuffleControl();
  updateVideoPlayerControls();
  updateVideoPictureInPictureControl();
  resetVideoTrackControls();

  const startFallback = () => {
    if (!fallbackUrl || fallbackStarted) {
      return false;
    }
    fallbackStarted = true;
    if (activeWebPlaybackRequest) {
      activeWebPlaybackRequest.fallbackStarted = true;
    }
    video.dataset.autoAdvance = "false";
    els.musicNext.disabled = true;
    setPlayerStatus("The requested stream failed. Playing the fallback stream.");
    return true;
  };

  try {
    const nativeHlsSupported = Boolean(video.canPlayType("application/vnd.apple.mpegurl"));
    if (!window.Hls) {
      setPlayerStatus("Loading player...");
      await loadHlsLibrary();
    }
    const hlsJsSupported = Boolean(window.Hls && window.Hls.isSupported());

    if (!hlsJsSupported && nativeHlsSupported) {
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
      await seekNativeVideo(video, resumeSeconds, Boolean(options.startAtBeginning));
      updateNativeTrackControls();
      if (autoplay) {
        await video.play();
      }
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
      let seekRecoveryAttempts = 0;
      let seekRecoveryTimer = null;
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
        const recentSeek = Date.now() - videoLastSeekAt < 60000;
        const recoverableSeekError = data.type === window.Hls.ErrorTypes.NETWORK_ERROR
          || data.type === window.Hls.ErrorTypes.MEDIA_ERROR;
        if (!isFallback && !options.live && recentSeek && recoverableSeekError && seekRecoveryAttempts < 4) {
          seekRecoveryAttempts += 1;
          setPlayerStatus("Buffering the new playback position...");
          clearTimeout(seekRecoveryTimer);
          seekRecoveryTimer = setTimeout(() => {
            if (hlsPlayer !== player) return;
            if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) {
              player.recoverMediaError();
            } else {
              player.startLoad(Math.max(0, Number(video.currentTime) || 0));
            }
          }, Math.min(1500, seekRecoveryAttempts * 350));
          return;
        }
        if (!isFallback && startFallback()) {
          clearTimeout(seekRecoveryTimer);
          cancelPendingHlsAudioSwitch();
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
      player.on(window.Hls.Events.FRAG_BUFFERED, (event, data) => {
        liveRecoveryAttempts = 0;
        seekRecoveryAttempts = 0;
        clearTimeout(seekRecoveryTimer);
        if (!isFallback) {
          if (!pendingHlsAudioSwitch || pendingHlsAudioSwitch.player !== player) {
            setPlayerStatus("");
          }
          completePendingHlsAudioSwitch(player, data);
          notifyWatchTogetherReady();
        }
      });
      player.on(window.Hls.Events.AUDIO_TRACKS_UPDATED, () => updateHlsTrackControls(player));
      player.on(window.Hls.Events.AUDIO_TRACK_SWITCHED, (event, data) => {
        markPendingHlsAudioTrackSwitched(player, data);
        updateHlsTrackControls(player);
      });
      player.on(window.Hls.Events.SUBTITLE_TRACKS_UPDATED, () => updateHlsTrackControls(player));
      player.on(window.Hls.Events.SUBTITLE_TRACK_SWITCH, () => updateHlsTrackControls(player));
      if (window.Hls.Events.CUES_PARSED) {
        player.on(window.Hls.Events.CUES_PARSED, scheduleVideoSubtitlePositionUpdate);
      }
      player.on(window.Hls.Events.MANIFEST_PARSED, async () => {
        updateHlsTrackControls(player);
        try {
          if (resumeSeconds > 0 || options.startAtBeginning) {
            video.currentTime = resumeSeconds;
          }
          if (autoplay) {
            await video.play();
          }
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

function loadHlsLibrary() {
  if (window.Hls) {
    return Promise.resolve(window.Hls);
  }
  if (hlsLibraryPromise) {
    return hlsLibraryPromise;
  }

  hlsLibraryPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.async = true;
    script.dataset.mediaBakerHls = "true";
    script.src = hlsScriptUrl;
    script.addEventListener("load", () => {
      if (window.Hls) {
        resolve(window.Hls);
      } else {
        reject(new Error("HLS player loaded without exposing its API"));
      }
    }, { once: true });
    script.addEventListener("error", () => reject(new Error("HLS player failed to load")), { once: true });
    document.head.appendChild(script);
  }).catch((error) => {
    hlsLibraryPromise = null;
    throw error;
  });
  return hlsLibraryPromise;
}

function resetWebPlaybackSourceForTransition() {
  webPlaybackSessionId += 1;
  webPlaybackRestartPromise = null;
  watchTogetherSuppressControlsUntil = Date.now() + 2000;
  if (hlsPlayer) {
    cancelPendingHlsAudioSwitch();
    hlsPlayer.destroy();
    hlsPlayer = null;
  }
  if (nativePlayerErrorHandler) {
    els.webPlayer.removeEventListener("error", nativePlayerErrorHandler);
    nativePlayerErrorHandler = null;
  }
  els.webPlayer.pause();
  els.webPlayer.removeAttribute("src");
  els.webPlayer.load();
  activeSkipMarkers = [];
  dismissedSkipMarkers = new Set();
  resetVideoTrackControls();
}

function closePlayer(options = {}) {
  webPlaybackSessionId += 1;
  webPlaybackRestartPromise = null;
  const finalProgressRequest = activeWebPlaybackRequest && activeWebPlaybackRequest.fallbackStarted
    ? null
    : reportWebPlaybackProgress(true);
  reportWatchTogetherProgress(true);
  leaveWatchTogether({ navigate: options.navigate !== false });
  stopOnDeckPolling();
  exitVideoPictureInPicture();
  clearTimeout(videoControlsHideTimer);
  videoControlsHideTimer = null;
  activeSkipMarkers = [];
  dismissedSkipMarkers = new Set();
  updateSkipMarkerControl();
  if (hlsPlayer) {
    cancelPendingHlsAudioSwitch();
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
  activePlaybackMedia = null;
  activeWebPlaybackRequest = null;
  webPlaybackNeedsRenewal = false;
  activePlaybackShuffle = null;
  state.selectedPlaybackShuffle = null;
  updateVideoShuffleControl();
  webProgressLastReportedAt = 0;
  resetVideoEndTracking();
  resetVideoTrackControls();
  setPlayerStatus("");
  if (finalProgressRequest) {
    finalProgressRequest.finally(() => {
      refreshOnDeckRow({ force: true }).catch(() => {});
    });
  }
}

function minimizeVideoPlayback() {
  if (els.playerOverlay.classList.contains("hidden") || els.videoPlaybackSurface.parentElement !== els.videoPlayerSlot) {
    return;
  }
  closeVideoTrackSettings(false);
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

function handleWebPlayerReplay() {
  if (!webPlaybackNeedsRenewal || watchTogetherSession || !activeWebPlaybackRequest || webPlaybackRestartPromise) {
    return;
  }
  els.webPlayer.pause();
  restartWebPlayback().catch(() => {});
}

function shouldRenewWebPlayback() {
  return Boolean(activeWebPlaybackRequest && (
    webPlaybackNeedsRenewal
    || activeWebPlaybackRequest.fallbackStarted
    || els.webPlayer.ended
  ));
}

function restartWebPlayback() {
  if (webPlaybackRestartPromise) {
    return webPlaybackRestartPromise;
  }
  const request = activeWebPlaybackRequest;
  if (!request || watchTogetherSession) {
    return Promise.resolve(false);
  }

  const sessionId = request.sessionId;
  webPlaybackNeedsRenewal = false;
  els.webPlayer.pause();
  setPlayerStatus("Preparing a fresh stream session...");

  const restart = (async () => {
    const freshOptions = await api(`/api/catalog/${encodeURIComponent(request.options.mediaType)}/${encodeURIComponent(request.options.mediaId)}/options`);
    if (activeWebPlaybackRequest !== request || webPlaybackSessionId !== sessionId) {
      return false;
    }

    const freshUrl = new URL(request.url, window.location.origin);
    freshUrl.searchParams.set("playbackToken", freshOptions.webPlaybackToken);
    if (state.selected
      && state.selected.mediaType === request.options.mediaType
      && state.selected.id === request.options.mediaId) {
      state.options = {
        ...(state.options || {}),
        webPlaybackToken: freshOptions.webPlaybackToken
      };
    }

    await openWebPlayer(freshUrl, {
      ...request.options,
      resumeSeconds: 0,
      autoplay: true,
      skipMarkers: freshOptions.skipMarkers || request.options.skipMarkers,
      autoAdvance: Boolean(freshOptions.nextItem) || Boolean(request.options.shuffle),
      nextItem: freshOptions.nextItem || null,
      hasSequentialNext: Boolean(freshOptions.nextItem)
    });
    return true;
  })().catch((err) => {
    if (activeWebPlaybackRequest === request) {
      webPlaybackNeedsRenewal = true;
      setPlayerStatus("The stream could not be reconnected. Press play to try again.");
    }
    throw err;
  }).finally(() => {
    if (webPlaybackRestartPromise === restart) {
      webPlaybackRestartPromise = null;
    }
  });

  webPlaybackRestartPromise = restart;
  return restart;
}

function toggleVideoPlayback() {
  if (els.videoPlaybackSurface.classList.contains("audio-only")) {
    return;
  }
  if (!watchTogetherSession && shouldRenewWebPlayback()) {
    restartWebPlayback().catch(() => {});
    return;
  }
  if (watchTogetherSession) {
    const roomPlaying = watchTogetherSession.state && watchTogetherSession.state.state === "playing";
    if (roomPlaying && els.webPlayer.paused) {
      watchTogetherSuppressControlsUntil = Date.now() + 1000;
      els.webPlayer.play().catch(() => setPlayerStatus("Press play to allow synchronized playback."));
      return;
    }
    if (watchTogetherCanControl()) {
      if (!roomPlaying && !watchTogetherCanStart()) {
        return;
      }
      const positionSeconds = roomPlaying
        ? Number(els.webPlayer.currentTime) || 0
        : watchTogetherStatePosition(watchTogetherSession.state);
      const sent = sendWatchTogether({
        type: "control",
        action: roomPlaying ? "pause" : "play",
        positionSeconds
      });
      if (!sent) return;
      watchTogetherSuppressControlsUntil = Date.now() + 1000;
      if (roomPlaying) {
        els.webPlayer.pause();
      } else {
        if (Math.abs((Number(els.webPlayer.currentTime) || 0) - positionSeconds) > 0.25) {
          els.webPlayer.currentTime = positionSeconds;
        }
        els.webPlayer.play().catch(() => setPlayerStatus("Press play to allow synchronized playback."));
      }
      return;
    }
    setTemporaryPlayerStatus("Only the host can control playback.");
    applyWatchTogetherState(watchTogetherSession.state, true);
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
  const targetSeconds = duration * (Number(els.videoSeek.value) || 0) / 1000;
  seekEndRecoveryAttempted = false;
  videoEndSkipRequested = false;
  videoNaturalEndSeconds = 0;
  if (!watchTogetherSession) {
    els.webPlayer.currentTime = targetSeconds;
  }
  els.videoCurrentTime.textContent = formatMediaTime(targetSeconds);
}

function finishVideoSeek() {
  videoSeeking = false;
  const duration = Number(els.webPlayer.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    updateVideoPlayerControls();
    return;
  }
  if (watchTogetherSession) {
    const targetSeconds = duration * (Number(els.videoSeek.value) || 0) / 1000;
    if (watchTogetherCanControl()) {
      sendWatchTogether({ type: "control", action: "seek", positionSeconds: targetSeconds });
    } else {
      setTemporaryPlayerStatus("Only the host can seek playback.");
      applyWatchTogetherState(watchTogetherSession.state, true);
    }
  }
  updateVideoPlayerControls();
}

function handleVideoSeeking() {
  const targetSeconds = Number(els.webPlayer.currentTime);
  const duration = Number(els.webPlayer.duration);
  if (!Number.isFinite(targetSeconds)) {
    return;
  }

  videoLastSeekAt = Date.now();

  seekEndRecoveryAttempted = false;
  const explicitCreditsSkip = videoEndSkipRequested
    && Number.isFinite(duration)
    && targetSeconds >= duration - 1;
  if (!explicitCreditsSkip) {
    videoEndSkipRequested = false;
    videoNaturalEndSeconds = 0;
  }
  if (!Number.isFinite(duration) || targetSeconds < duration - 30) {
    videoRecoverableSeconds = targetSeconds;
  }
  videoLastObservedAt = Date.now();
  videoLastObservedSeconds = targetSeconds;
}

function trackVideoPlaybackContinuity() {
  const currentSeconds = Number(els.webPlayer.currentTime);
  const duration = Number(els.webPlayer.duration);
  if (!Number.isFinite(currentSeconds) || !Number.isFinite(duration) || duration <= 0) {
    return;
  }

  const now = Date.now();
  const elapsedSeconds = videoLastObservedAt > 0 ? (now - videoLastObservedAt) / 1000 : 0;
  const advancedSeconds = currentSeconds - videoLastObservedSeconds;
  const continuous = videoLastObservedAt > 0
    && advancedSeconds >= -0.25
    && advancedSeconds <= Math.max(2, elapsedSeconds * 4 + 0.5);

  if (currentSeconds < duration - 30) {
    videoNaturalEndSeconds = 0;
    if (continuous || videoLastObservedAt === 0) {
      videoRecoverableSeconds = currentSeconds;
    }
  } else if (!els.webPlayer.seeking && !els.webPlayer.paused) {
    if (continuous && advancedSeconds > 0) {
      videoNaturalEndSeconds += advancedSeconds;
    } else if (!continuous) {
      videoNaturalEndSeconds = 0;
    }
  }

  videoLastObservedAt = now;
  videoLastObservedSeconds = currentSeconds;
}

function resetVideoEndTracking() {
  seekEndRecoveryAttempted = false;
  videoLastObservedAt = 0;
  videoLastObservedSeconds = 0;
  videoRecoverableSeconds = 0;
  videoNaturalEndSeconds = 0;
  videoEndSkipRequested = false;
}

function updateVideoVolume() {
  els.webPlayer.muted = false;
  els.webPlayer.volume = Math.max(0, Math.min(1, Number(els.videoVolume.value) || 0));
}

function resetVideoTrackControls() {
  cancelPendingHlsAudioSwitch();
  els.videoAudioTrack.innerHTML = "";
  els.videoSubtitleTrack.innerHTML = "";
  els.videoAudioTrackLabel.classList.add("hidden");
  els.videoSubtitleTrackLabel.classList.add("hidden");
  setVideoTrackSettingsAvailable(false);
}

function updateHlsTrackControls(player) {
  if (!player || player !== hlsPlayer) return;
  const audioTracks = Array.isArray(player.audioTracks) ? player.audioTracks : [];
  const subtitleTracks = Array.isArray(player.subtitleTracks) ? player.subtitleTracks : [];

  els.videoAudioTrack.innerHTML = audioTracks.map((track, index) => (
    `<option value="${index}">${escapeHtml(track.name || track.lang || `Audio ${index + 1}`)}</option>`
  )).join("");
  if (audioTracks.length > 0) {
    const pendingTrack = pendingHlsAudioSwitch && pendingHlsAudioSwitch.player === player
      ? pendingHlsAudioSwitch.trackIndex
      : null;
    els.videoAudioTrack.value = String(pendingTrack === null ? Math.max(0, player.audioTrack) : pendingTrack);
  }
  els.videoAudioTrackLabel.classList.toggle("hidden", audioTracks.length < 2);

  els.videoSubtitleTrack.innerHTML = [
    '<option value="-1">Off</option>',
    ...subtitleTracks.map((track, index) => (
      `<option value="${index}">${escapeHtml(track.name || track.lang || `Subtitles ${index + 1}`)}</option>`
    ))
  ].join("");
  els.videoSubtitleTrack.value = String(Number.isInteger(player.subtitleTrack) ? player.subtitleTrack : -1);
  els.videoSubtitleTrackLabel.classList.toggle("hidden", subtitleTracks.length === 0);
  setVideoTrackSettingsAvailable(audioTracks.length >= 2 || subtitleTracks.length > 0);
  bindVideoSubtitleTracks();
  scheduleVideoSubtitlePositionUpdate();
}

async function stageHlsAudioTrackSwitch(player, trackIndex) {
  const tracks = Array.isArray(player && player.audioTracks) ? player.audioTracks : [];
  const track = tracks[trackIndex];
  if (!track || player !== hlsPlayer) return;

  cancelPendingHlsAudioSwitch();
  if (trackIndex === player.audioTrack) {
    updateHlsTrackControls(player);
    return;
  }

  const operation = {
    player,
    trackIndex,
    trackId: Number.isInteger(track.id) ? track.id : trackIndex,
    previousTrackIndex: player.audioTrack,
    controller: new AbortController(),
    committed: false,
    switched: false,
    completionTimer: null
  };
  pendingHlsAudioSwitch = operation;
  updateHlsTrackControls(player);
  setPlayerStatus(`Preparing ${audioTrackDisplayName(track, trackIndex)}...`);

  try {
    await prefetchHlsAudioWindow(track.url, player, operation.controller.signal);
    if (pendingHlsAudioSwitch !== operation || player !== hlsPlayer) return;

    operation.committed = true;
    if (watchTogetherSession) watchTogetherSession.trackSwitching = true;
    markWatchTogetherTrackBuffering();
    setPlayerStatus(`Switching to ${audioTrackDisplayName(track, trackIndex)}...`);
    player.audioTrack = trackIndex;
    operation.completionTimer = window.setTimeout(() => {
      if (pendingHlsAudioSwitch === operation) finishHlsAudioTrackSwitch(operation);
    }, 15000);
  } catch (err) {
    if (pendingHlsAudioSwitch !== operation) return;
    pendingHlsAudioSwitch = null;
    if (watchTogetherSession && operation.committed) {
      watchTogetherSession.trackSwitching = false;
      if (watchTogetherSession.state) applyWatchTogetherState(watchTogetherSession.state, true);
      window.setTimeout(notifyWatchTogetherReady, 0);
    }
    if (err && err.name === "AbortError") return;
    setTemporaryPlayerStatus(`Could not prepare ${audioTrackDisplayName(track, trackIndex)}.`);
    updateHlsTrackControls(player);
  }
}

async function prefetchHlsAudioWindow(playlistUrl, player, signal) {
  if (!playlistUrl) throw new Error("Audio rendition does not have a playlist");
  const resolvedPlaylistUrl = new URL(playlistUrl, window.location.href).toString();
  const playlist = await fetchHlsPrefetchResource(resolvedPlaylistUrl, signal, true);
  const segments = parseHlsMediaSegments(playlist, resolvedPlaylistUrl);
  if (segments.length === 0) throw new Error("Audio rendition playlist has no segments");

  const fetched = new Set();
  for (let attempt = 0; attempt < AUDIO_SWITCH_PREFETCH_ATTEMPTS; attempt += 1) {
    const position = Math.max(0, Number(player.media && player.media.currentTime) || 0);
    const duration = Math.max(position, Number(player.media && player.media.duration) || segments[segments.length - 1].end);
    const requiredSeconds = Math.min(AUDIO_SWITCH_PREFETCH_SECONDS, Math.max(0.5, duration - position));
    const windowEnd = position + requiredSeconds;
    const urls = segments
      .filter((segment) => segment.end > position - 0.25 && segment.start < windowEnd + 0.25)
      .map((segment) => segment.url)
      .filter((url) => !fetched.has(url));

    await prefetchHlsSegmentUrls(urls, signal);
    urls.forEach((url) => fetched.add(url));

    const latestPosition = Math.max(0, Number(player.media && player.media.currentTime) || 0);
    if (prefetchedHlsSecondsAhead(segments, fetched, latestPosition) >= Math.min(requiredSeconds, AUDIO_SWITCH_PREFETCH_SECONDS) - 0.25) {
      return;
    }
  }
  throw new Error("Audio rendition could not stay ahead of playback");
}

async function prefetchHlsSegmentUrls(urls, signal) {
  const pending = [...urls];
  const workers = Array.from({ length: Math.min(3, pending.length) }, async () => {
    while (pending.length > 0) {
      const url = pending.shift();
      await fetchHlsPrefetchResource(url, signal, false);
    }
  });
  await Promise.all(workers);
}

async function fetchHlsPrefetchResource(url, signal, textResponse) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await fetch(url, {
      credentials: "same-origin",
      cache: textResponse ? "no-store" : "default",
      signal
    });
    if (response.ok) return textResponse ? response.text() : response.arrayBuffer();
    if (response.status !== 503 || attempt === 19) {
      throw new Error(`Audio prefetch failed with HTTP ${response.status}`);
    }
    await waitForHlsPrefetchRetry(response, signal);
  }
  throw new Error("Audio prefetch failed");
}

function waitForHlsPrefetchRetry(response, signal) {
  const retrySeconds = Math.max(0.25, Math.min(2, Number(response.headers.get("Retry-After")) || 1));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(new DOMException("Audio prefetch cancelled", "AbortError"));
    };
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, retrySeconds * 1000);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function parseHlsMediaSegments(playlist, playlistUrl) {
  const segments = [];
  let elapsed = 0;
  let duration = null;
  for (const rawLine of String(playlist || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("#EXTINF:")) {
      duration = Number.parseFloat(line.slice(8));
      continue;
    }
    if (!line || line.startsWith("#") || !Number.isFinite(duration) || duration <= 0) continue;
    segments.push({
      url: new URL(line, playlistUrl).toString(),
      start: elapsed,
      end: elapsed + duration
    });
    elapsed += duration;
    duration = null;
  }
  return segments;
}

function prefetchedHlsSecondsAhead(segments, fetched, position) {
  const firstIndex = segments.findIndex((segment) => segment.end > position - 0.25);
  if (firstIndex < 0 || !fetched.has(segments[firstIndex].url)) return 0;
  let end = segments[firstIndex].end;
  for (let index = firstIndex + 1; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment.start > end + 0.25 || !fetched.has(segment.url)) break;
    end = Math.max(end, segment.end);
  }
  return Math.max(0, end - position);
}

function audioTrackDisplayName(track, trackIndex) {
  return track.name || track.lang || `audio track ${trackIndex + 1}`;
}

function markPendingHlsAudioTrackSwitched(player, data) {
  const operation = pendingHlsAudioSwitch;
  if (!operation || operation.player !== player || !operation.committed) return;
  const switchedId = Number(data && data.id);
  if (Number.isFinite(switchedId) && switchedId !== operation.trackId) return;
  operation.switched = true;
}

function completePendingHlsAudioSwitch(player, data) {
  const operation = pendingHlsAudioSwitch;
  if (!operation || operation.player !== player || !operation.committed || !operation.switched) return;
  const fragment = data && data.frag;
  if (!fragment || fragment.type !== "audio") return;
  const fragmentTrack = Number(fragment.level);
  if (Number.isFinite(fragmentTrack) && fragmentTrack !== operation.trackId) return;
  finishHlsAudioTrackSwitch(operation);
}

function finishHlsAudioTrackSwitch(operation) {
  if (!operation || pendingHlsAudioSwitch !== operation) return;
  window.clearTimeout(operation.completionTimer);
  pendingHlsAudioSwitch = null;
  setPlayerStatus("");
  if (watchTogetherSession) {
    watchTogetherSession.trackSwitching = false;
    if (watchTogetherSession.state) applyWatchTogetherState(watchTogetherSession.state, true);
    window.setTimeout(notifyWatchTogetherReady, 0);
  }
  updateHlsTrackControls(operation.player);
}

function cancelPendingHlsAudioSwitch() {
  const operation = pendingHlsAudioSwitch;
  if (!operation) return;
  pendingHlsAudioSwitch = null;
  operation.controller.abort();
  window.clearTimeout(operation.completionTimer);
  if (watchTogetherSession) {
    watchTogetherSession.trackSwitching = false;
    if (operation.committed && watchTogetherSession.state) {
      applyWatchTogetherState(watchTogetherSession.state, true);
      window.setTimeout(notifyWatchTogetherReady, 0);
    }
  }
}

async function changeVideoAudioTrack() {
  const selectedIndex = Number.parseInt(els.videoAudioTrack.value, 10);
  if (hlsPlayer) {
    await stageHlsAudioTrackSwitch(hlsPlayer, selectedIndex);
    return;
  }
  const audioTracks = mediaTrackList(els.webPlayer.audioTracks);
  if (audioTracks.length < 2) return;
  markWatchTogetherTrackBuffering();
  audioTracks.forEach(({ track, index }) => {
    track.enabled = index === selectedIndex;
  });
  updateNativeTrackControls();
}

function changeVideoSubtitleTrack() {
  const selectedIndex = Number.parseInt(els.videoSubtitleTrack.value, 10);
  if (hlsPlayer) {
    hlsPlayer.subtitleDisplay = selectedIndex >= 0;
    hlsPlayer.subtitleTrack = selectedIndex;
    scheduleVideoSubtitlePositionUpdate();
    return;
  }
  mediaTrackList(els.webPlayer.textTracks)
    .filter(({ track }) => ["subtitles", "captions"].includes(track.kind))
    .forEach(({ track, index }) => {
      track.mode = index === selectedIndex ? "showing" : "disabled";
    });
  updateNativeTrackControls();
  scheduleVideoSubtitlePositionUpdate();
}

function updateNativeTrackControls() {
  if (hlsPlayer) return;
  const audioTracks = mediaTrackList(els.webPlayer.audioTracks);
  const subtitleTracks = mediaTrackList(els.webPlayer.textTracks)
    .filter(({ track }) => ["subtitles", "captions"].includes(track.kind));

  els.videoAudioTrack.innerHTML = audioTracks.map(({ track, index }, position) => (
    `<option value="${index}">${escapeHtml(track.label || track.language || `Audio ${position + 1}`)}</option>`
  )).join("");
  const selectedAudio = audioTracks.find(({ track }) => track.enabled);
  if (selectedAudio) els.videoAudioTrack.value = String(selectedAudio.index);
  els.videoAudioTrackLabel.classList.toggle("hidden", audioTracks.length < 2);

  els.videoSubtitleTrack.innerHTML = [
    '<option value="-1">Off</option>',
    ...subtitleTracks.map(({ track, index }, position) => (
      `<option value="${index}">${escapeHtml(track.label || track.language || `Subtitles ${position + 1}`)}</option>`
    ))
  ].join("");
  const selectedSubtitle = subtitleTracks.find(({ track }) => track.mode === "showing");
  els.videoSubtitleTrack.value = String(selectedSubtitle ? selectedSubtitle.index : -1);
  els.videoSubtitleTrackLabel.classList.toggle("hidden", subtitleTracks.length === 0);
  setVideoTrackSettingsAvailable(audioTracks.length >= 2 || subtitleTracks.length > 0);
  bindVideoSubtitleTracks();
  scheduleVideoSubtitlePositionUpdate();
}

function setVideoTrackSettingsAvailable(available) {
  els.videoTrackSettings.classList.toggle("hidden", !available);
  els.videoControls.classList.toggle("track-settings-available", available);
  if (!available) {
    closeVideoTrackSettings(false);
  }
}

function toggleVideoTrackSettings() {
  if (els.videoTrackSettings.classList.contains("hidden")) return;
  const opening = els.videoTrackControls.classList.contains("hidden");
  if (opening) {
    showVideoControls(false);
    els.videoTrackControls.classList.remove("hidden");
    els.videoTrackSettings.classList.add("active");
    els.videoTrackSettings.setAttribute("aria-expanded", "true");
    scheduleVideoSubtitlePositionUpdate();
    const firstSelect = els.videoTrackControls.querySelector("label:not(.hidden) select");
    firstSelect?.focus({ preventScroll: true });
    return;
  }
  closeVideoTrackSettings();
}

function closeVideoTrackSettings(scheduleHide = true) {
  els.videoTrackControls.classList.add("hidden");
  els.videoTrackSettings.classList.remove("active");
  els.videoTrackSettings.setAttribute("aria-expanded", "false");
  scheduleVideoSubtitlePositionUpdate();
  if (scheduleHide && !els.webPlayer.paused) {
    scheduleVideoControlsHide();
  }
}

function mediaTrackList(trackList) {
  const tracks = [];
  const length = Number(trackList && trackList.length) || 0;
  for (let index = 0; index < length; index += 1) {
    tracks.push({ track: trackList[index], index });
  }
  return tracks;
}

function bindVideoSubtitleTracks() {
  mediaTrackList(els.webPlayer.textTracks)
    .filter(({ track }) => ["subtitles", "captions"].includes(track.kind))
    .forEach(({ track }) => bindVideoSubtitleTrack(track));
}

function bindVideoSubtitleTrack(track) {
  if (!track || !["subtitles", "captions"].includes(track.kind) || boundVideoSubtitleTracks.has(track)) return;
  boundVideoSubtitleTracks.add(track);
  track.addEventListener("cuechange", scheduleVideoSubtitlePositionUpdate);
}

function scheduleVideoSubtitlePositionUpdate() {
  if (videoSubtitlePositionFrame !== null) return;
  videoSubtitlePositionFrame = window.requestAnimationFrame(() => {
    videoSubtitlePositionFrame = null;
    updateVideoSubtitlePositions();
  });
}

function updateVideoSubtitlePositions() {
  const surfaceRect = els.videoPlaybackSurface.getBoundingClientRect();
  if (!(surfaceRect.height > 0)) return;

  const controlsHidden = els.videoPlaybackSurface.classList.contains("controls-hidden");
  const gap = Math.max(8, Math.min(18, surfaceRect.height * 0.025));
  let obstructionTop = surfaceRect.bottom - Math.max(16, Math.min(28, surfaceRect.height * 0.04));
  if (!controlsHidden) {
    const controlsRect = els.videoControls.getBoundingClientRect();
    if (controlsRect.height > 0) {
      obstructionTop = controlsRect.top;
    }
    if (!els.videoTrackControls.classList.contains("hidden")) {
      const trackControlsRect = els.videoTrackControls.getBoundingClientRect();
      if (trackControlsRect.height > 0) {
        obstructionTop = Math.min(obstructionTop, trackControlsRect.top);
      }
    }
  }

  const line = Math.max(45, Math.min(96, ((obstructionTop - surfaceRect.top - gap) / surfaceRect.height) * 100));
  mediaTrackList(els.webPlayer.textTracks)
    .filter(({ track }) => ["subtitles", "captions"].includes(track.kind))
    .forEach(({ track }) => {
      bindVideoSubtitleTrack(track);
      let cues = null;
      try {
        cues = track.cues;
      } catch (err) {
        return;
      }
      const cueCount = Number(cues && cues.length) || 0;
      let placementChanged = false;
      for (let index = 0; index < cueCount; index += 1) {
        placementChanged = positionVideoSubtitleCue(cues[index], line) || placementChanged;
      }
      if (placementChanged && track.mode === "showing" && track.activeCues && track.activeCues.length > 0) {
        // Chromium needs a track repaint before an active native cue adopts its new line.
        track.mode = "hidden";
        track.mode = "showing";
      }
    });
}

function positionVideoSubtitleCue(cue, line) {
  if (!cue || !("line" in cue) || cue.vertical) return false;
  if (!positionedVideoSubtitleCues.has(cue) && cue.line !== "auto") return false;
  positionedVideoSubtitleCues.add(cue);
  const nextLine = Number(line.toFixed(2));
  const changed = cue.snapToLines !== false
    || cue.line !== nextLine
    || ("lineAlign" in cue && cue.lineAlign !== "end");
  try {
    cue.snapToLines = false;
    cue.line = nextLine;
    if ("lineAlign" in cue) {
      cue.lineAlign = "end";
    }
    return changed;
  } catch (err) {
    // Some native playback engines expose read-only cue placement.
    return false;
  }
}

function markWatchTogetherTrackBuffering() {
  if (!watchTogetherSession || watchTogetherSession.bufferReady === false) return;
  watchTogetherSession.bufferReady = false;
  sendWatchTogether({
    type: "ready",
    ready: false,
    durationSeconds: Number(els.webPlayer.duration) || 0,
    bufferedSeconds: 0,
    queueRevision: watchTogetherSession.queueRevision,
    readinessRevision: watchTogetherSession.readinessRevision
  });
}

function toggleVideoMute() {
  els.webPlayer.muted = !els.webPlayer.muted;
}

function updateVideoPlayerControls() {
  const duration = Number(els.webPlayer.duration);
  const currentTime = Number(els.webPlayer.currentTime) || 0;
  const paused = watchTogetherSession && watchTogetherSession.state
    ? watchTogetherSession.state.state !== "playing" || els.webPlayer.paused
    : els.webPlayer.paused;
  const muted = els.webPlayer.muted || els.webPlayer.volume === 0;
  els.videoPlayPause.innerHTML = paused ? "&#9654;" : "&#10074;&#10074;";
  els.videoPlayPause.title = paused ? "Play" : "Pause";
  els.videoPlayPause.setAttribute("aria-label", paused ? "Play" : "Pause");
  const waitingToStart = Boolean(watchTogetherSession
    && paused
    && !watchTogetherCanStart());
  els.videoPlayPause.disabled = waitingToStart;
  if (waitingToStart) {
    els.videoPlayPause.title = "Waiting for everyone to buffer";
    els.videoPlayPause.setAttribute("aria-label", "Waiting for everyone to buffer");
  }
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
  updateSkipMarkerControl();
  if (paused) {
    showVideoControls(false);
  } else if (!videoControlsHideTimer && !els.videoPlaybackSurface.classList.contains("controls-hidden")) {
    scheduleVideoControlsHide();
  }
}

function createPlaybackShuffle(item, items = []) {
  return {
    enabled: true,
    mediaType: item.mediaType,
    showId: item.showId || null,
    shuffleCollection: shuffleCollectionForItem(item),
    items: Array.isArray(items) ? items : []
  };
}

function updateVideoShuffleControl() {
  const available = Boolean(isShufflePlayableItem(activePlaybackMedia)
    && !activePlaybackMedia.audioOnly
    && !watchTogetherSession);
  const enabled = available && Boolean(activePlaybackShuffle && activePlaybackShuffle.enabled);
  els.videoShuffle.classList.toggle("hidden", !available);
  els.videoShuffle.classList.toggle("active", enabled);
  els.videoShuffle.setAttribute("aria-pressed", enabled ? "true" : "false");
  els.videoShuffle.setAttribute("aria-label", enabled ? "Disable shuffle" : "Enable shuffle");
  els.videoShuffle.title = enabled ? "Disable shuffle" : "Enable shuffle";
  els.videoControls.classList.toggle("shuffle-available", available);
}

async function toggleVideoShuffle() {
  if (!isShufflePlayableItem(activePlaybackMedia) || watchTogetherSession) {
    return;
  }

  if (activePlaybackShuffle && activePlaybackShuffle.enabled) {
    activePlaybackShuffle = null;
    els.webPlayer.dataset.autoAdvance = activePlaybackMedia.hasSequentialNext ? "true" : "false";
    updateVideoShuffleControl();
    return;
  }

  const collection = shuffleCollectionForItem(activePlaybackMedia);
  if (collection) {
    activePlaybackShuffle = createPlaybackShuffle(activePlaybackMedia);
    els.webPlayer.dataset.autoAdvance = "true";
    updateVideoShuffleControl();
    return;
  }

  els.videoShuffle.disabled = true;
  els.videoShuffle.title = "Loading episodes...";
  try {
    const show = await api(`${tvBasePath(activePlaybackMedia.mediaType)}/${activePlaybackMedia.showId}`);
    const items = (show.seasons || [])
      .flatMap((season) => season.episodes || [])
      .map((episode) => episodeItem(activePlaybackMedia.mediaType, show, episode));
    if (items.length === 0) {
      setPlayerStatus("No episodes are available to shuffle.");
      return;
    }
    activePlaybackShuffle = createPlaybackShuffle(activePlaybackMedia, items);
    els.webPlayer.dataset.autoAdvance = "true";
  } catch (err) {
    setPlayerStatus("The episode list could not be loaded for shuffle.");
  } finally {
    els.videoShuffle.disabled = false;
    updateVideoShuffleControl();
  }
}

async function randomShuffleItem(currentId) {
  if (!activePlaybackShuffle || !activePlaybackShuffle.enabled) {
    return null;
  }
  const collection = shuffleCollectionForItem(activePlaybackShuffle);
  if (collection) {
    const params = new URLSearchParams({ folder: collection.id });
    if (currentId) params.set("exclude", currentId);
    try {
      const response = await api(`/api/catalog/libraries/${encodeURIComponent(activePlaybackShuffle.mediaType)}/random-item?${params.toString()}`);
      return response.item || null;
    } catch (err) {
      setPlayerStatus("The next random video could not be loaded.");
      return null;
    }
  }
  const items = activePlaybackShuffle.items || [];
  const candidates = items.length > 1
    ? items.filter((item) => item.id !== currentId)
    : items;
  return candidates.length > 0
    ? candidates[Math.floor(Math.random() * candidates.length)]
    : null;
}

function normalizeSkipMarkers(markers) {
  return (Array.isArray(markers) ? markers : [])
    .map((marker) => ({
      type: marker && marker.type === "credits" ? "credits" : "intro",
      startSeconds: Math.max(0, Number(marker && marker.startSeconds) || 0),
      endSeconds: Math.max(0, Number(marker && marker.endSeconds) || 0)
    }))
    .filter((marker) => marker.endSeconds > marker.startSeconds)
    .sort((first, second) => first.startSeconds - second.startSeconds);
}

function currentSkipMarker() {
  const currentTime = Number(els.webPlayer.currentTime) || 0;
  return activeSkipMarkers.find((marker) => currentTime >= marker.startSeconds && currentTime < marker.endSeconds - 0.1) || null;
}

function updateSkipMarkerControl() {
  if (!els.videoSkipPrompt) {
    return;
  }
  const marker = currentSkipMarker();
  const canSkip = !watchTogetherSession || watchTogetherCanControl();
  const visible = canSkip && marker && !dismissedSkipMarkers.has(skipMarkerKey(marker));
  els.videoSkipPrompt.classList.toggle("hidden", !visible);
  if (visible) {
    els.videoSkipPromptText.textContent = marker.type === "credits" ? "Skip credits?" : "Skip intro?";
  }
}

function skipCurrentMarker(event) {
  event.preventDefault();
  event.stopPropagation();
  const marker = currentSkipMarker();
  if (!marker) {
    return;
  }
  dismissedSkipMarkers.add(skipMarkerKey(marker));
  videoEndSkipRequested = marker.type === "credits";
  const duration = Number(els.webPlayer.duration);
  const targetSeconds = Number.isFinite(duration)
    ? Math.min(duration, marker.endSeconds)
    : marker.endSeconds;
  if (marker.type === "credits" && Number.isFinite(duration) && duration > 0) {
    reportWebPlaybackProgress(true, targetSeconds);
  }
  if (watchTogetherSession) {
    if (!watchTogetherCanControl()) {
      updateSkipMarkerControl();
      return;
    }
    sendWatchTogether({ type: "control", action: "seek", positionSeconds: targetSeconds });
  } else {
    els.webPlayer.currentTime = targetSeconds;
  }
  updateVideoPlayerControls();
}

function dismissCurrentMarker(event) {
  event.preventDefault();
  event.stopPropagation();
  const marker = currentSkipMarker();
  if (!marker) {
    return;
  }
  dismissedSkipMarkers.add(skipMarkerKey(marker));
  updateSkipMarkerControl();
}

function skipMarkerKey(marker) {
  return `${marker.type}:${marker.startSeconds}:${marker.endSeconds}`;
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
  const controlsWereHidden = els.videoPlaybackSurface.classList.contains("controls-hidden");
  els.videoPlaybackSurface.classList.remove("controls-hidden");
  if (controlsWereHidden) {
    scheduleVideoSubtitlePositionUpdate();
  }
  if (scheduleHide && !els.webPlayer.paused) {
    scheduleVideoControlsHide();
  }
}

function scheduleVideoControlsHide() {
  clearTimeout(videoControlsHideTimer);
  if (els.webPlayer.paused || videoSeeking || !els.videoTrackControls.classList.contains("hidden")) {
    return;
  }
  videoControlsHideTimer = window.setTimeout(() => {
    videoControlsHideTimer = null;
    if (els.videoControls.matches(":hover")) {
      scheduleVideoControlsHide();
      return;
    }
    els.videoPlaybackSurface.classList.add("controls-hidden");
    scheduleVideoSubtitlePositionUpdate();
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
    if (typeof els.videoPlaybackSurface.webkitRequestFullscreen === "function") {
      handleFullscreenResult(els.videoPlaybackSurface.webkitRequestFullscreen());
      return;
    }
    if (typeof video.webkitEnterFullscreen === "function" && video.webkitSupportsFullscreen !== false) {
      video.controls = true;
      video.webkitEnterFullscreen();
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
  const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement;
  const nativeVideoFullscreen = fullscreenElement === els.webPlayer
    || Boolean(els.webPlayer.webkitDisplayingFullscreen);
  const fullscreen = fullscreenElement === els.videoPlaybackSurface || nativeVideoFullscreen;
  els.webPlayer.controls = nativeVideoFullscreen;
  els.videoFullscreen.title = fullscreen ? "Exit fullscreen" : "Fullscreen";
  els.videoFullscreen.setAttribute("aria-label", fullscreen ? "Exit fullscreen" : "Fullscreen");
  showVideoControls();
}

function setPlayerStatus(message) {
  const text = String(message || "");
  clearTimeout(playerStatusHideTimer);
  playerStatusHideTimer = null;
  for (const status of [els.playerStatus, els.musicPlayerStatus, els.videoMiniStatus]) {
    status.textContent = text;
    status.classList.toggle("hidden", !text);
  }
  els.playerOverlay.classList.toggle("player-status-visible", Boolean(text));
}

function clearPlayerStatus(...messages) {
  if (messages.includes(els.playerStatus.textContent)) {
    setPlayerStatus("");
  }
}

function setTemporaryPlayerStatus(message, durationMs = 3000) {
  setPlayerStatus(message);
  if (!message) return;
  playerStatusHideTimer = window.setTimeout(() => {
    playerStatusHideTimer = null;
    setPlayerStatus("");
  }, durationMs);
}

function showMusicPlayer(metadata, hasNext) {
  els.musicPlayerArtist.textContent = metadata.artist || "Unknown Artist";
  els.musicPlayerTitle.textContent = metadata.title || "Untitled";
  els.musicPlayerAlbum.textContent = metadata.album || "Unknown Album";
  clearPosterImage(els.musicPlayerCover);
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
  if (shouldRenewWebPlayback()) {
    restartWebPlayback().catch(() => {});
    return;
  }
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

function reportWebPlaybackProgress(force = false, positionOverride = null) {
  if (!activePlaybackMedia) {
    return webProgressRequest;
  }
  const positionSeconds = positionOverride === null
    ? Number(els.webPlayer.currentTime)
    : Number(positionOverride);
  const durationSeconds = Number(els.webPlayer.duration);
  if (!Number.isFinite(positionSeconds)
    || !Number.isFinite(durationSeconds)
    || durationSeconds <= 0) {
    return null;
  }
  const now = Date.now();
  if (!force && now - webProgressLastReportedAt < 5_000) {
    return null;
  }
  if (webProgressRequest && !force) {
    return webProgressRequest;
  }

  webProgressLastReportedAt = now;
  const playbackMedia = { ...activePlaybackMedia };
  const previousRequest = webProgressRequest;
  const request = (previousRequest || Promise.resolve())
    .catch(() => null)
    .then(() => api(
      `/api/progress/${encodeURIComponent(playbackMedia.mediaType)}/${encodeURIComponent(playbackMedia.mediaId)}/position`,
      state.token,
      {
        method: "POST",
        body: JSON.stringify({ positionSeconds, durationSeconds })
      }
    ))
    .then((progress) => {
      if (state.selected
        && state.selected.mediaType === playbackMedia.mediaType
        && state.selected.id === playbackMedia.mediaId) {
        state.selected = { ...state.selected, progress };
        renderDetailsProgress(progress);
        updateManagementActions(progress);
        updateRenderedCardsProgress(state.selected, progress);
        if (isWatchedProgress(progress)) {
          removeOnDeckCard(state.selected);
          refreshOnDeckRow({ force: true }).catch(() => {});
        }
      }
      return progress;
    })
    .catch(() => null);
  webProgressRequest = request;
  request.finally(() => {
    if (webProgressRequest === request) {
      webProgressRequest = null;
    }
  });
  return request;
}

async function handleWebPlayerEnded() {
  stopOnDeckPolling();
  const duration = Number(els.webPlayer.duration);
  if (watchTogetherSession) {
    reportWatchTogetherProgress(true);
    sendWatchTogether({ type: "ended", itemId: watchTogetherSession.queueItemId });
    return;
  }
  if (activeWebPlaybackRequest && activeWebPlaybackRequest.fallbackStarted) {
    webPlaybackNeedsRenewal = true;
    setPlayerStatus("The stream session expired. Press play to reconnect.");
    return;
  }
  const endedSessionId = webPlaybackSessionId;
  const videoEndConfirmed = videoEndSkipRequested || videoNaturalEndSeconds >= 5;
  if (activePlaybackMedia
    && !activePlaybackMedia.audioOnly
    && !videoEndConfirmed) {
    if (!seekEndRecoveryAttempted) {
      seekEndRecoveryAttempted = true;
      setPlayerStatus("Recovering playback after an unexpected end...");
      const recoverySeconds = Number.isFinite(duration) && duration > 0
        ? Math.min(videoRecoverableSeconds, Math.max(0, duration - 30))
        : videoRecoverableSeconds;
      if (recoverySeconds > 0) {
        els.webPlayer.currentTime = recoverySeconds;
        els.webPlayer.play().catch(() => {
          setPlayerStatus("Playback ended unexpectedly after seeking.");
        });
      } else {
        setPlayerStatus("Playback ended unexpectedly before reaching the end.");
      }
    } else {
      setPlayerStatus("Playback ended unexpectedly after seeking.");
    }
    return;
  }

  webPlaybackNeedsRenewal = Boolean(activeWebPlaybackRequest);
  await reportWebPlaybackProgress(true);
  await refreshSelectedProgress().catch(() => null);
  if (webPlaybackSessionId !== endedSessionId) {
    return;
  }
  const shuffle = activePlaybackShuffle && activePlaybackShuffle.enabled
    ? { ...activePlaybackShuffle, items: [...activePlaybackShuffle.items] }
    : null;
  const shuffledItem = els.webPlayer.dataset.autoAdvance === "true"
    ? await randomShuffleItem(activePlaybackMedia && activePlaybackMedia.mediaId)
    : null;
  const nextItem = shuffledItem || (els.webPlayer.dataset.autoAdvance === "true"
    ? activePlaybackMedia && activePlaybackMedia.nextItem
    : null);
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
    }, { shuffle: Boolean(shuffle), shuffleItems: shuffle && shuffle.items });
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

function seekNativeVideo(video, resumeSeconds, force = false) {
  if (resumeSeconds <= 0 && !force) {
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

  const selectedWatched = isWatchedProgress(state.selected.progress);
  const action = selectedWatched ? "unwatched" : "watched";
  els.markWatched.disabled = true;
  els.copyStatus.textContent = `Marking ${action}...`;
  try {
    const result = await api(`/api/progress/${state.selected.mediaType}/${state.selected.id}/${action}`, state.token, {
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
    if (!selectedWatched) {
      removeOnDeckCard(state.selected);
    }
    await refreshOnDeckRow({ force: true }).catch(() => {});
    els.copyStatus.textContent = selectedWatched ? "Marked unwatched." : "Marked watched.";
  } catch (err) {
    els.copyStatus.textContent = `Failed to mark ${action}.`;
  } finally {
    els.markWatched.disabled = false;
  }
}

async function markSeasonWatched(mediaType, show, season, button = null) {
  const episodes = season && Array.isArray(season.episodes) ? season.episodes : [];
  if (!state.user || state.libraryViewToken || episodes.length === 0) {
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

  await removeOnDeckItem(state.selected, els.removeOnDeck);
}

async function removeOnDeckItem(item, button = null) {
  if (!item) {
    return;
  }

  if (button) button.disabled = true;
  const selected = state.selected
    && state.selected.mediaType === item.mediaType
    && state.selected.id === item.id;
  if (selected) els.copyStatus.textContent = "Removing from On Deck...";
  try {
    const path = item.showId
      ? `/api/progress/${encodeURIComponent(item.mediaType)}/shows/${encodeURIComponent(item.showId)}/remove`
      : `/api/progress/${encodeURIComponent(item.mediaType)}/${encodeURIComponent(item.id)}/remove`;
    const result = await api(path, state.token, {
      method: "POST",
      body: JSON.stringify({})
    });
    if (selected) {
      state.selected = {
        ...state.selected,
        ...(result.progress ? { progress: result.progress } : {}),
        onDeckReason: null,
        onDeckRemoved: true
      };
      if (result.progress) {
        renderDetailsProgress(result.progress);
        updateRenderedCardsProgress(state.selected, result.progress);
      }
      updateManagementActions(state.selected.progress);
    }
    removeOnDeckCard(item);
    await refreshOnDeckRow({ force: true }).catch(() => {});
    if (selected) els.copyStatus.textContent = "Removed from On Deck.";
  } catch (err) {
    if (selected) els.copyStatus.textContent = err.message || "Failed to remove from On Deck.";
  } finally {
    if (button) button.disabled = false;
  }
}

function removeOnDeckCard(item) {
  const section = els.homeRows.querySelector('[data-row-kind="onDeck"]');
  if (!section) {
    return;
  }

  const cardElements = item.showId
    ? section.querySelectorAll(`.card[data-show-key="${cssEscape(`${item.mediaType}:${item.showId}`)}"]`)
    : section.querySelectorAll(`.card[data-media-key="${cssEscape(mediaKey(item))}"]`);
  for (const cardElement of cardElements) {
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
  } else if (state.libraryViewToken) {
    headers["X-Library-View-Token"] = state.libraryViewToken;
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
  if (state.libraryViewToken && !state.token) {
    return { name: "viewToken", value: state.libraryViewToken };
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
