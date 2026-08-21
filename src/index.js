#!/usr/bin/env node
import { createServer } from './server.js';

// ── CLI flags ─────────────────────────────────────────────────────────────────
// --data-dir <path>   Override ~/.context-mcp storage directory
// --help              Show usage

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
context-mcp — Persistent AI memory MCP server (stdio transport)

Usage:
  context-mcp [options]
  npx context-mcp-server@latest [options]

Options:
  --data-dir <path>   Override storage directory (default: ~/.context-mcp)
                      Also settable via env: CONTEXT_MCP_DIR=<path>
  --help, -h          Show this help

Platform setup (stdio):
  Claude Code:   claude mcp add context-mcp npx context-mcp-server@latest
  VS Code:       add to .vscode/mcp.json
  Antigravity:   add to .agents/mcp_config.json (or ~/.gemini/config/mcp_config.json)
  Codex CLI:     add to .codex/config.toml
  Hermes Agent:  add to ~/.hermes/config.yaml

Examples:
  context-mcp
  context-mcp --data-dir /my/project/.ctx
  CONTEXT_MCP_DIR=/tmp/ctx context-mcp
`);
  process.exit(0);
}

const dataDirIdx = args.indexOf('--data-dir');
if (dataDirIdx !== -1 && args[dataDirIdx + 1]) {
  process.env.CONTEXT_MCP_DIR = args[dataDirIdx + 1];
}

const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
const server = createServer();
const transport = new StdioServerTransport();
await server.connect(transport);
