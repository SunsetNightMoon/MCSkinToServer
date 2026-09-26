import express, { type Express } from 'express';
import type { AppConfig } from '../config.js';
import type { DatabaseConnection } from '../types.js';
import type { TokenService } from '../auth/tokens.js';
import type { IdentityService } from '../auth/identity.js';
import type { StoragePort } from '../storage/types.js';
import type { AssetUrlResolver } from '../storage/assetUrl.js';
import type { RsaKeyPair } from '../yggdrasil/keys.js';
import type { TextureProfileBuilder } from '../yggdrasil/textures.js';
import type { MinecraftSessionRepository } from '../repositories/minecraftSessionRepository.js';
import type { ProfileRepository } from '../repositories/profileRepository.js';
import type { AssetRepository } from '../repositories/assetRepository.js';
import type { TextureService } from '../textures/ingest.js';
import type { LibraryService } from '../library/libraryService.js';
import { buildMetadataDto } from '../yggdrasil/metadata.js';
import { createYggdrasilRouter } from './routes/yggdrasil.js';
import { createIdentityRouter } from './routes/identity.js';
import { createAssetRouter } from './routes/assets.js';
import { createLibraryRouter } from './routes/library.js';
import { createAdminRouter } from './routes/admin.js';
import { requireAuth } from './middleware.js';
import { errorHandler } from './errorHandler.js';

/**
 * Express 应用工厂（蓝图 §2.1）：
 * HTTP 层只做输入解析、调用服务、错误转换；不写 SQL、不碰文件、不判资源所有权。
 * 依赖注入全部来自 main.ts 的装配，可测试。
 */

export interface AppDependencies {
  config: AppConfig;
  /** 健康检查 ready 探针用 */
  database: DatabaseConnection;
  storage: StoragePort;
  tokenService: TokenService;
  rsaKeyPair: RsaKeyPair;
  // ---- P1 身份链路 ----
  identity: IdentityService;
  profileRepository: ProfileRepository;
  assetRepository: AssetRepository;
  minecraftSessions: MinecraftSessionRepository;
  textureBuilder: TextureProfileBuilder;
  assetUrlResolver: AssetUrlResolver;
  // ---- P2 上传链路 ----
  textures: TextureService;
  // ---- P3 公开库/收藏/审核 ----
  library: LibraryService;
}

const EMPTY_BYTES = new Uint8Array(0);
const HEALTH_PROBE_KEY = '.health-probe';

export function createApp(deps: AppDependencies): Express {
  const { config, database, storage, tokenService, rsaKeyPair } = deps;
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));

  // ---- 健康检查（蓝图 §5.3）----
  app.get('/health/live', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.get('/health/ready', async (_req, res) => {
    const checks: Record<'database' | 'storage', 'ok' | 'fail'> = {
      database: 'fail',
      storage: 'fail',
    };
    try {
      await database.query('SELECT 1');
      checks.database = 'ok';
    } catch (err) {
      console.error('[health] database check failed:', err);
    }
    try {
      await storage.put(HEALTH_PROBE_KEY, EMPTY_BYTES, 'text/plain');
      await storage.delete(HEALTH_PROBE_KEY);
      checks.storage = 'ok';
    } catch (err) {
      console.error('[health] storage check failed:', err);
    }
    const ready = checks.database === 'ok' && checks.storage === 'ok';
    res
      .status(ready ? 200 : 503)
      .json({ status: ready ? 'ready' : 'unready', checks });
  });

  // ---- Yggdrasil 元数据（协议入口，P1 扩展端点本体）----
  app.get('/api/yggdrasil', (_req, res) => {
    res.json(
      buildMetadataDto({
        baseUrl: config.publicBaseUrl,
        publicKeyPem: rsaKeyPair.publicKeyPem,
        skinDomains: config.skinDomains,
      }),
    );
  });

  // ---- Yggdrasil 协议端点（P1：认证五端点 + 会话/纹理 + 批量角色查询）----
  app.use(
    createYggdrasilRouter({
      identity: deps.identity,
      sessions: deps.minecraftSessions,
      profiles: deps.profileRepository,
      textureBuilder: deps.textureBuilder,
      assetUrlResolver: deps.assetUrlResolver,
    }),
  );

  // ---- Web 身份端点（P1：注册/登录/登出 + 角色管理）----
  app.use(
    createIdentityRouter({ identity: deps.identity, tokenService }),
  );

  // ---- 素材上传/衣柜端点（P2）----
  app.use(
    createAssetRouter({
      tokenService,
      textures: deps.textures,
      assets: deps.assetRepository,
      assetUrlResolver: deps.assetUrlResolver,
    }),
  );

  // ---- 公开库 / 收藏端点（P3，匿名可读）----
  app.use(createLibraryRouter({ tokenService, library: deps.library }));

  // ---- 管理员审核端点（P3）----
  app.use(
    createAdminRouter({
      tokenService,
      library: deps.library,
      assets: deps.assetRepository,
    }),
  );

  // ---- 本地存储静态挂载（URL 由 StoragePort 统一生成）----
  app.use('/uploads', express.static(config.uploadDir, { maxAge: '7d' }));

  // ---- 认证探针：当前登录用户（P1 扩展为完整 /api/auth、/api/me）----
  const auth = requireAuth(tokenService);
  app.get('/api/me', auth, (req, res) => {
    const c = req.context!;
    res.json({
      userId: c.userId,
      role: c.role,
      tokenType: c.tokenType,
      profileId: c.profileId,
    });
  });

  app.use((_req, res) => {
    res.status(404).json({ error: 'NOT_FOUND', message: 'Not Found' });
  });
  app.use(errorHandler);
  return app;
}
