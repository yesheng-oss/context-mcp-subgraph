import { execFileSync } from 'node:child_process';
import { guardPath } from '../guard.js';
import {
  saveContext, updateContext, getContext, deleteContext,
  listProjects, findDuplicate, archiveExpired, linkContextToDiscussion,
  listDiscussions, listGraphs, countContext, shouldCompact, compactProject,
  ensureProject, getProjectRoot,
} from '../db.js';

function detectGitRoot() {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: process.cwd(), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch { return null; }
}
import { summarizeEntries } from '../summarizer.js';
import { fireAutoLink } from '../hooks/autoLink.js';

function autoDigest(entries, project) {
  if (entries.length <= 10) return null;
  return summarizeEntries(entries, { project: project || 'global', topN: 5 });
}

export const definition = {
  name: 'context',
  description:
    `Factual memory — decisions, bugs, notes, discoveries.\n` +
    `• "resume"       — call first every session. Returns recent entries, active plans, graph status.\n` +
    `• "save"         — store an entry. Auto-deduplicates by content similarity.\n` +
    `• "get"          — fetch by id/ids, or filter by project/tags/limit.\n` +
    `• "update"       — edit an entry by id.\n` +
    `• "delete"       — remove one entry (id) or several (ids: [...]).\n` +
    `• "list_projects"— list all projects and entry counts.`,
  inputSchema: {
    type: 'object',
    properties: {
      action:        { type: 'string', enum: ['resume', 'save', 'get', 'update', 'delete', 'list_projects'] },
      content:       { type: 'string' },
      title:         { type: 'string', description: 'Up to 120 chars' },
      why:           { type: 'string', description: 'Why it mattered' },
      outcome:       { type: 'string', description: 'What the result was' },
      project:       { type: 'string' },
      rootPath:      { type: 'string', description: 'Absolute path to the project root directory. Stored on first call and used to sandbox file/git tool access.' },
      type:          { type: 'string', enum: ['note', 'compaction'] },
      status:        { type: 'string', enum: ['active', 'archived'] },
      tags:          { type: 'array', items: { type: 'string' } },
      source:        { type: 'string', enum: ['user', 'ai-summary', 'file', 'web', 'cli', 'auto'] },
      files:         { type: 'array', items: { type: 'object' } },
      codeRefs:      { type: 'array', items: { type: 'object' } },
      expiresAt:     { type: 'string' },
      limit:         { type: 'number' },
      includeArchived: { type: 'boolean' },
      id:            { type: 'string', description: 'Single entry ID' },
      ids:           { type: 'array', items: { type: 'string' }, description: 'Multiple entry IDs' },
    },
    required: ['action'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success:  { type: 'boolean' },
      id:       { type: 'string' },
      message:  { type: 'string' },
      entries:  { type: 'array' },
      count:    { type: 'number' },
      digest:   { type: 'string' },
      projects: { type: 'array' },
      storePath:{ type: 'string' },
    },
  },
};

export async function handle(args, state) {
  const { getStorePath } = await import('../db.js');

  switch (args.action) {

    case 'resume': {
      const proj = args.project || null;
      archiveExpired(proj);

      if (proj) state.sessionProject = proj;

      const storedRoot = proj ? getProjectRoot(proj) : null;
      const resolvedRoot = args.rootPath || storedRoot || detectGitRoot() || null;
      if (proj) ensureProject(proj, resolvedRoot || undefined);
      state.projectRootPath = resolvedRoot;

      const rawEntries    = getContext({ project: proj, limit: 15, compact: false })
        .filter(e => e.status !== 'archived');
      // Full content only for: newest 2, or high-signal entries (why+outcome+files)
      // ponytail: avoids dumping 5 full auto-entries (graph builds, etc.) every resume
      const entries = rawEntries.map((e, i) => {
        const isHighSignal = e.why && e.outcome && Array.isArray(e.files) && e.files.length > 0;
        if (i < 2 || isHighSignal) return e;
        return {
          id: e.id, project: e.project, title: e.title, type: e.type,
          status: e.status, tags: e.tags, source: e.source,
          createdAt: e.createdAt, updatedAt: e.updatedAt,
          preview: (e.content || '').slice(0, 200),
        };
      });
      const discussions   = listDiscussions({ project: proj, status: 'active' });
      const allGraphs     = listGraphs();
      const np = p => (p || '').toLowerCase().replace(/\\/g, '/');
      const graph         = resolvedRoot
        ? allGraphs.find(g => np(g.path) === np(resolvedRoot)) || null
        : proj
          ? allGraphs.find(g => {
              const parts = np(g.path).split('/');
              return parts[parts.length - 1] === proj.toLowerCase();
            }) || null
          : null;
      const totalEntries  = countContext(proj);

      if (discussions.length === 1) state.discussionId = discussions[0].id;

      const digest = totalEntries > 25
        ? autoDigest(getContext({ project: proj, limit: 30 }), proj)
        : null;

      const graphStatus = graph
        ? { built: true, path: graph.path, nodes: graph.nodes, edges: graph.edges, builtAt: graph.builtAt }
        : { built: false };

      return {
        recentEntries:      entries,
        activePlans:        discussions,
        restoredDiscussion: discussions.length === 1 ? { id: discussions[0].id, name: discussions[0].name } : null,
        codegraph:          graphStatus,
        digest:             digest || undefined,
        stats:              { totalEntries, projects: listProjects().length },
        message: `Loaded ${totalEntries} entries for project "${proj || 'global'}".${discussions.length === 1 ? ` Auto-linked to discussion "${discussions[0].name}".` : ''}`,
        rootPath: state.projectRootPath || undefined,
        sandbox: state.projectRootPath
          ? `All file and git operations are sandboxed to: ${state.projectRootPath} — do not use paths outside this root.`
          : 'No project root configured — pass rootPath to restrict file/git access to a directory.',
        hint: graphStatus.built
          ? `Graph ready (${graphStatus.nodes} nodes). Use codegraph_arch for module map, codegraph_query for specific symbol lookups.`
          : 'No graph built yet. Call codegraph_build on the project root to enable graph queries.',
      };
    }

    case 'save': {
      if (!args.content) throw new Error('content is required for save');
      if (!args.project && state.sessionProject) args = { ...args, project: state.sessionProject };
      if (args.project) {
        const existing = getProjectRoot(args.project);
        if (!existing) {
          const detected = state.projectRootPath || detectGitRoot();
          if (detected) {
            ensureProject(args.project, detected);
            if (!state.projectRootPath) state.projectRootPath = detected;
          }
        }
      }
      if (state.projectRootPath) {
        if (Array.isArray(args.files)) {
          args.files.forEach(f => { if (f.path) guardPath(f.path, state.projectRootPath); });
        }
        if (Array.isArray(args.codeRefs)) {
          args.codeRefs.forEach(r => { if (r.file) guardPath(r.file, state.projectRootPath); });
        }
      }

      const dupe = findDuplicate(args.content, args.project);
      if (dupe) {
        const updated = updateContext({
          id: dupe.id, content: args.content,
          title: args.title || dupe.title, tags: args.tags || dupe.tags,
          type: args.type || dupe.type, status: args.status || dupe.status,
          why: args.why !== undefined ? args.why : dupe.why,
          outcome: args.outcome !== undefined ? args.outcome : dupe.outcome,
          expiresAt: args.expiresAt !== undefined ? args.expiresAt : dupe.expiresAt,
          files: args.files || dupe.files, codeRefs: args.codeRefs || dupe.codeRefs,
        });
        fireAutoLink(updated.id, state);
        return { success: true, id: updated.id, deduplicated: true,
          message: `Updated existing entry "${updated.title || updated.id}" (auto-dedup).` };
      }
      const entry = saveContext({ ...args, rootPath: state.projectRootPath || undefined });
      fireAutoLink(entry.id, state);

      // Auto-compact when too many entries accumulate.
      // If the AI just saved a compaction entry, use that content as the summary
      // instead of running TF-IDF on top of it.
      let compaction = null;
      if (shouldCompact(entry.project)) {
        if (entry.type === 'compaction') {
          // AI wrote a proper summary — compact old entries without creating a duplicate summary
          compaction = compactProject(entry.project, entry.content, { skipSummaryEntry: true });
        } else {
          // AI didn't write a summary — fall back to TF-IDF extractive summarization.
          // getContext returns newest-first; summarizeEntries groups/scores by content
          // regardless of order, so pass everything being compacted, not a slice of it.
          // (Previously `old.slice(old.length - 30)` computed a negative start whenever
          // old.length < 30 — e.g. length 25 became slice(-5), summarizing only the 5
          // oldest entries instead of all of them.)
          const old = getContext({ project: entry.project, limit: 500 });
          const { summarizeEntries: summarize } = await import('../summarizer.js');
          const summaryContent = summarize(old, { project: entry.project || 'global', sessionLabel: 'auto-compaction', topN: 5 });
          compaction = compactProject(entry.project, summaryContent);
        }
      }

      return { success: true, id: entry.id, deduplicated: false,
        compaction: compaction ? { removedCount: compaction.removedCount, message: `Auto-compacted ${compaction.removedCount} old entries into summary.` } : null,
        message: `Saved context "${entry.title || entry.id}" under project "${entry.project}".` };
    }

    case 'get': {
      if (!args.project && state.sessionProject) args = { ...args, project: state.sessionProject };
      const includeArchived = args.includeArchived === true;

      // Fetch by specific ID(s) — bypass project/tag/limit filters
      const ids = args.ids || (args.id ? [args.id] : null);
      if (ids) {
        const entries = getContext({ ids, compact: false })
          .filter(e => includeArchived || e.status !== 'archived');
        return {
          entries, count: entries.length,
          message: entries.length ? `Found ${entries.length} entries.` : 'No entries found for given IDs.',
        };
      }

      archiveExpired(args.project);
      let entries = getContext({ project: args.project, tags: args.tags, limit: args.limit, compact: true });
      if (!includeArchived) entries = entries.filter(e => e.status !== 'archived');
      const fullEntries = entries.length > 10
        ? getContext({ project: args.project, tags: args.tags, limit: args.limit })
            .filter(e => includeArchived || e.status !== 'archived')
        : null;
      const digest = fullEntries ? autoDigest(fullEntries, args.project) : null;
      return {
        entries, count: entries.length, digest: digest || undefined,
        message: entries.length
          ? `Found ${entries.length} entries.${digest ? ' Auto-digest included.' : ''} Use search for full content.`
          : 'No context found.',
      };
    }

    case 'update': {
      if (!args.id) throw new Error('id is required for update');
      const updated = updateContext({ ...args });
      if (!updated) throw new Error(`No entry found with id "${args.id}"`);
      fireAutoLink(updated.id, state);
      return { success: true, id: updated.id, version: updated.version,
        message: `Updated entry "${updated.title || updated.id}" (v${updated.version}).` };
    }

    case 'delete': {
      if (!args.id && !args.ids) throw new Error('id or ids is required for delete');
      const result = deleteContext(args);
      return { ...result, message: `Deleted ${result.deleted} entr${result.deleted === 1 ? 'y' : 'ies'}.` };
    }

    case 'list_projects': {
      return { projects: listProjects(), storePath: getStorePath() };
    }

    default:
      throw new Error(`Unknown context action: ${args.action}`);
  }
}
