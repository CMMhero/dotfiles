// ==============================================================================
// usage-icons.mjs - brand icons for the dashboard.
//
// A set of common ones ships in usage-web-assets/icons, so the page works offline.
// Anything else (a provider or agent nobody listed) is fetched once from the
// lobe-icons set the bundled ones come from (MIT), kept in a local cache and
// served like a bundled one. The mono "currentColor" icons are used, so the page
// colours them the same way.
//
// The cache holds nothing the page cannot rebuild, so it lives with the machine's
// own caches and is never synced: %LOCALAPPDATA%\usage\icons on Windows,
// $XDG_CACHE_HOME/usage/icons (default ~/.cache/usage/icons) elsewhere.
// ==============================================================================

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BUNDLED = path.join(path.dirname(fileURLToPath(import.meta.url)), "usage-web-assets", "icons");
const SOURCE = "https://raw.githubusercontent.com/lobehub/lobe-icons/master/packages/static-svg/icons";
const SLUG = /^[a-z0-9]{3,40}$/;
const MISS_TTL_MS = 60 * 60 * 1000;
const MAX_BYTES = 64 * 1024;

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
 * Makes sure the named icons are on disk when they exist upstream, and returns the
 * full list of available slugs. At most 24 names a call, each fetched once.
 */
export async function ensureIcons(names, { offline = false, cacheDir = iconCacheDir(), fetchImpl = fetch } = {}) {
  if (!offline) {
    const have = new Set(listIcons(cacheDir));
    const wanted = [...new Set(names)].filter((n) => SLUG.test(n) && !have.has(n)).slice(0, 24);
    await Promise.all(wanted.map((slug) => fetchIcon(slug, cacheDir, fetchImpl)));
  }
  return listIcons(cacheDir);
}
