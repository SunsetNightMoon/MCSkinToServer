import { raw, Router } from 'express';
import type { TokenService } from '../../auth/tokens.js';
import type { LibraryService } from '../../library/libraryService.js';
import type { IdentityService } from '../../auth/identity.js';
import type { EmailFlow } from '../../account/emailFlow.js';
import type { MailService } from '../../mail/mailService.js';
import type { RuntimeSettings } from '../../site/runtimeSettings.js';
import type { SettingRepository } from '../../repositories/settingRepository.js';
import type { StatsRepository } from '../../repositories/statsRepository.js';
import { MAX_STATS_DAYS, MIN_STATS_DAYS } from '../../repositories/statsRepository.js';
import {
  MAX_THEME_IMAGE_BYTES,
  parseThemeImageType,
  type ThemeImageService,
} from '../../site/themeImage.js';
import { defaultSubject, builtinTemplateHtml } from '../../mail/templates.js';
import type {
  AssetRepository,
  AssetKind,
  ReviewStatus,
} from '../../repositories/assetRepository.js';
import { requireAdmin, requireAuth } from '../middleware.js';
import { AppError } from '../../errors.js';

/**
 * 管理员 HTTP 适配层（蓝图 P3/P4/P5）：
 * - GET   /api/admin/assets?kind=&status=&search=  全量素材（含私有/待审）
 * - GET   /api/admin/reviews?kind=     待审核列表
 * - GET   /api/admin/assets/:id/reviews  审核历史
 * - POST  /api/admin/assets/:id/review   审批（approved/rejected + reason）
 * - PATCH /api/admin/assets/:id          管理员警告 / AI 生成标记
 * - GET   /api/admin/users             用户列表（分页/搜索）
 * - PATCH /api/admin/users/:id         角色（仅 super_admin）/ 封禁 / 激活
 * - POST  /api/admin/users/:id/send-verification  代用户重发验证邮件
 * - PUT   /api/admin/users/:id/verify-email       手动放行/收回邮箱验证
 * - POST  /api/admin/test-smtp         测试 SMTP 连接
 * - GET   /api/admin/email-template    读取邮件模板（未配置时返回内置默认）
 * - PUT   /api/admin/email-template    保存邮件模板
 * - GET   /api/admin/stats             仪表盘概览（用户/皮肤/待审三个数）
 * - GET   /api/admin/stats/daily?days= 仪表盘趋势序列（按日，缺失补 0）
 * - POST  /api/admin/upload-theme-image?type=  上传主题背景图（raw 位图字节，成功即写设置键）
 * - DELETE /api/admin/theme-image/:type        移除主题背景图（清设置键 + 删文件）
 * 全部要求 admin 及以上（requireRole(1)）。
 *
 * 用户管理那三个端点（send-verification / verify-email）不是可有可无的补充：
 * 用户收不到邮件（进垃圾箱、企业邮箱拦截、SMTP 临时故障）是常态，
 * 没有手动放行的兜底，用户就会永久卡在「未验证」且没有任何自救路径。
 */

export interface AdminRouteDependencies {
  tokenService: TokenService;
  library: LibraryService;
  assets: AssetRepository;
  identity: IdentityService;
  /** 邮箱流程（用户管理页重发验证 / 手动放行）；未注入则相关端点返回 502 */
  emailFlow?: EmailFlow;
  /** 邮件服务（测试 SMTP 连接）；未注入则相关端点返回 502 */
  mailService?: MailService;
  /** 站点设置（读写邮件模板）；未注入则模板端点返回 502 */
  settings?: SettingRepository;
  /** 站点运行期设置（取站点名做默认主题、保存后刷新缓存） */
  runtimeSettings?: RuntimeSettings;
  /** 统计聚合（仪表盘）；未注入则两个 stats 端点返回 502 */
  stats?: StatsRepository;
  /** 主题背景图上传/移除；未注入则相关端点返回 501 */
  themeImages?: ThemeImageService;
}

const REVIEW_STATUSES: ReadonlySet<string> = new Set(['approved', 'rejected']);
/** 管理端列表的审核状态过滤（含 pending，管理员要看得到待审内容） */
const REVIEW_FILTERS: ReadonlySet<string> = new Set([
  'pending',
  'approved',
  'rejected',
]);

export function createAdminRouter(deps: AdminRouteDependencies): Router {
  const router = Router();
  // requireAuth 写入 req.context，requireAdmin 再做角色门槛 —— 两个都要挂
  const auth = requireAuth(deps.tokenService);
  const admin = requireAdmin;

  /** 统计仓储缺失时统一报「本实例未启用统计」，而不是抛 500 让人以为代码炸了 */
  const requireStats = (): StatsRepository => {
    if (!deps.stats) {
      throw new AppError('NOT_IMPLEMENTED', '本实例未启用统计聚合');
    }
    return deps.stats;
  };

  /** 主题图服务缺失时同理明确报「未启用」，而不是 500 */
  const requireThemeImages = (): ThemeImageService => {
    if (!deps.themeImages) {
      throw new AppError('NOT_IMPLEMENTED', '本实例未启用主题图上传');
    }
    return deps.themeImages;
  };

  /**
   * 主题图上传的 body 解析：只认位图 Content-Type。
   *
   * limit 与 `MAX_THEME_IMAGE_BYTES` 同值（这里是闸门，服务层那道是兜底）。
   * 类型不在白名单时 `raw()` **不解析**（`req.body` 为空）→ 服务层会以
   * 「上传内容为空」拒绝，路径上不会出现「解析器悄悄吞掉合法图片」。
   */
  const rawImage = raw({
    type: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
    limit: MAX_THEME_IMAGE_BYTES,
  });

  /**
   * 仪表盘概览：用户总数 / 皮肤总数 / 待审核。
   *
   * 三个数**必须在数据库里聚合**，不能像原先那样由前端拼三个接口：
   * 拼出来的「皮肤总数」取的是公开素材库的计数（只含 public + approved），
   * 「待审核」用 `items.length` 而那个接口不分页也不带总数 —— 数据一多就错。
   */
  router.get('/api/admin/stats', auth, admin, async (_req, res) => {
    res.json(await requireStats().overview());
  });

  /**
   * 仪表盘趋势：按日序列，六个数组与 `days` 等长（无活动的日子补 0）。
   *
   * `days` 非法或越界时**裁剪到 1..90**，不报 400 —— 它只是个展示参数，
   * 为一个手滑的查询串让整块图表报错不值得。
   */
  router.get('/api/admin/stats/daily', auth, admin, async (req, res) => {
    const raw = Number((req.query as Record<string, unknown>)['days'] ?? 7);
    const days = Number.isFinite(raw)
      ? Math.min(Math.max(Math.trunc(raw), MIN_STATS_DAYS), MAX_STATS_DAYS)
      : 7;
    res.json(await requireStats().daily(days));
  });

  /**
   * 全量素材列表（含 private / pending / rejected），供管理后台总览与编辑入口。
   * 与公开库的差别见 AssetRepository.listAllForAdmin。
   */
  router.get('/api/admin/assets', auth, admin, async (req, res) => {
    const q = req.query as Record<string, unknown>;
    const kind =
      typeof q['kind'] === 'string' && (q['kind'] === 'skin' || q['kind'] === 'cape')
        ? (q['kind'] as AssetKind)
        : undefined;
    const reviewStatus =
      typeof q['status'] === 'string' && REVIEW_FILTERS.has(q['status'])
        ? (q['status'] as ReviewStatus)
        : undefined;
    const page = Math.max(Number(q['page'] ?? 1) || 1, 1);
    const pageSize = Math.min(
      Math.max(Number(q['pageSize'] ?? 20) || 20, 1),
      100,
    );
    const search =
      typeof q['search'] === 'string' && q['search'].trim() !== ''
        ? q['search'].trim()
        : undefined;
    const result = await deps.assets.listAllForAdmin({
      kind,
      reviewStatus,
      search,
      page,
      pageSize,
    });
    // 直出 previewUrl：前端不再逐项调详情端点补图片地址（那会把浏览数刷高）
    res.json({
      ...result,
      items: await deps.library.withPreviewUrls(result.items),
      page,
      pageSize,
    });
  });

  router.get('/api/admin/reviews', auth, admin, async (req, res) => {
    const q = req.query as Record<string, unknown>;
    const kind =
      typeof q['kind'] === 'string' && (q['kind'] === 'skin' || q['kind'] === 'cape')
        ? (q['kind'] as AssetKind)
        : undefined;
    const items = await deps.assets.listPending(kind);
    res.json({ items: await deps.library.withPreviewUrls(items) });
  });

  router.get('/api/admin/assets/:id/reviews', auth, admin, async (req, res) => {
    const assetId = String(req.params['id'] ?? '');
    const asset = await deps.assets.findById(assetId);
    if (!asset) {
      throw new AppError('NOT_FOUND', '素材不存在');
    }
    res.json({ reviews: await deps.assets.listReviews(assetId) });
  });

  router.post('/api/admin/assets/:id/review', auth, admin, async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const status = String(body['status'] ?? '');
    if (!REVIEW_STATUSES.has(status)) {
      throw new AppError('VALIDATION_ERROR', 'status 必须为 approved 或 rejected');
    }
    const reason =
      typeof body['reason'] === 'string' && body['reason'].length > 0
        ? body['reason']
        : null;
    await deps.library.review(
      req.context!,
      String(req.params['id'] ?? ''),
      status as 'approved' | 'rejected',
      reason,
    );
    res.status(204).end();
  });

  router.patch('/api/admin/assets/:id', auth, admin, async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    await deps.library.moderate(
      req.context!,
      String(req.params['id'] ?? ''),
      {
        adminWarning:
          body['adminWarning'] === undefined
            ? undefined
            : body['adminWarning'] === null
              ? null
              : String(body['adminWarning']),
        aiGenerated:
          body['aiGenerated'] === undefined
            ? undefined
            : Boolean(body['aiGenerated']),
        // 管理员可直接编辑他人素材的元数据（不需归属校验，管理员身份即授权）
        name: body['name'] === undefined ? undefined : String(body['name']),
        description:
          body['description'] === undefined
            ? undefined
            : String(body['description']),
        license:
          body['license'] === undefined ? undefined : String(body['license']),
        visibility:
          body['visibility'] === undefined
            ? undefined
            : (String(body['visibility']) as 'private' | 'public'),
        downloadPolicy:
          body['downloadPolicy'] === undefined
            ? undefined
            : (String(body['downloadPolicy']) as 'owner_only' | 'public'),
      },
    );
    res.status(204).end();
  });

  // ---- 用户管理 ----

  router.get('/api/admin/users', auth, admin, async (req, res) => {
    const q = req.query as Record<string, unknown>;
    const page = Math.max(Number(q['page'] ?? 1) || 1, 1);
    const pageSize = Math.min(Math.max(Number(q['pageSize'] ?? 20) || 20, 1), 100);
    const search = typeof q['search'] === 'string' && q['search'].trim() !== '' ? q['search'].trim() : undefined;
    const result = await deps.identity.listUsersForAdmin({ page, pageSize, search });
    res.json({ ...result, page, pageSize });
  });

  router.patch('/api/admin/users/:id', auth, admin, async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const role = body['role'];
    if (role !== undefined && role !== 'user' && role !== 'admin' && role !== 'super_admin') {
      throw new AppError('VALIDATION_ERROR', 'role 必须为 user / admin / super_admin');
    }
    const isActive = body['isActive'] === undefined ? undefined : Boolean(body['isActive']);
    let ban: { permanent?: boolean; until?: string | null; reason?: string | null } | null | undefined;
    if (body['ban'] !== undefined) {
      if (body['ban'] === null) {
        ban = null; // 解封
      } else {
        const b = body['ban'] as Record<string, unknown>;
        ban = {
          permanent: b['permanent'] === true,
          until: typeof b['until'] === 'string' && b['until'] !== '' ? b['until'] : null,
          reason: typeof b['reason'] === 'string' && b['reason'] !== '' ? b['reason'] : null,
        };
      }
    }
    const user = await deps.identity.adminUpdateUser(
      { userId: req.context!.userId, role: req.context!.role },
      String(req.params['id'] ?? ''),
      {
        role: role as 'user' | 'admin' | 'super_admin' | undefined,
        isActive,
        ban,
      },
    );
    res.json({ user });
  });

  // ---- 邮箱验证（P5）----

  /** 邮箱流程缺失时统一报「本实例未启用邮件能力」，而不是抛 500 让人以为代码炸了 */
  const requireEmailFlow = (): EmailFlow => {
    if (!deps.emailFlow) {
      throw new AppError('SMTP_ERROR', '本实例未启用邮件发送能力（未配置 SMTP）');
    }
    return deps.emailFlow;
  };

  /** 代用户重发验证邮件（用户反馈收不到信时使用） */
  router.post(
    '/api/admin/users/:id/send-verification',
    auth,
    admin,
    async (req, res) => {
      const result = await requireEmailFlow().sendVerification(
        String(req.params['id'] ?? ''),
      );
      res.json({ ok: true, alreadyVerified: result.alreadyVerified });
    },
  );

  /**
   * 手动放行 / 收回邮箱验证。
   * 默认置为已验证；请求体传 `{ verified: false }` 可收回（排查误放行时用）。
   */
  router.put('/api/admin/users/:id/verify-email', auth, admin, async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const verified = body['verified'] === undefined ? true : Boolean(body['verified']);
    const result = await requireEmailFlow().adminSetEmailVerified(
      String(req.params['id'] ?? ''),
      verified,
    );
    res.json({ ok: true, ...result });
  });

  // ---- 邮件设置（P5）----

  /**
   * 测试 SMTP 连接。
   *
   * **失败也回 200 + `{ success: false }`**：这是台「诊断按钮」，不是业务写操作。
   * 用 4xx/5xx 表达「连不上」会让前端 fetch 层把消息压成通用报错，
   * 管理员就看不到「自签证书」「认证失败」这些真正有用的原因。
   */
  router.post('/api/admin/test-smtp', auth, admin, async (_req, res) => {
    if (!deps.mailService) {
      res.json({
        success: false,
        error: '本实例未启用邮件发送能力（未配置 SMTP）',
      });
      return;
    }
    try {
      await deps.mailService.verifyConnection();
      res.json({ success: true, message: 'SMTP 连接成功' });
    } catch (err) {
      res.json({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /** 读取邮件模板；管理员从未配置过时返回**带占位符的**内置默认，供其在上手点上修改 */
  router.get('/api/admin/email-template', auth, admin, async (_req, res) => {
    if (!deps.settings) {
      throw new AppError('SMTP_ERROR', '本实例未启用站点设置存储');
    }
    const siteTitle = deps.runtimeSettings
      ? await deps.runtimeSettings.siteTitle()
      : 'Minecraft Skin Server';
    const all = await deps.settings.getAll();
    const subject = String(all['EMAIL_TEMPLATE_SUBJECT'] ?? '').trim();
    const html = String(all['EMAIL_TEMPLATE_HTML'] ?? '');
    res.json({
      subject: subject !== '' ? subject : defaultSubject('verify', siteTitle),
      html: html.trim() !== '' ? html : builtinTemplateHtml('verify'),
      /** 便于前端提示「当前用的是内置模板」 */
      isDefault: subject === '' || html.trim() === '',
    });
  });

  /** 保存邮件模板（主题与正文都必填；要恢复内置模板请清空后重新保存） */
  router.put('/api/admin/email-template', auth, admin, async (req, res) => {
    if (!deps.settings) {
      throw new AppError('SMTP_ERROR', '本实例未启用站点设置存储');
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const subject = String(body['subject'] ?? '').trim();
    const html = String(body['html'] ?? '');
    if (subject === '') {
      throw new AppError('VALIDATION_ERROR', '邮件主题不能为空');
    }
    if (html.trim() === '') {
      throw new AppError('VALIDATION_ERROR', '邮件正文不能为空');
    }
    await deps.settings.setMany(
      { EMAIL_TEMPLATE_SUBJECT: subject, EMAIL_TEMPLATE_HTML: html },
      new Date(),
    );
    // 缓存里还留着旧模板，不刷新的话下一封信仍是旧的
    await deps.runtimeSettings?.refresh();
    res.json({ ok: true });
  });

  /**
   * 上传主题背景图（明亮/暗色/登录页/登录嵌入）。
   *
   * **收 raw 字节而不是 multipart**：与本项目素材上传同一约定 ——
   * 不引 multer，前端直接用 `fetch(url, { body: file })` 发原始字节。
   * 旧前端原先发的是 FormData（后端从来没有这个路由，所以也没人发现），
   * 现按约定改成原始字节。
   *
   * 上传成功即写入对应的设置键（`LIGHT_BG_IMAGE` 等），不必让管理员再点一次「保存」：
   * 按钮语义就是「换背景」，写了不算等于没换。
   */
  router.post(
    '/api/admin/upload-theme-image',
    auth,
    admin,
    rawImage,
    async (req, res) => {
      const type = parseThemeImageType((req.query as Record<string, unknown>)['type']);
      const result = await requireThemeImages().upload(
        type,
        req.body as Buffer,
        req.headers['content-type'],
      );
      res.status(201).json({ ok: true, url: result.url, type });
    },
  );

  /** 移除主题背景图：清空设置键 + 删文件（文件早就不在了也算成功） */
  router.delete('/api/admin/theme-image/:type', auth, admin, async (req, res) => {
    const type = parseThemeImageType(req.params['type']);
    const result = await requireThemeImages().remove(type);
    res.json({ ok: true, type, ...result });
  });

  return router;
}
