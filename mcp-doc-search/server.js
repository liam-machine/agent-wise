// Wiseway role-scoped MCP document-search server.
//
// THIS IS THE SECURITY BOUNDARY FOR DOCUMENT ACCESS.
//
// Trust model (see README.md for the full write-up):
//   * Identity is NOT a tool argument and is NEVER supplied by the model.
//   * LibreChat injects three HTTP headers on every MCP call:
//       X-User-Role  — the caller's Wiseway business role (warehouse/driver/office/hr-admin)
//       X-User-Id    — the caller's user id (for the audit log)
//       X-Mcp-Key    — a shared secret proving the request came from LibreChat
//   * We reject (401) any request whose X-Mcp-Key !== WISEWAY_MCP_SHARED_SECRET,
//     so only LibreChat (which holds the secret) can reach the tools at all.
//   * The role from the header drives roles.yaml; results are filtered
//     SERVER-SIDE so the model never sees a document outside the caller's role.
//
// Per-request isolation:
//   We run the Streamable HTTP transport in STATELESS mode (sessionIdGenerator
//   undefined) and build a fresh McpServer per POST. The role/user-id for the
//   request are captured in the tool-handler closures, so role is per-request
//   and can never leak across concurrent callers via a module global.

import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

import * as backend from './backend.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 8000);
const MCP_PATH = '/mcp';
const SHARED_SECRET = process.env.WISEWAY_MCP_SHARED_SECRET || '';

// ---------------------------------------------------------------------------
// Load the role -> allowed-categories map (the security gate).
// ---------------------------------------------------------------------------
function loadRoles() {
  const file = path.join(__dirname, 'roles.yaml');
  const parsed = yaml.load(fs.readFileSync(file, 'utf8')) || {};
  const roles = parsed.roles || {};
  // Normalize to lowercase string keys -> Set of category strings.
  const map = new Map();
  for (const [role, cats] of Object.entries(roles)) {
    map.set(
      String(role).toLowerCase().trim(),
      new Set((cats || []).map((c) => String(c).toLowerCase().trim())),
    );
  }
  return map;
}

const ROLE_MAP = loadRoles();

/**
 * Allowed categories for a role. Fails CLOSED: an unknown/empty role gets an
 * empty set, so it can read nothing.
 */
function allowedCategoriesFor(role) {
  const key = String(role || '').toLowerCase().trim();
  return ROLE_MAP.get(key) || new Set();
}

/**
 * Structured JSON audit line. Timestamp comes from the standard runtime clock —
 * this server runs on the user's own machine, so Date.now()/toISOString() is fine.
 */
function audit(entry) {
  process.stdout.write(
    JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n',
  );
}

// ---------------------------------------------------------------------------
// Build a per-request MCP server. `role` and `userId` are captured here so they
// are scoped to exactly this request — never a module-global.
// ---------------------------------------------------------------------------
function buildServer({ role, userId }) {
  const allowed = allowedCategoriesFor(role);

  const server = new McpServer(
    { name: 'wiseway-doc-search', version: '1.0.0' },
    {
      instructions:
        'Search and fetch internal Wiseway HR, SOP, safety and payroll ' +
        'documents. Results are already scoped to the current user\'s role. ' +
        'Always cite each fact as a markdown link [Title](source_url). If a ' +
        'search returns nothing, say you do not know rather than guessing.',
    },
  );

  // -- search ----------------------------------------------------------------
  // ROLE IS NOT IN THE INPUT SCHEMA. It comes from the trusted header only.
  server.registerTool(
    'search',
    {
      title: 'Search Wiseway documents',
      description:
        'Search internal Wiseway HR / SOP / safety / payroll documents. ' +
        'Returns ranked hits as text blocks formatted "[i] Title — source_url\\nsnippet". ' +
        'Cite each fact you use as [Title](source_url).',
      inputSchema: {
        query: z.string().describe('Natural-language search query.'),
        top: z
          .number()
          .int()
          .min(1)
          .max(25)
          .optional()
          .describe('Max number of results to return (default 8).'),
      },
    },
    async ({ query, top }) => {
      const limit = top && top > 0 ? top : 8;

      // 1. Ask the backend (no role awareness there).
      let rawHits = [];
      try {
        rawHits = await backend.search(query, limit);
      } catch (err) {
        audit({
          tool: 'search',
          role,
          user_id: userId,
          query,
          error: String(err && err.message ? err.message : err),
          returned_doc_ids: [],
        });
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Document search backend error: ${
                err && err.message ? err.message : String(err)
              }`,
            },
          ],
        };
      }

      // 2. SECURITY GATE: drop any hit whose category is not allowed for the
      //    caller's role. The model never sees disallowed docs.
      const visible = rawHits.filter((h) =>
        allowed.has(String(h.category || '').toLowerCase().trim()),
      );

      // 3. Audit every call (including what was actually returned).
      audit({
        tool: 'search',
        role,
        user_id: userId,
        query,
        backend: backend.default?.BACKEND_NAME,
        candidates: rawHits.length,
        returned_doc_ids: visible.map((h) => h.doc_id),
      });

      if (visible.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text:
                'No documents found that you are permitted to read. ' +
                'Tell the user you do not have anything on this.',
            },
          ],
        };
      }

      // 4. Format hits as text blocks the local model will cite as markdown
      //    links: "[i] Title — source_url\nsnippet".
      const content = visible.map((h, i) => ({
        type: 'text',
        text: `[${i + 1}] ${h.title} — ${h.source_url}\n${h.snippet}`,
      }));

      return { content };
    },
  );

  // -- fetch -----------------------------------------------------------------
  server.registerTool(
    'fetch',
    {
      title: 'Fetch a Wiseway document',
      description:
        'Fetch the full body of a single Wiseway document by its doc_id ' +
        '(returned by search). Cite it as [Title](source_url).',
      inputSchema: {
        doc_id: z.string().describe('The doc_id of the document to fetch.'),
      },
    },
    async ({ doc_id }) => {
      let doc = null;
      try {
        doc = await backend.fetch(doc_id);
      } catch (err) {
        audit({
          tool: 'fetch',
          role,
          user_id: userId,
          doc_id,
          error: String(err && err.message ? err.message : err),
          returned_doc_ids: [],
        });
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Document fetch backend error: ${
                err && err.message ? err.message : String(err)
              }`,
            },
          ],
        };
      }

      // SECURITY GATE: if the doc does not exist OR its category is not allowed
      // for this role, behave identically (do not leak existence of restricted
      // docs). The model never sees a disallowed doc body.
      const ok =
        doc &&
        allowed.has(String(doc.category || '').toLowerCase().trim());

      audit({
        tool: 'fetch',
        role,
        user_id: userId,
        doc_id,
        backend: backend.default?.BACKEND_NAME,
        allowed: Boolean(ok),
        returned_doc_ids: ok ? [doc.doc_id] : [],
      });

      if (!ok) {
        return {
          content: [
            {
              type: 'text',
              text:
                `No document available for id "${doc_id}" that you are ` +
                'permitted to read.',
            },
          ],
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: `[${doc.title}] — ${doc.source_url}\n\n${doc.body}`,
          },
        ],
      };
    },
  );

  return server;
}

// ---------------------------------------------------------------------------
// HTTP layer.
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: '2mb' }));

// Liveness probe (no secret required) — handy for Docker healthchecks.
app.get('/health', (_req, res) => {
  res.json({ ok: true, backend: backend.default?.BACKEND_NAME || 'local' });
});

// Stateless Streamable HTTP MCP endpoint.
app.post(MCP_PATH, async (req, res) => {
  // --- 1. Authenticate the CALLER (must be LibreChat holding the secret). ---
  const presentedKey = req.header('X-Mcp-Key') || '';
  if (!SHARED_SECRET || presentedKey !== SHARED_SECRET) {
    audit({
      event: 'reject',
      reason: 'bad_or_missing_mcp_key',
      user_id: req.header('X-User-Id') || null,
    });
    res.status(401).json({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Unauthorized: invalid X-Mcp-Key' },
      id: null,
    });
    return;
  }

  // --- 2. Resolve identity from trusted headers (NEVER from the model). -----
  const role = req.header('X-User-Role') || '';
  const userId = req.header('X-User-Id') || '';

  // --- 3. Build a per-request server + transport (stateless mode). ----------
  const server = buildServer({ role, userId });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
  });

  res.on('close', () => {
    transport.close();
    server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    audit({
      event: 'error',
      role,
      user_id: userId,
      error: String(err && err.message ? err.message : err),
    });
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
});

// Reject non-POST verbs on /mcp cleanly (no SSE / GET session support in
// stateless mode).
app.all(MCP_PATH, (_req, res) => {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed.' },
    id: null,
  });
});

app.listen(PORT, () => {
  audit({
    event: 'startup',
    msg: 'wiseway-doc-search listening',
    port: PORT,
    path: MCP_PATH,
    backend: backend.default?.BACKEND_NAME || 'local',
    secret_configured: Boolean(SHARED_SECRET),
  });
  if (!SHARED_SECRET) {
    audit({
      event: 'startup',
      level: 'warn',
      msg: 'WISEWAY_MCP_SHARED_SECRET is not set — ALL requests will be rejected (fail closed).',
    });
  }
});
