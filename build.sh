# docker build -f docker/Dockerfile -t flexmediaserver/flex-lite .
docker buildx build --platform linux/amd64,linux/arm64 -f docker/Dockerfile . -t ghcr.io/flexmediaserver/flex-lite --push