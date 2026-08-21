/**
 * get_symbol_detail — return source code for a single function/class by name.
 * Uses codegraph_query to locate the symbol, then reads only the relevant lines.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { handle as codegraphHandle } from './codegraph.js';

export const definition = {
  name: 'get_symbol_detail',
  description:
    'Return the source code and location for a single function, class, or method by name. ' +
    'Use instead of reading the whole file — much cheaper. Requires codegraph to be built. ' +
    'Pass file to narrow when multiple symbols share the same name.',
  inputSchema: {
    type: 'object',
    required: ['name'],
    properties: {
      name: { type: 'string', description: 'Symbol name (function, class, method)' },
      file: { type: 'string', description: 'Optional: narrow by file path (partial match ok)' },
      path: { type: 'string', description: 'Project root path (required if codegraph was built for a specific path)' },
      context_lines: { type: 'number', description: 'Extra lines to include above/below (default 3)' },
    },
  },
};

export async function handle(args, state) {
  const { name, file, context_lines = 3 } = args;
  const rootPath = args.path || state.projectRootPath;
  if (!rootPath) throw new Error('path or projectRootPath required');

  // Ask codegraph for the node location
  const queryResult = codegraphHandle('codegraph_query', { path: rootPath, node: name }, state);

  // Find the node matching name (and optionally file)
  const nodes = queryResult?.nodes || queryResult?.results || [];
  let match = nodes.find(n =>
    n.name === name && (!file || (n.file || '').includes(file))
  );
  if (!match && nodes.length === 1) match = nodes[0];
  if (!match) {
    return {
      found: false,
      message: `Symbol "${name}" not found in graph. Run codegraph_build first, or check spelling.`,
      candidates: nodes.slice(0, 5).map(n => ({ name: n.name, file: n.file, type: n.type })),
    };
  }

  // Read the source file around the symbol's line
  const absFile = join(rootPath, match.file);
  let source;
  try {
    source = readFileSync(absFile, 'utf8');
  } catch {
    return { found: true, ...match, error: `Could not read file: ${absFile}` };
  }

  const lines = source.split('\n');
  const startLine = Math.max(0, (match.line || 1) - 1 - context_lines);
  // Heuristic: read up to 80 lines or until we find the closing brace/dedent
  const endLine = Math.min(lines.length, startLine + 80 + context_lines);
  const snippet = lines.slice(startLine, endLine).join('\n');

  return {
    found: true,
    name: match.name,
    type: match.type,
    file: match.file,
    line: match.line,
    source: snippet,
    hint: `Lines ${startLine + 1}–${endLine} of ${match.file}. Use read_file for the full file.`,
  };
}
