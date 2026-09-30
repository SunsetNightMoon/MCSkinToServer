import { join } from 'node:path';
import type { Express } from 'express';
import {
  dialectDirName,
  resolveCaptchaGenerateRateLimit,
  resolveProfileLookupRateLimit,
  resolveRateLimit,
  resolveRefreshRateLimit,
  type AppConfig,
} from '../config.js';
import { createDatabase } from '../db/index.js';
import { createCacheLayer } from '../cache/index.js';
import { runMigrations } from '../migrate/runner.js';
import { createStoragePort } from '../storage/index.js';
import { SiteUrlResolver } from '../site/siteUrl.js';
import { RuntimeSettings } from '../site/runtimeSettings.js';
import { SecretBox, MASTER_SECRET_ENV } from '../util/secretBox.js';
import { AccountTokenRepository } from '../repositories/accountTokenRepository.js';
import { EmailChangeRepository } from '../repositories/emailChangeRepository.js';
import { CaptchaRepository } from '../repositories/captchaRepository.js';
import { SmtpMailer } from '../mail/smtpMailer.js';
import { MailService } from '../mail/mailService.js';
import { EmailFlow } from '../account/emailFlow.js';
import { EmailChangeFlow } from '../account/emailChangeFlow.js';
import { CaptchaService } from '../account/captcha.js';
import { ExternalCaptchaService } from '../account/externalCaptcha.js';
import { TokenService } from '../auth/tokens.js';
import { IdentityService } from '../auth/identity.js';
import { purgeExpiredAccounts } from '../auth/accountLifecycle.js';
import { TokenRepository } from '../repositories/tokenRepository.js';
import { UserRepository } from '../repositories/userRepository.js';
import { ProfileRepository } from '../repositories/profileRepository.js';
import { MinecraftSessionRepository } from '../repositories/minecraftSessionRepository.js';
import { BlobRepository } from '../repositories/blobRepository.js';
import { AssetRepository } from '../repositories/assetRepository.js';
import { FavoriteRepository } from '../repositories/favoriteRepository.js';
import { SettingRepository } from '../repositories/settingRepository.js';
import { StatsRepository } from '../repositories/statsRepository.js';
import { TextureService } from '../textures/ingest.js';
import { LibraryService } from '../library/libraryService.js';
import { ThemeImageService } from '../site/themeImage.js';
import { TextureProfileBuilder } from '../yggdrasil/textures.js';
import { AssetUrlResolver } from '../storage/assetUrl.js';
import { loadOrCreateKeyPair } from '../yggdrasil/keys.js';
import { recordExistingEnvironment } from '../setup/setupService.js';
import { createApp } from './app.js';
import { PluginHost } from '../plugins/loader.js';
import { buildForProfile } from '../yggdrasil/buildForProfile.js';
import { PluginImporter } from '../plugins/importer.js';

/**
 * 正常模式（installed / auto）的完整装配（P5 第十二批补充）。
 *
 * 从 main.ts 拆出：启动路径与「向导装完后原地软重启」路径共用同一份装配，
 * 避免两处各自维护依赖清单而漂移。这里只构建 app 与资源句柄，**不 listen** ——
 * 端口换绑的时序由调用方掌握（软重启时要等新 app 构建成功后才关旧服务）。
 */
export interface InstalledHandle {
  app: Express;
  /** 关闭数据库 / Redis 等资源（不含 HTTP server，那是调用方的） */
  closeResources: () => Promise<void>;
}

export async function buildInstalledApp(config: AppConfig): Promise<InstalledHandle> {
  const db = await createDatabase(config);

  try {
    await runMigrations(
      db,
      join(config.migrationsRoot, dialectDirName(config.dialect)),
    );
  } catch (err) {
    await db.close().catch(() => undefined);
    throw err;
  }

  // auto：存量环境（无 setup.json 但库已有数据/已配 env）—— 迁移照常（幂等），
  // 启动后按现状补写 setup.json，从此走正常模式，不打回重装。
  if (config.installMode === 'auto') {
    recordExistingEnvironment(config);
  }

  // P5 可选依赖：有 REDIS_URL 走 Redis，否则/连不上时降级进程内存（进程照常启动）
  const cacheLayer = await createCacheLayer({ redisUrl: config.redisUrl });

  // 站点设置必须先于存储创建：素材 URL 前缀要跟着站点根（BASE_URL）走。
  // 注意 PUBLIC_BASE_URL 这里读**真实环境变量**而不是 config.publicBaseUrl ——
  // config 里那个字段带了 `http://localhost:3000/uploads` 的缺省值，
  // 分不清「运维显式配了」和「吃了缺省」，会导致管理员设了 BASE_URL 后素材地址仍指向 localhost。
  const explicitAssetBaseUrl = process.env['PUBLIC_BASE_URL']?.trim() || undefined;
  const settingRepository = new SettingRepository(
    db,
    cacheLayer.cache,
    config.settingsCacheTtlMs,
  );
  const siteUrlResolver = new SiteUrlResolver({
    settings: settingRepository,
    envPublicBaseUrl: explicitAssetBaseUrl,
    envSkinDomains: config.skinDomains,
  });
  await siteUrlResolver.refresh();

  const storage = createStoragePort(config, () =>
    siteUrlResolver.assetBaseUrlSync(),
  );
  const rsaKeyPair = loadOrCreateKeyPair(config.rsaPrivateKeyPath);
  const tokenRepository = new TokenRepository(db);
  const tokenService = new TokenService(tokenRepository);
  const userRepository = new UserRepository(db);
  const profileRepository = new ProfileRepository(db);
  const minecraftSessions = new MinecraftSessionRepository(db);
  const assetUrlResolver = new AssetUrlResolver(storage);
  const identity = new IdentityService({
    db,
    users: userRepository,
    profiles: profileRepository,
    tokens: tokenService,
    sessions: minecraftSessions,
    assetUrlResolver,
    // 全局用户名模式（P5 第十一批）：注册初值 + 管理面板全局切换
    settings: settingRepository,
    // 密码强度单一来源：环境变量 BCRYPT_COST（config 已钳制），安装向导读同一个值
    bcryptCost: config.bcryptCost,
  });
  const textureBuilder = new TextureProfileBuilder(rsaKeyPair.privateKeyPem);
  const textureService = new TextureService({
    db,
    storage,
    blobs: new BlobRepository(db),
    assets: new AssetRepository(db),
    profiles: profileRepository,
  });
  const assetRepository = new AssetRepository(db);
  const libraryService = new LibraryService({
    assets: assetRepository,
    favorites: new FavoriteRepository(db),
    blobs: new BlobRepository(db),
    users: userRepository,
    resolver: assetUrlResolver,
  });
  // 主题背景图：图片存 blob 存储（theme/ 前缀），当前地址写进站点设置键
  const themeImages = new ThemeImageService({
    storage,
    settings: settingRepository,
  });
  // ---- P5：注册开关 / 邮箱验证 / 邮件发送 ----
  const secretBox = SecretBox.fromEnv();
  if (!secretBox) {
    console.warn(
      `[mcsts] 未设置 ${MASTER_SECRET_ENV}：SMTP 密码将以明文存入 system_settings`,
    );
  }
  const runtimeSettings = new RuntimeSettings({
    settings: settingRepository,
    secretBox,
  });
  await runtimeSettings.refresh();

  const accountTokens = new AccountTokenRepository(db);
  const emailChangeRepo = new EmailChangeRepository(db);
  // ---- 人机验证：自托管（math/image）+ 外部服务（external，端点可配不绑定厂商）----
  // 具体走哪条由 CAPTCHA_TYPE 决定（见 runtimeSettings.captchaType），每次请求现读。
  const captchaRepo = new CaptchaRepository(db);
  const captcha = new CaptchaService({ challenges: captchaRepo });
  const externalCaptcha = new ExternalCaptchaService();
  // ---- 管理后台统计（仪表盘）：分桶时区可配，默认 UTC+8 ----
  const stats = new StatsRepository(db, config.statsTzOffsetMinutes);
  const smtpMailer = new SmtpMailer(runtimeSettings);
  const mailService = new MailService({
    mailer: smtpMailer,
    runtime: runtimeSettings,
  });
  const emailChangeFlow = new EmailChangeFlow({
    db,
    users: userRepository,
    changes: emailChangeRepo,
    mail: mailService,
    siteUrl: siteUrlResolver,
    // 复用 IdentityService 的邮箱格式校验，避免两套正则各自漂移
    emails: identity,
  });
  const emailFlow = new EmailFlow({
    db,
    users: userRepository,
    tokens: accountTokens,
    tokenService,
    mail: mailService,
    siteUrl: siteUrlResolver,
    // 复用 IdentityService 的密码规则与 bcrypt cost，避免重置路径强度漂移
    passwords: identity,
  });

  // 账号宽限期到期清理（注销生命周期）：启动时执行一次，失败不阻塞启动
  try {
    const purgeResult = await purgeExpiredAccounts({
      db,
      users: userRepository,
      profiles: profileRepository,
      assets: assetRepository,
    });
    if (purgeResult.purged > 0) {
      console.log(
        `[mcsts] purged ${purgeResult.purged} expired deleted account(s)`,
      );
    }
  } catch (err) {
    console.error(
      '[mcsts] account purge failed (non-fatal):',
      err instanceof Error ? err.message : err,
    );
  }

  // 过期的一次性令牌（邮箱验证 / 密码重置）顺手清掉：这两张表只增不减，
  // 不清就会随「用户反复点重发」一直长。失败同样不阻塞启动。
  try {
    await emailFlow.purgeExpiredTokens();
    await emailChangeFlow.purgeExpired();
  } catch (err) {
    console.error(
      '[mcsts] account token purge failed (non-fatal):',
      err instanceof Error ? err.message : err,
    );
  }

  // ---- 插件系统（默认关闭；MCSTS_PLUGINS 未设时连对象都不建）----
  const pluginHost = config.plugins?.enabled
    ? new PluginHost({
        db,
        settings: settingRepository,
        secretBox: secretBox ?? undefined,
        siteUrlResolver,
        tokenService,
        profileRepository,
        publicKeyPem: () => rsaKeyPair.publicKeyPem,
        buildTextureProperty: async (profileId) => {
          const state = await profileRepository.findTextureState(profileId);
          if (!state) return null;
          const prop = buildForProfile(textureBuilder, state, assetUrlResolver);
          return { value: prop.value, signature: prop.signature ?? null };
        },
        cache: cacheLayer.cache,
        rateLimiter: cacheLayer.rateLimiter,
        pluginDir: config.plugins.dir,
        now: () => new Date(),
      })
    : undefined;

  // 导入器只在宿主存在时才有意义（插件目录由同一个配置项决定）
  const pluginImporter = config.plugins?.enabled
    ? new PluginImporter({
        pluginDir: config.plugins.dir,
        now: () => new Date(),
        token: config.plugins.githubToken,
      })
    : undefined;

  const app = createApp({
    config,
    database: db,
    storage,
    tokenService,
    rsaKeyPair,
    identity,
    profileRepository,
    assetRepository,
    minecraftSessions,
    textureBuilder,
    assetUrlResolver,
    textures: textureService,
    library: libraryService,
    settings: settingRepository,
    // ---- P5 可选依赖：未注入就不做限流、设置读取直连数据库 ----
    rateLimiter: cacheLayer.rateLimiter,
    rateLimitSettings: resolveRateLimit(config),
    refreshRateLimitSettings: resolveRefreshRateLimit(config),
    profileLookupRateLimitSettings: resolveProfileLookupRateLimit(config),
    captchaGenerateRateLimitSettings: resolveCaptchaGenerateRateLimit(config),
    cache: cacheLayer.cache,
    settingsCacheTtlMs: config.settingsCacheTtlMs,
    // P5：站点地址 / 开关 / 邮件
    siteUrlResolver,
    runtimeSettings,
    emailFlow,
    emailChangeFlow,
    captcha,
    externalCaptcha,
    stats,
    themeImages,
    mailService,
    secretBox,
    plugins: pluginHost,
    pluginImporter,
  });

  // 加载插件放在装配之后、listen 之前：首个请求到达时就绪，且启停不需要重启进程
  await pluginHost?.boot();

  const closeResources = async (): Promise<void> => {
    await Promise.all([
      db.close().catch(() => undefined),
      // Redis 客户端持有 socket，不显式 quit 会让进程多撑到超时
      cacheLayer.close().catch(() => undefined),
    ]);
  };

  return { app, closeResources };
}
