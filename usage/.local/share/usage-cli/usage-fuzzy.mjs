// ==============================================================================
// usage-fuzzy.mjs - typo-tolerant matching for the threads search.
//
// atuin's own search is exact full text: "dashbord" finds nothing and "usg limts"
// needs both words spelled right. This scores each thread's title, folder, branch,
// model, agent and preview against the query and keeps the ones that match, so a
// slip of a key or a half-remembered word still finds the thread.
//
// A query is split into words and every word must match something (AND). A word
// matches a field when, best first:
//   - it is the whole field or starts a word in it (prefix), or is inside a word
//   - its letters appear in order, close together (subsequence, "dshb" in "dashboard")
//   - a word in the field is within one typo of it (swap, miss, extra, wrong letter),
//     only for words of four letters or more so short words stay exact
// Fields count for different amounts: a hit in the title is worth far more than one
// in the preview. Pure functions, no I/O, so they are cheap to test.
// ==============================================================================

const norm = (s) => String(s ?? "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
const WORD = /[a-z0-9]+/g;

// Optimal string alignment distance, capped: cheap because words are short and the
// cap lets it stop as soon as a row is over it.
export function typoDistance(a, b, cap = 1) {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  const prev2 = [];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      row[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > cap) return cap + 1;
    prev2.length = 0;
    prev2.push(...prev);
    prev = row;
  }
  return prev[b.length];
}

// 0 for no match, otherwise a score in (0, 1]: how well one query word fits one field.
export function scoreWord(word, field, words = field.match(WORD) ?? []) {
  if (!word || !field) return 0;
  if (field === word) return 1;
  for (const w of words) if (w === word) return 0.95;
  for (const w of words) if (w.startsWith(word)) return 0.85;
  if (field.includes(word)) return 0.7;
  // Letters in order, within a window: "dshb" in "dashboard". The tighter, the better.
  if (word.length >= 3) {
    let at = -1;
    let first = -1;
    let ok = true;
    for (const ch of word) {
      at = field.indexOf(ch, at + 1);
      if (at < 0) { ok = false; break; }
      if (first < 0) first = at;
    }
    if (ok) {
      const span = at - first + 1;
      if (span <= word.length * 2.2) return 0.5 * (word.length / span) + 0.1;
    }
  }
  if (word.length >= 4) {
    for (const w of words) {
      if (Math.abs(w.length - word.length) <= 1 && typoDistance(word, w, 1) <= 1) return 0.55;
      // a typo in the start of a longer word: "dashbord" against "dashboard"
      if (w.length > word.length && typoDistance(word, w.slice(0, word.length), 1) <= 1) return 0.45;
    }
  }
  return 0;
}

const FIELD_WEIGHT = { title: 3, folder: 2, branch: 1.4, model: 1, harness: 1, preview: 1, reply: 0.5 };

/**
 * Prepares a thread's searchable fields once. Keep the result and pass it to
 * scoreThread for every query.
 */
export function prepare(thread) {
  const fields = {
    title: norm(thread.title),
    folder: norm(String(thread.cwd ?? "").split(/[\\/]/).filter(Boolean).at(-1)),
    branch: norm(thread.branch ?? thread.git_branch),
    model: norm(thread.model),
    harness: norm(thread.harness),
    preview: norm(thread.preview),
    reply: norm(thread.last_reply),
  };
  return Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, { text: v, words: v.match(WORD) ?? [] }]));
}

/** Score of a prepared thread for a query, or 0 when any word finds nothing. */
export function scoreThread(prepared, query) {
  const words = norm(query).match(WORD);
  if (!words?.length) return 0;
  let total = 0;
  for (const word of words) {
    let best = 0;
    for (const [name, field] of Object.entries(prepared)) {
      const s = scoreWord(word, field.text, field.words) * FIELD_WEIGHT[name];
      if (s > best) best = s;
    }
    if (best === 0) return 0;
    total += best;
  }
  return total / words.length;
}

/** The query words that did not match a field exactly, for showing why a thread came up. */
export const queryWords = (query) => norm(query).match(WORD) ?? [];
