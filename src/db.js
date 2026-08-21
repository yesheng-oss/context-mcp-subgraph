/**
 * db.js — per-project directory store for context-mcp
 *
 * Layout:
 *   ~/.context-mcp/
 *   ├── projects.json          ← master index
 *   └── projects/
 *       └── <slug>/
 *           ├── context.json   ← decision, bug, note, code, config, error
 *           ├── graph.json     ← { build: {...}, entries: [...architecture...] }
 *           ├── summary.json   ← summary type + archived entries
 *           └── discussions.json
 */

import {
  readFileSync, writeFileSync, mkdirSync, existsSync,
  openSync, closeSync, unlinkSync, renameSync, chmodSync, rmdirSync,
  readdirSync,
} from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const DATA_DIR     = process.env.CONTEXT_MCP_DIR || join(homedir(), '.context-mcp');
const PROJECTS_DIR = join(DATA_DIR, 'projects');
const PROJECTS_PATH = join(DATA_DIR, 'projects.json');


const MAX_CONTENT_LENGTH = 5000;
const PREVIEW_LENGTH     = 200;
const WRITE_DEBOUNCE_MS  = 500;
const LOCK_WAIT_TIMEOUT_MS = 2000;

const _isWin = platform() === 'win32';

function normPath(p) {
  return p ? p.toLowerCase().replace(/\\/g, '/').replace(/\/$/, '') : '';
}

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
}

function projectDataDir(name)    { return join(PROJECTS_DIR, slugify(name)); }
function contextFilePath(name)   { return join(projectDataDir(name), 'context.json'); }
function graphFilePath(name)     { return join(projectDataDir(name), 'graph.json'); }
function summaryFilePath(name)   { return join(projectDataDir(name), 'summary.json'); }
function discussFilePath(name)   { return join(projectDataDir(name), 'discussions.json'); }

function treeFor(entry) {
  if (entry.type === 'compaction') return 'summary';
  return 'context';
}

function _secureFile(p) {
  if (_isWin) return;
  try { chmodSync(p, 0o600); } catch {}
}

if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
  if (!_isWin) { try { chmodSync(DATA_DIR, 0o700); } catch {} }
}
if (!existsSync(PROJECTS_DIR)) {
  mkdirSync(PROJECTS_DIR, { recursive: true });
}

// ── In-memory cache ──────────────────────────────────────────────────────────

let _projectsIndex = null;     // array of { id, name, rootPath, createdAt, dataDir }
let _projectsIndexDirty = false;
let _projectData = new Map();  // name -> { context: [], graph: { build, entries: [] }, summary: [], discussions: [] }
let _dirtyProjects = new Set();
let _dirty = false;
let _writeTimer = null;
let _generation = 0;

// ── File I/O helpers ─────────────────────────────────────────────────────────

function _flushFile(filePath, content) {
  const lockPath = `${filePath}.lock`;
  const tmpPath  = `${filePath}.tmp`;
  let lockFd;
  let renamed = false;
  try {
    const started = Date.now();
    for (;;) {
      try { lockFd = openSync(lockPath, 'wx'); break; }
      catch (err) {
        if (err && err.code !== 'EEXIST') throw err;
        if (Date.now() - started > LOCK_WAIT_TIMEOUT_MS)
          throw new Error(`Timed out waiting for lock: ${lockPath}`);
        const t = Date.now(); while (Date.now() - t < 10) {}
      }
    }
    writeFileSync(tmpPath, JSON.stringify(content, null, 2), 'utf8');
    _secureFile(tmpPath);
    renameSync(tmpPath, filePath);
    renamed = true;
  } finally {
    if (lockFd !== undefined) { closeSync(lockFd); try { unlinkSync(lockPath); } catch {} }
    try { if (!renamed && existsSync(tmpPath)) unlinkSync(tmpPath); } catch {}
  }
}

function _readArr(filePath, key) {
  if (!existsSync(filePath)) return [];
  try {
    const d = JSON.parse(readFileSync(filePath, 'utf8'));
    return Array.isArray(d[key]) ? d[key] : (Array.isArray(d) ? d : []);
  } catch { return []; }
}

function _readObj(filePath, defaults) {
  if (!existsSync(filePath)) return { ...defaults };
  try { return { ...defaults, ...JSON.parse(readFileSync(filePath, 'utf8')) }; }
  catch { return { ...defaults }; }
}

// ── Projects index ───────────────────────────────────────────────────────────

function loadProjectsIndex() {
  if (_projectsIndex) return _projectsIndex;
  if (!existsSync(PROJECTS_PATH)) {
    // Fall back to scanning the projects dir so CLI works without projects.json
    _projectsIndex = [];
    if (existsSync(PROJECTS_DIR)) {
      try {
        for (const slug of readdirSync(PROJECTS_DIR, { withFileTypes: true })) {
          if (slug.isDirectory()) _projectsIndex.push({ name: slug.name, slug: slug.name });
        }
      } catch {}
    }
    return _projectsIndex;
  }
  try {
    const d = JSON.parse(readFileSync(PROJECTS_PATH, 'utf8'));
    _projectsIndex = Array.isArray(d.projects) ? d.projects : [];
  } catch { _projectsIndex = []; }
  return _projectsIndex;
}

// ── Per-project data loading ─────────────────────────────────────────────────

function loadProjectData(name) {
  if (_projectData.has(name)) return _projectData.get(name);
  const dir = projectDataDir(name);
  mkdirSync(dir, { recursive: true });
  const data = {
    context:     _readArr(contextFilePath(name), 'entries'),
    graph:       _readObj(graphFilePath(name), { build: null }),
    summary:     _readArr(summaryFilePath(name), 'entries'),
    discussions: _readArr(discussFilePath(name), 'discussions'),
  };
  _projectData.set(name, data);
  return data;
}

function getAllEntries(projectName) {
  const data = loadProjectData(projectName);
  return [...data.context, ...data.summary];
}

function findEntryById(id, projectHint) {
  const search = (data) => {
    for (const arr of [data.context, data.summary]) {
      const e = arr.find(c => c.id === id);
      if (e) return e;
    }
    return null;
  };
  if (projectHint) {
    const e = search(loadProjectData(projectHint));
    if (e) return { entry: e, projectName: projectHint };
  }
  for (const [name, data] of _projectData.entries()) {
    if (name === projectHint) continue;
    const e = search(data);
    if (e) return { entry: e, projectName: name };
  }
  // Always check 'global' — it is never in the projects index
  if (!_projectData.has('global') && 'global' !== projectHint) {
    const e = search(loadProjectData('global'));
    if (e) return { entry: e, projectName: 'global' };
  }
  const idx = loadProjectsIndex();
  for (const proj of idx) {
    if (_projectData.has(proj.name) || proj.name === projectHint) continue;
    const e = search(loadProjectData(proj.name));
    if (e) return { entry: e, projectName: proj.name };
  }
  return null;
}

function removeEntryFromData(data, entry) {
  if (treeFor(entry) === 'summary') {
    data.summary = data.summary.filter(e => e.id !== entry.id);
  } else {
    data.context = data.context.filter(e => e.id !== entry.id);
  }
}

// ── Dirty tracking & flush ───────────────────────────────────────────────────

function markDirty() {
  _dirty = true;
  _generation++;
  if (_writeTimer) clearTimeout(_writeTimer);
  _writeTimer = setTimeout(flushToDisk, WRITE_DEBOUNCE_MS);
}

function flushProjectToDisk(name) {
  const data = _projectData.get(name);
  if (!data) return;
  const dir = projectDataDir(name);
  mkdirSync(dir, { recursive: true });
  _flushFile(contextFilePath(name),   { entries: data.context });
  _flushFile(graphFilePath(name),     data.graph);
  _flushFile(summaryFilePath(name),   { entries: data.summary });
  _flushFile(discussFilePath(name),   { discussions: data.discussions });
}

export function flushToDisk() {
  if (!_dirty) return;
  _writeTimer = null;

  for (const name of _dirtyProjects) {
    flushProjectToDisk(name);
  }
  _dirtyProjects.clear();

  if (_projectsIndexDirty && _projectsIndex) {
    _flushFile(PROJECTS_PATH, { projects: _projectsIndex });
    _projectsIndexDirty = false;
  }

  _dirty = false;
}

process.on('exit', flushToDisk);
process.on('SIGINT',  () => { flushToDisk(); process.exit(); });
process.on('SIGTERM', () => { flushToDisk(); process.exit(); });

function init() {
  loadProjectsIndex();
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function truncate(text, max) {
  if (!text || text.length <= max) return text;
  return text.slice(0, max - 3) + '...';
}

function normalizeTags(tags) {
  if (Array.isArray(tags)) return tags;
  if (typeof tags === 'string') return tags.split(',').map(t => t.trim()).filter(Boolean);
  return [];
}

const VALID_SOURCES = new Set(['user', 'ai-summary', 'file', 'web', 'cli', 'auto']);
function normalizeSource(s) { return VALID_SOURCES.has(s) ? s : 'user'; }

function compactEntry(e) {
  const compact = {
    id:        e.id,
    project:   e.project,
    sessionId: e.sessionId,
    nodeType:  e.nodeType || 'entry',
    title:     e.title || '',
    type:      e.type || 'note',
    status:    e.status || 'active',
    version:   e.version || 1,
    tags:      e.tags,
    source:    e.source,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt || null,
    preview:   truncate(e.content, PREVIEW_LENGTH),
  };
  if (e.why)     compact.why     = e.why;
  if (e.outcome) compact.outcome = e.outcome;
  if (e.files    && e.files.length)    compact.files    = e.files;
  if (e.codeRefs && e.codeRefs.length) compact.codeRefs = e.codeRefs;
  if (e.expiresAt) compact.expiresAt = e.expiresAt;
  return compact;
}

// ── Context entries ──────────────────────────────────────────────────────────

const VALID_TYPES = new Set(['note', 'compaction']);

function computeImportance({ files = [], why = '', outcome = '', tags = [], type } = {}) {
  if (type === 'compaction') return 5;
  let score = 0;
  if (Array.isArray(files) && files.length > 0) score += 2;
  if (why && why.trim()) score += 1;
  if (outcome && outcome.trim()) score += 1;
  if (Array.isArray(tags) && tags.some(t => t === 'plan' || t === 'decision')) score += 1;
  return score;
}

const _SECRET_PATTERN = /("?(?:api[-_]?key|password|passwd|pwd|token|secret|authorization|auth_token|access_token|refresh_token|bearer|cookie|signature|private[-_]?key|client[-_]?secret)"?\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi;

function redactSecrets(text) {
  if (typeof text !== 'string') return text;
  return text.replace(_SECRET_PATTERN, '$1[REDACTED]');
}

export function saveContext({ project, content, why = '', outcome = '', tags = [], source = 'user', title = '',
  type = 'note', status = 'active', files = [], codeRefs = [],
  sessionId = null, parentId = null, expiresAt = null, rootPath = null }) {
  init();
  const projectName = project || 'global';
  ensureProject(projectName, rootPath || undefined);
  const data = loadProjectData(projectName);
  const now = new Date().toISOString();
  const validatedType = VALID_TYPES.has(type) ? type : 'note';
  const normalizedFiles = Array.isArray(files) ? files : [];
  const normalizedTags = normalizeTags(tags);
  const entry = {
    id: randomUUID(),
    project: projectName,
    sessionId: sessionId || null,
    parentId: parentId || sessionId || `project:${projectName}`,
    nodeType: 'entry',
    version: 1,
    title: truncate(title, 120),
    content: redactSecrets(truncate(content, MAX_CONTENT_LENGTH)),
    why: redactSecrets(truncate(why || '', 300)),
    outcome: redactSecrets(truncate(outcome || '', 300)),
    type: validatedType,
    status,
    tags: normalizedTags,
    source: normalizeSource(source),
    files: normalizedFiles,
    codeRefs: Array.isArray(codeRefs) ? codeRefs : [],
    importance: computeImportance({ files: normalizedFiles, why, outcome, tags: normalizedTags, type: validatedType }),
    discussionId: null,
    createdAt: now,
    updatedAt: null,
    expiresAt: expiresAt || null,
  };
  const tree = treeFor(entry);
  if (tree === 'summary') data.summary.push(entry);
  else data.context.push(entry);
  _dirtyProjects.add(projectName);
  markDirty();
  return entry;
}

export function updateContext({ id, content, why, outcome, title, tags, type, status, files, codeRefs, sessionId, parentId, expiresAt }) {
  init();
  const found = findEntryById(id);
  if (!found) return null;
  const { entry, projectName } = found;
  const data = loadProjectData(projectName);

  const oldTree = treeFor(entry);
  if (content   !== undefined) entry.content   = truncate(content, MAX_CONTENT_LENGTH);
  if (why       !== undefined) entry.why       = truncate(why     || '', 300);
  if (outcome   !== undefined) entry.outcome   = truncate(outcome || '', 300);
  if (title     !== undefined) entry.title     = truncate(title, 120);
  if (tags      !== undefined) entry.tags      = normalizeTags(tags);
  if (type      !== undefined) entry.type      = VALID_TYPES.has(type) ? type : entry.type;
  if (status    !== undefined) entry.status    = status;
  if (files     !== undefined) entry.files     = Array.isArray(files) ? files : [];
  if (codeRefs  !== undefined) entry.codeRefs  = Array.isArray(codeRefs) ? codeRefs : [];
  if (expiresAt !== undefined) entry.expiresAt = expiresAt || null;
  if (sessionId !== undefined) entry.sessionId = sessionId || null;
  if (parentId  !== undefined) entry.parentId  = parentId || entry.sessionId || `project:${entry.project || 'global'}`;
  entry.version  = (entry.version || 1) + 1;
  entry.updatedAt = new Date().toISOString();

  // Re-route if type/status changed tree membership
  const newTree = treeFor(entry);
  if (newTree !== oldTree) {
    removeEntryFromData(data, entry);
    if (newTree === 'summary') data.summary.push(entry);
    else data.context.push(entry);
  }

  _dirtyProjects.add(projectName);
  markDirty();
  return entry;
}

export function getContext({ project, tags, limit = 20, compact = false, ids } = {}) {
  init();

  if (ids && ids.length) {
    const idSet = new Set(ids);
    // Load all projects to find entries — always include 'global' since it is
    // never registered in the projects index (ensureProject skips it)
    const idx = loadProjectsIndex();
    const all = [];
    const loaded = new Set(_projectData.keys());
    loaded.add('global'); // ensure global is always searched
    for (const proj of idx) loaded.add(proj.name);
    for (const name of loaded) {
      for (const e of getAllEntries(name)) {
        if (idSet.has(e.id)) all.push(e);
      }
    }
    return compact ? all.map(compactEntry) : all;
  }

  let results;
  if (project) {
    const entries = getAllEntries(project);
    const globalEntries = project !== 'global' ? getAllEntries('global') : [];
    results = [...entries, ...globalEntries];
  } else {
    // No project filter: load all — always include 'global' since it is never in the index
    const idx = loadProjectsIndex();
    const all = [];
    const seen = new Set(_projectData.keys());
    seen.add('global');
    for (const proj of idx) seen.add(proj.name);
    for (const name of seen) {
      all.push(...getAllEntries(name));
    }
    results = all;
  }

  if (tags && tags.length) {
    const tagList = Array.isArray(tags) ? tags : tags.split(',').map(t => t.trim());
    results = results.filter(c => tagList.some(t => Array.isArray(c.tags) && c.tags.includes(t)));
  }

  // Sort by createdAt ascending, then take last `limit`
  results.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const sliced = results.slice(-limit).reverse();
  return compact ? sliced.map(compactEntry) : sliced;
}

export function getContextSince(since, project) {
  init();
  let results;
  if (project) {
    results = [...getAllEntries(project)];
    if (project !== 'global') results.push(...getAllEntries('global'));
  } else {
    const idx = loadProjectsIndex();
    results = [];
    const seen = new Set([..._projectData.keys(), 'global', ...idx.map(p => p.name)]);
    for (const name of seen) results.push(...getAllEntries(name));
  }
  return results.filter(c => c.createdAt >= since);
}

export function searchContext({ query, project, limit = 10, compact = false }) {
  init();
  const terms = query.toLowerCase().split(/\s+/);
  let results;
  if (project) {
    results = [...getAllEntries(project)];
    if (project !== 'global') results.push(...getAllEntries('global'));
  } else {
    const idx = loadProjectsIndex();
    results = [];
    const seen = new Set([..._projectData.keys(), 'global', ...idx.map(p => p.name)]);
    for (const name of seen) results.push(...getAllEntries(name));
  }
  const scored = results.map(c => {
    const haystack = `${c.title || ''} ${c.content || ''} ${(Array.isArray(c.tags) ? c.tags : []).join(' ')}`.toLowerCase();
    const score = terms.reduce((s, t) => {
      try { return s + (haystack.match(new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'))?.length ?? 0); }
      catch { return s; }
    }, 0);
    return { ...c, score };
  }).filter(c => c.score > 0).sort((a, b) => b.score - a.score);
  const sliced = scored.slice(0, limit).map(({ score, ...c }) => c);
  return compact ? sliced.map(compactEntry) : sliced;
}

export function deleteContext({ id, ids }) {
  init();
  const idSet = new Set(ids && ids.length ? ids : (id ? [id] : []));
  if (!idSet.size) return { deleted: 0 };
  let deleted = 0;
  // Scan all loaded projects — always include 'global' since it is never in the index
  const seen = new Set(_projectData.keys());
  seen.add('global');
  loadProjectsIndex().forEach(p => seen.add(p.name));
  for (const name of seen) {
    const data = loadProjectData(name);
    const allEntries = getAllEntries(name);
    const toRemove = allEntries.filter(e => idSet.has(e.id));
    if (!toRemove.length) continue;
    for (const entry of toRemove) removeEntryFromData(data, entry);
    _dirtyProjects.add(name);
    deleted += toRemove.length;
    if (deleted >= idSet.size) break;
  }
  if (deleted > 0) markDirty();
  return { deleted };
}

export function deleteProject(nameOrId) {
  init();
  const idx = loadProjectsIndex();
  const byId = idx.find(p => p.id === nameOrId);
  const projectName = byId ? byId.name : nameOrId;

  // Count before removing
  const data = _projectData.get(projectName) || loadProjectData(projectName);
  const ctxCount  = data.context.length + data.summary.length;
  const discCount = data.discussions.length;

  // Remove project directory from disk
  const dir = projectDataDir(projectName);
  if (existsSync(dir)) {
    for (const file of ['context.json', 'graph.json', 'summary.json', 'discussions.json']) {
      try { unlinkSync(join(dir, file)); } catch {}
    }
    try { rmdirSync(dir); } catch {}
  }

  // Drop from cache
  _projectData.delete(projectName);
  _dirtyProjects.delete(projectName);

  // Remove from index
  const beforeProj = idx.length;
  _projectsIndex = idx.filter(p => p.name !== projectName);
  if (_projectsIndex.length !== beforeProj) {
    _projectsIndexDirty = true;
    markDirty();
  }

  return { deletedEntries: ctxCount, deletedDiscussions: discCount };
}

export function countContext(project) {
  init();
  if (!project) {
    const idx = loadProjectsIndex();
    let total = 0;
    const seen = new Set([..._projectData.keys(), 'global', ...idx.map(p => p.name)]);
    for (const name of seen) total += getAllEntries(name).length;
    return total;
  }
  return getAllEntries(project).length;
}

export function ensureProject(name, rootPath) {
  if (!name || name === 'global') return null;
  const idx = loadProjectsIndex();
  let proj = idx.find(p => p.name === name);
  if (!proj) {
    proj = {
      id: randomUUID(),
      name,
      createdAt: new Date().toISOString(),
      dataDir: `projects/${slugify(name)}`,
    };
    idx.push(proj);
    _projectsIndexDirty = true;
    markDirty();
  }
  if (rootPath && !proj.rootPath) {
    proj.rootPath = rootPath;
    if (!proj.dataDir) proj.dataDir = `projects/${slugify(name)}`;
    _projectsIndexDirty = true;
    markDirty();
  }
  return proj;
}

export function getProjectRoot(name) {
  if (!name || name === 'global') return null;
  init();
  return loadProjectsIndex().find(p => p.name === name)?.rootPath || null;
}

export function listProjects() {
  init();
  const idx = loadProjectsIndex();
  // Load all known project dirs to get entry counts
  const seen = new Set([..._projectData.keys(), ...idx.map(p => p.name)]);
  return [...seen]
    .map(name => {
      const count = getAllEntries(name).length;
      const reg = idx.find(p => p.name === name);
      if (!reg && count === 0) return null;
      return {
        id:        reg?.id        || null,
        name,
        count,
        createdAt: reg?.createdAt || null,
        rootPath:  reg?.rootPath  || null,
      };
    })
    .filter(p => p && p.count > 0);
}

// ── Auto-dedup ───────────────────────────────────────────────────────────────

export function findDuplicate(content, project) {
  init();
  const existing = getContext({ project, limit: 50 });
  if (!existing.length) return null;
  const newWords = new Set(content.toLowerCase().split(/\s+/).filter(w => w.length > 3));
  if (!newWords.size) return null;
  for (const entry of existing) {
    const oldWords = new Set((entry.content || '').toLowerCase().split(/\s+/).filter(w => w.length > 3));
    if (!oldWords.size) continue;
    const overlap = [...newWords].filter(w => oldWords.has(w)).length;
    const similarity = overlap / Math.max(newWords.size, oldWords.size);
    if (similarity > 0.85) return entry;
  }
  return null;
}

// ── Discussions ───────────────────────────────────────────────────────────────

const VALID_DISCUSSION_TYPES    = new Set(['plan','research','idea','design','implementation','review','thread']);
const VALID_DISCUSSION_STATUSES = new Set(['active','done']);

export function saveDiscussion({ name, title, description, content, project, tags,
  type, status, steps, linkedContextIds, parentId, sessionId }) {
  init();
  const proj = project || 'global';
  const data = loadProjectData(proj);
  const existing = data.discussions.findIndex(d => d.name === name);
  const now = new Date().toISOString();
  const prev = existing >= 0 ? data.discussions[existing] : null;
  const disc = {
    id:               prev?.id || randomUUID(),
    name,
    project:          project          !== undefined ? (project || 'global')                              : (prev?.project          ?? 'global'),
    sessionId:        sessionId        !== undefined ? (sessionId || null)                                : (prev?.sessionId        ?? null),
    parentId:         parentId         !== undefined ? (parentId || null)                                 : (prev?.parentId         ?? null),
    title:            title            !== undefined ? truncate(title || name, 120)                       : (prev?.title            ?? name),
    description:      description      !== undefined ? (description || '')                                : (prev?.description      ?? ''),
    content:          content          !== undefined ? truncate(content || '', MAX_CONTENT_LENGTH)         : (prev?.content          ?? ''),
    type:             type             !== undefined ? (VALID_DISCUSSION_TYPES.has(type) ? type : 'plan')  : (prev?.type             ?? 'plan'),
    status:           status           !== undefined ? (VALID_DISCUSSION_STATUSES.has(status) ? status : 'active') : (prev?.status  ?? 'active'),
    tags:             tags             !== undefined ? normalizeTags(tags)                                : (prev?.tags             ?? []),
    steps:            steps            !== undefined ? mergeSteps(prev?.steps ?? [], steps)               : (prev?.steps            ?? []),
    linkedContextIds: linkedContextIds !== undefined ? (Array.isArray(linkedContextIds) ? linkedContextIds : []) : (prev?.linkedContextIds ?? []),
    createdAt:        prev?.createdAt || now,
    updatedAt:        now,
  };
  if (existing >= 0) data.discussions[existing] = disc;
  else data.discussions.push(disc);
  _dirtyProjects.add(proj);
  markDirty();
  return disc;
}

function mergeSteps(prevSteps, incomingSteps) {
  if (!Array.isArray(incomingSteps) || incomingSteps.length === 0) return prevSteps;
  return incomingSteps.map((s, i) => {
    const prev = prevSteps.find(p => p.id && p.id === s.id) || prevSteps[i];
    return {
      id:               s.id              || prev?.id              || randomUUID(),
      title:            s.title           ?? prev?.title           ?? '',
      description:      s.description     ?? prev?.description     ?? '',
      status:           s.status          ?? prev?.status          ?? 'pending',
      order:            s.order           ?? prev?.order           ?? i,
      linkedContextIds: s.linkedContextIds ?? prev?.linkedContextIds ?? [],
      completedAt:      s.completedAt     ?? prev?.completedAt     ?? null,
    };
  });
}

export function updateDiscussion({ id, name, title, description, content, status, type, tags, steps, linkedContextIds, parentId, sessionId }) {
  init();
  let disc = null;
  let projName = null;
  const idx = loadProjectsIndex();
  const seen = new Set([..._projectData.keys(), 'global', ...idx.map(p => p.name)]);
  for (const pName of seen) {
    const d = loadProjectData(pName);
    const found = id ? d.discussions.find(x => x.id === id) : d.discussions.find(x => x.name === name);
    if (found) { disc = found; projName = pName; break; }
  }
  if (!disc) return null;
  if (title       !== undefined) disc.title       = truncate(title || disc.name, 120);
  if (description !== undefined) disc.description = description || '';
  if (content     !== undefined) disc.content     = truncate(content || '', MAX_CONTENT_LENGTH);
  if (type        !== undefined) disc.type        = VALID_DISCUSSION_TYPES.has(type)      ? type   : disc.type;
  if (status      !== undefined) disc.status      = VALID_DISCUSSION_STATUSES.has(status) ? status : disc.status;
  if (tags        !== undefined) disc.tags        = normalizeTags(tags);
  if (steps       !== undefined) disc.steps       = mergeSteps(disc.steps ?? [], steps);
  if (linkedContextIds !== undefined) disc.linkedContextIds = Array.isArray(linkedContextIds) ? linkedContextIds : disc.linkedContextIds;
  if (parentId    !== undefined) disc.parentId    = parentId || null;
  if (sessionId   !== undefined) disc.sessionId   = sessionId || null;
  disc.updatedAt = new Date().toISOString();
  _dirtyProjects.add(projName);
  markDirty();
  return disc;
}

export function getDiscussion({ project, name, id } = {}) {
  init();
  if (project) {
    const data = loadProjectData(project);
    let list = data.discussions;
    if (id)   return list.find(d => d.id   === id)   || null;
    if (name) return list.find(d => d.name === name) || null;
    return null;
  }
  // Search all — always include 'global' since it is never in the projects index
  const idx = loadProjectsIndex();
  const seen = new Set([..._projectData.keys(), 'global', ...idx.map(p => p.name)]);
  for (const pName of seen) {
    const d = loadProjectData(pName);
    const found = id ? d.discussions.find(x => x.id === id) : d.discussions.find(x => x.name === name);
    if (found) return found;
  }
  return null;
}

export function listDiscussions({ project, status, type } = {}) {
  init();
  let list = [];
  if (project) {
    list = loadProjectData(project).discussions;
    if (project !== 'global') list = [...list, ...loadProjectData('global').discussions];
  } else {
    const idx = loadProjectsIndex();
    const seen = new Set([..._projectData.keys(), 'global', ...idx.map(p => p.name)]);
    for (const pName of seen) list.push(...loadProjectData(pName).discussions);
  }
  if (status) list = list.filter(d => d.status === status);
  if (type)   list = list.filter(d => d.type   === type);
  return list.map(({ content: _, steps, ...rest }) => ({
    ...rest,
    stepsSummary: {
      total:      (steps || []).length,
      done:       (steps || []).filter(s => s.status === 'done').length,
      inProgress: (steps || []).filter(s => s.status === 'in-progress').length,
    },
  }));
}

export function linkContextToDiscussion({ discussionId, discussionName, contextId }) {
  init();
  // Find discussion across projects
  let disc = null;
  let discProject = null;
  const idx = loadProjectsIndex();
  const seen = new Set([..._projectData.keys(), 'global', ...idx.map(p => p.name)]);
  for (const pName of seen) {
    const d = loadProjectData(pName);
    const found = discussionId
      ? d.discussions.find(x => x.id   === discussionId)
      : d.discussions.find(x => x.name === discussionName);
    if (found) { disc = found; discProject = pName; break; }
  }
  if (!disc) return null;

  if (!Array.isArray(disc.linkedContextIds)) disc.linkedContextIds = [];
  let changed = false;
  if (!disc.linkedContextIds.includes(contextId)) {
    disc.linkedContextIds.push(contextId);
    disc.updatedAt = new Date().toISOString();
    _dirtyProjects.add(discProject);
    changed = true;
  }

  // Write discussionId back onto the context entry
  const found = findEntryById(contextId);
  if (found && found.entry.discussionId !== disc.id) {
    found.entry.discussionId = disc.id;
    found.entry.updatedAt = new Date().toISOString();
    _dirtyProjects.add(found.projectName);
    changed = true;
  }
  if (changed) markDirty();
  return { discussionId: disc.id, contextId };
}

export function deleteDiscussion({ name, id }) {
  init();
  const idx = loadProjectsIndex();
  const seen = new Set([..._projectData.keys(), 'global', ...idx.map(p => p.name)]);
  for (const pName of seen) {
    const data = loadProjectData(pName);
    const before = data.discussions.length;
    data.discussions = data.discussions.filter(d => {
      if (id)   return d.id   !== id;
      if (name) return d.name !== name;
      return true;
    });
    if (data.discussions.length < before) {
      _dirtyProjects.add(pName);
      markDirty();
      return { deleted: before - data.discussions.length };
    }
  }
  return { deleted: 0 };
}

// ── Auto-operations ───────────────────────────────────────────────────────────

export function archiveExpired(project) {
  init();
  const now = new Date().toISOString();
  let count = 0;
  const processEntries = (entries, projName) => {
    for (const entry of entries) {
      if (entry.expiresAt && entry.expiresAt < now && entry.status !== 'archived') {
        entry.status    = 'archived';
        entry.updatedAt = now;
        _dirtyProjects.add(projName);
        count++;
      }
    }
  };

  if (project) {
    processEntries(getAllEntries(project), project);
  } else {
    const idx = loadProjectsIndex();
    const seen = new Set([..._projectData.keys(), 'global', ...idx.map(p => p.name)]);
    for (const name of seen) processEntries(getAllEntries(name).slice(), name);
  }
  if (count > 0) markDirty();
  return { archived: count };
}

// ── Exports ──────────────────────────────────────────────────────────────────

export function getStorePath() { return DATA_DIR; }
export function getGeneration() { return _generation; }
export function flushStore() { flushToDisk(); }

// ── Auto-compaction ───────────────────────────────────────────────────────────

// COMPACTION_THRESHOLD: shouldCompact's trigger point, and the AI-facing rule
// in every platform template ("at >=20 entries, write a compaction summary").
// COMPACTION_KEEP: how far compactProject drops the count once triggered.
// These used to be the same knob pointed the wrong way (threshold 20, but
// compactProject's own gate required 30) — shouldCompact fired on every save
// from 21..29, so the AI wrote a fresh "type:compaction" summary each time,
// while compactProject silently no-opped until 30, piling up duplicate
// summaries before anything was ever actually removed. Keeping the two
// concepts (trigger vs. how much to drop) explicit, but wired consistently,
// fixes both the stall and the duplicate-summary spam.
const COMPACTION_THRESHOLD = 20;
const COMPACTION_KEEP      = 10;

export function shouldCompact(project) {
  init();
  // Only count non-compaction entries — compaction summaries themselves don't trigger further compaction
  const proj = project || 'global';
  const data = loadProjectData(proj);
  const nonCompaction = [...data.context, ...data.summary].filter(e => e.type !== 'compaction');
  return nonCompaction.length > COMPACTION_THRESHOLD;
}

export function compactProject(project, summaryContent, { skipSummaryEntry = false } = {}) {
  init();
  const proj = project || 'global';
  const data = loadProjectData(proj);
  const now = Date.now();
  const entries = data.context
    .filter(e => e.type !== 'compaction')  // never remove existing compaction summaries
    .sort((a, b) => {
      // Higher score = more expendable; oldest + least important drops first
      const ageDaysA = (now - new Date(a.createdAt || 0).getTime()) / 86_400_000;
      const ageDaysB = (now - new Date(b.createdAt || 0).getTime()) / 86_400_000;
      const scoreA = ageDaysA * 0.7 + (5 - (a.importance ?? 0)) * 0.3;
      const scoreB = ageDaysB * 0.7 + (5 - (b.importance ?? 0)) * 0.3;
      return scoreB - scoreA;
    });
  if (entries.length <= COMPACTION_THRESHOLD) return null;
  // Drop down to COMPACTION_KEEP (well under the threshold) so this doesn't
  // re-trigger on the very next save — keeps the most recent + important ones live.
  const removeCount = entries.length - COMPACTION_KEEP;
  const toRemove = new Set(entries.slice(0, removeCount).map(e => e.id));
  const removed = entries.filter(e => toRemove.has(e.id));
  for (const entry of removed) removeEntryFromData(data, entry);
  _dirtyProjects.add(proj);
  markDirty();
  // If AI already saved a compaction entry this call, don't create a duplicate
  if (skipSummaryEntry) {
    return { removedCount: removed.length, summaryId: null };
  }
  const summary = saveContext({
    project: proj,
    title: `Compacted ${removed.length} entries — ${new Date().toISOString().slice(0, 10)}`,
    content: summaryContent,
    type: 'compaction',
    source: 'auto',
    tags: ['compaction', 'auto'],
  });
  return { removedCount: removed.length, summaryId: summary.id };
}

// ── Graph registry ────────────────────────────────────────────────────────────

export function saveGraph({ path, nodes, edges, communities, cached, changed, time_ms, summary }) {
  init();
  const idx = loadProjectsIndex();
  const proj = idx.find(p => normPath(p.rootPath) === normPath(path));
  const projName = proj ? proj.name : 'global';

  const data = loadProjectData(projName);
  const existing = data.graph.build;
  const record = {
    path,
    nodes:       nodes       ?? existing?.nodes       ?? 0,
    edges:       edges       ?? existing?.edges       ?? 0,
    communities: communities ?? existing?.communities ?? 0,
    cached:      cached      ?? 0,
    changed:     changed     ?? 0,
    time_ms:     time_ms     ?? 0,
    summary:     summary     || existing?.summary     || '',
    builtAt:     new Date().toISOString(),
  };
  data.graph.build = record;
  _dirtyProjects.add(projName);
  markDirty();
  return record;
}

export function getGraph(path) {
  init();
  if (!path) return listGraphs();
  const idx = loadProjectsIndex();
  for (const proj of idx) {
    if (normPath(proj.rootPath) === normPath(path)) {
      return loadProjectData(proj.name).graph.build || null;
    }
  }
  // fallback: scan all loaded data
  for (const [, data] of _projectData.entries()) {
    if (data.graph.build && normPath(data.graph.build.path) === normPath(path))
      return data.graph.build;
  }
  return null;
}

export function listGraphs() {
  init();
  const idx = loadProjectsIndex();
  const results = [];
  const seen = new Set([..._projectData.keys(), ...idx.map(p => p.name)]);
  for (const name of seen) {
    const build = loadProjectData(name).graph.build;
    if (build) results.push(build);
  }
  return results;
}
