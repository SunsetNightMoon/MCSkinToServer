import { Router } from 'express';
import type { TokenService, RequestContext } from '../../auth/tokens.js';
import type { LibraryService } from '../../library/libraryService.js';
import type { AssetKind } from '../../repositories/assetRepository.js';
import { optionalAuth, requireAuth } from '../middleware.js';

/**
 * 公开库 + 收藏 HTTP 适配层（蓝图 P3）。
 * 库/详情/计数/下载匿名可访问（optionalAuth 提取身份供权限矩阵）；
 * 收藏写操作与我的收藏需要登录。
 */

export interface LibraryRouteDependencies {
  tokenService: TokenService;
  library: LibraryService;
}

const KINDS: ReadonlySet<string> = new Set(['skin', 'cape']);
const SORTS: ReadonlySet<string> = new Set(['latest', 'views', 'downloads']);

function parseKind(value: unknown, fallback: AssetKind = 'skin'): AssetKind {
  return typeof value === 'string' && KINDS.has(value)
    ? (value as AssetKind)
    : fallback;
}

function parsePagination(query: Record<string, unknown>): {
  page: number;
  pageSize: number;
} {
  const page = Math.max(1, Number(query['page'] ?? 1) || 1);
  const pageSize = Math.min(
    50,
    Math.max(1, Number(query['pageSize'] ?? 20) || 20),
  );
  return { page, pageSize };
}

function viewerOf(req: { context?: RequestContext }): RequestContext | null {
  return req.context ?? null;
}

export function createLibraryRouter(deps: LibraryRouteDependencies): Router {
  const router = Router();
  const maybeAuth = optionalAuth(deps.tokenService);
  const auth = requireAuth(deps.tokenService);

  // ---- 公开库（匿名可访问）----

  router.get('/api/library', maybeAuth, async (req, res) => {
    const q = req.query as Record<string, unknown>;
    const result = await deps.library.listLibrary({
      kind: parseKind(q['kind']),
      page: parsePagination(q).page,
      pageSize: parsePagination(q).pageSize,
      sort:
        typeof q['sort'] === 'string' && SORTS.has(q['sort'])
          ? (q['sort'] as 'latest' | 'views' | 'downloads')
          : 'latest',
    });
    res.json(result);
  });

  router.get('/api/library/:id', maybeAuth, async (req, res) => {
    res.json(
      await deps.library.getDetail(
        String(req.params['id'] ?? ''),
        viewerOf(req),
      ),
    );
  });

  // ---- 统一素材详情（权限矩阵）----

  router.get('/api/assets/:id', maybeAuth, async (req, res) => {
    res.json(
      await deps.library.getDetail(
        String(req.params['id'] ?? ''),
        viewerOf(req),
      ),
    );
  });

  // ---- 下载（download_policy 权限矩阵，计数 +1）----

  router.get('/api/assets/:id/download', maybeAuth, async (req, res) => {
    const url = await deps.library.download(
      String(req.params['id'] ?? ''),
      viewerOf(req),
    );
    res.json({ url });
  });

  // ---- 收藏 ----

  router.get('/api/assets/:id/favorite-count', async (req, res) => {
    const count = await deps.library.getFavoriteCount(
      String(req.params['id'] ?? ''),
    );
    res.json({ count });
  });

  router.get(
    '/api/assets/:id/is-favorited',
    auth,
    async (req, res) => {
      const favorited = await deps.library.isFavorited(
        req.context!,
        String(req.params['id'] ?? ''),
      );
      res.json({ favorited });
    },
  );

  router.post('/api/assets/:id/favorite', auth, async (req, res) => {
    await deps.library.favorite(req.context!, String(req.params['id'] ?? ''));
    res.status(204).end();
  });

  router.delete('/api/assets/:id/favorite', auth, async (req, res) => {
    await deps.library.unfavorite(req.context!, String(req.params['id'] ?? ''));
    res.status(204).end();
  });

  router.get('/api/me/favorites', auth, async (req, res) => {
    const q = req.query as Record<string, unknown>;
    const kind =
      typeof q['kind'] === 'string' && KINDS.has(q['kind'])
        ? (q['kind'] as AssetKind)
        : undefined;
    res.json({ favorites: await deps.library.listMyFavorites(req.context!.userId, kind) });
  });

  return router;
}
