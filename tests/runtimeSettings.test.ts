import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  RuntimeSettings,
  toSettingBool,
  RUNTIME_SETTING_DEFAULTS,
} from '../src/site/runtimeSettings.js';
import { SecretBox } from '../src/util/secretBox.js';

/**
 * 运行期站点设置读取器（P5）。
 *
 * 这个模块的核心价值是**消除形态歧义**：同一个开关可能是布尔 true、
 * 字符串 'true' 或数字 1。改动前前端用 `!== 'false'` 判断，布尔 false 会被判成开启，
 * 于是「关掉注册后重新加载显示成开启」。这里的解析是唯一入口，必须覆盖全部形态。
 */

test('runtimeSettings: toSettingBool 覆盖全部已知形态', () => {
  // 布尔（AntD Switch 提交的形态）
  assert.equal(toSettingBool(true, false), true);
  assert.equal(toSettingBool(false, true), false);
  // 字符串（旧前端提交的形态）
  assert.equal(toSettingBool('true', false), true);
  assert.equal(toSettingBool('false', true), false);
  assert.equal(toSettingBool('TRUE', false), true);
  assert.equal(toSettingBool(' on ', false), true);
  // 数字（手工 SQL 写入的形态）
  assert.equal(toSettingBool(1, false), true);
  assert.equal(toSettingBool(0, true), false);
  // 缺失 / 损坏 → 回落 fallback，而不是抛错或猜一个
  assert.equal(toSettingBool(undefined, true), true);
  assert.equal(toSettingBool(null, true), true);
  assert.equal(toSettingBool('', true), true);
  assert.equal(toSettingBool('maybe', false), false);
});

/** 只实现 getAll 的最小设置仓储替身 */
function fakeSettings(values: Record<string, unknown>) {
  return {
    getAll: async (): Promise<Record<string, unknown>> => values,
  };
}

test('runtimeSettings: 未设置时使用与前端一致的缺省值', async () => {
  const runtime = new RuntimeSettings({ settings: fakeSettings({}) });
  assert.equal(await runtime.allowRegistration(), RUNTIME_SETTING_DEFAULTS.allowRegistration);
  assert.equal(
    await runtime.requireEmailVerification(),
    RUNTIME_SETTING_DEFAULTS.requireEmailVerification,
  );
  assert.equal(await runtime.enableCaptcha(), RUNTIME_SETTING_DEFAULTS.enableCaptcha);
  // 缺省必须真的是「允许注册 / 不要求验证 / 不启用验证码」：
  // 若与前端 SITE_DEFAULTS.allowRegistration 不一致，会出现「界面能填、提交必失败」
  assert.equal(RUNTIME_SETTING_DEFAULTS.allowRegistration, true);
  assert.equal(RUNTIME_SETTING_DEFAULTS.requireEmailVerification, false);
  assert.equal(RUNTIME_SETTING_DEFAULTS.enableCaptcha, false);
});

test('runtimeSettings: 布尔 false 会被正确读成「关闭」（回归测试）', async () => {
  // 这正是修复前的 bug：Switch 存的是布尔 false，而代码拿它跟字符串 'false' 比
  const runtime = new RuntimeSettings({
    settings: fakeSettings({ ALLOW_REGISTRATION: false, ENABLE_CAPTCHA: false }),
  });
  assert.equal(await runtime.allowRegistration(), false);
  assert.equal(await runtime.enableCaptcha(), false);
});

test('runtimeSettings: 字符串与数字形态同样生效', async () => {
  const runtime = new RuntimeSettings({
    settings: fakeSettings({
      ALLOW_REGISTRATION: 'false',
      REQUIRE_EMAIL_VERIFICATION: 'true',
      ENABLE_CAPTCHA: 1,
    }),
  });
  assert.equal(await runtime.allowRegistration(), false);
  assert.equal(await runtime.requireEmailVerification(), true);
  assert.equal(await runtime.enableCaptcha(), true);
});

test('runtimeSettings: siteTitle 缺省回落通用名', async () => {
  const empty = new RuntimeSettings({ settings: fakeSettings({}) });
  assert.equal(await empty.siteTitle(), RUNTIME_SETTING_DEFAULTS.siteTitle);

  const named = new RuntimeSettings({
    settings: fakeSettings({ SITE_TITLE: '  我的皮肤站  ' }),
  });
  assert.equal(await named.siteTitle(), '我的皮肤站');
});

test('runtimeSettings: smtp() 读取并解密口令', async () => {
  const box = new SecretBox('test-master-secret-value');
  const runtime = new RuntimeSettings({
    settings: fakeSettings({
      SMTP_HOST: 'smtp.example.com',
      SMTP_PORT: '465',
      SMTP_SECURE: true,
      SMTP_USER: 'noreply@example.com',
      SMTP_PASS: box.encrypt('smtp-authorization-code'),
      SMTP_FROM: 'noreply@example.com',
      SMTP_FROM_NAME: '皮肤站',
    }),
    secretBox: box,
  });

  const smtp = await runtime.smtp();
  assert.equal(smtp.host, 'smtp.example.com');
  assert.equal(smtp.port, 465);
  assert.equal(smtp.secure, true);
  assert.equal(smtp.user, 'noreply@example.com');
  // 拿到的是明文，调用方（nodemailer）不需要知道密文的存在
  assert.equal(smtp.pass, 'smtp-authorization-code');
  assert.equal(smtp.fromName, '皮肤站');
});

test('runtimeSettings: 未加密的历史明文口令仍可用', async () => {
  const runtime = new RuntimeSettings({
    settings: fakeSettings({
      SMTP_HOST: 'smtp.example.com',
      SMTP_USER: 'u@example.com',
      SMTP_PASS: 'plain-legacy-password',
    }),
    secretBox: new SecretBox('test-master-secret-value'),
  });
  assert.equal((await runtime.smtp()).pass, 'plain-legacy-password');
});

test('runtimeSettings: smtpConfigured 的三态判定', async () => {
  const noHost = new RuntimeSettings({ settings: fakeSettings({}) });
  assert.equal(await noHost.smtpConfigured(), false);

  const noPass = new RuntimeSettings({
    settings: fakeSettings({ SMTP_HOST: 'smtp.example.com', SMTP_USER: 'u@example.com' }),
  });
  assert.equal(await noPass.smtpConfigured(), false, '填了用户名却没有口令视为未配置');

  // 无认证的开放中继（内网常见）：没有用户名时不要求口令
  const noAuth = new RuntimeSettings({
    settings: fakeSettings({ SMTP_HOST: '10.0.0.5' }),
  });
  assert.equal(await noAuth.smtpConfigured(), true);

  const ok = new RuntimeSettings({
    settings: fakeSettings({
      SMTP_HOST: 'smtp.example.com',
      SMTP_USER: 'u@example.com',
      SMTP_PASS: 'p',
    }),
  });
  assert.equal(await ok.smtpConfigured(), true);
});

test('runtimeSettings: 端口非法时回落到 587', async () => {
  const runtime = new RuntimeSettings({
    settings: fakeSettings({ SMTP_HOST: 'h', SMTP_PORT: 'not-a-number' }),
  });
  assert.equal((await runtime.smtp()).port, 587);
});

test('runtimeSettings: 邮件模板主题或正文缺失即视为未配置', async () => {
  const onlySubject = new RuntimeSettings({
    settings: fakeSettings({ EMAIL_TEMPLATE_SUBJECT: '主题' }),
  });
  assert.equal(await onlySubject.mailTemplate(), null);

  const onlyHtml = new RuntimeSettings({
    settings: fakeSettings({ EMAIL_TEMPLATE_HTML: '<p>x</p>' }),
  });
  assert.equal(await onlyHtml.mailTemplate(), null);

  const both = new RuntimeSettings({
    settings: fakeSettings({
      EMAIL_TEMPLATE_SUBJECT: '主题',
      EMAIL_TEMPLATE_HTML: '<p>{{VERIFY_URL}}</p>',
    }),
  });
  assert.deepEqual(await both.mailTemplate(), {
    subject: '主题',
    html: '<p>{{VERIFY_URL}}</p>',
  });
});

test('runtimeSettings: refresh 让改动立即生效（TTL 内亦然）', async () => {
  const values: Record<string, unknown> = { ALLOW_REGISTRATION: true };
  const runtime = new RuntimeSettings({
    settings: { getAll: async () => values },
    ttlMs: 60_000,
  });
  assert.equal(await runtime.allowRegistration(), true);

  values['ALLOW_REGISTRATION'] = false;
  // TTL 是 60s，未刷新前仍读缓存
  assert.equal(await runtime.allowRegistration(), true);

  await runtime.refresh();
  assert.equal(await runtime.allowRegistration(), false);
});

test('runtimeSettings: 仓储报错时沿用缓存，不让注册端点 500', async () => {
  let fail = false;
  const runtime = new RuntimeSettings({
    settings: {
      getAll: async () => {
        if (fail) throw new Error('db down');
        return { ALLOW_REGISTRATION: false };
      },
    },
    ttlMs: 0,
  });
  assert.equal(await runtime.allowRegistration(), false);
  fail = true;
  assert.equal(await runtime.allowRegistration(), false, '读失败应沿用上一次的值');
});

test('runtimeSettings: 缓存不得与仓储返回的对象共享引用', async () => {
  // 仓储返回的对象归它自己所有。若本模块直接持有该引用，
  // 对方原地改值（测试替身、或将来某个带内部缓存的仓储实现）
  // 就会穿透进本模块的 TTL 缓存 —— 表现为「TTL 没到，读到的却是新值」。
  const values: Record<string, unknown> = { ALLOW_REGISTRATION: true };
  const runtime = new RuntimeSettings({
    settings: { getAll: async () => values },
    ttlMs: 60_000,
  });
  assert.equal(await runtime.allowRegistration(), true);

  values['ALLOW_REGISTRATION'] = false;
  assert.equal(
    await runtime.allowRegistration(),
    true,
    'TTL 内应返回加载时的快照，而不是被外部改动穿透',
  );

  await runtime.refresh();
  assert.equal(await runtime.allowRegistration(), false);
});

/**
 * 前后端布尔口径一致性（跨包断言）。
 *
 * `web/src/utils/settingBool.ts` 是前端的唯一解析入口，`toSettingBool` 是后端的。
 * 两侧必须对同一输入给出同一结果 —— 否则会出现「界面显示开启、后端按关闭执行」
 * （或反过来），而两边各自单测都是绿的。这里直接把前端实现 import 进来对拍。
 */
test('runtimeSettings: 前端 settingBool 与后端 toSettingBool 逐项一致', async () => {
  const { settingBool } = await import('../web/src/utils/settingBool.js');
  const inputs: unknown[] = [
    true,
    false,
    'true',
    'false',
    'TRUE',
    'False',
    ' true ',
    '1',
    '0',
    'on',
    'off',
    'yes',
    'no',
    1,
    0,
    2,
    '',
    null,
    undefined,
    'maybe',
    {},
    [],
  ];
  for (const value of inputs) {
    for (const fallback of [true, false]) {
      assert.equal(
        settingBool(value, fallback),
        toSettingBool(value, fallback),
        `对 ${JSON.stringify(value)}（fallback=${fallback}）前后端解析结果不一致`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Issue #3：人机验证类型与外部验证配置
// ---------------------------------------------------------------------------

const BOX_SECRET = 'test-master-secret-value';

function runtimeWith(values: Record<string, unknown>): RuntimeSettings {
  return new RuntimeSettings({
    settings: fakeSettings(values),
    secretBox: new SecretBox(BOX_SECRET),
  });
}

test('runtimeSettings: captchaType 显式值优先，缺省时才按旧布尔推导', async () => {
  // 老站点只写过 ENABLE_CAPTCHA，升级后行为必须一字不变
  assert.equal(await runtimeWith({ ENABLE_CAPTCHA: true }).captchaType(), 'math');
  assert.equal(await runtimeWith({ ENABLE_CAPTCHA: false }).captchaType(), 'none');
  assert.equal(await runtimeWith({}).captchaType(), 'none');

  // 显式类型压过旧布尔 —— 包括「新区里关掉验证码」这一条
  assert.equal(
    await runtimeWith({ CAPTCHA_TYPE: 'image', ENABLE_CAPTCHA: false }).captchaType(),
    'image',
  );
  assert.equal(
    await runtimeWith({ CAPTCHA_TYPE: 'none', ENABLE_CAPTCHA: true }).captchaType(),
    'none',
  );
  // 形态容忍：大小写与空白都要能认
  assert.equal(await runtimeWith({ CAPTCHA_TYPE: ' IMAGE ' }).captchaType(), 'image');

  // 枚举值写坏时不能让验证静默消失，必须回落到旧布尔口径
  assert.equal(
    await runtimeWith({ CAPTCHA_TYPE: 'nope', ENABLE_CAPTCHA: true }).captchaType(),
    'math',
  );
});

test('runtimeSettings: externalCaptcha 用预设填默认值，管理员写过的项优先', async () => {
  const box = new SecretBox(BOX_SECRET);
  const turnstile = await runtimeWith({
    EXTERNAL_CAPTCHA_PRESET: 'turnstile',
    EXTERNAL_CAPTCHA_SITE_KEY: 'site-public',
    EXTERNAL_CAPTCHA_SECRET: box.encrypt('secret-private'),
  }).externalCaptcha();
  assert.equal(turnstile.preset, 'turnstile');
  assert.equal(turnstile.siteKey, 'site-public');
  // 库里是密文，读出来就得是能直接用的明文
  assert.equal(turnstile.secret, 'secret-private');
  assert.equal(
    turnstile.verifyUrl,
    'https://challenges.cloudflare.com/turnstile/v0/siteverify',
  );
  assert.equal(turnstile.scriptUrl, 'https://challenges.cloudflare.com/turnstile/v0/api.js');
  assert.equal(turnstile.globalName, 'turnstile');

  // 只改一项，其余仍跟预设；历史上没加密的明文也照旧能用
  const overridden = await runtimeWith({
    EXTERNAL_CAPTCHA_PRESET: 'hcaptcha',
    EXTERNAL_CAPTCHA_VERIFY_URL: 'https://relay.internal/siteverify',
    EXTERNAL_CAPTCHA_GLOBAL_NAME: 'mycaptcha',
    EXTERNAL_CAPTCHA_SECRET: 'plain-legacy-secret',
  }).externalCaptcha();
  assert.equal(overridden.verifyUrl, 'https://relay.internal/siteverify');
  assert.equal(overridden.scriptUrl, 'https://js.hcaptcha.com/1/api.js');
  assert.equal(overridden.globalName, 'mycaptcha');
  assert.equal(overridden.secret, 'plain-legacy-secret');

  // 空串是「没写」，不是「刻意清空成空端点」
  const blank = await runtimeWith({
    EXTERNAL_CAPTCHA_PRESET: 'recaptcha',
    EXTERNAL_CAPTCHA_SCRIPT_URL: '   ',
  }).externalCaptcha();
  assert.equal(blank.scriptUrl, 'https://www.google.com/recaptcha/api.js');
  assert.equal(blank.globalName, 'grecaptcha');

  // custom 预设没有默认地址，三项全靠管理员给（缺的项就是空串）
  const custom = await runtimeWith({ EXTERNAL_CAPTCHA_PRESET: 'custom' }).externalCaptcha();
  assert.equal(custom.verifyUrl, '');
  assert.equal(custom.scriptUrl, '');

  // 预设名写坏按 turnstile 处理，不要把三项都清空
  const broken = await runtimeWith({ EXTERNAL_CAPTCHA_PRESET: 'no-such' }).externalCaptcha();
  assert.equal(broken.preset, 'turnstile');
  assert.ok(broken.verifyUrl.startsWith('https://challenges.cloudflare.com/'));
});
