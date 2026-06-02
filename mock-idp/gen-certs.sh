#!/usr/bin/env bash
# =============================================================================
# Generate a self-signed TLS certificate for the MOCK IdP (local dev only).
#
# LibreChat's OIDC strategy refuses a plain-HTTP issuer, so the mock IdP serves
# HTTPS. This script writes a throwaway self-signed cert that the LibreChat
# container trusts via NODE_EXTRA_CA_CERTS (see docker-compose.yml).
#
# NOT for production. With Wiseway's real SSO you use their CA-signed endpoint
# and delete this whole mock-idp service.
#
# Usage:  ./mock-idp/gen-certs.sh
# =============================================================================
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)/certs"
mkdir -p "$DIR"

CNF="$(mktemp)"
cat > "$CNF" <<'EOF'
[req]
distinguished_name = dn
x509_extensions    = v3
prompt             = no
[dn]
CN = host.docker.internal
[v3]
subjectAltName   = DNS:host.docker.internal,DNS:localhost,IP:127.0.0.1
basicConstraints = CA:FALSE
keyUsage         = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
EOF

openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$DIR/idp.key" -out "$DIR/idp.crt" \
  -days 825 -config "$CNF" >/dev/null 2>&1

rm -f "$CNF"
echo "✓ wrote $DIR/idp.crt and $DIR/idp.key (self-signed, host.docker.internal/localhost/127.0.0.1)"
