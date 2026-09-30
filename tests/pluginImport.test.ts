import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { PluginImporter, PLUGIN_MARKER_DIR } from '../src/plugins/importer.js';
import { AppError } from '../src/errors.js';
import { goodRepo, IMPORT_ENTRY, manifestJson, markerJson, startFakeGitHub, type FakeRepo } from './support/fakeGitHub.js';

/**
 * GitHub 导入器（P6 第二批）验收。
 *
 * 这里不打真网络：假 GitHub 端点在 `tests/support/fakeGitHub.ts`，
 * 因为要验的正是导入器**自己**的判断 —— 标记核对、清单校验、体积上限、
 * tag→sha 固定、逐字节核对。（真实网络只做一次冒烟确认，见开发日志。）
 */

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mcsts-import-'));
  after(() => rm(dir, { recursive: true, force: true }).catch(() => undefined));
  return dir;
}

async function makeImporter(
  repo: FakeRepo,
  pluginDir: string,
): Promise<{ importer: PluginImporter; close: () => void }> {
  const gh = await startFakeGitHub(repo);
  return {
    importer: new PluginImporter({
      pluginDir,
      now: () => new Date('2026-09-30T00:00:00.000Z'),
      apiBase: gh.apiBase,
      rawBase: gh.rawBase,
    }),
    close: gh.close,
  };
}

async function expectRejected(fn: () => Promise<unknown>, pattern: RegExp): Promise<string> {
  try {
    await fn();
  } catch (err) {
    assert.ok(err instanceof AppError, `应该抛 AppError，实际是 ${String(err)}`);
    assert.equal(err.code, 'PLUGIN_IMPORT_REJECTED');
    assert.match(err.message, pattern);
    return err.message;
  }
  throw new assert.AssertionError({ message: `期望被拒（${pattern.source}），却成功了` });
}

test('导入：预览给出清单、manifest 摘要与标记核对结果', async () => {
  const dir = await tempDir();
  const repo = goodRepo();
  const { importer, close } = await makeImporter(repo, dir);
  try {
    const preview = await importer.preview({ repo: 'acme/demo-plugin', tag: 'v0.1.0' });
    assert.equal(preview.manifest.id, 'demo_import');
    assert.equal(preview.sha, 'a'.repeat(40));
    assert.equal(preview.marker.ok, true);
    // 标记文件本身不进插件目录，README/入口/manifest 进
    assert.deepEqual(
      preview.files.map((item) => item.local).sort(),
      ['README.md', 'index.ts', 'mcsts.plugin.json'],
    );
    assert.ok(preview.totalBytes > 0);
  } finally {
    close();
  }
});

test('导入：安装落盘 + 来源记录，且目录里没有标记文件', async () => {
  const dir = await tempDir();
  const repo = goodRepo();
  const { importer, close } = await makeImporter(repo, dir);
  try {
    const preview = await importer.preview({ repo: 'acme/demo-plugin', tag: 'v0.1.0' });
    const result = await importer.install(
      { repo: 'acme/demo-plugin', tag: 'v0.1.0' },
      preview.sha,
      'user-1',
      false,
    );
    assert.equal(result.installedTo, join(dir, 'demo_import'));
    const listing = await readdir(join(dir, 'demo_import'));
    assert.deepEqual(listing.sort(), ['.mcsts-import.json', 'README.md', 'index.ts', 'mcsts.plugin.json']);

    const provenance = JSON.parse(
      await readFile(join(dir, 'demo_import', '.mcsts-import.json'), 'utf8'),
    ) as Record<string, unknown>;
    assert.equal(provenance['repo'], 'acme/demo-plugin');
    assert.equal(provenance['tag'], 'v0.1.0');
    assert.equal(provenance['sha'], preview.sha);
    assert.equal(provenance['importedBy'], 'user-1');
    // 暂存目录必须收干净
    assert.deepEqual((await readdir(dir)).filter((name) => name.startsWith('.import-')), []);
  } finally {
    close();
  }
});

test('导入：没有识别代号标记就不给装', async () => {
  const dir = await tempDir();
  const repo = goodRepo();
  delete repo.files[`${PLUGIN_MARKER_DIR}/demo_import.json`];
  const { importer, close } = await makeImporter(repo, dir);
  try {
    const preview = await importer.preview({ repo: 'acme/demo-plugin', tag: 'v0.1.0' });
    assert.equal(preview.marker.ok, false);
    if (preview.marker.ok === false) assert.match(preview.marker.reason, /无法证明这个仓库认领/);
    await expectRejected(
      () => importer.install({ repo: 'acme/demo-plugin', tag: 'v0.1.0' }, preview.sha, 'user-1', false),
      /识别代号标记未通过/,
    );
    assert.equal((await readdir(dir)).length, 0, '被拒之后磁盘上不该留任何东西');
  } finally {
    close();
  }
});

test('导入：标记内容与 manifest 对不上就拒', async () => {
  const dir = await tempDir();
  const repo = goodRepo();
  repo.files[`${PLUGIN_MARKER_DIR}/demo_import.json`] = markerJson('demo_import', 'someone-else/other', {
    author: '冒充者',
  });
  const { importer, close } = await makeImporter(repo, dir);
  try {
    const preview = await importer.preview({ repo: 'acme/demo-plugin', tag: 'v0.1.0' });
    assert.equal(preview.marker.ok, false);
    if (preview.marker.ok === false) {
      assert.match(preview.marker.reason, /repository/);
      assert.match(preview.marker.reason, /author/);
    }
  } finally {
    close();
  }
});

test('导入：二进制文件直接拒，并且一个字节都不落盘', async () => {
  const dir = await tempDir();
  const repo = goodRepo();
  repo.files['payload.exe'] = 'MZ...';
  const { importer, close } = await makeImporter(repo, dir);
  try {
    await expectRejected(
      () => importer.preview({ repo: 'acme/demo-plugin', tag: 'v0.1.0' }),
      /不允许的内容[\s\S]*payload\.exe/,
    );
    assert.equal((await readdir(dir)).length, 0);
  } finally {
    close();
  }
});

test('导入：manifest 不合法时把校验问题原样带出来', async () => {
  const dir = await tempDir();
  const repo = goodRepo();
  repo.files['mcsts.plugin.json'] = JSON.stringify({ id: 'BAD ID', name: 'x', version: '1', apiVersion: 99, main: 'index.ts' });
  const { importer, close } = await makeImporter(repo, dir);
  try {
    await expectRejected(
      () => importer.preview({ repo: 'acme/demo-plugin', tag: 'v0.1.0' }),
      /id: .*apiVersion: .*插件要求 API v99/,
    );
  } finally {
    close();
  }
});

test('导入：只认 tag，且预览与安装之间 tag 换了就中止', async () => {
  const dir = await tempDir();
  const repo = goodRepo();
  const { importer, close } = await makeImporter(repo, dir);
  try {
    const preview = await importer.preview({ repo: 'acme/demo-plugin', tag: 'v0.1.0' });
    // 作者把 tag 重打到另一个 commit
    repo.tags['v0.1.0'] = 'b'.repeat(40);
    await expectRejected(
      () => importer.install({ repo: 'acme/demo-plugin', tag: 'v0.1.0' }, preview.sha, 'user-1', false),
      /与预览时不一致/,
    );
    assert.equal((await readdir(dir)).length, 0);
  } finally {
    close();
  }
});

test('导入：未知 tag 与非法仓库名都拒，不给模糊错误', async () => {
  const dir = await tempDir();
  const { importer, close } = await makeImporter(goodRepo(), dir);
  try {
    await expectRejected(() => importer.preview({ repo: 'acme/demo-plugin', tag: 'nope' }), /GitHub 上没有这个 tag：acme\/demo-plugin@nope/);
    await expectRejected(() => importer.preview({ repo: 'acme/demo-plugin/../evil', tag: 'v0.1.0' }), /owner\/name/);
    await expectRejected(
      () => importer.preview({ repo: 'acme/demo-plugin', tag: 'v0.1.0', dir: '../outside' }),
      /子目录路径不合法/,
    );
  } finally {
    close();
  }
});

test('导入：monorepo 子目录只取该目录，落盘路径不带前缀', async () => {
  const dir = await tempDir();
  const repo: FakeRepo = {
    files: {
      'README.md': '# monorepo\n',
      'packages/skin/mcsts.plugin.json': manifestJson('skin_thing'),
      'packages/skin/index.ts': IMPORT_ENTRY,
      'packages/other/index.ts': 'export default 1\n',
      [`${PLUGIN_MARKER_DIR}/skin_thing.json`]: markerJson('skin_thing', 'acme/monorepo'),
    },
    tags: { 'skin-v1': 'c'.repeat(40) },
    hits: [],
  };
  const { importer, close } = await makeImporter(repo, dir);
  try {
    const preview = await importer.preview({ repo: 'acme/monorepo', tag: 'skin-v1', dir: 'packages/skin' });
    assert.deepEqual(
      preview.files.map((item) => item.local).sort(),
      ['index.ts', 'mcsts.plugin.json'],
    );
    await importer.install({ repo: 'acme/monorepo', tag: 'skin-v1', dir: 'packages/skin' }, preview.sha, 'u', false);
    assert.deepEqual((await readdir(join(dir, 'skin_thing'))).sort(), ['.mcsts-import.json', 'index.ts', 'mcsts.plugin.json']);
  } finally {
    close();
  }
});

test('导入：清单被截断的超大仓库直接拒', async () => {
  const dir = await tempDir();
  const repo = goodRepo();
  repo.truncated = true;
  const { importer, close } = await makeImporter(repo, dir);
  try {
    await expectRejected(() => importer.preview({ repo: 'acme/demo-plugin', tag: 'v0.1.0' }), /被 GitHub 截断/);
  } finally {
    close();
  }
});

test('导入：已装过同名插件时必须显式确认替换，替换后不留备份', async () => {
  const dir = await tempDir();
  const repo = goodRepo();
  const { importer, close } = await makeImporter(repo, dir);
  try {
    const preview = await importer.preview({ repo: 'acme/demo-plugin', tag: 'v0.1.0' });
    await importer.install({ repo: 'acme/demo-plugin', tag: 'v0.1.0' }, preview.sha, 'u', false);
    await expectRejected(
      () => importer.install({ repo: 'acme/demo-plugin', tag: 'v0.1.0' }, preview.sha, 'u', false),
      /已经装在目录里/,
    );
    // 换一版内容再带 replace 安装
    repo.files['index.ts'] = `${IMPORT_ENTRY}// v2\n`;
    repo.tags['v0.2.0'] = 'd'.repeat(40);
    const second = await importer.preview({ repo: 'acme/demo-plugin', tag: 'v0.2.0' });
    await importer.install({ repo: 'acme/demo-plugin', tag: 'v0.2.0' }, second.sha, 'u', true);
    const content = await readFile(join(dir, 'demo_import', 'index.ts'), 'utf8');
    assert.match(content, /\/\/ v2/);
    assert.deepEqual(
      (await readdir(dir)).filter((name) => name.includes('.replacing-') || name.startsWith('.import-')),
      [],
      '替换完不该留下备份或暂存目录',
    );
  } finally {
    close();
  }
});

test('导入：上游不通与仓库不合规是两回事（502 vs 400）', async () => {
  const dir = await tempDir();
  const make = (impl: typeof fetch) =>
    new PluginImporter({
      pluginDir: dir,
      now: () => new Date(),
      apiBase: 'http://github.invalid',
      rawBase: 'http://github.invalid',
      fetchImpl: impl,
    });

  const codeOf = async (fn: () => Promise<unknown>): Promise<string> => {
    try {
      await fn();
    } catch (err) {
      assert.ok(err instanceof AppError, `应该抛 AppError，实际是 ${String(err)}`);
      return err.code;
    }
    throw new assert.AssertionError({ message: '期望抛错却没有抛错' });
  };

  // 连不上：以前这里会冒成 500「内部错误」，面板看不出是 GitHub 挂了还是自己填错仓库。
  // Node 的 fetch 把真因藏在 cause 里，文案必须带出来，否则只剩「fetch failed」四个字。
  const network = await (async () => {
    try {
      const err = new TypeError('fetch failed') as TypeError & { cause?: unknown };
      err.cause = Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' });
      await make(async () => {
        throw err;
      }).preview({ repo: 'a/b', tag: 'v1' });
    } catch (err) {
      return err instanceof AppError ? err : undefined;
    }
    return undefined;
  })();
  assert.equal(network?.code, 'PLUGIN_IMPORT_UNREACHABLE');
  assert.match(String(network?.message), /Connect Timeout Error/);
  assert.match(String(network?.message), /UND_ERR_CONNECT_TIMEOUT/);
  // 限流 / 私有仓库没给 token：同样是上游问题，可重试
  assert.equal(
    await codeOf(() => make(async () => new Response('{}', { status: 403 })).preview({ repo: 'a/b', tag: 'v1' })),
    'PLUGIN_IMPORT_UNREACHABLE',
  );
  // tag 不存在是请求内容的问题 → 400 拒，且文案要指到 tag 上
  assert.equal(
    await codeOf(() => make(async () => new Response('{}', { status: 404 })).preview({ repo: 'a/b', tag: 'v1' })),
    'PLUGIN_IMPORT_REJECTED',
  );
});

test('导入：下载内容与仓库清单不符就中止，不留半个插件目录', async () => {
  const dir = await tempDir();
  const repo = goodRepo();
  // 清单按 `files` 报 sha，raw 却给另一份内容 —— 中间被改包 / CDN 不一致
  repo.overrideRaw = { 'index.ts': 'export default async function setup(){ throw new Error("被换包") }\n' };
  const { importer, close } = await makeImporter(repo, dir);
  try {
    const preview = await importer.preview({ repo: 'acme/demo-plugin', tag: 'v0.1.0' });
    await expectRejected(
      () => importer.install({ repo: 'acme/demo-plugin', tag: 'v0.1.0' }, preview.sha, 'u', false),
      /内容与仓库清单不符/,
    );
    assert.equal((await readdir(dir)).length, 0, '中止后不该留下半个插件目录');
  } finally {
    close();
  }
});
