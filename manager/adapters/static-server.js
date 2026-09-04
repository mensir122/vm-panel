#!/usr/bin/env node
// manager/adapters/static-server.js — static file server minimal (node:http bawaan).
// CLI: node static-server.js --root DIR --port N --host 127.0.0.1
// Proteksi: resolve + prefix check + realpath; segmen '..' ditolak.

import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

function parseArgs(argv) {
  const args = { root: process.cwd(), port: 0, host: '127.0.0.1' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') args.root = argv[++i];
    else if (a === '--port') args.port = Number(argv[++i]);
    else if (a === '--host') args.host = argv[++i];
  }
  return args;
}

/** True jika candidateReal === rootReal atau berada di bawahnya. */
function inside(rootReal, candidateReal) {
  if (candidateReal === rootReal) return true;
  const withSep = rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep;
  return candidateReal.startsWith(withSep);
}

/** Resolusi path URL -> file absolut di dalam root; return null jika ditolak/tak valid. */
function resolveSafe(rootReal, urlPathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPathname);
  } catch {
    return null; // %encoding rusak
  }
  if (decoded.includes('\0')) return null;
  // Tolak segmen '..' eksplisit (defense-in-depth sebelum resolve).
  for (const seg of decoded.split(/[\\/]+/)) {
    if (seg === '..') return null;
  }
  const abs = path.resolve(rootReal, '.' + path.posix.normalize(decoded.replaceAll('\\', '/')));
  // Realpath komponen terdalam yang ada (menutup symlink escape).
  let real = abs;
  for (;;) {
    try {
      real = fs.realpathSync(abs);
      break;
    } catch {
      const parent = path.dirname(real);
      if (parent === real) return null;
      real = parent;
    }
  }
  if (!inside(rootReal, real)) return null;
  return real;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

function serve(req, res, rootReal) {
  let pathname;
  try {
    pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  } catch {
    return send(res, 400, 'bad request\n');
  }
  if (pathname.endsWith('/')) pathname += 'index.html';

  const file = resolveSafe(rootReal, pathname);
  if (!file) return send(res, 404, 'not found\n');

  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return send(res, 404, 'not found\n');
  }
  if (st.isDirectory()) {
    return send(res, 404, 'not found\n'); // tanpa listing direktori
  }
  const type = CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
  try {
    const data = fs.readFileSync(file);
    send(res, 200, data, { 'content-type': type, 'content-length': st.size });
  } catch {
    send(res, 404, 'not found\n');
  }
}

const args = parseArgs(process.argv.slice(2));
const rootReal = fs.realpathSync(args.root);
const server = http.createServer((req, res) => serve(req, res, rootReal));
server.listen(args.port, args.host, () => {
  const { address, port } = server.address();
  process.stdout.write(`static-server listening on http://${address}:${port} root=${rootReal}\n`);
});
