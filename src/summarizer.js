/**
 * summarizer.js — session auto-summarizer
 *
 * Groups recent context entries by project and tag, then produces
 * a structured Markdown summary you can save back as a single entry.
 *
 * Uses extractive summarization (no LLM needed):
 *   1. Score sentences by TF-IDF weight against the session's corpus
 *   2. Pick top N sentences in original order
 *   3. Format as structured Markdown
 */

import { vectorSearch } from './vector.js';

// ── Sentence scoring ──────────────────────────────────────────────────────────

function sentences(text) {
  return String(text || '')
    .replace(/\n+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 20);
}

const STOP = new Set([
  'a','an','the','and','or','but','in','on','at','to','for','of','with',
  'by','from','is','it','its','as','be','was','are','this','that','i','we',
]);

function tokens(text) {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter(w => w.length > 2 && !STOP.has(w));
}

function scoreEntry(entry, corpusTokenFreq) {
  const toks = tokens(`${entry.title || ''} ${entry.content || ''}`);
  if (!toks.length) return 0;
  return toks.reduce((s, t) => s + (corpusTokenFreq[t] || 0), 0) / toks.length;
}

function buildFreq(entries) {
  const freq = {};
  for (const e of entries) {
    for (const t of tokens(`${e.title || ''} ${e.content || ''}`)) {
      freq[t] = (freq[t] || 0) + 1;
    }
  }
  return freq;
}

// ── Group by tag ──────────────────────────────────────────────────────────────

function groupByTag(entries) {
  const groups = {};
  for (const e of entries) {
    const tags = Array.isArray(e.tags) ? e.tags : [];
    const primaryTag = tags[0] || 'general';
    if (!groups[primaryTag]) groups[primaryTag] = [];
    groups[primaryTag].push(e);
  }
  return groups;
}

// ── Build Markdown summary ────────────────────────────────────────────────────

/**
 * Summarize a set of context entries into structured Markdown.
 *
 * @param {Array} entries - context entries to summarize
 * @param {Object} opts
 * @param {string} opts.project
 * @param {string} opts.sessionLabel  - e.g. "2025-01-15 morning session"
 * @param {number} opts.topN          - top entries per group (default 3)
 * @returns {string} Markdown summary
 */
export function summarizeEntries(entries, { project = 'global', sessionLabel = '', topN = 3 } = {}) {
  if (!entries.length) return '_No entries to summarize._';

  const freq = buildFreq(entries);
  const label = sessionLabel || new Date().toISOString().slice(0, 10);
  const groups = groupByTag(entries);

  const lines = [
    `## Session summary — ${project} · ${label}`,
    '',
    `**${entries.length} context entries** across ${Object.keys(groups).length} topic(s).`,
    '',
  ];

  for (const [tag, group] of Object.entries(groups)) {
    lines.push(`### ${tag}`);
    // Score and pick top N
    const ranked = group
      .map(e => ({ ...e, _score: scoreEntry(e, freq) }))
      .sort((a, b) => b._score - a._score)
      .slice(0, topN);

    for (const e of ranked) {
      lines.push(`- **${e.title || e.id.slice(0, 8)}** _(${e.source || 'user'}, ${(e.createdAt || '').slice(0, 10)})_`);
      // Extract most informative sentence
      const sents = sentences(e.content);
      const best = sents.sort((a, b) =>
        tokens(b).reduce((s, t) => s + (freq[t] || 0), 0) -
        tokens(a).reduce((s, t) => s + (freq[t] || 0), 0)
      )[0];
      if (best) lines.push(`  ${best.length > 140 ? best.slice(0, 137) + '...' : best}`);
    }

    if (group.length > topN) {
      lines.push(`  _…and ${group.length - topN} more ${tag} entries_`);
    }
    lines.push('');
  }

  // Key terms
  const topTerms = Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([t]) => `\`${t}\``);
  lines.push(`**Key terms:** ${topTerms.join(', ')}`);

  return lines.join('\n');
}

