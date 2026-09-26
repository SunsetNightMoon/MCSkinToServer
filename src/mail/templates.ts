import type { MailTemplateSetting } from '../site/runtimeSettings.js';

/**
 * 邮件正文模板与占位符替换。
 *
 * ## 占位符口径必须与前端一致
 *
 * 管理端的「验证邮件模板」编辑器（web/src/pages/Admin/SystemSettings.tsx）使用
 * `{{EMAIL}}` / `{{VERIFY_URL}}` / `{{YEAR}}` 三个占位符，并在界面上以提示文字
 * 告知管理员。这里必须支持同一组名字，否则管理员按提示写出来的模板会原样渲染出
 * 字面的 `{{VERIFY_URL}}` —— 一封点不动的验证邮件。
 *
 * 额外支持 `{{SITE_TITLE}}` 与 `{{RESET_URL}}`：
 * - `{{SITE_TITLE}}` 让内置模板与站点名一致，而不是写死一个品牌名
 * - `{{RESET_URL}}` 供重置密码邮件使用
 *
 * 宽容规则：重置密码邮件里如果出现了 `{{VERIFY_URL}}`（管理员直接复用验证模板），
 * 也填入重置链接。宁可给一个能用的链接，也不要寄出一封含字面占位符的死信。
 * 未知占位符原样保留 —— 便于管理员发现自己拼错了，而不是被静默吃掉。
 *
 * ## 内置模板以「占位符原文」形式保存
 *
 * 关键设计：内置正文存的是**未替换**的字符串常量，而不是「拼好变量的成品」。
 * 因为管理端的模板编辑器需要拿到带占位符的原文（拿渲染结果等于拿到一封
 * 已经填好某个邮箱、某个链接的样例邮件，管理员改完就废了）。
 * 渲染路径与自定义模板因此共用同一条 fillPlaceholders，不存在两套替换逻辑。
 */

export type MailKind = 'verify' | 'reset';

const BRAND_FALLBACK = 'Minecraft Skin Server';
const YEAR_PLACEHOLDER = '{{YEAR}}';

/** 全部支持的占位符，供管理端提示与测试断言引用 */
export const MAIL_PLACEHOLDERS = [
  'EMAIL',
  'VERIFY_URL',
  'RESET_URL',
  'SITE_TITLE',
  'YEAR',
] as const;

/** 替换 `{{NAME}}`（容忍花括号内空格）；未识别的占位符原样留下 */
export function fillPlaceholders(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(
    /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g,
    (match, key: string) => {
      const name = key.toUpperCase();
      return Object.prototype.hasOwnProperty.call(vars, name) ? vars[name]! : match;
    },
  );
}

const STYLE = `
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0d1117; color: #c9d1d9; margin: 0; padding: 20px; }
    .container { max-width: 480px; margin: 40px auto; background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 32px; }
    .header { text-align: center; margin-bottom: 24px; }
    .header h1 { margin: 0; font-size: 20px; color: #58a6ff; }
    .btn { display: inline-block; padding: 12px 28px; background: #238636; color: #fff; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 15px; }
    .btn:hover { background: #2ea043; }
    .footer { margin-top: 24px; font-size: 12px; color: #8b949e; text-align: center; }
    .code { background: #0d1117; border: 1px solid #30363d; border-radius: 6px; padding: 12px; font-family: monospace; font-size: 13px; word-break: break-all; color: #58a6ff; }`;

function shell(input: {
  emailTitle: string;
  heading: string;
  intro: string;
  buttonText: string;
  urlPlaceholder: string;
  validity: string;
  lang: string;
}): string {
  return `<!DOCTYPE html>
<html lang="${input.lang}">
<head>
  <meta charset="UTF-8" />
  <title>${input.emailTitle}</title>
  <style>${STYLE}
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>${input.heading}</h1>
    </div>
    <p>你好 {{EMAIL}}，</p>
    <p>${input.intro}</p>
    <p style="text-align:center; margin: 28px 0;">
      <a href="${input.urlPlaceholder}" class="btn">${input.buttonText}</a>
    </p>
    <p>或者，复制以下链接到浏览器地址栏：</p>
    <div class="code">${input.urlPlaceholder}</div>
    <p style="font-size:13px;color:#8b949e;margin-top:20px;">${input.validity}</p>
    <div class="footer">${BRAND_FALLBACK} &copy; ${YEAR_PLACEHOLDER}</div>
  </div>
</body>
</html>`;
}

/**
 * 内置验证邮件正文（含占位符原文）。
 * 措辞与前端 i18n 的 emailTemplate* 系列一致，使管理员无论是否自定义过，
 * 收到的邮件观感与编辑器里点「重置为默认」看到的完全相同。
 */
export const DEFAULT_VERIFY_TEMPLATE_HTML = shell({
  emailTitle: `邮箱验证 - {{SITE_TITLE}}`,
  heading: `🎮 {{SITE_TITLE}}`,
  intro: '我们收到了你的邮箱验证请求。请点击下面的按钮完成验证：',
  buttonText: '立即验证邮箱',
  urlPlaceholder: '{{VERIFY_URL}}',
  // 30 分钟必须与 emailFlow.VERIFICATION_TTL_MS 一致，否则邮件在骗用户
  validity: '此链接 30 分钟内有效。如果你没有请求验证，请忽略此邮件。',
  lang: 'zh-CN',
});

/** 内置重置密码邮件正文（含占位符原文） */
export const DEFAULT_RESET_TEMPLATE_HTML = shell({
  emailTitle: `重置密码 - {{SITE_TITLE}}`,
  heading: `🔒 {{SITE_TITLE}}`,
  intro: '我们收到了你的密码重置请求。请点击下面的按钮设置新密码：',
  buttonText: '重置密码',
  urlPlaceholder: '{{RESET_URL}}',
  // 1 小时必须与 emailFlow.RESET_TTL_MS 一致
  validity:
    '此链接 1 小时内有效。如果你没有请求重置密码，请忽略此邮件，你的密码不会改变。',
  lang: 'zh-CN',
});

/** 内置默认主题。与前端 `admin.defaultEmailSubject` 的措辞保持一致 */
export function defaultSubject(kind: MailKind, siteTitle: string): string {
  const brand = siteTitle.trim() !== '' ? siteTitle.trim() : BRAND_FALLBACK;
  return kind === 'verify' ? `【${brand}】请验证你的邮箱` : `【${brand}】重置密码`;
}

export function builtinTemplateHtml(kind: MailKind): string {
  return kind === 'verify'
    ? DEFAULT_VERIFY_TEMPLATE_HTML
    : DEFAULT_RESET_TEMPLATE_HTML;
}

export interface MailRenderVars {
  email: string;
  /** 本次邮件的动作链接（验证或重置） */
  url: string;
  siteTitle: string;
  /** 缺省取当前年份（UTC） */
  year?: string;
}

/** 组装完整占位符表；两种链接名都指向本次动作链接，理由见文件头「宽容规则」 */
function placeholderValues(vars: MailRenderVars): Record<string, string> {
  return {
    EMAIL: vars.email,
    VERIFY_URL: vars.url,
    RESET_URL: vars.url,
    SITE_TITLE: vars.siteTitle,
    YEAR: vars.year ?? String(new Date().getUTCFullYear()),
  };
}

/**
 * 渲染最终邮件。
 *
 * 自定义模板的判空（主题或正文为空即视为未配置）在 RuntimeSettings.mailTemplate
 * 里完成，这里只处理「有则用、无则内置」。
 */
export function renderMail(input: {
  kind: MailKind;
  custom: MailTemplateSetting | null;
  vars: MailRenderVars;
}): { subject: string; html: string } {
  const { kind, custom, vars } = input;
  const values = placeholderValues(vars);

  if (!custom) {
    return {
      subject: defaultSubject(kind, vars.siteTitle),
      html: fillPlaceholders(builtinTemplateHtml(kind), values),
    };
  }

  return {
    subject: fillPlaceholders(custom.subject, values),
    html: fillPlaceholders(custom.html, values),
  };
}
