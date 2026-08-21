#!/usr/bin/env node
/**
 * context-mcp CLI
 * Browse, search, add, and manage your context store from the terminal.
 */

import readline from 'node:readline';
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync, spawn } from 'node:child_process';
import {
  saveContext, getContext,
  deleteContext, deleteProject, listProjects,
  listDiscussions, getStorePath, listGraphs,
} from './db.js';
import { getConfig, getConfigPath, saveConfig, saveSecretToKeytar } from './config.js';
import { randomBytes } from 'node:crypto';
import { search as unifiedSearch } from './search.js';
import { summarizeEntries } from './summarizer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));

// ── ANSI color palette ────────────────────────────────────────────────────────
const C = {
  reset:    '\x1b[0m',
  bold:     '\x1b[1m',
  dim:      '\x1b[2m',
  italic:   '\x1b[3m',
  navy:     '\x1b[38;5;19m',
  dblue:    '\x1b[38;5;27m',
  blue:     '\x1b[38;5;33m',
  lblue:    '\x1b[38;5;39m',
  tcyan:    '\x1b[38;5;45m',
  cyan:     '\x1b[38;5;51m',
  green:    '\x1b[38;5;84m',
  yellow:   '\x1b[38;5;220m',
  red:      '\x1b[38;5;203m',
  purple:   '\x1b[38;5;135m',
  gray:     '\x1b[38;5;245m',
  darkgray: '\x1b[38;5;238m',
  white:    '\x1b[38;5;255m',
};

const R         = C.reset;
const color     = (c, t) => `${c}${t}${R}`;
const bold      = t => `${C.bold}${t}${R}`;
const dim       = t => `${C.dim}${t}${R}`;
const italic    = t => `${C.italic}${t}${R}`;
const ok        = t => color(C.green,    t);
const warn      = t => color(C.yellow,   t);
const bad       = t => color(C.red,      t);
const accent    = t => color(C.tcyan,    t);
const muted     = t => color(C.gray,     t);
const faint     = t => color(C.darkgray, t);
const brand     = t => color(C.cyan,     t);
const lblue     = t => color(C.lblue,    t);
const highlight = t => `${C.bold}${C.white}${t}${R}`;

const GRAD = [C.navy, C.dblue, C.blue, C.lblue, C.tcyan, C.cyan];
const gradLine = (text, step) => `${GRAD[Math.min(step, GRAD.length - 1)]}${text}${R}`;

function line(width = 74)  { return color(C.darkgray, '─'.repeat(width)); }
function dline(width = 74) { return color(C.dblue,    '═'.repeat(width)); }

function pill(text, tone = 'tcyan') {
  const cc = C[tone] || C.tcyan;
  return `${cc}\x1b[7m ${text} ${R}`;
}

function safeTags(tags) { return Array.isArray(tags) ? tags : []; }

// ── Logo ──────────────────────────────────────────────────────────────────────

const LOGO_LINES = [
  ' ██████╗ ██████╗ ███╗   ██╗████████╗███████╗██╗  ██╗████████╗',
  '██╔════╝██╔═══██╗████╗  ██║╚══██╔══╝██╔════╝╚██╗██╔╝╚══██╔══╝',
  '██║     ██║   ██║██╔██╗ ██║   ██║   █████╗   ╚███╔╝    ██║   ',
  '██║     ██║   ██║██║╚██╗██║   ██║   ██╔══╝   ██╔██╗    ██║   ',
  '╚██████╗╚██████╔╝██║ ╚████║   ██║   ███████╗██╔╝ ██╗   ██║   ',
  ' ╚═════╝ ╚═════╝ ╚═╝  ╚═══╝   ╚═╝   ╚══════╝╚═╝  ╚═╝   ╚═╝  ',
];

function printBanner() {
  console.log('');
  LOGO_LINES.forEach((l, i) => console.log(gradLine(l, i)));
  console.log('');
  console.log(`  ${bold(lblue('context-mcp'))}  ${faint('v' + pkg.version)}  ${faint('│')}  ${italic(muted('persistent memory + knowledge graph for AI'))}`);
  console.log(`  ${faint('store  ')} ${muted(getStorePath())}`);
  console.log(`  ${faint('config ')} ${muted(getConfigPath())}`);
  console.log('');
}

// ── Section header ────────────────────────────────────────────────────────────

function printSection(title, meta = '') {
  const metaPart = meta ? `  ${faint(meta)}` : '';
  console.log('');
  console.log(`  ${bold(lblue(title.toUpperCase()))}${metaPart}`);
  console.log(`  ${color(C.darkgray, '─'.repeat(62))}`);
}

// ── Help ──────────────────────────────────────────────────────────────────────

function printUsage() {
  printBanner();

  printSection('Commands');
  const cmd = (c, desc) => console.log(`  ${accent(c.padEnd(36))} ${faint(desc)}`);
  cmd('(no args)',                     'open interactive mode');
  cmd('list [project]',                'list entries + discussions + graphs');
  cmd('search <query>',                'keyword → semantic fallback search');
  cmd('add',                           'add entry interactively');
  cmd('save --title "…" --content "…" --project <p> --type <t>', 'non-interactive save (scripts/hooks)');
  cmd('delete <id-prefix>',            'delete one entry');
  cmd('delete project <name|id>',      'delete all entries for a project');
  cmd('summary [project]',             'summarize recent entries');
  cmd('projects',                      'show all projects + graphs');
  cmd('discuss [project]',             'show discussions');
  console.log('');
  cmd('install --initial',             'install / update Node.js + Python (codegraph) deps only');
  cmd('install --<platform>',          'write MCP config + skill/rules file only (no uv/npm)');
  cmd('install --all',                 'write config + skill files for all platforms');
  cmd('online [--port N]',             'start HTTP server for Claude.ai / ChatGPT');
  cmd('online --close',                'stop the running HTTP server');
  cmd('settings',                      'view and edit config (port, host, client id/secret)');
  cmd('update',                        'check for and apply latest version');
  cmd('help',                          'show this screen');
  console.log('');
}
function clearScreen() {
  // \x1b[2J = clear screen, \x1b[3J = clear scrollback, \x1b[H = cursor home
  process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
}

// ── List (grouped by project) ─────────────────────────────────────────────────

function cmdList(args) {
  const projectFlagIdx = args.indexOf('--project');
  const filterProject  = projectFlagIdx !== -1 ? args[projectFlagIdx + 1] : args[0];
  const entries        = getContext({ project: filterProject, limit: 100 });
  const allDiscussions = listDiscussions({ project: filterProject });
  const allGraphs      = listGraphs();
  const projectRegistry = new Map(listProjects().map(p => [p.name, p]));

  printSection('Context', filterProject ? `project: ${filterProject}` : 'all projects');

  const projects = {};
  const ensureProj = p => {
    if (!projects[p]) projects[p] = { context: [], summary: [], plans: [] };
    return projects[p];
  };
  for (const entry of entries) {
    const p = entry.project || 'global';
    const d = ensureProj(p);
    if (entry.type === 'compaction') d.summary.push(entry);
    else d.context.push(entry);
  }
  for (const disc of allDiscussions) {
    ensureProj(disc.project || 'global').plans.push(disc);
  }

  const projectNames = Object.keys(projects).sort();

  if (!projectNames.length) {
    console.log(`  ${faint('no entries, discussions, or graphs found')}`);
    console.log('');
    return;
  }

  for (const projectName of projectNames) {
    const pData        = projects[projectName];
    const graphBuild   = _graphForProject(allGraphs, projectName);
    const totalEntries = pData.context.length + pData.summary.length;
    const activePlans  = pData.plans.filter(p => p.status === 'active').length;
    const sections     = [
      graphBuild               && 'graph',
      pData.context.length     && 'context',
      pData.summary.length     && 'summary',
      pData.plans.length       && 'plans',
    ].filter(Boolean);
    let secIdx = 0;

    const projReg   = projectRegistry.get(projectName);
    const projIdStr = projReg?.id ? faint('  id:' + projReg.id.slice(0, 8)) : '';
    console.log(`\n  ${color(C.dblue, '◆')} ${bold(lblue(projectName))}${projIdStr}  ${faint(`${totalEntries} entries · ${pData.plans.length} plans`)}${activePlans ? `  ${warn('● ' + activePlans + ' active')}` : ''}`);
    console.log(`  ${color(C.darkgray, '│')}`);

    const renderEntries = (items, label, secIsLast) => {
      console.log(`  ${color(C.darkgray, secIsLast ? '└─' : '├─')} ${muted(label)}  ${faint(items.length + ' entries')}`);
      items.forEach((item, i) => {
        const br   = i === items.length - 1 ? '└─' : '├─';
        const date = (item.createdAt || '').slice(0, 10);
        const id   = item.id.slice(0, 8);
        const tags = safeTags(item.tags);
        const pipe = secIsLast ? ' ' : '│';
        console.log(`  ${color(C.darkgray, pipe)}  ${color(C.darkgray, br)} ${bold(item.title || '(no title)')}  ${faint('id:' + id)}  ${faint(date)}`);
        if (tags.length) console.log(`  ${color(C.darkgray, pipe)}     ${faint(tags.map(t => '#' + t).join(' '))}`);
      });
      if (!secIsLast) console.log(`  ${color(C.darkgray, '│')}`);
    };

    if (graphBuild) {
      secIdx++;
      const isLast  = secIdx === sections.length;
      const builtAt = (graphBuild.builtAt || '').slice(0, 10);
      console.log(`  ${color(C.darkgray, isLast ? '└─' : '├─')} ${accent('⬡')} ${muted('graph')}  ${faint(`${graphBuild.nodes}n · ${graphBuild.edges}e · ${graphBuild.communities} clusters · ${builtAt}`)}`);
      if (!isLast) console.log(`  ${color(C.darkgray, '│')}`);
    }

    if (pData.context.length) {
      secIdx++;
      renderEntries(pData.context, 'context', secIdx === sections.length);
    }

    if (pData.summary.length) {
      secIdx++;
      const isLast = secIdx === sections.length;
      console.log(`  ${color(C.darkgray, isLast ? '└─' : '├─')} ${muted('summary')}  ${faint(pData.summary.length + ' compactions')}`);
      pData.summary.forEach((item, i) => {
        const br   = i === pData.summary.length - 1 ? '└─' : '├─';
        const date = (item.createdAt || '').slice(0, 10);
        const pipe = isLast ? ' ' : '│';
        console.log(`  ${color(C.darkgray, pipe)}  ${color(C.darkgray, br)} ${faint('◎')} ${bold(item.title || '(compaction)')}  ${faint(date)}`);
      });
      if (!isLast) console.log(`  ${color(C.darkgray, '│')}`);
    }

    if (pData.plans.length) {
      secIdx++;
      const isLast = secIdx === sections.length;
      console.log(`  ${color(C.darkgray, isLast ? '└─' : '├─')} ${muted('plans')}  ${faint(pData.plans.length + ' total')}`);
      pData.plans.forEach((plan, i) => {
        const br   = i === pData.plans.length - 1 ? '└─' : '├─';
        const pipe = isLast ? ' ' : '│';
        console.log(`  ${color(C.darkgray, pipe)}  ${color(C.darkgray, br)} ${warn(plan.status === 'active' ? '●' : '○')} ${bold(plan.name)}  ${pill(plan.status, plan.status === 'done' ? 'green' : 'tcyan')}  ${faint((plan.description || '').slice(0, 60))}`);
      });
    }
  }

  console.log('');
  console.log(line());
  console.log(faint(`  ${entries.length} entries  ·  ${allDiscussions.length} plans  ·  ${allGraphs.length} graphs  ·  ${projectNames.length} projects`));
}

// ── Search ────────────────────────────────────────────────────────────────────

function cmdSearch(args) {
  const query = args.join(' ');
  if (!query) { console.log(bad('  usage: ctx search <query>')); return; }

  let results = unifiedSearch({ mode: 'keyword', query, limit: 10 });
  const mode  = results.length ? 'keyword' : 'semantic';
  if (!results.length) results = unifiedSearch({ mode: 'semantic', query, limit: 10 });

  printSection('Search', `${mode} · "${query}"`);
  if (!results.length) { console.log(`  ${faint('no results')}`); return; }

  results.forEach((entry, index) => {
    const score  = entry.similarity !== undefined ? ok(` ${Math.round(entry.similarity * 100)}%`) : '';
    const date   = (entry.createdAt || '').slice(0, 10);
    const id     = entry.id.slice(0, 8);
    const type   = entry.type || 'note';
    const isLast = index === results.length - 1;
    console.log(`  ${color(C.darkgray, isLast ? '└─' : '├─')} ${bold(entry.title || '(no title)')}${score}  ${faint('id:' + id)}  ${faint(date)}`);
  });
  console.log('');
  console.log(line());
}

// ── Projects ──────────────────────────────────────────────────────────────────

function cmdProjects() {
  const projectList = listProjects();
  const graphs      = listGraphs();
  const allDiscs    = listDiscussions({});
  printSection('Projects');
  if (!projectList.length) { console.log(`  ${faint('no projects yet')}`); return; }

  for (const project of projectList) {
    const entries   = getContext({ project: project.name, limit: 3, compact: true }).filter(e => e.status !== 'archived');
    const discs     = allDiscs.filter(d => (d.project || 'global') === project.name);
    const activeD   = discs.filter(d => d.status === 'active');
    const graph     = _graphForProject(graphs, project.name);

    const barLen = Math.min(Math.ceil(project.count / 2), 24);
    const bar    = color(C.dblue, '█'.repeat(barLen)) + color(C.darkgray, '░'.repeat(24 - barLen));

    const idTag = project.id ? faint('  id:' + project.id.slice(0, 8)) : '';
    console.log(`\n  ${color(C.dblue, '◆')} ${bold(lblue(project.name))}${idTag}  ${bar}  ${faint(project.count + ' entries')}`);
    console.log(`  ${color(C.darkgray, '│')}`);

    if (graph) {
      const builtAt = (graph.builtAt || '').slice(0, 10);
      console.log(`  ${color(C.darkgray, '├─')} ${accent('⬡')} ${muted('graph')}  ${faint(`${graph.nodes}n · ${graph.edges}e · ${graph.communities} clusters · ${builtAt}`)}`);
    } else {
      console.log(`  ${color(C.darkgray, '├─')} ${faint('⬡ no graph')}`);
    }

    if (entries.length) {
      console.log(`  ${color(C.darkgray, '├─')} ${muted('recent')}`);
      entries.forEach((e, i) => {
        const br   = i === entries.length - 1 && !activeD.length ? '└─' : '├─';
        const date = (e.createdAt || '').slice(0, 10);
        console.log(`  ${color(C.darkgray, '│')}  ${color(C.darkgray, br)} ${bold(e.title || '(no title)')}  ${faint(date)}`);
      });
    }

    if (activeD.length) {
      console.log(`  ${color(C.darkgray, '├─')} ${muted('discussions')}`);
      activeD.forEach((d, i) => {
        const br    = i === activeD.length - 1 ? '└─' : '├─';
        const steps = d.stepsSummary?.total ? faint(` ${d.stepsSummary.done}/${d.stepsSummary.total}`) : '';
        console.log(`  ${color(C.darkgray, '│')}  ${color(C.darkgray, br)} ${warn('●')} ${bold(d.name)}  ${faint(d.type || 'plan')}${steps}`);
      });
    }

    console.log(`  ${color(C.darkgray, '│')}`);
  }

  console.log('');
  console.log(line());
  console.log(faint(`  ${projectList.length} projects  ·  ${projectList.reduce((a, p) => a + p.count, 0)} entries  ·  ${graphs.length} graphs`));
  console.log('');
}

// ── Discussions ───────────────────────────────────────────────────────────────

function cmdDiscussions(args) {
  const projectFlagIdx = args.indexOf('--project');
  const filterProject  = projectFlagIdx !== -1 ? args[projectFlagIdx + 1] : args[0];
  const discussions   = listDiscussions({ project: filterProject });
  printSection('Discussions', filterProject || 'all projects');

  if (!discussions.length) {
    console.log(`  ${faint('no discussions yet')}`);
    return;
  }

  const byType = {};
  for (const disc of discussions) {
    const t = disc.type || 'plan';
    if (!byType[t]) byType[t] = [];
    byType[t].push(disc);
  }

  for (const [type, items] of Object.entries(byType)) {
    console.log(`\n  ${color(C.dblue, '◆')} ${bold(lblue(type.toUpperCase()))}  ${faint(items.length + '')}`);
    items.forEach((disc, i) => {
      const isLast = i === items.length - 1;
      const sc     = disc.status === 'done' ? 'green' : 'tcyan';
      const steps  = disc.stepsSummary?.total
        ? faint(`  ${disc.stepsSummary.done}/${disc.stepsSummary.total} steps`)
        : '';
      const tags   = safeTags(disc.tags).map(t => pill(t, 'purple')).join(' ');
      console.log(`    ${color(C.darkgray, isLast ? '└─' : '├─')} ${bold(disc.name)}  ${pill(disc.status, sc)}${steps}  ${tags}`);
      if (disc.description) console.log(`    ${color(C.darkgray, isLast ? '  ' : '│')}   ${faint(disc.description)}`);
    });
  }

  console.log('');
  console.log(line());
  console.log(faint(`  ${discussions.length} discussion(s)`));
}

// ── Summary ───────────────────────────────────────────────────────────────────

function cmdSummary(args) {
  const projectFlagIdx = args.indexOf('--project');
  const project        = projectFlagIdx !== -1 ? args[projectFlagIdx + 1] : args[0];
  const entries = getContext({ project, limit: 50 });
  printSection('Summary', project || 'global');
  if (!entries.length) { console.log(`  ${faint('no entries to summarize')}`); return; }

  const md = summarizeEntries(entries, { project: project || 'global' });
  const rendered = md
    .replace(/^## (.+)/gm,     (_, t) => `\n${bold(lblue(t))}`)
    .replace(/^### (.+)/gm,    (_, t) => `\n${accent(t)}`)
    .replace(/\*\*(.+?)\*\*/g, (_, t) => bold(t))
    .replace(/`([^`]+)`/g,     (_, t) => warn(t))
    .replace(/^- /gm,          '  • ');
  console.log(rendered.trim());
  console.log('');
}

// ── Install ───────────────────────────────────────────────────────────────────

const TPLS = join(__dirname, 'templates');

function _tpl(name) {
  const p = join(TPLS, name);
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}

function _writeFile(filePath, content, label) {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, content, 'utf8');
  console.log(`  ${ok('✓')} ${label.padEnd(28)} ${faint(filePath.replace(/\\/g, '/'))}`);
}

// Entries ctx install writes into project roots — add to user's global gitignore if one exists
const _GLOBAL_GITIGNORE_ENTRIES = [
  // Installed instruction files
  'CLAUDE.md',
  'GEMINI.md',
  'AGENTS.md',
  // AI/IDE platform config folders (context-mcp specific — safe to ignore globally)
  '.claude/',
  '.vscode/',
  '.codex/',
  '.agents/',
  // Build outputs and session artifacts
  'codegraph-cache/',
  '.mcp.json',
];

// Match a graph to a project by exact last-path-component comparison (not substring)
function _graphForProject(graphs, projectName) {
  const norm = p => (p || '').toLowerCase().replace(/\\/g, '/').replace(/\/$/, '');
  const name = projectName.toLowerCase();
  return graphs.find(g => norm(g.path).split('/').pop() === name) || null;
}

const _PROJECT_GITIGNORE_ENTRIES = [
  '.claude/', '.vscode/', '.codex/', '.agents/',
  'codegraph-cache/', '.mcp.json', 'CLAUDE.md', 'GEMINI.md', 'AGENTS.md',
];

function _updateProjectGitignore(projectDir) {
  const giPath = join(projectDir, '.gitignore');
  const existing = existsSync(giPath) ? readFileSync(giPath, 'utf8') : '';
  const lines = existing.split(/\r?\n/);
  const missing = _PROJECT_GITIGNORE_ENTRIES.filter(e => !lines.includes(e));
  if (!missing.length) return;
  const block = '\n# context-mcp — written by ctx install\n' + missing.join('\n') + '\n';
  writeFileSync(giPath, (existing ? existing.trimEnd() : '') + block, 'utf8');
  console.log(`  ${ok('✓')} ${'project .gitignore'.padEnd(28)} ${faint(giPath.replace(/\\/g, '/'))}`);
  for (const e of missing) console.log(`      ${faint('+ ' + e)}`);
}

function _updateGlobalGitignore() {
  // Resolve global gitignore path: git config > ~/.gitignore_global > ~/.gitignore
  let giPath = null;
  const gitCfg = spawnSync('git', ['config', '--global', 'core.excludesFile'], { encoding: 'utf8' });
  if (gitCfg.status === 0 && gitCfg.stdout.trim()) {
    const resolved = gitCfg.stdout.trim().replace(/^~/, homedir());
    if (existsSync(resolved)) giPath = resolved;
  }
  if (!giPath) {
    for (const candidate of [join(homedir(), '.gitignore_global'), join(homedir(), '.gitignore')]) {
      if (existsSync(candidate)) { giPath = candidate; break; }
    }
  }
  if (!giPath) return; // no global gitignore — skip silently

  const existing = readFileSync(giPath, 'utf8');
  const lines = existing.split(/\r?\n/);
  const missing = _GLOBAL_GITIGNORE_ENTRIES.filter(e => !lines.includes(e));
  if (!missing.length) return;

  const block = '\n# context-mcp — written by ctx install\n' + missing.join('\n') + '\n';
  writeFileSync(giPath, existing.trimEnd() + block, 'utf8');
  console.log(`  ${ok('✓')} ${'global gitignore'.padEnd(28)} ${faint(giPath.replace(/\\/g, '/'))}`);
  for (const e of missing) console.log(`      ${faint('+ ' + e)}`);
}

function _writeCommands(baseDir) {
  const cmdsDir = join(TPLS, 'claude', 'commands');
  const destDir = join(baseDir, '.claude', 'commands');
  for (const [name, label] of [
    ['context-resume.md', '/context-resume'],
    ['graph-build.md',    '/graph-build'],
    ['save-context.md',   '/save-context'],
  ]) {
    const src = join(cmdsDir, name);
    if (existsSync(src)) {
      _writeFile(join(destDir, name), readFileSync(src, 'utf8'), label);
    }
  }
}

const MCP_SERVER_CMD = { command: 'npx', args: ['-y', 'context-mcp-server@latest'] };

function _tomlString(value) {
  return JSON.stringify(value);
}

function _copyHooks(platform, dotDir, dir, hookFiles) {
  const hooksSrc = join(TPLS, platform, 'hooks');
  const hooksDest = join(dir, dotDir, 'hooks');
  for (const file of hookFiles) {
    const src = join(hooksSrc, file);
    if (existsSync(src)) {
      const dest = join(hooksDest, file);
      _writeFile(dest, readFileSync(src, 'utf8'), `${dotDir}/hooks/${file}`);
      // Make executable on Unix so shells can run it without explicit `node` prefix
      if (process.platform !== 'win32') {
        try { chmodSync(dest, 0o755); } catch {}
      }
    }
  }
}

function _copyCodexHooks(dir) {
  _copyHooks('codex', '.codex', dir, [
    'context-mcp-pre-tool-use.js',
    'context-mcp-post-tool-use.js',
  ]);
}

// Read JSON from path (returns {} on missing/invalid), run mutateFn, write back.
function _mergeJsonFile(filePath, label, mutateFn) {
  let obj = {};
  try { obj = JSON.parse(readFileSync(filePath, 'utf8')); } catch {}
  mutateFn(obj);
  _writeFile(filePath, JSON.stringify(obj, null, 2), label);
  return obj;
}

// Append a YAML block under `topKey:` only if that top-level key isn't already in the file.
// ponytail: no YAML parser — safe subset (append-if-absent) instead of a real merge; if the
// key already exists, prints the block so the user can merge it in by hand rather than risking
// a corrupt rewrite of a file we can't fully parse.
function _appendYamlBlockIfAbsent(filePath, topKey, block, label) {
  let existing = '';
  try { existing = readFileSync(filePath, 'utf8'); } catch {}
  if (new RegExp(`^${topKey}:`, 'm').test(existing)) {
    console.log(`  ${faint('ℹ')} ${label}: "${topKey}:" already present — merge this in by hand:`);
    console.log(faint(block.split('\n').map(l => `      ${l}`).join('\n')));
    return;
  }
  const sep = existing && !existing.endsWith('\n') ? '\n' : '';
  _writeFile(filePath, existing + sep + block, label);
}

// Merge `entries` ({ EventName: [hookGroup] }) into an existing settings.json
// hooks object, replacing any previously installed context-mcp groups.
function _mergeHooksIntoSettings(settingsPath, entries, label) {
  let settings = {};
  try { settings = JSON.parse(readFileSync(settingsPath, 'utf8')); } catch {}
  settings.hooks = settings.hooks || {};
  for (const [event, groups] of Object.entries(entries)) {
    const existing = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
    settings.hooks[event] = existing
      .filter(g => !(g.hooks || []).some(h => String(h.command || '').includes('context-mcp-')))
      .concat(groups);
  }
  _writeFile(settingsPath, JSON.stringify(settings, null, 2), label);
  return settings;
}

function _codexConfigToml(dir, includeHooks = false) {
  const lines = [
    '[mcp_servers.context-mcp]',
    'command = "npx"',
    'args    = ["-y", "context-mcp-server@latest"]',
    'default_tools_approval_mode = "prompt"',
    '',
    '[mcp_servers.context-mcp.tools.context]',
    'approval_mode = "approve"',
    '',
    '[mcp_servers.context-mcp.tools.search]',
    'approval_mode = "approve"',
    '',
    '[mcp_servers.context-mcp.tools.codegraph_query]',
    'approval_mode = "approve"',
  ];

  if (includeHooks) {
    const preHook = join(dir, '.codex', 'hooks', 'context-mcp-pre-tool-use.js');
    const postHook = join(dir, '.codex', 'hooks', 'context-mcp-post-tool-use.js');
    lines.push(
      '',
      '[[hooks.PreToolUse]]',
      'matcher = "^Bash$"',
      '',
      '[[hooks.PreToolUse.hooks]]',
      'type = "command"',
      `command = ${_tomlString(`node ${_tomlString(preHook)}`)}`,
      `command_windows = ${_tomlString(`node ${_tomlString(preHook)}`)}`,
      'timeout = 30',
      'statusMessage = "Checking shell command"',
      '',
      '[[hooks.PostToolUse]]',
      'matcher = "^Bash$"',
      '',
      '[[hooks.PostToolUse.hooks]]',
      'type = "command"',
      `command = ${_tomlString(`node ${_tomlString(postHook)}`)}`,
      `command_windows = ${_tomlString(`node ${_tomlString(postHook)}`)}`,
      'timeout = 30',
      'statusMessage = "Saving failed shell context"',
    );
  }

  return `${lines.join('\n')}\n`;
}

const PLATFORMS = {
  claude: {
    label: 'Claude Code',
    restartNote: 'Type /context-resume in Claude Code to start using context-mcp.',
    install(dir, scope) {
      // Skill — user-global, works across all projects
      const skillSrc = join(TPLS, 'claude', 'skills', 'SKILL.md');
      const skillDest = join(homedir(), '.claude', 'skills', 'context-mcp', 'SKILL.md');
      if (existsSync(skillSrc)) {
        _writeFile(skillDest, readFileSync(skillSrc, 'utf8'), '~/.claude/skills/context-mcp/');
      }
      // Slash commands — user-global
      _writeCommands(homedir());
      // Rules file — project root for project scope, ~/.claude/CLAUDE.md for global
      const claudeMd = _tpl('claude/CLAUDE.md');
      if (claudeMd) {
        const claudeMdPath = scope === 'project'
          ? join(dir, 'CLAUDE.md')
          : join(homedir(), '.claude', 'CLAUDE.md');
        _writeFile(claudeMdPath, claudeMd, scope === 'project' ? 'CLAUDE.md' : '~/.claude/CLAUDE.md');
      }
      // Hooks — write into the appropriate settings.json scope
      // Project hooks live in .claude/hooks/ and are committed; user hooks in ~/.claude/hooks/
      const hooksBase = scope === 'project' ? dir : homedir();
      _copyHooks('claude', '.claude', hooksBase, [
        'context-mcp-pre-tool-use.js',
        'context-mcp-post-tool-use.js',
      ]);
      const preHook = join(hooksBase, '.claude', 'hooks', 'context-mcp-pre-tool-use.js');
      const postHook = join(hooksBase, '.claude', 'hooks', 'context-mcp-post-tool-use.js');
      const settingsPath = scope === 'project'
        ? join(dir, '.claude', 'settings.json')
        : join(homedir(), '.claude', 'settings.json');
      _mergeHooksIntoSettings(settingsPath, {
        PreToolUse: [{
          matcher: 'Bash',
          hooks: [{ type: 'command', command: `node "${preHook}"`, timeout: 30, statusMessage: 'Checking shell command' }],
        }],
        PostToolUse: [{
          matcher: 'Bash',
          hooks: [{ type: 'command', command: `node "${postHook}"`, timeout: 30, statusMessage: 'Saving failed shell context' }],
        }],
      }, scope === 'project' ? '.claude/settings.json' : '~/.claude/settings.json');
      // Register MCP server via claude CLI
      const scopeFlag = scope === 'global' ? 'user' : 'project';
      const reg = spawnSync(
        'claude', ['mcp', 'add', '--scope', scopeFlag, 'context-mcp', '--', 'npx', '-y', 'context-mcp-server@latest'],
        { encoding: 'utf8', shell: true },
      );
      if (reg.status === 0) {
        console.log(`  ${ok('✓')} ${'registered via claude mcp add'.padEnd(28)} ${faint('scope: ' + scopeFlag)}`);
      } else {
        console.log(`  ${faint('ℹ')} claude CLI not found — open Claude Code and trust context-mcp when prompted`);
      }
    },
  },
  vscode: {
    label: 'VS Code Copilot',
    restartNote: 'Reload VS Code window (Ctrl+Shift+P → "Reload Window").',
    install(dir, scope) {
      // MCP config
      const mcpJson = JSON.stringify({
        servers: { 'context-mcp': { type: 'stdio', ...MCP_SERVER_CMD } },
      }, null, 2);
      _writeFile(join(dir, '.vscode', 'mcp.json'), mcpJson, '.vscode/mcp.json');
      if (scope === 'project') {
        // Prompt files (.github/prompts/)
        const cmdsSrc = join(TPLS, 'vscode', 'commands');
        for (const file of ['context-resume.prompt.md', 'graph-build.prompt.md', 'save-context.prompt.md']) {
          const src = join(cmdsSrc, file);
          if (existsSync(src)) _writeFile(join(dir, '.github', 'prompts', file), readFileSync(src, 'utf8'), `.github/prompts/${file}`);
        }
        // Hook script
        _copyHooks('vscode', '.vscode', dir, ['context-mcp-post-tool-use.js']);
        const hookPath = join(dir, '.vscode', 'hooks', 'context-mcp-post-tool-use.js');
        // Merge hooks into .vscode/settings.json under github.copilot.chat.agent.hooks
        _mergeJsonFile(join(dir, '.vscode', 'settings.json'), '.vscode/settings.json', obj => {
          const hooks = obj['github.copilot.chat.agent.hooks'] || {};
          const strip = arr => (arr || []).filter(h => !String(h.command || '').includes('context-mcp-'));
          hooks.PostToolUse = strip(hooks.PostToolUse).concat([
            { type: 'command', command: `node "${hookPath}"`, timeout: 30, windows: `node "${hookPath}"` },
          ]);
          obj['github.copilot.chat.agent.hooks'] = hooks;
        });
      }
    },
  },
  antigravity: {
    label: 'Antigravity (2.0 / IDE / CLI)',
    restartNote: 'Reload the MCP Servers panel (or restart Antigravity CLI) to pick up context-mcp.',
    install(dir, scope) {
      const base = scope === 'project' ? join(dir, '.agents') : join(homedir(), '.gemini', 'config');

      // MCP config — shared format across Antigravity 2.0, IDE, and CLI
      _mergeJsonFile(join(base, 'mcp_config.json'), `${scope === 'project' ? '.agents' : '~/.gemini/config'}/mcp_config.json`, obj => {
        obj.mcpServers = obj.mcpServers || {};
        obj.mcpServers['context-mcp'] = MCP_SERVER_CMD;
      });

      // Skills — one per slash-command equivalent (agent activates by description or name)
      const skillsSrc = join(TPLS, 'antigravity', 'skills');
      for (const name of ['context-resume', 'graph-build', 'context-subgraph', 'save-context']) {
        const src = join(skillsSrc, name, 'SKILL.md');
        if (existsSync(src)) {
          _writeFile(join(base, 'skills', name, 'SKILL.md'), readFileSync(src, 'utf8'),
            `${scope === 'project' ? '.agents' : '~/.gemini/config'}/skills/${name}/SKILL.md`);
        }
      }

      // Rules file — GEMINI.md is Antigravity's own memory file
      const geminiMd = _tpl('antigravity/GEMINI.md');
      if (geminiMd) {
        const geminiMdPath = scope === 'project' ? join(dir, 'GEMINI.md') : join(homedir(), '.gemini', 'GEMINI.md');
        _writeFile(geminiMdPath, geminiMd, scope === 'project' ? 'GEMINI.md' : '~/.gemini/GEMINI.md');
      }

      // Hook — PostToolUse on run_command, merged into hooks.json under a named "context-mcp" entry
      _copyHooks('antigravity', scope === 'project' ? '.agents' : '.gemini/config', scope === 'project' ? dir : homedir(), [
        'context-mcp-post-tool-use.js',
      ]);
      const hookPath = join(base, 'hooks', 'context-mcp-post-tool-use.js');
      _mergeJsonFile(join(base, 'hooks.json'), `${scope === 'project' ? '.agents' : '~/.gemini/config'}/hooks.json`, obj => {
        obj['context-mcp'] = {
          PostToolUse: [{
            matcher: 'run_command',
            hooks: [{ type: 'command', command: `node "${hookPath}"`, timeout: 30 }],
          }],
        };
      });
    },
  },
  codex: {
    label: 'Codex CLI',
    restartNote: 'Restart your Codex CLI session.',
    install(dir, scope) {
      const includeHooks = scope === 'project';
      if (includeHooks) _copyCodexHooks(dir);
      _writeFile(join(dir, '.codex', 'config.toml'), _codexConfigToml(dir, includeHooks), '.codex/config.toml');
      // Rules file — project root for project scope, ~/.codex/AGENTS.md for global
      const codexMd = _tpl('codex/AGENTS.md');
      if (codexMd) {
        const codexMdPath = scope === 'project'
          ? join(dir, 'AGENTS.md')
          : join(homedir(), '.codex', 'AGENTS.md');
        _writeFile(codexMdPath, codexMd, scope === 'project' ? 'AGENTS.md' : '~/.codex/AGENTS.md');
      }
      // Prompts (slash commands) — always user-global; Codex only loads ~/.codex/prompts/
      const promptsSrc = join(TPLS, 'codex', 'prompts');
      for (const file of ['context-resume.md', 'graph-build.md', 'save-context.md']) {
        const src = join(promptsSrc, file);
        if (existsSync(src)) {
          _writeFile(join(homedir(), '.codex', 'prompts', file), readFileSync(src, 'utf8'), `~/.codex/prompts/${file}`);
        }
      }
      // Register via codex CLI so server is active immediately
      const reg = spawnSync(
        'codex', ['mcp', 'add', 'context-mcp', '--', 'npx', '-y', 'context-mcp-server@latest'],
        { encoding: 'utf8', shell: true },
      );
      if (reg.status === 0) {
        console.log(`  ${ok('✓')} ${'registered via codex mcp add'.padEnd(28)}`);
      } else {
        console.log(`  ${faint('ℹ')} codex CLI not found — server will load on next Codex session`);
      }
    },
  },
  hermes: {
    label: 'Hermes Agent',
    restartNote: 'Run /reload-mcp (and /reload-skills) in Hermes, or restart the session.',
    install(dir, scope) {
      const hermesDir = join(homedir(), '.hermes');
      const configPath = join(hermesDir, 'config.yaml');

      // MCP server + shell hook — appended to ~/.hermes/config.yaml (always user-global; Hermes has no
      // per-project config file). ponytail: no YAML parser dependency — only appends a top-level key
      // (mcp_servers:/hooks:) when it isn't already present; if it exists, prints manual-merge instructions
      // instead of risking a corrupt rewrite of the user's existing config.
      _copyHooks('hermes', '.hermes', homedir(), ['context-mcp-post-tool-use.js']);
      const hookPath = join(hermesDir, 'hooks', 'context-mcp-post-tool-use.js');

      _appendYamlBlockIfAbsent(configPath, 'mcp_servers',
        'mcp_servers:\n  context-mcp:\n    command: "npx"\n    args: ["-y", "context-mcp-server@latest"]\n',
        '~/.hermes/config.yaml (mcp_servers)');
      _appendYamlBlockIfAbsent(configPath, 'hooks',
        `hooks:\n  post_tool_call:\n    - matcher: "terminal"\n      command: "node \\"${hookPath.replace(/\\/g, '/')}\\""\n      timeout: 30\n`,
        '~/.hermes/config.yaml (hooks)');

      // Skills — always global at ~/.hermes/skills/ (single source of truth per Hermes docs)
      const skillsSrc = join(TPLS, 'hermes', 'skills');
      for (const name of ['context-resume', 'graph-build', 'save-context']) {
        const src = join(skillsSrc, name, 'SKILL.md');
        if (existsSync(src)) {
          _writeFile(join(hermesDir, 'skills', 'context-mcp', name, 'SKILL.md'), readFileSync(src, 'utf8'),
            `~/.hermes/skills/context-mcp/${name}/SKILL.md`);
        }
      }

      // Rules file — Hermes auto-injects project-root AGENTS.md (shared file/content with Codex)
      if (scope === 'project') {
        const agentsMd = _tpl('codex/AGENTS.md');
        if (agentsMd) _writeFile(join(dir, 'AGENTS.md'), agentsMd, 'AGENTS.md');
      } else {
        console.log(`  ${faint('ℹ')} Hermes reads AGENTS.md from the project root — re-run with project scope to write one`);
      }
    },
  },
};

async function cmdInstall(args) {
  const flags = new Set(args.map(a => a.replace(/^--/, '')));
  const all     = flags.has('all');
  const initial = flags.has('initial');
  const keys  = all ? Object.keys(PLATFORMS) : Object.keys(PLATFORMS).filter(k => flags.has(k));

  if (initial) {
    printSection('Install', 'install / update');
    console.log('');

    const __dirname_init = dirname(fileURLToPath(import.meta.url));
    const pkgRootInit = join(__dirname_init, '..');

    // Node.js packages
    console.log(`  ${bold(lblue('Node.js packages'))}`);
    const npmInstall = spawnSync('npm', ['install', '--omit=dev'], {
      cwd: pkgRootInit, encoding: 'utf8', shell: true,
    });
    if (npmInstall.status !== 0) {
      console.log(`  ${bad('✗')} npm install failed:\n${faint((npmInstall.stderr || npmInstall.stdout || '').trim())}`);
    } else {
      console.log(`  ${ok('✓')} Node.js dependencies installed`);
    }
    console.log('');

    // Python / uv (codegraph)
    console.log(`  ${bold(lblue('Python Codegraph'))}`);
    const uvCheck2 = spawnSync('uv', ['--version'], { encoding: 'utf8', shell: true });
    if (uvCheck2.error || uvCheck2.status !== 0) {
      console.log(`  ${bad('✗')} uv not found — install from ${accent('https://docs.astral.sh/uv/')} to enable codegraph`);
    } else {
      console.log(`  ${ok('✓')} uv found: ${faint(uvCheck2.stdout.trim())}`);
      // On Windows, an existing .venv contains a lib64 junction that uv can't remove — wipe it first
      if (process.platform === 'win32') {
        const venvPath = join(pkgRootInit, '.venv');
        spawnSync('cmd', ['/c', 'rmdir', '/s', '/q', venvPath], { encoding: 'utf8' });
      }
      const sync2 = spawnSync('uv', ['--directory', pkgRootInit, 'sync', '--no-dev'], { encoding: 'utf8' });
      if (sync2.status !== 0) {
        console.log(`  ${bad('✗')} uv sync failed:\n${faint((sync2.stderr || sync2.stdout || '').trim())}`);
      } else {
        console.log(`  ${ok('✓')} Python environment ready — codegraph enabled`);
      }
    }
    // Bootstrap store structure — creates ~/.context-mcp/, projects/, contextconfig.json
    console.log(`  ${bold(lblue('Store'))}`);
    try {
      getConfig(); // triggers DATA_DIR creation + contextconfig.json generation
      console.log(`  ${ok('✓')} store ready          ${faint(getStorePath())}`);
      console.log(`  ${ok('✓')} config ready         ${faint(getConfigPath())}`);
    } catch (e) {
      console.log(`  ${bad('✗')} store init failed: ${faint(e.message)}`);
    }
    console.log('');
    return;
  }

  if (!keys.length) {
    printSection('Install');
    console.log(`  ${muted('Usage:')}  ctx install ${faint('[--initial] [--claude] [--vscode] [--antigravity] [--codex] [--hermes] [--all]')}`);
    console.log('');
    console.log(`  ${accent('--initial      ')}  ${faint('Install / update Node.js + Python (codegraph) deps')}`);
    console.log('');
    console.log(`  Writes MCP config file + AI instruction file for each selected platform.`);
    console.log(`  Files are written into the ${accent('current directory')} (your project root).`);
    console.log('');
    for (const [k, p] of Object.entries(PLATFORMS)) {
      console.log(`    ${accent(('--' + k).padEnd(14))}  ${faint(p.label)}`);
    }
    console.log(`    ${accent('--all          ')}  ${faint('All platforms at once')}`);
    console.log('');
    return;
  }

  // ── Scope prompt ───────────────────────────────────────────────────────────
  let scope = 'project';
  let baseDir = process.cwd();

  const rl  = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = q => new Promise(resolve => rl.question(`  ${accent('›')} ${muted(q)} `, resolve));

  printSection('Install', keys.map(k => PLATFORMS[k].label).join(', '));
  console.log('');
  console.log(`  ${muted('Install scope:')}`);
  console.log(`  ${accent('1.')} For this project  ${faint('(writes config into current directory)')}`);
  console.log(`  ${accent('2.')} Globally          ${faint('(writes config to your home directory)')}`);
  console.log('');
  const answer = (await ask('Choose (1/2) [1]:')).trim();
  rl.close();
  console.log('');

  if (answer === '2') {
    scope = 'global';
    baseDir = homedir();
  }

  for (const key of keys) {
    const platform = PLATFORMS[key];
    console.log(`  ${bold(lblue(platform.label))}`);
    try {
      platform.install(baseDir, scope);
    } catch (err) {
      console.log(`  ${bad('✗')} failed: ${err.message}`);
    }
    if (platform.restartNote) {
      console.log(`  ${faint('→ ' + platform.restartNote)}`);
    }
    console.log('');
  }

  const destLabel = scope === 'global' ? homedir().replace(/\\/g, '/') : process.cwd().replace(/\\/g, '/');
  console.log(line());
  console.log(faint(`  ${keys.length} platform(s) installed  ·  scope: ${scope}  ·  ${destLabel}`));
  console.log('');

  // ── Project .gitignore — add context-mcp entries for this project ──────────
  _updateProjectGitignore(process.cwd());

  // ── Global gitignore — add context-mcp runtime files if global gitignore exists ──
  _updateGlobalGitignore();
  console.log('');
}

// ── Online ────────────────────────────────────────────────────────────────────

function _httpPidFile(port) {
  const dataDir = process.env.CONTEXT_MCP_DIR || join(homedir(), '.context-mcp');
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  return join(dataDir, `http-${port}.pid`);
}

// Check if something is actually listening on the port (cross-platform, reliable)
function _isPortListening(port) {
  const script = `const n=require('net'),s=n.createConnection({port:${port},host:'localhost'});s.setTimeout(500);s.on('connect',()=>{s.destroy();process.exit(0);});s.on('error',()=>process.exit(1));s.on('timeout',()=>{s.destroy();process.exit(1);});`;
  const r = spawnSync(process.execPath, ['-e', script], { timeout: 2000 });
  return r.status === 0;
}

function _storedPid(port) {
  const pidPath = _httpPidFile(port);
  if (!existsSync(pidPath)) return null;
  const pid = parseInt(readFileSync(pidPath, 'utf8').trim() || '0');
  return pid || null;
}

// Returns { status: 'running', pid } | { status: 'none' }
function _checkExistingHttpServer(port) {
  if (!_isPortListening(port)) {
    // Clean up stale PID file if present
    try { unlinkSync(_httpPidFile(port)); } catch {}
    return { status: 'none' };
  }
  const pid = _storedPid(port);
  return { status: 'running', pid };
}

function cmdOnline(args) {
  const portIdx = args.indexOf('--port');
  const port    = portIdx !== -1 && args[portIdx + 1] ? args[portIdx + 1] : null;
  const hostIdx = args.indexOf('--host');
  const host    = hostIdx !== -1 && args[hostIdx + 1] ? args[hostIdx + 1] : null;
  const git     = args.includes('--access-git');
  const restart = args.includes('--restart');
  const close   = args.includes('--close');

  let cfg;
  try { cfg = getConfig(); } catch { cfg = { client_id: 'context-mcp', client_secret: '(unavailable)', port: 3100, host: 'localhost' }; }

  const resolvedPort = port || cfg.port || 3100;
  const resolvedHost = host || cfg.host || 'localhost';

  printSection('Online', `HTTP MCP server → Claude.ai / ChatGPT`);
  console.log('');

  if (close) {
    const existing2 = _checkExistingHttpServer(resolvedPort);
    if (existing2.status === 'running') {
      if (existing2.pid) {
        try { process.kill(existing2.pid); } catch {}
      }
      try { unlinkSync(_httpPidFile(resolvedPort)); } catch {}
      const pidStr = existing2.pid ? `pid ${existing2.pid}  ·  ` : '';
      console.log(`  ${ok('✓')} ${bold('server stopped')}  ${faint(pidStr + 'port ' + resolvedPort)}\n`);
    } else {
      console.log(`  ${warn('–')} no server running on port ${resolvedPort}\n`);
    }
    return;
  }

  // Check if a server is already running on this port
  const existing = _checkExistingHttpServer(resolvedPort);
  if (existing.status === 'running') {
    if (!restart) {
      const pidStr = existing.pid ? `pid ${existing.pid}  ·  ` : '';
      console.log(`  ${ok('✓')} ${bold('already running')}  ${faint(pidStr + 'port ' + resolvedPort)}`);
      console.log(`  ${faint('Run')} ${accent('ctx online --restart')} ${faint('to force a restart')}\n`);
      return;
    }
    if (existing.pid) { try { process.kill(existing.pid); } catch {} }
    try { unlinkSync(_httpPidFile(resolvedPort)); } catch {}
    const stopMsg = existing.pid ? `stopped pid ${existing.pid}` : `port ${resolvedPort} was in use`;
    console.log(`  ${warn('⚠')} restarting  ${faint('(' + stopMsg + ')')}`);
    console.log('');
  }

  // Credentials
  console.log(`  ${faint('client id')}      ${accent(cfg.client_id)}`);
  console.log(`  ${faint('client secret')}  ${ok(cfg.client_secret)}`);
  console.log(`  ${faint('config')}         ${faint(getConfigPath())}`);
  console.log('');
  console.log(`  ${faint('endpoint')}  ${accent(`http://${resolvedHost}:${resolvedPort}`)}`);
  console.log(`  ${faint('oauth')}     ${faint('POST')} ${accent(`http://${resolvedHost}:${resolvedPort}/oauth/token`)}`);
  console.log('');
  console.log(`  ${faint('To connect Claude.ai / ChatGPT:')}`);
  console.log(`    ${faint('Settings → Integrations → Add MCP Connector')}`);
  console.log(`    ${faint('URL:')} ${accent(`http://${resolvedHost}:${resolvedPort}`)}`);
  console.log(`    ${faint('Use the client id and secret above when prompted')}`);
  console.log('');

  // Build args for the HTTP server
  const httpBin = join(__dirname, 'http.js');
  const spawnArgs = ['--port', String(resolvedPort)];
  if (host) spawnArgs.push('--host', resolvedHost);
  if (git)  spawnArgs.push('--access-git');

  // Spawn detached so HTTP server runs in background
  const child = spawn(process.execPath, [httpBin, ...spawnArgs], {
    detached: true,
    stdio:    'ignore',
    env:      { ...process.env },
  });
  child.unref();

  // Persist PID so next invocation can kill it
  try { writeFileSync(_httpPidFile(resolvedPort), String(child.pid)); } catch {}

  console.log(`  ${ok('✓')} ${bold('HTTP server started')}  ${faint('pid ' + child.pid + '  ·  port ' + resolvedPort)}`);
  console.log(`  ${faint('Run')} ${accent('ctx online')} ${faint('again to restart  ·  or')} ${faint('kill ' + child.pid)}\n`);
}

// ── Settings ─────────────────────────────────────────────────────────────────

async function cmdSettings(existingRl) {
  const rl  = existingRl || readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = q => new Promise(resolve => rl.question(`  ${accent('›')} ${muted(q)} `, resolve));

  printSection('Settings', getConfigPath());

  const FIELDS = [
    { key: 'client_id',     label: 'Client ID',     desc: 'OAuth client identifier' },
    { key: 'client_secret', label: 'Client Secret', desc: 'OAuth client secret (keep private)' },
    { key: 'port',          label: 'HTTP Port',      desc: 'Port for ctx online server', coerce: Number },
    { key: 'host',          label: 'Host',           desc: 'Bind address for ctx online server' },
    { key: 'access_git',    label: 'Access Git',     desc: 'Allow git tools (true/false)', coerce: v => v === 'true' },
  ];

  let cfg;
  try { cfg = getConfig(); } catch { cfg = {}; }

  // Display current values
  console.log('');
  FIELDS.forEach((f, i) => {
    const val = cfg[f.key];
    const display = f.key === 'client_secret' ? val?.slice(0, 8) + '...' : String(val ?? '');
    console.log(`  ${faint((i + 1) + '.')} ${muted(f.label.padEnd(16))} ${accent(display)}  ${faint(f.desc)}`);
  });
  console.log('');
  console.log(`  ${faint('Enter a number to edit, or press Enter to exit.')}`);
  console.log('');

  const choice = (await ask('Edit field (1-' + FIELDS.length + '):')).trim();

  const idx = parseInt(choice) - 1;
  if (isNaN(idx) || idx < 0 || idx >= FIELDS.length) {
    if (!existingRl) rl.close();
    console.log(`  ${faint('no changes made')}`);
    return;
  }

  const field = FIELDS[idx];
  const current = cfg[field.key];
  const newValRaw = (await ask(`${field.label} [${current}]:`)).trim();
  if (!existingRl) rl.close();

  if (!newValRaw) {
    console.log(`  ${faint('no changes made')}`);
    return;
  }

  const newVal = field.coerce ? field.coerce(newValRaw) : newValRaw;
  cfg[field.key] = newVal;
  saveConfig(cfg);
  console.log(`  ${ok('✓')} ${bold(field.label)} updated to ${accent(String(newVal))}`);
}

// ── Add ───────────────────────────────────────────────────────────────────────

async function cmdAdd(existingRl) {
  const rl  = existingRl || readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = q => new Promise(resolve => rl.question(`  ${accent('›')} ${muted(q)} `, resolve));

  printSection('Add Entry');
  const title   = await ask('Title (optional):');
  const content = await ask('Content:');
  const project = await ask('Project (blank = global):');
  const tagsRaw = await ask('Tags (comma-separated):');
  const type    = await ask('Type (note/compaction):');

  if (!existingRl) rl.close();
  if (!content.trim()) { console.log(`  ${bad('✗')} content required`); return; }

  const entry = saveContext({
    title:   title.trim(),
    content: content.trim(),
    project: project.trim() || 'global',
    tags:    tagsRaw.split(',').map(t => t.trim()).filter(Boolean),
    type:    type.trim() || 'note',
    source:  'cli',
  });

  console.log(`  ${ok('✓')} ${bold(entry.title || '(no title)')}  ${faint('id:' + entry.id.slice(0, 8))}`);
}

// ── Save (non-interactive, flag-based — used by hooks and scripts) ───────────

function cmdSave(args) {
  // Usage: ctx save --title "..." --content "..." --project <p> --type <t> --tags <t1,t2>
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      flags[args[i].slice(2)] = args[i + 1] || '';
      i++;
    }
  }
  const content = flags.content || flags.c;
  if (!content) { console.log(`  ${bad('✗')} --content required`); process.exit(1); }
  const entry = saveContext({
    title:   (flags.title || flags.t || '').trim(),
    content: content.trim(),
    project: (flags.project || flags.p || '').trim() || 'global',
    tags:    (flags.tags || '').split(',').map(s => s.trim()).filter(Boolean),
    type:    (flags.type || 'note').trim(),
    source:  'cli',
  });
  console.log(`  ${ok('✓')} saved "${entry.title || entry.id.slice(0, 8)}" → ${entry.project}`);
}

// ── Delete ────────────────────────────────────────────────────────────────────

function cmdDelete(args) {
  if (args[0] === 'project') {
    const nameOrId = args.slice(1).join(' ');
    if (!nameOrId) {
      console.log(`  ${bad('✗')} usage: ctx delete project <name|id>`);
      const projects = listProjects();
      if (projects.length) {
        console.log('');
        for (const p of projects) {
          const idStr = p.id ? faint(p.id.slice(0, 8)) : faint('built-in');
          console.log(`  ${faint('·')} ${muted(p.name)}  ${idStr}  ${faint(p.count + ' entries')}`);
        }
      }
      return;
    }
    const { deletedEntries, deletedDiscussions } = deleteProject(nameOrId);
    if (!deletedEntries && !deletedDiscussions) {
      // Try to give a helpful hint — list available projects
      const projects = listProjects();
      console.log(`  ${bad('✗')} no project matching "${nameOrId}"`);
      if (projects.length) {
        console.log(`  ${faint('available:')}`);
        for (const p of projects) {
          const idStr = p.id ? faint('  ' + p.id.slice(0, 8)) : faint('  built-in');
          console.log(`    ${muted(p.name)}${idStr}  ${faint(p.count + ' entries')}`);
        }
      }
    } else {
      const label = nameOrId.length === 36 ? nameOrId.slice(0, 8) : nameOrId;
      console.log(`  ${ok('✓')} deleted project "${label}"  ${faint(deletedEntries + ' entries removed')}`);
    }
    return;
  }

  const partial = args[0];
  if (!partial) {
    console.log(`  ${bad('✗')} usage: ctx delete <id-prefix>`);
    console.log(`  ${faint('       ctx delete project <name|id>')}`);
    return;
  }

  const entries = getContext({ limit: 1000 });
  const matches = entries.filter(e => e.id.startsWith(partial));

  if (!matches.length) {
    console.log(`  ${bad('✗')} no entry with id starting "${partial}"`);
    return;
  }
  if (matches.length > 1) {
    console.log(`  ${warn('!')} "${partial}" matches ${matches.length} entries — be more specific:`);
    for (const m of matches) console.log(`    ${faint(m.id.slice(0, 8))}  ${m.title || '(no title)'}`);
    return;
  }

  const match = matches[0];
  const { deleted } = deleteContext({ id: match.id });
  if (deleted) {
    console.log(`  ${ok('✓')} deleted ${bold(match.title || '(no title)')}  ${faint('id:' + match.id.slice(0, 8))}`);
  } else {
    console.log(`  ${bad('✗')} delete failed`);
  }
}
// ── Compact header (shown after screen clear in interactive mode) ─────────────

function printCompactHeader(cmdLabel = '') {
  const tag = cmdLabel ? `  ${faint('›')} ${muted(cmdLabel)}` : '';
  console.log(`\n  ${bold(lblue('context-mcp'))}  ${faint('v' + pkg.version)}${tag}\n`);
}

// ── Interactive mode ──────────────────────────────────────────────────────────

async function interactive() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  clearScreen();
  printBanner();

  const ask = () => new Promise(resolve => rl.question(`\n  ${color(C.dblue, '◆')} ${lblue('context')} ${faint('›')} `, resolve));

  while (true) {
    const input = (await ask()).trim();
    if (!input) continue;
    const [cmd, ...rest] = input.split(/\s+/);

    const runCmd = async () => {
      switch (cmd.toLowerCase()) {
        case 'exit': case 'quit': case 'q':
          rl.close(); printBye(); process.exit(0); break;
        case 'list': case 'ls':
          clearScreen(); printCompactHeader('list'); cmdList(rest); break;
        case 'search':
          clearScreen(); printCompactHeader('search'); cmdSearch(rest); break;
        case 'projects':
          clearScreen(); printCompactHeader('projects'); cmdProjects(); break;
        case 'discuss': case 'discussions':
          clearScreen(); printCompactHeader('discussions'); cmdDiscussions(rest); break;
        case 'summary':
          clearScreen(); printCompactHeader('summary'); cmdSummary(rest); break;
        case 'install':
          clearScreen(); printCompactHeader('install'); await cmdInstall(rest); break;
        case 'online':
          clearScreen(); printCompactHeader('online'); cmdOnline(rest); break;
        case 'settings': case 'config':
          clearScreen(); printCompactHeader('settings'); await cmdSettings(rl); break;
        case 'add':
          clearScreen(); printCompactHeader('add'); await cmdAdd(rl); break;
        case 'save':
          cmdSave(rest); break;
        case 'delete': case 'del': case 'rm':
          clearScreen(); printCompactHeader('delete'); cmdDelete(rest); break;
        case 'help': case '?':
          clearScreen(); printUsage(); break;
        case 'clear': case 'cls':
          clearScreen(); printBanner(); break;
        default:
          console.log(`\n  ${bad('✗')} unknown command ${faint(cmd)}  ${dim('type help')}`);
      }
    };

    await runCmd();
  }
}

function printBye() {
  console.log(`\n  ${ok('✓')} ${bold(lblue('goodbye'))}  ${faint('keep building')}\n`);
}

// ── Update check ──────────────────────────────────────────────────────────────

async function checkForUpdate() {
  try {
    const result = spawnSync(
      'npm', ['view', 'context-mcp-server', 'version', '--json'],
      { encoding: 'utf8', timeout: 3000, shell: true },
    );
    if (result.status !== 0 || !result.stdout) return;
    const parsed = JSON.parse(result.stdout.trim());
    const latest = typeof parsed === 'string' ? parsed : String(parsed);
    const current = pkg.version;
    if (latest && latest !== current) {
      console.log(`  ${warn('↑')} ${bold('Update available')}  ${faint(current)} ${accent('→')} ${ok(latest)}  ${faint('run:')} ${accent('npm i -g context-mcp-server@latest')}`);
      console.log('');
    }
  } catch {}
}

// ── CLI entry point ───────────────────────────────────────────────────────────

(async () => {
  const [, , cmd, ...rest] = process.argv;

  switch ((cmd || '').toLowerCase()) {
    case 'list': case 'ls':
      cmdList(rest); break;
    case 'search':
      cmdSearch(rest); break;
    case 'projects':
      cmdProjects(); break;
    case 'discuss': case 'discussions':
      cmdDiscussions(rest); break;
    case 'summary':
      cmdSummary(rest); break;
    case 'install':
      await cmdInstall(rest);
      process.exit(0);
      break;
    case 'update': {
      printSection('Update');
      console.log('');
      const upd = spawnSync(
        'npm', ['install', '-g', 'context-mcp-server@latest'],
        { encoding: 'utf8', shell: true, stdio: 'inherit' },
      );
      if (upd.status === 0) {
        console.log(`\n  ${ok('✓')} ${bold('context-mcp updated to latest')}`);
      } else {
        console.log(`\n  ${bad('✗')} update failed — try: ${accent('npm i -g context-mcp-server@latest')}`);
      }
      console.log('');
      break;
    }
    case 'online':
      cmdOnline(rest); break;
    case 'settings': case 'config':
      await cmdSettings(); break;
    case 'add':
      await cmdAdd(); break;
    case 'save':
      cmdSave(rest); break;
    case 'delete': case 'del': case 'rm':
      cmdDelete(rest); break;
    case 'help': case '--help': case '-h':
      await checkForUpdate();
      printUsage();
      break;
    case '--version': case '-v':
      console.log(pkg.version); break;
    default:
      await checkForUpdate();
      await interactive();
  }
})();
