#!/usr/bin/env node
// ==============================================================================
// usage-tui.mjs - the interactive view of the usage snapshots.
//
//   usage tui            (or)  node usage-tui.mjs
//
// Keys:
//   1 2 3 4 5 6   range: today, 7d, 30d, 90d, 1y, lifetime
//   t g m p h r   table: tokens, group, model, provider, harness, host, project
//   ← →           step the table group (model -> provider -> harness -> host)
//   ↑ ↓ / j k     move the cursor, which drives the detail pane
//   c             table sorted by cost instead of tokens
//   a             table sorted by active time (when the rows carry it)
//   r             refresh prices from OpenRouter, then redraw
//   q             quit
//
// Why it exists next to `usage report`: the report answers "what did the last
// few models cost" and nothing else. This answers "which week was expensive",
// "is cache read or output driving the bill", and "which project was that",
// with a calendar heatmap and a bar chart per period.
//
// No dependency. Raw mode, alternate screen, and a redraw on every key. The
// snapshot data is day-granular, so a range is a day count, not a timestamp
// window; "today" is today's rows and there is no sub-day view to offer.
// ==============================================================================

import {
  GROUP_KEYS,
  addRow,
  costOf,
  emptyTotals,
  formatCompact,
  formatMoney,
  formatTokens,
  hostSnapshots,
  mergeRows,
  percent,
  priceFor,
  priceIndex,
  refreshPrices,
  usageDir,
} from "./usage.mjs";

// ------------------------------------------------------------------------------
// Terminal
// ------------------------------------------------------------------------------
const out = process.stdout;
const stdin = process.stdin;

// Colour when drawing to a terminal. FORCE_COLOR exists so the headless
// --frame render can include the escape codes: without it the selected-row
// highlight is invisible to a test, and "the highlight does not show" is
// exactly the kind of bug that then ships unnoticed.
const USE_COLOR = Boolean(
  process.env.FORCE_COLOR || (out.isTTY && !process.env.NO_COLOR && process.env.TERM !== "dumb"),
);
const S = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m", reverse: "\x1b[7m",
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", blue: "\x1b[34m",
  magenta: "\x1b[35m", cyan: "\x1b[36m", grey: "\x1b[90m",
};

function paint(code, text) {
  return USE_COLOR ? `${code}${text}${S.reset}` : String(text);
}
const dim = (t) => paint(S.dim, t);
const bold = (t) => paint(S.bold, t);
const grey = (t) => paint(S.grey, t);
const cyan = (t) => paint(S.cyan, t);
const yellow = (t) => paint(S.yellow, t);
const green = (t) => paint(S.green, t);
const magenta = (t) => paint(S.magenta, t);
const blue = (t) => paint(S.blue, t);

const ESC = "\x1b[";
function moveTo(row, col) { return `${ESC}${row};${col}H`; }
const CLEAR = `${ESC}2J`;
const HIDE_CURSOR = `${ESC}?25l`;
const SHOW_CURSOR = `${ESC}?25h`;

function termSize() {
  // COLUMNS/LINES first: they are what every other CLI honours, and they are the
  // only way a test can ask this program what it does at a given size. Without
  // reading them, every width test silently measured 100 columns.
  const envCols = Number(process.env.COLUMNS);
  const envRows = Number(process.env.LINES);
  const cols = Number.isFinite(envCols) && envCols > 0 ? envCols : Number(out.columns) || 100;
  const rows = Number.isFinite(envRows) && envRows > 0 ? envRows : Number(out.rows) || 30;
  return { cols: Math.max(40, cols), rows: Math.max(10, rows) };
}

// Visible width, ignoring escape sequences and counting wide glyphs once.
function width(text) {
  return String(text).replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").length;
}

function fitText(text, max) {
  const plain = String(text);
  if (plain.length <= max) return plain;
  return `${plain.slice(0, Math.max(0, max - 1))}…`;
}

const pad = (text, n) => {
  const gap = n - width(text);
  return gap > 0 ? `${text}${" ".repeat(gap)}` : text;
};
const padLeft = (text, n) => {
  const gap = n - width(text);
  return gap > 0 ? `${" ".repeat(gap)}${text}` : text;
};

// ------------------------------------------------------------------------------
// Ranges. Day-granular data, so each range is a number of days back from the
// newest day the snapshots contain, not from "now": a machine whose last
// snapshot is a week old would otherwise show an empty range.
// ------------------------------------------------------------------------------
const RANGES = [
  { key: "1", label: "today", days: 1 },
  { key: "2", label: "7d", days: 7 },
  { key: "3", label: "30d", days: 30 },
  { key: "4", label: "90d", days: 90 },
  { key: "5", label: "1y", days: 365 },
  { key: "6", label: "lifetime", days: null },
];

const TABLES = [
  { key: "m", by: "model", label: "model" },
  { key: "p", by: "provider", label: "provider" },
  { key: "h", by: "harness", label: "harness" },
  { key: "s", by: "host", label: "host" },
  { key: "r", by: "project", label: "project" },
  { key: "d", by: "day", label: "day" },
];

const SORTS = [
  { field: "total", label: "tokens" },
  { field: "cost", label: "cost" },
  { field: "activeMs", label: "time" },
];

function dayKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function addDays(dayString, delta) {
  const [y, m, d] = dayString.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + delta);
  return dayKey(date);
}

function daysBetween(from, to) {
  const a = new Date(`${from}T00:00:00`);
  const b = new Date(`${to}T00:00:00`);
  return Math.round((b - a) / 86_400_000);
}

// ------------------------------------------------------------------------------
// State
// ------------------------------------------------------------------------------
const state = {
  range: 5,          // lifetime to start: an empty first screen is a bad first screen
  table: 0,
  sort: 0,
  cursor: 0,
  scroll: 0,
  status: "",
  statusUntil: 0,
  // `/` turns this on; keystrokes then edit the query instead of acting as
  // commands. Esc leaves the mode and keeps the filter, Esc again clears it.
  search: "",
  searching: false,
  help: false,
};

let snapshots = [];
let rows = [];
let index = null;
let newestDay = null;
let oldestDay = null;

function load({ rebuild = true } = {}) {
  snapshots = hostSnapshots();
  index = priceIndex();
  if (rebuild) rows = mergeRows(snapshots);
  const days = rows.map((r) => r.day).filter(Boolean).sort();
  oldestDay = days[0] ?? dayKey(new Date());
  newestDay = days[days.length - 1] ?? dayKey(new Date());
}

function rangeCutoff() {
  const days = RANGES[state.range].days;
  if (!days) return null;
  return addDays(newestDay, -(days - 1));
}

// Every text field a row carries, lowercased once per row for the search.
// Cached on the row object so a keystroke does not re-join strings for 1,560
// rows on every redraw.
function searchText(row) {
  if (row.__search === undefined) {
    row.__search = [row.model, row.provider, row.harness, row.project, row.session]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
  }
  return row.__search;
}

function matchesSearch(row) {
  const query = state.search.trim().toLowerCase();
  if (!query) return true;
  // Space-separated terms must all match, so `/opus claude` narrows rather than
  // widening the way a plain OR would.
  return query.split(/\s+/).every((term) => searchText(row).includes(term) || String(row.day ?? "").includes(term));
}

function visibleRows() {
  const cutoff = rangeCutoff();
  return rows.filter((row) => (!cutoff || String(row.day) >= cutoff) && matchesSearch(row));
}

function currentRangeLabel() {
  const days = RANGES[state.range].days;
  if (!days) return `lifetime (${oldestDay} to ${newestDay})`;
  const cutoff = rangeCutoff();
  return `${RANGES[state.range].label} (${cutoff} to ${newestDay})`;
}

// Aggregate the visible rows into the current table grouping.
function aggregate() {
  const visible = visibleRows();
  const keyFn = GROUP_KEYS[TABLES[state.table].by];
  const groups = new Map();
  const totals = emptyTotals();
  const unpriced = new Set();
  for (const row of visible) {
    const price = priceFor(row.model, row.provider, index);
    const cost = costOf(row, price);
    const key = keyFn(row);
    if (!groups.has(key)) {
      const fresh = emptyTotals();
      fresh.activeMs = 0;
      groups.set(key, fresh);
    }
    const bucket = groups.get(key);
    addRow(bucket, row, cost);
    addRow(totals, row, cost);
    bucket.activeMs += row.activeMs ?? 0;
    totals.activeMs += row.activeMs ?? 0;
    if (cost === null) unpriced.add(row.model || "(unknown)");
  }
  const field = SORTS[state.sort].field;
  const ordered = [...groups.entries()].sort((a, b) => {
    if (TABLES[state.table].by === "day") return a[0].localeCompare(b[0]);
    return (b[1][field] ?? 0) - (a[1][field] ?? 0) || b[1].total - a[1].total;
  });
  return { ordered, totals, unpriced, visible };
}

// ------------------------------------------------------------------------------
// Widgets
// ------------------------------------------------------------------------------
const BLOCKS = " ▁▂▃▄▅▆▇█";

// A bar chart over the days in the current range. Each column is one day when
// they fit, otherwise days are bucketed so the chart never scrolls.
function chart(visible, cols, metric) {
  const cutoff = rangeCutoff() ?? oldestDay;
  const from = cutoff;
  const to = newestDay;
  const span = Math.max(1, daysBetween(from, to) + 1);
  const perDay = new Map();
  for (const row of visible) {
    const day = row.day ?? "";
    const value = metric === "cost"
      ? (costOf(row, priceFor(row.model, row.provider, index)) ?? 0)
      : (row.tokens?.total ?? 0);
    perDay.set(day, (perDay.get(day) ?? 0) + value);
  }
  const buckets = Math.min(cols, span);
  const bucketSize = span / buckets;
  const values = Array.from({ length: buckets }, (_, i) => {
    const start = i * bucketSize;
    const end = Math.min(span, (i + 1) * bucketSize);
    let sum = 0;
    for (let d = Math.ceil(start); d < end; d += 1) {
      const day = addDays(from, d);
      sum += perDay.get(day) ?? 0;
    }
    return sum;
  });
  const peak = Math.max(...values, 1);
  return values
    .map((value) => {
      const level = value <= 0 ? 0 : Math.max(1, Math.round((value / peak) * 8));
      return BLOCKS[Math.min(8, level)];
    })
    .join("");
}

// Calendar heatmap: weeks as columns, weekday as rows. Levels are relative to
// the busiest day in view, which is what makes a quiet week visible.
function heatmap(rowsInRange, maxCols, metric) {
  const perDay = new Map();
  for (const row of rowsInRange) {
    const value = metric === "cost"
      ? (costOf(row, priceFor(row.model, row.provider, index)) ?? 0)
      : (row.tokens?.total ?? 0);
    perDay.set(row.day, (perDay.get(row.day) ?? 0) + value);
  }
  const end = newestDay;
  const endDate = new Date(`${end}T00:00:00`);
  // Pad the first column so rows line up with weekday names.
  const dow = endDate.getDay();
  const weeks = Math.max(1, Math.min(maxCols, Math.ceil((daysBetween(rangeCutoff() ?? oldestDay, end) + 1 + dow) / 7)));
  const startSunday = addDays(end, -(weeks * 7 - 1) + (6 - dow));
  const cells = [];
  const values = [];
  for (let w = 0; w < weeks; w += 1) {
    const column = [];
    for (let d = 0; d < 7; d += 1) {
      const day = addDays(startSunday, w * 7 + d);
      const value = perDay.get(day) ?? 0;
      const inRange = day <= end && (!rangeCutoff() || day >= rangeCutoff());
      column.push({ day, value, inRange });
      if (inRange) values.push(value);
    }
    cells.push(column);
  }
  const peak = Math.max(...values, 1);
  return { cells, peak };
}

function heatGlyph(value, peak, inRange) {
  if (!inRange) return dim("·");
  if (value <= 0) return dim("░");
  const ratio = value / peak;
  if (ratio > 0.8) return green("█");
  if (ratio > 0.55) return paint(S.green, "▓");
  if (ratio > 0.3) return paint(S.green, "▒");
  if (ratio > 0.1) return paint(S.green, "░");
  return dim("░");
}

// ------------------------------------------------------------------------------
// Panes
// ------------------------------------------------------------------------------
function renderHeader(cols) {
  const lines = [];
  const title = bold("agent usage");
  const where = dim(usageDir());
  const hosts = snapshots.length;
  lines.push("");
  const titleLine = `  ${title}  ${dim("·")}  ${where}  ${dim("·")}  ${hosts} hosts  ${dim("·")}  ${dim("newest data")} ${newestDay}`;
  // A narrow terminal drops the trailing detail rather than wrapping the header
  // into three lines, which pushed everything below it down the screen.
  lines.push(cols >= 88 ? titleLine : fitText(titleLine, cols));

  // Chips are laid out by one function that returns both the printed text and
  // the column span of every chip. The spans are what a click maps back through,
  // so they are derived from the same strings that get printed: generating them
  // separately is how the click targets drifted from the labels.
  const buildRow = (label, items, active, startLine) => {
    const parts = [];
    const spans = [];
    let column = 2 + label.length + 1; // margin + "range " + space
    for (let i = 0; i < items.length; i += 1) {
      const text = ` ${items[i].label} `;
      if (column + text.length > cols) break; // a half chip breaks clicks too
      spans.push([column, column + text.length - 1]);
      parts.push(i === active ? paint(`${S.reverse}${S.bold}`, text) : dim(text));
      column += text.length + 1;
    }
    return { line: `  ${dim(label)} ${parts.join(" ")}`, spans, shown: spans.length };
  };

  const rangeRow = buildRow("range", RANGES, state.range, lines.length);
  lines.push(rangeRow.line);
  headerChips.row = lines.length;
  headerChips.ranges = rangeRow.spans;

  // Group and sort share one line when it fits. The sort spans must be measured
  // on the COMBINED string, not on the row sort would have had on its own:
  // reusing the standalone spans pointed the sort clicks at "okens" and "ime".
  const groupRow = buildRow("group", TABLES, state.table, lines.length);
  const groupText = groupRow.spans.length
    ? groupRow.line
    : `  ${dim("group")}`;
  const sortText = `   ${dim("sort")} ` + SORTS.map((s, i) =>
    i === state.sort ? paint(`${S.reverse}${S.bold}`, ` ${s.label} `) : dim(` ${s.label} `),
  ).join(" ");
  const combined = groupText + sortText;
  if (width(combined) <= cols) {
    lines.push(combined);
    headerChips.groups = groupRow.spans;
    // Walk the SORTS run on the combined line the same way buildRow walks a row.
    const sorts = [];
    let column = width(groupText) + width(`   ${dim("sort")} `) + 1;
    for (let i = 0; i < SORTS.length; i += 1) {
      const text = ` ${SORTS[i].label} `;
      if (column + text.length > cols) break;
      sorts.push([column, column + text.length - 1]);
      column += text.length + 1;
    }
    headerChips.sorts = sorts;
  } else {
    lines.push(groupRow.line);
    headerChips.groups = groupRow.spans;
    const sortRow = buildRow("sort", SORTS, state.sort, lines.length);
    if (sortRow.shown) {
      lines.push(sortRow.line);
      headerChips.sorts = sortRow.spans;
    } else {
      headerChips.sorts = [];
    }
  }
  return lines;
}
function renderSummary(totals, cols) {
  const lines = [];
  const priced = totals.unpricedRows > 0 ? `${formatMoney(totals.cost)}*` : formatMoney(totals.cost);
  const hours = (totals.activeMs ?? 0) / 3_600_000;
  lines.push("");
  // Build the headline from the parts that fit. Each part is independent, so a
  // narrow terminal loses the hours figure first and the row count next, instead
  // of wrapping one long line that pushes the table down the screen.
  const headline = [
    `  ${bold(padLeft(formatCompact(totals.total), 8))} ${dim("tokens")}`,
    `   ${bold(padLeft(priced, 9))} ${dim("cost")}`,
    `   ${bold(padLeft(formatTokens(totals.messages), 7))} ${dim("messages")}`,
    `   ${bold(padLeft(formatTokens(totals.rows), 6))} ${dim("rows")}`,
  ];
  if (hours > 0.05) headline.push(`   ${bold(padLeft(hours.toFixed(1), 6))} ${dim("hours")}`);
  let line = "";
  for (const part of headline) {
    if (width(line + part) > cols) break;
    line += part;
  }
  lines.push(line || headline[0]);
  // Token kinds, each with its share. Reasoning is excluded from the total by
  // the collector's own convention, so it is shown but never summed in.
  const kinds = [
    ["input", totals.input, cyan],
    ["output", totals.output, magenta],
    ["cache read", totals.cacheRead, blue],
    ["cache write", totals.cacheWrite, yellow],
  ];
  const sum = kinds.reduce((n, [, v]) => n + v, 0) || 1;
  // Two cells per line. When the width cannot hold both, one per line; and the
  // bar shortens rather than overflowing, because a row that wraps looks like a
  // rendering bug even though the numbers are right.
  const perLine = cols >= 76 ? 2 : 1;
  const cellWidth = Math.max(20, Math.floor((cols - 4) / perLine));
  const barWidth = Math.max(3, Math.min(12, cellWidth - 26));
  for (let i = 0; i < kinds.length; i += perLine) {
    const row = kinds.slice(i, i + perLine).map(([label, value, colour]) => {
      const share = value / sum;
      const blocks = Math.max(1, Math.round(share * barWidth));
      return `${pad(label, 11)} ${padLeft(formatCompact(value), 8)} ${dim(padLeft(percent(value, sum), 6))} ${colour("▇".repeat(blocks))}`;
    });
    lines.push(`  ${row.map((cell) => pad(cell, cellWidth)).join(" ").trimEnd()}`);
  }
  if (totals.reasoning) {
    lines.push(fitText(`  ${dim(`reasoning ${formatCompact(totals.reasoning)}, inside output, not added`)}`, cols));
  }
  return lines;
}

function renderChart(visible, cols) {
  const lines = [];
  // 13 columns go to the label on each bar row, so the bars get the rest.
  const width = Math.max(10, Math.min(200, cols - 15));
  const tokensChart = chart(visible, width, "tokens");
  const costChart = chart(visible, width, "cost");
  lines.push("");
  lines.push(`  ${dim("tokens/day")} ${green(tokensChart)}`);
  lines.push(`  ${dim("cost/day  ")} ${yellow(costChart)}`);
  // The axis, so a bar means a date.
  const cutoff = rangeCutoff();
  if (cutoff) {
    const total = daysBetween(cutoff, newestDay) + 1;
    lines.push(`  ${dim(pad(cutoff, Math.max(1, width - newestDay.length - 4)))}${dim(newestDay)} ${dim(`(${total}d)`)}`);
  } else {
    lines.push(`  ${dim(pad(oldestDay, Math.max(1, width - newestDay.length - 4)))}${dim(newestDay)} ${dim("all")}`);
  }
  return lines;
}

function renderHeatmap(visible, cols) {
  const lines = [];
  // Two columns per glyph, four for the weekday label, two for the left margin.
  // Two columns per week (glyph + space) plus a 6-column weekday label.
  const maxWeeks = Math.max(4, Math.floor((cols - 10) / 2));
  const { cells, peak } = heatmap(visible, maxWeeks, "tokens");
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  lines.push("");
  lines.push(fitText(`  ${dim("calendar")} ${dim("tokens per day, brighter is busier")}`, cols));
  for (let d = 0; d < 7; d += 2) {
    const row = cells.map((column) => heatGlyph(column[d].value, peak, column[d].inRange)).join(" ");
    lines.push(`  ${grey(pad(names[d], 4))}${row}`);
  }
  // Axis under the grid, sized to it rather than to the terminal.
  const gridWidth = cells.length * 2 - 1;
  const first = cells[0]?.[0]?.day ?? oldestDay;
  const last = cells[cells.length - 1]?.[6]?.day ?? newestDay;
  const gap = Math.max(1, gridWidth - first.length - last.length);
  lines.push(`  ${" ".repeat(4)} ${dim(`${first}${"-".repeat(gap)}${last}`)}`);
  return lines;
}

// `dataLines` is the number of DATA rows to draw, not a total line budget.
//
// It used to be a total budget and this function quietly spent four lines on the
// blank, the header, the rule and the scroll indicator. The caller then scrolled
// using the budget, so the selected row could sit below the last row actually
// drawn: the highlight vanished and arrow keys appeared to do nothing. Making
// the argument mean what it says is the fix.
//
// `cols` drives which columns survive. A narrow terminal drops the least useful
// ones instead of running past the right edge, where the numbers are simply
// unreadable.
function renderTable(aggregateIn, dataLines, cols = 100) {
  const { ordered, totals } = aggregateIn;
  const lines = [];
  const by = TABLES[state.table].by;
  const compact = cols < 92;
  const narrow = cols < 74;
  const showShare = !narrow;
  const showMsgs = !narrow;
  const showUnit = !compact;
  // The name gets whatever is left after the numeric columns it must show.
  const fixed = 2 + 9 + (showShare ? 17 : 0) + 10 + (showMsgs ? 8 : 0) + (showUnit ? 7 : 0) + 4;
  const nameWidth = Math.max(10, Math.min(30, cols - fixed));

  const header =
    `  ${pad(dim(by), nameWidth)} ${padLeft(dim("tokens"), 9)}` +
    (showShare ? ` ${padLeft(dim("share"), 17)}` : "") +
    ` ${padLeft(dim("cost"), 10)}` +
    (showMsgs ? ` ${padLeft(dim("msgs"), 7)}` : "") +
    (showUnit ? ` ${padLeft(dim("$/M"), 7)}` : "");
  lines.push("");
  lines.push(header);
  lines.push(`  ${dim("─".repeat(Math.max(20, header.length - 2)))}`);

  const peak = Math.max(1, ...ordered.map(([, v]) => v.total));
  const rows = Math.max(0, Math.min(dataLines, ordered.length - state.scroll));
  const list = ordered.slice(state.scroll, state.scroll + rows);
  const above = state.scroll;
  const below = Math.max(0, ordered.length - state.scroll - list.length);
  for (let i = 0; i < list.length; i += 1) {
    const absolute = state.scroll + i;
    const [key, value] = list[i];
    const selected = absolute === state.cursor;
    const blocks = Math.max(1, Math.round((value.total / peak) * 10));
    const barText = green("▇".repeat(blocks)) + dim("·".repeat(Math.max(0, 10 - blocks)));
    const label = fitText(key, nameWidth);
    let line =
      `${pad(selected ? paint(S.reverse, label + " ".repeat(Math.max(0, nameWidth - label.length))) : label, nameWidth)} ` +
      `${padLeft(formatCompact(value.total), 9)}`;
    if (showShare) line += ` ${barText} ${padLeft(percent(value.total, totals.total || 1), 5)}`;
    line += ` ${padLeft(value.unpricedRows > 0 ? `${formatMoney(value.cost)}*` : formatMoney(value.cost), 10)}`;
    if (showMsgs) line += ` ${padLeft(formatTokens(value.messages), 7)}`;
    if (showUnit) line += ` ${padLeft(value.total ? ((value.cost / value.total) * 1e6).toFixed(3) : "-", 7)}`;
    lines.push(`  ${line}`);
  }
  // One line, both directions, so the reader knows where they are in the list
  // whether they are at the top, the middle or the end.
  if (ordered.length === 0) {
    lines.push(`  ${yellow("no rows match")} ${dim(state.search ? `"${state.search}" in ${RANGES[state.range].label}` : "the current filters")}`);
    lines.push(`  ${dim("Esc clears the filter, 6 shows lifetime")}`);
    return lines;
  }
  const position = `${state.cursor + 1}/${ordered.length}`;
  if (above > 0 || below > 0) {
    const parts = [];
    if (above > 0) parts.push(`${above} above`);
    if (below > 0) parts.push(`${below} below`);
    const hint = cols >= 60 ? `, ↑↓ PgUp/PgDn Home/End` : "";
    lines.push(fitText(`  ${dim(`… ${parts.join(", ")}  (row ${position}${hint})`)}`, cols));
  } else {
    lines.push(`  ${dim(`row ${position} of ${ordered.length}`)}`);
  }
  return lines;
}

function renderDetail(aggregateIn, cols) {
  const { ordered } = aggregateIn;
  const entry = ordered[state.cursor];
  if (!entry) return [];
  const [key, value] = entry;
  const visible = visibleRows();
  // What this group is made of: its models, or its days when grouped by day.
  const by = TABLES[state.table].by;
  const lines = [];
  lines.push("");
  lines.push(`  ${bold(fitText(key, cols - 6))} ${dim(`(${by})`)}`);
  const field = by === "model" ? "harness" : "model";
  const breakdown = new Map();
  for (const row of visible) {
    if (GROUP_KEYS[by](row) !== key) continue;
    const other = GROUP_KEYS[field](row);
    const bucket = breakdown.get(other) ?? { total: 0, cost: 0 };
    bucket.total += row.tokens?.total ?? 0;
    bucket.cost += costOf(row, priceFor(row.model, row.provider, index)) ?? 0;
    breakdown.set(other, bucket);
  }
  const top = [...breakdown.entries()].sort((a, b) => b[1].total - a[1].total).slice(0, 4);
  const peak = Math.max(1, ...top.map(([, v]) => v.total));
  // name column and bar shrink together; on a narrow terminal the bar goes and
  // the name keeps its room, because the name is the information.
  const nameCol = Math.max(8, Math.min(34, cols - 30));
  const barWidth = Math.max(0, Math.min(10, cols - nameCol - 22));
  for (const [name, bucket] of top) {
    const blocks = barWidth ? Math.max(1, Math.round((bucket.total / peak) * barWidth)) : 0;
    const bar = barWidth ? ` ${blue("▇".repeat(blocks))}` : "";
    lines.push(`  ${dim(pad(field, 8))} ${pad(fitText(name, nameCol), nameCol)} ${padLeft(formatCompact(bucket.total), 8)}${bar}`);
  }
  return lines;
}

// Two lines, always on screen: the keys a first-time reader needs, then the
// search box and status. Hiding hints behind `?` alone means a new user sees a
// wall of numbers and no way in.
function renderFooter(cols) {
  const lines = [];
  const status = state.status && Date.now() < state.statusUntil ? `   ${yellow(state.status)}` : "";
  // No leading blank line: the table already ends with its scroll indicator, and
  // that empty row was dead space at the bottom of every screen.
  const keys =
    `  ${bold("?")} help  ${bold("/")} search  ${bold("1-6")} range  ${bold("tgmhpr")} group  ` +
    `${bold("↑↓")} move  ${bold("PgUp/PgDn")} page  ${bold("c")} cost  ${bold("r")} prices  ${bold("q")} quit`;
  lines.push(fitText(keys, cols));
  // Left: the filter state. Right: nothing unless a filter is active, so the
  // line carries information instead of a second static hint.
  const query = state.searching
    ? `${cyan("/")}${state.search}${paint(S.reverse, " ")}`
    : state.search
      ? `${dim("/")}${state.search} ${dim(`(${visibleRows().length} rows match, Esc clears)`)}`
      : dim("no filter");
  lines.push(`  ${dim("filter")} ${query}${status}`);
  return lines;
}

// The `?` overlay. Every binding in one place, in the order it appears on
// screen, so it doubles as the manual for the layout.
function renderHelp(cols) {
  const rows = [
    ["ranges", "1 today   2 7d   3 30d   4 90d   5 1y   6 lifetime"],
    ["groups", "t tokens   g day   m model   p provider   h harness   s host   r project"],
    ["stepping", "← → cycle groups"],
    ["moving", "↑ ↓ or j k one row   PgUp PgDn one page   Home End first and last"],
    ["sorting", "t tokens   c cost   a active time"],
    ["search", "/ type to filter (Enter or Esc keeps it, Esc again clears)"],
    ["data", "r refresh prices   R reload snapshots from disk"],
    ["mouse", "wheel scrolls the table, click selects a row, click a chip to switch"],
    ["quit", "q or Ctrl-C"],
  ];
  const labelWidth = Math.max(...rows.map(([label]) => label.length)) + 2;
  const lines = [];
  lines.push("");
  lines.push(`  ${bold("keys")}`);
  lines.push("");
  for (const [label, text] of rows) {
    lines.push(`  ${pad(dim(label), labelWidth)}${fitText(text, cols - labelWidth - 4)}`);
  }
  lines.push("");
  lines.push(`  ${dim("Esc or ? closes this")}`);
  return lines;
}

// ------------------------------------------------------------------------------
// Draw
//
// The layout is built top-down and every section is optional, so nothing can be
// pushed off the bottom: the table shrinks first, then the heatmap, then the
// detail pane. That is what makes "scroll to the bottom" always possible at any
// window height.
// Build the screen as an array of lines. `draw` and `--frame` both call this, so
// the headless render is the same layout that ships.
//
// The rule that matters: the panel is built from a real line budget, and the
// number of DATA rows handed to renderTable is the number that will actually be
// drawn. Every earlier version scrolled using an assumed height, so on a short
// terminal the cursor walked off the bottom of the table and the highlight
// disappeared: arrow keys looked broken when they were working fine.
//
// Degradation order when the window is short, cheapest to lose first:
//   detail pane, chart, heatmap, summary, then data rows down to 1.
function layout(cols, screenRows) {
  const agg = aggregate();
  const footer = renderFooter(cols);
  // One row left clear at the very bottom: drawing on the last cell of a
  // terminal makes some of them scroll a line and shears the whole frame.
  const budget = screenRows - 1 - footer.length;

  if (state.help) {
    const body = [...renderHeader(cols), ...renderHelp(cols)];
    return [...body.slice(0, budget), ...footer].slice(0, screenRows - 1);
  }

  const header = renderHeader(cols);
  // On a terminal this short, the first thing to lose is the decoration: the
  // title line, then the sort chips. Dropping them buys the table its header,
  // rule and scroll indicator, which are all more useful than a repeated title.
  const headerTrimmed = screenRows < 20 ? header.slice(1) : header;
  const summaryFull = renderSummary(agg.totals, cols);
  // A table costs 3 fixed lines before its data (blank, header, rule) and 1
  // after it (the scroll indicator). Budget them before anything else, or the
  // last data row lands under the indicator and never gets drawn.
  //
  // 5, not 4: the indicator itself is often two lines when there are rows on
  // both sides of the window, and on a 14-row terminal the second one was the
  // first thing cut, taking the row counter with it.
  const TABLE_FIXED = 5;
  // On a very short terminal the token-kind breakdown is the first thing to go:
  // it is the least load-bearing block, and dropping it buys the table its
  // header, rule and scroll indicator instead of a truncated mess.
  const summary = budget - headerTrimmed.length - summaryFull.length - TABLE_FIXED < 3
    ? summaryFull.slice(0, 2)
    : summaryFull;
  const total = agg.ordered.length;

  // Clamp the cursor to real rows first, so the arithmetic below is about
  // showing an existing row rather than one that filtering removed.
  state.cursor = Math.max(0, Math.min(state.cursor, total - 1));

  // Read-only-priority allocation: measure each optional section, take it only
  // if it fits whole, keep the rest for the table.
  const heatLinesAll = renderHeatmap(agg.visible, cols);
  const chartLinesAll = renderChart(agg.visible, cols);
  const detailLinesAll = renderDetail(agg, cols);

  let room = budget - headerTrimmed.length - summary.length - TABLE_FIXED;
  // Give the table a comfortable share first, not the whole budget. Letting it
  // take everything made a tall window show nothing but rows: the heatmap and
  // chart were starved even with 40 lines to spend.
  //
  // `dataRows` is data only. The table chrome is already out of `room`, and 1
  // row is the floor so a short terminal still shows which row is selected.
  //
  // The clamp to `room` is essential: without it dataRows could exceed the space
  // left, the body then overflowed the budget, and the final slice cut the
  // scroll indicator and sometimes the selected row with it.
  const comfortable = Math.max(3, Math.min(14, Math.floor(room * 0.55)));
  let dataRows = Math.max(1, Math.min(Math.min(total, comfortable), Math.max(1, room)));
  room -= dataRows;

  // Chart before heatmap. Both answer "when", but the chart costs 3 lines and the
  // heatmap 6, so when room is short the chart is the one worth keeping: it
  // shows trend and peak in one glance, while a heatmap squeezed to a couple of
  // weeks shows almost nothing.
  let chart = [];
  if (room >= chartLinesAll.length && chartLinesAll.length) {
    chart = chartLinesAll;
    room -= chart.length;
  }
  let heat = [];
  if (room >= heatLinesAll.length && heatLinesAll.length) {
    heat = heatLinesAll;
    room -= heat.length;
  }
  let detail = [];
  if (room >= 3 && detailLinesAll.length) {
    detail = detailLinesAll.slice(0, room);
    room -= detail.length;
  }
  // Whatever is left grows the table, so a tall window fills to the footer with
  // real rows instead of leaving a gap.
  if (room > 0) {
    const extra = Math.max(0, Math.min(room, total - dataRows));
    dataRows += extra;
    room -= extra;
  }

  // Scroll so the selected row is inside the window. This is the whole point:
  // the drawn slice starts at `scroll` and is `dataRows` long, and the cursor is
  // forced into that range, so the highlight is always on screen.
  if (state.cursor < state.scroll) state.scroll = state.cursor;
  if (state.cursor >= state.scroll + dataRows) state.scroll = state.cursor - dataRows + 1;
  const maxScroll = Math.max(0, total - dataRows);
  if (state.scroll > maxScroll) state.scroll = maxScroll;
  if (state.scroll < 0) state.scroll = 0;

  const table = renderTable(agg, dataRows, cols);

  // Absolute row of the FIRST DATA row, 1-based, so a click maps back to an
  // index. renderTable emits blank, header and rule before the data.
  // Must list the sections in the SAME order the body prints them, below:
  // header, summary, chart, heat, then the table. Ordered the other way the
  // click target was off by the height difference between chart and heatmap.
  hotspots.tableTop = headerTrimmed.length + summary.length + chart.length + heat.length + 4;
  hotspots.rows = Math.max(0, Math.min(dataRows, total - state.scroll));
  hotspots.ranges = headerChips.ranges;
  hotspots.groups = headerChips.groups;
  hotspots.sorts = headerChips.sorts ?? [];

  const body = [...headerTrimmed, ...summary, ...chart, ...heat, ...table, ...detail];
  return [...body.slice(0, budget), ...footer].slice(0, screenRows - 1);
}

function draw() {
  const { cols, rows: screenRows } = termSize();
  const body = layout(cols, screenRows).slice(0, screenRows - 1);
  out.write(CLEAR + body.map((line, i) => moveTo(i + 1, 1) + line).join(""));
}

// Where the chips sit on row `headerChips.row`, as [startCol, endCol] per chip.
// Built by renderHeader so a click lands on the label it is over.
const headerChips = { ranges: [], groups: [], row: 2 };
// Screen coordinates of the table, refreshed by draw: 1-based row of the first
// data line, and how many lines it occupies.
const hotspots = { tableTop: 0, rows: 0, ranges: [], groups: [] };

// ------------------------------------------------------------------------------
// Keys
// ------------------------------------------------------------------------------
const PAGE = 10;

// SGR mouse reports from the terminal, when 1006 mode is on:
//   ESC [ < b ; x ; y M   (press or wheel)
//   ESC [ < b ; x ; y m   (release)
function parseMouse(seq) {
  const match = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(seq);
  if (!match) return null;
  const code = Number(match[1]);
  const x = Number(match[2]);
  const y = Number(match[3]);
  const release = match[4] === "m";
  // Wheel is bit 64. Low two bits pick the button, bit 32 is the motion flag.
  const wheel = (code & 64) !== 0;
  const button = code & 3;
  return { wheel, up: wheel && button === 0, down: wheel && button === 1, x, y, release, code };
}

function scrollBy(delta) {
  const agg = aggregate();
  state.cursor = Math.max(0, Math.min(agg.ordered.length - 1, state.cursor + delta));
  draw();
}

function clickAt(x, y) {
  const chipRow = state.help ? -1 : headerChips.row;
  if (y === chipRow) {
    const hit = (spans) => spans.findIndex(([a, b]) => x >= a && x <= b);
    const range = hit(headerChips.ranges);
    if (range >= 0) { state.range = range; state.cursor = 0; state.scroll = 0; draw(); return; }
    const group = hit(headerChips.groups);
    if (group >= 0) { state.table = group; state.cursor = 0; state.scroll = 0; draw(); return; }
    const sort = hit(headerChips.sorts ?? []);
    if (sort >= 0) { state.sort = sort; state.cursor = 0; draw(); return; }
    return;
  }
  if (state.help) return;
  // Table rows: row 1 of the body is the first printed line.
  const first = hotspots.tableTop;
  const index = y - first;
  if (index >= 0 && index < hotspots.rows) {
    const agg = aggregate();
    const target = state.scroll + index;
    if (target < agg.ordered.length) {
      state.cursor = target;
      draw();
    }
  }
}

function onKey(buffer) {
  const raw = buffer.toString("utf8");

  // Mouse sequences arrive whole per read. Handle them before anything else so
  // their bytes are never mistaken for the digits and letters inside them.
  if (raw.startsWith("\x1b[<")) {
    const mouse = parseMouse(raw.trim());
    if (mouse?.wheel && mouse.up) scrollBy(-3);
    else if (mouse?.wheel && mouse.down) scrollBy(3);
    else if (mouse && !mouse.wheel && !mouse.release) clickAt(mouse.x, mouse.y);
    return;
  }

  // Search mode takes every printable key as text. Navigation still works, so a
  // filter can be refined while walking the results.
  if (state.searching) {
    if (raw === "\r" || raw === "\n") { state.searching = false; draw(); return; }
    if (raw === "\x1b") { state.searching = false; draw(); return; }
    if (raw === "\x7f" || raw === "\b") {
      state.search = state.search.slice(0, -1);
      state.cursor = 0;
      state.scroll = 0;
      draw();
      return;
    }
    if (raw === "\x1b[A") { scrollBy(-1); return; }
    if (raw === "\x1b[B") { scrollBy(1); return; }
    if (raw >= " " && raw <= "~") {
      state.search += raw;
      state.cursor = 0;
      state.scroll = 0;
      draw();
      return;
    }
    return;
  }

  // Arrow keys arrive as ESC [ A/B/C/D. They must be recognised HERE, before
  // the switch, because a bare `\x1b` is also Esc: matching Esc first would
  // swallow every arrow.
  const ARROWS = { "\x1b[A": "up", "\x1b[B": "down", "\x1b[C": "right", "\x1b[D": "left" };
  const arrow = ARROWS[raw];
  if (arrow) {
    if (arrow === "up") scrollBy(-1);
    else if (arrow === "down") scrollBy(1);
    else if (arrow === "right") { state.table = (state.table + 1) % TABLES.length; state.cursor = 0; state.scroll = 0; draw(); }
    else { state.table = (state.table - 1 + TABLES.length) % TABLES.length; state.cursor = 0; state.scroll = 0; draw(); }
    return;
  }

  // Help is a mode: any of Esc, ? or q closes it and returns to the report.
  if (state.help) {
    if (raw === "?" || raw === "\x1b" || raw === "q" || raw === "h") {
      state.help = false;
      draw();
    }
    return;
  }

  const digit = RANGES.findIndex((r) => r.key === raw);
  if (digit >= 0) {
    state.range = digit;
    state.cursor = 0;
    state.scroll = 0;
    draw();
    return;
  }

  switch (raw) {
    case "q":
    case "\x03":
      quit();
      return;
    case "?":
      state.help = true;
      draw();
      return;
    case "/":
      state.searching = true;
      state.search = "";
      draw();
      return;
    case "\x1b":
      // Esc outside search: clear an active filter, otherwise do nothing.
      if (state.search) { state.search = ""; state.cursor = 0; state.scroll = 0; draw(); }
      return;
    case "j":
    case "down":
      scrollBy(1);
      return;
    case "k":
    case "up":
      scrollBy(-1);
      return;
    case "\x1b[6~": // PgDn
      scrollBy(PAGE);
      return;
    case "\x1b[5~": // PgUp
      scrollBy(-PAGE);
      return;
    case "\x1b[F": // End
    case "\x1b[4~": {
      const agg = aggregate();
      state.cursor = Math.max(0, agg.ordered.length - 1);
      draw();
      return;
    }
    case "\x1b[H": // Home
    case "\x1b[1~":
      state.cursor = 0;
      state.scroll = 0;
      draw();
      return;
    case "c":
      state.sort = SORTS.findIndex((s) => s.field === "cost");
      state.cursor = 0;
      draw();
      return;
    case "a":
      state.sort = SORTS.findIndex((s) => s.field === "activeMs");
      state.cursor = 0;
      draw();
      return;
    case "t":
      state.sort = 0;
      state.cursor = 0;
      draw();
      return;
    case "g":
      state.table = TABLES.findIndex((t) => t.by === "day");
      state.cursor = 0;
      state.scroll = 0;
      draw();
      return;
    case "m":
    case "p":
    case "h":
    case "s":
    case "r": {
      const target = { m: "model", p: "provider", h: "harness", s: "host", r: "project" }[raw];
      state.table = TABLES.findIndex((t) => t.by === target);
      state.cursor = 0;
      state.scroll = 0;
      draw();
      return;
    }
    case "R":
      // Reload snapshots: a collect on another machine lands on disk, and this
      // is how the screen picks it up without a restart.
      state.status = "reloading snapshots…";
      state.statusUntil = Date.now() + 5000;
      load();
      state.status = `reloaded ${snapshots.length} snapshots`;
      state.statusUntil = Date.now() + 3000;
      draw();
      return;
    case "\x12": // Ctrl-R
      refreshNow();
      return;
    default:
      return;
  }
}

async function refreshNow() {
  state.status = "refreshing prices…";
  state.statusUntil = Date.now() + 60_000;
  draw();
  try {
    const result = await refreshPrices();
    load();
    state.status = `prices: ${result.count} models refreshed`;
  } catch (error) {
    state.status = `prices failed: ${error.message}`;
  }
  state.statusUntil = Date.now() + 4000;
  draw();
}

// ------------------------------------------------------------------------------
// Lifecycle
// ------------------------------------------------------------------------------
let finished = false;
function quit() {
  if (finished) return;
  finished = true;
  stdin.setRawMode?.(false);
  stdin.pause();
  // Turn mouse reporting off before leaving the alternate screen, or the shell
  // keeps receiving click sequences after the program is gone.
  out.write(`${ESC}?1006l${ESC}?1000l${SHOW_CURSOR}${ESC}?1049l`);
  process.exit(0);
}

function start() {
  // `--frame` renders one screen to stdout and exits. Redirecting the TUI's
  // output makes it a pipe, so there is no other way to see the layout in a
  // test without a real terminal.
  if (process.argv.includes("--frame")) {
    const keys = process.argv.filter((a) => /^[0-9tgmpchskaRr?]$/.test(a) || a.startsWith("q=") || a.startsWith("c="));
    load();
    for (const k of keys) {
      if (k.startsWith("q=")) { state.search = k.slice(2); continue; }
      // c=N moves the cursor, so the scroll/highlight invariant is testable at
      // any position without a terminal.
      if (k.startsWith("c=")) { state.cursor = Number(k.slice(2)) || 0; continue; }
      if (k === "?") { state.help = true; continue; }
      const rangeIndex = RANGES.findIndex((r) => r.key === k);
      if (rangeIndex >= 0) { state.range = rangeIndex; continue; }
      if (k === "g") { state.table = TABLES.findIndex((t) => t.by === "day"); continue; }
      if (k === "c") { state.sort = SORTS.findIndex((s) => s.field === "cost"); continue; }
      if (k === "a") { state.sort = SORTS.findIndex((s) => s.field === "activeMs"); continue; }
      if (k === "t") { state.sort = 0; continue; }
      const target = { m: "model", p: "provider", h: "harness", s: "host", r: "project" }[k];
      if (target) state.table = TABLES.findIndex((t) => t.by === target);
    }
    const { cols } = termSize();
    const screenRows = Number(process.env.LINES) || 40;
    const frame = layout(cols, screenRows);
    // TUI_DEBUG_HOTSPOTS prints the click map, so a test can prove a click
    // lands on the row it looks like rather than trusting the arithmetic.
    if (process.env.TUI_DEBUG_HOTSPOTS) {
      if (process.env.TUI_DEBUG_SPANS) console.log(`SPANS groups=${JSON.stringify(hotspots.groups)} sorts=${JSON.stringify(hotspots.sorts)}`);
      console.log(`HOTSPOTS tableTop=${hotspots.tableTop} rows=${hotspots.rows} scroll=${state.scroll} cursor=${state.cursor}`);
    }
    console.log(frame.slice(0, screenRows - 1).join("\n"));
    return;
  }
  if (!out.isTTY) {
    console.error("usage tui needs a terminal. Use `usage` for the plain report, or `usage --json`.");
    process.exit(1);
  }
  load();
  // 1049h alternate screen, 25l hide cursor, 1000h+1006h report mouse clicks
  // and presses in SGR form (needed for coordinates beyond column 223).
  out.write(`${ESC}?1049h${HIDE_CURSOR}${ESC}?1000h${ESC}?1006h`);
  stdin.setRawMode?.(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  stdin.on("data", onKey);
  out.on("resize", draw);
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
  draw();
}

start();
