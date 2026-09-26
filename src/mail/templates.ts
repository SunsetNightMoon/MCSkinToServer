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
 * 站点徽标（第八批 +）：
 * - `{{SITE_LOGO}}` 原样填入徽标 URL（未设置 = 空串），给会写 HTML 的管理员自己拼
 * - `{{SITE_LOGO_IMG}}` 填入**拼好的 `<img>` 标签**；未设置时填空串 ——
 *   内置模板的抬头用的是它。空串不会在邮件里留下破图，这正是「未设置徽标」的正确表现。
 *   之所以要一个「拼好的标签」占位符，是因为 fillPlaceholders 只做值替换、
 *   没有条件块语法，`<img src="{{SITE_LOGO}}">` 在徽标未设置时会渲染成一张破图。
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

export type MailKind =
  | 'verify'
  | 'reset'
  /** 0003：绑定备用邮箱（发给待绑定的备用邮箱） */
  | 'backup_verify'
  /** 0003：改邮箱 —— 新地址证明归属 */
  | 'change_verify'
  /** 0003：改邮箱 —— 另一个邮箱交叉授权 */
  | 'change_authorize'
  /** 0003：改邮箱 —— 通知被改掉的那个邮箱（不阻塞流程） */
  | 'change_notice';

const BRAND_FALLBACK = 'Minecraft Skin Server';
const YEAR_PLACEHOLDER = '{{YEAR}}';

/** 全部支持的占位符，供管理端提示与测试断言引用 */
export const MAIL_PLACEHOLDERS = [
  'EMAIL',
  'VERIFY_URL',
  'RESET_URL',
  /** 通用动作链接：与 VERIFY_URL / RESET_URL 同值（见 placeholderValues 的宽容规则） */
  'ACTION_URL',
  'OLD_EMAIL',
  'NEW_EMAIL',
  'SITE_TITLE',
  /** 站点徽标 URL 原文；未设置 = 空串 */
  'SITE_LOGO',
  /** 站点徽标的完整 <img> 标签；未设置 = 空串（内置模板抬头用它） */
  'SITE_LOGO_IMG',
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
      {{SITE_LOGO_IMG}}
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

// ---------------------------------------------------------------------------
// 0003：备用邮箱与邮箱变更（四类内置模板）
//
// 这四类**不走管理端自定义**，只用内置正文。理由：它们是低频的账号安全通知，
// 为每一个都加一套「主题 + 正文」编辑器会把管理页撑成一屏十几个模板，
// 而收益只是措辞可改。将来真需要时，套用现有的 EMAIL_TEMPLATE_* 键加一组即可。
// ---------------------------------------------------------------------------

/** 内置：验证待绑定的备用邮箱 */
export const DEFAULT_BACKUP_VERIFY_TEMPLATE_HTML = shell({
  emailTitle: `验证备用邮箱 - {{SITE_TITLE}}`,
  heading: `📮 {{SITE_TITLE}}`,
  intro:
    '我们收到了把它绑定为备用邮箱的请求。备用邮箱用于主邮箱失效时找回账号，请点击下面的按钮完成验证：',
  buttonText: '验证备用邮箱',
  urlPlaceholder: '{{ACTION_URL}}',
  // 30 分钟必须与 emailChangeFlow.BACKUP_VERIFY_TTL_MS 一致
  validity: '此链接 30 分钟内有效。如果你没有提出该请求，请忽略此邮件。',
  lang: 'zh-CN',
});

/** 内置：改邮箱 —— 请新地址证明归属 */
export const DEFAULT_CHANGE_VERIFY_TEMPLATE_HTML = shell({
  emailTitle: `确认新邮箱 - {{SITE_TITLE}}`,
  heading: `📧 {{SITE_TITLE}}`,
  intro:
    '你的账号正在申请把邮箱改为本地址。请点击下面的按钮证明这个邮箱属于你 —— 变更还需要另一个邮箱授权，两步都完成后才会生效：',
  buttonText: '确认这个新邮箱',
  urlPlaceholder: '{{ACTION_URL}}',
  // 1 小时必须与 emailChangeFlow.CHANGE_TTL_MS 一致
  validity: '此链接 1 小时内有效。如果你没有提出该请求，请忽略此邮件。',
  lang: 'zh-CN',
});

/** 内置：改邮箱 —— 请另一个邮箱交叉授权 */
export const DEFAULT_CHANGE_AUTHORIZE_TEMPLATE_HTML = shell({
  emailTitle: `授权邮箱变更 - {{SITE_TITLE}}`,
  heading: `🔑 {{SITE_TITLE}}`,
  intro:
    '有人申请把账号 {{EMAIL}} 的邮箱变更到新地址。为了防止账号被他人接管，这次变更需要你**授权**才会生效。请点击下面的按钮确认你同意：',
  buttonText: '授权这次变更',
  urlPlaceholder: '{{ACTION_URL}}',
  validity:
    '此链接 1 小时内有效。如果你没有提出该请求，请不要点击，并考虑尽快修改密码。',
  lang: 'zh-CN',
});

/**
 * 无按钮的正文外壳（用于纯通知类邮件）。
 *
 * 复用同一套 STYLE，但去掉 CTA 按钮与「复制链接」区块 —— 通知邮件里放一个链接
 * 反而会让收件人以为需要点它做点什么。
 */
function noticeShell(input: {
  emailTitle: string;
  heading: string;
  intro: string;
  body: string;
  lang: string;
}): string {
  return `<!DOCTYPE html>
<html lang="${input.lang}">
<head>
  <meta charset="UTF-8" />
  <title>${input.emailTitle}</title>
  <style>${STYLE}
    .change { background: #0d1117; border: 1px solid #30363d; border-radius: 6px; padding: 12px; font-family: monospace; font-size: 13px; word-break: break-all; color: #c9d1d9; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      {{SITE_LOGO_IMG}}
      <h1>${input.heading}</h1>
    </div>
    <p>你好，</p>
    <p>${input.intro}</p>
    <div class="change">${input.body}</div>
    <p style="font-size:13px;color:#8b949e;margin-top:20px;">
      这不是你需要执行的操作，只是变更完成后的知情通知。如果这不是你本人做的，请立即修改密码。
    </p>
    <div class="footer">${BRAND_FALLBACK} &copy; ${YEAR_PLACEHOLDER}</div>
  </div>
</body>
</html>`;
}

/** 内置：改邮箱 —— 通知被改掉的那个邮箱（仅知情，不需要操作） */
export const DEFAULT_CHANGE_NOTICE_TEMPLATE_HTML = noticeShell({
  emailTitle: `邮箱已变更 - {{SITE_TITLE}}`,
  heading: `✅ {{SITE_TITLE}}`,
  intro: '你的账号邮箱已经完成变更：',
  body: '{{OLD_EMAIL}}<br />↓<br />{{NEW_EMAIL}}',
  lang: 'zh-CN',
});

/** 内置默认主题。与前端 `admin.defaultEmailSubject` 的措辞保持一致 */
export function defaultSubject(kind: MailKind, siteTitle: string): string {
  const brand = siteTitle.trim() !== '' ? siteTitle.trim() : BRAND_FALLBACK;
  switch (kind) {
    case 'verify':
      return `【${brand}】请验证你的邮箱`;
    case 'reset':
      return `【${brand}】重置密码`;
    case 'backup_verify':
      return `【${brand}】请验证你的备用邮箱`;
    case 'change_verify':
      return `【${brand}】请确认新的邮箱地址`;
    case 'change_authorize':
      return `【${brand}】请授权邮箱变更`;
    case 'change_notice':
      return `【${brand}】邮箱已变更`;
  }
}

export function builtinTemplateHtml(kind: MailKind): string {
  switch (kind) {
    case 'verify':
      return DEFAULT_VERIFY_TEMPLATE_HTML;
    case 'reset':
      return DEFAULT_RESET_TEMPLATE_HTML;
    case 'backup_verify':
      return DEFAULT_BACKUP_VERIFY_TEMPLATE_HTML;
    case 'change_verify':
      return DEFAULT_CHANGE_VERIFY_TEMPLATE_HTML;
    case 'change_authorize':
      return DEFAULT_CHANGE_AUTHORIZE_TEMPLATE_HTML;
    case 'change_notice':
      return DEFAULT_CHANGE_NOTICE_TEMPLATE_HTML;
  }
}

/** 管理员可自定义正文与主题的邮件种类（管理端编辑器只暴露这些） */
export const CUSTOMIZABLE_MAIL_KINDS: ReadonlySet<MailKind> = new Set<MailKind>([
  'verify',
  'reset',
]);

export interface MailRenderVars {
  email: string;
  /** 本次邮件的动作链接（验证或重置）；纯通知类邮件传空串 */
  url: string;
  siteTitle: string;
  /** 站点徽标 URL；未设置 = 空串（此时 SITE_LOGO_IMG 也是空串） */
  siteLogo?: string;
  /** 邮箱变更通知用：被替换掉的旧地址 */
  oldEmail?: string;
  /** 邮箱变更通知用：生效的新地址 */
  newEmail?: string;
  /** 缺省取当前年份（UTC） */
  year?: string;
}

/**
 * 站点徽标的完整 `<img>` 标签；未设置返回空串。
 *
 * 内联样式而不是放 `<style>`：不少收件端（Gmail 会裁掉 `<style>` 之外的一部分，
 * 企业邮箱更激进）对 `<style>` 支持不完整，邮件里关键样式一律内联。
 * 固定高度、宽度自适应，透明背景 SVG/PNG 都能正常显示。
 */
function siteLogoImg(siteLogo: string | undefined, siteTitle: string): string {
  const url = (siteLogo ?? '').trim();
  if (url === '') return '';
  const alt = siteTitle.replace(/"/g, '&quot;');
  return (
    `<img src="${url}" alt="${alt}" ` +
    'style="height: 56px; max-width: 200px; object-fit: contain; vertical-align: middle; border: 0;" />'
  );
}

/** 组装完整占位符表；两种链接名都指向本次动作链接，理由见文件头「宽容规则」 */
function placeholderValues(vars: MailRenderVars): Record<string, string> {
  return {
    EMAIL: vars.email,
    // ACTION_URL 是给 0003 那几个内置模板用的中性名字；保留 VERIFY_URL / RESET_URL
    // 是因为管理员可能沿用了旧模板里的写法，静默失效不如照常填上。
    VERIFY_URL: vars.url,
    RESET_URL: vars.url,
    ACTION_URL: vars.url,
    OLD_EMAIL: vars.oldEmail ?? '',
    NEW_EMAIL: vars.newEmail ?? '',
    SITE_TITLE: vars.siteTitle,
    SITE_LOGO: (vars.siteLogo ?? '').trim(),
    SITE_LOGO_IMG: siteLogoImg(vars.siteLogo, vars.siteTitle),
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
