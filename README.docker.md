# Media Baker Docker Setup

Use this guide for Docker deployments. The image installs Linux `ffmpeg`, `ffprobe`, and `ffsubsync`; do not configure Windows `.exe` paths in Docker.

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

## Fixed Container Paths

Docker mode is enabled with `MEDIA_BAKER_DOCKER=1`.

These paths are fixed inside the container:

- `/config/config.json`
- `/cache`
- `/logs`
- `/fallback/404.mp4`
- `/media/...` for mounted media folders

Use the WebUI for runtime settings and library management. In Docker, `config.json` only needs startup settings such as `port` and optional MySQL credentials.

## Setup

1. Create folders and config:

   ```powershell
   New-Item -ItemType Directory -Force cache, fallback, logs
   Copy-Item config.example.json config.json
   ```

2. Put your fallback video here:

   ```text
   fallback/404.mp4
   ```

3. Edit `config.json`:

   ```json
   {
     "port": 5000,
     "mysql": false
   }
   ```

   MySQL is optional. If enabled, create the database first and put the credentials in `config.json`.

   Runtime settings such as metadata, subtitles, HLS, fallback stream, GPU encoding, scans, and logging are changed in `Admin > Settings` after startup.

4. Edit `docker-compose.yml` media mounts:

   ```yaml
   volumes:
     - "./config.json:/config/config.json:ro"
     - "./cache:/cache"
     - "./logs:/logs"
     - "./fallback:/fallback:ro"
     - "/mnt/media/TV Shows:/media/tv:ro"
     - "/mnt/media/Movies:/media/movies:ro"
   ```

5. Build and start:

   ```powershell
   docker compose up -d --build
   ```

6. Open:

   ```text
   http://localhost:5000
   ```

On first launch, create the first admin account, then add libraries using container paths such as `/media/tv` and `/media/movies`.

## SMB And NAS Media

Mount SMB/NAS shares on the Docker host, then bind-mount the mounted folder into the container.

Linux example:

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

On Windows Docker Desktop, prefer local paths such as:

```yaml
- "D:/Media/Movies:/media/movies:ro"
```

Mapped drive letters such as `Z:` are usually not visible inside Docker.

## GPU Encoding

Enable GPU encoding in `Admin > Settings`.

The Docker image already includes Linux `ffmpeg`, `ffprobe`, `ffsubsync`, Intel VAAPI drivers, Mesa VAAPI drivers, and `vainfo`.

NVIDIA is different: the NVIDIA Container Toolkit must be installed on the Docker host because it configures Docker to pass the host GPU devices and driver libraries into containers. It cannot be baked into this app image in a useful way.

Ubuntu/Debian host example:

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

Then enable GPU access in `docker-compose.yml`:

```yaml
gpus: all
```

For Intel QSV or VAAPI on Linux hosts, pass `/dev/dri` into the container:

```yaml
devices:
  - /dev/dri:/dev/dri
```

The app tests available FFmpeg H.264 hardware encoders and caches the selected profile. If no hardware encoder works, it falls back to CPU.

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
