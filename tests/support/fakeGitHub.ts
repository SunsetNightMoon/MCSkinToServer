import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { PLUGIN_MARKER_DIR } from '../../src/plugins/importer.js';

/**
 * 假 GitHub 端点：把「仓库」演成内存里的路径 → 内容映射。
 *
 * 导入器要验的判断全在它自己这边（标记核对、清单上限、逐字节核对、tag→sha 固定），
 * 而响应形状是 GitHub 公开且稳定的，所以用假端点比打真网络更可重复 ——
 * 真网络只用于一次冒烟确认（见 docs/development-log.md 的 P6 第二批）。
 */

export interface FakeRepo {
  /** 仓库内路径 → 内容 */
  files: Record<string, string>;
  /** tag → commit sha */
  tags: Record<string, string>;
  /** 置为 true 时 tree 响应带 truncated */
  truncated?: boolean;
  /**
   * raw 端点单独返回的内容（tree 仍按 `files` 报 sha）。
   * 用来模拟「清单说一份、下载给另一份」：CDN 不一致或被改包。
   */
  overrideRaw?: Record<string, string>;
  /** 请求路径计数，用来看清导入器到底打了哪几个端点 */
  hits: string[];
}

export function blobSha(content: string): string {
  const buf = Buffer.from(content, 'utf8');
  return createHash('sha1').update(`blob ${buf.length}\u0000`, 'utf8').update(buf).digest('hex');
}

export function startFakeGitHub(repo: FakeRepo): Promise<{ apiBase: string; rawBase: string; close: () => void }> {
  return new Promise((resolveStart) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const path = url.pathname;
      repo.hits.push(path);
      const send = (status: number, body: string, type = 'application/json') => {
        res.writeHead(status, { 'content-type': type });
        res.end(body);
      };

      // /repos/{owner}/{name}/commits/{tag}
      const commit = /^\/repos\/([^/]+)\/([^/]+)\/commits\/(.+)$/.exec(path);
      if (commit) {
        const sha = repo.tags[decodeURIComponent(commit[3]!)];
        if (!sha) return send(404, JSON.stringify({ message: 'No commit found' }));
        return send(200, JSON.stringify({ sha }));
      }

      // /repos/{owner}/{name}/git/trees/{sha}
      const trees = /^\/repos\/([^/]+)\/([^/]+)\/git\/trees\/([a-f0-9]+)$/.exec(path);
      if (trees) {
        const tree = Object.entries(repo.files).map(([p, content]) => ({
          path: p,
          mode: '100644',
          type: 'blob',
          sha: blobSha(content),
          size: Buffer.byteLength(content, 'utf8'),
        }));
        return send(200, JSON.stringify({ sha: trees[3], tree, ...(repo.truncated ? { truncated: true } : {}) }));
      }

      // raw: /{owner}/{name}/{sha}/{path...}
      const raw = /^\/([^/]+)\/([^/]+)\/[a-f0-9]+\/(.+)$/.exec(path);
      if (raw) {
        const key = decodeURIComponent(raw[3]!);
        if (!(key in repo.files)) return send(404, 'Not Found', 'text/plain');
        return send(200, repo.overrideRaw?.[key] ?? repo.files[key]!, 'text/plain');
      }

      send(404, JSON.stringify({ message: 'Not Found' }));
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolveStart({
        apiBase: `http://127.0.0.1:${port}`,
        rawBase: `http://127.0.0.1:${port}`,
        close: () => server.close(),
      });
    });
  });
}

export function manifestJson(id: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id,
    name: `夹具：${id}`,
    version: '0.1.0',
    apiVersion: 1,
    main: 'index.ts',
    author: 'MCSTS tests',
    description: '导入用例用的最小插件',
    endpoints: [{ kind: 'router', method: 'GET', path: '/ping', auth: 'public', note: '回显' }],
    ...extra,
  });
}

export function markerJson(id: string, repo: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id,
    name: `夹具：${id}`,
    author: 'MCSTS tests',
    repository: repo,
    ...overrides,
  });
}

/** 入口：注册 manifest 里声明过的 `/ping`，并导出一个 dispose */
export const IMPORT_ENTRY = `import type { PluginSetup } from './plugin-api.js';

const setup: PluginSetup = async (ctx) => {
  ctx.route({ method: 'GET', path: '/ping', auth: 'public' }, async (_req, res) => {
    res.json({ ok: true, plugin: ctx.pluginId });
  });
  return () => undefined;
};

export default setup;
`;

/** 一个「合规」的仓库：manifest + 入口 + 识别代号标记 */
export function goodRepo(id = 'demo_import', repo = 'acme/demo-plugin'): FakeRepo {
  return {
    files: {
      'mcsts.plugin.json': manifestJson(id),
      'index.ts': IMPORT_ENTRY,
      'README.md': '# demo\n',
      [`${PLUGIN_MARKER_DIR}/${id}.json`]: markerJson(id, repo),
    },
    tags: { 'v0.1.0': 'a'.repeat(40) },
    hits: [],
  };
}
