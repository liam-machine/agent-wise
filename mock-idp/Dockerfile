# Wiseway mock phone+PIN OIDC provider — demo image.
FROM node:20-alpine

WORKDIR /app

# Install dependencies first for better layer caching.
COPY package.json ./
# No lockfile is committed for this demo service, so use `npm install`.
RUN npm install --omit=dev

# App source.
COPY server.js staff.js ./
COPY views ./views

# Issuer + listen port. The issuer MUST match LibreChat's OPENID_ISSUER and the
# string the browser is redirected to (see README.md).
ENV ISSUER=http://host.docker.internal:9000
ENV PORT=9000

EXPOSE 9000

CMD ["node", "server.js"]
