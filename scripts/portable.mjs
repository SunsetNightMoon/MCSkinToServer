// 便携包启动器：同进程拉起后端 (:3000) + 前端静态托管与反代 (:8080)
// 仅用 Node 内置模块，供 start.cmd / start.sh 调用。
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createReadStream, statSync, existsSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
// better-sqlite3 v11 只发布 ABI 127 (Node 22) / 131 (Node 23) 的 win32 预编译，
// 便携包不带运行时，必须在加载原生模块前给出人话提示，而不是 ERR_DLOPEN_FAILED。
if (!['127', '131'].includes(process.versions.modules)) {
  console.error(`[portable] 当前 Node 的模块 ABI 是 ${process.versions.modules}，便携包内的原生模块只支持 Node 22.x / 23.x。请换用 Node 22 LTS 后重试。`);
  process.exit(1);
}
const distDir = join(root, 'web', 'dist');
const backend = process.env.PORTABLE_BACKEND || 'http://127.0.0.1:3000';
const sitePort = Number(process.env.PORTABLE_PORT || 8080);
const PROXY_PREFIXES = ['/api', '/uploads', '/authserver', '/sessionserver'];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const child = spawn(process.execPath, ['--import', 'tsx', 'src/server/main.ts'], {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
});
child.on('exit', (code) => process.exit(code ?? 0));
process.on('SIGINT', () => { child.kill('SIGINT'); });
process.on('SIGTERM', () => { child.kill('SIGTERM'); });

async function proxy(req, res) {
  try {
    const upstream = await fetch(backend + req.url, {
      method: req.method,
      headers: req.headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : req,
      duplex: 'half',
      redirect: 'manual',
    });
    const outHeaders = {};
    upstream.headers.forEach((v, k) => {
      if (!['transfer-encoding', 'connection', 'content-encoding'].includes(k)) outHeaders[k] = v;
    });
    res.writeHead(upstream.status, outHeaders);
    if (upstream.body) {
      const { Readable } = await import('node:stream');
      Readable.fromWeb(upstream.body).pipe(res);
    } else {
      res.end();
    }
  } catch {
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('后端未就绪，请稍后重试');
  }
}

function serveStatic(req, res) {
  const path = decodeURIComponent(req.url.split('?')[0]);
  let file = normalize(join(distDir, path));
  if (!file.startsWith(distDir)) { res.writeHead(403).end(); return; }
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(distDir, 'index.html');
  // ALI 头：启动器里填裸站点根（http://localhost:8080）时靠它发现 API 地址，
  // 静态托管吃掉了后端的 /，这个头只能由站点入口自己补上
  res.writeHead(200, {
    'content-type': MIME[extname(file)] || 'application/octet-stream',
    'x-authlib-injector-api-location': '/api/yggdrasil',
  });
  createReadStream(file).pipe(res);
}

createServer((req, res) => {
  if (PROXY_PREFIXES.some((p) => req.url === p || req.url.startsWith(p + '/'))) proxy(req, res);
  else serveStatic(req, res);
}).listen(sitePort, () => {
  console.log(`[portable] 站点入口: http://localhost:${sitePort}  （API 反代 → ${backend}）`);
});
