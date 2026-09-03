# Media Baker Docker Setup

This guide covers Media Baker's Docker deployment. For application features and standalone installation, see the [main README](README.md).

The image currently contains:

- Node.js 24.
- FFmpeg and FFprobe.
- ffsubsync and yt-dlp in a Python virtual environment.
- Intel QSV/VAAPI and Mesa VAAPI userspace packages.
- `tini` for process supervision.
- The Media Baker WebUI and source-update supervisor.

Docker mode is selected by `MEDIA_BAKER_DOCKER=1`, which is already set by the supplied Dockerfile.

## Container Paths

| Container path | Purpose |
| --- | --- |
| `/config/config.json` | Read-only startup configuration |
| `/cache` | JSON stores, metadata, artwork, HLS, subtitles, keyframes, backups, branding derivatives, and source updates |
| `/cache/app/current` | Source installed by Media Baker's updater |
| `/logs` | Daily rotating log files |
| `/downloads` | Default YT-DLP output |
| `/fallback/404.mp4` | Optional fallback source |
| `/media/...` | User-defined media mounts |

Keep `/cache` persistent even when MySQL is enabled. Generated artwork, HLS fragments, update state, and other disk-backed data are not stored in MySQL.

## Setup

1. Clone the repository:

   ```bash
   git clone https://github.com/jazzy348/media-baker.git
   cd media-baker
   ```

2. Create persistent folders and the configuration file.

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

3. Edit `config.json`:

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

   When MySQL runs in another Compose service, set `host` to that service name rather than `localhost`.

4. Optionally place a fallback video at `fallback/404.mp4`.

5. Edit the media mounts in `docker-compose.yml`:

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

   ```bash
   docker compose up -d --build
   ```

7. Open `http://localhost:5000`, create the first administrator account, then add libraries using container paths such as `/media/tv`.

The WebUI manages runtime settings. `config.json` remains limited to settings required before the application database is available.

## Media Mounts

Media Baker only sees container paths. A host path such as `/mnt/media/Movies` must be configured in the WebUI using its mounted path, such as `/media/movies`.

Read-only mounts are sufficient for indexing and playback:

```yaml
- "/mnt/media/Movies:/media/movies:ro"
```

The optimiser replaces validated source files and therefore requires a writable mount:

```yaml
- "/mnt/media/Movies:/media/movies"
```

YT-DLP output, downloaded subtitles, and any other path that Media Baker writes must also be backed by a writable persistent mount. Ensure the container process has permission to read and write the corresponding host directories.

Unreadable subdirectories are logged and skipped; they no longer stop the remainder of a library scan.

## SMB And NAS Media

The simplest approach is to mount the share on the Docker host and bind-mount it:

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

Protect credentials in production, preferably with Docker secrets or a credentials file. On Windows Docker Desktop, use a shared host path:

```yaml
- "D:/Media/Movies:/media/movies:ro"
```

Mapped drive letters such as `Z:` are not normally available inside Linux containers.

## MySQL

MySQL is optional. When disabled, persistent structured data is written below `/cache`. When enabled, Media Baker creates and manages its tables in the configured database.

Example with a Compose service:

```yaml
services:
  media-baker:
    depends_on:
      - mysql

  mysql:
    image: mysql:8
    environment:
      MYSQL_DATABASE: media_baker
      MYSQL_USER: media_baker
      MYSQL_PASSWORD: change-me
      MYSQL_ROOT_PASSWORD: change-root
    volumes:
      - "./mysql:/var/lib/mysql"
```

`config.json` would use:

```json
{
  "mysql": {
    "enabled": true,
    "host": "mysql",
    "port": 3306,
    "user": "media_baker",
    "password": "change-me",
    "database": "media_baker",
    "connectionLimit": 5
  }
}
```

Do not expose MySQL publicly unless it is separately secured.

## Custom Metadata Services

Select `Custom` under `Admin > Settings > Metadata`, then enter the compatible service's base URL and API key. Containers on the same network should use a Compose service hostname:

```text
http://metadata-service:5051
```

Do not use `localhost` for a metadata service running in another container. Use the other container's Compose service name and internal port, such as `http://metadata-service:5051`.

If the metadata service runs on the Docker host instead, Docker Desktop users can normally use a URL such as `http://host.docker.internal:5051`. On Linux, use the host's reachable LAN address or configure the `host.docker.internal` host-gateway mapping in Compose.

The custom service may use any metadata sources. It only needs to provide the endpoints and response format described in the [Custom Metadata API specification](README.metadata-service-api.md).

## GPU Acceleration

Enable GPU acceleration in `Admin > Settings`. Media Baker can use hardware decoding and encoding for streaming and optimisation, and falls back to software when a detected path fails.

The Hardware page can display NVIDIA, Intel, or AMD activity when the host, container, and operating-system counters expose it. GPU usage monitoring and FFmpeg acceleration are related but separate capabilities.

### NVIDIA

Install the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html) on the Docker host, then enable the existing Compose option:

```yaml
services:
  media-baker:
    gpus: all
```

The host driver provides matching NVIDIA libraries at runtime. The image sets `NVIDIA_DRIVER_CAPABILITIES=compute,video,utility`.

### Intel And AMD

Pass the host DRM devices into the container:

```yaml
services:
  media-baker:
    devices:
      - "/dev/dri:/dev/dri"
```

The image includes Intel and Mesa VAAPI userspace packages plus `vainfo`. Device permissions and driver support still depend on the Docker host.

Useful checks:

```bash
docker compose exec media-baker vainfo
docker compose exec media-baker ffmpeg -hide_banner -encoders
```

## YT-DLP

The default output is `/downloads`. Enable YT-DLP in Settings and keep that mount writable.

- Administrators can update yt-dlp from the WebUI.
- YouTube `cookies.txt` data is stored under the persistent cache and is only supplied for YouTube URLs.
- Node.js 24 is passed to yt-dlp as its JavaScript runtime.
- Channel subscriptions download the existing channel catalogue and then check for new uploads. The default interval is 24 hours.
- Subscription download archives are stored in `/cache`, so they survive container recreation.
- Live URLs can be recorded to the library or relayed through rolling HLS.

## HLS, Storage, And Shared Memory

HLS data is generated below `/cache`. Media Baker can remove inactive HLS caches when free space falls below the configured reserve, while active readers and transcodes remain protected. Size the cache volume for concurrent streams and long media.

The supplied Compose file reserves 512 MiB of shared memory:

```yaml
shm_size: "512mb"
```

Live TV uses shared memory when available and falls back to disk-backed cache behavior where necessary.

## OpenMovie

OpenMovie is a simplified API for building lightweight clients around Media Baker, including clients running in restricted environments such as VRChat. It supplies ready-made catalogues, poster atlases, playback variants, On Deck data, and playback URLs without requiring the client to reproduce the full WebUI.

OpenMovie is disabled by default and is controlled in `Admin > Settings`. A client sends an API key only to the initial authentication endpoint. That endpoint returns encrypted access URLs used for later catalogue, artwork, and playback requests. OpenMovie registries and the unique encryption secret for the deployment are stored with the application's persistent data and included in Media Baker backups.

Do not publish `/cache`, `config.json`, API keys, or backup files through a web server.

## Branding

Media Baker selects one source icon on first startup and stores generated sizes in `/cache`. The selection remains stable across restarts and can be changed in Settings.

To add a custom source icon to a Docker deployment, add its transparent PNG to `public/icons` in the build context and rebuild the image. Generated derivatives remain in the persistent cache.

## Updates

Configure release checks, prereleases, and automatic installation in `Admin > Settings > Updates`. The supervisor installs source releases and npm production dependencies under `/cache/app/current`, then restarts the server child. The `/cache` mount preserves those source updates across an ordinary container restart or recreation.

Rebuild the image when a release changes Node.js, FFmpeg, Python tools, system packages, the Dockerfile, Compose configuration, or the supervisor:

```bash
git pull
docker compose up -d --build
```

Active streams stop during either update method.

## Backup And Restore

`Admin > Backup & Restore` can create manual or scheduled compressed snapshots. The default destination is `/cache/backups`.

- MySQL mode snapshots all Media Baker tables.
- JSON mode snapshots the persistent application stores.
- OpenMovie capability secrets and registries are included.
- A restore replaces the selected storage backend and restarts Media Baker.

Separately back up:

- `config.json`.
- `cache/`.
- `downloads/`.
- Custom icons and the fallback source.
- The MySQL volume when MySQL is enabled.
- Media files, especially when the optimiser has write access.

## Useful Commands

Build and start:

```bash
docker compose up -d --build
```

View logs:

```bash
docker compose logs -f media-baker
```

Restart:

```bash
docker compose restart media-baker
```

Stop:

```bash
docker compose down
```

Open a shell:

```bash
docker compose exec media-baker sh
```

## API Documentation

Swagger UI:

```text
http://localhost:5000/api/docs
```

Raw OpenAPI JSON:

```text
http://localhost:5000/api/docs/openapi.json
```
