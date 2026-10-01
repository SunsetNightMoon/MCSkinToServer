import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import {
  PluginImporter,
  PLUGIN_MARKER_DIR,
  newestSemverTag,
  parseRepoInput,
} from '../src/plugins/importer.js';
import { AppError } from '../src/errors.js';
import { goodRepo, IMPORT_ENTRY, manifestJson, markerJson, startFakeGitHub, type FakeRepo } from './support/fakeGitHub.js';

/**
 * GitHub 导入器（P6 第二批起）验收。
 *
 * 这里不打真网络：假 GitHub 端点在 `tests/support/fakeGitHub.ts`，
 * 因为要验的正是导入器**自己**的判断 —— 标记核对、清单校验、体积上限、
 * tag→sha 固定、逐字节核对。（真实网络只做一次冒烟确认，见开发日志。）
 *
 * 第三批把「手输 tag」换成「贴地址 + 自动识别版本」，所以这里额外钉两件事：
 * 版本怎么挑（语义化比较，不信列表顺序），以及地址有哪些形态能认。
 */

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mcsts-import-'));
  after(() => rm(dir, { recursive: true, force: true }).catch(() => undefined));
  return dir;
}

async function makeImporter(
  repo: FakeRepo,
  pluginDir: string,
  opts: { mirror?: boolean } = {},
): Promise<{ importer: PluginImporter; close: () => void }> {
  const gh = await startFakeGitHub(repo, { wrap: opts.mirror === true });
  return {
    importer: new PluginImporter({
      pluginDir,
      now: () => new Date('2026-09-30T00:00:00.000Z'),
      // 镜像形态：只给 mirror，让导入器自己把完整请求 URL 拼上去（走的是真实代码路径）
      ...(opts.mirror ? { mirror: gh.apiBase } : { apiBase: gh.apiBase, rawBase: gh.rawBase }),
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

/** parseRepoInput / newestSemverTag 这些纯函数是同步抛错的，单独一个断言器 */
function expectRejectSync(fn: () => unknown, pattern: RegExp): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof AppError, `应该抛 AppError，实际是 ${String(err)}`);
    assert.equal(err.code, 'PLUGIN_IMPORT_REJECTED');
    assert.match(err.message, pattern);
    return true;
  });
}

// ------------------------------------------------------ 地址形态（只决定装哪个仓库）

test('地址识别：clone 地址、网页地址、SSH、owner/name 都归一成 owner/name', () => {
  const forms = [
    'acme/demo-plugin',
    'acme/demo-plugin/',
    'https://github.com/acme/demo-plugin',
    'https://github.com/acme/demo-plugin.git',
    'https://github.com/acme/demo-plugin/',
    'https://www.github.com/acme/demo-plugin',
    'git@github.com:acme/demo-plugin.git',
    'ssh://git@github.com/acme/demo-plugin.git',
    // 网页上常用的深层地址：尾段被忽略，仓库还是那个仓库（版本仍按 tag 自动识别）
    'https://github.com/acme/demo-plugin/releases/tag/v1.2.3',
    'https://github.com/acme/demo-plugin/tree/main/src',
    // 「镜像前缀 + 完整 GitHub 地址」：gh-proxy 一类粘进剪贴板的原样
    'https://gh-proxy.com/https://github.com/acme/demo-plugin.git',
  ];
  for (const form of forms) {
    assert.equal(parseRepoInput(form), 'acme/demo-plugin', `这种写法应该认得：${form}`);
  }
});

test('地址识别：非 GitHub 的域名点名拒绝，不去 GitHub 找一个同名仓库', () => {
  // 认错仓库比报错严重：Gitee/GitLab 上的同名仓库会被悄悄换成 GitHub 的那一份
  expectRejectSync(() => parseRepoInput('https://gitee.com/acme/demo-plugin'), /gitee\.com/);
  expectRejectSync(() => parseRepoInput('https://gitlab.com/acme/demo-plugin'), /gitlab\.com/);
  // 内网地址同样进不来（导入器不能变成任意 URL 探针）
  expectRejectSync(
    () => parseRepoInput('http://169.254.169.254/latest/meta-data'),
    /169\.254\.169\.254/,
  );
  expectRejectSync(() => parseRepoInput(''), /请填写插件仓库地址/);
  expectRejectSync(() => parseRepoInput('acme/demo/../evil'), /认不出这个仓库地址/);
});

// ------------------------------------------------------------- 版本自动识别（语义化）

test('版本识别：按语义化比较挑最新，不信列表顺序，也忽略噪声 tag', () => {
  const tags = [
    { name: 'v0.1.0', sha: 'a'.repeat(40) },
    { name: 'latest', sha: 'b'.repeat(40) },
    { name: 'v1.2.0', sha: 'c'.repeat(40) },
    { name: 'backup-2024', sha: 'd'.repeat(40) },
    { name: 'v1.10.0', sha: 'e'.repeat(40) },
  ];
  // 字典序会把 v1.10.0 排在 v1.2.0 前面 —— 这正是「取最后一个」会踩的坑
  assert.equal(newestSemverTag(tags)?.name, 'v1.10.0');
  assert.equal(newestSemverTag([...tags].reverse())?.name, 'v1.10.0', '列表顺序不得影响结论');

  // 正式版 > 预发布版（semver 的规矩）
  assert.equal(
    newestSemverTag([{ name: 'v2.0.0-rc.1' }, { name: 'v2.0.0' }])?.name,
    'v2.0.0',
  );
  assert.equal(
    newestSemverTag([{ name: 'v2.0.0-rc.2' }, { name: 'v2.0.0-rc.1' }])?.name,
    'v2.0.0-rc.2',
  );
  // 没有 v 前缀、没有补零的写法都认
  assert.equal(newestSemverTag([{ name: '1.4.0' }, { name: 'v1.3.9' }])?.name, '1.4.0');
  assert.equal(newestSemverTag([{ name: 'v1.2' }, { name: 'nightly' }]), null, '两段号不算发布版本');
});

test('版本识别：仓库一个 tag 都没有就拒，并说明该打 tag', async () => {
  const dir = await tempDir();
  const repo = goodRepo();
  repo.tags = {};
  const { importer, close } = await makeImporter(repo, dir);
  try {
    const message = await expectRejected(
      () => importer.preview({ repoInput: 'acme/demo-plugin' }),
      /一个 tag 都没有/,
    );
    assert.match(message, /语义化版本 tag/);
    assert.equal((await readdir(dir)).length, 0, '被拒之后磁盘上不该留任何东西');
  } finally {
    close();
  }
});

test('版本识别：有 tag 但没有可识别的版本号时，把扫到的那些列出来', async () => {
  const dir = await tempDir();
  const repo = goodRepo();
  repo.tags = { 'latest': 'a'.repeat(40), 'snapshot-0930': 'b'.repeat(40) };
  const { importer, close } = await makeImporter(repo, dir);
  try {
    const message = await expectRejected(
      () => importer.preview({ repoInput: 'acme/demo-plugin' }),
      /没有可识别的语义化版本 tag/,
    );
    // 文案要能让作者立刻知道改什么：把扫到的 tag 名列出来
    assert.match(message, /latest/);
    assert.match(message, /snapshot-0930/);
  } finally {
    close();
  }
});

test('导入：自动选中最新的语义化版本 tag，并按它解析的 commit 取文件', async () => {
  const dir = await tempDir();
  const repo = goodRepo();
  repo.tags = {
    'v0.1.0': 'a'.repeat(40),
    'v1.2.0': 'c'.repeat(40),
    'v1.10.0': 'e'.repeat(40),
    'latest': 'f'.repeat(40),
  };
  const { importer, close } = await makeImporter(repo, dir);
  try {
    const preview = await importer.preview({ repoInput: 'acme/demo-plugin' });
    assert.equal(preview.tag, 'v1.10.0');
    assert.equal(preview.sha, 'e'.repeat(40));
    assert.equal(preview.tagsScanned, 4, '扫过的 tag 数要如实报给面板');
    // 夹具的 manifest 写的是 0.1.0，tag 是 v1.10.0 —— 不一致只提示、不拦
    assert.equal(preview.versionMatchesManifest, false);
    // 地址栏粘完整 clone 地址与粘 owner/name 得到的是同一份东西
    const byUrl = await importer.preview({ repoInput: 'https://github.com/acme/demo-plugin.git' });
    assert.equal(byUrl.sha, preview.sha);
  } finally {
    close();
  }
});

test('导入：tag 与 manifest 版本一致时给出肯定的比对结果', async () => {
  const dir = await tempDir();
  const repo = goodRepo();
  repo.files['mcsts.plugin.json'] = manifestJson('demo_import', { version: '1.10.0' });
  repo.tags = { 'v1.10.0': 'e'.repeat(40) };
  const { importer, close } = await makeImporter(repo, dir);
  try {
    const preview = await importer.preview({ repoInput: 'acme/demo-plugin' });
    assert.equal(preview.versionMatchesManifest, true);
  } finally {
    close();
  }
});

test('导入：镜像前缀生效时，每个请求都是「前缀 + 完整 GitHub 地址」的形态', async () => {
  const dir = await tempDir();
  const repo = goodRepo();
  // 假 GitHub 在 wrap 模式下只接被包住的请求，没包住的一律 404 ——
  // 「配了镜像但代码其实没走镜像」在这种服务器上一定会考砸
  const { importer, close } = await makeImporter(repo, dir, { mirror: true });
  try {
    const preview = await importer.preview({ repoInput: 'acme/demo-plugin' });
    assert.equal(preview.tag, 'v0.1.0');
    assert.ok(repo.hits.length >= 3, `镜像形态下应该打过清单与文件，实得 ${repo.hits.length} 次`);
    // 走到这里就已经证明「请求确实被包住了」：这台服务器上没被包住的地址一律 404。
    // 再核一遍端点齐全：取 tag 列表、把 tag 解析成 commit、取清单、取文件。
    assert.ok(repo.hits.some((path) => path.endsWith('/tags')), '应通过镜像取 tag 列表');
    assert.ok(repo.hits.some((path) => path.includes('/commits/')), '应通过镜像把 tag 解析成 commit');
    assert.ok(repo.hits.some((path) => path.includes('/git/trees/')), '应通过镜像取文件清单');
    assert.ok(
      repo.hits.some((path) => /^\/acme\/demo-plugin\/[a-f0-9]+\//.test(path)),
      '应通过镜像取到文件内容',
    );
  } finally {
    close();
  }
});

// ------------------------------------------------------------------- 原有硬闸仍在

test('导入：预览给出清单、manifest 摘要与标记核对结果', async () => {
  const dir = await tempDir();
  const repo = goodRepo();
  const { importer, close } = await makeImporter(repo, dir);
  try {
    const preview = await importer.preview({ repoInput: 'acme/demo-plugin' });
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
    const preview = await importer.preview({ repoInput: 'acme/demo-plugin' });
    const result = await importer.install(
      { repoInput: 'acme/demo-plugin' },
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
    // 来源记录里写的是自动识别出的那个 tag，将来出问题能一路回到同一份 commit
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
    const preview = await importer.preview({ repoInput: 'acme/demo-plugin' });
    assert.equal(preview.marker.ok, false);
    if (preview.marker.ok === false) assert.match(preview.marker.reason, /无法证明这个仓库认领/);
    await expectRejected(
      () => importer.install({ repoInput: 'acme/demo-plugin' }, preview.sha, 'user-1', false),
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
    const preview = await importer.preview({ repoInput: 'acme/demo-plugin' });
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
      () => importer.preview({ repoInput: 'acme/demo-plugin' }),
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
      () => importer.preview({ repoInput: 'acme/demo-plugin' }),
      /id: .*apiVersion: .*插件要求 API v99/,
    );
  } finally {
    close();
  }
});

test('导入：预览与安装之间版本换了就中止（新打 tag 或 tag 被重打）', async () => {
  const dir = await tempDir();
  const repo = goodRepo();
  const { importer, close } = await makeImporter(repo, dir);
  try {
    const preview = await importer.preview({ repoInput: 'acme/demo-plugin' });
    // 情形一：作者把 tag 重打到另一个 commit
    repo.tags['v0.1.0'] = 'b'.repeat(40);
    await expectRejected(
      () => importer.install({ repoInput: 'acme/demo-plugin' }, preview.sha, 'user-1', false),
      /发布版本在预览之后变了/,
    );
    // 情形二：作者刚发了新 tag —— 自动识别会跟着走，所以更要停下来让人复核
    repo.tags = { 'v0.1.0': 'b'.repeat(40), 'v0.2.0': 'c'.repeat(40) };
    await expectRejected(
      () => importer.install({ repoInput: 'acme/demo-plugin' }, preview.sha, 'user-1', false),
      /请重新预览后再安装/,
    );
    assert.equal((await readdir(dir)).length, 0);
  } finally {
    close();
  }
});

test('导入：非法子目录路径仍拒', async () => {
  const dir = await tempDir();
  const { importer, close } = await makeImporter(goodRepo(), dir);
  try {
    await expectRejected(
      () => importer.preview({ repoInput: 'acme/demo-plugin', dir: '../outside' }),
      /子目录路径不合法/,
    );
  } finally {
    close();
  }
});

test('导入：manifest 只在子目录里有一份时，dir 留空自动识别它', async () => {
  const dir = await tempDir();
  const repo: FakeRepo = {
    files: {
      'README.md': '# monorepo\n',
      'server/pom.xml': '<project/>\n',
      'site/mcsts.plugin.json': manifestJson('skin_thing'),
      'site/index.ts': IMPORT_ENTRY,
      [`${PLUGIN_MARKER_DIR}/skin_thing.json`]: markerJson('skin_thing', 'acme/monorepo'),
    },
    tags: { 'v1.0.0': 'c'.repeat(40) },
    hits: [],
  };
  const { importer, close } = await makeImporter(repo, dir);
  try {
    const preview = await importer.preview({ repoInput: 'acme/monorepo' });
    assert.equal(preview.dir, 'site');
    assert.equal(preview.dirAutoDetected, true);
    assert.deepEqual(preview.files.map((f) => f.local).sort(), ['index.ts', 'mcsts.plugin.json']);
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
    tags: { 'v1.0.0': 'c'.repeat(40) },
    hits: [],
  };
  const { importer, close } = await makeImporter(repo, dir);
  try {
    const preview = await importer.preview({ repoInput: 'acme/monorepo', dir: 'packages/skin' });
    assert.equal(preview.tag, 'v1.0.0');
    assert.deepEqual(
      preview.files.map((item) => item.local).sort(),
      ['index.ts', 'mcsts.plugin.json'],
    );
    await importer.install({ repoInput: 'acme/monorepo', dir: 'packages/skin' }, preview.sha, 'u', false);
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
    await expectRejected(() => importer.preview({ repoInput: 'acme/demo-plugin' }), /被 GitHub 截断/);
  } finally {
    close();
  }
});

test('导入：已装过同名插件时必须显式确认替换，替换后不留备份', async () => {
  const dir = await tempDir();
  const repo = goodRepo();
  const { importer, close } = await makeImporter(repo, dir);
  try {
    const preview = await importer.preview({ repoInput: 'acme/demo-plugin' });
    await importer.install({ repoInput: 'acme/demo-plugin' }, preview.sha, 'u', false);
    await expectRejected(
      () => importer.install({ repoInput: 'acme/demo-plugin' }, preview.sha, 'u', false),
      /已经装在目录里/,
    );
    // 作者发了新版：改了内容 + 打了新 tag，面板不用再填任何东西就能装到新版
    repo.files['index.ts'] = `${IMPORT_ENTRY}// v2\n`;
    repo.tags['v0.2.0'] = 'd'.repeat(40);
    const second = await importer.preview({ repoInput: 'acme/demo-plugin' });
    assert.equal(second.tag, 'v0.2.0', '新版 tag 应被自动选中');
    await importer.install({ repoInput: 'acme/demo-plugin' }, second.sha, 'u', true);
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
      }).preview({ repoInput: 'a/b' });
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
    await codeOf(() => make(async () => new Response('{}', { status: 403 })).preview({ repoInput: 'a/b' })),
    'PLUGIN_IMPORT_UNREACHABLE',
  );
  // 仓库不存在 / 取不到 tag 列表：是 404，属请求内容问题 → 400 拒
  assert.equal(
    await codeOf(() => make(async () => new Response('{}', { status: 404 })).preview({ repoInput: 'a/b' })),
    'PLUGIN_IMPORT_REJECTED',
  );
});

test('导入：错误文案点名实际请求的主机，配了镜像时不再一口咬定是 GitHub', async () => {
  const dir = await tempDir();
  const importer = new PluginImporter({
    pluginDir: dir,
    now: () => new Date(),
    mirror: 'https://gh-proxy.example',
    fetchImpl: async () => {
      throw new TypeError('fetch failed');
    },
  });
  await assert.rejects(
    () => importer.preview({ repoInput: 'acme/demo-plugin' }),
    (err: unknown) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.code, 'PLUGIN_IMPORT_UNREACHABLE');
      // 运维要能一眼看出打的是镜像域名（DNS 有没有解析、镜像是否活着）
      assert.match(err.message, /gh-proxy\.example/);
      return true;
    },
  );
});

test('导入：清单域名通、文件域名不通时，文案点的是不通的那一个', async () => {
  const dir = await tempDir();
  const gh = await startFakeGitHub(goodRepo());
  // 真实踩到的形态就是这样的：api.github.com 通，raw.githubusercontent.com 被重置。
  // 文案若照 apiBase 写成「无法访问 api.github.com」，运维会去修一条本来好好的链路。
  const importer = new PluginImporter({
    pluginDir: dir,
    now: () => new Date(),
    apiBase: gh.apiBase,
    rawBase: 'https://raw.githubusercontent.com',
  });
  try {
    await assert.rejects(
      () => importer.preview({ repoInput: 'acme/demo-plugin' }),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'PLUGIN_IMPORT_UNREACHABLE');
        assert.match(err.message, /raw\.githubusercontent\.com/);
        assert.doesNotMatch(err.message, /无法访问 127\.0\.0\.1/);
        return true;
      },
    );
    assert.equal((await readdir(dir)).length, 0, '取不到文件时不该落任何东西');
  } finally {
    gh.close();
  }
});

test('导入：下载内容与仓库清单不符就中止，不留半个插件目录', async () => {
  const dir = await tempDir();
  const repo = goodRepo();
  // 清单按 `files` 报 sha，raw 却给另一份内容 —— 中间被改包 / CDN 不一致
  repo.overrideRaw = { 'index.ts': 'export default async function setup(){ throw new Error("被换包") }\n' };
  const { importer, close } = await makeImporter(repo, dir);
  try {
    const preview = await importer.preview({ repoInput: 'acme/demo-plugin' });
    await expectRejected(
      () => importer.install({ repoInput: 'acme/demo-plugin' }, preview.sha, 'u', false),
      /内容与仓库清单不符/,
    );
    assert.equal((await readdir(dir)).length, 0, '中止后不该留下半个插件目录');
  } finally {
    close();
  }
});

test('子目录自动识别：仓库里只有一份 manifest 时，dir 留空也认得（jar 共仓布局的痛点）', async () => {
  const dir = await tempDir();
  // 复刻 Bedrock-Link-Java：插件住 site/，仓库另有 jar 线（非 manifest 文件不参与判定）
  const repo: FakeRepo = {
    files: {
      'site/mcsts.plugin.json': manifestJson('demo_site'),
      'site/index.ts': IMPORT_ENTRY,
      'README.md': '# demo\n',
      'server/dist/BedrockLink-0.1.28.jar': 'BINARY-PLACEHOLDER',
      [`${PLUGIN_MARKER_DIR}/demo_site.json`]: markerJson('demo_site', 'acme/demo-plugin'),
    },
    tags: { 'v0.1.0': 'a'.repeat(40), 'server-v0.1.28': 'b'.repeat(40) },
    hits: [],
  };
  const { importer, close } = await makeImporter(repo, dir);
  try {
    const preview = await importer.preview({ repoInput: 'acme/demo-plugin' });
    assert.equal(preview.dir, 'site', '唯一一份 manifest 在 site/ 下就该自动认出来');
    assert.equal(preview.dirAutoDetected, true);
    assert.deepEqual(preview.files.map((f) => f.local).sort(), ['index.ts', 'mcsts.plugin.json']);
    const result = await importer.install({ repoInput: 'acme/demo-plugin' }, preview.sha, 'u', false);
    assert.equal(result.dir, 'site');
    assert.deepEqual((await readdir(join(dir, 'demo_site'))).sort(), ['.mcsts-import.json', 'index.ts', 'mcsts.plugin.json']);
  } finally {
    close();
  }
});

test('子目录不猜：树里有多份 manifest 时留空被拒并列出候选，指明其一才继续', async () => {
  const dir = await tempDir();
  const repo: FakeRepo = {
    files: {
      'skin/mcsts.plugin.json': manifestJson('demo_skin'),
      'skin/index.ts': IMPORT_ENTRY,
      'chat/mcsts.plugin.json': manifestJson('demo_chat'),
      'chat/index.ts': IMPORT_ENTRY,
      [`${PLUGIN_MARKER_DIR}/demo_skin.json`]: markerJson('demo_skin', 'acme/monorepo'),
      [`${PLUGIN_MARKER_DIR}/demo_chat.json`]: markerJson('demo_chat', 'acme/monorepo'),
    },
    tags: { 'v0.1.0': 'a'.repeat(40) },
    hits: [],
  };
  const { importer, close } = await makeImporter(repo, dir);
  try {
    const message = await expectRejected(
      () => importer.preview({ repoInput: 'acme/monorepo' }),
      /多份插件清单/,
    );
    assert.match(message, /skin\/mcsts\.plugin\.json/);
    assert.match(message, /chat\/mcsts\.plugin\.json/);
    const picked = await importer.preview({ repoInput: 'acme/monorepo', dir: 'skin' });
    assert.equal(picked.dir, 'skin');
    assert.equal(picked.dirAutoDetected, false, '人指的路径不算自动识别');
  } finally {
    close();
  }
});
