# context-mcp — Full Refactor & Feature Plan

> Generated after full audit of all source files.
> Current commit state: post schema-redesign, post git-tools, post discussion split.

---

## 1. Audit Findings

### 1.1 Architecture — Monolithic `index.js`

`index.js` is **850+ lines** doing everything:
- 3 tool definition arrays (`CORE_TOOLS`, `FILE_TOOLS`, `GIT_TOOLS`) — ~400 lines
- `runGit()` helper
- `autoDigest()` helper
- `createServer()` with one giant switch containing all 20+ tool handlers
- stdio entry point

This means every tool is coupled to every other tool. Adding one tool requires editing the same file as everything else. Fixing a bug in `git_commit` means opening the same file as `context.save`.

**Proposed structure:**

```
src/
  index.js          ← stdio entry point only (~10 lines)
  server.js         ← createServer() that imports + mounts all tools
  config.js         ← unchanged
  db.js             ← unchanged (data layer)
  vector.js         ← unchanged (TF-IDF)
  summarizer.js     ← unchanged
  http.js           ← unchanged (HTTP transport)
  cli.js            ← unchanged (CLI)
  tools/
    context.js      ← CONTEXT_TOOL def + handler
    discussion.js   ← DISCUSSION_TOOL def + handler
    search.js       ← SEARCH_TOOL def + unified search handler
    session.js      ← SESSION_TOOL def + handler
    errorCheck.js   ← ERROR_CHECK_TOOL def + handler
    fileTools.js    ← FILE_TOOLS array + all file handlers
    gitTools.js     ← GIT_TOOLS array + runGit() + all git handlers
    mapProject.js   ← MAP_PROJECT_TOOL def + handler (NEW)
  hooks/
    autoContext.js  ← shared auto-context hook called by file + git tools
    autoLink.js     ← shared auto-link hook for discussion linking
```

Each `tools/*.js` file exports:
```js
export const definition = { name, description, inputSchema, outputSchema };
export async function handle(args, sessionState) { ... }
```

`server.js` imports all tools, registers them, and owns the switch dispatch.

---

### 1.2 Broken / Incomplete Hooks

#### Hook: auto-context on file/git write
**Status: conditionally broken**

`write_file`, `patch_file`, `git_commit` all do:
```js
if (activeSessionId) { saveContext(...) }
```

If the AI hasn't called `session.new` or `session.continue`, `activeSessionId` is `null` and the hook silently does nothing. No error, no trace.

**Fix:** Auto-start a minimal session if none is active when a hook fires. Or at minimum, save the context without a `sessionId` so the trace is never lost.

```js
// in autoContext.js
export function fireAutoContext({ title, content, type, files, sessionId, project }) {
  saveContext({
    project: project || 'global',
    sessionId: sessionId || null,  // save even without session
    title, content, type,
    source: 'auto',
    tags: ['auto-hook'],
    files,
  });
}
```

#### Hook: auto-link context to active discussion
**Status: partially broken**

`context.save` calls `linkContextToDiscussion` if `activeDiscussionId` is set.
`context.update` does NOT call `linkContextToDiscussion`. Updated entries are never linked.

**Fix:** Both `context.save` and `context.update` should fire the auto-link hook.

#### Hook: `expiresAt` auto-archival
**Status: only fires on session.new/continue**

`archiveExpired()` is called in `session.new` and `session.continue` only. If no session is started, expired entries are never archived.

**Fix:** Also call `archiveExpired()` inside `context.get` (lazy archival — archive before returning results).

#### Hook: session auto-save context
**Status: works but fragile**

All auto-context hooks depend on `activeSessionId`. The `sessionState` object (`activeSessionId`, `sessionProject`, `activeDiscussionId`) is currently per-server-instance as local `let` variables. When `server.js` is split from tool files, these need to be passed explicitly.

**Fix:** Extract session state into a `SessionState` class or plain object passed to each tool handler. Tools mutate it, server.js holds the reference.

```js
// server.js
const state = {
  sessionId:      null,
  sessionProject: null,
  sessionStart:   null,
  discussionId:   null,
};
// pass to each handler: handle(args, state)
```

#### Hook: discussion auto-close
**Status: works**
`updateDiscussionStep` auto-sets `discussion.status = 'done'` when all steps are `done/skipped`. Also clears `activeDiscussionId` in the handler. No fix needed.

---

### 1.3 Search — Two Functions, Should Be One

**Current state:**
- `db.js` → `searchContext()` — keyword scoring (word frequency)
- `vector.js` → `vectorSearch()` — TF-IDF cosine similarity
- `vector.js` → `findRelated()` — wrapper around vectorSearch

The MCP `search` tool already unifies them from the AI's view (`mode: keyword | semantic | related`). But the implementations are split across two files with no shared interface.

**Problem:** Any caller that wants "search" has to know which function to call and where it lives. The CLI has its own fork of the logic. The `error_check` tool calls `vectorSearch` directly.

**Fix:** Create `src/search.js` as the single search entry point:

```js
// src/search.js
export function search({ query, mode = 'semantic', project, limit = 10, id }) {
  if (mode === 'keyword')  return searchContext({ query, project, limit });
  if (mode === 'semantic') return vectorSearch(query, getContext({ project, limit: 500 }), limit);
  if (mode === 'related')  return findRelated(getContext({ limit: 1000 }).find(e => e.id.startsWith(id)), getContext({ limit: 1000 }), limit);
  throw new Error(`Unknown search mode: ${mode}`);
}
```

Both the MCP tool handler and the CLI import from `src/search.js`. `db.js` and `vector.js` stay as low-level implementations.

---

### 1.4 `deleteProject` Missing Discussions

`db.js:deleteProject()` deletes contexts and sessions for a project but does NOT delete discussions.

**Fix:**
```js
// in deleteProject()
store.discussions = store.discussions.filter(d => d.project !== projectName);
```

---

### 1.5 `ACCESS_GIT` Env Var Inconsistency

`index.js` createServer default uses `getConfig().access_git === true` (reads config file).
`http.js` passes `config.access_git === true` (also config file).

But we told the user `ACCESS_GIT=true` env var controls it.

**Fix:** In `config.js`, merge env var into config:
```js
config.access_git = process.env.ACCESS_GIT === 'true' || stored.access_git || false;
```
This way both the env var AND the config file work. Env var wins.

---

### 1.6 Dead Code

- `normalizeSteps()` in `db.js` — defined but never called (replaced by `mergeSteps`). Remove.
- `projectDigest()` in `summarizer.js` — exported but never imported anywhere. Remove or wire up.

---

## 2. CodeGraph — Companion MCP Server (replaces map_project)

> CodeGraph is a **separate Python MCP server** built alongside context-mcp.
> map_project (previously Phase 3) is removed — CodeGraph does this properly.

### Why separate, not integrated

CodeGraph requires Python-only libraries: `tree-sitter`, `networkx`, `python-leiden`,
`pymupdf`, `faster-whisper`. These have no clean Node.js equivalents. Integrating them
into context-mcp would mean shelling out to Python subprocesses — fragile and slow.
Two separate MCP servers running in parallel is the correct architecture.

```
AI Assistant (Claude Code / Cursor / Gemini CLI / any MCP client)
       │
       ├── context-mcp  (Node.js) — memory, sessions, discussions, git
       └── codegraph    (Python)  — codebase graph, AST, queries, reports
```

### MCP tools CodeGraph exposes

| Tool | What it does |
|------|-------------|
| `codegraph_build` | Scan project, build/update knowledge graph. Content-hash cache — only changed files re-extract. |
| `codegraph_query` | Natural language question → graph traversal answer. No LLM call on query. |
| `codegraph_report` | Return full REPORT.md — god nodes, clusters, surprising connections, suggested questions. |
| `codegraph_nodes` | List all nodes of a given type: `class`, `function`, `module`, `concept`, `file`. |
| `codegraph_path` | Find shortest relationship path between two concepts. |

### Architecture (from CODEGRAPH_PLAN.md)

```
project files → File Scanner (SHA-256 hash, diff against cache)
              → Pass 1: tree-sitter AST (code), regex (SQL/config)
              → Pass 2: Batched LLM — all changed docs/images in ONE API call
              → Graph Builder: NetworkX + Leiden community clustering
              → graph.json + REPORT.md + MCP server
```

### Cache strategy
SHA-256 hash per file stored in `codegraph-cache/cache.json`. Unchanged files load
from cache instantly (zero API calls). A 200-file project where 3 files changed costs
exactly 3 file extractions.

### LLM batching
All files needing LLM extraction (docs, images) collected into ONE batched API call.
50 docs, 4 changed = 1 API call. Graphify makes one call per file.

### Integration with context-mcp

context-mcp gets ONE new thing: `context { action: 'sync_graph' }` — saves a
CodeGraph build summary as a context entry so the session knows the graph exists.

```js
// AI agent workflow
await codegraph_build({ path: '/project' });
await context({ action: 'sync_graph', graphSummary: result, project: 'my-project' });
// now session knows the graph was built, when, and how many nodes
```

`codegraph_query` results can also be saved as context entries linked to the active
discussion — the AI agent does this explicitly, no tight coupling needed.

### File structure (separate repo: `codegraph/`)

```
codegraph/
  server.py               ← MCP server entry point
  scanner.py              ← File walker + SHA-256 hasher
  cache.py                ← cache.json read/write
  report.py               ← REPORT.md generator
  config.py               ← settings
  extractors/
    ast_extractor.py      ← tree-sitter (Python, JS, TS, Go, Rust, Java, C/C++, Ruby)
    doc_extractor.py      ← pymupdf + markdown
    image_extractor.py    ← LLM vision
    audio_extractor.py    ← faster-whisper
  graph/
    builder.py            ← NetworkX graph construction
    clustering.py         ← Leiden community detection
    query.py              ← graph traversal for codegraph_query
  llm/
    batch.py              ← batched Anthropic API calls
```

### Build order

1. `cache.py` — hashing + cache read/write
2. `scanner.py` — walk directory, detect changed files
3. `extractors/ast_extractor.py` — tree-sitter (Python + JS first)
4. `graph/builder.py` — NetworkX graph from nodes
5. `server.py` — MCP server with `codegraph_build` + `codegraph_query`
6. `graph/query.py` — graph traversal
7. `report.py` — REPORT.md generator
8. `extractors/doc_extractor.py` — PDF + markdown
9. `llm/batch.py` — batched LLM extraction
10. `extractors/image_extractor.py` — vision
11. `extractors/audio_extractor.py` — faster-whisper
12. `graph/clustering.py` — Leiden community detection

### MCP config (user setup)

```json
{
  "mcpServers": {
    "context-mcp": {
      "command": "node",
      "args": ["src/index.js"],
      "cwd": "/path/to/context-mcp"
    },
    "codegraph": {
      "command": "python",
      "args": ["-m", "codegraph.server"],
      "cwd": "/path/to/your/project"
    }
  }
}
```

---

**Available on both stdio AND HTTP** (not gated by `enableFileTools` — it reads the filesystem but is also useful offline for the AI to understand project structure).

### Purpose
On first run of a project, or when the structure changes, map the full file tree with per-file descriptions. The AI can call `map_project.create` once, then `get` it in future sessions to instantly understand the codebase without re-reading files.

### Schema
```js
{
  id:          uuid,
  name:        string,        // project name / slug
  rootPath:    string,        // absolute path to project root
  description: string,        // one-line project description
  files: [
    {
      path:        string,    // relative path from rootPath
      type:        'file' | 'dir',
      description: string,    // short description of what this file does
      lang:        string?,   // detected: js, ts, py, md, json, etc.
      size:        number?,   // bytes
    }
  ],
  ignorePatterns: string[],   // e.g. ['node_modules', '.git', 'dist']
  createdAt: ISO,
  updatedAt: ISO,
}
```

### Actions
| Action | Description |
|--------|-------------|
| `create` | Scan `rootPath`, build file list, save map. Requires `name` + `rootPath`. |
| `update` | Re-scan `rootPath`, merge new files, update descriptions if provided. |
| `get` | Retrieve map by `name`. Returns full file list. |
| `list` | List all maps (name, rootPath, fileCount, updatedAt). |
| `delete` | Remove map by `name`. |
| `annotate` | Update description for specific files without re-scanning. |

### Storage
New `projectMaps` array in `store.json`. Added to `db.js` alongside contexts, sessions, discussions.

### Auto-ignore defaults
```
node_modules, .git, dist, build, .next, __pycache__, *.pyc,
.env, *.lock, coverage, .DS_Store
```

### inputSchema
```js
{
  action:         enum ['create','update','get','list','delete','annotate'],
  name:           string,   // project slug
  rootPath:       string,   // [create|update] absolute path to scan
  description:    string?,  // [create] one-line project description
  ignorePatterns: string[]?,// [create] extra patterns to ignore
  fileAnnotations: [        // [annotate] per-file descriptions
    { path: string, description: string }
  ]?,
  maxDepth:       number?,  // [create|update] max scan depth (default: 6)
}
```

---

## 0. Storage Architecture — Split Monolithic Store

> This is Phase 0 — done before anything else. Every other phase depends on it.

### Current (monolithic)
```
~/.context-mcp/
  store.json          ← contexts[] + sessions[] + discussions[] all in one file
  store.json.lock     ← single mutex for all writes
  contextconfig.json
```

### Target (per-collection)
```
~/.context-mcp/
  contexts.json       ← context entries only
  discussions.json    ← discussions only
  sessions.json       ← sessions only
  maps.json           ← project maps (new tool)
  contextconfig.json  ← unchanged
```

### What changes in `db.js`

**In-memory `_cache` shape is unchanged:** `{ contexts[], discussions[], sessions[], projectMaps[] }`

Only the serialization layer changes:

| Function | Change |
|---|---|
| `load()` | Reads 4 files instead of 1. Runs one-time migration if old `store.json` found. |
| `readStoreFromDisk()` | Reads 4 files, merges into one object |
| `flushToDisk()` | Uses existing dirty sets to flush ONLY changed files. `discussion.save` → only writes `discussions.json`. |
| Lock files | Per-file locks: `contexts.json.lock`, `discussions.json.lock`, `sessions.json.lock`, `maps.json.lock` |
| `mergeStore()` | Unchanged — logic stays the same, just operates on merged data |

### Flush optimisation

We already track dirty state per-collection:
```js
_changedContextIds    → flush contexts.json
_changedSessionIds    → flush sessions.json
_changedDiscussionNames → flush discussions.json
// new:
_changedMapNames      → flush maps.json
```

A `discussion.save` call sets `_changedDiscussionNames`. `flushToDisk` sees only that set is non-empty → writes only `discussions.json`. `contexts.json` is never opened.

### One-time migration (automatic)

```
First load() after update:
  1. contexts.json exists? → use new format
  2. No? store.json exists? → migrate:
     a. read store.json
     b. write contexts.json, discussions.json, sessions.json
     c. rename store.json → store.json.migrated (keeps backup)
  3. Subsequent loads use new files
```

### Implementation steps

| # | Change | Detail |
|---|--------|--------|
| 0.1 | Replace `STORE_PATH` with 4 path constants | `CONTEXTS_PATH`, `DISCUSSIONS_PATH`, `SESSIONS_PATH`, `MAPS_PATH` |
| 0.2 | Add `_changedMapNames` dirty set | For future `map_project` tool |
| 0.3 | Rewrite `load()` | Read 4 files; auto-migrate from `store.json` |
| 0.4 | Rewrite `readStoreFromDisk()` | Read 4 files into merged object |
| 0.5 | Rewrite `flushToDisk()` | Per-file locking; only flush dirty collections |
| 0.6 | Update `process.on('exit')` | Flush all 4 files on exit |

---



### Phase 1 — Bug Fixes + Missing Tools (no restructuring)
Apply these to existing files first. They're safe, isolated.

| # | Change | File | Impact |
|---|--------|------|--------|
| 1.1 | `deleteProject` — also delete discussions | `db.js` | bug fix |
| 1.2 | `normalizeSteps` dead code removal | `db.js` | cleanup |
| 1.3 | `projectDigest` — wire up or remove | `summarizer.js` | cleanup |
| 1.4 | `ACCESS_GIT` env var → config.js merge | `config.js` | consistency |
| 1.5 | `context.update` → add auto-link hook | `index.js` | hook fix |
| 1.6 | `context.get` → call `archiveExpired()` lazily | `index.js` | hook fix |
| 1.7 | Auto-context hooks — save even without `activeSessionId` | `index.js` | hook fix |
| 1.8 | Add `create_dir` to `FILE_TOOLS` — explicit directory creation | `index.js` | missing tool |

### Phase 2 — Search Unification
| # | Change | File |
|---|--------|------|
| 2.1 | Create `src/search.js` with unified `search()` function | new file |
| 2.2 | Update `index.js` search handler to use `src/search.js` | `index.js` |
| 2.3 | Update `error_check` handler to use `src/search.js` | `index.js` |
| 2.4 | Update `cli.js` to use `src/search.js` | `cli.js` |

### Phase 3 — CodeGraph (separate Python repo)

CodeGraph is built as a standalone Python MCP server in its own repository.
context-mcp gets one addition: `context { action: 'sync_graph' }` bridge.

| # | Change | File |
|---|--------|------|
| 3.1 | Add `sync_graph` action to context tool inputSchema | `index.js` |
| 3.2 | Add `sync_graph` handler — saves build summary as context entry (type: architecture) | `index.js` |
| 3.3 | Add `ctx graph` command to CLI — shows stored graph summaries | `cli.js` |

### Phase 4 — Architecture Split
Split `index.js` into `src/server.js` + `src/tools/*.js` modules.

| # | Change | New File |
|---|--------|---------|
| 4.1 | Extract session state object | `src/server.js` |
| 4.2 | Extract `autoContext` and `autoLink` hooks | `src/hooks/autoContext.js`, `src/hooks/autoLink.js` |
| 4.3 | Extract context tool | `src/tools/context.js` |
| 4.4 | Extract discussion tool | `src/tools/discussion.js` |
| 4.5 | Extract search tool | `src/tools/search.js` |
| 4.6 | Extract session tool | `src/tools/session.js` |
| 4.7 | Extract error_check tool | `src/tools/errorCheck.js` |
| 4.8 | Extract file tools | `src/tools/fileTools.js` |
| 4.9 | Extract git tools | `src/tools/gitTools.js` |
| 4.10 | Extract map_project tool | `src/tools/mapProject.js` |
| 4.11 | Create `src/server.js` — imports tools, owns session state, dispatch | `src/server.js` |
| 4.12 | Reduce `src/index.js` to stdio entry point only | `src/index.js` |
| 4.13 | Update `src/http.js` import to point to `src/server.js` | `src/http.js` |

---

## 4. Session State Object (Phase 4 reference)

```js
// src/server.js
function makeSessionState() {
  return {
    sessionId:      null,   // active session ID
    sessionProject: null,   // project scoped to this session
    sessionStart:   null,   // ISO timestamp session started
    discussionId:   null,   // active discussion (for auto-link)
  };
}
```

Each tool handler receives `(args, state)`. Handlers that mutate state (session.new, discussion.save) write to `state.*` directly. The server holds one `state` per `createServer()` call.

---

## 5. File Structure After Phase 4

```
context-mcp/
  src/
    index.js          ← entry point (stdio, ~10 lines)
    server.js         ← createServer(), tool dispatch, session state
    http.js           ← HTTPS transport + OAuth
    config.js         ← config file management
    db.js             ← data layer (contexts, sessions, discussions, projectMaps)
    vector.js         ← TF-IDF search
    summarizer.js     ← extractive summarization
    search.js         ← unified search (keyword + semantic + related)
    cli.js            ← terminal CLI
    tools/
      context.js
      discussion.js
      search.js
      session.js
      errorCheck.js
      fileTools.js
      gitTools.js
      mapProject.js
    hooks/
      autoContext.js
      autoLink.js
  PLAN.md             ← this file
  package.json
  .certs/
  README.md

codegraph/           ← separate Python repo
  server.py
  scanner.py
  cache.py
  report.py
  extractors/
  graph/
  llm/
```

---

## 6. Tool Surface After All Phases

| Tool | Transport | Gate |
|------|-----------|------|
| `context` | both | always |
| `discussion` | both | always |
| `search` | both | always |
| `session` | both | always |
| `error_check` | both | always |
| `list_dir` | HTTP only | `enableFileTools` |
| `read_file` | HTTP only | `enableFileTools` |
| `create_dir` | HTTP only | `enableFileTools` |
| `write_file` | HTTP only | `enableFileTools` |
| `patch_file` | HTTP only | `enableFileTools` |
| `delete_file` | HTTP only | `enableFileTools` |
| `git_status` | both | `ACCESS_GIT=true` |
| `git_diff` | both | `ACCESS_GIT=true` |
| `git_log` | both | `ACCESS_GIT=true` |
| `git_add` | both | `ACCESS_GIT=true` |
| `git_commit` | both | `ACCESS_GIT=true` |
| `git_push` | both | `ACCESS_GIT=true` |
| `git_pull` | both | `ACCESS_GIT=true` |
| `git_branch` | both | `ACCESS_GIT=true` |
| `git_stash` | both | `ACCESS_GIT=true` |
| `git_reset` | both | `ACCESS_GIT=true` |
| `git_show` | both | `ACCESS_GIT=true` |

**Total: 21 tools** (context-mcp) + **5 tools** (codegraph, separate server)

---

## Phase 5 — Distribution & Security

### 5.1 Package Distribution

| Package | Registry | Zero-install run |
|---|---|---|
| context-mcp | npm | `npx -y context-mcp` |
| codegraph | PyPI + uv | `uvx codegraph-mcp` |

MCP config (zero-install, works in Claude Code / Cursor / Windsurf / any MCP client):
```json
{
  "mcpServers": {
    "context-mcp": { "command": "npx", "args": ["-y", "context-mcp"] },
    "codegraph":   { "command": "uvx", "args": ["codegraph-mcp"] }
  }
}
```

### 5.2 Online Access — Local + Optional ngrok

> **Relay removed (May 2026):** System now operates purely local. For remote access, users optionally run `ngrok http 3100` manually.

Data **always stays local** (`~/.context-mcp/`). 

**Local deployment:**
```
AI Assistant (localhost or same network)
      │  HTTPS (if TLS configured)
      ▼
context-mcp-http (localhost:3100)
      │
~/.context-mcp/         ← all data stays local
```

**Optional remote access:**
```bash
# User manually runs ngrok (optional)
$ ngrok http 3100

# This generates a temporary public URL for remote access
# User shares ngrok URL + client_id + client_secret with AI assistant
```

Simple, zero-infrastructure model. Users control when/if to expose their server.

### 5.3 Registration — Client Credentials (Auto-Generated)

No device flow or registration needed. On first run, `contextconfig.json` is auto-created with:

```json
{
  "client_id": "auto-uuid",
  "client_secret": "auto-hex",
  "port": 3100,
  "host": "localhost",
  "access_git": false
}
```

For secret rotation: `ctx rotate-secret` generates new secret, saves to keychain.

### 5.4 Security Layers

#### Offline (stdio)

| Threat | Protection |
|---|---|
| Other process reads data files | `chmod 700` on `~/.context-mcp/`, `chmod 600` on all JSON files — set on creation |
| client_secret stolen from disk | Stored in system keychain via `keytar` (macOS Keychain / Linux Secret Service / Windows Credential Manager) |

#### Online (local + optional ngrok)

| Layer | Mechanism | Protects against |
|---|---|---|
| TLS 1.3 (optional) | Configured by user in `contextconfig.json` | Network interception |
| OAuth 2.0 PKCE | Client credentials + JWT tokens | Unauthorized connections |
| HMAC-SHA256 | Every HTTP request signed | Replay attacks, tampering |
| Secret rotation | `ctx rotate-secret` | Compromised credentials |
| File permissions | `chmod 700/600` on `~/.context-mcp/` | Local file access |

**Data privacy:** All context data stays on user's machine. No relay server, no cloud storage.

### 5.5 Implementation Steps

| # | Change | Where |
|---|--------|-------|
| 5.1 | `ctx rotate-secret` — generate new secret, save to keychain | `cli.js` |
| 5.2 | `keytar` integration — store/read client_secret from system keychain | `config.js` |
| 5.3 | `chmod 700/600` on data dir + all files on creation | `db.js` |
| 5.4 | JWT access token validation middleware (verify signature + expiry) | `http.js` |
| 5.5 | Auto-create `contextconfig.json` with client_id + client_secret on first run | `config.js` |
| 5.6 | Optional TLS support — load cert/key from config | `http.js` |
| 5.7 | npm publish pipeline | `package.json` |

**Relay removed:** Device flow, relay server, relay auth, relay client code all deleted (May 2026).

---

## 7. Execution Order

**Phase 0** — Storage split. Foundation everything else sits on.
**Phase 1** — 17 bug fixes + hook fixes + linking. No structure changes.
**Phase 2** — Search unification. Small, clean.
**Phase 3** — CodeGraph bridge (3 changes to context-mcp). CodeGraph itself is separate.
**Phase 4** — Architecture split into `src/tools/` + `src/hooks/`. Largest, done last.
**Phase 5** — Security, secret rotation, optional TLS. Simplified to local-only.

Phase 4 is the only one that restructures files. All phases before it patch existing files only.

---

## 8. Status Lifecycle & Linking — Full Audit

> Every status transition, link direction, and auto-hook. What works, what's broken, what's missing.

---

### 8.1 Context Entry — Status Lifecycle

| Transition | Trigger | Works? |
|---|---|---|
| created → `active` | default on `context.save` | ✓ |
| `active` → `done` | explicit `context.update { status:'done' }` | ✓ |
| `active` → `archived` | explicit update OR `expiresAt` passed | ✗ partial — `archiveExpired()` only fires on `session.new/continue` |
| archived entries hidden in `context.get` | should default-filter `status !== 'archived'` | ✗ **bug** — `context.get` returns archived entries with no filter |

**Fixes:**
- `context.get` must default-filter out `archived` entries. Add `includeArchived: boolean` opt-in param.
- `archiveExpired()` also called lazily inside `context.get` (Phase 1.6 already covers this).

---

### 8.2 Discussion — Status Lifecycle

| Transition | Trigger | Works? |
|---|---|---|
| created → `draft` | default | ✓ |
| `draft` → `active` | `discussion.save { status:'active' }` — sets `activeDiscussionId` | ✓ |
| `active` → `done` (manual) | `discussion.save { status:'done' }` | ✓ |
| `active` → `done` (auto) | all steps `done/skipped` in `update_step` | ✓ |
| `done` → clears `activeDiscussionId` | handled in `update_step` and `discussion.save` | ✓ |
| `active` → `on-hold` | `discussion.save { status:'on-hold' }` — `activeDiscussionId` NOT cleared | ✗ **bug** |
| `active` → `archived` | `discussion.save { status:'archived' }` — `activeDiscussionId` NOT cleared | ✗ **bug** |
| deleted → clears `activeDiscussionId` | `discussion.delete` handler | ✓ |

**Fixes:**
- In `discussion.save` handler: any status change away from `active` (`on-hold`, `archived`, `done`) must clear `activeDiscussionId` when it matches the current one.

---

### 8.3 Linking — Full Direction Audit

#### Context ↔ Discussion

| Link | Direction | Works? |
|---|---|---|
| Discussion knows its context entries | `discussion.linkedContextIds[]` via `linkContextToDiscussion()` | ✓ partial — only from `context.save` |
| Context entry knows its discussion | `context.discussionId` field | ✗ **field missing entirely** |
| `context.update` auto-links | should call `linkContextToDiscussion()` | ✗ not wired |
| `write_file` auto-context links to discussion | hook saves context but never calls `linkContextToDiscussion()` | ✗ not wired |
| `patch_file` auto-context links to discussion | same | ✗ not wired |
| `git_commit` auto-context links to discussion | same | ✗ not wired |
| `error_check` save links to discussion | same | ✗ not wired |

**Fixes:**
- Add `discussionId: string | null` field to context entry schema in `db.js:saveContext()`.
- `linkContextToDiscussion()` also writes `entry.discussionId = discussionId` back to the context entry.
- Extract a single `fireAutoLink(entryId, state)` helper in `hooks/autoLink.js` — called after EVERY `saveContext()`: `write_file`, `patch_file`, `git_commit`, `error_check`, `context.update`.

#### Context ↔ Context (relations)

| Link | Direction | Works? |
|---|---|---|
| `A relates-to B` saved on A | `A.relations = [{id:B, relType}]` | ✓ |
| B has back-reference to A | `B.relatedBy = [{id:A, relType}]` — field doesn't exist | ✗ |
| `search.related` uses declared relations | uses semantic similarity only — ignores `relations` field | ✗ partial |

**Fixes:**
- Add `relatedBy: {id, relType}[]` field to context entry schema. Default `[]`.
- Add `addRelation({ fromId, toId, relType })` to `db.js` — writes both directions atomically: `A.relations` and `B.relatedBy`.
- `search.related` mode: check explicit `relations` + `relatedBy` first, then fall back to semantic similarity for enrichment.

#### Context ↔ Session

| Link | Direction | Works? |
|---|---|---|
| Context entry → session | `context.sessionId` | ✓ |
| Session → context entries | implicit via `getContextSince(session.startedAt)` | ✓ by design |

No changes needed.

#### Discussion ↔ Discussion (parent/child)

| Link | Direction | Works? |
|---|---|---|
| Child knows parent | `discussion.parentId` | ✓ |
| Parent knows children | no `childIds[]` — must scan `listDiscussions` | ✗ partial |

**Fix:** `listDiscussions({ grouped: true })` option groups results by `parentId` tree. No schema change needed.

---

### 8.4 Auto-Hook Completeness Matrix

| Action | Saves context entry? | Links to active discussion? | Respects `sessionId`? |
|---|---|---|---|
| `context.save` | ✓ | ✓ | ✓ |
| `context.update` | n/a | ✗ missing | n/a |
| `write_file` | ✓ auto | ✗ missing | ✓ |
| `patch_file` | ✓ auto | ✗ missing | ✓ |
| `git_commit` | ✓ auto | ✗ missing | ✓ |
| `error_check.save` | ✓ auto | ✗ missing | ✓ |
| `discussion.save → active` | n/a | sets `activeDiscussionId` ✓ | n/a |
| `discussion.save → non-active` | n/a | should clear `activeDiscussionId` ✗ | n/a |
| `session.end` | ✓ summary | n/a | ✓ |
| `session.checkpoint` | ✓ checkpoint | n/a | n/a |

**Every ✗ in "Links to active discussion?" is the same fix:** extract `fireAutoLink(entryId, state)` helper. Call it after every `saveContext()` anywhere. One function, one place to maintain.

---

### 8.5 New Schema Fields Needed

**Context entry — add to `db.js:saveContext()`:**

| Field | Type | Default | Set by |
|---|---|---|---|
| `discussionId` | `string \| null` | `null` | `linkContextToDiscussion()` |
| `relatedBy` | `{id, relType}[]` | `[]` | `addRelation()` |

**Discussion — already complete.**

---

### 8.6 New `db.js` Functions Needed

| Function | Purpose |
|---|---|
| `addRelation({ fromId, toId, relType })` | Writes `A.relations` and `B.relatedBy` atomically in one flush |
| `getContextByDiscussion(discussionId)` | Returns all context entries where `entry.discussionId === id` |
| `clearDiscussionLink(contextId)` | Clears `discussionId` on a context entry (for when a discussion is deleted) |

---

### 8.7 Updated Phase 1 — Additional Fixes from Section 8

Add to Phase 1 implementation list:

| # | Change | File | Section |
|---|--------|------|---------|
| 1.9  | Add `discussionId` + `relatedBy` fields to context entry schema | `db.js` | 8.5 |
| 1.10 | `linkContextToDiscussion()` — also write `entry.discussionId` back | `db.js` | 8.3 |
| 1.11 | Add `addRelation()` + `getContextByDiscussion()` + `clearDiscussionLink()` | `db.js` | 8.6 |
| 1.12 | `discussion.save` handler — clear `activeDiscussionId` on non-active status | `index.js` | 8.2 |
| 1.13 | `context.get` — default filter `status !== 'archived'` + `includeArchived` param | `index.js` | 8.1 |
| 1.14 | Extract `fireAutoLink(entryId, state)` helper inline in `index.js` (Phase 4 moves it to `hooks/`) | `index.js` | 8.4 |
| 1.15 | Wire `fireAutoLink` after every auto-context save: `write_file`, `patch_file`, `git_commit`, `error_check`, `context.update` | `index.js` | 8.4 |
| 1.16 | `search.related` — check explicit `relations` + `relatedBy` before semantic fallback | `index.js` | 8.3 |
| 1.17 | `discussion.delete` — call `clearDiscussionLink()` for all linked context entries | `index.js` | 8.3 |
