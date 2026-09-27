import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { MailService } from '../src/mail/mailService.js';
import type { MailMessage, MailPort } from '../src/mail/types.js';
import {
  MAIL_PLACEHOLDERS,
  builtinTemplateHtml,
  renderMail,
  type MailCopyrightVars,
  type MailKind,
} from '../src/mail/templates.js';
import {
  RUNTIME_SETTING_DEFAULTS,
  RuntimeSettings,
} from '../src/site/runtimeSettings.js';
import { PUBLIC_SETTING_KEYS } from '../src/repositories/settingRepository.js';

/**
 * 邮件落款必须跟随「版权设置」。
 *
 * 报上来的缺陷很具体：管理端改了自定义版权标识，网页页脚变了，寄出去的邮件落款
 * 还是写死的品牌名 —— 同一份品牌信息在两个地方各说各话。
 * 根因是邮件正文的 `<div class="footer">` 里嵌的是常量，而不是占位符。
 *
 * 所以这里守三件事：
 *  1. 六种内置正文的落款都是 `{{COPYRIGHT_FOOTER}}`（源码级：写死就红）
 *  2. 渲染出来的落款与网页页脚同构 —— 正文原文 + 备案号链到工信部查询页 + 项目署名
 *  3. 署名条款：`COPYRIGHT_PROJECT` 没填时回落 `Powered by MCSkinToServer`，
 *     邮件与网页的缺省值必须是同一个字面量
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAIL_KINDS: readonly MailKind[] = [
  'verify',
  'reset',
  'backup_verify',
  'change_verify',
  'change_authorize',
  'change_notice',
];
const BEIAN_URL = 'https://beian.miit.gov.cn/#/Integrated/recordQuery';

function fakeSettings(values: Record<string, unknown>) {
  return { getAll: async (): Promise<Record<string, unknown>> => values };
}

class RecordingMailer implements MailPort {
  readonly sent: MailMessage[] = [];
  async send(message: MailMessage): Promise<void> {
    this.sent.push(message);
  }
  async verify(): Promise<void> {}
  last(): MailMessage {
    const message = this.sent[this.sent.length - 1];
    assert.ok(message, '应当已发出一封邮件');
    return message;
  }
}

function vars(overrides: Partial<MailCopyrightVars> & { year?: string } = {}) {
  return {
    email: 'someone@example.test',
    url: 'https://skin.example.test/verify-email#token=abc',
    siteTitle: '猫旅之夜',
    copyright: {
      text: overrides.text ?? '© 2026 猫旅之夜',
      beian: overrides.beian ?? '',
      project: overrides.project ?? 'Powered by MCSkinToServer',
    },
    year: overrides.year ?? '2026',
  };
}

test('内置邮件：六种正文的落款都是版权占位符，没有写死的品牌落款', () => {
  for (const kind of MAIL_KINDS) {
    const template = builtinTemplateHtml(kind);
    assert.ok(
      template.includes('<div class="footer">{{COPYRIGHT_FOOTER}}</div>'),
      `${kind} 的落款没有用 {{COPYRIGHT_FOOTER}}，改版权设置它会不跟随`,
    );
    assert.ok(
      !/Minecraft Skin Server\s*&copy;/.test(template),
      `${kind} 的内置正文里残留写死的品牌落款`,
    );
  }
});

test('占位符表：版权三项与整行落款都对管理端开放', () => {
  for (const name of [
    'COPYRIGHT_TEXT',
    'COPYRIGHT_BEIAN',
    'COPYRIGHT_PROJECT',
    'COPYRIGHT_FOOTER',
  ] as const) {
    assert.ok(
      (MAIL_PLACEHOLDERS as readonly string[]).includes(name),
      `缺少 {{${name}}}`,
    );
  }
});

test('渲染：落款与网页页脚同构（正文原文 + 备案号链接 + 项目署名）', () => {
  const { html } = renderMail({
    kind: 'verify',
    custom: null,
    vars: vars({ text: '© 2026 猫旅之夜 · 保留所有权利', beian: '京ICP备2026000001号-1' }),
  });
  // 正文按原文插入：网页端就是 dangerouslySetInnerHTML，两边必须同一个口径
  assert.ok(html.includes('© 2026 猫旅之夜 · 保留所有权利'), html.slice(-600));
  assert.ok(html.includes(`href="${BEIAN_URL}"`), '备案号应链到工信部查询页');
  assert.ok(html.includes('京ICP备2026000001号-1</a>'), '备案号文字应在链接内');
  assert.ok(html.includes('Powered by MCSkinToServer'), '署名条款要求的落款必须在');
  // 写死的旧落款不该再出现在任何一封邮件里
  assert.ok(!html.includes('Minecraft Skin Server &copy;'));
});

test('渲染：未设置版权正文时回落品牌名 + 年份，署名依然保留', () => {
  const { html } = renderMail({
    kind: 'reset',
    custom: null,
    vars: vars({ text: '   ', beian: '' }),
  });
  assert.ok(html.includes('Minecraft Skin Server &copy; 2026'), html.slice(-600));
  assert.ok(html.includes('Powered by MCSkinToServer'));
  // 备案号为空 → 整段链接不出现，而不是留一个空锚点
  assert.ok(!html.includes(BEIAN_URL));
});

test('渲染：备案号与署名按纯文本转义，版权正文按原文保留', () => {
  const { html } = renderMail({
    kind: 'change_notice',
    custom: null,
    vars: vars({
      text: '© 2026 <b>猫旅之夜</b>',
      beian: '<script>alert(1)</script>',
      project: 'Powered by <x>MCSkinToServer',
    }),
  });
  assert.ok(html.includes('© 2026 <b>猫旅之夜</b>'), '正文与网页端同为原文插入');
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('Powered by &lt;x&gt;MCSkinToServer'));
});

test('渲染：管理员自定义模板里也能用整行落款与三个分项', () => {
  const { html } = renderMail({
    kind: 'verify',
    custom: { subject: '【猫旅之夜】验证', html: '<p>{{COPYRIGHT_TEXT}} | {{COPYRIGHT_BEIAN}} | {{COPYRIGHT_PROJECT}} | {{COPYRIGHT_FOOTER}}</p>' },
    vars: vars({ text: '© 2026 猫旅', beian: '京ICP备2026000002号-1', project: 'Powered by MCSkinToServer' }),
  });
  assert.ok(html.includes('<p>© 2026 猫旅 | 京ICP备2026000002号-1 | Powered by MCSkinToServer |'));
  assert.ok(html.includes(`href="${BEIAN_URL}"`));
  assert.ok(!html.includes('{{COPYRIGHT'));
});

test('MailService：把运行期版权设置喂给渲染层（设置改了下一封信就跟随）', async () => {
  const mailer = new RecordingMailer();
  const runtime = new RuntimeSettings({
    settings: fakeSettings({
      SITE_TITLE: '猫旅之夜',
      COPYRIGHT_TEXT: '© 2026 从设置来的落款',
      COPYRIGHT_BEIAN: '京ICP备2026000003号-1',
    }),
  });
  const service = new MailService({ mailer, runtime });
  await service.sendVerification({
    to: 'someone@example.test',
    url: 'https://skin.example.test/verify-email#token=abc',
  });
  const mail = mailer.last();
  assert.ok(mail.html.includes('© 2026 从设置来的落款'), mail.html.slice(-600));
  assert.ok(mail.html.includes('京ICP备2026000003号-1'));
  assert.ok(mail.html.includes(BEIAN_URL));
  // 未设置 COPYRIGHT_PROJECT 也要署名：缺省值由 RuntimeSettings 兜底
  assert.ok(mail.html.includes(RUNTIME_SETTING_DEFAULTS.copyrightProject));
});

test('RuntimeSettings.copyright：未设置时 text/beian 为空、project 回落署名', async () => {
  const empty = await new RuntimeSettings({ settings: fakeSettings({}) }).copyright();
  assert.deepEqual(empty, {
    text: '',
    beian: '',
    project: RUNTIME_SETTING_DEFAULTS.copyrightProject,
  });
  // 填了空串与没填不能区别对待：署名条款不允许「清空就不署名」
  const blank = await new RuntimeSettings({
    settings: fakeSettings({ COPYRIGHT_PROJECT: '   ' }),
  }).copyright();
  assert.equal(blank.project, RUNTIME_SETTING_DEFAULTS.copyrightProject);
  const filled = await new RuntimeSettings({
    settings: fakeSettings({
      COPYRIGHT_TEXT: '© 2026 猫旅之夜',
      COPYRIGHT_BEIAN: '京ICP备2026000004号-1',
      COPYRIGHT_PROJECT: 'Powered by MCSkinToServer / 附加说明',
    }),
  }).copyright();
  assert.equal(filled.text, '© 2026 猫旅之夜');
  assert.equal(filled.beian, '京ICP备2026000004号-1');
  assert.equal(filled.project, 'Powered by MCSkinToServer / 附加说明');
});

test('口径一致：邮件读的就是网页页脚那三个公开设置键', () => {
  // 网页页脚读 /api/settings/public（白名单 PUBLIC_SETTING_KEYS）。邮件若读别的键，
  // 「同步」就是空话 —— 这三项必须在白名单里，且名字与 RuntimeSettingKeys 同源。
  for (const key of ['COPYRIGHT_TEXT', 'COPYRIGHT_BEIAN', 'COPYRIGHT_PROJECT']) {
    assert.ok(PUBLIC_SETTING_KEYS.includes(key), `${key} 未对外公开，网页页脚拿不到`);
  }
});

test('口径一致：邮件缺省署名与前端 siteStore 的缺省值同字面量', async () => {
  const src = await readFile(join(REPO_ROOT, 'web', 'src', 'store', 'siteStore.ts'), 'utf8');
  const m = src.match(/copyrightProject:\s*'([^']*)'/);
  assert.ok(m, '前端 SITE_DEFAULTS.copyrightProject 找不到，缺省口径需重新对齐');
  assert.equal(m[1], RUNTIME_SETTING_DEFAULTS.copyrightProject);
});

test('回归：管理端「重置为默认」的正文不再写死品牌落款', async () => {
  const src = await readFile(
    join(REPO_ROOT, 'web', 'src', 'pages', 'Admin', 'SystemSettings.tsx'),
    'utf8',
  );
  assert.ok(
    !/class="footer">Minecraft Skin Server/.test(src),
    '重置为默认仍在前端写死落款，改版权设置后默认模板会再次脱钩',
  );
  // 前端造出来的默认正文必须与后端内置模板用同一个占位符，否则「重置为默认」
  // 保存一次就把邮件重新钉回一个不会跟随版权设置的落款
  assert.match(src, /const footerVar = '\{\{COPYRIGHT_FOOTER\}\}'/);
  assert.match(src, /<div class="footer">\$\{footerVar\}<\/div>/);
});
