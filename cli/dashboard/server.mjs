// `snaglog dashboard` — the OTLP receiver (127.0.0.1:4318) plus a local web
// dashboard (127.0.0.1:4747). Both listen on loopback only.
//
// Hardening: requests must carry a loopback Host header (DNS rebinding);
// every /api request needs the per-start token embedded in the page, and
// state-changing requests also need a same-origin Origin (CSRF); the page is
// served with a strict Content-Security-Policy and loads nothing external.
// The dashboard writes nothing to GitHub except an unsent report the user
// explicitly sends.

import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createReceiver, DEFAULT_PORT as OTLP_PORT } from '../collect/otel/receiver.mjs';
import { UNSUPPORTED } from '../connect/common.mjs';
import { snaglogHome } from '../lib/home.mjs';
import { loadConnections, loadEvals, loadEvents, loadLocalReports, loadSnags, repoSkills, skillChanges } from './data.mjs';
import { compare, overview, skillDetail } from './metrics.mjs';
import { deleteReport, listUnsent, sendReport, updateReport } from './reports.mjs';

export const DEFAULT_PORT = 4747;
export const HOST = '127.0.0.1';
const PAGE = readFileSync(fileURLToPath(new URL('./index.html', import.meta.url)), 'utf8');
const SKILL = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,127}$/;
const MAX_BODY = 256 * 1024;

const AGENTS = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    tips: [
      'Restart Claude Code after `snaglog connect claude-code`.',
      'Logs are exported every 5 s: run one prompt that uses a skill, then reload.',
      'OTEL_EXPORTER_OTLP_LOGS_PROTOCOL must be http/json; protobuf is rejected.',
      'Managed (organisation) settings can override your user settings.',
    ],
  },
  {
    id: 'codex',
    label: 'Codex',
    tips: [
      'Restart Codex after `snaglog connect codex`.',
      'The [otel] exporter endpoint must end in /v1/logs and use protocol = "json".',
      'Codex builds before 2026-09-30 do not emit skill events.',
    ],
  },
];

function headers(extra = {}) {
  return { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', ...extra };
}

function sendJson(res, status, body) {
  res.writeHead(status, headers({ 'content-type': 'application/json; charset=utf-8' }));
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolveBody(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(Object.assign(new Error('invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

/** Build the dashboard. `receiverInfo()` reports the OTLP receiver state. */
export function createDashboard({ env = process.env, root, demo = false, receiverInfo = () => ({ running: false }), now = () => Date.now() } = {}) {
  const home = snaglogHome(env);
  const token = randomBytes(24).toString('hex');
  let port;

  function data() {
    return { events: loadEvents(home), snags: loadSnags(home), evals: loadEvals(home), reports: loadLocalReports(home), now: now() };
  }

  const routes = [
    ['GET', /^\/api\/meta$/, () => [200, { demo, root: root ?? null, receiver: receiverInfo() }]],
    ['GET', /^\/api\/overview$/, () => [200, { rows: overview({ ...data(), skills: repoSkills(root) }) }]],
    ['GET', /^\/api\/skill\/([^/]+)$/, (m) => {
      const skill = decodeURIComponent(m[1]);
      if (!SKILL.test(skill)) return [400, { error: 'invalid skill name' }];
      return [200, skillDetail(skill, { ...data(), changes: skillChanges(root, skill) })];
    }],
    ['GET', /^\/api\/compare\/([^/]+)\/([0-9a-f]{7,40})$/, (m) => {
      const skill = decodeURIComponent(m[1]);
      if (!SKILL.test(skill)) return [400, { error: 'invalid skill name' }];
      const result = compare(skill, m[2], { ...data(), changes: skillChanges(root, skill) });
      return result ? [200, result] : [404, { error: 'change not found' }];
    }],
    ['GET', /^\/api\/reports$/, () => [200, { reports: listUnsent(home) }]],
    ['PUT', /^\/api\/reports\/([0-9a-f-]{36})$/, (m, body) => {
      const r = updateReport(home, m[1], body);
      return r.error ? [r.status, { error: r.error }] : [200, r];
    }],
    ['DELETE', /^\/api\/reports\/([0-9a-f-]{36})$/, (m) => {
      const r = deleteReport(home, m[1]);
      return r.error ? [r.status, { error: r.error }] : [200, r];
    }],
    ['POST', /^\/api\/reports\/([0-9a-f-]{36})\/send$/, (m, body) => {
      if (demo) return [403, { error: 'demo mode: sending is disabled' }];
      const r = sendReport(home, m[1], body.approval, env);
      return r.error ? [r.status, { error: r.error }] : [200, r];
    }],
    ['GET', /^\/api\/connections$/, () => {
      const state = loadConnections(home);
      const agents = AGENTS.map((a) => {
        const s = state[a.id] ?? {};
        const connected = Boolean(s.connection);
        return { agent: a.id, label: a.label, connected, lastEventAt: s.lastEventAt ?? null, file: s.connection?.file ?? null, tips: connected ? a.tips : [`Run \`snaglog connect ${a.id}\`.`] };
      });
      return [200, { receiver: receiverInfo(), agents, unsupported: Object.entries(UNSUPPORTED).map(([agent, reason]) => ({ agent, reason })) }];
    }],
  ];

  const server = createServer(async (req, res) => {
    try {
      const host = String(req.headers.host ?? '');
      const allowed = [`127.0.0.1:${port}`, `localhost:${port}`];
      if (!allowed.includes(host)) return sendJson(res, 403, { error: 'loopback only' });
      const url = new URL(req.url, `http://${host}`);

      if (url.pathname === '/' && req.method === 'GET') {
        const nonce = randomBytes(16).toString('base64');
        res.writeHead(200, headers({
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
        }));
        return res.end(PAGE.replaceAll('__NONCE__', nonce).replace('__CSRF__', token));
      }
      if (!url.pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'not found' });
      if (req.headers['x-snaglog-token'] !== token) return sendJson(res, 403, { error: 'missing or wrong dashboard token' });
      if (req.method !== 'GET') {
        const origin = req.headers.origin;
        if (origin !== undefined && !allowed.map((a) => `http://${a}`).includes(origin)) return sendJson(res, 403, { error: 'cross-origin request refused' });
        if (!String(req.headers['content-type'] ?? '').includes('application/json')) return sendJson(res, 415, { error: 'content-type must be application/json' });
      }
      for (const [method, pattern, handler] of routes) {
        const m = pattern.exec(url.pathname);
        if (!m) continue;
        if (method !== req.method) continue;
        // Always drain a request body, or Node drops the keep-alive socket.
        const body = method === 'GET' ? {} : await readBody(req);
        const [status, payload] = handler(m, body);
        return sendJson(res, status, payload);
      }
      return sendJson(res, 404, { error: 'not found' });
    } catch (error) {
      return sendJson(res, error.status ?? 500, { error: error.status ? error.message : 'internal error' });
    }
  });

  return {
    server,
    token,
    listen(p = DEFAULT_PORT) {
      return new Promise((resolveListen, reject) => {
        server.once('error', reject);
        server.listen(p, HOST, () => {
          port = server.address().port;
          resolveListen(server.address());
        });
      });
    },
    close: () => new Promise((r) => server.close(() => r())),
  };
}

const USAGE = `Usage: snaglog dashboard [options]

Starts the OTLP receiver on 127.0.0.1:${OTLP_PORT} and the dashboard on
http://127.0.0.1:${DEFAULT_PORT}. Both listen on this machine only.

Options:
  --path <dir>       Skills repo checkout, for SKILL.md history (default: current directory)
  --port <n>         Dashboard port (default ${DEFAULT_PORT})
  --otlp-port <n>    Receiver port (default ${OTLP_PORT})
  --no-receiver      Start only the dashboard
  --demo             Show generated sample data (nothing is read or sent)
  -h, --help         Show this help`;

export async function run(args, io, deps = {}) {
  let values;
  try {
    ({ values } = parseArgs({ args, options: { path: { type: 'string' }, port: { type: 'string' }, 'otlp-port': { type: 'string' }, 'no-receiver': { type: 'boolean' }, demo: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } }));
  } catch (error) {
    io.err(`snaglog dashboard: ${error.message}\n\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    io.out(USAGE);
    return 0;
  }
  const port = Number(values.port ?? DEFAULT_PORT);
  const otlpPort = Number(values['otlp-port'] ?? OTLP_PORT);
  if (!Number.isInteger(port) || !Number.isInteger(otlpPort) || port < 0 || otlpPort < 0) {
    io.err('snaglog dashboard: ports must be integers');
    return 2;
  }

  let env = deps.env ?? process.env;
  let root = resolve(values.path ?? process.cwd());
  let demoDir;
  if (values.demo) {
    const { createSample } = await import('./sample.mjs');
    demoDir = mkdtempSync(join(tmpdir(), 'snaglog-demo-'));
    root = join(demoDir, 'repo');
    env = { ...env, SNAGLOG_HOME: join(demoDir, 'home') };
    createSample({ home: env.SNAGLOG_HOME, root });
  }

  let receiver;
  const receiverState = { running: false, port: otlpPort, error: null };
  if (!values.demo && !values['no-receiver']) {
    receiver = createReceiver({ env });
    try {
      await receiver.listen(otlpPort);
      receiverState.running = true;
    } catch (error) {
      receiverState.error = error.message;
      receiver = undefined;
      io.err(`warning: receiver not started: ${error.message}`);
    }
  }

  const dashboard = createDashboard({
    env,
    root,
    demo: Boolean(values.demo),
    receiverInfo: () => ({ ...receiverState, rejected: receiver?.stats.rejected ?? 0, lastRejectReason: receiver?.stats.lastRejectReason ?? null }),
  });
  try {
    const address = await dashboard.listen(port);
    io.out(`snaglog dashboard: http://127.0.0.1:${address.port}${values.demo ? ' (demo data)' : ''}`);
    if (receiverState.running) io.out(`OTLP receiver: http://127.0.0.1:${otlpPort} (logs: /v1/logs)`);
    io.out('Press Ctrl+C to stop.');
  } catch (error) {
    io.err(`snaglog dashboard: cannot listen on port ${port}: ${error.message}`);
    await receiver?.close();
    if (demoDir) rmSync(demoDir, { recursive: true, force: true });
    return 1;
  }

  if (deps.keepAlive === false) return { dashboard, receiver, demoDir };
  await new Promise((resolveStop) => {
    const stop = () => resolveStop();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  await dashboard.close();
  await receiver?.close();
  if (demoDir) rmSync(demoDir, { recursive: true, force: true });
  return 0;
}
