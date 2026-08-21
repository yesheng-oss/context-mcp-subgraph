/**
 * tool_registry + safety_policy — static metadata about every MCP tool.
 * No DB queries. Pure JSON describing side-effects and approval requirements.
 */

const REGISTRY = [
  // Core memory tools
  { name: 'context',           side_effects: 'Writes to ~/.context-mcp on save/update/delete', requires_approval: false },
  { name: 'search',            side_effects: 'none',                                            requires_approval: false },
  { name: 'plan',              side_effects: 'Writes plan files to planDir on save/update',     requires_approval: false },
  { name: 'error_check',       side_effects: 'Writes to ~/.context-mcp on save',                requires_approval: false },
  // Graph tools
  { name: 'codegraph_build',   side_effects: 'Writes codegraph-cache/ in project root',         requires_approval: false },
  { name: 'codegraph_query',   side_effects: 'none',                                            requires_approval: false },
  { name: 'codegraph_context', side_effects: 'none',                                            requires_approval: false },
  { name: 'codegraph_arch',    side_effects: 'none',                                            requires_approval: false },
  { name: 'codegraph_nodes',   side_effects: 'none',                                            requires_approval: false },
  { name: 'codegraph_report',  side_effects: 'Writes CODEGRAPH_REPORT.md in project root',      requires_approval: false },
  { name: 'codegraph_affected',side_effects: 'none',                                            requires_approval: false },
  { name: 'codegraph_html',    side_effects: 'Writes HTML/GraphML files to codegraph-cache/',   requires_approval: false },
  { name: 'get_symbol_detail', side_effects: 'none',                                            requires_approval: false },
  // File tools (HTTP mode only)
  { name: 'read_file',         side_effects: 'none',                                            requires_approval: false },
  { name: 'list_dir',          side_effects: 'none',                                            requires_approval: false },
  { name: 'write_file',        side_effects: 'Creates or overwrites a file',                    requires_approval: true  },
  { name: 'patch_file',        side_effects: 'Modifies an existing file',                       requires_approval: true  },
  { name: 'create_dir',        side_effects: 'Creates a directory',                             requires_approval: false },
  { name: 'delete_file',       side_effects: 'Permanently deletes a file or directory',         requires_approval: true  },
  // Git tools (ACCESS_GIT=true only)
  { name: 'git_status',        side_effects: 'none',                                            requires_approval: false },
  { name: 'git_diff',          side_effects: 'none',                                            requires_approval: false },
  { name: 'git_log',           side_effects: 'none',                                            requires_approval: false },
  { name: 'git_show',          side_effects: 'none',                                            requires_approval: false },
  { name: 'git_add',           side_effects: 'Stages files for commit',                         requires_approval: false },
  { name: 'git_commit',        side_effects: 'Creates a git commit',                            requires_approval: true  },
  { name: 'git_push',          side_effects: 'Pushes commits to remote — IRREVERSIBLE',         requires_approval: true  },
  { name: 'git_pull',          side_effects: 'Modifies working tree',                           requires_approval: true  },
  { name: 'git_branch',        side_effects: 'May create or switch branches',                   requires_approval: false },
  { name: 'git_stash',         side_effects: 'Modifies stash stack',                            requires_approval: false },
  { name: 'git_reset',         side_effects: 'Modifies staging area or HEAD — use with care',   requires_approval: true  },
];

const SAFETY_POLICY = {
  description: 'Actions that require explicit user confirmation before execution.',
  requires_confirmation: REGISTRY.filter(t => t.requires_approval).map(t => t.name),
  rules: [
    'Always confirm before git_push — pushes affect the remote and are hard to undo.',
    'Always confirm before delete_file — no recycle bin.',
    'Always confirm before git_reset if mode is hard — discards uncommitted work.',
    'Always confirm before write_file on files that look like credentials or config.',
  ],
};

export const definitions = [
  {
    name: 'tool_registry',
    description:
      'Lists every MCP tool with its side effects and whether it requires user approval. ' +
      'Read this before calling any destructive tool to understand the risk.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'safety_policy',
    description:
      'Lists which operations require explicit user confirmation before execution ' +
      '(git_push, git_reset, delete_file, write_file, git_commit, patch_file). ' +
      'Read before performing any irreversible action.',
    inputSchema: { type: 'object', properties: {} },
  },
];

export const TOOL_NAMES = new Set(definitions.map(d => d.name));

export function handle(name) {
  if (name === 'tool_registry') return { tools: REGISTRY, count: REGISTRY.length };
  if (name === 'safety_policy') return SAFETY_POLICY;
  throw new Error(`Unknown tool: ${name}`);
}
