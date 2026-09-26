import { Router } from 'express';
import type { TokenService } from '../../auth/tokens.js';
import type { LibraryService } from '../../library/libraryService.js';
import type { IdentityService } from '../../auth/identity.js';
import type {
  AssetRepository,
  AssetKind,
  ReviewStatus,
} from '../../repositories/assetRepository.js';
import { requireAdmin, requireAuth } from '../middleware.js';
import { AppError } from '../../errors.js';

/**
 * 管理员 HTTP 适配层（蓝图 P3/P4）：
 * - GET   /api/admin/assets?kind=&status=&search=  全量素材（含私有/待审）
 * - GET   /api/admin/reviews?kind=     待审核列表
 * - GET   /api/admin/assets/:id/reviews  审核历史
 * - POST  /api/admin/assets/:id/review   审批（approved/rejected + reason）
 * - PATCH /api/admin/assets/:id          管理员警告 / AI 生成标记
 * - GET   /api/admin/users             用户列表（分页/搜索）
 * - PATCH /api/admin/users/:id         角色（仅 super_admin）/ 封禁 / 激活
 * 全部要求 admin 及以上（requireRole(1)）。
 */

export interface AdminRouteDependencies {
  tokenService: TokenService;
  library: LibraryService;
  assets: AssetRepository;
  identity: IdentityService;
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
    res.json({ ...result, page, pageSize });
  });

  router.get('/api/admin/reviews', auth, admin, async (req, res) => {
    const q = req.query as Record<string, unknown>;
    const kind =
      typeof q['kind'] === 'string' && (q['kind'] === 'skin' || q['kind'] === 'cape')
        ? (q['kind'] as AssetKind)
        : undefined;
    const items = await deps.assets.listPending(kind);
    res.json({ items });
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

  return router;
}
