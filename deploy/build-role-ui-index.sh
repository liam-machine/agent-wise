#!/usr/bin/env bash
# =============================================================================
# Wiseway Staff Assistant — generate the role-UI index.html override
# =============================================================================
# LibreChat's built client (dist/index.html) references its JS/CSS bundles by
# content hash, which change on every image build. So instead of hand-editing a
# copy, we GENERATE deploy/wiseway-assets/index.html from the image's own
# index.html and inject two tags: the role-UI stylesheet + boot script.
#
# Mounted over /app/client/dist/index.html (see docker-compose.yml).
#
# RUN THIS:
#   - once, to create the override, then `docker compose up -d librechat`
#   - again after `docker compose pull` brings a newer librechat-dev image
#     (bundle hashes change → the old override would load stale/missing assets)
#
# Idempotent: re-running strips any prior injection before re-adding it.
#   ./deploy/build-role-ui-index.sh
# =============================================================================
set -euo pipefail

CONTAINER="${CONTAINER:-wiseway-librechat}"
DIR="$(cd "$(dirname "$0")" && pwd)"
OUT="$DIR/wiseway-assets/index.html"

echo "Reading index.html from container '${CONTAINER}'..."
docker exec "$CONTAINER" sh -c 'cat /app/client/dist/index.html' > "$OUT.tmp"

python3 - "$OUT.tmp" "$OUT" <<'PY'
import sys, re
src, out = sys.argv[1], sys.argv[2]
html = open(src, encoding='utf-8').read()
# Strip any previous Wiseway injection so this is idempotent.
html = re.sub(r'\n?[ \t]*<!-- wiseway-role-ui:start -->.*?<!-- wiseway-role-ui:end -->\n?',
              '\n', html, flags=re.S)
inject = (
    '    <!-- wiseway-role-ui:start -->\n'
    '    <link rel="stylesheet" href="assets/wiseway-role-ui.css" />\n'
    '    <script src="assets/wiseway-role-ui.js"></script>\n'
    '    <!-- wiseway-role-ui:end -->\n'
)
if '</head>' not in html:
    raise SystemExit('ERROR: no </head> found in index.html')
html = html.replace('</head>', inject + '  </head>', 1)
open(out, 'w', encoding='utf-8').write(html)
print('Wrote', out)
PY

rm -f "$OUT.tmp"
echo "Done. Now: docker compose up -d librechat   (recreates with the mounts)"
