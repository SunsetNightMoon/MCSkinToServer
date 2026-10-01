import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  checkConfigGaps,
  logConfigGaps,
  type ConfigGapContext,
} from '../src/server/configCheck.js';
import type { AppConfig } from '../src/config.js';
import { normalizePluginMirror } from '../src/config.js';

/**
 * 启动配置自检（缺项提示）。
 *
 * 这批测试钉的是**提示的口径**而不是排版：每一项都要说清「缺了会看到什么症状」，
 * 因为运维是按症状去搜索日志的；同时要钉住「不该出现的别出现」—— 见风就是雨的检查
 * 会被当成噪音忽略，那就等于没有检查。
 */

/** 一份全部合格的配置：MCSTS_SECRET 已设、TRUST_PROXY 已设、站点根已声明 */
const COMPLETE: ConfigGapContext = {
  config: { rateLimit: { enabled: true, max: 5, windowMs: 300_000 } } as unknown as AppConfig,
  env: { MCSTS_SECRET: 'a-secret-of-at-least-16-chars', TRUST_PROXY: '1' },
  siteOriginDeclared: true,
};

function gapsOf(overrides: Partial<ConfigGapContext>): string[] {
  const merged: ConfigGapContext = { ...COMPLETE, ...overrides };
  return checkConfigGaps(merged).map((g) => g.item);
}

test('配置自检：一切就绪时不产生任何提示（否则会被当噪音忽略）', () => {
  assert.deepEqual(checkConfigGaps(COMPLETE), []);
});

test('配置自检：主密钥缺失时提醒「要重新保存才会加密」', () => {
  const gaps = checkConfigGaps({
    ...COMPLETE,
    env: { TRUST_PROXY: '1' },
  });
  const secret = gaps.find((g) => g.item === 'MCSTS_SECRET');
  assert.ok(secret, 'MCSTS_SECRET 未设置应进缺项列表');
  // 这条是生产端实测踩到的误解：以为补上主密钥就能把历史明文一并加密。
  assert.match(secret!.hint, /重新保存/);
  assert.match(secret!.hint, /SMTP_PASS/);
  assert.match(secret!.hint, /EXTERNAL_CAPTCHA_SECRET/);
});

test('配置自检：TRUST_PROXY 缺失写成条件句（不在反代后可忽略）', () => {
  const gaps = checkConfigGaps({ ...COMPLETE, env: { MCSTS_SECRET: 'a-secret-value-1234567890' } });
  const proxy = gaps.find((g) => g.item === 'TRUST_PROXY');
  assert.ok(proxy, 'TRUST_PROXY 未设置应进缺项列表');
  assert.match(proxy!.hint, /反向代理/);
  assert.match(proxy!.hint, /429/);
  // 必须同时说明「乱设的后果」，否则运维会照着清单无脑加
  assert.match(proxy!.hint, /X-Forwarded-For|伪造/);
});

test('配置自检：站点根未声明时点名后台设置项 BASE_URL', () => {
  assert.deepEqual(gapsOf({ siteOriginDeclared: false }), [
    'BASE_URL（后台站点设置）',
  ]);
});

test('配置自检：限流总开关关闭时提醒这是临时状态', () => {
  assert.ok(
    gapsOf({
      config: { rateLimit: { enabled: false, max: 5, windowMs: 300_000 } } as unknown as AppConfig,
    }).includes('RATE_LIMIT_DISABLED'),
  );
});

test('配置自检：SMTP_ALLOW_SELF_SIGNED 只在真的开启时提醒', () => {
  assert.ok(
    gapsOf({
      env: {
        MCSTS_SECRET: 'a-secret-value-1234567890',
        TRUST_PROXY: '1',
        SMTP_ALLOW_SELF_SIGNED: 'true',
      },
    }).includes('SMTP_ALLOW_SELF_SIGNED'),
  );
  // 显式写 false 是「想过并保持关闭」，不该再提醒
  assert.deepEqual(
    gapsOf({
      env: {
        MCSTS_SECRET: 'a-secret-value-1234567890',
        TRUST_PROXY: '1',
        SMTP_ALLOW_SELF_SIGNED: 'false',
      },
    }),
    [],
  );
});

test('配置自检：只含空白的环境变量按未设置处理', () => {
  assert.deepEqual(
    gapsOf({ env: { MCSTS_SECRET: '   ', TRUST_PROXY: '' } }),
    ['MCSTS_SECRET', 'TRUST_PROXY'],
  );
});

test('配置自检：rateLimit 缺省（测试里手工构造的 config）不误报', () => {
  assert.deepEqual(gapsOf({ config: {} as unknown as AppConfig }), []);
});

// ------------------------------------------------- 插件导入镜像前缀（填错要有回声）

test('镜像前缀：只接受合法的 https 绝对地址，其余按未设置处理', () => {
  assert.equal(normalizePluginMirror('https://gh-proxy.com'), 'https://gh-proxy.com');
  // 末尾斜杠会被拼进 URL，先去掉才是规范形态
  assert.equal(normalizePluginMirror('https://gh-proxy.com///'), 'https://gh-proxy.com');
  assert.equal(normalizePluginMirror('  https://mirror.example  '), 'https://mirror.example');
  // 明文 http 会被中间人改写清单；带凭据的地址不该从配置里溜进去
  assert.equal(normalizePluginMirror('http://gh-proxy.com'), undefined);
  assert.equal(normalizePluginMirror('https://user:pw@gh-proxy.com'), undefined);
  assert.equal(normalizePluginMirror('gh-proxy.com'), undefined);
  assert.equal(normalizePluginMirror('not a url'), undefined);
  assert.equal(normalizePluginMirror('   '), undefined);
  assert.equal(normalizePluginMirror(undefined), undefined);
});

test('配置自检：镜像填错时点名，合法时安静（非法值现在打的是 github.com）', () => {
  const bad = checkConfigGaps({
    ...COMPLETE,
    env: {
      MCSTS_SECRET: 'a-secret-value-1234567890',
      TRUST_PROXY: '1',
      MCSTS_PLUGIN_MIRROR: 'gh-proxy.com',
    },
  });
  assert.deepEqual(bad.map((g) => g.item), ['MCSTS_PLUGIN_MIRROR']);
  assert.match(bad[0]!.hint, /按未设置处理/);

  const good = checkConfigGaps({
    ...COMPLETE,
    env: {
      MCSTS_SECRET: 'a-secret-value-1234567890',
      TRUST_PROXY: '1',
      MCSTS_PLUGIN_MIRROR: 'https://gh-proxy.com',
    },
  });
  assert.equal(good.length, 0, '合法的镜像前缀不该出现在缺项列表里');
});

test('配置自检日志：一条一行、统一前缀，无缺项时保持安静', () => {  const lines: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(' '));
  };
  try {
    logConfigGaps(COMPLETE);
    // 注意别写成 assert.deepEqual(lines, [])：@types/node 的 deepEqual 带
    // `asserts actual is T` 签名，空数组字面量会把 lines 收窄成 never[]。
    assert.equal(lines.length, 0, '一切就绪时不该打印任何启动日志');

    logConfigGaps({ ...COMPLETE, env: {} });
    assert.equal(lines.length, 3, '汇总行 + 两条缺项');
    assert.match(lines[0]!, /配置自检：2 项/);
    assert.ok(lines.slice(1).every((l) => l.includes('[mcsts] 配置自检 · ')));
  } finally {
    console.warn = original;
  }
});
