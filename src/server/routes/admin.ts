import { Router } from 'express';
import type { LibraryService } from '../../library/libraryService.js';
import type {
  AssetRepository,
  AssetKind,
} from '../../repositories/assetRepository.js';
import { requireAdmin } from '../middleware.js';
import { AppError } from '../../errors.js';

/**
 * 管理员审核 HTTP 适配层（蓝图 P3）：
 * - GET   /api/admin/reviews?kind=     待审核列表
 * - GET   /api/admin/assets/:id/reviews  审核历史
 * - POST  /api/admin/assets/:id/review   审批（approved/rejected + reason）
 * - PATCH /api/admin/assets/:id          管理员警告 / AI 生成标记
 * 全部要求 admin 及以上（requireRole(1)）。
 */

export interface AdminRouteDependencies {
  library: LibraryService;
  assets: AssetRepository;
}

const REVIEW_STATUSES: ReadonlySet<string> = new Set(['approved', 'rejected']);

export function createAdminRouter(deps: AdminRouteDependencies): Router {
  const router = Router();
  const admin = requireAdmin();

  router.get('/api/admin/reviews', admin, async (req, res) => {
    const q = req.query as Record<string, unknown>;
    const kind =
      typeof q['kind'] === 'string' && (q['kind'] === 'skin' || q['kind'] === 'cape')
        ? (q['kind'] as AssetKind)
        : undefined;
    const items = await deps.assets.listPending(kind);
    res.json({ items });
  });

  router.get('/api/admin/assets/:id/reviews', admin, async (req, res) => {
    const assetId = String(req.params['id'] ?? '');
    const asset = await deps.assets.findById(assetId);
    if (!asset) {
      throw new AppError('NOT_FOUND', '素材不存在');
    }
    res.json({ reviews: await deps.assets.listReviews(assetId) });
  });

  router.post('/api/admin/assets/:id/review', admin, async (req, res) => {
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

  router.patch('/api/admin/assets/:id', admin, async (req, res) => {
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
      },
    );
    res.status(204).end();
  });

  return router;
}
