#!/usr/bin/env bash
# =============================================================================
# Seed the SOP agents for the Wiseway Staff Assistant.
#
# LibreChat agents can't be declared in librechat.yaml — but they CAN be created
# via LibreChat's REST API, so this script ships the agents the same way
# create-accounts.sh ships the demo logins: one command, after the stack is up.
#
# It seeds TWO agents — identical gated MCP tools + citing prompt, different model:
#   - "SOP Claude" — Anthropic / claude-sonnet-4-6  (the DEFAULT for everyone)
#   - "SOP"        — Ollama   / qwen2.5:7b          (local, no-cloud fallback)
#
# For EACH agent it does the THREE things that make an agent usable by a
# non-author (the UI hides these behind one "Share" button):
#   1. Creates the agent       (POST /api/agents)          — wired to the
#      wiseway-docs MCP search+fetch tools, with the citing prompt.
#   2. Shares it publicly       (PUT /api/permissions/...) — public "agent_viewer"
#      ACL so the warehouse User (not just the Admin author) can open it.
#   3. (once) Ensures the `warehouse` role exists in the Mongo `roles` collection
#      with AGENTS.USE — without it the ACL grant is overridden and the User is
#      Forbidden (the LibreChat role nuance flagged in CLAUDE.md).
# Then it patches each agent's id into the matching modelSpecs entry in
# deploy/librechat.yaml and restarts LibreChat, so "SOP Claude" is the pinned
# default for everyone with "SOP" (local) as a selectable fallback.
#
# NOTE: "SOP Claude" only RUNS once ANTHROPIC_API_KEY is set in deploy/.env and
# LibreChat has been recreated to pick it up. The script warns if it's missing
# but still seeds the agent (so the model is ready the moment the key lands).
#
# Idempotent: re-running reuses the existing agents by name (no duplicates).
#
# Prereqs (host): curl + node (node is already used in README/.env for secrets).
# Run AFTER `docker compose up -d` and `./deploy/create-accounts.sh`:
#     ./deploy/create-agent.sh
#
# *** DEMO scaffolding. Re-point at Wiseway SSO + a hosted model for production
#     (docs/INTEGRATION.md). ***
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
YAML="$SCRIPT_DIR/librechat.yaml"

LC=wiseway-librechat
DB=wiseway-mongodb
BASE="http://localhost:3080"
# uaParser middleware rejects non-browser User-Agents ("Illegal request"), so
# every API call must look like a browser.
UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"

ADMIN_EMAIL="admin@wiseway.demo"
ADMIN_PASS="wisewayadmin"
AGENT_DESC="Cited answers on HR policy, SOPs and safety — scoped to your role."

# The citing system prompt — load-bearing: the local model will not auto-cite.
AGENT_INSTRUCTIONS="You are the Wiseway HR & SOP Assistant. Answer staff questions about HR policy, standard operating procedures, and workplace safety using ONLY the wiseway-docs search and fetch tools. ALWAYS call the search tool first before answering. Cite every fact as a Markdown link [Title](source_url) using the title and source_url returned by each search hit. If search returns nothing relevant, say plainly that you do not know and that the answer is not in the documents you can access. Never invent policy. You only ever see documents this staff member's role is permitted to read."

# MCP tools, named with LibreChat's "_mcp_" delimiter: tool + server.
TOOLS_JSON='["search_mcp_wiseway-docs","fetch_mcp_wiseway-docs"]'

say() { printf '%s\n' "$*"; }

# --- 0. preconditions -------------------------------------------------------
docker inspect -f '{{.State.Running}}' "$LC" >/dev/null 2>&1 || {
  say "✗ $LC is not running. Run 'docker compose up -d' first."; exit 1; }
if ! docker exec "$DB" mongosh LibreChat --quiet --eval \
     'quit(db.users.findOne({email:"'"$ADMIN_EMAIL"'"})?0:1)' >/dev/null 2>&1; then
  say "✗ admin account missing. Run './deploy/create-accounts.sh' first."; exit 1
fi

# Warn (don't fail) if the Anthropic key is missing — "SOP Claude" needs it to RUN.
if [ -z "$(docker exec "$LC" printenv ANTHROPIC_API_KEY 2>/dev/null)" ]; then
  say "⚠ ANTHROPIC_API_KEY is not set in the librechat container — \"SOP Claude\""
  say "  will be seeded but won't run until you add it to deploy/.env and run"
  say "  'docker compose up -d --force-recreate librechat'."
fi

# --- 1. ensure the warehouse role exists with USE perms (clone USER) --------
say "Ensuring 'warehouse' role exists (clone of USER, grants AGENTS.USE)…"
docker exec "$DB" mongosh LibreChat --quiet --eval '
  if (!db.roles.findOne({name:"warehouse"})) {
    const u = db.roles.findOne({name:"USER"});
    if (u) { delete u._id; u.name = "warehouse";
      db.roles.insertOne(u); print("  created."); }
    else print("  WARN: no USER role to clone.");
  } else print("  already present.");
' >/dev/null

# --- 2. log in as admin -----------------------------------------------------
say "Logging in as admin…"
TOKEN=$(curl -fsS -A "$UA" -X POST "$BASE/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASS\"}" \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.parse(s).token||''))")
[ -n "$TOKEN" ] || { say "✗ admin login failed."; exit 1; }

# --- 3. seed each SOP agent: create-or-reuse, share publicly, pin in yaml ----
# seed_agent <mongo-name> <provider> <model> <yaml-spec-name>
#   provider MUST be the normalized (lowercase) endpoint name. LibreChat keys its
#   model map by normalizeEndpointName(...) but validates an agent run with
#   modelsConfig[agent.provider] WITHOUT normalizing — so "Ollama" here yields
#   "Models for Ollama could not be loaded". Use "ollama" / "anthropic".
seed_agent() {
  local NAME="$1" PROVIDER="$2" MODEL="$3" SPEC="$4" AID OBJID PAYLOAD

  AID=$(docker exec "$DB" mongosh LibreChat --quiet --eval '
    const a = db.agents.find({name:"'"$NAME"'"}).sort({updatedAt:-1}).limit(1).toArray()[0];
    print(a ? a.id : "");' 2>/dev/null | tr -d '[:space:]')

  if [ -n "$AID" ]; then
    say "Reusing existing '$NAME' agent: $AID"
  else
    say "Creating '$NAME' agent ($PROVIDER / $MODEL)…"
    PAYLOAD=$(AGENT_NAME="$NAME" AGENT_DESC="$AGENT_DESC" \
      AGENT_INSTRUCTIONS="$AGENT_INSTRUCTIONS" TOOLS_JSON="$TOOLS_JSON" \
      PROVIDER="$PROVIDER" MODEL="$MODEL" node -e '
      process.stdout.write(JSON.stringify({
        name: process.env.AGENT_NAME,
        description: process.env.AGENT_DESC,
        instructions: process.env.AGENT_INSTRUCTIONS,
        provider: process.env.PROVIDER,
        model: process.env.MODEL,
        tools: JSON.parse(process.env.TOOLS_JSON),
      }))')
    AID=$(curl -fsS -A "$UA" -X POST "$BASE/api/agents" \
      -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
      -d "$PAYLOAD" \
      | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);if(!j.id){console.error(s);process.exit(1)}process.stdout.write(j.id)})")
    say "  created: $AID"
  fi

  # Share publicly (needs the Mongo _id, not the agent_ id) so non-authors can open it.
  OBJID=$(docker exec "$DB" mongosh LibreChat --quiet --eval '
    const a = db.agents.findOne({id:"'"$AID"'"},{_id:1}); print(a?a._id.toString():"");' \
    2>/dev/null | tr -d '[:space:]')
  [ -n "$OBJID" ] || { say "✗ could not resolve _id for '$NAME'."; exit 1; }
  curl -fsS -A "$UA" -X PUT "$BASE/api/permissions/agent/$OBJID" \
    -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
    -d '{"public":true,"publicAccessRoleId":"agent_viewer"}' >/dev/null
  say "  shared publicly (agent_viewer)."

  # Pin into the matching modelSpecs entry — anchor on the spec `name:` so each
  # agent_id lands in its own block (there are two now).
  node -e '
    const fs=require("fs"), f=process.argv[1], spec=process.argv[2], id=process.argv[3];
    let y=fs.readFileSync(f,"utf8");
    const re=new RegExp("(name:\\s*\""+spec+"\"[\\s\\S]*?agent_id:\\s*\")[^\"]*(\")");
    if(!re.test(y)){console.error("  WARN: no agent_id for spec \""+spec+"\" in "+f);process.exit(0)}
    fs.writeFileSync(f, y.replace(re, `$1${id}$2`));
    console.log("  "+spec+" agent_id -> "+id);
  ' "$YAML" "$SPEC" "$AID"
}

seed_agent "SOP Claude" "anthropic" "claude-sonnet-4-6" "sop-claude"
seed_agent "SOP"        "ollama"    "qwen2.5:7b"        "sop"

# --- 4. restart LibreChat once to load the pinned agents --------------------
say "Restarting LibreChat to load the pinned agents…"
( cd "$REPO_ROOT" && docker compose up -d --force-recreate librechat >/dev/null )

cat <<EOF

✓ Done. Two SOP agents are created, shared, and pinned:
  - "SOP Claude" (Anthropic claude-sonnet-4-6) — the DEFAULT everyone lands on.
  - "SOP" (local Ollama qwen2.5:7b)            — selectable fallback.
  Admin and User both reach them (User via the public agent_viewer ACL).
  enforce:false lets staff also pick the local SOP / any other shared agent;
  set enforce:true to lock them to the default for production.

  If "SOP Claude" errors on send, confirm ANTHROPIC_API_KEY is in deploy/.env and
  re-run 'docker compose up -d --force-recreate librechat'.

Open http://localhost:3080 — sign in as User (password 'user') to confirm SOP Claude loads.
EOF
