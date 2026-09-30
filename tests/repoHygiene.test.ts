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
 * 版本口径：代号 `v2-<年>.<季>.<迭代>` = 重制版标头 `2` + 年份 + 季度 + 季度内迭代序号。
 *
 * npm 要求 `version` 是合法 semver（三段），装不下四段号，所以包内只存读出来的那一段
 * `<年>.<季>.<迭代>`，标头由展示层拼（Yggdrasil 元数据、前端 `__APP_VERSION__`）。
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

/**
 * 后端新增 `/api/admin/<资源>` 端点时，前端兼容层必须知道它。
 *
 * `web/src/utils/apiCompat.ts` 末尾有一条**按前缀拦截**的兜底：凡是没进
 * `ADMIN_PASSTHROUGH`、也没有翻译分支的 `/api/admin/*`，一律返回 501「敬请期待」。
 * 于是后端接口明明是好的，开发环境里页面只会显示空数据 —— 插件面板第一次挂载时
 * 就是这样：列表恒为「插件目录里没有任何插件」，而 `GET /api/admin/plugins` 直接
 * 用 curl 调是 200 一条就绪的插件。
 *
 * 这条守卫把「加端点必须同时告诉兼容层」从注释里的提醒变成会红的测试。
 * 判定按**资源名**（`/api/admin/` 后第一段）而不是整条路径：兼容层里既有字面量
 * 也有正则（`\/api\/admin\/theme-image\/([^/]+)`），去掉反斜杠后两种写法都能命中。
 */
test('后端 /api/admin 端点必须被前端兼容层认出', () => {
  const compat = fs
    .readFileSync(path.join(ROOT, 'web', 'src', 'utils', 'apiCompat.ts'), 'utf8')
    .replace(/\\/g, '');
  const routesDir = path.join(ROOT, 'src', 'server', 'routes');
  const resources = new Map<string, string>();
  for (const file of fs.readdirSync(routesDir)) {
    if (!file.endsWith('.ts')) continue;
    const src = fs.readFileSync(path.join(routesDir, file), 'utf8');
    for (const hit of src.matchAll(/['"`]\/api\/admin\/([A-Za-z0-9_-]+)/g)) {
      if (!resources.has(hit[1]!)) resources.set(hit[1]!, file);
    }
  }
  assert.ok(resources.size > 0, '一条 /api/admin 路由都没扫到：正则或目录结构变了，这条守卫已失效');
  const missing = [...resources].filter(([name]) => !compat.includes(`/api/admin/${name}`));
  assert.deepEqual(
    missing,
    [],
    `这些管理端资源在 apiCompat 里毫无提及，开发环境会被兜底拦成 501：` +
      missing.map(([name, file]) => `/api/admin/${name}（${file}）`).join('、'),
  );
});

/**
 * 四语言语言包键位必须一一对应。
 *
 * 本站的界面文字全部走 i18next，缺一个键就退化成直接把 key 名印在界面上
 * （或者按 fallback 显示另一种语言）。这类洞只有跑到那个语言、那个分支才看得见，
 * 靠肉眼验收抓不完 —— 而键位集合是纯结构信息，可以直接比。
 *
 * 基线取 SCH（简体中文，主语言）；其余三份必须与它**完全相同**：不缺、不多、不重复。
 */
test('四语言语言包键位必须完全一致', () => {
  const dir = path.join(ROOT, 'web', 'src', 'i18n', 'locales');
  const flatten = (value: unknown, prefix = ''): string[] => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return [prefix];
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
      typeof child === 'object' && child !== null && !Array.isArray(child)
        ? flatten(child, `${prefix}${key}.`)
        : [`${prefix}${key}`],
    );
  };
  const load = (file: string): string[] => {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as unknown;
    return flatten(parsed).filter((key) => key !== '');
  };

  const base = load('SCH.json');
  const baseSet = new Set(base);
  assert.equal(base.length, baseSet.size, 'SCH.json 里出现重复键');
  assert.ok(baseSet.size > 500, `只扫到 ${baseSet.size} 个键：解析方式或目录变了，这条守卫已失效`);

  for (const file of ['TCH.json', 'EN.json', 'JP.json']) {
    const keys = load(file);
    assert.equal(keys.length, new Set(keys).size, `${file} 里出现重复键`);
    const set = new Set(keys);
    const missing = base.filter((key) => !set.has(key));
    const extra = keys.filter((key) => !baseSet.has(key));
    assert.deepEqual(
      [missing, extra],
      [[], []],
      `${file} 与 SCH.json 键位不一致：缺 ${missing.slice(0, 8).join(', ')}｜多 ${extra.slice(0, 8).join(', ')}`,
    );
  }
});
