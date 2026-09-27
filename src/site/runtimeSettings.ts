import type { SettingRepository } from '../repositories/settingRepository.js';
import type { SecretBox } from '../util/secretBox.js';
import { SecretBox as SecretBoxClass } from '../util/secretBox.js';

/**
 * 站点设置的**运行期**读取器（P5）。
 *
 * 与 SettingRepository 的分工：仓储只负责「键值怎么存怎么取」，
 * 本模块负责「这个键在当前业务里意味着什么」—— 布尔怎么解析、端口缺省多少、
 * 密码要不要解密。业务层（注册端点、邮件流程）依赖本模块，不直接碰键名字符串，
 * 这样键名改动只影响一处。
 *
 * ## 为什么一次性读全表
 *
 * 注册/登录请求往往要同时判定三个开关，逐个 get() 就是三次往返（Redis 场景跨网络）。
 * 这里用 getAll() 一次取回整张表，进程内缓存 30 秒 —— 与公开设置缓存同一量级，
 * 管理员保存后由调用方 refresh() 立即失效。
 *
 * ## 布尔解析为什么必须容错
 *
 * 同一个开关可能以三种形式出现在库里：AntD Switch 写入的 `true`（JSON 布尔）、
 * 旧前端写入的 `'true'`（字符串）、以及手工 SQL 写入的 `1`。改动前前端用
 * `data.X !== 'false'` 比较，布尔 `false` 与字符串 `'false'` 不相等，
 * 导致「关掉注册后重新加载仍显示开启」。这里的 toSettingBool 是唯一解析入口，
 * 前端也有一份同语义的实现（web/src/utils/settingBool.ts），两侧口径必须一致。
 */

const DEFAULT_TTL_MS = 30 * 1000;

/** 本模块消费的全部设置键 */
export const RuntimeSettingKeys = {
  allowRegistration: 'ALLOW_REGISTRATION',
  requireEmailVerification: 'REQUIRE_EMAIL_VERIFICATION',
  /** 旧布尔开关：只作为 `CAPTCHA_TYPE` 未设置时的兼容来源（true → math） */
  enableCaptcha: 'ENABLE_CAPTCHA',
  /** 人机验证类型：'none' | 'math' | 'image' | 'external' */
  captchaType: 'CAPTCHA_TYPE',
  /** 外部人机验证（不绑定厂商）：预设只是推荐值，四项均可改成自建/中转端点 */
  externalCaptchaPreset: 'EXTERNAL_CAPTCHA_PRESET',
  externalCaptchaSiteKey: 'EXTERNAL_CAPTCHA_SITE_KEY',
  externalCaptchaSecret: 'EXTERNAL_CAPTCHA_SECRET',
  externalCaptchaVerifyUrl: 'EXTERNAL_CAPTCHA_VERIFY_URL',
  externalCaptchaScriptUrl: 'EXTERNAL_CAPTCHA_SCRIPT_URL',
  /** 前端要调的 `window.<globalName>.render()`；三家形状兼容的服务各不同 */
  externalCaptchaGlobalName: 'EXTERNAL_CAPTCHA_GLOBAL_NAME',
  baseUrl: 'BASE_URL',
  siteTitle: 'SITE_TITLE',
  /** 站点徽标（顶栏/登录页/邮件抬头共用）；未设置 = 空串，而不是默认图 */
  siteLogo: 'SITE_LOGO',
  /**
   * 全站统一的用户名模式（P5 第十一批）：'single' | 'multi'。
   * 不再按用户各自设置 —— 由超级管理员在管理面板切换，影响全部账号。
   */
  profileMode: 'PROFILE_MODE',
  smtpHost: 'SMTP_HOST',
  smtpPort: 'SMTP_PORT',
  smtpSecure: 'SMTP_SECURE',
  smtpUser: 'SMTP_USER',
  smtpPass: 'SMTP_PASS',
  smtpFrom: 'SMTP_FROM',
  smtpFromName: 'SMTP_FROM_NAME',
  mailTemplateSubject: 'EMAIL_TEMPLATE_SUBJECT',
  mailTemplateHtml: 'EMAIL_TEMPLATE_HTML',
  /**
   * 页脚版权三项（管理端「版权设置」）。
   * 邮件正文的页脚必须与网页页脚读同一组键 —— 此前邮件里写死品牌名，
   * 管理员改了版权设置只有网页跟着变，收件人看到的还是旧落款。
   */
  copyrightText: 'COPYRIGHT_TEXT',
  copyrightBeian: 'COPYRIGHT_BEIAN',
  copyrightProject: 'COPYRIGHT_PROJECT',
} as const;

/** 缺省值：未设置时按这里的语义走，与前端表单初值保持一致 */
export const RUNTIME_SETTING_DEFAULTS = {
  /** 未设置 = 允许注册（新装站点开箱可用） */
  allowRegistration: true,
  /** 未设置 = 不要求邮箱验证（邮箱验证是新能力，默认不拦人） */
  requireEmailVerification: false,
  /** 未设置 = 不启用验证码（同上，默认不拦人） */
  enableCaptcha: false,
  /** 邮件落款用的站点名；未设置时用这个通用名 */
  siteTitle: 'Minecraft Skin Server',
  /**
   * 页脚的项目署名（`COPYRIGHT_PROJECT` 未设置时的缺省）。
   *
   * 必须与前端 `siteStore.SITE_DEFAULTS.copyrightProject` 同值：许可的附加条款要求
   * 对外提供服务时保留这条署名，网页有、邮件没有就是口径漏洞。
   */
  copyrightProject: 'Powered by MCSkinToServer',
} as const;

const TRUE_VALUES: ReadonlySet<string> = new Set(['true', '1', 'on', 'yes']);
const FALSE_VALUES: ReadonlySet<string> = new Set(['false', '0', 'off', 'no']);

/**
 * 人机验证的四种形态。
 *
 * - `none`     不做人机验证
 * - `math`     自托管算术题，题干明文下发（0004 起的老行为）
 * - `image`    自托管图片题，题干只出现在 PNG 里，脚本读不到明文
 * - `external` 外部人机验证服务（默认参数指向 Cloudflare Turnstile，四项均可改）
 */
export const CAPTCHA_TYPES = ['none', 'math', 'image', 'external'] as const;
export type CaptchaType = (typeof CAPTCHA_TYPES)[number];

function toCaptchaType(value: unknown): CaptchaType | null {
  const raw = toSettingString(value).trim().toLowerCase();
  return (CAPTCHA_TYPES as readonly string[]).includes(raw)
    ? (raw as CaptchaType)
    : null;
}

/**
 * 外部人机验证的内置预设。
 *
 * 刻意做成「预设 + 全部可改」而不是厂商绑定：管理员选预设只等于把下面三项填成
 * 推荐值，任何一项都能改成自建端点或国内可达的中转服务，`custom` 预设就是
 * 让三项完全由管理员给。
 *
 * 这一类服务的共同形状是：表单 POST 到 verifyUrl（secret + response，可选 sitekey
 * 与 remoteip），响应里带布尔 `success` —— Turnstile / hCaptcha / reCAPTCHA 都符合。
 *
 * 需要厂商签名的国内服务（腾讯天御、阿里云人机验证、网易易盾、GeeTest v4）**不在**
 * 这一类里：它们的校验要按各家算法签一次名，前端也要各自的 SDK 而不是
 * `window.<globalName>.render()`。接它们需要单独写适配器，这里刻意不预先塞
 * 无法验证的代码；扩展位是 `ExternalCaptchaConfig.preset`（自定义值）+
 * `src/account/externalCaptcha.ts` 的校验入口。
 */
export const EXTERNAL_CAPTCHA_PRESETS = {
  turnstile: {
    verifyUrl: 'https://challenges.cloudflare.com/turnstile/v0/siteverify',
    scriptUrl: 'https://challenges.cloudflare.com/turnstile/v0/api.js',
    globalName: 'turnstile',
  },
  hcaptcha: {
    verifyUrl: 'https://api.hcaptcha.com/siteverify',
    scriptUrl: 'https://js.hcaptcha.com/1/api.js',
    globalName: 'hcaptcha',
  },
  recaptcha: {
    verifyUrl: 'https://www.google.com/recaptcha/api/siteverify',
    scriptUrl: 'https://www.google.com/recaptcha/api.js',
    globalName: 'grecaptcha',
  },
} as const;

export type ExternalCaptchaPreset =
  | keyof typeof EXTERNAL_CAPTCHA_PRESETS
  | 'custom';

const PRESET_NAMES: ReadonlySet<string> = new Set([
  ...Object.keys(EXTERNAL_CAPTCHA_PRESETS),
  'custom',
]);

function toPreset(value: unknown): ExternalCaptchaPreset {
  const raw = toSettingString(value).trim().toLowerCase();
  return PRESET_NAMES.has(raw) ? (raw as ExternalCaptchaPreset) : 'turnstile';
}

/**
 * 把任意来源的开关值解析为布尔。
 * 无法识别时返回 fallback（而不是抛错）：设置项损坏不该让登录端点 500。
 */
export function toSettingBool(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const normalized = String(value).trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  return fallback;
}

/** 把任意来源的数值解析为整数（端口等） */
function toSettingInt(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value);
  const parsed = Number(String(value ?? '').trim());
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function toSettingString(value: unknown): string {
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value : String(value);
}

export interface SmtpSettings {
  host: string;
  port: number;
  /** true = 隐式 TLS（465）；false = 明文连接后 STARTTLS（587） */
  secure: boolean;
  user: string;
  /** 已解密的口令；未配置密文主密钥时即为库中原值 */
  pass: string;
  from: string;
  fromName: string;
}

export interface MailTemplateSetting {
  subject: string;
  html: string;
}

/** 外部人机验证的有效配置（预设 + 管理员覆盖合并后的结果） */
export interface ExternalCaptchaSettings {
  preset: ExternalCaptchaPreset;
  siteKey: string;
  /** 已解密的密钥；未配置主密钥时即为库中原值 */
  secret: string;
  verifyUrl: string;
  scriptUrl: string;
  /** 前端要调的全局对象名（turnstile / hcaptcha / grecaptcha / 自建实现自定义） */
  globalName: string;
}

export interface RuntimeSettingsDependencies {
  settings?: Pick<SettingRepository, 'getAll'>;
  /** 用于解密 SMTP_PASS；未注入时按明文处理（本地开发/测试） */
  secretBox?: SecretBox | null;
  ttlMs?: number;
  now?: () => number;
}

export class RuntimeSettings {
  private readonly settings?: Pick<SettingRepository, 'getAll'>;
  private readonly secretBox: SecretBox | null;
  private readonly ttlMs: number;
  private readonly now: () => number;

  private cache: Record<string, unknown> = {};
  private loadedAt = 0;

  constructor(deps: RuntimeSettingsDependencies = {}) {
    this.settings = deps.settings;
    this.secretBox = deps.secretBox ?? null;
    this.ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
    this.now = deps.now ?? (() => Date.now());
  }

  /** 取全量设置（带 TTL 缓存）；仓储读失败时沿用上一次的缓存值 */
  async values(): Promise<Record<string, unknown>> {
    if (this.ttlMs > 0 && this.loadedAt !== 0 && this.now() - this.loadedAt < this.ttlMs) {
      return this.cache;
    }
    return this.refresh();
  }

  /** 立即重读（管理端保存设置后调用） */
  async refresh(): Promise<Record<string, unknown>> {
    this.loadedAt = this.now();
    if (!this.settings) return this.cache;
    try {
      const loaded = await this.settings.getAll();
      // 拷贝一份再入缓存：仓储返回的对象归它自己所有，直接持有引用意味着
      // 对方（或测试替身）原地改动值会穿透到本缓存的「只读快照」语义，
      // 表现为「TTL 还没到，读到的却已经是新值」。
      this.cache = loaded ? { ...loaded } : {};
    } catch {
      // 站点设置不是权威数据源：读不到就沿用旧值，让注册/登录继续可用
    }
    return this.cache;
  }

  private async read(key: string): Promise<unknown> {
    return (await this.values())[key];
  }

  // ---- 三个注册相关开关 ----

  async allowRegistration(): Promise<boolean> {
    return toSettingBool(
      await this.read(RuntimeSettingKeys.allowRegistration),
      RUNTIME_SETTING_DEFAULTS.allowRegistration,
    );
  }

  async requireEmailVerification(): Promise<boolean> {
    return toSettingBool(
      await this.read(RuntimeSettingKeys.requireEmailVerification),
      RUNTIME_SETTING_DEFAULTS.requireEmailVerification,
    );
  }

  async enableCaptcha(): Promise<boolean> {
    return toSettingBool(
      await this.read(RuntimeSettingKeys.enableCaptcha),
      RUNTIME_SETTING_DEFAULTS.enableCaptcha,
    );
  }

  /**
   * 当前人机验证类型。
   *
   * 兼容口径：`CAPTCHA_TYPE` 未设置时（老站点只写过 `ENABLE_CAPTCHA` 布尔）按布尔推导
   * —— `true` → `math`、`false` → `none`。显式写了类型就以它为准，两边不会打架。
   * 这样升级不改变任何既有站点的行为：没碰过新枚举的站，验证码表现和 0004 一致。
   */
  async captchaType(): Promise<CaptchaType> {
    const explicit = toCaptchaType(
      await this.read(RuntimeSettingKeys.captchaType),
    );
    if (explicit) return explicit;
    return (await this.enableCaptcha()) ? 'math' : 'none';
  }

  /**
   * 外部人机验证的有效配置（预设值与管理员覆盖合并后的结果）。
   *
   * `secret` 与 `SMTP_PASS` 走同一套密文习惯：库里是密文，读出来即用。
   */
  async externalCaptcha(): Promise<ExternalCaptchaSettings> {
    const preset = toPreset(
      await this.read(RuntimeSettingKeys.externalCaptchaPreset),
    );
    const fromPreset = preset === 'custom' ? undefined : EXTERNAL_CAPTCHA_PRESETS[preset];
    const rawSecret = await this.read(RuntimeSettingKeys.externalCaptchaSecret);
    const secret = SecretBoxClass.isEncrypted(rawSecret)
      ? (this.secretBox?.decrypt(rawSecret as string) ?? '')
      : toSettingString(rawSecret).trim();

    // 管理员显式写过的项优先；空串视为「没写」而不是「刻意清空成空端点」
    const resolve = (
      explicitValue: unknown,
      fallback: string | undefined,
    ): string => {
      const explicit = toSettingString(explicitValue).trim();
      return explicit !== '' ? explicit : (fallback ?? '');
    };

    return {
      preset,
      siteKey: resolve(
        await this.read(RuntimeSettingKeys.externalCaptchaSiteKey),
        undefined,
      ),
      secret,
      verifyUrl: resolve(
        await this.read(RuntimeSettingKeys.externalCaptchaVerifyUrl),
        fromPreset?.verifyUrl,
      ),
      scriptUrl: resolve(
        await this.read(RuntimeSettingKeys.externalCaptchaScriptUrl),
        fromPreset?.scriptUrl,
      ),
      globalName:
        resolve(
          await this.read(RuntimeSettingKeys.externalCaptchaGlobalName),
          fromPreset?.globalName,
        ) || 'turnstile',
    };
  }

  /** 站点名（邮件标题与落款）；未配置时回落到通用名 */
  async siteTitle(): Promise<string> {
    const raw = toSettingString(await this.read(RuntimeSettingKeys.siteTitle)).trim();
    return raw !== '' ? raw : RUNTIME_SETTING_DEFAULTS.siteTitle;
  }

  /**
   * 站点徽标 URL（邮件抬头用）。
   *
   * 与 siteTitle 不同：未设置返回**空串**而不是默认值 ——
   * 「没有设徽标」的正确表现是邮件里不出现那张图，而不是塞一张占位图。
   */
  async siteLogoUrl(): Promise<string> {
    return toSettingString(await this.read(RuntimeSettingKeys.siteLogo)).trim();
  }

  /**
   * 页脚版权三项（网页页脚与管理端「版权设置」用的是同一组键）。
   *
   * `text` / `beian` 未设置就是空串，由渲染层决定回落什么；`project` 这里就回落
   * 缺省署名，因为「管理员没填」和「管理员填了空」在署名条款上不能区别对待。
   */
  async copyright(): Promise<{ text: string; beian: string; project: string }> {
    return {
      text: toSettingString(await this.read(RuntimeSettingKeys.copyrightText)).trim(),
      beian: toSettingString(await this.read(RuntimeSettingKeys.copyrightBeian)).trim(),
      project:
        toSettingString(await this.read(RuntimeSettingKeys.copyrightProject)).trim()
        || RUNTIME_SETTING_DEFAULTS.copyrightProject,
    };
  }

  // ---- 邮件 ----

  /** SMTP 配置；口令在此处解密，调用方拿到的一律是明文 */
  async smtp(): Promise<SmtpSettings> {
    const raw = await this.read(RuntimeSettingKeys.smtpPass);
    const pass = SecretBoxClass.isEncrypted(raw)
      ? (this.secretBox?.decrypt(raw as string) ?? '')
      : toSettingString(raw);
    return {
      host: toSettingString(await this.read(RuntimeSettingKeys.smtpHost)).trim(),
      port: toSettingInt(await this.read(RuntimeSettingKeys.smtpPort), 587),
      secure: toSettingBool(await this.read(RuntimeSettingKeys.smtpSecure), false),
      user: toSettingString(await this.read(RuntimeSettingKeys.smtpUser)).trim(),
      pass,
      from: toSettingString(await this.read(RuntimeSettingKeys.smtpFrom)).trim(),
      fromName: toSettingString(await this.read(RuntimeSettingKeys.smtpFromName)).trim(),
    };
  }

  /** 判断是否具备发信条件：有 host 且（无认证或已有口令） */
  async smtpConfigured(): Promise<boolean> {
    const smtp = await this.smtp();
    if (smtp.host === '') return false;
    return smtp.user === '' || smtp.pass !== '';
  }

  /** 管理员自定义邮件模板；未配置（主题或正文为空）时返回 null，由内置默认接管 */
  async mailTemplate(): Promise<MailTemplateSetting | null> {
    const subject = toSettingString(await this.read(RuntimeSettingKeys.mailTemplateSubject)).trim();
    const html = toSettingString(await this.read(RuntimeSettingKeys.mailTemplateHtml));
    if (subject === '' || html.trim() === '') return null;
    return { subject, html };
  }
}
