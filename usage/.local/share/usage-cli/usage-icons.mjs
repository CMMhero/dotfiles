// ==============================================================================
// usage-icons.mjs - brand icons for the dashboard.
//
// A set of common ones ships in usage-web-assets/icons, so the page works offline.
// Anything else (a provider or agent nobody listed) is fetched once from the
// lobe-icons set the bundled ones come from (MIT), kept in a local cache and
// served like a bundled one. The mono "currentColor" icons are used, so the page
// colours them the same way.
//
// A name is matched to an icon in three steps: the alias table below (vendor names
// that differ from the icon's, like "xiaomi" for "xiaomimimo"), the exact icon name,
// then a prefix match against the full upstream index ("opencodezen" -> "opencode",
// "xiaomi" -> "xiaomimimo"). The index is fetched once a day and kept beside the cache.
//
// The cache holds nothing the page cannot rebuild, so it lives with the machine's
// own caches and is never synced: %LOCALAPPDATA%\usage\icons on Windows,
// $XDG_CACHE_HOME/usage/icons (default ~/.cache/usage/icons) elsewhere.
// ==============================================================================

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BUNDLED = path.join(path.dirname(fileURLToPath(import.meta.url)), "usage-web-assets", "icons");
const SOURCE = "https://raw.githubusercontent.com/lobehub/lobe-icons/master/packages/static-svg/icons";
const SLUG = /^[a-z0-9]{3,40}$/;
const MISS_TTL_MS = 60 * 60 * 1000;
const MAX_BYTES = 64 * 1024;


// Vendor and provider names as models and transcripts spell them (letters and
// digits only) -> the icon that carries that brand.
const ALIASES = {
  xiaomi: "xiaomimimo", mimo: "xiaomimimo", xiaomimimo: "xiaomimimo",
  metallama: "meta", llama: "meta", muse: "meta", musespark: "meta", metaai: "meta",
  mistralai: "mistral", moonshotai: "moonshot", kimi: "kimi", moonshot: "moonshot",
  zai: "zai", zhipu: "zhipu", thudm: "zhipu", glm: "zhipu", zhipuai: "zhipu",
  xai: "xai", grok: "grok", openaicodex: "openai", codex: "codex", gpt: "openai",
  opencodezen: "opencode", opencodego: "opencode", zen: "opencode",
  anthropic: "anthropic", google: "gemini", googleai: "gemini", gemma: "gemma",
  amazon: "aws", amazonbedrock: "bedrock", azureopenai: "azure", microsoft: "microsoft",
  stepfun: "stepfun", stepfunai: "stepfun", arceeai: "arcee", nousresearch: "nousresearch",
  deepseekai: "deepseek", qwen: "qwen", alibaba: "alibaba", tencent: "tencent", baidu: "baidu",
  meituan: "longcat", longcat: "longcat", inclusionai: "ling", ant: "antgroup", bytedance: "bytedance", bytedanceseed: "bytedance",
  nvidia: "nvidia", ibm: "ibm", ibmgranite: "ibm", liquid: "liquid", inception: "inception", cohere: "cohere",
  perplexity: "perplexity", minimax: "minimax", openrouter: "openrouter", commandcode: "commandcode",
};

const INDEX_FILE = (cacheDir) => path.join(cacheDir, "index.json");
const INDEX_TTL_MS = 24 * 60 * 60 * 1000;
const NOT_MONO = /-(color|text|brand|avatar|brand-color|text-cn)$/;

// Every icon name upstream has, from the package listing on a CDN, cached for a day.
async function upstreamIndex(cacheDir, fetchImpl) {
  try {
    const file = INDEX_FILE(cacheDir);
    if (Date.now() - statSync(file).mtimeMs < INDEX_TTL_MS) return JSON.parse(readFileSync(file, "utf8"));
  } catch { /* none yet, or stale */ }
  try {
    // The listing needs a concrete version, so the latest one is looked up first.
    const meta = await (await fetchImpl("https://data.jsdelivr.com/v1/packages/npm/@lobehub/icons-static-svg", { signal: AbortSignal.timeout(8_000) })).json();
    const version = meta.tags?.latest ?? meta.versions?.[0]?.version;
    const response = await fetchImpl(`https://data.jsdelivr.com/v1/packages/npm/@lobehub/icons-static-svg@${version}?structure=flat`, { signal: AbortSignal.timeout(8_000) });
    const files = (await response.json()).files ?? [];
    const names = files.map((f) => /^\/icons\/([a-z0-9-]+)\.svg$/.exec(f.name)?.[1]).filter((n) => n && !NOT_MONO.test(n));
    if (names.length > 50) {
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(INDEX_FILE(cacheDir), JSON.stringify(names));
      return names;
    }
  } catch { /* offline: what is on disk is the index */ }
  return null;
}

// candidate (letters and digits) -> an icon name, or null.
export function resolveSlug(candidate, known) {
  const c = String(candidate).toLowerCase().replace(/[^a-z0-9]/g, "");
  if (c.length < 3) return null;
  const names = new Set(known);
  if (ALIASES[c] && (names.has(ALIASES[c]) || known.length === 0)) return ALIASES[c];
  if (names.has(c)) return c;
  const list = [...names].filter((n) => !n.includes("-"));
  const longer = list.filter((n) => c.length >= 5 && n.startsWith(c)).sort((a, b) => a.length - b.length)[0]; // "xiaomi" -> "xiaomimimo"
  if (longer) return longer;
  return list.filter((n) => n.length >= 4 && c.startsWith(n)).sort((a, b) => b.length - a.length)[0] ?? null; // "opencodezen" -> "opencode"
}

const misses = new Map(); // slug -> when it was not found, so a missing icon is not asked for again for an hour

export function iconCacheDir(env = process.env, platform = process.platform) {
  if (platform === "win32") return path.join(env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "usage", "icons");
  return path.join(env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "usage", "icons");
}

const slugsIn = (dir) => {
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".svg")).map((f) => f.slice(0, -4));
  } catch {
    return [];
  }
};

export const listIcons = (cacheDir = iconCacheDir()) => [...new Set([...slugsIn(BUNDLED), ...slugsIn(cacheDir)])].sort();

// The file for a slug, bundled first. The slug pattern keeps it inside the two folders.
export function readIcon(slug, cacheDir = iconCacheDir()) {
  if (!/^[a-z0-9-]{1,40}$/.test(slug)) return null;
  for (const dir of [BUNDLED, cacheDir]) {
    try {
      return readFileSync(path.join(dir, `${slug}.svg`));
    } catch { /* try the next folder */ }
  }
  return null;
}

// Only a plain vector drawing is kept. A downloaded file is served from this
// origin, so anything that could run script when opened directly is refused, and
// the 1em sizing the set uses is replaced with the 24px the bundled ones have.
export function cleanSvg(text) {
  const svg = String(text).trim();
  if (!svg.startsWith("<svg") || svg.length > MAX_BYTES) return null;
  if (/<script|<foreignObject|<iframe|<image|javascript:|\son[a-z]+\s*=|xlink:href\s*=\s*["']?(?!#)|<!ENTITY/i.test(svg)) return null;
  return svg
    .replace(/\sstyle="[^"]*"/, "")
    .replace(/\sheight="1em"/, ' height="24"')
    .replace(/\swidth="1em"/, ' width="24"');
}

async function fetchIcon(slug, cacheDir, fetchImpl) {
  const hit = misses.get(slug);
  if (hit && Date.now() - hit < MISS_TTL_MS) return false;
  try {
    const response = await fetchImpl(`${SOURCE}/${slug}.svg`, { signal: AbortSignal.timeout(6_000) });
    const svg = response.ok ? cleanSvg(await response.text()) : null;
    if (!svg) { misses.set(slug, Date.now()); return false; }
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(path.join(cacheDir, `${slug}.svg`), svg);
    return true;
  } catch {
    // Offline or GitHub unreachable: not a verdict on the icon, so it is asked for again next time.
    return false;
  }
}

/**
 * Resolves each name (letters and digits) to an icon, fetching the ones that are
 * missing, and returns { available, resolved } where resolved maps a name to the
 * icon that stands for it. At most 24 names a call.
 */
export async function ensureIcons(names, { offline = false, cacheDir = iconCacheDir(), fetchImpl = fetch } = {}) {
  const wanted = [...new Set(names.map((n) => String(n).toLowerCase().replace(/[^a-z0-9]/g, "")))].filter((n) => n.length >= 3).slice(0, 24);
  const local = listIcons(cacheDir);
  const index = offline ? null : await upstreamIndex(cacheDir, fetchImpl);
  const known = [...new Set([...local, ...(index ?? [])])];
  const resolved = {};
  for (const name of wanted) {
    const slug = resolveSlug(name, known);
    if (slug) resolved[name] = slug;
  }
  if (!offline) {
    const have = new Set(local);
    await Promise.all([...new Set(Object.values(resolved))].filter((slug) => !have.has(slug) && /^[a-z0-9]{3,40}$/.test(slug)).map((slug) => fetchIcon(slug, cacheDir, fetchImpl)));
  }
  return { available: listIcons(cacheDir), resolved };
}
