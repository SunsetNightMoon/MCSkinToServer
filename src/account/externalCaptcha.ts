import { AppError } from '../errors.js';
import type { ExternalCaptchaSettings } from '../site/runtimeSettings.js';

/**
 * 外部人机验证的校验客户端（Issue #3，不绑定厂商）。
 *
 * ## 只依赖一个共同形状
 *
 * Turnstile / hCaptcha / reCAPTCHA 的服务器端校验都是同一件事：表单 POST 到
 * verifyUrl，带 `secret` + `response`（前端拿到的 token），响应里一个布尔 `success`。
 * 本项目就按这一形状实现，因此换厂商、换自建中转都只是改配置。
 *
 * `sitekey` 与 `remoteip` 一并送出：hCaptcha 要求 sitekey，而 Cloudflare/reCAPTCHA
 * 会忽略未知字段 —— 多送比按厂商分支省事，也不会让任何一家校验失败。
 *
 * 需要厂商签名的服务（腾讯天御、阿里云人机验证、网易易盾、GeeTest v4）不符合这一
 * 形状，接它们要另写适配器；扩展位就是本类的 `verify`。
 *
 * ## 两条硬约束
 *
 * 1. **超时**：这是一次出站 HTTP，挂在注册/登录的请求路径上。不设上限就等于让
 *    上游抖动直接把本站登录打挂，所以默认 5 秒必须放弃。
 * 2. **失败不静默放行**：网络错、非 2xx、响应不是 JSON，一律 `CAPTCHA_UNAVAILABLE`
 *    （502），绝不回退成「当作验证通过」。开关开了就必须验，这一条与数学题的
 *    fail-closed 同一口径。
 *
 * ## SSRF 面
 *
 * `verifyUrl` 是管理员可配项，等于让服务器按管理员给的地址发一次请求。这里把协议
 * 锁死在 http/https（挡掉 `file:` / `gopher:` 之类），**刻意不拦内网地址** ——
 * 「指向自建/内网校验服务」正是这项能力存在的理由之一，能配到管理面板的人本就有
 * 这台机器的配置权。
 */

const DEFAULT_TIMEOUT_MS = 5000;

/** token 长度上限：正常几百字节，给一个宽松但有限的天花板，避免拿超大 body 打内存 */
const MAX_TOKEN_LENGTH = 4096;

/** 注入点：测试打本地桩，绝不在测试里出网 */
export type ExternalVerifyTransport = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

export interface ExternalCaptchaDeps {
  transport?: ExternalVerifyTransport;
  timeoutMs?: number;
}

/** 参数是否够发起一次校验；缺任何一项都属于「开关开了但没接上」 */
export function isExternalCaptchaReady(
  settings: ExternalCaptchaSettings,
): boolean {
  if (settings.siteKey === '' || settings.secret === '') return false;
  return /^https?:\/\/\S+$/i.test(settings.verifyUrl);
}

export class ExternalCaptchaService {
  private readonly transport: ExternalVerifyTransport;
  private readonly timeoutMs: number;

  constructor(deps: ExternalCaptchaDeps = {}) {
    this.transport = deps.transport ?? ((input, init) => fetch(input, init));
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * 校验一个前端 token。
   *
   * 通过就静默返回；不通过抛 `CAPTCHA_INVALID`（400，用户可以重试），
   * 上游不通抛 `CAPTCHA_UNAVAILABLE`（502，管理员要去看配置）。
   */
  async verify(
    settings: ExternalCaptchaSettings,
    token: unknown,
    remoteIp?: string,
  ): Promise<void> {
    if (!isExternalCaptchaReady(settings)) {
      throw new AppError(
        'CAPTCHA_UNAVAILABLE',
        '本站已启用外部人机验证，但校验端点或密钥未配置，请联系管理员',
      );
    }

    const value = typeof token === 'string' ? token.trim() : '';
    if (value === '' || value.length > MAX_TOKEN_LENGTH) {
      throw new AppError('CAPTCHA_INVALID', '请先完成人机验证');
    }

    const form = new URLSearchParams({
      secret: settings.secret,
      response: value,
      sitekey: settings.siteKey,
    });
    if (remoteIp) form.set('remoteip', remoteIp);

    let response: Response;
    try {
      response = await this.transport(settings.verifyUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      console.error(
        '[captcha] 外部人机验证请求失败:',
        err instanceof Error ? err.message : err,
      );
      throw new AppError(
        'CAPTCHA_UNAVAILABLE',
        '人机验证服务暂时不可用，请稍后重试',
      );
    }

    if (!response.ok) {
      console.error('[captcha] 外部人机验证端点返回非 2xx:', response.status);
      throw new AppError(
        'CAPTCHA_UNAVAILABLE',
        '人机验证服务暂时不可用，请稍后重试',
      );
    }

    let verdict: unknown;
    try {
      verdict = await response.json();
    } catch {
      console.error('[captcha] 外部人机验证响应不是 JSON');
      throw new AppError(
        'CAPTCHA_UNAVAILABLE',
        '人机验证服务暂时不可用，请稍后重试',
      );
    }

    const success =
      typeof verdict === 'object' &&
      verdict !== null &&
      (verdict as { success?: unknown }).success === true;

    if (!success) {
      throw new AppError('CAPTCHA_INVALID', '人机验证未通过，请重试');
    }
  }
}
