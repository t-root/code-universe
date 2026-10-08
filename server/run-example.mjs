// Runs a JavaScript example in a sandbox and returns what it prints, so the
// "## Kết quả" section of a note is real output, never typed by hand.
//
// Every `console.log(expr)` is rewritten to show its own expression:
//     console.log(arr.map(x => x * 2))   ->   arr.map(x => x * 2) → [ 2, 4, 6 ]
// A log whose first argument is a string literal prints like Node does
// (console.log('Tổng:', 3) -> Tổng: 3). Dates run in UTC.
import vm from 'node:vm';
import util from 'node:util';
import path from 'node:path';
import events from 'node:events';
import assert from 'node:assert';
import nodeUrl from 'node:url';
import querystring from 'node:querystring';
import stringDecoder from 'node:string_decoder';
import { Buffer } from 'node:buffer';
import stream from 'node:stream';
import streamPromises from 'node:stream/promises';
import timersPromises from 'node:timers/promises';
import nodeCrypto from 'node:crypto';
import zlib from 'node:zlib';

process.env.TZ = 'UTC';
// An example that leaves a rejection unhandled must not take the importer down.
process.on('unhandledRejection', () => {});
process.on('uncaughtException', () => {});

const MODULES = {
  path, events, assert, url: nodeUrl, util, querystring, string_decoder: stringDecoder, buffer: { Buffer },
  stream, 'stream/promises': streamPromises, 'timers/promises': timersPromises, crypto: nodeCrypto, zlib,
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Index of the ")" matching the "(" at `open`, skipping strings, templates
// and comments; -1 when there is none.
function matchParen(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++;
    } else if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (c === '/' && src[i + 1] === '*') {
      i = src.indexOf('*/', i + 2);
      if (i < 0) return -1;
      i++;
    } else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i;
  }
  return -1;
}

// Is `index` inside a string, template or comment?
function inLiteral(src, index) {
  for (let i = 0; i < index; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++;
      if (i >= index) return true;
    } else if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      if (i >= index) return true;
    } else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end < 0 || end >= index) return true;
      i = end + 1;
    }
  }
  return false;
}

// Is the first argument of a console.log call one whole string literal
// ('text', "text" or `text ${x}`), followed by "," or the end?
const FIRST_ARG_LITERAL = /^(?:'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`)\s*(?:,|$)/;

function instrument(code) {
  const hits = [];
  for (const m of code.matchAll(/\bconsole\.log\(/g)) {
    if (inLiteral(code, m.index)) continue;
    const open = m.index + m[0].length - 1;
    const close = matchParen(code, open);
    if (close < 0) continue;
    hits.push({ start: m.index, close, args: code.slice(open + 1, close) });
  }
  let out = code;
  for (const h of hits.reverse()) {
    const label = h.args.replace(/\s*\n\s*/g, ' ').trim();
    const literal = FIRST_ARG_LITERAL.test(h.args.trimStart());
    out = `${out.slice(0, h.start)}__show(${JSON.stringify(label)}, ${literal}, ${h.args})${out.slice(h.close + 1)}`;
  }
  return out;
}

const inspect = (v) =>
  util.inspect(v, { depth: 5, breakLength: Infinity, compact: true, maxArrayLength: 30, maxStringLength: 200 });

/** @returns {Promise<{lines: string[], error?: string}>} */
export async function runExample(code, { timeout = 2500 } = {}) {
  const lines = [];
  const timers = new Set();
  const track = (set, fn, ms, args, repeat) => {
    const t = (repeat ? setInterval : setTimeout)(() => {
      if (!repeat) set.delete(t);
      fn(...args);
    }, ms);
    set.add(t);
    return t;
  };
  const intervals = new Set();
  const say = (...a) => lines.push(util.format(...a));
  const sandbox = {
    console: { log: say, info: say, warn: say, error: say, debug: say },
    __show: (label, isFormat, ...vals) => {
      if (isFormat) say(...vals);
      else {
        const one = `${label} → ${vals.map(inspect).join(' ')}`;
        if (one.length <= 100) lines.push(one);
        else {
          // too long for one line: break the value across lines like Node does
          const pretty = vals.map((v) => util.inspect(v, { depth: 5, breakLength: 60, compact: 3, maxArrayLength: 30 })).join(' ');
          lines.push(`${label} →`, ...pretty.split('\n').map((l) => `  ${l}`));
        }
      }
    },
    setTimeout: (fn, ms = 0, ...a) => track(timers, fn, ms, a, false),
    setInterval: (fn, ms = 0, ...a) => track(intervals, fn, ms, a, true),
    clearTimeout: (t) => (timers.delete(t), clearTimeout(t)),
    clearInterval: (t) => (intervals.delete(t), clearInterval(t)),
    setImmediate,
    queueMicrotask,
    structuredClone,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    AbortController,
    AbortSignal,
    EventTarget,
    Event,
    Buffer,
    atob,
    btoa,
    crypto: globalThis.crypto,
    performance: { now: () => 0 },
    process: { nextTick: process.nextTick.bind(process), argv: ['node', 'app.js'], env: {}, platform: 'linux' },
    require: (name) => {
      const m = MODULES[name.replace(/^node:/, '')];
      if (!m) throw new Error(`require('${name}') không có trong sandbox`);
      return m;
    },
  };
  vm.createContext(sandbox);
  const deadline = Date.now() + timeout;
  try {
    const script = new vm.Script(`(async () => {\n${instrument(code)}\n})()`);
    const done = script.runInContext(sandbox, { timeout });
    await Promise.race([done, sleep(timeout).then(() => Promise.reject(new Error('quá thời gian chạy')))]);
    await new Promise((r) => setImmediate(r));
    while (timers.size && Date.now() < deadline) await sleep(5);
    return { lines };
  } catch (e) {
    return { lines, error: `${e?.name ?? 'Error'}: ${e?.message ?? e}` };
  } finally {
    for (const t of [...timers, ...intervals]) clearTimeout(t), clearInterval(t);
  }
}

// node server/run-example.mjs file.js  -> prints the output (handy while writing)
if (process.argv[1] && process.argv[1].endsWith('run-example.mjs') && process.argv[2]) {
  const { readFileSync } = await import('node:fs');
  const r = await runExample(readFileSync(process.argv[2], 'utf8'));
  console.log(r.lines.join('\n'));
  if (r.error) console.error('LỖI:', r.error);
}
