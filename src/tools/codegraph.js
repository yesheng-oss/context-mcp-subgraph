/**
 * src/tools/codegraph.js — CodeGraph tools bridged to Python subprocess.
 * Spawns `uv run python -m codegraph` with JSON on stdin, reads JSON from stdout.
 */

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveGraph, saveContext, updateContext, getContext, flushToDisk } from '../db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT  = join(__dirname, '..', '..');

function callPython(tool, args) {
  const result = spawnSync('uv', ['run', 'python', '-m', 'codegraph'], {
    input:    JSON.stringify({ tool, args }),
    encoding: 'utf8',
    cwd:      REPO_ROOT,
    timeout:  120_000,
  });
  if (result.error) throw new Error(`codegraph subprocess failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(result.stderr?.trim() || 'codegraph error');
  const out = result.stdout.trim();
  if (!out) throw new Error('codegraph returned no output');
  return JSON.parse(out);
}

export const definitions = [
  {
    name: 'codegraph_build',
    description:
      'Scan a project directory and build the knowledge graph from code files. ' +
      'Uses AST extraction for code files. For docs and PDFs, call codegraph_extract ' +
      'afterward — the AI reads and extracts concepts, then calls codegraph_add_nodes.',
    inputSchema: {
      type: 'object',
      properties: {
        path:    { type: 'string', description: 'Absolute path to project root' },
        cluster: { type: 'boolean', description: 'Run community detection after build (default true)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'codegraph_query',
    description:
      'Ask a structural question about the codebase OR look up a specific node by name — or both in one call. ' +
      'Pass `question` for natural-language traversal: "what does module X depend on?", "what calls function Y?". ' +
      'Pass `node` for fast single-node lookup: returns type, file, depends_on, used_by. ' +
      'Pass both to get node detail + surrounding graph context together. ' +
      'Returns structured text within token_budget. Use before reading any files.',
    inputSchema: {
      type: 'object',
      properties: {
        path:         { type: 'string', description: 'Project root' },
        question:     { type: 'string', description: 'Natural language question about the codebase' },
        node:         { type: 'string', description: 'Node name or partial name to look up (type, file, deps, callers)' },
        token_budget: { type: 'integer', description: 'Max tokens in response (default 2000)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'codegraph_report',
    description: 'Return CODEGRAPH_REPORT.md — god nodes, clusters, surprising connections, suggested questions.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'codegraph_context',
    description:
      'Build a bounded, token-budgeted context subgraph for an AI coding task. ' +
      'Finds query-matching seed nodes, expands callers/dependencies/imports up to max_hops, ' +
      'ranks candidates, and returns compact nodes, relationship paths, budget usage, and dropped counts.',
    inputSchema: {
      type: 'object',
      properties: {
        path:         { type: 'string', description: 'Project root' },
        question:     { type: 'string', description: 'Current code task or architecture question' },
        max_hops:     { type: 'integer', description: 'Maximum graph expansion depth (default 2, max 5)' },
        top_k:        { type: 'integer', description: 'Maximum query seed nodes (default 5)' },
        token_budget: { type: 'integer', description: 'Maximum approximate tokens for nodes and edges' },
      },
      required: ['path'],
    },
  },
  {
    name: 'codegraph_nodes',
    description:
      'List all nodes of a given type, sorted by PageRank (most connected first). ' +
      'type must be one of: class, function, module, concept, service, file, struct, table. ' +
      'Each node includes signature, return_type, side_effect, exported, docstring. ' +
      'Pass token_budget to get the highest-rank nodes within a token limit.',
    inputSchema: {
      type: 'object',
      properties: {
        path:         { type: 'string' },
        type:         { type: 'string', enum: ['class', 'function', 'module', 'concept', 'service', 'file', 'struct', 'table'] },
        limit:        { type: 'integer', description: 'Max results (default 50)' },
        token_budget: { type: 'integer', description: 'Return highest-rank nodes within this token budget' },
      },
      required: ['path', 'type'],
    },
  },
  {
    name: 'codegraph_arch',
    description:
      'Return a module map of the project — every file with its exported functions/classes and its imports. ' +
      'Use this to understand project structure without reading any files. ' +
      'Call after codegraph_build. Much faster than reading each file individually.',
    inputSchema: {
      type: 'object',
      properties: {
        path:  { type: 'string', description: 'Project root' },
        limit: { type: 'integer', description: 'Max files in output (default 100)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'codegraph_affected',
    description:
      'BFS traversal: given a node name, find every node that would be affected if you change it — ' +
      'callers, importers, inheritors, etc. Use before refactoring to understand blast radius. ' +
      'Returns affected nodes with file paths, relation types, and traversal depth.',
    inputSchema: {
      type: 'object',
      properties: {
        path:  { type: 'string', description: 'Project root' },
        node:  { type: 'string', description: 'Node name, ID, or file path to start from' },
        depth: { type: 'integer', description: 'BFS depth (default 2, max 5)' },
      },
      required: ['path', 'node'],
    },
  },
  {
    name: 'codegraph_filter',
    description:
      'Filter graph nodes by semantic properties — all filters are optional and combinable. ' +
      'Results sorted by PageRank (most connected first). ' +
      'Use to answer questions like "show me all exported async functions with side effects" or ' +
      '"which classes implement IService?" without reading any files.',
    inputSchema: {
      type: 'object',
      properties: {
        path:         { type: 'string', description: 'Project root' },
        node_type:    { type: 'string', enum: ['function', 'class', 'module', 'file'], description: 'Filter by node type' },
        exported:     { type: 'boolean', description: 'Only exported nodes' },
        side_effect:  { type: 'boolean', description: 'Filter by side-effect presence' },
        return_type:  { type: 'string', description: 'Substring match on return type annotation' },
        called_by:    { type: 'string', description: 'Only nodes called/imported by this name' },
        calls:        { type: 'string', description: 'Only nodes that call this name' },
        file_pattern: { type: 'string', description: 'Glob pattern for file path (e.g. "src/auth/**")' },
        limit:        { type: 'integer', description: 'Max results (default 20)' },
        token_budget: { type: 'integer', description: 'Max tokens in response' },
      },
      required: ['path'],
    },
  },
  {
    name: 'codegraph_html',
    description:
      'Generate interactive visualizations from the knowledge graph. ' +
      'Outputs: graph.html (vis.js force graph, dark theme, search, community toggle), ' +
      'tree.html (D3 collapsible file tree), callflow.html (Mermaid architecture diagrams), ' +
      'graph.graphml (Gephi/yEd), obsidian/ vault (per-node .md with wikilinks). ' +
      'Run after codegraph_build. Pass formats array to select specific outputs.',
    inputSchema: {
      type: 'object',
      properties: {
        path:    { type: 'string', description: 'Project root' },
        formats: {
          type: 'array',
          items: { type: 'string', enum: ['html', 'tree', 'callflow', 'graphml', 'obsidian'] },
          description: 'Formats to generate (default: all)',
        },
      },
      required: ['path'],
    },
  },
];

export const TOOL_NAMES = new Set(definitions.map(d => d.name));

export function handle(name, args, state) {
  const result = callPython(name, args);

  // Persist graph metadata + save/update a context entry as a visible build record
  if (name === 'codegraph_build' && result.success) {
    saveGraph({
      path:        args.path,
      nodes:       result.nodes,
      edges:       result.edges,
      communities: result.communities,
      cached:      result.cached,
      changed:     result.changed,
      time_ms:     result.time_ms,
      summary:     result.summary || '',
    });
    flushToDisk(); // write graph.json to disk immediately so ctx list sees it

    const inferredProject = args.path
      ? args.path.replace(/\\/g, '/').replace(/\/$/, '').split('/').pop()
      : null;
    const project = state?.sessionProject || inferredProject || null;
    const title   = `ContextGraph built — ${args.path}`;
    const content = [
      `nodes: ${result.nodes} | edges: ${result.edges} | communities: ${result.communities}`,
      `cached: ${result.cached} | changed: ${result.changed} | time: ${result.time_ms}ms`,
      result.summary || '',
    ].filter(Boolean).join('\n');

    // Search all projects — same path always produces same title regardless of session
    const existing = getContext({ tags: ['codegraph'], limit: 100 })
      .find(e => e.title === title);

    if (existing) {
      updateContext({ id: existing.id, content, status: 'active' });
    } else {
      saveContext({
        project,
        sessionId: state?.sessionId || null,
        title,
        content,
        type:   'note',
        source: 'auto',
        tags:   ['codegraph', 'graph-build'],
      });
    }
  }

  return result;
}
