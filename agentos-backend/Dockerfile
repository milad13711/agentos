# AgentOS Backend — mostly pure Node core (node:http, node:sqlite,
# node:crypto); real dependencies: `pg` (only used when DATABASE_URL is set,
# see agentos-deploy/DEPLOY.md) and `socks-proxy-agent` (only used when
# TELEGRAM_SOCKS_PROXY is set, for deployments where api.telegram.org is
# network-filtered — see src/telegram.js).
FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src ./src
COPY scripts ./scripts

# Persistent SQLite file lives here — mount a volume at /app/data in
# docker-compose so data survives container restarts/rebuilds.
RUN mkdir -p /app/data
VOLUME ["/app/data"]

ENV PORT=8787
ENV AGENTOS_DB_PATH=/app/data/agentos.sqlite
EXPOSE 8787

# Basic container-level healthcheck hitting the real health endpoint.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://localhost:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
