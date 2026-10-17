FROM lscr.io/linuxserver/plex:1.43.4

RUN apt-get update && \
    apt-get install -y supervisor nodejs npm && \
    apt-get clean

# Copy and build NestJS application
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN npm install -g pnpm

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

# Use BuildKit cache for pnpm store
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --force --dangerously-allow-all-builds

COPY src ./src
COPY migrations ./migrations
COPY .config ./.config
COPY tsconfig.json tsconfig.build.json ./
RUN pnpm run build

COPY docker/supervisord.conf /supervisord.conf
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 32400 32404

ENV DATABASE_URL=sqlite:///config/flex.sqlite
ENV FLEX_PORT=32404
ENV MEDIA_NOT_FOUND_VIDEO=http://127.0.0.1:32404/assets/MediaNotFound.mp4
ENV PLEX_PREFERENCES_PATH="/config/Library/Application Support/Plex Media Server/Preferences.xml"
ENV PLEX_BASE=http://127.0.0.1:32400

ENTRYPOINT ["/entrypoint.sh"]