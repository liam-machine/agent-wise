#!/usr/bin/env bash
# =============================================================================
# Wiseway Staff Assistant — seed business roles into Mongo
# =============================================================================
# LibreChat's OIDC strategy lands EVERY new user as role USER. The custom
# Wiseway business role (warehouse | driver | office | hr-admin) is a separate
# string on the user document that the MCP doc-search tool reads via the
# {{LIBRECHAT_USER_ROLE}} header. This script writes that business role onto
# each demo user, keyed by email.
#
# Field written: user.role  (the value LibreChat substitutes into
#                {{LIBRECHAT_USER_ROLE}} for the X-User-Role MCP header).
#
# WHEN TO RUN:
#   - Each demo user must have signed in via the Wiseway Staff Login at least
#     once (so their user document exists in Mongo), OR you can pre-seed and the
#     update will simply match 0 docs until they log in — re-run after login.
#   - The script is idempotent: re-running just re-sets the same values.
#
# USAGE:
#   ./deploy/seed-roles.sh
# The script runs mongosh INSIDE the running compose mongodb container, so you
# do not need mongosh installed on the host. Requires the stack to be up:
#   docker compose up -d
# =============================================================================
set -euo pipefail

MONGO_SERVICE="${MONGO_SERVICE:-mongodb}"
MONGO_DB="${MONGO_DB:-LibreChat}"
COMPOSE="${COMPOSE:-docker compose}"

echo "Seeding Wiseway business roles into Mongo db '${MONGO_DB}' (container '${MONGO_SERVICE}')..."

# Heredoc of an idempotent mongosh script. Each updateOne is keyed by email and
# sets the business role string. setOnInsert is NOT used: we want to overwrite
# an existing USER-defaulted role with the correct business role every run.
read -r -d '' SEED_JS <<'JS' || true
const mapping = [
  { email: "sam.tran@wiseway.demo",    role: "warehouse", name: "Sam Tran (Warehouse)" },
  { email: "dee.okafor@wiseway.demo",  role: "driver",    name: "Dee Okafor (Driver)" },
  { email: "olivia.park@wiseway.demo", role: "office",    name: "Olivia Park (Office)" },
  { email: "hannah.reed@wiseway.demo", role: "hr-admin",  name: "Hannah Reed (HR Admin)" },
];

let matched = 0, missing = 0;
for (const m of mapping) {
  const res = db.users.updateOne(
    { email: m.email },
    { $set: { role: m.role } }
  );
  if (res.matchedCount === 1) {
    matched++;
    print(`  ok   ${m.email.padEnd(26)} -> role=${m.role}`);
  } else {
    missing++;
    print(`  WAIT ${m.email.padEnd(26)} -> no user doc yet (sign in once, then re-run)`);
  }
}
print(`\nSummary: ${matched} updated, ${missing} awaiting first login.`);
JS

$COMPOSE exec -T "$MONGO_SERVICE" mongosh --quiet "$MONGO_DB" --eval "$SEED_JS"

echo "Done. Re-run after any demo user logs in for the first time."
