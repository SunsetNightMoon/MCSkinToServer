import { Router } from 'express';
import type { TokenService } from '../../auth/tokens.js';
import type { SettingRepository } from '../../repositories/settingRepository.js';
import type { RuntimeSettings } from '../../site/runtimeSettings.js';
import type { SiteUrlResolver } from '../../site/siteUrl.js';
import type { SecretBox } from '../../util/secretBox.js';
import { SecretBox as SecretBoxClass } from '../../util/secretBox.js';
import { requireAdmin, requireAuth } from '../middleware.js';
import { AppError } from '../../errors.js';

/**
 * 站点设置 HTTP 适配层（对应 system_settings 表，无需新迁移）。
 *
 * - GET /api/settings/public   站点外观与文案（匿名可读；前端 siteStore 拉取）
 * - GET /api/admin/settings    全部设置（管理员）
 * - PUT /api/admin/settings    保存，body 为扁平键值对象 {KEY: value}
 *
 * 键名沿用旧版 SCREAMING_SNAKE_CASE，使 /api/settings/public 的响应形状
 * 与旧站一致，前端不需要改协议。
 *
 * ## 敏感值只在 HTTP 边界处理
 *
 * `SMTP_PASS` 以密文入库（见 util/secretBox.ts），但加解密不该由仓储或业务层感知 ——
 * 仓储的职责是「原样存取」，让它知道哪个键敏感会把安全策略散进数据层。
 * 因此处理点收敛在本文件的两个边界：
 * - PUT：明文 → 密文（encryptIfNeeded，重复提交同一密文不会二次加密）
 * - GET：密文 → 空串 + `SMTP_PASS_SET` 标志
 * 第二条是刻意的：把密文回传给浏览器毫无用处（前端也解不开），
 * 只会让密文跟着日志、截图、前端状态到处跑。前端要的是「有没有设过」这个布尔。
 */

export interface SettingRouteDependencies {
  tokenService: TokenService;
  settings: SettingRepository;
  /** 主密钥；未注入时 SMTP_PASS 按明文处理（本地开发） */
  secretBox?: SecretBox | null;
  /** 保存后刷新运行期设置缓存（注册开关等立即生效） */
  runtimeSettings?: RuntimeSettings;
  /** 保存后刷新站点地址缓存（BASE_URL 改动立即生效） */
  siteUrlResolver?: SiteUrlResolver;
  /** 时钟可注入（测试） */
  now?: () => Date;
}

const MAX_KEY_LENGTH = 64;

/**
 * 入库前需要加密的键。
 *
 * `EXTERNAL_CAPTCHA_SECRET` 与 SMTP 口令同一待遇：它是本站去外部校验端点换 token
 * 的凭据，泄露等于别人可以冒充本站做校验（并可被拿去做滥用配额）。
 */
const ENCRYPTED_KEYS: ReadonlySet<string> = new Set([
  'SMTP_PASS',
  'EXTERNAL_CAPTCHA_SECRET',
]);

/**
 * 只读回传用的脱敏键：值一律替换为空串，另以 `<KEY>_SET` 布尔告知「是否已配置」。
 * 放在这里而不是让前端自己判断空串，是因为「空串」既可能是没设过、也可能是被清空，
 * 前端无法区分，会显示错误的提示文案。
 */
const SECRET_KEYS: readonly string[] = ['SMTP_PASS', 'EXTERNAL_CAPTCHA_SECRET'];

export function createSettingRouter(deps: SettingRouteDependencies): Router {
  const router = Router();
  const now = deps.now ?? ((): Date => new Date());

  router.get('/api/settings/public', async (_req, res) => {
    res.json(await deps.settings.getPublic());
  });

  // requireAuth 写 req.context，requireAdmin 做角色门槛 —— 两个都要挂
  const auth = requireAuth(deps.tokenService);
  const admin = requireAdmin;

  router.get('/api/admin/settings', auth, admin, async (_req, res) => {
    const all = await deps.settings.getAll();
    const out: Record<string, unknown> = { ...all };
    for (const key of SECRET_KEYS) {
      if (key in out) {
        out[`${key}_SET`] = String(all[key] ?? '') !== '';
        out[key] = '';
      }
    }
    res.json(out);
  });

  router.put('/api/admin/settings', auth, admin, async (req, res) => {
    const body = req.body as unknown;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new AppError('VALIDATION_ERROR', '请求体必须为键值对象');
    }
    const entries: Record<string, unknown> = { ...(body as Record<string, unknown>) };
    for (const key of Object.keys(entries)) {
      if (key.length === 0 || key.length > MAX_KEY_LENGTH) {
        throw new AppError(
          'VALIDATION_ERROR',
          `设置键名长度必须在 1-${MAX_KEY_LENGTH} 之间`,
        );
      }
    }

    // 脱敏字段被原样回传（空串）时不覆盖库里的真值 —— 否则管理员改个别的字段
    // 保存一次，SMTP 密码就被清空了，而且没有任何提示。
    for (const key of SECRET_KEYS) {
      const value = entries[key];
      if (value === undefined) continue;
      if (typeof value === 'string' && value === '') {
        delete entries[key];
        continue;
      }
      const box = deps.secretBox ?? SecretBoxClass.fromEnv();
      if (box) {
        entries[key] = box.encryptIfNeeded(String(value));
      }
      // 没有主密钥时按明文落库：退化行为，但至少功能可用（README 有说明）
    }

    await deps.settings.setMany(entries, now());

    // 设置值变了，两个缓存必须立刻失效，否则「保存成功但没生效」要等 30 秒 TTL，
    // 管理员只会以为功能坏了。并行刷新，互不依赖。
    await Promise.all([
      deps.runtimeSettings?.refresh(),
      deps.siteUrlResolver?.refresh(),
    ]);

    res.json({ ok: true, saved: Object.keys(entries).length });
  });

  return router;
}
