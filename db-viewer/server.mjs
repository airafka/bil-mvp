import http from 'node:http';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { CHANNEL, connection, overview, tablePage, InputError, pool } from './database.mjs';

const port = Number(process.env.PORT || 3002);
const clients = new Set();
let listener;
let connected = false;
let shuttingDown = false;
let retry;
const encode = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
function broadcast(event, data) {
  for (const response of clients) if (!response.write(encode(event, data))) response.destroy();
}
async function listen() {
  const current = new pg.Client(connection);
  listener = current;
  let lost = false;
  const disconnected = () => {
    if (lost || shuttingDown) return;
    lost = true;
    connected = false;
    broadcast('status', { connected: false });
    current.end().catch(() => {});
    retry = setTimeout(listen, 2000);
  };
  current.on('error', disconnected);
  current.on('end', disconnected);
  current.on('notification', message => {
    try { broadcast('change', { ...JSON.parse(message.payload), at: new Date().toISOString() }); }
    catch { /* Ignore notifications with an unexpected format. */ }
  });
  try {
    await current.connect();
    await current.query(`LISTEN ${CHANNEL}`);
    connected = true;
    broadcast('status', { connected: true });
  } catch { disconnected(); }
}
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);
const server = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
  const host = req.headers.host || '';
  if (!new RegExp(`^(localhost|127\\.0\\.0\\.1|\\[::1\\]):${port}$`).test(host) ||
      (req.headers.origin && req.headers.origin !== `http://${host}`) ||
      req.headers['sec-fetch-site'] === 'cross-site') {
    res.writeHead(403).end(); return;
  }
  if (req.method !== 'GET') { res.writeHead(405, { Allow: 'GET' }).end(); return; }
  const url = new URL(req.url, `http://${host}`);
  try {
    if (url.pathname === '/api/events') {
      if (clients.size >= 20) { res.writeHead(503).end(); return; }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 1500\n' + encode('status', { connected }));
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (url.pathname === '/api/health') {
      res.writeHead(connected ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ connected, database: connection.database })); return;
    }
    if (url.pathname === '/api/tables' || url.pathname === '/api/table') {
      const result = url.pathname === '/api/tables' ? await overview() : await tablePage(url.searchParams);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result)); return;
    }
    if (assets.has(url.pathname)) {
      const [file, type] = assets.get(url.pathname);
      const body = await readFile(new URL(`./public/${file}`, import.meta.url));
      res.writeHead(200, { 'Content-Type': type }); res.end(body); return;
    }
    res.writeHead(404).end();
  } catch (error) {
    res.writeHead(error instanceof InputError ? 400 : 503, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: error instanceof InputError ? error.message : 'Не удалось прочитать БД. Проверьте подключение и повторите.' }));
  }
});
// Heartbeats keep SSE alive; they do not query the database or refresh the UI.
const heartbeat = setInterval(() => { for (const res of clients) res.write(': heartbeat\n\n'); }, 15000);
server.listen(port, process.env.HOST || '127.0.0.1', () => console.log(`Database viewer: http://localhost:${port}`));
listen();
async function shutdown() {
  shuttingDown = true;
  clearTimeout(retry); clearInterval(heartbeat);
  for (const res of clients) res.end();
  server.close();
  await listener?.end().catch(() => {});
  await pool.end();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
