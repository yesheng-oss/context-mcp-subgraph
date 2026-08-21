<p align="center">
  <img src="src/assests/main.png" alt="context-mcp" />
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/context-mcp-server"><img src="https://img.shields.io/npm/v/context-mcp-server?style=flat-square" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/context-mcp-server"><img src="https://img.shields.io/npm/dm/context-mcp-server?style=flat-square" alt="npm downloads" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square" alt="License: MIT" /></a>
  <a href="package.json"><img src="https://img.shields.io/node/v/context-mcp-server?style=flat-square" alt="Node.js" /></a>
</p>

Persistent memory and codebase knowledge graph for AI coding assistants — delivered as a single MCP server.

One shared context store across Claude Code, VS Code Copilot, Google Antigravity (2.0 / IDE / CLI), Codex CLI, Hermes Agent, Claude.ai, and ChatGPT. Save context from one AI, pick it up in another.

---

## The Problem

Every conversation with an AI assistant starts from zero. The AI re-reads files it already read yesterday, re-discovers architecture it already understood, re-derives decisions that were already made. You repeat context. You paste the same background.

This gets worse as projects grow — reading 20 files to answer "what calls this function?" burns thousands of tokens every time.

---

## What It Solves

- **Persistent memory** — decisions, bugs, notes, and config saved across sessions, loaded automatically at conversation start
- **Shared store** — `~/.context-mcp/projects/<name>/` per-project on your machine; all AI tools read and write it
- **ContextGraph** — build a knowledge graph of your codebase once, answer structural questions in ~500 tokens instead of ~50,000

Real measured reduction on this project: **162× fewer tokens**, **99.38% reduction** per conversation.

---

## Installation

```bash
npm install -g context-mcp-server
```

Requires Node.js ≥ 18. Installs `context-mcp`, `context-mcp-http`, and the `ctx` CLI.

**ContextGraph requires [uv](https://docs.astral.sh/uv/)** (Python runner). Memory tools work without it.

```bash
# macOS / Linux
curl -Ls https://astral.sh/uv/install.sh | sh

# Windows
winget install astral-sh.uv
```

---

## Quick Start

Run from your project root:

```bash
ctx install --initial
```

This installs Node.js + Python (ContextGraph) dependencies. Run once after installing the npm package.

Then write MCP config + AI instruction files:

```bash
ctx install --all
```

To install for a specific platform only:

```bash
ctx install --claude      # Claude Code
ctx install --vscode      # VS Code Copilot
ctx install --antigravity # Google Antigravity (2.0 / IDE / CLI)
ctx install --codex       # Codex CLI
ctx install --hermes      # Hermes Agent
```

For Codex project installs, `ctx install --codex` writes:

- `.codex/config.toml` with `[mcp_servers.context-mcp]` MCP configuration.
- `AGENTS.md` with Context-MCP usage rules for Codex.
- `.codex/hooks/` pre/post shell hook scripts for project-local Codex sessions.

For web clients (Claude.ai, ChatGPT), start the HTTP server:

```bash
ctx online               # start in background, prints OAuth credentials + URL
ctx online --restart     # force restart
ctx online --port 3200   # different port
```

### Claude Code plugin

This repo is also a self-hosted Claude Code plugin marketplace — an alternative to `ctx install --claude` that doesn't require cloning or npm-installing anything yourself:

```bash
claude plugin marketplace add vibhasdutta/context-mcp
claude plugin install context-mcp@context-mcp-marketplace
```

or from inside a session: `/plugin marketplace add vibhasdutta/context-mcp` then `/plugin install context-mcp@context-mcp-marketplace`. This installs the `context-mcp` skill, the Bash pre/post-tool-use hooks, and registers the MCP server (still launched via `npx context-mcp-server@latest`) — everything `ctx install --claude` writes into `~/.claude/`, bundled as one installable unit. `ctx install --initial` is still required once to install the ContextGraph Python environment.

---

## CLI Reference

Both `ctx` and `context` are aliases for the same CLI.

```bash
ctx                            # interactive mode (UI)

# Context
ctx list [project]             # list entries by tree: graph / context / summary / plans
ctx projects                   # all projects with graph status + recent entries
ctx search "query"             # keyword → semantic fallback search
ctx add                        # add entry interactively
ctx summary [project]          # summarize recent entries

# Delete
ctx delete <id-prefix>         # delete one entry
ctx delete project <name>      # delete all entries for a project

# Server
ctx online                     # start HTTP server (idempotent)
ctx online --restart           # force stop + restart
ctx settings                   # view and edit config interactively

# Install
ctx install --initial          # install / update Node.js + Python deps
ctx install --all              # write config + rules for all platforms
```

---

## Security

File and git tools are sandboxed to your project root. Pass `rootPath` when calling `context.resume`:

```json
{ "action": "resume", "project": "my-app", "rootPath": "/home/user/my-app" }
```

Any file or git operation outside that directory is rejected. Applies to all HTTP-connected clients.

---

## Features

### Memory

- `context.resume` — loads recent entries, active plans, and graph status; registers `rootPath` for sandboxing
- `context.save` — store context as `note` (or `compaction` for session summaries); categorize with free-form `tags`
- `context.get` / `context.update` / `context.delete` — full CRUD, single or batch
- `search` — keyword-first, semantic fallback
- `plan` — auto-triggered when AI makes any plan; saves a markdown summary to a `planDir` you specify
- Auto-deduplication on save; auto-compact at 20 entries → stored in `summary.json`

### ContextGraph

> Also called **CodeGraph**. MCP tools use the `codegraph_*` prefix — both names mean the same thing.

**Step 1 — Build** (once per project, runs locally, no API cost):

```
codegraph_build(path)
```

Parses codebase via tree-sitter AST (16 languages, regex fallback). Extracts functions, classes, imports, call edges, and inheritance. Every node carries a full enriched schema: `signature`, `params`, `return_type`, `docstring`, `side_effect`, `exported`, `complexity`, `last_modified`. PageRank scores all nodes by connectivity. Metadata saved to `<project>/codegraph-cache/`.

**Step 2 — Query** (instant, forever):

```
codegraph_arch(path, limit?)                     → module map: every file, its exports, its imports
codegraph_query(path, question?, node?)          → structural question OR single-node lookup (or both)
codegraph_nodes(path, type, token_budget?)       → all nodes of a type, sorted by PageRank
codegraph_filter(path, node_type?, exported?,    → predicate filter: side_effect, return_type,
  side_effect?, return_type?, called_by?,          called_by, file_pattern — rank-sorted output
  calls?, file_pattern?, token_budget?)
codegraph_report(path)                           → god nodes, clusters, surprising connections
codegraph_affected(path, node, depth?)           → BFS blast radius — what breaks if you change X?
```

`codegraph_query` accepts `question` (natural language), `node` (exact/partial name), or both. `codegraph_filter` answers property questions ("which functions have side effects?", "all exported async handlers") without reading any files. Pass `token_budget` to any tool to get the highest-rank results within a token limit.

**What's in each node (v1.2+):**

| Field | Example |
|---|---|
| `signature` | `function fetchUser(id: string): Promise<User>` |
| `return_type` | `Promise<User>` |
| `side_effect` | `true` (db write, HTTP call, fs op detected) |
| `exported` | `true` |
| `docstring` | first comment or JSDoc string |
| `rank` | PageRank score — higher = more connected |
| `inherits` / `implements` | parent class / interface names |

**Step 3 — Visualize** (auto-generated on every build):

```
codegraph_html(path, formats?)            → regenerate visualizations on demand
```

Every `codegraph_build` automatically writes to `<project>/codegraph-cache/`:
- `graph.html` — interactive vis.js force graph (dark theme, search, community toggle)
- `tree.html` — D3 collapsible file hierarchy
- `callflow.html` — Mermaid architecture diagrams per community
- `graph.graphml` — Gephi / yEd export
- `obsidian/` — per-node `.md` vault with `[[wikilinks]]`

### File & Git Tools

Available to HTTP-connected clients (Claude.ai, ChatGPT). Local AI clients use their native IDE tools.

- `read_file`, `write_file`, `patch_file`, `create_dir`, `list_dir`, `delete_file`
- `git_status`, `git_diff`, `git_log`, `git_add`, `git_commit`, `git_push`, `git_pull`, `git_branch`, `git_stash`, `git_reset`, `git_show`

Enable git tools with `--access-git` flag or `access_git: true` in config.

---

## Server Flags

```
context-mcp [--data-dir <path>]

context-mcp-http [--port <number>] [--host <string>] [--access-git] [--data-dir <path>]
```

Default port: `3100`. Default data dir: `~/.context-mcp`.

---

## Config Reference

`~/.context-mcp/contextconfig.json` — auto-created on first run:

| Field | Default | Description |
|-------|---------|-------------|
| `client_id` | `"context-mcp"` | OAuth client ID |
| `client_secret` | auto-generated | OAuth signing secret |
| `port` | `3100` | HTTP server port |
| `host` | `"localhost"` | HTTP bind host |
| `access_git` | `false` | Enable git tools for HTTP clients |
| `public_url` | `null` | Public URL for `ctx online` output |
| `allowed_redirect_uris` | `["https://claude.ai"]` | OAuth redirect URI whitelist |
| `allowed_origins` | `[]` | Extra CORS origins |

Edit with `ctx settings`.

---

## License

MIT
