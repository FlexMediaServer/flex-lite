FROM lscr.io/linuxserver/plex

RUN apt-get update && \
    apt-get install -y curl unzip wget fuse3 supervisor nodejs npm && \
    apt-get clean

RUN mkdir -p /run/plex-temp
RUN curl https://rclone.org/install.sh | bash

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

COPY docker/rclone.conf /root/.config/rclone/rclone.conf
COPY docker/supervisord.conf /supervisord.conf
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 32400

ENTRYPOINT ["/entrypoint.sh"]