import { execFileSync } from 'node:child_process';
import { resolve as pathResolve } from 'node:path';
import { saveAutoContext } from '../hooks/autoContext.js';
import { guardPath } from '../guard.js';

const MAX_DIFF_LENGTH = 10000;

function runGit(argArr, cwd) {
  const dir = cwd || process.cwd();
  try {
    return execFileSync('git', argArr, { cwd: dir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    const msg = ((err.stderr || '') + (err.stdout || '') || err.message || '').trim();
    throw new Error(`git ${argArr[0]} failed: ${msg}`);
  }
}

function autoDetectRoot(fromDir) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: fromDir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

function resolveCwd(args, state) {
  if (!state.projectRootPath) {
    throw new Error('No project root configured. Call context.resume with rootPath before using git tools.');
  }
  const raw = args.cwd ? pathResolve(args.cwd) : state.projectRootPath;
  return guardPath(raw, state.projectRootPath);
}

const ROOT_NOTE = ' All paths must be within the project root (sandboxed — access outside root is denied).';

export const definitions = [
  {
    name: 'git_status',
    description: 'Show working tree status — current branch, staged, unstaged, and untracked files.' + ROOT_NOTE,
    inputSchema: { type: 'object', properties: { cwd: { type: 'string' } } },
    outputSchema: { type: 'object', properties: { branch: { type: 'string' }, clean: { type: 'boolean' }, staged: { type: 'array' }, unstaged: { type: 'array' }, untracked: { type: 'array' } } },
  },
  {
    name: 'git_diff',
    description: 'Show file changes. Use staged:true for cached diff. Optionally scope to a path.' + ROOT_NOTE,
    inputSchema: { type: 'object', properties: { staged: { type: 'boolean' }, path: { type: 'string' }, cwd: { type: 'string' } } },
    outputSchema: { type: 'object', properties: { diff: { type: 'string' }, staged: { type: 'boolean' } } },
  },
  {
    name: 'git_log',
    description: 'Show recent commit history — hash, author, date, message.' + ROOT_NOTE,
    inputSchema: { type: 'object', properties: { limit: { type: 'number' }, path: { type: 'string' }, cwd: { type: 'string' } } },
    outputSchema: { type: 'object', properties: { commits: { type: 'array' }, count: { type: 'number' } } },
  },
  {
    name: 'git_add',
    description: 'Stage files for commit. Pass paths:["."] to stage everything.' + ROOT_NOTE,
    inputSchema: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' } }, cwd: { type: 'string' } }, required: ['paths'] },
    outputSchema: { type: 'object', properties: { success: { type: 'boolean' }, staged: { type: 'array' }, message: { type: 'string' } } },
  },
  {
    name: 'git_commit',
    description: 'Commit staged changes. Set all:true to auto-stage tracked modified files first. Auto-saves context entry.' + ROOT_NOTE,
    inputSchema: { type: 'object', properties: { message: { type: 'string' }, all: { type: 'boolean' }, cwd: { type: 'string' } }, required: ['message'] },
    outputSchema: { type: 'object', properties: { success: { type: 'boolean' }, hash: { type: 'string' }, branch: { type: 'string' }, message: { type: 'string' }, files: { type: 'array' } } },
  },
  {
    name: 'git_push',
    description: 'Push current branch to remote.' + ROOT_NOTE,
    inputSchema: { type: 'object', properties: { remote: { type: 'string' }, branch: { type: 'string' }, cwd: { type: 'string' } } },
    outputSchema: { type: 'object', properties: { success: { type: 'boolean' }, remote: { type: 'string' }, branch: { type: 'string' }, output: { type: 'string' } } },
  },
  {
    name: 'git_pull',
    description: 'Pull from remote and merge into current branch.' + ROOT_NOTE,
    inputSchema: { type: 'object', properties: { remote: { type: 'string' }, branch: { type: 'string' }, cwd: { type: 'string' } } },
    outputSchema: { type: 'object', properties: { success: { type: 'boolean' }, remote: { type: 'string' }, output: { type: 'string' } } },
  },
  {
    name: 'git_branch',
    description: 'List, create, or checkout branches.' + ROOT_NOTE,
    inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['list', 'create', 'checkout'] }, name: { type: 'string' }, cwd: { type: 'string' } } },
  },
  {
    name: 'git_stash',
    description: 'Stash or restore work-in-progress changes.' + ROOT_NOTE,
    inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['save', 'pop', 'list', 'drop'] }, message: { type: 'string' }, ref: { type: 'string' }, cwd: { type: 'string' } } },
  },
  {
    name: 'git_reset',
    description: 'Unstage files or reset HEAD. Use mode:file + path to restore a single file.' + ROOT_NOTE,
    inputSchema: { type: 'object', properties: { mode: { type: 'string', enum: ['soft', 'mixed', 'hard', 'file'] }, path: { type: 'string' }, ref: { type: 'string' }, cwd: { type: 'string' } } },
  },
  {
    name: 'git_show',
    description: 'Show full diff and metadata for a specific commit.',
    inputSchema: { type: 'object', properties: { ref: { type: 'string' }, cwd: { type: 'string' } } },
  },
];

export async function handle(name, args, state) {
  switch (name) {
    case 'git_status': {
      const cwd      = resolveCwd(args, state);
      const porcelain = runGit(['status', '--porcelain'], cwd);
      const branch   = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
      const lines    = porcelain ? porcelain.split('\n').filter(Boolean) : [];
      return {
        branch,
        clean:     lines.length === 0,
        staged:    lines.filter(l => l[0] !== ' ' && l[0] !== '?').map(l => l.slice(3)),
        unstaged:  lines.filter(l => l[1] === 'M' || l[1] === 'D').map(l => l.slice(3)),
        untracked: lines.filter(l => l.startsWith('??')).map(l => l.slice(3)),
      };
    }

    case 'git_diff': {
      const cwd  = resolveCwd(args, state);
      const argv = ['diff'];
      if (args.staged) argv.push('--cached');
      if (args.path) { argv.push('--'); argv.push(guardPath(args.path, state.projectRootPath || cwd)); }
      let diff = runGit(argv, cwd);
      if (diff.length > MAX_DIFF_LENGTH) diff = diff.slice(0, MAX_DIFF_LENGTH) + '\n…(truncated)';
      return { diff: diff || '(no changes)', staged: !!args.staged };
    }

    case 'git_log': {
      const cwd   = resolveCwd(args, state);
      const limit = Math.min(Math.max(1, parseInt(args.limit) || 10), 200);
      const argv  = ['log', '--pretty=format:%H\t%an\t%ad\t%s', '--date=short', `-n${limit}`];
      if (args.path) { argv.push('--'); argv.push(guardPath(args.path, state.projectRootPath || cwd)); }
      const raw   = runGit(argv, cwd);
      const commits = raw
        ? raw.split('\n').filter(Boolean).map(line => {
            const [hash, author, date, ...msg] = line.split('\t');
            return { hash: hash.slice(0, 8), author, date, message: msg.join('\t') };
          })
        : [];
      return { commits, count: commits.length };
    }

    case 'git_add': {
      const cwd   = resolveCwd(args, state);
      const paths = Array.isArray(args.paths) ? args.paths : [args.paths || '.'];
      const resolvedPaths = paths.map(p => state.projectRootPath ? guardPath(p, state.projectRootPath) : pathResolve(p));
      runGit(['add', '--', ...resolvedPaths], cwd);
      const status = runGit(['status', '--porcelain'], cwd);
      const staged = status
        ? status.split('\n').filter(l => l[0] !== ' ' && l[0] !== '?' && l.trim()).map(l => l.slice(3))
        : [];
      return { success: true, staged, message: `Staged: ${paths.join(', ')}` };
    }

    case 'git_commit': {
      if (!args.message) throw new Error('message is required for git_commit');
      const cwd = resolveCwd(args, state);

      const nameStatus = runGit(['diff', '--cached', '--name-status'], cwd);
      const stagedFiles = nameStatus
        ? nameStatus.split('\n').filter(Boolean).map(l => {
            const [s, ...parts] = l.split('\t');
            return { path: parts.join('\t'), action: s === 'A' ? 'created' : s === 'D' ? 'deleted' : 'modified' };
          })
        : [];

      if (args.all) runGit(['add', '-u'], cwd);

      runGit(['commit', '-m', args.message], cwd);

      const hash   = runGit(['rev-parse', '--short', 'HEAD'], cwd);
      const branch = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);

      saveAutoContext({
        title:   `git commit: ${args.message.slice(0, 57)}${args.message.length > 57 ? '...' : ''}`,
        content: `hash: ${hash} | branch: ${branch}\nmessage: ${args.message}\nfiles: ${stagedFiles.map(f => f.path).join(', ')}`,
        type:    'note',
        files:   stagedFiles,
        tags:    ['git', 'commit', branch],
        state,
      });

      return { success: true, hash, branch, message: args.message, files: stagedFiles };
    }

    case 'git_push': {
      const cwd    = resolveCwd(args, state);
      const remote = args.remote || 'origin';
      const branch = args.branch || runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
      const output = runGit(['push', remote, branch], cwd);
      return { success: true, remote, branch, output: output || 'Pushed successfully.' };
    }

    case 'git_pull': {
      const cwd    = resolveCwd(args, state);
      const remote = args.remote || 'origin';
      const argv   = ['pull', remote];
      if (args.branch) argv.push(args.branch);
      const output = runGit(argv, cwd);
      return { success: true, remote, output: output || 'Already up to date.' };
    }

    case 'git_branch': {
      const cwd    = resolveCwd(args, state);
      const action = args.action || 'list';
      if (action === 'list') {
        const raw      = runGit(['branch', '-a'], cwd);
        const branches = raw ? raw.split('\n').map(b => b.trim()).filter(Boolean) : [];
        const current  = branches.find(b => b.startsWith('* '))?.slice(2) || '';
        return { branches: branches.map(b => b.replace(/^\* /, '')), current };
      } else if (action === 'create') {
        if (!args.name) throw new Error('name is required for branch create');
        runGit(['checkout', '-b', args.name], cwd);
        return { success: true, branch: args.name, message: `Created and switched to "${args.name}"` };
      } else if (action === 'checkout') {
        if (!args.name) throw new Error('name is required for branch checkout');
        runGit(['checkout', args.name], cwd);
        return { success: true, branch: args.name, message: `Switched to "${args.name}"` };
      }
      throw new Error(`Unknown branch action: ${action}. Use: list, create, checkout`);
    }

    case 'git_stash': {
      const cwd    = resolveCwd(args, state);
      const action = args.action || 'save';
      if (action === 'save') {
        const argv = ['stash', 'push'];
        if (args.message) { argv.push('-m'); argv.push(args.message); }
        runGit(argv, cwd);
        return { success: true, message: `Stashed changes${args.message ? `: ${args.message}` : '.'}` };
      } else if (action === 'pop') {
        const out = runGit(['stash', 'pop'], cwd);
        return { success: true, output: out };
      } else if (action === 'list') {
        const raw = runGit(['stash', 'list'], cwd);
        return { stashes: raw ? raw.split('\n').filter(Boolean) : [] };
      } else if (action === 'drop') {
        const ref = args.ref || 'stash@{0}';
        runGit(['stash', 'drop', ref], cwd);
        return { success: true, message: `Dropped ${ref}` };
      }
      throw new Error(`Unknown stash action: ${action}. Use: save, pop, list, drop`);
    }

    case 'git_reset': {
      const cwd  = resolveCwd(args, state);
      const mode = args.mode || 'mixed';
      if (mode === 'file') {
        if (!args.path) throw new Error('path is required for file mode reset');
        const filePath = state.projectRootPath ? guardPath(args.path, state.projectRootPath) : pathResolve(args.path);
        runGit(['checkout', '--', filePath], cwd);
        return { success: true, message: `Restored "${args.path}" to last committed state.` };
      }
      const ref = args.ref || 'HEAD';
      runGit(['reset', `--${mode}`, ref], cwd);
      return { success: true, mode, ref, message: `Reset --${mode} to ${ref}` };
    }

    case 'git_show': {
      const cwd = resolveCwd(args, state);
      const ref = args.ref || 'HEAD';
      const info = runGit(['show', '--stat', '--format=%H%n%an%n%ad%n%s', ref], cwd);
      let diff = runGit(['show', ref], cwd);
      if (diff.length > MAX_DIFF_LENGTH) diff = diff.slice(0, MAX_DIFF_LENGTH) + '\n…(truncated)';
      return { ref, info, diff };
    }

    default:
      throw new Error(`Unknown git tool: ${name}`);
  }
}
