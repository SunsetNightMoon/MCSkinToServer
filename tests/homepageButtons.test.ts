import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHomepageButtons } from '../web/src/utils/homepageButtons.js';

// ---------------------------------------------------------------------------
// 首页额外按钮的容错解析（缺陷回归守卫）
//
// 症状（生产域名服务器实测）：/api/settings/public 把 HOMEPAGE_BUTTONS 直出为
// **已解析数组**（早期/手工写入的单编码形态），而改动前管理端与首页都裸调
// `JSON.parse(raw)` —— JSON.parse 收到数组会先隐式转成 "[object Object]" 再解析，
// 必然抛错被 catch 吞掉，表现为「按钮存了却加载为空、像没保存」。
// 两种真实形态（数组 / JSON 字符串）都必须能解析，是本文件的唯一契约。
// ---------------------------------------------------------------------------

test('homepageButtons: 已解析数组形态（生产域名服务器的真实存储形态）可直接读出', () => {
  const raw = [{ text: '进入主站', link: 'https://catnight.top/' }];
  assert.deepEqual(parseHomepageButtons(raw), [{ text: '进入主站', link: 'https://catnight.top/' }]);
});

test('homepageButtons: JSON 字符串形态（管理端保存的形态）可读出', () => {
  const raw = '[{"text":"A","link":"/a"}]';
  assert.deepEqual(parseHomepageButtons(raw), [{ text: 'A', link: '/a' }]);
});

test('homepageButtons: 缺失/坏值回落空数组，不抛错', () => {
  for (const bad of [undefined, null, '', '  ', 'not json', '{', 42, {}]) {
    assert.deepEqual(parseHomepageButtons(bad), [], `坏值应回落空数组: ${String(bad)}`);
  }
});

test('homepageButtons: 条目字段缺失时归一为空串（调用方据此过滤）', () => {
  assert.deepEqual(parseHomepageButtons([{ text: 'A' }, { link: '/b' }, null, 7]), [
    { text: 'A', link: '' },
    { text: '', link: '/b' },
  ]);
});

test('homepageButtons: 管理端与首页不再裸 JSON.parse 该键，统一走共享解析器', async () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const files = [
    join(repoRoot, 'web', 'src', 'pages', 'Admin', 'SystemSettings.tsx'),
    join(repoRoot, 'web', 'src', 'pages', 'Landing', 'Landing.tsx'),
  ];
  for (const file of files) {
    const src = await readFile(file, 'utf8');
    assert.match(
      src,
      /utils\/homepageButtons/,
      `${file} 应改用共享的 parseHomepageButtons，而不是就地解析`,
    );
    assert.doesNotMatch(
      src,
      /JSON\.parse\(\s*[\w.]*HOMEPAGE_BUTTONS/,
      `${file} 仍在裸 JSON.parse HOMEPAGE_BUTTONS（数组形态会抛错丢按钮）`,
    );
  }
});
