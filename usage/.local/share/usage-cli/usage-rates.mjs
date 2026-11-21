// ==============================================================================
// usage-rates.mjs - USD exchange rates for showing prices in another currency.
//
// Every figure the dashboard computes is in US dollars (that is what the price
// tables are in). Showing rupiah, euro and so on is a multiplication at display
// time, so the only thing needed is a current USD -> X rate. It comes from
// open.er-api.com, which needs no key and publishes mid-market rates for about 160
// currencies, refreshed once a day (so "realtime" here means the latest published
// rate, re-fetched at most once an hour); api.frankfurter.dev (ECB reference rates)
// is the fallback. The last good answer is kept next to the icon cache, so a machine
// that goes offline keeps converting with the rate it last had, marked stale.
// ==============================================================================

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { iconCacheDir } from "./usage-icons.mjs";

const TTL_MS = 60 * 60 * 1000;
const FILE = () => path.join(path.dirname(iconCacheDir()), "rates.json");

let memory = null; // { at, value }

function readDisk() {
  try {
    return JSON.parse(readFileSync(FILE(), "utf8"));
  } catch {
    return null;
  }
}

async function fromErApi(fetchImpl) {
  const response = await fetchImpl("https://open.er-api.com/v6/latest/USD", { signal: AbortSignal.timeout(10_000) });
  const body = await response.json();
  if (body?.result !== "success" || !body.rates?.USD) throw new Error("er-api gave no rates");
  return { base: "USD", rates: body.rates, asOf: body.time_last_update_utc ? new Date(body.time_last_update_utc).toISOString() : new Date().toISOString(), source: "open.er-api.com" };
}

async function fromFrankfurter(fetchImpl) {
  const response = await fetchImpl("https://api.frankfurter.dev/v1/latest?base=USD", { signal: AbortSignal.timeout(10_000) });
  const body = await response.json();
  if (!body?.rates) throw new Error("frankfurter gave no rates");
  return { base: "USD", rates: { USD: 1, ...body.rates }, asOf: new Date(`${body.date}T16:00:00Z`).toISOString(), source: "frankfurter.dev (ECB)" };
}

/**
 * { base: "USD", rates: { IDR: 16250, ... }, asOf, source, stale } or null when no
 * rate has ever been fetched on this machine. offline serves the saved copy only.
 */
export async function usdRates({ offline = false, fetchImpl = fetch, now = Date.now() } = {}) {
  if (memory && now - memory.at < TTL_MS) return memory.value;
  if (!offline) {
    for (const source of [fromErApi, fromFrankfurter]) {
      try {
        const value = { ...(await source(fetchImpl)), stale: false };
        mkdirSync(path.dirname(FILE()), { recursive: true });
        writeFileSync(FILE(), JSON.stringify(value));
        memory = { at: now, value };
        return value;
      } catch { /* try the next source */ }
    }
  }
  const saved = readDisk();
  const value = saved ? { ...saved, stale: true } : null;
  if (value) memory = { at: now - TTL_MS + 5 * 60_000, value }; // look again in 5 minutes
  return value;
}
