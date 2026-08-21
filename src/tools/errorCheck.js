import { saveContext, getContext } from '../db.js';
import { search as unifiedSearch } from '../search.js';
import { fireAutoLink } from '../hooks/autoLink.js';

export const definition = {
  name: 'error_check',
  description:
    `Diagnose and track terminal errors.\n` +
    `• action "check" — Search memory for past occurrences of this error.\n` +
    `• action "save"  — Record a new error, the command that caused it, and the solution.`,
  inputSchema: {
    type: 'object',
    properties: {
      action:       { type: 'string', enum: ['check', 'save'] },
      errorMessage: { type: 'string' },
      command:      { type: 'string' },
      solution:     { type: 'string' },
      project:      { type: 'string' },
    },
    required: ['action', 'errorMessage'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      found:   { type: 'boolean' },
      matches: { type: 'array' },
      message: { type: 'string' },
    },
  },
};

export async function handle(args, state) {
  const { action, errorMessage, command, solution, project } = args;

  if (action === 'check') {
    const results = unifiedSearch({ mode: 'semantic', query: errorMessage, project, limit: 5 })
      .filter(r => Array.isArray(r.tags) && r.tags.includes('error-log'));
    if (results.length > 0 && results[0].similarity > 0.4) {
      return {
        success: true, found: true,
        matches: results.map(r => ({ title: r.title, solution: r.content, similarity: Math.round(r.similarity * 100) + '%', id: r.id })),
        message: `Found ${results.length} similar past error(s).`,
      };
    }
    return { success: true, found: false, message: 'No similar past errors found in memory.' };
  }

  if (action === 'save') {
    if (!solution) throw new Error('solution is required for save action');
    const entry = saveContext({
      project,
      sessionId: state.sessionId || null,
      title:   `Error: ${errorMessage.split('\n')[0].slice(0, 60)}`,
      content: `Command: ${command || 'unknown'}\n\nError:\n${errorMessage}\n\nSolution:\n${solution}`,
      type:    'note',
      status:  'active',
      tags:    ['error-log', command].filter(Boolean),
    });
    fireAutoLink(entry.id, state);
    return { success: true, message: `Error logged to context (id: ${entry.id.slice(0, 8)}).` };
  }

  throw new Error(`Unknown error_check action: ${action}`);
}
