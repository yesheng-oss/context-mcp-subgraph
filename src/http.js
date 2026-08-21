#!/usr/bin/env node
/**
 * context-mcp HTTP server — Streamable HTTP transport (OAuth 2.0)
 *
 * Enables web-based AI clients (ChatGPT, Claude.ai, etc.) to connect
 * to context-mcp over HTTP.
 *
 * Auth: OAuth 2.0 Client Credentials flow
 *   1. Client sends POST /oauth/token with client_id & client_secret
 *   2. Server returns an access_token
 *   3. Client uses Authorization: Bearer <token> on /mcp requests
 *
 * Setup:
 *   1. Run: ctx online
 *   2. Config auto-generated in ~/.context-mcp/contextconfig.json
 *   3. Add http://localhost:3100 as MCP connector in Claude.ai / ChatGPT
 */

import { createServer as createHTTPServer } from 'node:http';
import { randomUUID, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { getConfig, getConfigPath } from './config.js';
import { createServer } from './server.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ── CLI flags ─────────────────────────────────────────────────────────────────
// --port <number>     HTTP port (default: 3100)
// --host <string>     Bind host (default: localhost)
// --access-git        Enable git tools
// --data-dir <path>   Override ~/.context-mcp storage directory
// --help              Show usage

const _args = process.argv.slice(2);

if (_args.includes('--help') || _args.includes('-h')) {
  console.log(`
context-mcp-http — Persistent AI memory MCP server (HTTP/OAuth transport)

Usage:
  context-mcp-http [options]
  npx context-mcp-server@latest [options]

Options:
  --port <number>     HTTP listen port (default: 3100)
  --host <string>     Bind address (default: localhost)
  --access-git        Enable git tools for connected clients
  --data-dir <path>   Override storage directory (default: ~/.context-mcp)
                      Also settable via env: CONTEXT_MCP_DIR=<path>
  --help, -h          Show this help

Platform setup (HTTP — for Claude.ai, ChatGPT, web clients):
  1. Start the server:  ctx online
     (or directly:      context-mcp-http --port 3100)
  2. Add http://localhost:3100 as a remote MCP connector in your AI client.
     Use the CLIENT_ID and CLIENT_SECRET from ~/.context-mcp/contextconfig.json

Examples:
  context-mcp-http
  context-mcp-http --port 4000 --access-git
  context-mcp-http --host 0.0.0.0 --port 3100
  context-mcp-http --data-dir /my/project/.ctx
`);
  process.exit(0);
}

function _getFlag(flag, defaultVal) {
  const idx = _args.indexOf(flag);
  if (idx !== -1 && _args[idx + 1] && !_args[idx + 1].startsWith('--')) return _args[idx + 1];
  return defaultVal;
}

if (_args.includes('--access-git')) process.env.CONTEXT_MCP_ACCESS_GIT = 'true';
const _dataDirIdx = _args.indexOf('--data-dir');
if (_dataDirIdx !== -1 && _args[_dataDirIdx + 1]) process.env.CONTEXT_MCP_DIR = _args[_dataDirIdx + 1];

// ── Load Config ──────────────────────────────────────────────────────────────

const config = getConfig();

// ── Config ───────────────────────────────────────────────────────────────────

const PORT = Number(_getFlag('--port', null)) || config.port || 3100;
const HOST = _getFlag('--host', null) || config.host || 'localhost';
const CLIENT_ID = config.client_id || 'context-mcp';
const CLIENT_SECRET = config.client_secret || '';

// ── Validate credentials ────────────────────────────────────────────────────

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error(`
\x1b[31m✗ ERROR: CLIENT_ID and CLIENT_SECRET are required.\x1b[0m

  These are managed automatically via contextconfig.json
  Location: ${getConfigPath()}

  The server auto-generates credentials on first run.
  Check the config file for your CLIENT_ID and CLIENT_SECRET.
`);
  process.exit(1);
}

// ── OAuth 2.0 token store ────────────────────────────────────────────────────

const activeTokens = new Map(); // token -> { expiresAt }
const authCodes = new Map();    // code -> { code_challenge, redirect_uri, expiresAt }
const TOKEN_TTL = 3600 * 1000;  // 1 hour
const CODE_TTL = 5 * 60 * 1000; // 5 minutes

function issueToken() {
  return issueJWT({ sub: CLIENT_ID, scope: 'mcp' }, CLIENT_SECRET, TOKEN_TTL / 1000);
}

function isValidToken(token) {
  // Try JWT validation first (stateless)
  if (token.includes('.')) {
    return verifyJWT(token, CLIENT_SECRET) !== null;
  }
  // Fallback: opaque UUID in map
  const entry = activeTokens.get(token);
  if (!entry) return false;
  if (Date.now() > entry.expiresAt) { activeTokens.delete(token); return false; }
  return true;
}

// Clean expired tokens & codes every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [token, { expiresAt }] of activeTokens) {
    if (now > expiresAt) activeTokens.delete(token);
  }
  for (const [code, { expiresAt }] of authCodes) {
    if (now > expiresAt) authCodes.delete(code);
  }
}, 600_000);



// ── HMAC request signing ─────────────────────────────────────────────────────

const HMAC_WINDOW_MS = 30_000;

function makeHmacSignature(secret, timestampMs, body) {
  return createHmac('sha256', secret)
    .update(`${timestampMs}:${body}`)
    .digest('hex');
}

function verifyHmac(secret, req, body) {
  const ts  = req.headers['x-timestamp'];
  const sig = req.headers['x-signature'];
  if (!ts || !sig) return false;
  const now = Date.now();
  if (Math.abs(now - Number(ts)) > HMAC_WINDOW_MS) return false;
  const expected = makeHmacSignature(secret, ts, body);
  try {
    return timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
  } catch { return false; }
}

// ── JWT access token validation ──────────────────────────────────────────────

function decodeJWT(token) {
  try {
    const [, payload] = token.split('.');
    return JSON.parse(Buffer.from(payload, 'base64url').toString());
  } catch { return null; }
}

function verifyJWT(token, secret) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const sig = createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest('base64url');
  try {
    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(parts[2]))) return null;
  } catch { return null; }
  const payload = decodeJWT(token);
  if (!payload) return null;
  if (payload.exp && Date.now() / 1000 > payload.exp) return null;
  return payload;
}

function issueJWT(payload, secret, ttlSeconds = 3600) {
  const header  = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body    = Buffer.from(JSON.stringify({ ...payload, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + ttlSeconds })).toString('base64url');
  const sig     = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

// ── MCP session management ───────────────────────────────────────────────────

const sessions = new Map();

async function createMCPSession() {
  const id = randomUUID();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => id });
  const server = createServer({
    enableFileTools: true,
    enableGitTools:  process.env.CONTEXT_MCP_ACCESS_GIT === 'true' || config.access_git === true,
  });
  await server.connect(transport);
  sessions.set(id, { transport, server });
  transport.onclose = () => sessions.delete(id);
  return { transport, server };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const ALLOWED_ORIGINS = [
  'https://claude.ai',
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`,
  ...(config.allowed_origins || []),
];

function corsHeaders(reqOrigin) {
  const origin = ALLOWED_ORIGINS.includes(reqOrigin) ? reqOrigin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': origin,
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id, Accept',
    'Access-Control-Expose-Headers': 'Mcp-Session-Id',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  };
}

function sendJSON(res, statusCode, data, reqOrigin) {
  res.writeHead(statusCode, { ...corsHeaders(reqOrigin), 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// Simple in-memory rate limiter: ip -> { count, resetAt }
const _rateLimits = new Map();
function checkRate(ip, limit, windowMs) {
  const now = Date.now();
  let e = _rateLimits.get(ip) ?? { count: 0, resetAt: now + windowMs };
  if (now > e.resetAt) e = { count: 0, resetAt: now + windowMs };
  e.count++;
  _rateLimits.set(ip, e);
  return e.count <= limit;
}

const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB

async function readBody(req) {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    totalBytes += chunk.length;
    if (totalBytes > MAX_BODY_BYTES) {
      req.destroy();
      throw new Error('Request body too large (max 10 MB)');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString();
}

// ── Request handler ──────────────────────────────────────────────────────────

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  const reqOrigin = req.headers['origin'] || '';
  const clientIp  = req.socket?.remoteAddress || 'unknown';

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(reqOrigin));
    res.end();
    return;
  }

  // Health check (public)
  if (url.pathname === '/health' && req.method === 'GET') {
    sendJSON(res, 200, { status: 'ok', sessions: sessions.size }, reqOrigin);
    return;
  }

  // ── OAuth 2.0 Authorization endpoint ──
  if (url.pathname === '/authorize' && req.method === 'GET') {
    const response_type = url.searchParams.get('response_type');
    const client_id = url.searchParams.get('client_id');
    const redirect_uri = url.searchParams.get('redirect_uri');
    const state = url.searchParams.get('state');
    const code_challenge = url.searchParams.get('code_challenge');

    if (response_type !== 'code') {
      sendJSON(res, 400, { error: 'unsupported_response_type', error_description: 'Only response_type=code is supported' }, reqOrigin);
      return;
    }

    if (client_id !== CLIENT_ID) {
      sendJSON(res, 401, { error: 'invalid_client' }, reqOrigin);
      return;
    }

    if (!redirect_uri) {
      sendJSON(res, 400, { error: 'invalid_request', error_description: 'redirect_uri is required' }, reqOrigin);
      return;
    }

    // Validate redirect_uri against whitelist to prevent open redirect attacks
    const allowedRedirectUris = config.allowed_redirect_uris ?? ['https://claude.ai'];
    if (!allowedRedirectUris.some(u => redirect_uri.startsWith(u))) {
      sendJSON(res, 400, { error: 'invalid_request', error_description: 'redirect_uri not allowed' }, reqOrigin);
      return;
    }

    // Generate an authorization code
    const code = randomUUID();
    authCodes.set(code, {
      code_challenge,
      redirect_uri,
      expiresAt: Date.now() + CODE_TTL
    });

    // Auto-redirect back to the client (e.g. Claude.ai)
    const redirectUrl = new URL(redirect_uri);
    redirectUrl.searchParams.set('code', code);
    if (state) redirectUrl.searchParams.set('state', state);

    res.writeHead(302, { Location: redirectUrl.toString() });
    res.end();
    return;
  }

  // ── OAuth 2.0 token endpoint ──
  if ((url.pathname === '/oauth/token' || url.pathname === '/token') && req.method === 'POST') {
    // Rate limit: 10 requests per minute per IP
    if (!checkRate(clientIp, 10, 60_000)) {
      sendJSON(res, 429, { error: 'rate_limit_exceeded', error_description: 'Too many token requests' }, reqOrigin);
      return;
    }

    const bodyStr = await readBody(req);
    let params;

    const ct = req.headers['content-type'] || '';

    if (ct.includes('application/json')) {
      try { params = JSON.parse(bodyStr); } catch { params = {}; }
    } else {
      params = Object.fromEntries(new URLSearchParams(bodyStr));
    }

    // Also check Basic Auth in headers just in case Claude is using it
    let clientId = params.client_id;
    let clientSecret = params.client_secret;
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Basic ')) {
      const b64 = authHeader.slice(6);
      const [u, p] = Buffer.from(b64, 'base64').toString().split(':');
      clientId = clientId || u;
      clientSecret = clientSecret || p;
    }

    const { grant_type, code, code_verifier } = params;

    if (clientId !== CLIENT_ID || clientSecret !== CLIENT_SECRET) {
      sendJSON(res, 401, { error: 'invalid_client', error_description: 'Invalid client_id or client_secret' }, reqOrigin);
      return;
    }

    if (grant_type === 'authorization_code') {
      const codeEntry = authCodes.get(code);
      if (!codeEntry || Date.now() > codeEntry.expiresAt) {
        sendJSON(res, 400, { error: 'invalid_grant', error_description: 'Invalid or expired authorization code' }, reqOrigin);
        return;
      }

      if (codeEntry.code_challenge && code_verifier) {
        const hash = createHash('sha256').update(code_verifier).digest('base64')
          .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
        if (hash !== codeEntry.code_challenge) {
          sendJSON(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' }, reqOrigin);
          return;
        }
      }

      authCodes.delete(code);
    } else if (grant_type !== 'client_credentials') {
      sendJSON(res, 400, { error: 'unsupported_grant_type', error_description: 'Unsupported grant type' }, reqOrigin);
      return;
    }

    const token = issueToken();
    sendJSON(res, 200, {
      access_token: token,
      token_type: 'Bearer',
      expires_in: TOKEN_TTL / 1000,
    });
    return;
  }

  // ── OAuth discovery (well-known) ──
  if (url.pathname === '/.well-known/oauth-authorization-server' && req.method === 'GET') {
    const base = `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host || `${HOST}:${PORT}`}`;
    sendJSON(res, 200, {
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/oauth/token`,
      grant_types_supported: ['client_credentials', 'authorization_code'],
      response_types_supported: ['code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
    }, reqOrigin);
    return;
  }

  // User-friendly HTML guide for the root route (GET only)
  if (url.pathname === '/' && req.method === 'GET') {
    const html = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>context-mcp | Secure Transport</title>
        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
        <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600&family=JetBrains+Mono&display=swap" rel="stylesheet">
        <style>
          :root {
            --bg: #05070a;
            --card: rgba(15, 18, 25, 0.8);
            --brand: #00f2ff;
            --accent: #bc13fe;
            --text: #e2e8f0;
            --muted: #64748b;
            --success: #10b981;
            --glass: rgba(255, 255, 255, 0.03);
            --border: rgba(255, 255, 255, 0.1);
          }

          * { box-sizing: border-box; }
          body {
            font-family: 'Outfit', sans-serif;
            background: var(--bg);
            background-image: 
              radial-gradient(circle at 20% 30%, rgba(0, 242, 255, 0.05) 0%, transparent 40%),
              radial-gradient(circle at 80% 70%, rgba(188, 19, 254, 0.05) 0%, transparent 40%);
            color: var(--text);
            margin: 0;
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            line-height: 1.6;
            overflow-x: hidden;
          }

          .container {
            width: 100%;
            max-width: 680px;
            padding: 40px;
            position: relative;
          }

          .glass-card {
            background: var(--card);
            backdrop-filter: blur(12px);
            -webkit-backdrop-filter: blur(12px);
            border: 1px solid var(--border);
            border-radius: 24px;
            padding: 48px;
            box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
            position: relative;
            z-index: 1;
            overflow: hidden;
          }

          .glass-card::before {
            content: '';
            position: absolute;
            top: 0; left: 0; right: 0; height: 2px;
            background: linear-gradient(90deg, transparent, var(--brand), var(--accent), transparent);
            opacity: 0.5;
          }

          .logo-area {
            display: flex;
            align-items: center;
            gap: 16px;
            margin-bottom: 32px;
          }

          .status-pulse {
            width: 12px;
            height: 12px;
            background: var(--success);
            border-radius: 50%;
            position: relative;
            box-shadow: 0 0 15px var(--success);
          }

          .status-pulse::after {
            content: '';
            position: absolute;
            top: -4px; left: -4px; right: -4px; bottom: -4px;
            border: 2px solid var(--success);
            border-radius: 50%;
            animation: pulse 2s infinite;
          }

          @keyframes pulse {
            0% { transform: scale(1); opacity: 0.8; }
            100% { transform: scale(2); opacity: 0; }
          }

          h1 {
            font-size: 32px;
            font-weight: 600;
            margin: 0;
            background: linear-gradient(135deg, #fff 0%, #94a3b8 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            letter-spacing: -0.02em;
          }

          p { color: var(--muted); font-size: 17px; margin-bottom: 32px; }

          .setup-grid {
            display: grid;
            gap: 20px;
            margin-top: 40px;
          }

          .step {
            background: var(--glass);
            border: 1px solid var(--border);
            border-radius: 16px;
            padding: 20px;
            transition: all 0.3s ease;
          }

          .step:hover {
            border-color: rgba(0, 242, 255, 0.3);
            transform: translateY(-2px);
            background: rgba(255, 255, 255, 0.05);
          }

          .step-num {
            display: inline-block;
            width: 24px;
            height: 24px;
            background: var(--brand);
            color: var(--bg);
            border-radius: 6px;
            text-align: center;
            font-size: 14px;
            font-weight: 600;
            line-height: 24px;
            margin-bottom: 12px;
          }

          .step-title {
            font-weight: 600;
            color: var(--text);
            margin-bottom: 8px;
            display: block;
          }

          .step-content {
            font-size: 14px;
            color: var(--muted);
          }

          code {
            font-family: 'JetBrains Mono', monospace;
            background: rgba(0, 0, 0, 0.3);
            color: var(--brand);
            padding: 4px 8px;
            border-radius: 6px;
            font-size: 13px;
            border: 1px solid rgba(0, 242, 255, 0.1);
          }

          .badge {
            display: inline-flex;
            align-items: center;
            background: rgba(16, 185, 129, 0.1);
            color: var(--success);
            padding: 4px 12px;
            border-radius: 20px;
            font-size: 12px;
            font-weight: 600;
            margin-left: auto;
          }

          footer {
            margin-top: 32px;
            text-align: center;
            font-size: 13px;
            color: var(--muted);
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="glass-card">
            <div class="logo-area">
              <div class="status-pulse"></div>
              <h1>context-mcp</h1>
              <div class="badge">HTTP LOCAL</div>
            </div>
            
            <p>Your AI memory server is running and ready for connections from Claude.ai or ChatGPT.</p>

            <div class="setup-grid">
              <div class="step">
                <span class="step-num">1</span>
                <span class="step-title">Add MCP Connector</span>
                <span class="step-content">Go to your AI client → Settings → Integrations → <b>Add MCP Connector</b>.</span>
              </div>

              <div class="step">
                <span class="step-num">2</span>
                <span class="step-title">Server URL</span>
                <span class="step-content">Enter: <code>${req.headers['x-forwarded-proto'] === 'https' || req.socket?.encrypted ? 'https' : 'http'}://${req.headers.host}</code></span>
              </div>

              <div class="step">
                <span class="step-num">3</span>
                <span class="step-title">Credentials</span>
                <span class="step-content">
                  Client ID &amp; Secret: see <code>~/.context-mcp/contextconfig.json</code>
                </span>
              </div>
            </div>
          </div>
          <footer>
            &copy; ${new Date().getFullYear()} context-mcp • Premium AI Memory
          </footer>
        </div>
      </body>
      </html>
    `;
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }

  // Allow both /mcp and / to handle MCP requests (but not GET / — that serves the HTML guide)
  if (url.pathname !== '/mcp' && !(url.pathname === '/' && req.method !== 'GET')) {
    sendJSON(res, 404, { error: `Not found: ${url.pathname}` }, reqOrigin);
    return;
  }

  // ── Auth: validate Bearer token ──
  const auth = req.headers['authorization'];
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token || !isValidToken(token)) {
    sendJSON(res, 401, { error: 'invalid_token', error_description: 'Missing or expired token. POST /oauth/token first.' }, reqOrigin);
    return;
  }

  const sessionId = req.headers['mcp-session-id'] || null;

  try {
    if (req.method === 'POST') {
      const bodyStr = await readBody(req);
      let body;
      try { body = JSON.parse(bodyStr); } catch { body = null; }

      if (body && isInitializeRequest(body)) {
        const { transport } = await createMCPSession();
        await transport.handleRequest(req, res, body);
        return;
      }

      if (!sessionId || !sessions.has(sessionId)) {
        sendJSON(res, 400, { error: 'Missing or invalid Mcp-Session-Id.' }, reqOrigin);
        return;
      }
      const { transport } = sessions.get(sessionId);
      await transport.handleRequest(req, res, body);

    } else if (req.method === 'GET') {
      if (!sessionId || !sessions.has(sessionId)) {
        sendJSON(res, 400, { error: 'Missing or invalid Mcp-Session-Id' }, reqOrigin);
        return;
      }
      const { transport } = sessions.get(sessionId);
      await transport.handleRequest(req, res);

    } else if (req.method === 'DELETE') {
      if (sessionId && sessions.has(sessionId)) {
        const { transport } = sessions.get(sessionId);
        await transport.close();
        sessions.delete(sessionId);
      }
      sendJSON(res, 200, { closed: true }, reqOrigin);

    } else {
      sendJSON(res, 405, { error: 'Method not allowed' }, reqOrigin);
    }
  } catch (err) {
    console.error('MCP HTTP error:', err.message);
    if (!res.headersSent) {
      sendJSON(res, 500, { error: err.message }, reqOrigin);
    }
  }
}

// ── Start server ─────────────────────────────────────────────────────────────

async function start() {
  const server = createHTTPServer(handleRequest);

  server.listen(PORT, async () => {
    const LOGO = `
\x1b[96m ██████╗ ██████╗ ███╗   ██╗████████╗███████╗██╗  ██╗████████╗
██╔════╝██╔═══██╗████╗  ██║╚══██╔══╝██╔════╝╚██╗██╔╝╚══██╔══╝
██║     ██║   ██║██╔██╗ ██║   ██║   █████╗   ╚███╔╝    ██║
██║     ██║   ██║██║╚██╗██║   ██║   ██╔══╝   ██╔██╗    ██║
╚██████╗╚██████╔╝██║ ╚████║   ██║   ███████╗██╔╝ ██╗   ██║
 ╚═════╝ ╚═════╝ ╚═╝  ╚═══╝   ╚═╝   ╚══════╝╚═╝  ╚═╝   ╚═╝\x1b[0m`;

    console.log(LOGO);
    console.log(`
\x1b[90m┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓\x1b[0m
\x1b[90m┃\x1b[0m  \x1b[1m\x1b[95mcontext-mcp Web AI Server\x1b[0m                       \x1b[90m┃\x1b[0m
\x1b[90m┃\x1b[0m                                                  \x1b[90m┃\x1b[0m
\x1b[90m┃\x1b[0m  \x1b[2mEndpoint:\x1b[0m  \x1b[96m${'http://' + HOST + ':' + PORT}\x1b[0m                    \x1b[90m┃\x1b[0m
\x1b[90m┃\x1b[0m  \x1b[2mConfig:\x1b[0m    \x1b[2m${getConfigPath().padEnd(36)}\x1b[0m\x1b[90m┃\x1b[0m
\x1b[90m┃\x1b[0m  \x1b[2mMCP path:\x1b[0m  \x1b[94mPOST /mcp\x1b[0m                            \x1b[90m┃\x1b[0m
\x1b[90m┃\x1b[0m  \x1b[2mOAuth:\x1b[0m     \x1b[94mPOST /oauth/token\x1b[0m                    \x1b[90m┃\x1b[0m
\x1b[90m┃\x1b[0m  \x1b[2mHealth:\x1b[0m    \x1b[94mGET  /health\x1b[0m                          \x1b[90m┃\x1b[0m
\x1b[90m┃\x1b[0m                                                  \x1b[90m┃\x1b[0m
\x1b[90m┃\x1b[0m  \x1b[2mAuth:\x1b[0m      🔒 Client Credentials + OAuth 2.0        \x1b[90m┃\x1b[0m
\x1b[90m┃\x1b[0m                                                  \x1b[90m┃\x1b[0m
\x1b[90m┃\x1b[0m  \x1b[2mClient ID:\x1b[0m \x1b[92m${CLIENT_ID.padEnd(34)}\x1b[0m\x1b[90m┃\x1b[0m
\x1b[90m┃\x1b[0m  \x1b[2mSecret:\x1b[0m    \x1b[2m${CLIENT_SECRET.slice(0, 8)}... (see config)\x1b[0m\x1b[90m┃\x1b[0m
\x1b[90m┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛\x1b[0m
`);

  });

  // Graceful shutdown
  const shutdown = async (signal) => {
    console.log(`\n[http] Received ${signal}, shutting down...`);

    server.close(() => {
      console.log('[http] Server closed');
      process.exit(0);
    });

    // Force shutdown after 10s
    setTimeout(() => {
      console.error('[http] Forced shutdown');
      process.exit(1);
    }, 10000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start();
