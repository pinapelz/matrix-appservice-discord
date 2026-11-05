FROM node:24-slim AS BUILD
WORKDIR /tmp/src
# install some dependencies needed for the build process
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    make \
    gcc \
    g++ \
    python3 \
    ca-certificates \
    libc-dev \
    wget \
    git \
    && rm -rf /var/lib/apt/lists/*

COPY . /tmp/src
RUN yarn install --frozen-lockfile

FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /data
COPY --from=BUILD /tmp/src/build /build
COPY --from=BUILD /tmp/src/config /config
COPY --from=BUILD /tmp/src/node_modules /node_modules
RUN sh -c 'cd /build/tools; for TOOL in *.js; do LINK="/usr/bin/$(basename $TOOL .js)"; printf "#!/bin/sh\ncd /data\nnode /build/tools/%s \"\$@\"\n" "$TOOL" > "$LINK"; chmod +x "$LINK"; done'
CMD ["node", "/build/src/discordas.js", "-p", "9005", "-c", "/data/config.yaml", "-f", "/data/discord-registration.yaml"]
EXPOSE 9005
VOLUME ["/data"]
