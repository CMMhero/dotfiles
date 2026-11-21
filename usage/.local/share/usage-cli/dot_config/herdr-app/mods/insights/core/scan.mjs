import { createHash } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { open, readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import * as zlib from "node:zlib";
import { parseAdapterRecord, parseClineMessages } from "./adapters.mjs";
import { readConversation } from "./antigravity.mjs";
import {
  MAX_LINE_BYTES,
  expandHome,
  isPlainObject,
  localDay,
} from "./util.mjs";
import {
  addTask,
  addUsage,
  dedupKeyFor,
  fileKey,
  newFileEntry,
  prepareStore,
  removeLatestFallbackTaskForSession,
  resetFileEntry,
  taskKeyFor,
} from "./store.mjs";

const CHUNK_BYTES = 256 * 1024;
const MAX_WARNINGS = 50;
const MAX_TRAVERSAL_ENTRIES = 250_000;
const PARSER_VERSIONS = { pi: 3, omp: 1, codex: 5, claude: 2 };

function warningSink(warnings, stats, sourceState) {
  let hidden = 0;
  let reportedHidden = false;
  return {
    warn(message, sourceId) {
      stats.errors += 1;
      if (sourceId && sourceState?.[sourceId]) sourceState[sourceId].errors += 1;
      if (warnings.length < MAX_WARNINGS) warnings.push(message);
      else hidden += 1;
    },
    note(message) {
      if (warnings.length < MAX_WARNINGS) warnings.push(message);
    },
    finish() {
      if (hidden > 0 && !reportedHidden) {
        reportedHidden = true;
        warnings.push(`${hidden} additional scan warnings were not shown.`);
      }
    },
  };
}

function isEligible(adapter, filePath) {
  if (adapter === "opencode") return path.basename(filePath) === "opencode.db";
  if (adapter === "cline") return filePath.endsWith(".messages.json");
  if (adapter === "antigravity") return filePath.endsWith(".db");
  if (adapter === "codex") {
    return filePath.endsWith(".jsonl") || filePath.endsWith(".jsonl.zst");
  }
  return filePath.endsWith(".jsonl");
}

async function walkRoot(root, adapter) {
  const files = [];
  let unavailable = false;
  let fatal = null;
  let traversed = 0;
  let canonical;
  try {
    canonical = await realpath(root);
    const rootStat = await stat(canonical);
    if (rootStat.isFile()) {
      return { files: isEligible(adapter, canonical) ? [canonical] : [], sortBase: root };
    }
  } catch (error) {
    if (error?.code === "ENOENT") return { files: [], sortBase: root, unavailable: true };
    return { files: [], sortBase: root, fatal: error };
  }

  const stack = [canonical];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      fatal = fatal ?? error;
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      traversed += 1;
      if (traversed > MAX_TRAVERSAL_ENTRIES) {
        fatal = new Error(`root ${root} exceeds ${MAX_TRAVERSAL_ENTRIES} entries`);
        break;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && isEligible(adapter, entry.name)) {
        files.push(full);
      } else if (entry.isSymbolicLink()) {
        // Do not follow directory symlinks (loops); a symlinked file is harmless.
        try {
          const linkStat = await stat(full);
          if (linkStat.isFile() && isEligible(adapter, full)) files.push(full);
        } catch {
          // Broken links are simply not transcript files.
        }
      }
    }
    if (traversed > MAX_TRAVERSAL_ENTRIES) break;
  }
  return { files, sortBase: canonical, unavailable, fatal };
}

export async function discoverFiles(config, home, sink, sourceState) {
  const discovered = [];
  for (let sourceIndex = 0; sourceIndex < config.sources.length; sourceIndex += 1) {
    const source = config.sources[sourceIndex];
    const state = sourceState[source.id];
    if (!source.enabled) continue;
    for (let rootIndex = 0; rootIndex < source.roots.length; rootIndex += 1) {
      const root = expandHome(source.roots[rootIndex], home);
      if (!root) continue;
      const result = await walkRoot(root, source.adapter);
      if (result.unavailable) {
        sink.note(
          `[${source.id}] source ${source.id}: root ${source.roots[rootIndex]} is not available.`,
        );
      } else if (result.fatal) {
        sink.warn(
          `[${source.id}] source ${source.id}: cannot read root ${source.roots[rootIndex]}: ${result.fatal.message}`,
          source.id,
        );
      } else {
        state.rootsAvailable += 1;
      }
      for (const file of result.files) {
        discovered.push({
          source,
          sourceIndex,
          rootIndex,
          file,
          sortBase: result.sortBase,
        });
      }
    }
  }
  discovered.sort(
    (a, b) =>
      a.sourceIndex - b.sourceIndex ||
      a.rootIndex - b.rootIndex ||
      a.file.localeCompare(b.file),
  );
  return discovered;
}

function hashBytes(buffer) {
  return createHash("sha256").update(buffer).digest("hex").slice(0, 24);
}

function createLineConsumer(onLine) {
  let pending = [];
  let pendingLength = 0;
  let discarding = false;
  let lineNo = 0;
  let offset = 0;
  let skippedLargeLine = false;

  function processLine(buffer, absoluteEnd, complete) {
    let end = buffer.length;
    if (end > 0 && buffer[end - 1] === 13) end -= 1;
    lineNo += 1;
    offset = absoluteEnd;
    if (end === 0) return;
    const line = buffer.subarray(0, end);
    let value;
    try {
      value = JSON.parse(line.toString("utf8"));
    } catch {
      if (complete) onLine(null, { lineNo, hash: hashBytes(line), parseError: true });
      return;
    }
    onLine(value, {
      lineNo,
      hash: hashBytes(line),
      parseError: false,
    });
  }

  function feedAt(buffer, chunkStart) {
    let start = 0;
    while (start < buffer.length) {
      const newline = buffer.indexOf(10, start);
      if (newline === -1) {
        const remainder = buffer.subarray(start);
        if (!discarding) {
          if (pendingLength + remainder.length > MAX_LINE_BYTES) {
            pending = [];
            pendingLength = 0;
            discarding = true;
            skippedLargeLine = true;
          } else if (remainder.length > 0) {
            pending.push(Buffer.from(remainder));
            pendingLength += remainder.length;
          }
        }
        if (discarding) offset = chunkStart + buffer.length;
        return;
      }
      const absoluteEnd = chunkStart + newline + 1;
      if (discarding) {
        lineNo += 1;
        offset = absoluteEnd;
        discarding = false;
        start = newline + 1;
        continue;
      }
      const piece = buffer.subarray(start, newline);
      if (pendingLength > 0) {
        const whole = Buffer.concat([...pending, piece], pendingLength + piece.length);
        pending = [];
        pendingLength = 0;
        if (whole.length > MAX_LINE_BYTES) {
          lineNo += 1;
          offset = absoluteEnd;
          skippedLargeLine = true;
        } else {
          processLine(whole, absoluteEnd, true);
        }
      } else if (piece.length > MAX_LINE_BYTES) {
        lineNo += 1;
        offset = absoluteEnd;
        skippedLargeLine = true;
      } else {
        processLine(piece, absoluteEnd, true);
      }
      start = newline + 1;
    }
  }

  function finish(fileSize) {
    if (discarding) {
      pending = [];
      pendingLength = 0;
      return;
    }
    if (pendingLength === 0) return;
    const whole = Buffer.concat(pending, pendingLength);
    pending = [];
    pendingLength = 0;
    if (whole.length > MAX_LINE_BYTES) return;
    try {
      JSON.parse(whole.toString("utf8"));
      processLine(whole, fileSize, true);
    } catch {
      // A trailing partial line is deliberately not persisted. offset stays at
      // the last complete newline and the next scan rereads the tail from disk.
    }
  }

  return {
    feedAt,
    finish,
    get offset() {
      return offset;
    },
    get lineNo() {
      return lineNo;
    },
    get skippedLargeLine() {
      return skippedLargeLine;
    },
    get discarding() {
      return discarding;
    },
    set discarding(value) {
      discarding = Boolean(value);
    },
    set offset(value) {
      offset = value;
    },
    set lineNo(value) {
      lineNo = value;
    },
  };
}

async function streamRange(filePath, start, end, onChunk) {
  const handle = await open(filePath, "r");
  let position = start;
  let bytes = 0;
  try {
    while (position < end) {
      const toRead = Math.min(CHUNK_BYTES, end - position);
      const buffer = Buffer.allocUnsafe(toRead);
      const { bytesRead } = await handle.read(buffer, 0, toRead, position);
      if (bytesRead <= 0) break;
      position += bytesRead;
      bytes += bytesRead;
      await onChunk(buffer.subarray(0, bytesRead), position - bytesRead);
    }
  } finally {
    await handle.close();
  }
  return bytes;
}

function hasZstdSupport() {
  return typeof zlib.createZstdDecompress === "function";
}

function lineContext(store, entry, source, sink) {
  return {
    file: entry,
    state: entry.state,
    source,
    lineHash: "",
    warn(message) {
      sink.warn(`${source.adapter} ${entry.path}: ${message}`);
    },
    addUsage(meta, tokens, key) {
      return addUsage(store, entry, meta, tokens, key);
    },
    addTask(fileId, rowIdx, key, durationMs, session, exact) {
      return addTask(
        store,
        fileId,
        rowIdx,
        key,
        durationMs,
        session,
        exact,
        entry.id,
      );
    },
    removeLatestFallback(session) {
      return removeLatestFallbackTaskForSession(store, session);
    },
  };
}

async function parseBuffers(
  store,
  entry,
  source,
  chunks,
  startOffset,
  endOffset,
  sink,
) {
  const context = lineContext(store, entry, source, sink);
  const consumer = createLineConsumer((record, info) => {
    if (info.parseError) {
      sink.warn(
        `${source.adapter} ${entry.path}: line ${info.lineNo} is not valid JSON; skipped.`,
      );
      return;
    }
    if (!isPlainObject(record)) return;
    context.lineHash = info.hash;
    try {
      parseAdapterRecord(source.adapter, record, context);
    } catch (error) {
      sink.warn(
        `${source.adapter} ${entry.path}: line ${info.lineNo} could not be parsed: ${error.message}`,
      );
    }
  });
  consumer.offset = startOffset;
  consumer.lineNo = entry.lineNo ?? 0;
  let chunkStart = startOffset;
  for await (const chunk of chunks) {
    consumer.feedAt(chunk, chunkStart);
    chunkStart += chunk.length;
  }
  consumer.finish(endOffset ?? chunkStart);
  if (consumer.skippedLargeLine) {
    sink.warn(
      `${source.adapter} ${entry.path}: a line larger than ${MAX_LINE_BYTES} bytes was skipped.`,
    );
  }
  return { offset: consumer.offset, lineNo: consumer.lineNo };
}

async function processStringChunks(
  store,
  entry,
  source,
  chunks,
  startOffset,
  endOffset,
  sink,
) {
  return parseBuffers(store, entry, source, chunks, startOffset, endOffset, sink);
}

async function scanPlainFile(
  store,
  entry,
  source,
  filePath,
  fileStat,
  sink,
  stats,
) {
  const adapter = source.adapter;
  let dirty = false;
  const start = entry.offset;

  if (fileStat.size > start) {
    const context = lineContext(store, entry, source, sink);
    const consumer = createLineConsumer((record, info) => {
      if (info.parseError) {
        sink.warn(
          `${adapter} ${entry.path}: line ${info.lineNo} is not valid JSON; skipped.`,
        );
        return;
      }
      if (!isPlainObject(record)) return;
      context.lineHash = info.hash;
      try {
        parseAdapterRecord(adapter, record, context);
      } catch (error) {
        sink.warn(
          `${adapter} ${entry.path}: line ${info.lineNo} could not be parsed: ${error.message}`,
        );
      }
    });
    consumer.offset = start;
    consumer.lineNo = entry.lineNo ?? 0;
    consumer.discarding = entry.state.discardingLargeLine;
    let bytes = 0;
    try {
      await streamRange(filePath, start, fileStat.size, async (chunk, chunkStart) => {
        bytes += chunk.length;
        consumer.feedAt(chunk, chunkStart);
      });
      consumer.finish(start + bytes);
      delete entry.state.readFailed;
    } catch (error) {
      // Keep the accepted complete prefix and its parser state together. The
      // unfinished suffix is retried even if the file metadata is unchanged.
      entry.state.readFailed = true;
      sink.warn(`${adapter} ${entry.path}: read failed; accepted prefix retained: ${error.message}`);
    }
    stats.bytesRead += bytes;
    if (bytes > 0) stats.filesRead += 1;
    if (consumer.skippedLargeLine) {
      sink.warn(
        `${adapter} ${entry.path}: a line larger than ${MAX_LINE_BYTES} bytes was skipped.`,
      );
    }
    entry.offset = consumer.offset;
    entry.lineNo = consumer.lineNo;
    if (consumer.discarding) entry.state.discardingLargeLine = true;
    else delete entry.state.discardingLargeLine;
    dirty = true;
    return dirty;
  }

  return dirty;
}

async function scanCompressedFile(
  store,
  entry,
  source,
  filePath,
  fileStat,
  sink,
  stats,
  checkpoint,
) {
  if (!hasZstdSupport()) {
    entry.size = fileStat.size;
    entry.mtimeMs = fileStat.mtimeMs;
    entry.offset = fileStat.size;
    entry.state.unsupported = "zstd";
    sink.warn(
      `${source.adapter} ${entry.path}: .jsonl.zst needs Node's zstd API (Node 22.15+); skipped.`,
    );
    return { ok: true, dirty: true };
  }
  // Roll back metadata if a stream fails after producing valid records. Raw
  // transcript bytes are never retained: the line consumer is bounded.
  let result;
  try {
    if (entry.offset || entry.rows.length || Object.keys(entry.state).length) resetFileEntry(store, entry);
    result = await pipeline(
      createReadStream(filePath),
      zlib.createZstdDecompress(),
      async (chunks) => processStringChunks(store, entry, source, chunks, 0, undefined, sink),
    );
  } catch (error) {
    Object.assign(store, checkpoint);
    prepareStore(store);
    sink.warn(
      `${source.adapter} ${entry.path}: zstd file could not be decompressed: ${error.message}`,
    );
    return { ok: false, dirty: false };
  }
  stats.bytesRead += fileStat.size;
  if (fileStat.size > 0) stats.filesRead += 1;
  entry.offset = fileStat.size;
  entry.lineNo = result.lineNo;
  return { ok: true, dirty: true };
}

function openCodeString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "unknown";
}

function openCodeInt(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

// Which message table this store has. `session_message` is the newer one and
// the superset where both exist, so it wins; `message` is the fallback.
function hasSessionMessage(db) {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_message' LIMIT 1").get());
  } catch {
    return false;
  }
}

// session id -> working directory. The new schema keeps the project on the
// session (and on `session_v2` specifically), because its message rows carry no
// path of their own.
function sessionDirectories(db) {
  const map = new Map();
  for (const table of ["session_v2", "session"]) {
    try {
      for (const row of db.prepare(`SELECT id, directory FROM ${table}`).iterate()) {
        if (row?.id && typeof row.directory === "string" && row.directory) {
          map.set(String(row.id), row.directory);
        }
      }
    } catch {
      // Table absent on this store; the other one may still be there.
    }
  }
  return map;
}

/**
 * OpenCode stores sessions in one SQLite database. Messages are immutable
 * once completed and each assistant row carries canonical tokens, so a full
 * re-read through the max-upsert dedup is exact. The WAL file changes on
 * every write while the main database may not, so the checkpoint fingerprint
 * covers both files.
 */
async function scanOpenCodeDb(store, source, filePath, sink, stats) {
  let dbStat;
  try {
    dbStat = await stat(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      sink.warn(`opencode ${filePath}: cannot stat file: ${error.message}`);
    }
    return false;
  }
  if (!dbStat.isFile()) return false;
  let walStat = null;
  try {
    walStat = await stat(`${filePath}-wal`);
  } catch { /* no WAL right now */ }
  const fingerprint = `${dbStat.mtimeMs}:${dbStat.size}:${walStat?.mtimeMs ?? 0}:${walStat?.size ?? 0}`;

  const key = fileKey(source.id, filePath);
  let entry = store.files[key];
  let dirty = false;
  if (!entry) {
    entry = newFileEntry(store, {
      sourceId: source.id,
      adapter: source.adapter,
      path: filePath,
      dev: String(dbStat.dev),
      ino: String(dbStat.ino),
      size: 0,
      mtimeMs: 0,
      compressed: false,
    });
    dirty = true;
  }
  if (entry.state.opencodeParserVersion === 3 && entry.state.opencodeFingerprint === fingerprint) {
    if (entry.state.opencodeMalformedRows) sink.warn(`opencode ${filePath}: ${entry.state.opencodeMalformedRows} malformed message rows were skipped.`);
    stats.unchangedFiles += 1;
    return dirty;
  }

  let sqlite;
  try {
    sqlite = await import("node:sqlite");
  } catch {
    if (entry.state.unsupported !== "sqlite") {
      sink.warn(`opencode ${filePath}: node:sqlite is unavailable in this Node runtime; skipped.`);
      entry.state.unsupported = "sqlite";
      dirty = true;
    }
    stats.unchangedFiles += 1;
    return dirty;
  }

  let db;
  let checkpoint;
  let malformedRows = 0;
  try {
    // Never open an external source writable, including on recovery errors.
    db = new sqlite.DatabaseSync(filePath, { readOnly: true });

    // Two schemas are in the wild, and one store can carry both.
    //
    //   message         session_id, id, time_created, data   (0.x / early 1.x)
    //   session_message session_id, id, time_created, data,  (1.x+, plus `type`)
    //
    // The row JSON differs too: the old one has `role`, top-level `providerID`
    // and `modelID` plus `path.cwd`; the new one has a `type` column set to
    // `assistant` and nests the model as `model.providerID` / `model.id`. There
    // is no `path`, so the project comes from `session_v2.directory`.
    //
    // READ ONLY ONE. On this Windows box the two tables overlap almost
    // entirely (7919 of 7952 old assistant rows are also in the new table) and
    // the new one is the superset (8128 vs 7952). Reading both would count the
    // same messages twice under two different dedup keys, so the new table wins
    // whenever it exists and `message` is the fallback for older stores.
    //
    // space-pp had ONLY the new schema, which is why it published 1 row while
    // its database held 8 sessions and 1.28M tokens.
    const table = hasSessionMessage(db) ? "session_message" : "message";
    const legacy = table === "message";
    const records = legacy
      ? db.prepare("SELECT session_id, id, time_created, data FROM message").iterate()
      : db.prepare("SELECT session_id, id, time_created, data FROM session_message WHERE type = 'assistant'").iterate();
    // Project per session, for the new schema: the row itself has no cwd.
    const projectBySession = legacy ? null : sessionDirectories(db);

    checkpoint = structuredClone(store);
    resetFileEntry(store, entry);
    delete entry.state.unsupported;
    for (const record of records) {
      let data;
      try {
        data = JSON.parse(record.data);
      } catch {
        malformedRows += 1;
        continue;
      }
      if (!isPlainObject(data)) { malformedRows += 1; continue; }
      // The old schema marks the role inside the row; the new one filters by
      // the `type` column, so its rows are already assistant turns.
      if (legacy && data.role !== "assistant") continue;
      if (!isPlainObject(data.tokens)) { malformedRows += 1; continue; }
      const reported = [data.tokens.input, data.tokens.output, data.tokens.reasoning, data.tokens.cache?.read, data.tokens.cache?.write];
      if (reported.some((value) => value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0))) {
        malformedRows += 1;
        continue;
      }
      const tokens = {
        input: openCodeInt(data.tokens.input),
        output: openCodeInt(data.tokens.output),
        cacheRead: openCodeInt(data.tokens.cache?.read),
        cacheWrite: openCodeInt(data.tokens.cache?.write),
        reasoning: openCodeInt(data.tokens.reasoning),
      };
      if (tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite <= 0) continue;
      const created = openCodeInt(data.time?.created) || openCodeInt(record.time_created);
      if (created <= 0 || !Number.isFinite(new Date(created).getTime())) { malformedRows += 1; continue; }
      const session = String(record.session_id ?? "unknown");
      const provider = legacy ? data.providerID : data.model?.providerID;
      const model = legacy ? data.modelID : data.model?.id;
      const project = legacy
        ? (typeof data.path?.cwd === "string" ? data.path.cwd : "")
        : (projectBySession.get(session) ?? "");
      const result = addUsage(store, entry, {
        day: localDay(created),
        session,
        harness: source.id,
        provider: openCodeString(provider),
        model: openCodeString(model),
        project,
      }, tokens, dedupKeyFor("opencode", "message", String(record.id)));
      const completed = openCodeInt(data.time?.completed);
      if (completed > created) {
        addTask(
          store,
          result.fileId,
          result.rowIdx,
          taskKeyFor("opencode", "message", String(record.id)),
          completed - created,
          session,
          true,
        );
      }
    }
  } catch (error) {
    if (checkpoint) {
      Object.assign(store, checkpoint);
      prepareStore(store);
    }
    sink.warn(`opencode ${filePath}: scan failed: ${error.message}`);
    return dirty;
  } finally {
    try { db?.close(); } catch { /* close is best-effort */ }
  }

  entry.dev = String(dbStat.dev);
  entry.ino = String(dbStat.ino);
  entry.size = dbStat.size;
  entry.mtimeMs = dbStat.mtimeMs;
  entry.state.opencodeFingerprint = fingerprint;
  entry.state.opencodeParserVersion = 3;
  entry.state.opencodeMalformedRows = malformedRows;
  if (malformedRows) sink.warn(`opencode ${filePath}: ${malformedRows} malformed message rows were skipped.`);
  stats.filesRead += 1;
  stats.bytesRead += dbStat.size + (walStat?.size ?? 0);
  return true;
}

/**
 * Antigravity keeps one SQLite file per conversation (see antigravity.mjs for the
 * row layout). Calls are immutable once written, so a full re-read through the
 * max-upsert dedup is exact; the fingerprint covers the WAL as well, because an
 * open conversation changes the WAL while the main file may stay put.
 */
async function scanAntigravityDb(store, source, filePath, sink, stats) {
  let dbStat;
  try {
    dbStat = await stat(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") sink.warn(`antigravity ${filePath}: cannot stat file: ${error.message}`);
    return false;
  }
  if (!dbStat.isFile()) return false;
  let walStat = null;
  try {
    walStat = await stat(`${filePath}-wal`);
  } catch { /* no WAL right now */ }
  const fingerprint = `${dbStat.mtimeMs}:${dbStat.size}:${walStat?.mtimeMs ?? 0}:${walStat?.size ?? 0}`;

  const key = fileKey(source.id, filePath);
  let entry = store.files[key];
  let dirty = false;
  if (!entry) {
    entry = newFileEntry(store, {
      sourceId: source.id,
      adapter: source.adapter,
      path: filePath,
      dev: String(dbStat.dev),
      ino: String(dbStat.ino),
      size: 0,
      mtimeMs: 0,
      compressed: false,
    });
    dirty = true;
  }
  if (entry.state.antigravityParserVersion === 1 && entry.state.antigravityFingerprint === fingerprint) {
    stats.unchangedFiles += 1;
    return dirty;
  }

  let sqlite;
  try {
    sqlite = await import("node:sqlite");
  } catch {
    if (entry.state.unsupported !== "sqlite") {
      sink.warn(`antigravity ${filePath}: node:sqlite is unavailable in this Node runtime; skipped.`);
      entry.state.unsupported = "sqlite";
      dirty = true;
    }
    stats.unchangedFiles += 1;
    return dirty;
  }

  let db;
  let checkpoint;
  let malformed = 0;
  try {
    db = new sqlite.DatabaseSync(filePath, { readOnly: true });
    const conversation = readConversation(db, path.basename(filePath, ".db"));
    malformed = conversation.malformed;
    checkpoint = structuredClone(store);
    resetFileEntry(store, entry);
    delete entry.state.unsupported;
    for (const call of conversation.generations) {
      if (!call.timeMs || !Number.isFinite(new Date(call.timeMs).getTime())) { malformed += 1; continue; }
      addUsage(store, entry, {
        day: localDay(call.timeMs),
        session: conversation.conversationId,
        harness: source.id,
        provider: "google",
        model: call.model,
        project: conversation.project,
      }, call.tokens, dedupKeyFor("antigravity", "generation", call.key));
    }
  } catch (error) {
    if (checkpoint) {
      Object.assign(store, checkpoint);
      prepareStore(store);
    }
    sink.warn(`antigravity ${filePath}: scan failed: ${error.message}`);
    return dirty;
  } finally {
    try { db?.close(); } catch { /* close is best-effort */ }
  }

  entry.dev = String(dbStat.dev);
  entry.ino = String(dbStat.ino);
  entry.size = dbStat.size;
  entry.mtimeMs = dbStat.mtimeMs;
  entry.state.antigravityFingerprint = fingerprint;
  entry.state.antigravityParserVersion = 1;
  if (malformed) sink.warn(`antigravity ${filePath}: ${malformed} rows could not be read.`);
  stats.filesRead += 1;
  stats.bytesRead += dbStat.size + (walStat?.size ?? 0);
  return true;
}

/**
 * Cline keeps each session as one JSON document with a `messages` array, so
 * there is no offset to resume from: the whole file is re-read on every change
 * and the global message-id dedup keeps re-reads exact. Sub-agent transcripts
 * live beside their parent as `agent_*.messages.json` and reuse the parent's
 * project and harness.
 */
async function scanClineDocument(store, source, filePath, sink, stats) {
  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      sink.warn(`cline ${filePath}: cannot stat file: ${error.message}`);
    }
    return false;
  }
  if (!fileStat.isFile()) return false;

  const key = fileKey(source.id, filePath);
  let entry = store.files[key];
  let dirty = false;
  if (!entry) {
    entry = newFileEntry(store, {
      sourceId: source.id,
      adapter: source.adapter,
      path: filePath,
      dev: String(fileStat.dev),
      ino: String(fileStat.ino),
      size: 0,
      mtimeMs: 0,
      compressed: false,
    });
    dirty = true;
  }
  const dev = String(fileStat.dev);
  const ino = String(fileStat.ino);
  const clineParserCurrent = entry.state.clineParserVersion === 1;
  if (
    clineParserCurrent &&
    !entry.state.readFailed &&
    entry.dev === dev &&
    entry.ino === ino &&
    entry.size === fileStat.size &&
    entry.mtimeMs === fileStat.mtimeMs
  ) {
    stats.unchangedFiles += 1;
    return dirty;
  }
  if (entry.dev !== dev || entry.ino !== ino) {
    resetFileEntry(store, entry);
    entry.dev = dev;
    entry.ino = ino;
    dirty = true;
  }

  let raw;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    entry.state.readFailed = true;
    sink.warn(`cline ${filePath}: read failed; accepted rows retained: ${error.message}`);
    return dirty;
  }
  stats.bytesRead += raw.length;
  stats.filesRead += 1;

  let document;
  try {
    document = JSON.parse(raw);
  } catch (error) {
    sink.warn(`cline ${filePath}: not valid JSON; skipped: ${error.message}`);
    entry.size = fileStat.size;
    entry.mtimeMs = fileStat.mtimeMs;
    return dirty;
  }
  const messages = isPlainObject(document) ? document.messages : null;
  if (!Array.isArray(messages)) {
    sink.warn(`cline ${filePath}: no messages array; skipped`);
    entry.size = fileStat.size;
    entry.mtimeMs = fileStat.mtimeMs;
    return dirty;
  }

  const parentDir = path.basename(path.dirname(filePath));
  const agentName = isPlainObject(document) ? asStringField(document.agent, "") : "";
  const isSubagent = agentName === "subagent" || path.basename(filePath).startsWith("agent_");
  const sessionId = isPlainObject(document)
    ? asStringField(document.sessionId, parentDir)
    : parentDir;
  const session = isSubagent
    ? `cline-sub:${sessionId}:${path.basename(filePath, ".messages.json")}`
    : `cline:${sessionId}`;
  const project = clineProject(document, filePath);

  resetFileEntry(store, entry);
  const context = {
    file: entry,
    state: entry.state,
    source,
    lineHash: "",
    warn(message) {
      sink.warn(`cline ${entry.path}: ${message}`);
    },
    addUsage(meta, tokens, dedupKey) {
      return addUsage(store, entry, meta, tokens, dedupKey);
    },
    addTask(fileId, rowIdx, taskKey, durationMs, sessionId, exact) {
      return addTask(
        store,
        fileId,
        rowIdx,
        taskKey,
        durationMs,
        sessionId,
        exact,
        entry.id,
      );
    },
    removeLatestFallback() {
      return false;
    },
  };
  parseClineMessages(messages, { session, project }, context);

  entry.offset = 0;
  entry.lineNo = 0;
  entry.size = fileStat.size;
  entry.mtimeMs = fileStat.mtimeMs;
  entry.path = filePath;
  entry.state.clineParserVersion = 1;
  delete entry.state.readFailed;
  return true;
}

function asStringField(value, fallback) {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

/** Sub-agent files inherit their parent session's workspace. */
function clineProject(document, filePath) {
  const direct = isPlainObject(document)
    ? asStringField(document.workspaceRoot ?? document.cwd, "")
    : "";
  if (direct) return direct;
  const sessionDir = path.dirname(filePath);
  const parentId = path.basename(sessionDir);
  try {
    const parsed = JSON.parse(
      readFileSync(path.join(sessionDir, `${parentId}.json`), "utf8"),
    );
    const workspace = asStringField(parsed?.workspace_root ?? parsed?.cwd, "");
    if (workspace) return workspace;
  } catch {
    // A sub-agent transcript without its parent metadata still carries usage.
  }
  return "unknown";
}

async function scanOneFile(store, source, filePath, sink, stats) {
  const sourceSink = {
    warn(message) {
      sink.warn(`[${source.id}] ${message}`, source.id);
    },
    note(message) {
      sink.note(`[${source.id}] ${message}`);
    },
  };
  if (source.adapter === "opencode") {
    return scanOpenCodeDb(store, source, filePath, sourceSink, stats);
  }
  if (source.adapter === "cline") {
    return scanClineDocument(store, source, filePath, sourceSink, stats);
  }
  if (source.adapter === "antigravity") {
    return scanAntigravityDb(store, source, filePath, sourceSink, stats);
  }
  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      sourceSink.warn(`${source.adapter} ${filePath}: cannot stat file: ${error.message}`);
    }
    return false;
  }
  if (!fileStat.isFile()) return false;

  const key = fileKey(source.id, filePath);
  let entry = store.files[key];
  const isNew = !entry;
  let dirty = false;
  if (!entry) {
    entry = newFileEntry(store, {
      sourceId: source.id,
      adapter: source.adapter,
      path: filePath,
      dev: String(fileStat.dev),
      ino: String(fileStat.ino),
      size: 0,
      mtimeMs: 0,
      compressed: filePath.endsWith(".jsonl.zst"),
    });
    dirty = true;
  }

  const dev = String(fileStat.dev);
  const ino = String(fileStat.ino);
  const parserVersion = PARSER_VERSIONS[entry.adapter];
  const parserKey = `${entry.adapter}ParserVersion`;
  const parserCurrent = (!parserVersion || entry.state[parserKey] === parserVersion)
    && !(entry.state.unsupported === "zstd" && hasZstdSupport());
  if (parserCurrent && !entry.state.readFailed && entry.dev === dev && entry.ino === ino
    && entry.size === fileStat.size && entry.mtimeMs === fileStat.mtimeMs) {
    stats.unchangedFiles += 1;
    return dirty;
  }
  // Capture before migrations/truncation reset anything, including ownership
  // transferred to copied files. Unchanged archives never allocate a checkpoint.
  const checkpoint = entry.compressed && hasZstdSupport() ? structuredClone(store) : null;
  let forceRead = false;
  if (!isNew && parserVersion && entry.state[parserKey] !== parserVersion) {
    // Migrate existing history once for accounting fixes. New files own no
    // metadata and must never trigger a global ownership cleanup scan.
    resetFileEntry(store, entry);
    forceRead = true;
    dirty = true;
  }
  if (
    entry.state.unsupported === "zstd" &&
    hasZstdSupport() &&
    filePath.endsWith(".jsonl.zst")
  ) {
    resetFileEntry(store, entry);
    forceRead = true;
    dirty = true;
  }
  if (
    entry.dev !== dev ||
    entry.ino !== ino ||
    fileStat.size < entry.size ||
    fileStat.size < entry.offset
  ) {
    resetFileEntry(store, entry);
    entry.dev = dev;
    entry.ino = ino;
    forceRead = true;
    dirty = true;
  }

  if (
    !forceRead &&
    !entry.state.readFailed &&
    entry.size === fileStat.size &&
    entry.mtimeMs === fileStat.mtimeMs
  ) {
    stats.unchangedFiles += 1;
    return dirty;
  }

  if (filePath.endsWith(".jsonl.zst")) {
    const compressed = await scanCompressedFile(
      store,
      entry,
      source,
      filePath,
      fileStat,
      sourceSink,
      stats,
      checkpoint,
    );
    if (!compressed.ok) return dirty;
    dirty = compressed.dirty || dirty;
  } else {
    dirty =
      (await scanPlainFile(
        store,
        entry,
        source,
        filePath,
        fileStat,
        sourceSink,
        stats,
      )) || dirty;
  }

  entry.size = fileStat.size;
  entry.mtimeMs = fileStat.mtimeMs;
  entry.path = filePath;
  if (parserVersion) entry.state[parserKey] = parserVersion;
  return dirty;
}

export async function scanSources(store, { home, onProgress } = {}) {
  const warnings = [];
  const stats = {
    files: 0,
    filesRead: 0,
    bytesRead: 0,
    unchangedFiles: 0,
    errors: 0,
  };
  const sourceState = {};
  for (const source of store.config.sources) {
    sourceState[source.id] = {
      enabled: source.enabled,
      rootCount: source.roots.length,
      rootsAvailable: 0,
      files: 0,
      filesRead: 0,
      bytesRead: 0,
      errors: 0,
    };
  }
  const sink = warningSink(warnings, stats, sourceState);
  const discovered = await discoverFiles(store.config, home, sink, sourceState);
  const seenInodes = new Set();
  const seenPaths = new Set();
  let dirty = false;
  let processed = 0;

  for (const found of discovered) {
    onProgress?.({ processed, total: discovered.length, file: found.file });
    processed += 1;
    if (seenPaths.has(found.file)) continue;
    let fileStat;
    try {
      fileStat = await stat(found.file);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        sink.warn(
          `[${found.source.id}] ${found.source.adapter} ${found.file}: cannot stat file: ${error.message}`,
          found.source.id,
        );
      }
      continue;
    }
    if (!fileStat.isFile()) continue;
    const inode = `${fileStat.dev}:${fileStat.ino}`;
    if (seenInodes.has(inode)) continue;
    seenPaths.add(found.file);
    seenInodes.add(inode);
    stats.files += 1;
    sourceState[found.source.id].files += 1;
    const beforeRead = stats.filesRead;
    const beforeBytes = stats.bytesRead;
    const changed = await scanOneFile(
      store,
      found.source,
      found.file,
      sink,
      stats,
    ).catch((error) => {
      sink.warn(
        `[${found.source.id}] ${found.source.adapter} ${found.file}: scan failed: ${error.message}`,
        found.source.id,
      );
      return false;
    });
    sourceState[found.source.id].filesRead +=
      stats.filesRead - beforeRead;
    sourceState[found.source.id].bytesRead +=
      stats.bytesRead - beforeBytes;
    dirty = changed || dirty;
  }

  const sourceStats = {};
  for (const source of store.config.sources) {
    const state = sourceState[source.id];
    let status;
    if (!state.enabled) status = "disabled";
    else if (state.errors > 0) status = "error";
    else if (state.rootCount > 0 && state.rootsAvailable === 0) status = "missing";
    else if (state.files === 0) status = "empty";
    else status = "ok";
    sourceStats[source.id] = {
      status,
      files: state.files,
      filesRead: state.filesRead,
      bytesRead: state.bytesRead,
      errors: state.errors,
    };
  }

  sink.finish();
  return { stats, warnings, dirty, sourceStats };
}

export async function rebuildScan(store, { home }) {
  return scanSources(store, { home });
}

export { createLineConsumer, processStringChunks, scanOneFile, walkRoot };
