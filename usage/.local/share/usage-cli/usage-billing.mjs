// ==============================================================================
// usage-billing.mjs - how each agent on this machine pays for its tokens.
//
// The transcripts already say which provider served a model (anthropic,
// commandcode, opencode, openrouter ...), and that travels in every usage row.
// What a transcript cannot say is whether that provider was reached through a
// subscription login or a metered API key. That is in each tool's own auth
// file, so it is read from there:
//
//   claude    ~/.claude/.credentials.json   OAuth login with subscriptionType =
//                                           subscription (Pro, Max 5x ...);
//                                           otherwise ANTHROPIC_API_KEY, a
//                                           Bedrock or Vertex switch, or an
//                                           apiKeyHelper in settings.json
//   codex     ~/.codex/auth.json            ChatGPT tokens = subscription;
//                                           OPENAI_API_KEY = API key
//   opencode  ~/.local/share/opencode/auth.json   per provider: api or oauth
//   pi        ~/.pi/agent/auth.json               per provider: api_key or oauth
//
// Only the KIND of credential is read. No key, token or account id leaves this
// file. The answer describes this machine's logins, so a row collected on
// another host is labelled only by its provider name.
// ==============================================================================

import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};
const title = (s) => String(s).replace(/^./, (c) => c.toUpperCase());
const sub = (label) => ({ kind: "subscription", label });
const API = { kind: "api", label: "API key" };

function claude(home, env) {
  const out = {};
  const oauth = readJson(path.join(home, ".claude", ".credentials.json"))?.claudeAiOauth;
  const settings = readJson(path.join(home, ".claude", "settings.json")) ?? {};
  const senv = settings.env ?? {};
  if (env.CLAUDE_CODE_USE_BEDROCK || senv.CLAUDE_CODE_USE_BEDROCK) out.bedrock = out.anthropic = { kind: "api", label: "Amazon Bedrock" };
  else if (env.CLAUDE_CODE_USE_VERTEX || senv.CLAUDE_CODE_USE_VERTEX) out.vertex = out.anthropic = { kind: "api", label: "Google Vertex AI" };
  else if (oauth?.subscriptionType) {
    const mult = /(\d+)x/.exec(String(oauth.rateLimitTier ?? ""))?.[1];
    out.anthropic = sub(`Claude ${title(oauth.subscriptionType)}${mult ? ` ${mult}x` : ""} subscription`);
  } else if (env.ANTHROPIC_API_KEY || senv.ANTHROPIC_API_KEY || settings.apiKeyHelper) out.anthropic = API;
  else if (oauth?.accessToken) out.anthropic = { kind: "oauth", label: "Console login" };
  return out;
}

function codex(home, env) {
  const auth = readJson(path.join(home, ".codex", "auth.json"));
  if (!auth) return env.OPENAI_API_KEY && existsSync(path.join(home, ".codex")) ? { openai: API } : {};
  if (auth.tokens?.access_token || auth.tokens?.id_token || auth.auth_mode === "chatgpt") return { openai: sub("ChatGPT subscription") };
  return auth.OPENAI_API_KEY ? { openai: API } : {};
}

// opencode and pi keep one entry per provider: { type, ... }.
function perProvider(file) {
  const out = {};
  for (const [provider, entry] of Object.entries(readJson(file) ?? {})) {
    const type = String(entry?.type ?? "");
    out[provider] = /oauth/.test(type) ? { kind: "oauth", label: "Account login" } : /api/.test(type) ? API : { kind: "unknown", label: type || "unknown" };
  }
  return out;
}

let cache = null;
// { "<harness>|<provider>": { kind, label } } for the agents installed here.
export function detectBilling({ home = os.homedir(), env = process.env } = {}) {
  if (cache && Date.now() - cache.at < 60_000) return cache.value;
  const value = {};
  const put = (harness, map) => { for (const [provider, info] of Object.entries(map)) value[`${harness}|${provider}`] = info; };
  put("claude", claude(home, env));
  put("codex", codex(home, env));
  put("opencode", perProvider(path.join(home, ".local", "share", "opencode", "auth.json")));
  const pi = perProvider(path.join(home, ".pi", "agent", "auth.json"));
  put("pi", pi);
  put("omp", perProvider(path.join(home, ".omp", "agent", "auth.json")));
  cache = { at: Date.now(), value };
  return value;
}
