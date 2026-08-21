import { getContext, searchContext } from './db.js';
import { vectorSearch, findRelated } from './vector.js';

// ── Vocabulary cache (lazy singleton per process) ─────────────────────────────

let _vocabCache = null;

function buildVocab(entries) {
  const vocab = new Set();
  for (const e of entries) {
    const text = `${e.title || ''} ${e.content || ''}`.toLowerCase();
    for (const w of text.split(/\W+/)) {
      if (w.length > 2) vocab.add(w);
    }
  }
  return vocab;
}

// ── Levenshtein fuzzy correction ──────────────────────────────────────────────

function levenshtein(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const curr = [i + 1];
    for (let j = 0; j < b.length; j++) {
      curr.push(Math.min(prev[j + 1] + 1, curr[j] + 1, prev[j] + (a[i] === b[j] ? 0 : 1)));
    }
    prev.splice(0, prev.length, ...curr);
  }
  return prev[b.length];
}

function maxEditDist(len) {
  if (len <= 4) return 1;
  if (len <= 12) return 2;
  return 3;
}

function fuzzyCorrect(word, vocab) {
  const max = maxEditDist(word.length);
  let bestWord = word;
  let bestDist = max + 1;
  for (const candidate of vocab) {
    if (Math.abs(candidate.length - word.length) > max) continue;
    const dist = levenshtein(word, candidate);
    if (dist < bestDist) { bestDist = dist; bestWord = candidate; }
  }
  return bestDist <= max ? bestWord : word;
}

// ── Smart snippet (window centered on first match position) ───────────────────

function snippet(text, terms, windowSize = 200) {
  if (!text) return text;
  const lower = text.toLowerCase();
  let bestPos = -1;
  for (const term of terms) {
    const idx = lower.indexOf(term.toLowerCase());
    if (idx !== -1 && (bestPos === -1 || idx < bestPos)) bestPos = idx;
  }
  if (bestPos === -1) return text.slice(0, windowSize);
  const start = Math.max(0, bestPos - Math.floor(windowSize / 3));
  const end = Math.min(text.length, start + windowSize);
  return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
}

// ── Unified search ────────────────────────────────────────────────────────────

/**
 * @param {Object} opts
 * @param {string} opts.query      - search query (keyword/semantic)
 * @param {string} [opts.mode]     - 'keyword' | 'semantic' | 'related' (default: semantic)
 * @param {string} [opts.project]  - scope to project
 * @param {number} [opts.limit]    - max results (default 10)
 * @param {string} [opts.id]       - [related] entry ID
 * @param {boolean} [opts.compact] - return compact previews
 */
export function search({ query, mode = 'semantic', project, limit = 10, id, compact = false }) {
  switch (mode) {
    case 'keyword': {
      if (!query) throw new Error('query required for keyword search');
      if (!_vocabCache) {
        _vocabCache = buildVocab(getContext({ project, limit: 500 }));
      }
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
      const corrected = terms.map(t => fuzzyCorrect(t, _vocabCache));
      const correctedQuery = corrected.join(' ');
      const results = searchContext({ query: correctedQuery, project, limit, compact: false });
      return results.map(e => ({ ...e, content: snippet(e.content, corrected) }));
    }
    case 'semantic': {
      if (!query) throw new Error('query required for semantic search');
      const corpus = getContext({ project, limit: 500 });
      return vectorSearch(query, corpus, limit);
    }
    case 'related': {
      if (!id) throw new Error('id required for related search');
      const all = getContext({ limit: 1000 });
      const target = all.find(e => e.id === id || e.id.startsWith(id));
      if (!target) throw new Error(`No entry found with id starting "${id}"`);
      // ponytail: relations/relatedBy never populated — pure semantic fallback
      const others = all.filter(e => e.id !== target.id);
      const results = findRelated(target, others, limit);
      return { target, results };
    }
    default:
      throw new Error(`Unknown search mode: ${mode}. Use: keyword, semantic, related`);
  }
}
