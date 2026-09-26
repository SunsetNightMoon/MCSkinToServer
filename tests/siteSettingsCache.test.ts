import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// 站点设置的读取路径（缺陷回归守卫）
//
// 症状：管理员上传亮/暗色背景图、登录页背景图后，前台**毫无变化**，刷新也不生效，
// 只能等 5 分钟或手动清 localStorage。
// 根因：`/api/admin/upload-theme-image` 这条写入路径不经过 `PUT /api/admin/settings`，
// 因此没人调用 clearSiteTitleCache()；而改动前的 usePageTitle 一旦命中
// localStorage 里那份带 TTL 的旧值就直接 return，把 siteStore.loadSettings()
// 刚拿到的新值又冲回「背景图为空」。
// 契约：站点设置**只从网络读**；内存里那份只用于首屏标题，不参与请求短路；
// 任何写入站点头像/背景图的端点成功后都必须失效缓存。
// ---------------------------------------------------------------------------

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const hookPath = join(repoRoot, 'web', 'src', 'hooks', 'usePageTitle.ts');
const adminPath = join(
  repoRoot,
  'web',
  'src',
  'pages',
  'Admin',
  'SystemSettings.tsx',
);

test('usePageTitle: 站点设置不再读写 localStorage 缓存（旧缓存会把新背景图冲回旧值）', async () => {
  const src = await readFile(hookPath, 'utf8');
  assert.doesNotMatch(
    src,
    /localStorage\.getItem/,
    '命中本地缓存直接返回是本次缺陷的根因，不允许再读回来',
  );
  assert.doesNotMatch(
    src,
    /localStorage\.setItem/,
    '站点设置不写本地缓存：写一次就留下一份会撒谎的旧值',
  );
  assert.doesNotMatch(src, /CACHE_TTL_MS/, '不该再有「缓存有效期」这类概念');
});

test('usePageTitle: fetchSiteSettings 只做并发去重，不返回内存里的旧值', async () => {
  const src = await readFile(hookPath, 'utf8');
  const start = src.indexOf('async function fetchSiteSettings');
  assert.ok(start !== -1, '找不到 fetchSiteSettings');
  const body = src.slice(start, src.indexOf('\n}', start));
  assert.match(
    body,
    /if \(inflight !== null\) return inflight/,
    '保留 in-flight Promise 去重（同一次挂载多个页面共用一份请求）',
  );
  assert.doesNotMatch(
    body,
    /latestSettings !== null/,
    '内存值只能当首屏标题的初始值，不能拿来短路网络请求',
  );
});

test('usePageTitle: 历史遗留的 localStorage 键会被清理掉', async () => {
  const src = await readFile(hookPath, 'utf8');
  assert.match(src, /catTavernSkins-site-settings/, '应仍知道旧键名，否则老访客的清不掉');
  assert.match(src, /localStorage\.removeItem/, 'clearSiteTitleCache 要顺手清掉旧键');
});

test('SystemSettings: 背景图/站点头像的每条写入路径都失效站点设置缓存', async () => {
  const src = await readFile(adminPath, 'utf8');
  // favicon/logo 走共用 helper；四个背景图各有自己的上传/删除处理器
  const units = [
    'const uploadIcon',
    'const removeIcon',
    'const handleUploadLightBg',
    'const handleRemoveLightBg',
    'const handleUploadDarkBg',
    'const handleRemoveDarkBg',
    'const handleUploadLoginBg',
    'const handleRemoveLoginBg',
    'const handleUploadLoginEmbed',
    'const handleRemoveLoginEmbed',
  ];
  for (const unit of units) {
    const start = src.indexOf(unit);
    assert.ok(start !== -1, `${unit} 不存在，守卫需同步更新`);
    const next = src.indexOf('\n  const ', start + unit.length);
    const block = src.slice(start, next === -1 ? src.length : next);
    assert.match(
      block,
      /theme-image/,
      `${unit} 应确实在调用主题图端点（块切分失效，需修正本测试）`,
    );
    assert.match(
      block,
      /clearSiteTitleCache\(\)/,
      `${unit} 写入成功后必须失效站点设置缓存，否则前台继续展示旧图`,
    );
  }
});
