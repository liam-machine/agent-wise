# Wiseway role-scoped MCP doc-search tool.
# node:20-slim per the shared build contract.
FROM node:20-slim

ENV NODE_ENV=production
WORKDIR /app

# Install dependencies first for better layer caching.
COPY package.json ./
# package-lock.json is optional; copy it if present so `npm ci` can be used.
COPY package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

# Application source.
COPY server.js backend.js roles.yaml ./
COPY backends ./backends

# The sample-docs corpus is bind-mounted at runtime (../sample-docs ->
# /app/sample-docs) for the local backend; SAMPLE_DOCS_DIR defaults to it.
ENV SAMPLE_DOCS_DIR=/app/sample-docs \
    PORT=8000 \
    WISEWAY_DOC_BACKEND=local

EXPOSE 8000

CMD ["node", "server.js"]
