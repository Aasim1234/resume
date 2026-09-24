# Node 24 LTS (matches local development)
FROM node:24-alpine

WORKDIR /usr/src/app
ENV NODE_ENV=production

# Install dependencies first for better layer caching
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# App source: server, page, static assets
COPY server.js index.html ./
COPY public ./public

# Persistent data (db.json, uploads/, screenshots/) lives in /usr/src/app/data.
# Mount a volume there so it survives container restarts.
ENV DATA_DIR=/usr/src/app/data
RUN mkdir -p "$DATA_DIR" && chown -R node:node "$DATA_DIR"
VOLUME ["/usr/src/app/data"]

# Don't run as root
USER node

# Unprivileged port (non-root user). Map it on the host: docker run -p 80:3000 ...
ENV PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -q -O - "http://localhost:${PORT}/api/health" || exit 1

CMD ["node", "server.js"]
