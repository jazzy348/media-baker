# Media Baker Standalone Setup

Use this guide for standalone Media Baker deployments with Node.js, Express, and FFmpeg installed directly on the host.

## Features

- WebUI with accounts, permissions, API keys, share URLs, self-service account settings, and per-user watch state.
- Dynamic library creation, removal, ordering, folder browsing, and background re-indexing from the admin panel.
- TV, movie, anime, 3D, loose-file, and Plex-style folder scanning, including `S01E01` and `1x01` episode names.
- Recently added and randomized home rows, lazy library browsing, metadata-first search, show/season views, and random episode selection.
- On Deck, next-episode handling, watch history, resume playback, manual watched/unwatched controls, and currently-playing admin view.
- Browser playback and copyable HLS URLs for external players.
- HLS generation with cache reuse, one-transcode-per-file locking, pre-generation, configurable TTL, and fallback error stream.
- Original, medium, and low quality presets with resolution and bitrate selection.
- Audio-track selection, stereo mixdown, preserved 5.1, and Stabby Cinema 5.1 channel remapping.
- Embedded and external subtitle burn-in, English subtitle preference, SubDL search, and optional ffsubsync synchronization.
- ProTV and VRChat URL support including resume time and stereoscopic 3D mode parameters.
- TMDb metadata, aliases, poster cache, season artwork, episode thumbnails, manual poster URLs, unmatched-media search, provider-ID matching, rematching, and duplicate detection.
- YT-DLP download library with progress, H.264/AAC preference, automatic indexing, and generated thumbnails.
- M3U and HDHomeRun Live TV with EPG refresh, automatic/manual channel matching, channel filtering, cached logos, deinterlacing, and rolling HLS.
- Optional MySQL storage for the index, settings, accounts, sessions, metadata, and playback progress.
- JSON storage fallback when MySQL is disabled.
- Admin pages for accounts, API keys, libraries, duplicates, settings, hardware graphs, currently playing, live logs, and user history.
- Runtime settings for metadata, subtitles, HLS, IPTV, YT-DLP, scans, logging, GPU encoding, fallback playback, and update checks.
- Daily rotating log files with configurable retention and selectable error, info, or full logging levels.
- Admin-only GitHub release notifications and optional automatic source updates.
- Swagger/OpenAPI documentation at `/api/docs`.

## Standalone Setup

1. Install Node.js 20 or newer.

2. Install dependencies:

   ```powershell
   npm ci
   ```

3. Create `config.json`:

   ```powershell
   Copy-Item config.example.json config.json
   ```

   Linux:

   ```bash
   cp config.example.json config.json
   ```

4. Edit the startup configuration:

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

5. On Windows, add the required binaries:

   ```text
   bin/ffmpeg.exe
   bin/ffprobe.exe
   bin/ffsubsync.exe   optional
   bin/yt-dlp.exe      optional
   ```

   On Linux, install the equivalent commands on `PATH`.

6. Add the optional fallback video:

   ```text
   fallback/404.mp4
   ```

7. Start Media Baker through its supervisor:

   ```powershell
   npm start
   ```

8. Open `http://localhost:5000`.

On first launch, create the first admin account, then add libraries from `Admin > Libraries`.

## Docker Deployment
[Docker Setup Guide](README.docker.md)

## Configuration

`config.json` contains settings required before the database, account system, and WebUI settings are available:

- `port`: HTTP port; defaults to `5000`.
- `mysql`: set `enabled` to `true` and provide credentials to use MySQL.
- `libraries`: optional first-run library import; manage libraries in the WebUI afterward.

Runtime configuration is stored in MySQL or the JSON settings store and can be changed without restarting:

- `Admin > Settings`: metadata, subtitles, HLS, IPTV, YT-DLP, scans, playback, logging, GPU, fallback stream, and updates.
- `Admin > Libraries`: media folders, order, re-indexing, and share URLs.
- `Admin > Accounts`: users, passwords, permissions, and library access.
- `Admin > API Keys`: user-scoped API keys.

Standalone paths:

- `cache/`: JSON stores, metadata, thumbnails, subtitles, HLS, playback state, update staging, and backups.
- `cache/logs/YYYY-MM-DD.log`: daily log files.
- `cache/yt-dlp/`: default standalone YT-DLP output.
- `fallback/404.mp4`: fallback video source.
- `bin/`: Windows FFmpeg, FFprobe, ffsubsync, and yt-dlp binaries.

The WebUI reports missing binaries. Playback remains disabled until FFmpeg and FFprobe are available; subtitle synchronization and YT-DLP are disabled when their optional binaries are missing.

## Libraries

Create libraries with:

- `Name`: display name, such as `Weeb TV`.
- `Type`: `TV`, `Movies`, `TV 3D`, or `Movies 3D`.
- `Path`: local path, UNC path, mapped drive, or mounted network folder.

Movie libraries may contain loose files or individual movie folders. TV libraries may contain season folders, loose episodes, anime layouts, and unmatched videos. Files that cannot be parsed as episodes remain available as movie-like items instead of being discarded.

Periodic scans add new files, remove missing files, and discover newly released episodes for On Deck. Network shares must already be accessible to the account running Media Baker. Windows services should use UNC paths because interactive mapped drives may not exist in the service session.

## Metadata And Subtitles

Enable TMDb in `Admin > Settings` and provide an API key or read access token. Metadata can be preloaded in the background and is permanently cached. Admins and permitted users can search unmatched items, enter a provider ID, rematch incorrect results, edit poster URLs, and inspect duplicate matches.

Enable SubDL to search for subtitles only when requested. Selected subtitles are downloaded beside the media cache and can be synchronized with ffsubsync before being burned into the HLS output.

## YT-DLP

Enable YT-DLP in `Admin > Settings`, select a download folder, and use the Download button in the WebUI. Media Baker requests H.264 video and AAC audio when available, shows active progress, indexes completed files automatically, and generates local thumbnails. Playlist downloads are optional.

## Live TV

Enable IPTV in `Admin > Settings` and choose an M3U playlist or HDHomeRun device. Add an XMLTV EPG URL or mounted file for programme data.

- Channel and EPG sources refresh on a configurable interval and can be reloaded manually.
- EPG channels are fuzzy-matched automatically and can be corrected manually.
- Channel logos are cached locally and stale guide data is removed during refresh.
- Live streams are normalized to browser-compatible H.264/AAC when required.
- Auto, forced, smooth, and per-channel deinterlacing modes are available.
- Rolling HLS uses memory when available and stops FFmpeg after the channel has no viewers.

Live TV access is granted per user like a library permission.

## Authentication

- Browser login returns a persistent session token.
- API keys inherit the selected user's permissions.
- Share URLs grant access to one library only and can be revoked.
- Playback URLs use generated, stream-scoped playback tokens instead of user sessions.
- Admin API routes enforce account permissions; release-update endpoints require a full admin account.

## Updates

Media Baker checks `jazzy348/media-baker` for releases every six hours by default. Only admins see release notifications. Pre-release checks and automatic installation are configurable in `Admin > Settings > Updates`.

Always start Media Baker with `npm start`. The supervisor owns one server child, installs staged source after that child exits, and starts the new version. Active playback stops during an update. Running `node src/server.js` directly disables update installation.

Releases must:

- Match the Git tag to `package.json` and `package-lock.json`.
- Keep `npm start` set to `node src/supervisor.js`.
- Include `src/supervisor.js` and `src/services/updateInstaller.js`.

Update logs and backups are stored under `cache/updates`.

## API Docs

Swagger UI:

```text
http://localhost:5000/api/docs
```

Raw OpenAPI JSON:

```text
http://localhost:5000/api/docs/openapi.json
```

## Backup

Back up `config.json`, `cache/`, `downloads/`, and the MySQL database when enabled.
