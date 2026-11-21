// Antigravity CLI (`agy`) keeps one SQLite file per conversation under
// ~/.gemini/antigravity-cli/conversations. Its rows are protobuf blobs with no
// published schema, so the field numbers below were read off real conversations
// and checked against the totals `agy -p ... --output-format json` prints for the
// same turn (input 8541, output 127, thinking 104 matched field for field).
//
//   gen_metadata.data     one row per model call
//     1.4.2   input tokens (the whole prompt)
//     1.4.3   output tokens, thinking included
//     1.4.9   thinking tokens, a subset of 1.4.3
//     1.4.7   response id, the same string a step carries (join key)
//     3.28    model id, e.g. gemini-3.8-flash-medium
//   steps.metadata        1.1 seconds since the epoch, 9.7 response id
//   trajectory_metadata_blob.data   7 workspace as a file:// URI, 6 conversation id
//
// No cache-read field has been seen non-zero (every turn so far reported 0), so
// cache tokens are not counted. A field that is missing or malformed makes that
// one call count as zero rather than failing the file.

// ---- minimal protobuf reader --------------------------------------------------

function readVarint(buf, start) {
  let result = 0n;
  let shift = 0n;
  let i = start;
  while (i < buf.length) {
    const byte = buf[i++];
    result |= BigInt(byte & 0x7f) << shift;
    if (!(byte & 0x80)) return { value: result, next: i };
    shift += 7n;
    if (shift > 70n) return null;
  }
  return null;
}

// Fields of one message as { field, wire, value }. varint -> BigInt, length
// delimited -> Buffer. Anything that does not parse cleanly returns null, which
// is how a blob that is really text or random bytes is told apart from a message.
export function readFields(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    const key = readVarint(buf, i);
    if (!key) return null;
    i = key.next;
    const field = Number(key.value >> 3n);
    const wire = Number(key.value & 7n);
    if (field === 0) return null;
    if (wire === 0) {
      const v = readVarint(buf, i);
      if (!v) return null;
      out.push({ field, wire, value: v.value });
      i = v.next;
    } else if (wire === 1) {
      if (i + 8 > buf.length) return null;
      out.push({ field, wire, value: buf.subarray(i, i + 8) });
      i += 8;
    } else if (wire === 5) {
      if (i + 4 > buf.length) return null;
      out.push({ field, wire, value: buf.subarray(i, i + 4) });
      i += 4;
    } else if (wire === 2) {
      const len = readVarint(buf, i);
      if (!len) return null;
      const end = len.next + Number(len.value);
      if (end > buf.length) return null;
      out.push({ field, wire, value: buf.subarray(len.next, end) });
      i = end;
    } else {
      return null;
    }
  }
  return out;
}

const first = (fields, n) => fields?.find((f) => f.field === n)?.value;
const message = (fields, n) => {
  const v = first(fields, n);
  return Buffer.isBuffer(v) ? readFields(v) : null;
};
const text = (fields, n) => {
  const v = first(fields, n);
  return Buffer.isBuffer(v) ? v.toString("utf8") : "";
};
const count = (fields, n) => {
  const v = first(fields, n);
  return typeof v === "bigint" && v < 2n ** 53n ? Number(v) : 0;
};

// ---- one conversation ---------------------------------------------------------

// file:///C:/Users/me/proj -> C:/Users/me/proj, file:///home/me/proj -> /home/me/proj
export function workspaceFromUri(uri) {
  if (typeof uri !== "string" || !uri.startsWith("file://")) return typeof uri === "string" ? uri : "";
  let p = uri.slice("file://".length);
  try { p = decodeURIComponent(p); } catch { /* keep it raw */ }
  return /^\/[A-Za-z]:/.test(p) ? p.slice(1) : p;
}

/**
 * Reads one open conversation database (node:sqlite DatabaseSync) and returns
 * { conversationId, project, startedMs, generations: [{ key, timeMs, model,
 * tokens: { input, output, reasoning } }], malformed }.
 */
export function readConversation(db, fallbackId = "unknown") {
  let malformed = 0;
  let project = "";
  let conversationId = fallbackId;
  let startedMs = 0;
  try {
    const row = db.prepare("SELECT data FROM trajectory_metadata_blob LIMIT 1").get();
    const meta = row?.data ? readFields(Buffer.from(row.data)) : null;
    if (meta) {
      project = workspaceFromUri(text(meta, 7) || text(message(meta, 1), 1));
      conversationId = text(meta, 6) || fallbackId;
      startedMs = count(message(meta, 2), 1) * 1000;
    }
  } catch { /* a missing table just means no project */ }

  // response id -> when it finished, from the step that carries the same usage
  const stepTime = new Map();
  try {
    for (const row of db.prepare("SELECT metadata FROM steps WHERE metadata IS NOT NULL").iterate()) {
      const meta = readFields(Buffer.from(row.metadata));
      const usage = message(meta, 9);
      const id = usage ? text(usage, 7) : "";
      if (!id) continue;
      const seconds = count(message(meta, 7), 1) || count(message(meta, 1), 1);
      if (seconds) stepTime.set(id, seconds * 1000);
    }
  } catch { /* no steps table: fall back to the conversation start */ }

  const generations = [];
  try {
    for (const row of db.prepare("SELECT idx, data FROM gen_metadata").iterate()) {
      const top = readFields(Buffer.from(row.data));
      const usage = message(message(top, 1), 4);
      if (!usage) { malformed += 1; continue; }
      const input = count(usage, 2);
      const output = count(usage, 3);
      const reasoning = Math.min(count(usage, 9), output);
      if (input + output <= 0) continue;
      const responseId = text(usage, 7);
      generations.push({
        key: `${conversationId}:${responseId || row.idx}`,
        timeMs: stepTime.get(responseId) || startedMs,
        model: text(message(top, 3), 28) || "unknown",
        tokens: { input, output, cacheRead: 0, cacheWrite: 0, reasoning },
      });
    }
  } catch {
    malformed += 1;
  }
  return { conversationId, project, startedMs, generations, malformed };
}
