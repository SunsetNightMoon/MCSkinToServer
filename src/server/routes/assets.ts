import { raw, Router, type Request, type Response, type RequestHandler } from 'express';
import type { TokenService } from '../../auth/tokens.js';
import type { TextureService } from '../../textures/ingest.js';
import type {
  AssetRepository,
  AssetKind,
} from '../../repositories/assetRepository.js';
import type { AssetUrlResolver } from '../../storage/assetUrl.js';
import { requireAuth } from '../middleware.js';
import { AppError } from '../../errors.js';

/**
 * 素材上传/衣柜 HTTP 适配层（蓝图 P2）。
 * 上传用 raw PNG body（Content-Type: image/png），元数据走 query，
 * 不引入 multer；P4 前端用 fetch 直接 send(File) 即可。
 */

export interface AssetRouteDependencies {
  tokenService: TokenService;
  textures: TextureService;
  assets: AssetRepository;
  assetUrlResolver: AssetUrlResolver;
}

const KINDS: ReadonlySet<string> = new Set(['skin', 'cape']);
const MODELS: ReadonlySet<string> = new Set(['default', 'slim']);
const VISIBILITIES: ReadonlySet<string> = new Set(['private', 'public']);
const DOWNLOAD_POLICIES: ReadonlySet<string> = new Set(['owner_only', 'public']);

function requireKind(value: unknown): AssetKind {
  if (typeof value === 'string' && KINDS.has(value)) return value as AssetKind;
  throw new AppError('VALIDATION_ERROR', 'kind 必须为 skin 或 cape');
}

function requireSlot(value: unknown): AssetKind {
  return requireKind(value);
}

export function createAssetRouter(deps: AssetRouteDependencies): Router {
  const router = Router();
  const auth = requireAuth(deps.tokenService);
  const rawPng: RequestHandler = raw({ type: 'image/png', limit: '2mb' });

  // ---- 上传（sha256 去重在服务内完成）----
  router.post(
    '/api/assets',
    auth,
    rawPng,
    async (req: Request, res: Response) => {
      const kind = requireKind(req.query['kind']);
      const modelRaw = req.query['model'];
      const result = await deps.textures.ingest({
        ownerUserId: req.context!.userId,
        kind,
        // model 原样传给服务层：披风带 model 的校验（schema CHECK 同款）在 ingest 内
        modelType:
          typeof modelRaw === 'string' && MODELS.has(modelRaw)
            ? (modelRaw as 'default' | 'slim')
            : undefined,
        name: String(req.query['name'] ?? ''),
        description: req.query['description']
          ? String(req.query['description'])
          : undefined,
        license: req.query['license'] ? String(req.query['license']) : undefined,
        // 上传表单的「权限设置」：非法值交给服务层校验后报错，不静默吞掉
        visibility:
          req.query['visibility'] !== undefined
            ? (String(req.query['visibility']) as 'private' | 'public')
            : undefined,
        downloadPolicy:
          req.query['downloadPolicy'] !== undefined
            ? (String(req.query['downloadPolicy']) as 'owner_only' | 'public')
            : undefined,
        buffer: req.body as Buffer,
      });
      res.status(201).json({
        asset: {
          id: result.asset.id,
          kind: result.asset.kind,
          modelType: result.asset.modelType,
          name: result.asset.name,
          description: result.asset.description,
          reviewStatus: result.asset.reviewStatus,
          visibility: result.asset.visibility,
          createdAt: result.asset.createdAt,
        },
        blob: {
          sha256: result.blob.sha256,
          byteSize: result.blob.byteSize,
          width: result.blob.width,
          height: result.blob.height,
        },
        url: deps.assetUrlResolver.forBlob(result.blob),
        deduped: result.deduped,
      });
    },
  );

  // ---- 我的素材列表 ----
  router.get('/api/me/assets', auth, async (req: Request, res: Response) => {
    const kindRaw = req.query['kind'];
    const kind =
      typeof kindRaw === 'string' && KINDS.has(kindRaw)
        ? (kindRaw as AssetKind)
        : undefined;
    const list = await deps.assets.listByOwner(req.context!.userId, kind);
    res.json({ assets: list });
  });

  // ---- 应用到角色槽位（衣柜语义：同槽覆盖）----
  router.post('/api/assets/:id/apply', auth, async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    await deps.textures.applyToProfile({
      userId: req.context!.userId,
      assetId: String(req.params['id'] ?? ''),
      profileId: String(body['profileId'] ?? ''),
      slot: requireSlot(body['slot']),
    });
    res.status(204).end();
  });

  // ---- 摘下槽位 ----
  router.post('/api/assets/:id/remove', auth, async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    await deps.textures.removeFromProfile({
      userId: req.context!.userId,
      profileId: String(body['profileId'] ?? ''),
      slot: requireSlot(body['slot']),
    });
    res.status(204).end();
  });

  // ---- owner 修改素材元数据（可见性/下载策略等）----
  router.patch('/api/assets/:id', auth, async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    await deps.textures.updateOwnerFields(
      req.context!.userId,
      String(req.params['id'] ?? ''),
      {
        name: body['name'] as string | undefined,
        description: body['description'] as string | undefined,
        visibility: body['visibility'] as 'private' | 'public' | undefined,
        downloadPolicy: body['downloadPolicy'] as 'owner_only' | 'public' | undefined,
      },
    );
    res.status(204).end();
  });

  // ---- 删除素材（解绑 + 无引用时连带删 blob 与文件）----
  router.delete('/api/assets/:id', auth, async (req: Request, res: Response) => {
    await deps.textures.deleteAsset(
      req.context!.userId,
      String(req.params['id'] ?? ''),
    );
    res.status(204).end();
  });

  return router;
}
