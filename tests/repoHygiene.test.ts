/**
 * 仓库卫生：禁止 Windows 保留设备名出现在项目树里。
 *
 * ## 为什么需要这条测试
 *
 * `nul`（以及 con / prn / aux / com1-9 / lpt1-9）是 Windows 的 **DOS 设备名**。
 * 用 PowerShell 的 `>` 重定向、或任何走 .NET 全路径的写入，会在磁盘上**真的建出**
 * 一个名为 `nul` 的文件（.NET 会补 `\\?\` 前缀，从而绕开 Win32 的设备名解析）。
 *
 * 而它一旦建出来就**普通权限下删不掉**：`CreateFileW(path, DELETE)` 直接返回
 * ACCESS_DENIED —— 实测与「有进程占用」无关（独占打开成功、Restart Manager 报 0），
 * 也与 ACL 无关（ACL 里用户有 Modify）。`del`、`rm`、`[IO.File]::Delete`、
 * `\\?\Volume{...}\` 路径、`FILE_FLAG_POSIX_SEMANTICS` 全部失败。
 * 只能靠「重启时删除」（需要管理员）或直接绕开。
 *
 * ## 历史
 *
 * 它两次出现在 `web/src/i18n/locales/` 下：污染项目树、混进 grep 结果、
 * 还会被 Vite 的目录扫描读到。这条测试的目的就是让第三次出现立刻可见，
 * 而不是等谁偶然 `ls` 才发现。
 *
 * 结论：**任何 shell 里都不要用 `>nul`**；Git Bash 用 `/dev/null`，
 * PowerShell 用 `$null` / `| Out-Null`。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildMetadataDto } from '../src/yggdrasil/metadata.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Windows 保留设备名（大小写不敏感；带扩展名也算，如 nul.txt） */
const RESERVED = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

/**
 * 跳过的目录：都不是源码，且 data / INDEV 里体积大（便携 PostgreSQL 数据目录），
 * 全量遍历会让测试变慢很多。
 */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'coverage',
  'data',
  'INDEV',
  '.workbuddy',
  '.junk-i18n',
]);

function isReserved(name: string): boolean {
  const base = name.split('.')[0]?.toLowerCase() ?? '';
  return RESERVED.has(base);
}

function walk(dir: string, hits: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    // 权限不足等异常不该让卫生检查失败
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (isReserved(entry.name)) {
      hits.push(path.relative(ROOT, full).replace(/\\/g, '/'));
    }
    if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) {
      walk(full, hits);
    }
  }
}

test('项目树中不得出现 Windows 保留设备名（nul / con / aux …）', () => {
  const hits: string[] = [];
  walk(ROOT, hits);
  hits.sort();
  assert.deepEqual(
    hits,
    [],
    [
      '发现 Windows 保留设备名文件，它们在 Windows 上无法用常规手段删除：',
      ...hits.map((h) => `  - ${h}`),
      '',
      '请检查是否有命令用了 `>nul`（Git Bash 请用 /dev/null，PowerShell 请用 $null）。',
    ].join('\n'),
  );
});

/**
 * 版本口径：`v2-26.3.6` = 重制版标头 `2` + 年份 + 季度 + 季度内迭代序号。
 *
 * npm 要求 `version` 是合法 semver（三段），装不下四段号，所以包内只存读出来的那一段
 * `26.3.6`，标头由展示层拼（Yggdrasil 元数据、前端 `__APP_VERSION__`）。
 * 于是「同一个版本散在多处」成了必须守住的不变量：漏改一处就会出现页脚与启动器
 * 元数据各说一套，所以这里逐条比对。
 */
test('版本号：包内 semver 与对外的 v2- 代号必须同源', async () => {
  const rootPkg = JSON.parse(
    await fs.promises.readFile(path.join(ROOT, 'package.json'), 'utf8'),
  ) as { version: string };
  const webPkg = JSON.parse(
    await fs.promises.readFile(path.join(ROOT, 'web', 'package.json'), 'utf8'),
  ) as { version: string };

  assert.equal(webPkg.version, rootPkg.version, 'web/package.json 与 package.json 版本不同步');
  // 年.季.迭代 三段，且必须是合法 semver（npm 会校验）
  assert.match(
    rootPkg.version,
    /^\d{2}\.\d{1,2}\.\d{1,2}$/,
    `版本号 ${rootPkg.version} 不符合「年份.季度.季度内迭代」三段口径`,
  );

  const code = `2-${rootPkg.version}`;
  const meta = buildMetadataDto({
    baseUrl: 'http://localhost:3000',
    publicKeyPem: '-----BEGIN PUBLIC KEY-----\nprobe\n-----END PUBLIC KEY-----',
  });
  assert.equal(
    meta.meta.implementation.version,
    code,
    'Yggdrasil 元数据的 implementation.version 漂移',
  );

  // 四语言 README 的版本行都要带对外代号
  for (const file of ['README.md', 'README.zh-Hant.md', 'README.en.md', 'README.ja.md']) {
    const text = await fs.promises.readFile(path.join(ROOT, file), 'utf8');
    assert.ok(
      text.includes(`v${code}`),
      `${file} 里没有对外版本代号 v${code}（版本行漏改或口径说明被删）`,
    );
  }
});
