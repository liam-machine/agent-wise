# Wiseway admin feedback dashboard (read-only). node:20-slim per the shared
# build contract (mirrors mcp-doc-search).
FROM node:20-slim

ENV NODE_ENV=production
WORKDIR /app

# Install dependencies first for better layer caching.
COPY package.json ./
COPY package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

# Application source (single file — the HTML page is inlined in server.js).
COPY server.js ./

ENV PORT=8050 \
    MONGO_URI=mongodb://mongodb:27017/LibreChat

EXPOSE 8050

CMD ["node", "server.js"]
