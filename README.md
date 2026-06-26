# Media Baker

Media Baker is a Node/Express media library app for indexing local folders, managing users/libraries, and serving HLS playback through FFmpeg.

## Features

- WebUI with accounts, permissions, API keys, share URLs, and per-user watch state.
- Dynamic library management from the admin panel.
- TV, movie, anime, 3D, loose-file, and Plex-style folder scanning.
- Lazy library browsing, fuzzy catalog search, On Deck, watch history, and currently-playing admin view.
- HLS generation with cache reuse, one-transcode-per-file locking, pre-generation, and fallback error stream.
- Audio/subtitle selection, subtitle burn-in, downloaded subtitle search, and optional subtitle sync.
- Quality presets for original, medium, and low playback.
- 5.1 options including preserve, stereo mixdown, and Stabby Cinema 5.1 channel remap.
- ProTV/VRChat URL support including resume time and 3D mode parameters.
- Optional TMDb metadata, poster cache, episode thumbnails, manual matching, and manual poster URLs.
- Optional MySQL storage for index, settings, accounts, sessions, metadata, and playback progress.
- JSON storage fallback when MySQL is disabled.
- Runtime settings in the admin panel for metadata, subtitles, HLS, scans, logging, GPU, and fallback stream.
- Daily rotating log files with configurable retention.
- Swagger/OpenAPI docs at `/api/docs`.

## Standalone Setup

1. Install Node.js 20 or newer.

2. Install dependencies:

   ```powershell
   npm install
   ```

3. Create `config.json`:

   ```powershell
   Copy-Item config.example.json config.json
   ```

4. Edit `config.json` with the settings Media Baker needs before the WebUI is available:

   ```json
   {
     "port": 5000,
     "mysql": false
   }
   ```

   Use MySQL instead with:

   ```json
   {
     "port": 5000,
     "mysql": {
       "enabled": true,
       "host": "localhost",
       "port": 3306,
       "user": "media_baker",
       "password": "password",
       "database": "media_baker",
       "connectionLimit": 5
     }
   }
   ```

5. Add optional binaries:

   ```text
   bin/ffmpeg.exe
   bin/ffprobe.exe
   bin/ffsubsync.exe
   ```

   If these are missing, Media Baker uses commands from `PATH`.

6. Add the fallback video:

   ```text
   fallback/404.mp4
   ```

7. Start the app:

   ```powershell
   npm start
   ```

8. Open:

   ```text
   http://localhost:5000
   ```

On first launch, create the first admin account, then add libraries from `Admin > Libraries`.

## Configuration

`config.json` is the startup configuration file. It is read when Media Baker starts and is used for settings that must exist before the database, account system, and WebUI settings are loaded.

Common `config.json` values:

- `port`: HTTP port. The default is `5000`.
- `mysql`: set to `false` for JSON storage, or provide MySQL credentials.
- `libraries`: optional first-run library import. After first launch, manage libraries in the WebUI.

Settings managed in the WebUI:

- `Admin > Settings`: metadata, subtitles, HLS, GPU, fallback stream, scans, logging, and playback behavior.
- `Admin > Libraries`: media folders, library order, re-indexing, and share URLs.
- `Admin > Accounts`: users, passwords, permissions, and library access.
- `Admin > API Keys`: user-scoped API keys.

When MySQL is enabled, Media Baker stores runtime settings, accounts, sessions, metadata, playback progress, and the media index in MySQL. When MySQL is disabled, the same data is stored under `cache/`.

Standalone paths:

- `cache/`: generated data, JSON stores, HLS cache, metadata cache, playback secret, and subtitle cache.
- `cache/logs/YYYY-MM-DD.log`: daily app log files.
- `fallback/404.mp4`: fallback video source.
- `bin/`: optional location for `ffmpeg.exe`, `ffprobe.exe`, and `ffsubsync.exe`.

If FFmpeg or FFprobe is missing, the WebUI shows a banner and disables playback actions until the binaries are installed or configured. If subtitle search and auto-sync are enabled, Media Baker also checks `ffsubsync` and shows a warning when it is missing.

## Libraries

Create libraries in the WebUI with:

- `Name`: display name, such as `Weeb TV`.
- `Type`: `TV`, `Movies`, `TV 3D`, or `Movies 3D`.
- `Path`: local path, mapped drive, or mounted network folder.

Movie libraries can contain loose files or folders. TV libraries can contain normal season folders, loose episode files, anime-style folders, and unmatched videos. Files that cannot be parsed as episodes are still indexed as movie-like items.

## Authentication

- User login returns a session token.
- API keys inherit the selected user's permissions.
- Share URLs grant access to one library only.
- Playback URLs use generated `playbackToken` values, not user sessions.

## API Docs

Open Swagger UI at:

```text
http://localhost:5000/api/docs
```

The raw OpenAPI document is:

## Docker

For Docker deployment, use [README.docker.md](README.docker.md).
