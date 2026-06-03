#!/usr/bin/env bash
# =============================================================================
# Set up the SOP-agent evaluation harness against the RUNNING LibreChat stack.
#
# Does three things, idempotently:
#   1. Mints (or reuses) a LibreChat "agent API key" for the remote-agents
#      OpenAI-compatible endpoint  (POST /api/api-keys).
#   2. For each candidate Ollama model, creates (or reuses) an agent that is a
#      clone of the pinned "SOP" agent — SAME instructions + SAME wiseway-docs
#      MCP tools, only the `model` differs — and shares it publicly. This is how
#      we compare models through the IDENTICAL retrieval+citation pipeline.
#   3. Writes eval/.env (key + base URL) and eval/agents.json (model -> agent_id).
#
# The candidate models default to everything `ollama list` reports; override by
# passing them as args:   ./eval/scripts/setup-eval.sh qwen2.5:7b llama3.1:8b
#
# Run AFTER the stack is up (docker compose up -d) and the SOP agent exists
# (./deploy/create-agent.sh). Prereqs: curl + node + docker.
#
# Why admin: we run the QUALITY eval as the admin user, whose role sees all four
# doc categories, so retrieval is never starved — that isolates MODEL quality.
# The role gate is exercised by a separate targeted check, not this run.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EVAL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BASE="http://localhost:3080"
UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
LC=wiseway-librechat
DB=wiseway-mongodb
ADMIN_EMAIL="admin@wiseway.demo"
ADMIN_PASS="wisewayadmin"

say() { printf '%s\n' "$*"; }
jget() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{process.stdout.write(String(JSON.parse(s)$1??''))}catch(e){process.exit(1)}})"; }

docker inspect -f '{{.State.Running}}' "$LC" >/dev/null 2>&1 || { say "✗ $LC not running. 'docker compose up -d' first."; exit 1; }

# --- candidate models -------------------------------------------------------
if [ "$#" -gt 0 ]; then
  MODELS=("$@")
else
  # everything Ollama has, minus embedding/vision models (not tool-calling chat models)
  mapfile -t MODELS < <(curl -fsS http://localhost:11434/api/tags | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{JSON.parse(s).models.map(m=>m.name).filter(n=>!/embed|moondream|llava|bakllava|vision|clip/i.test(n)).forEach(n=>console.log(n))})")
fi
[ "${#MODELS[@]}" -gt 0 ] || { say "✗ no candidate models found. Pull one: 'ollama pull qwen2.5:7b'"; exit 1; }
say "Candidate models: ${MODELS[*]}"

# --- 1. admin login ---------------------------------------------------------
say "Logging in as admin…"
TOKEN=$(curl -fsS -A "$UA" -X POST "$BASE/api/auth/login" -H "Content-Type: application/json" \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASS\"}" | jget ".token")
[ -n "$TOKEN" ] || { say "✗ admin login failed."; exit 1; }

# --- 2. mint (or reuse) an agent API key ------------------------------------
# Keys can't be listed in plaintext after creation, so we always mint a fresh
# one named with a timestamp and rely on eval/.env holding the latest.
say "Minting agent API key…"
KEYRESP=$(curl -fsS -A "$UA" -X POST "$BASE/api/api-keys" -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" -d '{"name":"wiseway-eval"}')
EVAL_KEY=$(printf '%s' "$KEYRESP" | jget ".key")
[ -n "$EVAL_KEY" ] || { say "✗ key mint failed: $KEYRESP"; exit 1; }
say "  key minted (prefix $(printf '%s' "$KEYRESP" | jget ".keyPrefix"))."

# --- 3. pull SOP agent's instructions + tools (stay in sync) ----------------
SOP_JSON=$(docker exec "$DB" mongosh LibreChat --quiet --eval '
  const a = db.agents.find({name:"SOP"}).sort({updatedAt:-1}).limit(1).toArray()[0];
  if(!a){print("{}");quit(1)}
  print(JSON.stringify({instructions:a.instructions, tools:a.tools||[]}));')
INSTR=$(printf '%s' "$SOP_JSON" | jget ".instructions")
TOOLS=$(printf '%s' "$SOP_JSON" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.stringify(JSON.parse(s).tools)))")
[ -n "$INSTR" ] || { say "✗ could not read SOP agent (run ./deploy/create-agent.sh first)."; exit 1; }

# --- 4. create/reuse an agent per candidate model ---------------------------
AGENTS_JSON="["
first=1
for M in "${MODELS[@]}"; do
  NAME="EVAL-SOP — $M"
  AID=$(docker exec "$DB" mongosh LibreChat --quiet --eval '
    const a=db.agents.find({name:"'"$NAME"'"}).sort({updatedAt:-1}).limit(1).toArray()[0];
    print(a?a.id:"");' 2>/dev/null | tr -d '[:space:]')
  if [ -n "$AID" ]; then
    say "  reuse  $M -> $AID"
  else
    PAYLOAD=$(NAME="$NAME" INSTR="$INSTR" TOOLS="$TOOLS" MODEL="$M" node -e '
      process.stdout.write(JSON.stringify({
        name: process.env.NAME,
        description: "Eval clone of SOP agent on "+process.env.MODEL,
        instructions: process.env.INSTR,
        provider: "ollama",
        model: process.env.MODEL,
        tools: JSON.parse(process.env.TOOLS),
      }))')
    AID=$(curl -fsS -A "$UA" -X POST "$BASE/api/agents" -H "Content-Type: application/json" \
      -H "Authorization: Bearer $TOKEN" -d "$PAYLOAD" | jget ".id")
    [ -n "$AID" ] || { say "  ✗ create failed for $M"; continue; }
    OBJID=$(docker exec "$DB" mongosh LibreChat --quiet --eval '
      const a=db.agents.findOne({id:"'"$AID"'"},{_id:1}); print(a?a._id.toString():"");' 2>/dev/null | tr -d '[:space:]')
    curl -fsS -A "$UA" -X PUT "$BASE/api/permissions/agent/$OBJID" -H "Content-Type: application/json" \
      -H "Authorization: Bearer $TOKEN" -d '{"public":true,"publicAccessRoleId":"agent_viewer"}' >/dev/null
    say "  create $M -> $AID"
  fi
  [ "$first" -eq 1 ] || AGENTS_JSON+=","
  first=0
  AGENTS_JSON+=$(M="$M" AID="$AID" node -e 'process.stdout.write(JSON.stringify({model:process.env.M,agent_id:process.env.AID,label:process.env.M}))')
done
AGENTS_JSON+="]"

# --- 5. write eval/.env + eval/agents.json ----------------------------------
cat > "$EVAL_DIR/.env" <<EOF
# Generated by setup-eval.sh — gitignored. Holds the live agent API key.
WISEWAY_EVAL_BASE_URL=$BASE/api/agents/v1
WISEWAY_EVAL_KEY=$EVAL_KEY
# Judge model: a STRONG model that is NOT a candidate (self-preference bias).
# promptfoo provider string. Anthropic (recommended) needs ANTHROPIC_API_KEY.
# Examples:  anthropic:messages:claude-opus-4-8   |   ollama:chat:<a-big-local-model>
EVAL_JUDGE=anthropic:messages:claude-sonnet-4-6
EOF
printf '%s' "$AGENTS_JSON" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{console.log(JSON.stringify(JSON.parse(s),null,2))})" > "$EVAL_DIR/agents.json"

say ""
say "✓ Setup complete."
say "  eval/.env        — base URL + live API key + judge model (edit EVAL_JUDGE to swap judge)"
say "  eval/agents.json — $(printf '%s' "$AGENTS_JSON" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(String(JSON.parse(s).length)))") candidate agent(s)"
say ""
say "Next:  node eval/scripts/build-tests.mjs   &&   (cd eval/promptfoo && promptfoo eval)"
