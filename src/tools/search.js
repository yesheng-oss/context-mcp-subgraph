import { search as unifiedSearch } from '../search.js';

export const definition = {
  name: 'search',
  description:
    `Search across all saved context. Three modes:\n` +
    `• "semantic" (default) — TF-IDF similarity. Best for natural language queries.\n` +
    `• "keyword" — Exact keyword matching. Best for specific terms.\n` +
    `• "related" — Find entries similar to a given entry ID.`,
  inputSchema: {
    type: 'object',
    properties: {
      query:   { type: 'string' },
      mode:    { type: 'string', enum: ['keyword', 'semantic', 'related'] },
      project: { type: 'string' },
      limit:   { type: 'number' },
      id:      { type: 'string', description: '[related mode] entry ID' },
    },
  },
  outputSchema: {
    type: 'object',
    properties: {
      matches: { type: 'array' },
      count:   { type: 'number' },
      mode:    { type: 'string' },
      message: { type: 'string' },
      source:  { type: 'string' },
      related: { type: 'array' },
    },
  },
};

export async function handle(args, _state) {
  const mode  = args.mode || 'semantic';
  const limit = args.limit || (mode === 'related' ? 5 : 10);

  if (mode === 'related') {
    const { target, results } = unifiedSearch({ mode, id: args.id, limit });
    return { source: target.title, related: results, count: results.length, mode };
  }

  const raw = unifiedSearch({ mode, query: args.query, project: args.project, limit });
  const matches = raw.map(e => ({
    id: e.id, project: e.project, title: e.title || '',
    tags: e.tags, createdAt: e.createdAt,
    similarity: e.similarity,
    // ponytail: preview omitted — call context.get id:[...] for full content
  }));
  return {
    matches, count: matches.length, mode,
    message: matches.length
      ? `${matches.length} ${mode} result(s) for "${args.query}".`
      : `No results for "${args.query}".`,
  };
}
