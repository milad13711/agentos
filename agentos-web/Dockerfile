# AgentOS Web — multi-stage build producing a minimal standalone server.

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json ./
RUN npm install

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# AGENTOS_API_URL isn't needed at build time (only used server-side at
# request time), so no build-arg plumbing required here.
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
# Docker sets HOSTNAME to the container ID automatically; the Next.js
# standalone server binds to that instead of all interfaces unless we
# override it, which breaks both the HEALTHCHECK below and anything
# reaching the container via "localhost". Force it to bind everywhere.
ENV HOSTNAME=0.0.0.0

# Standalone output already contains a minimal node_modules subset + server.js
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://localhost:3000/login').then(r=>process.exit(r.ok||r.status===200?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
