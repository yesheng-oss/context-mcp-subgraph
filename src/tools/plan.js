import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  saveDiscussion, getDiscussion, listDiscussions,
  deleteDiscussion, updateDiscussion,
} from '../db.js';

function writePlanFile(planDir, name, content, title) {
  if (!planDir) return null;
  const dir = resolve(planDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const filePath = join(dir, `${slug}.md`);
  const md = `# ${title || name}\n\n${content || ''}\n`;
  writeFileSync(filePath, md, 'utf8');
  return filePath;
}

export const definition = {
  name: 'plan',
  description:
    `Plan storage — saves to project store, optionally writes a .md file to planDir.\n` +
    `• "save"   — store a new plan or overwrite by name.\n` +
    `• "update" — patch title/content/status.\n` +
    `• "get"    — retrieve a plan by name or id.\n` +
    `• "list"   — list all plans for the project.\n` +
    `• "delete" — remove a plan by name or id.`,
  inputSchema: {
    type: 'object',
    properties: {
      action:  { type: 'string', enum: ['save', 'get', 'list', 'update', 'delete'] },
      name:    { type: 'string', description: 'Short slug-style identifier for the plan, e.g. "auth-refactor"' },
      id:      { type: 'string' },
      project: { type: 'string' },
      title:   { type: 'string', description: 'Plan title' },
      content: { type: 'string', description: 'Full plan summary in markdown' },
      status:  { type: 'string', enum: ['active', 'done'] },
      tags:    { type: 'array', items: { type: 'string' } },
      planDir: { type: 'string', description: 'Absolute path to the folder where .md plan files are written. Pass the path for your AI platform (e.g. ~/.claude/plans/ for Claude Code).' },
    },
    required: ['action'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success:  { type: 'boolean' },
      id:       { type: 'string' },
      name:     { type: 'string' },
      filePath: { type: 'string' },
      plan:     { type: 'object' },
      plans:    { type: 'array' },
      message:  { type: 'string' },
    },
  },
};

export async function handle(args, state) {
  if (!args.project && state.sessionProject) args = { ...args, project: state.sessionProject };

  switch (args.action) {
    case 'save': {
      if (!args.name)    throw new Error('name is required for save');
      if (!args.content) throw new Error('content is required for save');
      const plan = saveDiscussion({
        name:        args.name,
        title:       args.title || args.name,
        content:     args.content,
        project:     args.project,
        tags:        args.tags,
        type:        'plan',
        status:      args.status || 'active',
        sessionId:   state.sessionId || null,
      });
      if (plan.status === 'active') state.discussionId = plan.id;
      const filePath = writePlanFile(args.planDir, args.name, args.content, args.title);
      return {
        success: true, id: plan.id, name: plan.name,
        filePath: filePath || undefined,
        message: `Plan "${plan.name}" saved.${filePath ? ` Written to ${filePath}` : ''}`,
      };
    }

    case 'update': {
      if (!args.name && !args.id) throw new Error('name or id is required for update');
      if (args.status === 'done') {
        const result = deleteDiscussion({ name: args.name, id: args.id });
        state.discussionId = null;
        return { success: true, message: `Plan "${args.name || args.id}" completed and removed.` };
      }
      const updated = updateDiscussion({
        name:    args.name,
        id:      args.id,
        title:   args.title,
        content: args.content,
        status:  args.status,
        tags:    args.tags,
      });
      if (!updated) throw new Error(`No plan found for "${args.name || args.id}".`);
      if (updated.status === 'active') state.discussionId = updated.id;
      const filePath = writePlanFile(args.planDir, updated.name, updated.content, updated.title);
      return {
        success: true, id: updated.id, name: updated.name,
        filePath: filePath || undefined,
        message: `Plan "${updated.name}" updated.`,
      };
    }

    case 'get': {
      if (!args.name && !args.id) throw new Error('name or id is required for get');
      const plan = getDiscussion({ name: args.name, id: args.id, project: args.project });
      return plan
        ? { plan }
        : { plan: null, message: `No plan found for "${args.name || args.id}".` };
    }

    case 'list': {
      const plans = listDiscussions({ project: args.project, status: args.status });
      return { plans };
    }

    case 'delete': {
      if (!args.name && !args.id) throw new Error('name or id is required for delete');
      const result = deleteDiscussion({ name: args.name, id: args.id });
      if (state.discussionId && (args.id === state.discussionId || result.deleted > 0)) {
        state.discussionId = null;
      }
      return { ...result, message: `Deleted ${result.deleted} plan(s).` };
    }

    default:
      throw new Error(`Unknown plan action: ${args.action}`);
  }
}
