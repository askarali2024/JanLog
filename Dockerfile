# JanLog — lightweight real-time log tailer
FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production

# Install production dependencies first for better layer caching.
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

# Application code.
COPY server ./server
COPY public ./public
COPY scripts ./scripts

# Default log directory (mount your real logs over this, or set LOG_PATHS).
RUN mkdir -p /app/logs && chown -R node:node /app
USER node

EXPOSE 8002

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -q --spider http://127.0.0.1:8002/api/sources || exit 1

CMD ["node", "server/index.js"]
