# Media Baker Docker Setup

Use this guide for Docker deployments. The image includes Node.js, Linux FFmpeg and FFprobe, ffsubsync, yt-dlp, Intel and Mesa VAAPI drivers, and the Media Baker WebUI.

## Features

- WebUI with accounts, permissions, API keys, share URLs, self-service account settings, and per-user watch state.
- Dynamic library creation, removal, ordering, folder browsing, and background re-indexing from the admin panel.
- TV, movie, music, image, anime, 3D, loose-file, and Plex-style folder scanning, including `S01E01` and `1x01` episode names.
- Recently added and randomized home rows, lazy library browsing, metadata-first search, show/season views, and random episode selection.
- On Deck, next-episode handling, watch history, resume playback, and currently-playing admin view.
- Browser playback and copyable HLS URLs for external players, with automatic next-episode and next-track playback, a movable themed music player, and minimizable floating video.
- HLS cache reuse, one-transcode-per-file locking, pre-generation, quality presets, and fallback error stream.
- Audio/subtitle selection, subtitle burn-in, SubDL search, subtitle sync, preserved 5.1, stereo mixdown, and Stabby Cinema 5.1 remapping.
- ProTV and VRChat URL support including resume time and stereoscopic 3D mode parameters.
- TMDb video metadata and MusicBrainz music metadata with 1024px WebP artwork caching, aliases, season artwork, episode thumbnails, manual matching, poster editing, and duplicate detection.
- YT-DLP downloads with progress, automatic indexing, and generated thumbnails.
- M3U and HDHomeRun Live TV with EPG refresh/matching, cached logos, deinterlacing, and rolling HLS.
- MySQL storage or local JSON fallback for indexes, settings, accounts, sessions, metadata, and playback progress.
- Admin settings, database backup/restore, hardware/network graphs, currently playing, live logs, history, and rotating log files.
- Admin-only GitHub release notifications and optional automatic source updates.
- Swagger/OpenAPI documentation at `/api/docs`.

## Fixed Container Paths

Docker mode is enabled with `MEDIA_BAKER_DOCKER=1`.

| Container path | Purpose |
| --- | --- |
| `/config/config.json` | Startup configuration |
| `/cache` | JSON data, metadata, HLS, thumbnails, subtitles, playback state, database backups, and source updates |
| `/cache/app/current` | Automatically installed application source |
| `/logs` | Daily log files |
| `/downloads` | YT-DLP output |
| `/fallback/404.mp4` | Optional fallback source |
| `/media/...` | Mounted media libraries |

Use the WebUI for runtime settings and library management. `config.json` only contains the port and optional MySQL credentials.

## Setup

0. Pull the repo.
   Windows Powershell and linux
   
   ```powershell and linux
   git clone git clone https://github.com/jazzy348/media-baker.git
   cd media-baker
   ```
   

2. Create folders and configuration.

   Windows PowerShell:

   ```powershell
   New-Item -ItemType Directory -Force cache, fallback, logs, downloads
   Copy-Item config.example.json config.json
   ```

   Linux:

   ```bash
   mkdir -p cache fallback logs downloads
   cp config.example.json config.json
   ```

3. Put the optional fallback video at `fallback/404.mp4`.

4. Edit `config.json`:

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

5. Edit media mounts in `docker-compose.yml`:

   ```yaml
   volumes:
     - "./config.json:/config/config.json:ro"
     - "./cache:/cache"
     - "./logs:/logs"
     - "./downloads:/downloads"
     - "./fallback:/fallback:ro"
     - "/mnt/media/TV Shows:/media/tv:ro"
     - "/mnt/media/Movies:/media/movies:ro"
   ```

6. Build and start:

   ```powershell
   docker compose up -d --build
   ```

7. Open `http://localhost:5000`.

On first launch, create the first admin account, then add libraries using container paths such as `/media/tv` and `/media/movies`.

Configure manual or scheduled database snapshots in `Admin > Backup & Restore`. The default destination is `/cache/backups`, which persists through the existing `./cache:/cache` mount. A restore replaces the configured MySQL database or JSON stores and restarts the supervised app process.

## SMB And NAS Media

Mount SMB/NAS shares on the Docker host, then bind-mount the mounted folder:

```yaml
volumes:
  - "/mnt/media:/media:ro"
```

Docker-managed CIFS example:

```yaml
services:
  media-baker:
    volumes:
      - "media-share:/media:ro"

volumes:
  media-share:
    driver: local
    driver_opts:
      type: cifs
      device: "//192.168.1.200/Media"
      o: "username=media-user,password=media-password,vers=3.0,ro"
```

Protect share credentials. On Windows Docker Desktop, use local paths such as:

```yaml
- "D:/Media/Movies:/media/movies:ro"
```

Mapped drive letters such as `Z:` are normally unavailable inside Docker.

## GPU Encoding

Enable GPU encoding in `Admin > Settings`. Media Baker detects supported H.264 hardware encoders at startup, caches the selected profile, and falls back to `libx264`.

The image includes the userspace components for modern and legacy Intel VAAPI, Intel QSV, and AMD VAAPI. The supplied `docker-compose.yml` contains commented GPU passthrough blocks so the appropriate one can be enabled for the Docker host.

### NVIDIA

NVIDIA driver libraries must match the host driver, so the NVIDIA Container Toolkit injects them into the container at runtime. Install the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html) on the Docker host:

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg2

curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
  | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg

curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
  | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
  | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list

sudo apt-get update
sudo apt-get install -y nvidia-container-toolkit
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker
```

Enable access in `docker-compose.yml`:

```yaml
container_name: media-baker
gpus: all #Put under here ^
```

### Intel And AMD

Pass `/dev/dri` into the container:

```yaml
devices:
  - /dev/dri:/dev/dri
```

The image already includes Intel QSV/VAAPI and AMD VAAPI userspace drivers plus `vainfo`; the host device still needs to be passed through as shown above.

## YT-DLP

Enable YT-DLP in `Admin > Settings`, choose the `/downloads` path or another mounted container folder, and use the Download button in the WebUI. Completed files are indexed automatically and receive generated thumbnails.

## Live TV

Enable IPTV in `Admin > Settings` and choose an M3U source or HDHomeRun device. Add an XMLTV EPG URL or mounted guide file when programme data is required.

- Source refresh interval and startup buffer are configurable.
- EPG matching is automatic with manual channel overrides.
- Channel logos are cached locally.
- Incompatible streams are transcoded to H.264/AAC.
- Global and per-channel deinterlacing modes are available.
- Live HLS uses shared memory when available and stops inactive FFmpeg processes.

The supplied Compose file reserves 512 MB of shared memory.

## Updates

Configure release checks, prereleases, and automatic installation in `Admin > Settings > Updates`. Only admins see release notifications.

The supervisor installs source releases under `/cache/app/current`, stops its server child, and starts the new version. The `/cache` mount preserves source updates across container recreation. Active streams stop during an update.

Rebuild the image when a release changes Node.js, FFmpeg, system packages, the supervisor, or Docker configuration:

```powershell
git pull
docker compose up -d --build
```

## Useful Commands

Build and start:

```powershell
docker compose up -d --build
```

View logs:

```powershell
docker compose logs -f media-baker
```

Restart:

```powershell
docker compose restart media-baker
```

Stop:

```powershell
docker compose down
```

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

Back up `config.json`, `cache/`, `logs/`, `downloads/`, and the MySQL database when enabled.
