# Media Baker

Media Baker is a self-hosted media library, metadata manager, and HLS streaming server with a browser interface. This guide covers a standalone installation. For containers, see the [Docker setup guide](README.docker.md).

## Features

- TV, movie, music, image, anime, 3D, loose-file, and common season-folder library layouts.
- Installable WebUI with accounts, granular permissions, per-account colour themes, selectable server branding, search, lazy-loaded libraries, and remembered navigation state.
- Recently Added based on Media Baker's persisted first-seen time, stable random browsing, show and season pages, episode progress, watched state, On Deck, history, and shuffle playback.
- Browser HLS playback with quality selection, switchable audio and subtitle tracks, automatic next-item playback, resumable sessions, rapid-seek recovery, and cached keyframe timelines.
- Copyable HLS URLs for external players, including H.264/AAC compatibility output, audio/subtitle variants, progress tracking, and fallback playback.
- Watch Together rooms with synchronized playback, guest names, chat, host controls, readiness checks, and active-room administration.
- Optional intro and credit detection with persistent failures, previews, retries, reanalysis, chapter hints, recurring-theme matching, and post-credit scene protection.
- Optional per-library optimiser with one configurable profile, retained audio languages, optional subtitles, stereo downmix, HDR preservation, validation, retries, and hardware acceleration.
- TMDb video metadata and Deezer music metadata, or a compatible custom metadata service, with cached WebP artwork, artist and album art, season posters, episode thumbnails, manual matching, and duplicate detection.
- YT-DLP downloads, playlist handling, YouTube cookies, channel subscriptions, live recording, live HLS relay, progress, automatic indexing, and generated thumbnails.
- M3U and HDHomeRun Live TV with XMLTV programme data, channel matching, logo caching, deinterlacing, and rolling HLS.
- Optional OpenMovie API for building simplified Media Baker clients, including VRChat integrations, with encrypted access URLs, playback variants, poster atlases, On Deck, and future URL generation.
- MySQL storage or local JSON files for the index, settings, accounts, sessions, metadata, playback progress, keyframes, OpenMovie state, and other persistent data.
- Admin views for accounts, keys, libraries, duplicates, backup and restore, optimisation, skip detection, settings, tasks, hardware, current playback, Watch Together rooms, logs, and user history.
- Manual and scheduled compressed backups, rotating logs, GitHub release notifications, and supervised source updates.
- Swagger/OpenAPI documentation at `/api/docs`.

## Requirements

- Node.js 24 or newer.
- FFmpeg and FFprobe.
- npm.
- Optional: MySQL 8 or a compatible MySQL server.
- Optional: ffsubsync for downloaded subtitle synchronization.
- Optional: yt-dlp for downloads, subscriptions, recording, and relays.
- Optional: a supported NVIDIA, Intel, AMD, or Apple GPU and its drivers.

## Standalone Setup

1. Install dependencies:

   ```powershell
   npm ci
   ```

2. Create the startup configuration:

   ```powershell
   Copy-Item config.example.json config.json
   ```

   Linux:

   ```bash
   cp config.example.json config.json
   ```

3. Edit `config.json` if required:

   ```json
   {
     "port": 5000,
     "mysql": {
       "enabled": false,
       "host": "localhost",
       "port": 3306,
       "user": "media_baker",
       "password": "",
       "database": "media_baker",
       "connectionLimit": 5
     }
   }
   ```

4. On Windows, place binaries in `bin/`:

   ```text
   bin/ffmpeg.exe
   bin/ffprobe.exe
   bin/ffsubsync.exe   optional
   bin/yt-dlp.exe      optional
   ```

   On Linux and macOS, install equivalent commands on `PATH`.

5. Optionally place a fallback video at `fallback/404.mp4`.

6. Start Media Baker through its supervisor:

   ```powershell
   npm start
   ```

7. Open `http://localhost:5000` and create the first administrator account.

Always use `npm start`. Running `node src/server.js` directly bypasses the supervisor and disables source-update installation.

## Configuration And Storage

`config.json` is intentionally small. It provides values needed before the database and WebUI settings are available:

- `port`: HTTP port, defaulting to `5000`.
- `mysql`: enables MySQL and supplies its connection details.
- `libraries`: optional seed libraries for an initial deployment. Libraries should normally be managed in the WebUI afterward.

Most settings are runtime settings stored in MySQL or `cache/settings.json`. They are managed under `Admin > Settings`, `Admin > Optimise`, and `Admin > Backup & Restore`.

Important standalone paths:

| Path | Purpose |
| --- | --- |
| `config.json` | Startup configuration |
| `cache/` | JSON stores, metadata, artwork, HLS, subtitles, keyframes, update staging, and backups |
| `cache/logs/` | Daily rotating logs unless configured otherwise |
| `cache/yt-dlp/` | Default standalone YT-DLP output |
| `public/icons/` | Built-in and administrator-supplied source icons |
| `fallback/404.mp4` | Optional fallback video source |
| `bin/` | Bundled Windows executables |

MySQL stores structured application data when enabled. Generated images, HLS fragments, downloaded subtitles, logs, and update files remain on disk. JSON mode stores the corresponding structured data below `cache/`.

## Administration

- `Accounts`: users, passwords, library access, and granular permissions.
- `Keys`: user-scoped API keys and revocable Library View URLs.
- `Libraries`: create, order, re-index, or remove libraries and browse server folders.
- `Duplicates`: inspect duplicate metadata matches.
- `Backup & Restore`: destination, schedule, retention, manual snapshots, and restore.
- `Optimise`: global scheduling, per-library profiles, current work, queues, full checks, and retryable failures.
- `Skip Detection`: progress, failures, marker review, retries, and fingerprint rebuilds.
- `Settings`: branding, metadata, subtitles, YT-DLP, IPTV, HLS, playback, scans, logging, hardware acceleration, OpenMovie, fallback playback, and updates.
- `Tasks`: running, queued, failed, and recently completed work across indexing, metadata, keyframes, streaming, optimisation, downloads, backups, and updates.
- `Hardware`: five-minute CPU, memory, GPU, and network graphs. GPU sampling supports NVIDIA, Intel, AMD, and Apple where the operating system exposes suitable counters.
- `Currently Playing`: active playback and Watch Together rooms.
- `Live Log` and `User History`: operational logs and filtered account playback history.

## Libraries And Indexing

Create a library with a display name, type, and server-visible path. Supported types are TV, Movies, Music, Images, TV 3D, and Movies 3D. Paths may be local folders, UNC paths, mounted shares, or mapped drives visible to the account running Media Baker.

Movie libraries may use loose files or one folder per movie. TV libraries support season folders, specials and season zero, `S01E01`, `1x01`, anime-style layouts, and unmatched video files. Music libraries primarily use `Artist/Album/track`, but tolerate intermediate grouping folders and tagged files. Image libraries are scanned recursively.

Periodic scans add and remove media. Unreadable subdirectories are logged and skipped without stopping the rest of the library scan. A file's `addedAtMs` becomes its persistent first-seen time: later metadata changes, optimisation, or filesystem timestamp updates do not make it Recently Added again. Unambiguous renames retain both the media ID and first-seen time.

Compatible video files are queued for background keyframe discovery during indexing. Keyframe timelines are stored with the media identity and file signature in MySQL or JSON. Playback reuses them while size and modification time still match, and refreshes stale data when the source changes.

## Playback And Progress

Media Baker serves HLS for browser and copied playback. It reuses compatible streams where possible and transcodes only the tracks or video properties that require it. Original, medium, and low quality profiles are available.

The browser player exposes switchable audio and WebVTT subtitle renditions where supported. Track changes prepare and buffer the replacement before switching. Copied URLs remain compatibility-oriented HLS and can select a fixed audio/subtitle variant. Audio output supports stereo, preserved surround, 5.1, and Stabby Cinema channel mapping.

HLS fragments are cached on disk and shared by identical playback requests. Missing seek positions can reposition FFmpeg using the stored keyframe timeline. Abandoned requests are cancelled so rapid seeking does not keep reasserting obsolete positions. The minimum-free-space setting can remove inactive HLS caches before generation; active readers and transcodes are protected.

Logged-in browser playback writes account progress and refreshes On Deck. Users can remove a movie or show from On Deck; it remains suppressed until that media is watched again. Copied playback estimates progress from delivered HLS segments, so it can be less precise than browser-reported playback.

### Watch Together

Users with `Copy playback URLs` permission can create Watch Together rooms. Logged-in participants retain normal account progress; guests choose a temporary room name. Playback starts after the initial participants report enough buffered media. The host can play, pause, seek, kick participants, close the room, or allow everyone to control playback. Late joiners synchronize without pausing existing viewers. Chat records joins, control-policy changes, kicks, and other room events. Empty rooms are removed automatically, and administrators can inspect or close active rooms.

## Re-encode And Optimise

The optimiser is disabled by default and supports TV and movie libraries. Both the global switch and a library's switch must be enabled. Libraries may run all day or inside a daily time window, with 1-8 parallel jobs.

Each library has one profile:

- The preferred audio language is inherited from `Admin > Settings`.
- Additional audio languages can be selected per library.
- Commentary and audio-description tracks are excluded.
- `Preserve subtitles` retains suitable subtitle streams; otherwise subtitles are omitted from rewritten output.
- `Downmix to stereo` converts retained surround audio to AAC stereo; otherwise channel layouts are preserved where possible.
- `Preserve HDR` keeps detected HDR as 10-bit HEVC with available colour metadata.

Video normally targets H.264 using quality-based encoding. Media Baker can use supported NVIDIA, Intel QSV, VAAPI/AMD, or Apple VideoToolbox decoding and encoding, with an automatic software fallback. Already-compatible files are probed and skipped rather than rewritten.

Outputs are written to temporary files and validated for codecs, stream counts, channel layouts, duration, timestamps, and packet continuity before replacing the source. Heartbeat lock files prevent two workers or instances from processing the same file. Failed sources remain unchanged and can be retried from the failure panel.

The optimiser needs a writable library and enough temporary space for intermediate streams and the final output. Keep independent backups of irreplaceable media.

## Metadata And Artwork

Select either `TMDb and Deezer` or `Custom` under `Admin > Settings > Metadata`.

- TMDb supplies movie and TV metadata, posters, season artwork, and episode stills. Configure an API key or read access token.
- Deezer supplies built-in artist, album, and music metadata without a Media Baker API key.
- A custom service receives normalized information derived from each media file, together with the requested language. The service decides which metadata sources to use and returns results in Media Baker's standard format.

Metadata is cached and missing fields are rechecked. Artwork is converted to WebP and constrained within 1024x1024 without changing its aspect ratio. Cached artwork lives on disk even when structured metadata uses MySQL. Users with metadata permission can search, apply or refresh matches, edit posters, refresh season posters, and inspect duplicates.

See the [Custom Metadata API specification](README.metadata-service-api.md) for the endpoints and response format a compatible service must provide.

SubDL subtitle search is performed only when requested. Selected subtitles may be synchronized with ffsubsync before use. Browser playback can overlay supported subtitles; fixed copied variants may require subtitle processing as part of their HLS output.

## YT-DLP

Enable YT-DLP under `Admin > Settings`, choose a download folder, and use the Download action in the WebUI. Media Baker prefers H.264 video and AAC audio when available, reports progress, indexes completed files, and creates thumbnails.

- The administrator can force a yt-dlp update from Settings.
- A Netscape-format `cookies.txt` can be uploaded. Cookies are passed only to YouTube requests.
- Node.js is supplied to yt-dlp as its JavaScript runtime.
- Direct videos and explicit playlists are supported according to the playlist setting.
- A YouTube channel URL prompts the user to download the channel or create a subscription.
- Creating a subscription downloads the existing channel catalogue, records downloaded IDs, and checks for new uploads. The default interval is 24 hours and is configurable.
- Removing a subscription stops future checks without deleting downloaded media.
- Live URLs can be recorded or relayed as rolling HLS. Relays stop when inactive.

## Live TV

Enable IPTV under `Admin > Settings` and choose an M3U playlist or HDHomeRun lineup. Add an XMLTV URL or mounted guide file for programme information.

- Sources refresh on a configurable interval and can be refreshed manually.
- EPG channels are matched automatically and may be corrected manually.
- Logos are cached locally.
- Incompatible streams are normalized to H.264/AAC.
- Automatic, forced, smooth, and per-channel deinterlacing modes are available.
- Rolling HLS is shared and inactive FFmpeg processes are stopped.

Live TV permission is assigned per account like library access.

## Keys And Authentication

Browser sessions last seven days and use sliding expiration. Active sessions refresh their expiry at most once per hour. Account preferences, including playback defaults and the interface colour, follow the account across devices.

`Admin > Keys` contains:

- **API Keys:** inherit the selected user's current permissions and can be revoked.
- **Library View URLs:** read-only, account-free access to selected libraries. They may expire after one hour, one day, one week, one month, a custom time, or never. Visitors can browse, search, and inspect metadata, but cannot play, copy URLs, share, reveal paths, write progress, or administer the server.

Copying playback URLs and creating Watch Together rooms require `Copy playback URLs`. Built-in playback tokens are scoped separately from copied playback tokens.

## OpenMovie API

OpenMovie is a simplified API for building clients around Media Baker. It provides ready-made media lists, artwork references, playback variants, On Deck data, and playback URLs, so a lightweight client does not need to reproduce the full Media Baker WebUI or account flow. It was designed for restricted environments such as VRChat, but it can also be used by other clients that benefit from stable, pre-generated URLs.

OpenMovie is disabled by default and can be enabled in `Admin > Settings`. When disabled, all OpenMovie endpoints are inaccessible.

The client authenticates once by sending an API key to `/api/openmovie/auth`. Media Baker returns encrypted URLs for movie, TV, On Deck, and future catalogue requests. The returned catalogue data also contains encrypted poster, atlas, playback, and audio/subtitle variant URLs. These URLs contain the minimum information Media Baker needs to authorize and resolve the request, so the client does not send the API key again. Revoking the original key or changing its permissions also affects its generated URLs.

Internal incremental IDs remain stable for clients that need pre-generated URLs, but are not exposed publicly. Poster atlases use a 4x3 layout with 12 slots. Published static atlases are immutable; dynamic On Deck atlases are regenerated from the current page.

See `/api/docs` for the current request and response schemas.

## Branding And Themes

Source PNG icons live in `public/icons`. On first startup Media Baker chooses an icon if none is configured, generates required sizes in the cache, and retains that choice across restarts. Administrators can select another built-in or custom icon under Settings. The selected icon is used by the navigation, login screen, favicon, and web-app manifest.

Each account can select a preset accent colour or use the colour picker. The preview updates immediately and the saved preference applies whenever that account signs in.

## Updates

Media Baker checks `jazzy348/media-baker` for releases every six hours by default. Pre-release checks and automatic installation are configurable. Pre-release and stable releases display their available changelog to administrators.

The supervisor stops the server child, installs the staged source and npm dependencies, then starts the new version. Active playback stops during an update. Changes to Node.js, FFmpeg, operating-system packages, or service configuration still require a manual host update.

## Backup And Restore

Backups can run manually or on selected weekdays at a local server time. Retention removes the oldest Media Baker snapshots beyond the configured count.

MySQL snapshots include every Media Baker table. JSON snapshots include accounts, sessions, libraries, settings, index data, metadata, playback progress, keyframes, skip markers, and OpenMovie state, including the deployment-specific encryption secret. Restore replaces the matching storage backend and restarts Media Baker.

Also back up `config.json`, media, downloaded files, cached artwork when required, custom icons, and the fallback source. A database restore does not restore those external files.

## API Documentation

Swagger UI:

```text
http://localhost:5000/api/docs
```

Raw OpenAPI JSON:

```text
http://localhost:5000/api/docs/openapi.json
```
