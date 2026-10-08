# Flex Media Server (PMS Middleware)

Flex is a custom Plex server that connects Plex clients to Stremio providers. Here's how it works:

1. **Browse** - Search for a show/movie. Flex fetches metadata from Plex's discover service
2. **Play** - Press play and Flex queries your Stremio provider for available sources
3. **Stream** - Flex selects the first available source (with automatic fallbacks if one fails) and sends it to Plex to ingest

Flex makes no attempt to grant Plex Pass features for free - it is not a way to dodge a subscription. If you enjoy the experience, consider buying Plex Pass to support Plex.

Please note that this is currently in **beta**. I use it for my own Plex setup and actively update it, but things may occasionally break or behave unexpectedly. Please keep this in mind when using it.

## Docker Compose Setup

Here's how to get Flex up and running.

### What You'll Need

- Docker and Docker Compose installed
- **A reverse proxy (required)** - nginx, Traefik, Caddy, or something like that to expose Flex over HTTPS
- A Plex claim token from https://www.plex.tv/claim

### Ports

The Flex container runs a single image containing both Plex and the Flex proxy layer:

### docker-compose.yml

Create a `docker-compose.yml` file with the following configuration:

```yaml
version: '3.9'

services:
    flex:
        image: ghcr.io/flexmediaserver/server
        restart: unless-stopped
        environment:
            CLAIM_TOKEN: <claim token>
            MEDIA_NOT_FOUND_VIDEO: https://flex.example.com/assets/MediaNotFound.mp4
            STREMIO_ADDON: https://aiostreams.example.com/stremio/fcff3eeb-2cae-4924-9890-d32d856ade5b/xjXWkhjjrpDshlbARGiMscmVDrTsmiDUfQqVvfIcKiIhqVuwKiVQSiltKmwVMDYtjCKeCDzIBEQNJekIYRLAJTauErlkGtxMeXedRKFdsFlUJcbZjaHfiZpeCRqVMTiOeCbNWOEYaoygdJOpBSxNUO/manifest.json
        volumes:
            - ./flex:/config
```

### Configuration

Environment variables supported by Flex:

| Variable | Description |
| -------- | ----------- |
| `CLAIM_TOKEN` | Plex claim token from https://www.plex.tv/claim |
| `STREMIO_ADDON` | Full Stremio addon manifest URL (required). e.g. `https://aiostreams.example.com/stremio/<token>/manifest.json` |
| `MEDIA_NOT_FOUND_VIDEO` | HTTP path for the video returned when no media can be resolved |
| `PLEX_SERVICE_TOKEN_SEED` | Seed for reading Plex scrobble tokens |

Once the Plex is running, disable Remote Access in the settings, then add a custom endpoint that points to your HTTP(S) reverse proxy.

### Reverse Proxy Setup (Required)

You must have a reverse proxy as Flex does not (yet) support plex.direct subdomains via https. Your reverse proxy needs to:

- Expose Flex over **HTTPS**
- Forward all requests to the Flex container at `http://flex:32404` — Flex handles passthrough to Plex and transcode sessions internally, so a single endpoint is all you need
- You must use a dedicated subdomain
- Handle SSL/TLS certificates (I suggest using LetsEncrypt)

**Example nginx configuration (single subdomain):**
```nginx
server {
    listen 443 ssl http2;
    server_name flex.example.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://flex:32404;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # The below properties are important for the transcoder to work properly
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
        keepalive_timeout 86400s;
        send_timeout 86400s;
        proxy_buffering off;
    }
}
```

### Deployment

1. Save the docker-compose.yml file wherever
2. Edit the environment variables (especially your claim token and domain)
3. Create a config directory:
   ```bash
   mkdir -p ./flex
   ```
4. Spin it up:
   ```bash
   docker-compose up -d
   ```
5. Set up your reverse proxy to point to the Flex container on port `32404`
6. Tail the logs to see if anything exploded:
   ```bash
   docker-compose logs -f flex
   ```
7. Your Flex instance will be live at your reverse proxy URL (e.g., `https://flex.example.com`)


### Known issues
Playback tracking is showing my user
 * This is because Plex only allows transiently ingested items to be accessed by the server owner's token. This will be fixed in later releases.

Not able to watch content locally without Plex Pass
 * This is because the current all-in-one docker image does not support going into host networking mode. May be addressed in later updates