# Builds our own minimal Xray-core image instead of pulling a third-party
# one from Docker Hub (docker.io/teddysun/xray got a 403 Forbidden trying to
# pull from the production server — docker.io/library/* official images
# like node:22-alpine pull fine, so this is specific to that repo, not a
# blanket Docker Hub block; downloading the official release directly from
# GitHub sidesteps it either way).
FROM alpine:latest

RUN apk add --no-cache curl unzip ca-certificates

RUN curl -fsSL -o /tmp/xray.zip \
      https://github.com/XTLS/Xray-core/releases/latest/download/Xray-linux-64.zip \
    && unzip /tmp/xray.zip -d /usr/local/bin xray \
    && chmod +x /usr/local/bin/xray \
    && rm /tmp/xray.zip

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/bin/sh", "/entrypoint.sh"]
