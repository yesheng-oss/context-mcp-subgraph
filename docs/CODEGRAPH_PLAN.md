# CodeGraph — MCP Knowledge Graph Server

> Turn any codebase into a queryable knowledge graph, exposed as an MCP server that any AI coding assistant can call directly.

---

## What it is

CodeGraph is a Python MCP server. When connected, any MCP-compatible AI assistant (Claude Code, Cursor, Gemini CLI, VS Code Copilot, etc.) gets a set of tools it can call to understand your codebase — without reading every file individually.

Instead of the AI grepping through 200 files and burning tokens, it calls `codegraph_query` and gets back a precise answer from the pre-built graph.

---

## How it beats Graphify

| Feature | Graphify | CodeGraph |
|---|---|---|
| Integration | Per-platform hooks (14+ setups) | Single MCP server, works everywhere |
| Re-runs | Full re-extraction every time | Content-hash cache — only changed files re-extract |
| LLM calls | One subagent per file | Batched — all changed docs in one API call |
| Setup | `pip install` + per-platform install command | Add to MCP config, done |
| Output | 3 files + hook files | MCP tools + `REPORT.md` + `graph.json` |

---

## MCP Tools exposed

The server exposes these tools to any connected AI assistant:

### `codegraph_build`
Scans the project, builds or updates the knowledge graph.
- Input: `path` (project directory)
- Output: summary — nodes added, nodes from cache, LLM calls made, time taken
- Behaviour: hashes every file, skips unchanged files, batches LLM calls for docs/images that changed

### `codegraph_query`
Ask a natural language question about the codebase.
- Input: `question` (e.g. "what does the auth module depend on?")
- Output: answer derived from the graph — relevant nodes, relationships, file locations
- No LLM call on query — pure graph traversal

### `codegraph_report`
Get the full REPORT.md contents — god nodes, surprising connections, suggested questions.
- Input: none
- Output: markdown report text

### `codegraph_nodes`
List all nodes of a given type.
- Input: `type` — one of `class`, `function`, `module`, `concept`, `file`
- Output: list of matching nodes with their connections

### `codegraph_path`
Find the relationship path between two concepts.
- Input: `from`, `to` (node names or descriptions)
- Output: shortest path through the graph explaining how they connect

---

## Architecture

```
project files
     │
     ▼
┌─────────────────────────────────┐
│  File Scanner                   │
│  SHA-256 hash every file        │
│  Compare to cache.json          │
│  → unchanged: load from cache   │
│  → changed: queue for extract   │
└─────────────────────────────────┘
     │ changed files only
     ▼
┌─────────────────────────────────┐
│  Pass 1 — Local (free, fast)    │
│  Tree-sitter AST for code       │
│  Regex fallback for SQL/config  │
│  faster-whisper for audio/video │
│  pymupdf for PDFs               │
└─────────────────────────────────┘
     │ docs + images only
     ▼
┌─────────────────────────────────┐
│  Pass 2 — Batched LLM           │
│  All changed docs/images in     │
│  ONE batched API call           │
│  Results cached by file hash    │
└─────────────────────────────────┘
     │
     ▼
┌─────────────────────────────────┐
│  Graph Builder                  │
│  NetworkX directed graph        │
│  Leiden community clustering    │
│  Incremental merge — add/remove │
│  only changed nodes             │
└─────────────────────────────────┘
     │
     ├──→ graph.json   (full queryable graph)
     ├──→ REPORT.md    (god nodes, insights, suggested questions)
     └──→ MCP server   (tools available to any AI assistant)
```

---

## File structure

```
codegraph/
├── server.py          # MCP server entry point
├── scanner.py         # File walker + SHA-256 hasher
├── extractors/
│   ├── ast_extractor.py     # Tree-sitter for code files
│   ├── doc_extractor.py     # pymupdf + markdown parser
│   ├── image_extractor.py   # LLM vision for images/diagrams
│   └── audio_extractor.py   # faster-whisper transcription
├── graph/
│   ├── builder.py     # NetworkX graph construction
│   ├── clustering.py  # Leiden community detection
│   └── query.py       # Graph traversal for codegraph_query
├── llm/
│   └── batch.py       # Batched Anthropic API calls
├── cache.py           # SHA-256 cache read/write (cache.json)
├── report.py          # REPORT.md generator
├── config.py          # Settings (LLM provider, ignore patterns)
└── codegraph.json     # Per-project config (gitignored cache/)
```

---

## Supported file types

| Category | Extensions | Extraction method |
|---|---|---|
| Python | `.py` | Tree-sitter AST |
| JS / TS | `.js .ts .jsx .tsx .mjs` | Tree-sitter AST |
| Go | `.go` | Tree-sitter AST |
| Rust | `.rs` | Tree-sitter AST |
| Java | `.java` | Tree-sitter AST |
| C / C++ | `.c .cpp .h .hpp` | Tree-sitter AST |
| Ruby | `.rb` | Tree-sitter AST |
| SQL | `.sql` | Regex (tables, FK, indexes) |
| Config | `.yaml .yml .toml .env` | Regex + key extraction |
| Docs | `.md .txt .rst` | Direct text + LLM concepts |
| PDF | `.pdf` | pymupdf → LLM concepts |
| Images | `.png .jpg .svg` | LLM vision |
| Audio | `.mp3 .wav` | faster-whisper local |
| Video | `.mp4 .mov` | faster-whisper local |

---

## Cache strategy (the speed secret)

Every file gets a SHA-256 hash stored in `codegraph-cache/cache.json`:

```json
{
  "src/auth.py": {
    "hash": "a3f9...",
    "nodes": [ ... extracted nodes ... ],
    "extracted_at": "2026-05-13T10:00:00"
  }
}
```

On re-run:
- Hash matches → load nodes from cache instantly, zero API calls
- Hash differs → re-extract, update cache
- File deleted → remove its nodes from graph

Result: a 200-file project where 3 files changed costs exactly the same as extracting 3 files from scratch.

---

## LLM batching strategy

Instead of one API call per file (Graphify's approach), CodeGraph collects all files needing LLM extraction into a single prompt:

```
Extract concepts and relationships from each of these documents.
Return JSON array, one entry per document.

[DOC 1]: auth-design.md
<content>...</content>

[DOC 2]: architecture.pdf (extracted text)
<content>...</content>

[DOC 3]: system-diagram.png
<image>...</image>
```

One round-trip, results cached. On a project with 50 docs where 4 changed, that's 1 API call vs 4.

---

## MCP config (how users connect it)

Users add this to their MCP config file (works in Claude Code, Cursor, Gemini CLI, any MCP client):

```json
{
  "mcpServers": {
    "codegraph": {
      "command": "python",
      "args": ["-m", "codegraph.server"],
      "cwd": "/path/to/your/project"
    }
  }
}
```

Then in any AI assistant: "build the knowledge graph" → calls `codegraph_build`. "What does the payment module depend on?" → calls `codegraph_query`. No platform-specific hook files, no CLAUDE.md sections, no `.cursor/rules/`.

---

## Output files

### `REPORT.md`
- God nodes (highest-degree concepts everything flows through)
- Community clusters (groups of closely related files/concepts)
- Surprising cross-module connections
- 5 suggested questions the graph can answer
- Confidence tags on every inferred relationship (EXTRACTED / INFERRED / AMBIGUOUS)

### `graph.json`
```json
{
  "nodes": [
    { "id": "AuthService", "type": "class", "file": "src/auth.py", "community": 2 }
  ],
  "edges": [
    { "from": "AuthService", "to": "UserModel", "relation": "imports", "confidence": "EXTRACTED" }
  ],
  "communities": [
    { "id": 2, "label": "Authentication", "members": ["AuthService", "TokenValidator"] }
  ],
  "god_nodes": ["AuthService", "DatabasePool"],
  "generated_at": "2026-05-13T10:00:00"
}
```

---

## Build order (what to code first)

1. `cache.py` — file hashing + cache read/write
2. `scanner.py` — walk directory, detect changed files
3. `extractors/ast_extractor.py` — Tree-sitter for Python + JS
4. `graph/builder.py` — NetworkX graph from extracted nodes
5. `server.py` — MCP server with `codegraph_build` + `codegraph_query`
6. `graph/query.py` — graph traversal answering natural language questions
7. `report.py` — REPORT.md generator
8. `extractors/doc_extractor.py` — PDF + markdown
9. `llm/batch.py` — batched LLM extraction
10. `extractors/image_extractor.py` — vision for diagrams
11. `extractors/audio_extractor.py` — faster-whisper
12. `graph/clustering.py` — Leiden community detection

---

## Dependencies

```
# Core
mcp                    # MCP server SDK
networkx               # Graph data structure
tree-sitter            # AST parsing
tree-sitter-python     # Language grammar
tree-sitter-javascript # Language grammar
tree-sitter-typescript # Language grammar
# ... other grammars

# Extraction
pymupdf                # PDF text extraction
faster-whisper         # Local audio/video transcription
anthropic              # Batched LLM calls (optional, only for docs/images)
Pillow                 # Image preprocessing

# Utils
python-leiden          # Community clustering
hashlib                # stdlib, no install needed
```

---

*CodeGraph — one MCP server, any AI assistant, zero per-platform setup.*
