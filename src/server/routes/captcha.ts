import { Router, type Response } from 'express';
import type { CaptchaService } from '../../account/captcha.js';
import type { CaptchaType, RuntimeSettings } from '../../site/runtimeSettings.js';
import type { RateLimiterPort } from '../../cache/types.js';
import type { RateLimitSettings } from '../../config.js';
import { DEFAULT_CAPTCHA_GENERATE_RATE_LIMIT } from '../../config.js';
import { clientIp, rateLimit } from '../rateLimit.js';
import { RateLimitKeys } from '../../cache/keys.js';

/**
 * 人机验证的 HTTP 适配层（0004 数学题，Issue #3 图片题与外部验证）。
 *
 * - GET /api/captcha/captcha-type  当前类型：`{ type: 'none'|'math'|'image'|'external', ... }`
 * - GET /api/captcha/generate      出数学题：`{ question, sessionId, expiresInSeconds }`
 * - GET /api/captcha/image         出图片题：直接回 PNG（题干与答案都不出服务端）
 *
 * ## 为什么形状是这几个端点
 *
 * 前端（`web/src/pages/Auth/Login.tsx` / `Register.tsx`）在挂载时就调 `captcha-type`，
 * 拿到类型后决定渲染哪种控件；`math` 时再调 `generate?sessionId=…` 取题、
 * `image` 时把 `image?sessionId=…` 塞进 `<img>`，提交表单时回传
 * `captcha_session_id` + `captcha_answer`（external 则回传 `captcha_token`）。
 * **沿用旧版界面是硬约束**，所以这里适配前端，而不是改前端来适配这里。
 *
 * ## 三种模式的取舍
 *
 * - `math` / `image` 都是自托管，不出网、不把访客 IP 交给任何第三方。区别是
 *   数学题把题干明文下发（脚本算一下就能过），图片题只回 PNG。
 * - `external` 走外部服务（默认参数指向 Cloudflare Turnstile，端点/脚本地址/全局名
 *   四项均可改成自建中转或其它厂商）。这条路径会把访客 IP 交给校验端点，
 *   所以是**管理员显式选择**才启用，仓库不预设任何厂商绑定。
 *   `type` 响应里带 `siteKey` / `scriptUrl` / `globalName`，前端据此加载脚本。
 *
 * ## 未开启时的行为
 *
 * 类型为 `none` 时 `captcha-type` 返回 `'none'`，前端整块验证码 UI 不渲染；
 * `generate` / `image` 仍然可用（幂等无害），便于管理员在开启前先自测样式。
 */
export interface CaptchaRouteDependencies {
  captcha?: CaptchaService;
  /** 站点运行期设置；未注入时按「不开启验证码」处理 */
  runtimeSettings?: RuntimeSettings;
  rateLimiter?: RateLimiterPort;
  /**
   * 出题端点专用限流参数；缺省用 DEFAULT_CAPTCHA_GENERATE_RATE_LIMIT（10 次/5 分钟）。
   *
   * 刻意**不复用认证端点那套 5 次/5 分钟**：实测正常用户几步就能打满，
   * 而打满后题干空白且无提示，直接堵死注册（详见 config.ts 中的取值说明）。
   */
  generateRateLimit?: RateLimitSettings;
}

export function createCaptchaRouter(deps: CaptchaRouteDependencies): Router {
  const router = Router();

  /**
   * 出题端点按**来源地址**限流。
   *
   * 这是整个数学题方案里收紧「批量预生成答案」的地方：题目本身没有难度，
   * 所以必须限制**出题速率**，否则攻击者可以一次性领走大量题目、把答案存下来慢慢用。
   * 但真正的批量闸门在别处 —— 注册/登录端点各自按 IP 限流，且每个账号还需要
   * 配一个自己算对的答案。所以这里只求「压掉脚本狂刷」，不求卡住真人：
   * 真人进入页面取一题、答错换一道、严格模式下挂载重复一次，都应当畅通。
   */
  const generateSettings = deps.generateRateLimit ?? DEFAULT_CAPTCHA_GENERATE_RATE_LIMIT;
  const generateLimit: ReturnType<typeof rateLimit>[] =
    deps.rateLimiter && generateSettings.enabled
      ? [
          rateLimit({
            limiter: deps.rateLimiter,
            settings: generateSettings,
            keyOf: (req) => RateLimitKeys.captchaGenerate(clientIp(req)),
            message: (seconds) => `验证码请求过于频繁，请在 ${seconds} 秒后重试`,
          }),
        ]
      : [];

  /**
   * 类型答案的来源。刻意**每次请求都问一遍**（RuntimeSettings 自己有 30s 缓存），
   * 这样管理员在后台改类型后无需重启即可生效。
   */
  const currentType = async (): Promise<CaptchaType> =>
    deps.runtimeSettings ? deps.runtimeSettings.captchaType() : 'none';

  /** 未注入验证码服务属于部署问题，不能静默给空题（前端会渲染成一片空白） */
  const serviceUnavailable = (res: Response): void => {
    res.status(503).json({
      error: 'CAPTCHA_UNAVAILABLE',
      errorMessage: '人机验证服务未启用',
      message: '人机验证服务未启用',
    });
  };

  router.get('/api/captcha/captcha-type', async (_req, res) => {
    // 开关状态随时可能被管理员改动，不能让中间层缓存住旧的 'none'
    res.setHeader('Cache-Control', 'no-store');
    const type = await currentType();
    if (type !== 'external' || !deps.runtimeSettings) {
      res.json({ type });
      return;
    }
    // 外部模式要告诉前端加载哪个脚本、调哪个全局对象、用哪个 siteKey；
    // secret 永远不下发（它只在服务端校验时用）
    const external = await deps.runtimeSettings.externalCaptcha();
    res.json({
      type,
      siteKey: external.siteKey,
      scriptUrl: external.scriptUrl,
      globalName: external.globalName,
    });
  });

  router.get('/api/captcha/generate', ...generateLimit, async (req, res) => {
    if (!deps.captcha) {
      serviceUnavailable(res);
      return;
    }
    const sessionId = req.query['sessionId'];
    const question = await deps.captcha.generate(
      Array.isArray(sessionId) ? sessionId[0] : sessionId,
    );
    res.setHeader('Cache-Control', 'no-store');
    res.json(question);
  });

  /**
   * 图片题：响应就是 PNG 本身，题干与答案都不出现在任何 JSON 里。
   *
   * 与 `generate` 共用出题限流 —— 两者烧的是同一张 `captcha_challenges` 表，
   * 分开限流反而给了「一条路打满就换另一条」的口子。
   */
  router.get('/api/captcha/image', ...generateLimit, async (req, res) => {
    if (!deps.captcha) {
      serviceUnavailable(res);
      return;
    }
    const sessionId = req.query['sessionId'];
    const { png } = await deps.captcha.generateImage(
      Array.isArray(sessionId) ? sessionId[0] : sessionId,
    );
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'image/png');
    res.send(Buffer.from(png));
  });

  return router;
}
