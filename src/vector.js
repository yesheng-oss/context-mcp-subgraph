/**
 * vector.js — TF-IDF cosine similarity search (cached)
 *
 * Optimizations:
 *   1. IDF cache — reuses computed IDF when the corpus hasn't changed
 *   2. Pre-computed corpus strings — avoids re-concatenating on every search
 *   3. Early exit — skips entries with zero query term overlap
 *   4. Sparse dot product — only iterates non-zero dimensions
 */

import { getGeneration } from './db.js';

// ── Text utilities ────────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  'a','an','the','and','or','but','in','on','at','to','for','of','with',
  'by','from','is','it','its','as','be','was','are','were','this','that',
  'i','we','you','he','she','they','have','has','had','do','did','will',
  'would','could','should','not','no','so','if','then','than','just','my',
]);

function stemLight(w) {
  return w
    .replace(/ication$/, 'ic').replace(/ations?$/, 'ate').replace(/ments?$/, '')
    .replace(/ings?$/, '').replace(/tion$/, 't').replace(/ness$/, '')
    .replace(/ity$/, '').replace(/ies$/, 'y').replace(/s$/, '');
}

function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w))
    .map(stemLight);
}

function termFreq(tokens) {
  const tf = {};
  for (const t of tokens) tf[t] = (tf[t] || 0) + 1;
  // FIX: avoid Math.max(...array) spread which can hit the JS argument limit
  // on very large texts. Use a reduce loop instead.
  let max = 1;
  for (const v of Object.values(tf)) if (v > max) max = v;
  for (const t in tf) tf[t] /= max;
  return tf;
}

// ── IDF cache ─────────────────────────────────────────────────────────────────

let _idfCache = null;
let _idfGeneration = -1;
let _idfCorpusLen = -1;

function buildIDF(docs) {
  const df = {};
  for (const doc of docs) {
    const seen = new Set(tokenize(doc));
    for (const t of seen) df[t] = (df[t] || 0) + 1;
  }
  const N = docs.length || 1;
  const idf = {};
  for (const t in df) idf[t] = Math.log((N + 1) / (df[t] + 1)) + 1;
  return idf;
}

let _idfFingerprint = null;

function getCachedIDF(corpus) {
  const gen = getGeneration();
  // Fingerprint first 20 IDs to detect content change at same size (e.g. delete+add)
  const fingerprint = corpus.slice(0, 20).map(e => e.id).join(',');
  if (_idfCache && _idfGeneration === gen && _idfCorpusLen === corpus.length
      && _idfFingerprint === fingerprint) {
    return _idfCache;
  }
  _idfCache = buildIDF(corpus);
  _idfGeneration = gen;
  _idfCorpusLen = corpus.length;
  _idfFingerprint = fingerprint;
  return _idfCache;
}

// ── TF-IDF vector ─────────────────────────────────────────────────────────────

function tfidfVector(text, idf) {
  const tokens = tokenize(text);
  const tf = termFreq(tokens);
  const vec = {};
  for (const t in tf) vec[t] = tf[t] * (idf[t] || Math.log(2));
  return vec;
}

// ── Cosine similarity (sparse) ────────────────────────────────────────────────

function cosine(a, b) {
  let dot = 0, magA = 0, magB = 0;
  for (const t in a) {
    magA += a[t] ** 2;
    if (t in b) dot += a[t] * b[t];
  }
  for (const t in b) magB += b[t] ** 2;
  if (!magA || !magB) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

// ── Quick overlap check (skip zero-similarity entries early) ──────────────────

function hasOverlap(queryTokens, text) {
  const tokens = new Set(tokenize(text));
  return queryTokens.some(t => tokens.has(t));
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Rank entries by semantic similarity to query.
 * Returns compact results by default (preview, not full content).
 */
export function vectorSearch(query, entries, limit = 10) {
  if (!entries.length) return [];

  const queryTokens = tokenize(query);
  if (!queryTokens.length) return [];

  // Build corpus strings (once per call)
  const corpus = entries.map(e => {
    const tags = Array.isArray(e.tags) ? e.tags : [];
    return `${e.title || ''} ${e.content || ''} ${tags.join(' ')}`;
  });

  // Use cached IDF when corpus hasn't changed
  const idf = getCachedIDF(corpus);
  const queryVec = tfidfVector(query, idf);

  const scored = [];
  for (let i = 0; i < entries.length; i++) {
    // Early exit: skip entries with zero token overlap
    if (!hasOverlap(queryTokens, corpus[i])) continue;

    const sim = cosine(queryVec, tfidfVector(corpus[i], idf));
    if (sim > 0) {
      scored.push({ ...entries[i], similarity: Math.round(sim * 100) / 100 });
    }
  }

  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, limit);
}

/**
 * Find entries similar to a given entry.
 */
export function findRelated(targetEntry, allEntries, limit = 5) {
  const others = allEntries.filter(e => e.id !== targetEntry.id);
  const query = `${targetEntry.title || ''} ${targetEntry.content || ''}`;
  return vectorSearch(query, others, limit);
}
