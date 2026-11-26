// Local OTLP/HTTP receiver (JSON encoding). Binds 127.0.0.1 only, accepts
// requests only for a loopback Host header, and stores nothing but the
// SkillEvents the adapters derive. Raw request bodies are never written or
// logged. Metrics and traces are acknowledged and discarded.

import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { gunzipSync, inflateSync } from 'node:zlib';
import { anonymize, appendJsonLine, readJson, salt, snaglogHome, writeJson } from '../../lib/home.mjs';
import { logRecords } from './otlp.mjs';
import { createHintStore } from './hints.mjs';
import * as claudeCode from './adapters/claude-code.mjs';
import * as codex from './adapters/codex.mjs';

export const DEFAULT_PORT = 4318;
export const HOST = '127.0.0.1';
const MAX_BODY = 5 * 1024 * 1024;
const MAX_INFLATED = 25 * 1024 * 1024;
const PATHS = new Set(['/v1/logs', '/v1/metrics', '/v1/traces']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export const ADAPTERS = [claudeCode, codex];

/** Append events to ~/.snaglog/events/<UTC day>.jsonl */
export function createEventStore(home) {
  return {
    append(events) {
      for (const event of events) appendJsonLine(join(home, 'events', `${event.time.slice(0, 10)}.jsonl`), event);
    },
  };
}

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function decode(buffer, encoding) {
  const enc = String(encoding ?? '').toLowerCase();
  if (enc === 'gzip') return gunzipSync(buffer, { maxOutputLength: MAX_INFLATED });
  if (enc === 'deflate') return inflateSync(buffer, { maxOutputLength: MAX_INFLATED });
  if (enc && enc !== 'identity') throw Object.assign(new Error(`unsupported content-encoding ${enc}`), { status: 415 });
  return buffer;
}

/**
 * Build a receiver. `ingest(request)` is the transport-independent core and
 * is what the tests exercise directly; `server` wraps it in HTTP.
 */
export function createReceiver({ env = process.env, now = () => Date.now() } = {}) {
  const home = snaglogHome(env);
  const saltValue = salt(env);
  const hash = (value) => anonymize(value, saltValue);
  const hints = createHintStore(home);
  const adapters = ADAPTERS.map((mod) => mod.createAdapter({ anonymize: hash, hints }));
  const store = createEventStore(home);
  const connectionsFile = join(home, 'connections.json');
  const seen = {};
  let lastFlush = 0;

  function noteSeen(agent, time) {
    seen[agent] = time;
    if (now() - lastFlush < 5000) return;
    lastFlush = now();
    const state = readJson(connectionsFile, {});
    for (const [name, at] of Object.entries(seen)) state[name] = { ...(state[name] ?? {}), lastEventAt: at };
    writeJson(connectionsFile, state);
  }

  function ingest(request) {
    const events = [];
    let unknown = 0;
    for (const item of logRecords(request)) {
      const adapter = adapters.find((a) => a.matches(item));
      if (!adapter) {
        unknown += 1;
        continue;
      }
      noteSeen(adapter.agent, new Date(now()).toISOString());
      events.push(...adapter.handle(item));
    }
    store.append(events);
    return { events, unknown };
  }

  function sweep() {
    const events = adapters.flatMap((a) => a.sweep(now()));
    store.append(events);
    return events;
  }

  const server = createServer(async (req, res) => {
    try {
      const host = String(req.headers.host ?? '').replace(/:\d+$/, '');
      if (!LOOPBACK_HOSTS.has(host)) return send(res, 403, { error: 'loopback only' });
      const path = new URL(req.url, 'http://127.0.0.1').pathname;
      if (!PATHS.has(path)) return send(res, 404, { error: 'not found' });
      if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
      const type = String(req.headers['content-type'] ?? '').toLowerCase();
      if (type.includes('protobuf')) {
        return send(res, 415, { error: 'snaglog accepts OTLP JSON only; set OTEL_EXPORTER_OTLP_PROTOCOL=http/json (Claude Code) or protocol = "json" (Codex)' });
      }
      if (!type.includes('application/json')) return send(res, 415, { error: 'content-type must be application/json' });
      if (Number(req.headers['content-length'] ?? 0) > MAX_BODY) {
        res.setHeader('connection', 'close');
        return send(res, 413, { error: 'body too large' });
      }
      const body = decode(await readBody(req), req.headers['content-encoding']);
      if (path !== '/v1/logs') return send(res, 200, {});
      let request;
      try {
        request = JSON.parse(body.toString('utf8'));
      } catch {
        return send(res, 400, { error: 'invalid JSON' });
      }
      ingest(request);
      return send(res, 200, {});
    } catch (error) {
      return send(res, error.status ?? 500, { error: error.status ? error.message : 'internal error' });
    }
  });

  let timer;
  return {
    server,
    ingest,
    sweep,
    listen(port = DEFAULT_PORT) {
      return new Promise((resolve, reject) => {
        server.once('error', (error) => {
          if (error.code === 'EADDRINUSE') error.message = `port ${port} is already in use${portOwner(port)}`;
          reject(error);
        });
        server.listen(port, HOST, () => {
          timer = setInterval(sweep, 60 * 1000);
          timer.unref();
          resolve(server.address());
        });
      });
    },
    close() {
      clearInterval(timer);
      sweep();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

/** Best effort: name the process holding a port (macOS / Linux, via lsof). */
export function portOwner(port) {
  const r = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fc'], { encoding: 'utf8' });
  const name = r.status === 0 ? /^c(.+)$/m.exec(r.stdout)?.[1] : undefined;
  return name ? ` by "${name}"; stop it or start snaglog with another port` : '; start snaglog with another port';
}
