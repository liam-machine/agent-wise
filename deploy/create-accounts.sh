#!/usr/bin/env bash
# =============================================================================
# Create the two DEMO logins for the Wiseway Staff Assistant.
#
# The login box (deploy/wiseway-assets/wiseway-role-ui.js) lets a user pick
# "User" or "Admin" and type a short demo password (user / admin). Behind the
# scenes it signs in to one of these two LibreChat accounts. LibreChat enforces
# a >= 8 char password, so the stored passwords are longer; the box maps the
# short demo password to them.
#
#   User  -> user@wiseway.demo  / wisewayuser   role: warehouse  (minimal UI, hr+sop+safety docs)
#   Admin -> admin@wiseway.demo / wisewayadmin   role: ADMIN      (full UI, all docs, manages agents)
#
# *** DEMO ONLY. Not real auth. Replace with Wiseway SSO — docs/INTEGRATION.md §1. ***
#
# Run AFTER `docker compose up -d`:  ./deploy/create-accounts.sh
# =============================================================================
set -euo pipefail

LC=wiseway-librechat
DB=wiseway-mongodb

echo "Creating demo accounts…"
docker exec "$LC" npm run create-user -- user@wiseway.demo  "Wiseway Worker" user  wisewayuser  --email-verified=true  >/dev/null 2>&1 || true
docker exec "$LC" npm run create-user -- admin@wiseway.demo "Wiseway Admin"  admin wisewayadmin --email-verified=true  >/dev/null 2>&1 || true

echo "Setting roles (user->warehouse, admin->ADMIN)…"
docker exec "$DB" mongosh LibreChat --quiet --eval '
  db.users.updateOne({email:"user@wiseway.demo"},  {$set:{role:"warehouse"}});
  db.users.updateOne({email:"admin@wiseway.demo"}, {$set:{role:"ADMIN"}});
  // The business role "warehouse" must ALSO exist in the roles collection or the
  // user inherits no feature permissions (e.g. AGENTS.USE) and cannot open shared
  // agents — the LibreChat role nuance in CLAUDE.md. Clone the stock USER role.
  if (!db.roles.findOne({name:"warehouse"})) {
    const u = db.roles.findOne({name:"USER"});
    if (u) { delete u._id; u.name = "warehouse"; db.roles.insertOne(u); }
  }
  print("  done.");
'

cat <<'EOF'

Demo logins ready. Open http://localhost:3080 and use the password box:
    User  -> password: user    (warehouse: minimal UI, HR + SOP + Safety docs)
    Admin -> password: admin    (full UI, all docs, manages agents)

NOTE: agents you build in the Agent Builder are private to their creator. To let
the User account use the pinned assistant, share it: build agents while signed in
as Admin, then share each one publicly (Agent Builder -> Share -> anyone-can-view).
EOF
