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
import type { SettingRepository } from '../repositories/settingRepository.js';
import type { EmailFlow } from '../account/emailFlow.js';
import type { EmailChangeFlow } from '../account/emailChangeFlow.js';
import type { OAuthProvider } from '../account/oauth/types.js';
import type { MailService } from '../mail/mailService.js';
import type { RuntimeSettings } from '../site/runtimeSettings.js';
import type { SiteUrlResolver } from '../site/siteUrl.js';
import type { SecretBox } from '../util/secretBox.js';
import type { RateLimiterPort, CachePort } from '../cache/types.js';
import type { RateLimitSettings } from '../config.js';
import { buildMetadataDto } from '../yggdrasil/metadata.js';
import { createYggdrasilRouter } from './routes/yggdrasil.js';
import { createIdentityRouter } from './routes/identity.js';
import { createAccountRouter } from './routes/account.js';
import { createEmailChangeRouter } from './routes/emailChange.js';
import { createOAuthRouter } from './routes/oauth.js';
import { createCaptchaRouter } from './routes/captcha.js';
import { createAssetRouter } from './routes/assets.js';
import { createLibraryRouter } from './routes/library.js';
import { createAdminRouter } from './routes/admin.js';
import { createSettingRouter } from './routes/settings.js';
import { requireAuth } from './middleware.js';
import { errorHandler } from './errorHandler.js';
import type { CaptchaService } from '../account/captcha.js';

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
  /** 站点设置（可选：测试未注入时公开端点返回空对象、管理端点不挂载） */
  settings?: SettingRepository;
  // ---- P5 可选依赖（未注入 = 关闭该能力，核心功能不受影响）----
  /** 认证端点限流器；未注入则不做限流 */
  rateLimiter?: RateLimiterPort;
  /** 限流参数；缺省用 DEFAULT_RATE_LIMIT */
  rateLimitSettings?: RateLimitSettings;
  /** `POST /refresh` 专用限流参数（按 IP）；缺省用 DEFAULT_REFRESH_RATE_LIMIT */
  refreshRateLimitSettings?: RateLimitSettings;
  /**
   * 验证码出题端点专用限流参数（按 IP）；缺省用 DEFAULT_CAPTCHA_GENERATE_RATE_LIMIT。
   *
   * 与 `rateLimitSettings` 分开：认证端点是 5 次/5 分钟，出题端点复用它会被
   * 正常用户几步打满，打满后题干空白、注册被堵死（见 config.ts 的取值说明）。
   */
  captchaGenerateRateLimitSettings?: RateLimitSettings;
  /** 通用缓存；未注入时设置读取直连数据库 */
  cache?: CachePort;
  /** 站点设置缓存 TTL（毫秒）；缺省 30s */
  settingsCacheTtlMs?: number;
  // ---- P5 站点地址 / 开关 / 邮件（全部可选：未注入 = 该能力不启用）----
  /**
   * 站点地址解析（BASE_URL 站点根 + PUBLIC_BASE_URL 素材前缀）。
   * 未注入时元数据与素材 URL 回落 config.publicBaseUrl 的旧行为。
   */
  siteUrlResolver?: SiteUrlResolver;
  /** 注册开关 / 邮箱验证开关 / SMTP 配置的读取器 */
  runtimeSettings?: RuntimeSettings;
  /** 邮箱验证与密码重置流程；未注入则账号辅助端点不挂载 */
  emailFlow?: EmailFlow;
  /** 邮件服务（管理端测试 SMTP 连接） */
  mailService?: MailService;
  /** 0003：备用邮箱与邮箱变更流程；未注入则相关端点不挂载 */
  emailChangeFlow?: EmailChangeFlow;
  /**
   * 0004：人机验证服务（自托管数学题）。
   * 未注入时 `/api/captcha/generate` 返回 503（明确报部署问题），
   * 而 `/api/captcha/captcha-type` 仍可用 —— 开关关着时它返回 `'none'`。
   */
  captcha?: CaptchaService;
  /**
   * 批4-F：第三方登录 provider 列表来源。
   * 未注入时读模块级注册表（宿主在自己的启动脚本里 `registerOAuthProvider`）。
   * 默认无 provider → 前端第三方登录小格子不渲染。
   */
  oauthProviders?: () => OAuthProvider[];
  /** 敏感设置加解密（SMTP_PASS）；缺省从 MSCTS_SECRET 环境变量取 */
  secretBox?: SecretBox | null;
}

const EMPTY_BYTES = new Uint8Array(0);
const HEALTH_PROBE_KEY = '.health-probe';

/**
 * 未注入 SettingRepository 时的占位实现（测试场景）：
 * 公开端点返回空对象（前端回落到自身默认值），写操作静默丢弃。
 */
const EMPTY_SETTINGS = {
  getAll: async (): Promise<Record<string, unknown>> => ({}),
  getPublic: async (): Promise<Record<string, unknown>> => ({}),
  get: async (): Promise<unknown> => undefined,
  setMany: async (): Promise<void> => undefined,
} as unknown as SettingRepository;

export function createApp(deps: AppDependencies): Express {
  const { config, database, storage, tokenService, rsaKeyPair } = deps;
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));

  // 反代后取真实客户端 IP（限流按 IP 计数的场景必需，如注册）。
  // 生产是 OpenResty + 1Panel，未设置时 req.ip 拿到的是反代自身地址 → 所有用户共用一个限流桶。
  // 值直接透传给 Express（'1' / 'loopback' / 'true' / IP 列表）。仅在确实位于可信反代之后才可开启，
  // 否则客户端可伪造 X-Forwarded-For 绕过基于 IP 的限流。
  const trustProxy = process.env['TRUST_PROXY'];
  if (trustProxy && trustProxy.trim() !== '') {
    const raw = trustProxy.trim();
    const numeric = Number(raw);
    app.set(
      'trust proxy',
      raw === 'true' ? true : Number.isFinite(numeric) ? numeric : raw,
    );
  }

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
  // 同时挂 /api/yggdrasil（规范路径）与根路径：HMCL 填裸 http://host:port 时会在根上找元数据。
  const siteUrl = deps.siteUrlResolver;
  const metadataHandler = async (
    _req: express.Request,
    res: express.Response,
  ): Promise<void> => {
    // TTL 内直接用缓存值；到点才查一次库，故这里的 await 不会给每个请求都带来查询
    await siteUrl?.ensureFresh();
    res.json(
      buildMetadataDto({
        // 元数据里的地址是给启动器下载纹理用的，因此用**素材前缀**而不是站点根
        baseUrl: siteUrl ? siteUrl.assetBaseUrlSync() : config.publicBaseUrl,
        publicKeyPem: rsaKeyPair.publicKeyPem,
        // skinDomains 未显式配置时由站点根 hostname 派生（未注入解析器时沿用环境变量）
        skinDomains: siteUrl ? siteUrl.skinDomains() : config.skinDomains,
      }),
    );
  };
  app.get('/', metadataHandler);
  app.get('/api/yggdrasil', metadataHandler);

  // ---- Yggdrasil 协议端点（P1：认证五端点 + 会话/纹理 + 批量角色查询）----
  // 路由内部为相对路径，多前缀挂载：
  // - /authserver/*      项目原始路径（测试/文档兼容）
  // - /api/yggdrasil/*   authlib-injector 规范推荐路径（HMCL 推荐填此）
  // - /                  根别名：认证五端点 + /sessionserver/*，HMCL 填裸根时可用
  // （批量查询 /api/profiles/minecraft 为绝对路径，由根挂载命中）
  const yggRouter = createYggdrasilRouter({
    identity: deps.identity,
    sessions: deps.minecraftSessions,
    profiles: deps.profileRepository,
    textureBuilder: deps.textureBuilder,
    assetUrlResolver: deps.assetUrlResolver,
    rateLimiter: deps.rateLimiter,
    rateLimit: deps.rateLimitSettings,
    refreshRateLimit: deps.refreshRateLimitSettings,
  });
  app.use('/authserver', yggRouter);
  app.use('/api/yggdrasil', yggRouter);
  app.use('/', yggRouter);
  /**
   * `/api/yggdrasil/authserver/*` 别名。
   *
   * 背景：启动器会把端点路径**直接拼在所填地址后**，而不同启动器拼法不同 ——
   * 有的拼规范相对路径 `/authenticate`，有的拼 `/authserver/authenticate`。
   * 页面展示给用户的是 `<站点>/api/yggdrasil`（见 UserProfile.tsx 的说明），
   * 只挂 `/api/yggdrasil` 时前者可用、后者 404，用户会看到「填了官方给的地址还是连不上」。
   * 多挂一个别名让两种拼法都命中，代价只是多一层无冲突的路径前缀。
   * （根挂载 `/` 已覆盖 `/<endpoint>` 与 `/authserver/<endpoint>` 两种裸域名填法。）
   */
  app.use('/api/yggdrasil/authserver', yggRouter);

  // ---- Web 身份端点（P1：注册/登录/登出 + 角色管理）----
  app.use(
    createIdentityRouter({
      identity: deps.identity,
      tokenService,
      runtimeSettings: deps.runtimeSettings,
      emailFlow: deps.emailFlow,
      captcha: deps.captcha,
      rateLimiter: deps.rateLimiter,
      rateLimit: deps.rateLimitSettings,
    }),
  );

  // ---- 邮箱验证 / 密码重置端点（P5；未注入 EmailFlow 则整体不挂载）----
  if (deps.emailFlow) {
    app.use(
      createAccountRouter({
        tokenService,
        emailFlow: deps.emailFlow,
        // 0003：注入后 /api/me/email-status 会连带返回备用邮箱与进行中的变更
        emailChangeFlow: deps.emailChangeFlow,
        rateLimiter: deps.rateLimiter,
        rateLimit: deps.rateLimitSettings,
      }),
    );
  }

  // ---- 备用邮箱 / 邮箱变更端点（0003；未注入 EmailChangeFlow 则整体不挂载）----
  if (deps.emailChangeFlow) {
    app.use(
      createEmailChangeRouter({
        tokenService,
        emailChangeFlow: deps.emailChangeFlow,
        rateLimiter: deps.rateLimiter,
        rateLimit: deps.rateLimitSettings,
      }),
    );
  }

  // ---- 第三方登录预留端口（批4-F；无 provider 时前端小格子不渲染）----
  app.use(createOAuthRouter({ providers: deps.oauthProviders }));

  // ---- 人机验证（0004；开关关着时 captcha-type 返回 'none'，前端不渲染）----
  app.use(
    createCaptchaRouter({
      captcha: deps.captcha,
      runtimeSettings: deps.runtimeSettings,
      rateLimiter: deps.rateLimiter,
      generateRateLimit: deps.captchaGenerateRateLimitSettings,
    }),
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

  // ---- 管理员审核端点（P3，P4 增用户管理）----
  app.use(
    createAdminRouter({
      tokenService,
      library: deps.library,
      assets: deps.assetRepository,
      identity: deps.identity,
      emailFlow: deps.emailFlow,
      mailService: deps.mailService,
      settings: deps.settings,
      runtimeSettings: deps.runtimeSettings,
    }),
  );

  // ---- 站点设置（P4；可选依赖，未注入时公开端点返回空对象）----
  app.use(
    createSettingRouter({
      tokenService,
      settings: deps.settings ?? EMPTY_SETTINGS,
      secretBox: deps.secretBox,
      runtimeSettings: deps.runtimeSettings,
      siteUrlResolver: deps.siteUrlResolver,
    }),
  );

  // ---- 本地存储静态挂载（URL 由 StoragePort 统一生成）----
  // CORS：Web 端 canvas（头像/3D 预览）跨源读取纹理必须带 ACAO 头
  app.use(
    '/uploads',
    express.static(config.uploadDir, {
      maxAge: '7d',
      setHeaders: (res) => res.set('Access-Control-Allow-Origin', '*'),
    }),
  );

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
