// Static server for the perf harness: the power app's build with the SPA
// fallback Workers Static Assets gives it (any path without a file is
// index.html), so /demo/... runs the in-browser demo. No Worker is needed.
//   node perf/serve-static.mjs <dist/browser dir> <port>
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const root = path.resolve(process.argv[2] ?? '');
const port = Number(process.argv[3] ?? 8791);
if (!fs.existsSync(path.join(root, 'index.html'))) {
  console.error(`no index.html in ${root}: build the power app first`);
  process.exit(1);
}
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

http
  .createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/__perf_ready') {
      res.writeHead(200).end('ok');
      return;
    }
    let file = path.join(root, decodeURIComponent(url.pathname));
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      file = path.join(root, 'index.html');
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
  })
  .listen(port, () => console.log(`perf static server on http://localhost:${port} (${root})`));
