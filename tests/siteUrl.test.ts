import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SiteUrlResolver,
  originFromAssetBase,
  ASSET_MOUNT_PATH,
} from '../src/site/siteUrl.js';

/**
 * 站点地址解析（P5）。
 *
 * 覆盖的其实是**一条容易出错的优先级链**：站点根来自后台设置 BASE_URL，
 * 素材前缀来自环境变量 PUBLIC_BASE_URL，两者互不覆盖、各有兜底。
 * 改动前 BASE_URL 是死字段（后端从不读），PUBLIC_BASE_URL 语义又与「站点根」混淆，
 * 这里把四种组合都钉住，防止将来某次改动把优先级调反。
 */

/** 只实现 get 的最小设置仓储替身 */
function fakeSettings(values: Record<string, unknown>) {
  return {
    get: async (key: string): Promise<unknown> => values[key],
  };
}

test('siteUrl: originFromAssetBase 剥掉 /uploads 挂载点', () => {
  assert.equal(
    originFromAssetBase('http://localhost:3000/uploads'),
    'http://localhost:3000',
  );
  // 尾斜杠要一并吞掉，否则拼出来的链接会出现 // 或 /uploads/
  assert.equal(
    originFromAssetBase('https://skin.example.com/uploads///'),
    'https://skin.example.com',
  );
  // 不以 /uploads 结尾时原样当作站点根（宁可多一个斜杠，也不要猜错）
  assert.equal(originFromAssetBase('https://skin.example.com'), 'https://skin.example.com');
  assert.equal(originFromAssetBase(''), 'http://localhost:3000');
});

test('siteUrl: 无设置无环境变量时用 localhost 兜底', async () => {
  const resolver = new SiteUrlResolver({});
  await resolver.refresh();
  assert.equal(resolver.originSync(), 'http://localhost:3000');
  assert.equal(resolver.assetBaseUrlSync(), `http://localhost:3000${ASSET_MOUNT_PATH}`);
  assert.deepEqual(resolver.skinDomains(), ['localhost']);
});

test('siteUrl: 只有 PUBLIC_BASE_URL 时由它反推站点根', async () => {
  const resolver = new SiteUrlResolver({
    envPublicBaseUrl: 'https://cdn.example.com/uploads',
  });
  await resolver.refresh();
  assert.equal(resolver.originSync(), 'https://cdn.example.com');
  assert.equal(resolver.assetBaseUrlSync(), 'https://cdn.example.com/uploads');
});

test('siteUrl: BASE_URL 决定站点根，但不覆盖显式的素材前缀', async () => {
  const resolver = new SiteUrlResolver({
    settings: fakeSettings({ BASE_URL: 'https://skin.example.com' }),
    envPublicBaseUrl: 'https://cdn.example.com/uploads',
    ttlMs: 0,
  });
  await resolver.refresh();
  // 站点根跟随后台设置（邮件链接用这个）
  assert.equal(resolver.originSync(), 'https://skin.example.com');
  // 素材仍走环境变量（部署形态，管理员在后台改不了）
  assert.equal(resolver.assetBaseUrlSync(), 'https://cdn.example.com/uploads');
  assert.deepEqual(resolver.skinDomains(), ['skin.example.com']);
});

test('siteUrl: 只设 BASE_URL 时素材前缀跟着站点根推导', async () => {
  const resolver = new SiteUrlResolver({
    settings: fakeSettings({ BASE_URL: 'https://skin.example.com' }),
    ttlMs: 0,
  });
  await resolver.refresh();
  assert.equal(resolver.originSync(), 'https://skin.example.com');
  assert.equal(resolver.assetBaseUrlSync(), 'https://skin.example.com/uploads');
});

test('siteUrl: YGGDRASIL_SKIN_DOMAINS 优先于 hostname 派生', async () => {
  const resolver = new SiteUrlResolver({
    settings: fakeSettings({ BASE_URL: 'https://skin.example.com' }),
    envSkinDomains: ['a.example.com', 'b.example.com'],
    ttlMs: 0,
  });
  await resolver.refresh();
  assert.deepEqual(resolver.skinDomains(), ['a.example.com', 'b.example.com']);
});

test('siteUrl: link() 生成 HashRouter 形态链接', async () => {
  const resolver = new SiteUrlResolver({
    settings: fakeSettings({ BASE_URL: 'https://skin.example.com' }),
    ttlMs: 0,
  });
  const url = await resolver.link('/verify-email', { token: 'abc 123' });
  // 路径必须在 # 之后：静态托管只认 index.html，写成 /verify-email 会 404
  assert.equal(url, 'https://skin.example.com/#/verify-email?token=abc+123');
});

test('siteUrl: BASE_URL 变化在刷新后立即生效（缓存不得粘住旧值）', async () => {
  const values: Record<string, unknown> = { BASE_URL: 'https://old.example.com' };
  const resolver = new SiteUrlResolver({
    settings: { get: async (k: string) => values[k] },
    // TTL 设大，确保「生效」来自 refresh 而不是缓存过期
    ttlMs: 60_000,
  });
  await resolver.refresh();
  assert.equal(resolver.originSync(), 'https://old.example.com');

  values['BASE_URL'] = 'https://new.example.com';
  await resolver.refresh();
  assert.equal(resolver.originSync(), 'https://new.example.com');
});

test('siteUrl: 设置为空串时回落到环境变量，而不是变成空站点根', async () => {
  const resolver = new SiteUrlResolver({
    settings: fakeSettings({ BASE_URL: '   ' }),
    envPublicBaseUrl: 'https://cdn.example.com/uploads',
    ttlMs: 0,
  });
  await resolver.refresh();
  assert.equal(resolver.originSync(), 'https://cdn.example.com');
});

test('siteUrl: 仓储读失败时沿用上一次的值（不把站点拖挂）', async () => {
  let shouldThrow = false;
  const resolver = new SiteUrlResolver({
    settings: {
      get: async () => {
        if (shouldThrow) throw new Error('db down');
        return 'https://skin.example.com';
      },
    },
    ttlMs: 0,
  });
  await resolver.refresh();
  assert.equal(resolver.originSync(), 'https://skin.example.com');

  // 模拟数据库不可用：地址不应退化成 localhost，否则所有纹理 URL 会突然指向本机
  shouldThrow = true;
  await resolver.refresh();
  assert.equal(resolver.originSync(), 'https://skin.example.com');
});
