// ==============================================================================
// usage-models.mjs - what each model costs and how it scores, next to how much
// of it you used.
//
// One public source: OpenRouter's model list. Besides prices it carries the
// context window, the output limit, input modalities, and a `benchmarks` block
// with the Artificial Analysis indexes (intelligence, coding, agentic) and Design
// Arena Elo scores. Nothing here is scraped and no key is needed. The list is
// cached in the usage share as catalog.json for a day.
//
// "Used" models come from the same merged rows as the rest of the dashboard, so
// the usage columns agree with the Usage view. A model the logs name that
// OpenRouter does not list still appears, with its usage and no catalog data:
// a missing benchmark is shown as missing, never guessed.
//
// ==============================================================================

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { normalizeId, usageDir } from "./usage.mjs";
import { summarize } from "./usage-summary.mjs";

const OPENROUTER_MODELS = "https://openrouter.ai/api/v1/models";
const TTL_MS = 24 * 60 * 60 * 1000; // server start: refresh in the background past this
const OPEN_TTL_MS = 10 * 60 * 1000; // opening the Models view: refetch past this
const FORCE_FLOOR_MS = 30 * 1000; // the reload button: refetch, but not more often than this

const catalogFile = () => path.join(usageDir(), "catalog.json");

function readCatalog() {
  try {
    return JSON.parse(readFileSync(catalogFile(), "utf8"));
  } catch {
    return null;
  }
}

const perMillion = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n * 1_000_000 : null;
};
const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);

function benchmarks(raw) {
  if (!raw) return null;
  const aa = raw.artificial_analysis ?? {};
  const arena = Array.isArray(raw.design_arena) ? raw.design_arena : [];
  const elo = (kind, category) => arena.filter((r) => r.arena === kind && (!category || r.category === category)).map((r) => r.elo).filter(Number.isFinite);
  const out = {
    intelligence: aa.intelligence_index ?? null,
    coding: aa.coding_index ?? null,
    agentic: aa.agentic_index ?? null,
    arenaModels: mean(elo("models")),
    arenaCode: mean(elo("models", "codecategories")),
    arenaAgents: mean(elo("agents")),
  };
  return Object.values(out).some((v) => v !== null) ? out : null;
}

export async function refreshCatalog() {
  const response = await fetch(OPENROUTER_MODELS, { headers: { "User-Agent": "usage-dashboard" }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`OpenRouter returned ${response.status}`);
  const body = await response.json();
  const models = [];
  for (const m of body.data ?? []) {
    if (/:batch$/.test(m.id)) continue; // same model, batch pricing
    const p = m.pricing ?? {};
    const input = perMillion(p.prompt);
    models.push({
      id: m.id,
      name: m.name ?? m.id,
      vendor: m.id.split("/")[0],
      created: m.created ? new Date(m.created * 1000).toISOString().slice(0, 10) : null,
      context: m.context_length ?? m.top_provider?.context_length ?? null,
      maxOutput: m.top_provider?.max_completion_tokens ?? null,
      inputs: m.architecture?.input_modalities ?? [],
      reasoning: Array.isArray(m.supported_parameters) && m.supported_parameters.includes("reasoning"),
      tools: Array.isArray(m.supported_parameters) && m.supported_parameters.includes("tools"),
      knowledge: m.knowledge_cutoff ?? null,
      price: { input, output: perMillion(p.completion), cacheRead: perMillion(p.input_cache_read), cacheWrite: perMillion(p.input_cache_write) },
      bench: benchmarks(m.benchmarks),
    });
  }
  const file = catalogFile();
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ source: "openrouter", fetchedAt: new Date().toISOString(), models })}\n`);
  renameSync(temp, file);
  return { count: models.length, file };
}

export function catalogIsStale() {
  const at = Date.parse(readCatalog()?.fetchedAt);
  return !Number.isFinite(at) || Date.now() - at > TTL_MS;
}

// Log names and catalog ids differ in vendor prefix, punctuation and the free
// suffix (`claude-opus-5-5` vs `anthropic/claude-opus-5.5`). Both sides are
// reduced with usage.mjs's own normalizer, so a model is matched here by the same
// rule that prices it. Among several catalog entries with one normal form the
// paid one wins, because it is the one that carries benchmarks.
function matcher(models) {
  const byNorm = new Map();
  for (const m of models) {
    const norm = normalizeId(m.id);
    const seen = byNorm.get(norm);
    if (!seen || (/:free$/.test(seen.id) && !/:free$/.test(m.id))) byNorm.set(norm, m);
  }
  const norms = [...byNorm.keys()];
  return (name) => {
    const norm = normalizeId(name);
    if (!norm) return null;
    if (byNorm.has(norm)) return byNorm.get(norm);
    if (norm.length < 6) return null;
    const prefixed = norms.filter((key) => key.startsWith(norm));
    return prefixed.length === 1 ? byNorm.get(prefixed[0]) : null;
  };
}

// The list is refetched when the Models view is opened and the cache is more than
// ten minutes old, and whenever the reload button is pressed (at most once per 30
// seconds). The request waits for the fetch, so what is shown is what was just
// fetched. If OpenRouter cannot be reached the cached list is shown with a note:
// an old price list is better than an empty page.
let refreshing = null;
export async function modelsReport(filters = {}, { offline = false, fresh = false } = {}) {
  let catalog = readCatalog();
  let note = null;
  const age = Date.now() - (Date.parse(catalog?.fetchedAt) || 0);
  if (!offline && (!catalog || age > (fresh ? FORCE_FLOOR_MS : OPEN_TTL_MS))) {
    refreshing ??= refreshCatalog().finally(() => { refreshing = null; });
    try {
      await refreshing;
      catalog = readCatalog();
    } catch (error) {
      note = catalog ? `Could not refresh the model list (${error.message}); showing the copy from ${catalog.fetchedAt.slice(0, 16).replace("T", " ")} UTC.` : `Could not fetch the model list: ${error.message}`;
    }
  }
  const models = catalog?.models ?? [];
  const match = matcher(models);

  const used = new Map();
  for (const row of summarize(filters).models) {
    let entry = used.get(row.model);
    if (!entry) {
      entry = { model: row.model, agents: [], providers: [], tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0, sessions: 0, cost: 0, unpricedRows: 0, activeMs: 0 };
      used.set(row.model, entry);
    }
    entry.agents.push(row.agent);
    if (row.provider && !entry.providers.includes(row.provider)) entry.providers.push(row.provider);
    for (const key of ["tokens", "input", "output", "cacheRead", "cacheWrite", "messages", "sessions", "cost", "unpricedRows", "activeMs"]) entry[key] += row[key] ?? 0;
  }
  const usedList = [...used.values()].map((u) => {
    const prompt = u.input + u.cacheRead + u.cacheWrite;
    return {
      ...u,
      catalogId: match(u.model)?.id ?? null,
      free: /(^|[/])free$|[:/-]free(?=[/:._-]|$)/i.test(u.model),
      cacheHitRate: prompt ? u.cacheRead / prompt : null,
      costPerMessage: u.messages && !u.unpricedRows ? u.cost / u.messages : null,
    };
  }).sort((a, b) => b.tokens - a.tokens);

  return { fetchedAt: catalog?.fetchedAt ?? null, source: "OpenRouter model list (prices, limits, Artificial Analysis and Design Arena scores)", offline, note: note ?? (catalog ? null : "No model list cached yet. Start without --offline once to fetch it."), used: usedList, catalog: models };
}
