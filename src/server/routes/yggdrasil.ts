import { Router, type Request, type Response } from 'express';
import type { IdentityService } from '../../auth/identity.js';
import type { MinecraftSessionRepository } from '../../repositories/minecraftSessionRepository.js';
import type { ProfileRepository } from '../../repositories/profileRepository.js';
import type { TextureProfileBuilder } from '../../yggdrasil/textures.js';
import type { AssetUrlResolver } from '../../storage/assetUrl.js';
import type { RateLimiterPort } from '../../cache/types.js';
import type { RateLimitSettings } from '../../config.js';
import {
  DEFAULT_PROFILE_LOOKUP_RATE_LIMIT,
  DEFAULT_REFRESH_RATE_LIMIT,
} from '../../config.js';
import { illegalArgument } from '../../yggdrasil/errors.js';
import { normalizeUuid, toShortUuid } from '../../yggdrasil/uuid.js';
import { buildForProfile } from '../../yggdrasil/buildForProfile.js';
import { bodyKey, clientIp, rateLimit } from '../rateLimit.js';
import { RateLimitKeys } from '../../cache/keys.js';

/**
 * Yggdrasil 协议 HTTP 适配层（蓝图 §3.2）。
 * 只做：请求体解析 → 调 IdentityService / 仓储 → DTO 映射。
 * 错误统一抛 YggdrasilError / AppError，由 errorHandler 转 HTTP。
 *
 * 路径全部为相对路径，由 app.ts 多前缀挂载：
 * - /authserver/*            （项目原始路径，测试与文档兼容）
 * - /api/yggdrasil/*         （authlib-injector 规范推荐路径，HMCL 填此）
 * - /*                       （根路径别名：HMCL 填裸 http://host:port 时直接拼 /authenticate）
 */

export interface YggdrasilRouteDependencies {
  identity: IdentityService;
  sessions: MinecraftSessionRepository;
  profiles: ProfileRepository;
  textureBuilder: TextureProfileBuilder;
  assetUrlResolver: AssetUrlResolver;
  /** hasJoined 短会话过期判断用时钟 */
  now?: () => Date;
  /** 限流器；未注入则不做限流（测试场景） */
  rateLimiter?: RateLimiterPort;
  /** 限流参数；缺省用 DEFAULT_RATE_LIMIT */
  rateLimit?: RateLimitSettings;
  /**
   * `POST /refresh` 专用限流参数；缺省用 DEFAULT_REFRESH_RATE_LIMIT。
   *
   * 与上面那套分开是刻意的：refresh 按 **IP** 计（不能按用户名，见 RateLimitKeys.yggdrasilRefresh），
   * 且上限更宽松 —— 它是启动器的后台定期行为，不是登录尝试。
   */
  refreshRateLimit?: RateLimitSettings;
  /**
   * `POST /api/profiles/minecraft` 专用限流参数；缺省用 DEFAULT_PROFILE_LOOKUP_RATE_LIMIT。
   *
   * 同样是**按 IP**、且比认证端点宽松得多：这个端点匿名可用（角色名 → UUID，
   * 单次最多 10 名），真客户端进服时也会打它，共用出口地址下多人同时进服
   * 会落在同一个键上。
   */
  profileLookupRateLimit?: RateLimitSettings;
}

const MAX_BATCH_NAMES = 10;

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw illegalArgument(`缺少必填字段: ${field}`);
  }
  return value;
}

function profileDto(id: string, name: string): { id: string; name: string } {
  return { id: toShortUuid(id), name };
}

export function createYggdrasilRouter(deps: YggdrasilRouteDependencies): Router {
  const router = Router();
  const now = deps.now ?? (() => new Date());

  /**
   * 凭据类端点限流（authenticate / signout）。按用户名（邮箱）计数，
   * 与 plan3 的行为对齐：5 次 / 5 分钟。未注入限流器时返回恒放行的空中间件。
   */
  const credentialLimit: ReturnType<typeof rateLimit>[] =
    deps.rateLimiter && deps.rateLimit
      ? [
          rateLimit({
            limiter: deps.rateLimiter,
            settings: deps.rateLimit,
            keyOf: bodyKey('username', (v) => RateLimitKeys.yggdrasilAccount(v)),
            message: (seconds) =>
              `请求过于频繁，请在 ${seconds} 秒后重试`,
          }),
        ]
      : [];

  /**
   * `POST /refresh` 限流：**按来源地址**，刻意不按用户名。
   *
   * 为什么不按用户名：启动器会在 accessToken 临近过期时**自动定期刷新**。
   * 按账号计数会把这种正常后台行为判成攻击，症状是「挂机一阵后启动器突然掉线，
   * 重新登录又好」，而日志里只看到一串 429 —— 极难排查。
   *
   * 按 IP 计只压「同一出口地址的高频刷新」；上限也放宽（DEFAULT_REFRESH_RATE_LIMIT），
   * 让共用出口地址（宿舍 / 机房 NAT）下的正常用户不会互相误伤。
   *
   * 注：本 router 被挂到 4 个前缀（/authserver、/api/yggdrasil、/、/api/yggdrasil/authserver），
   * 但限流键只取客户端地址，因此换前缀不会绕过限流。
   */
  const refreshSettings = deps.refreshRateLimit ?? DEFAULT_REFRESH_RATE_LIMIT;
  const refreshLimit: ReturnType<typeof rateLimit>[] =
    deps.rateLimiter && refreshSettings.enabled
      ? [
          rateLimit({
            limiter: deps.rateLimiter,
            settings: refreshSettings,
            keyOf: (req) => RateLimitKeys.yggdrasilRefresh(clientIp(req)),
            message: (seconds) => `请求过于频繁，请在 ${seconds} 秒后重试`,
          }),
        ]
      : [];

  /**
   * 批量角色名查询限流：**按来源地址**，60 次/分钟。
   *
   * 这是本路由里唯一完全匿名的写读端点，不限流就等于允许无限速遍历全站角色名与
   * UUID（预留名也报占用，见下）。阈值刻意宽松：正常玩家与服务器都到不了顶，
   * 而脚本爬库会被压到很小一个速率。键只取客户端地址，换挂载前缀绕不过去。
   */
  const profileLookupSettings =
    deps.profileLookupRateLimit ?? DEFAULT_PROFILE_LOOKUP_RATE_LIMIT;
  const profileLookupLimit: ReturnType<typeof rateLimit>[] =
    deps.rateLimiter && profileLookupSettings.enabled
      ? [
          rateLimit({
            limiter: deps.rateLimiter,
            settings: profileLookupSettings,
            keyOf: (req) => RateLimitKeys.yggdrasilProfileLookup(clientIp(req)),
            message: (seconds) => `请求过于频繁，请在 ${seconds} 秒后重试`,
          }),
        ]
      : [];

  // ---- 认证五端点（相对路径，挂载前缀见文件头注释）----
  router.post('/authenticate', ...credentialLimit, async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const session = await deps.identity.authenticateYggdrasil({
      email: requireString(body['username'], 'username'),
      password: requireString(body['password'], 'password'),
      clientToken:
        typeof body['clientToken'] === 'string' ? body['clientToken'] : null,
    });
    res.json(session);
  });

  router.post('/refresh', ...refreshLimit, async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const session = await deps.identity.refreshYggdrasil({
      accessToken: requireString(body['accessToken'], 'accessToken'),
      clientToken: requireString(body['clientToken'], 'clientToken'),
    });
    res.json(session);
  });

  router.post('/validate', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    await deps.identity.validateYggdrasil({
      accessToken: requireString(body['accessToken'], 'accessToken'),
      clientToken:
        typeof body['clientToken'] === 'string' ? body['clientToken'] : null,
    });
    res.status(204).end();
  });

  router.post('/invalidate', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    await deps.identity.invalidateYggdrasil(
      requireString(body['accessToken'], 'accessToken'),
    );
    res.status(204).end();
  });

  router.post('/signout', ...credentialLimit, async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    await deps.identity.signoutYggdrasil({
      username: requireString(body['username'], 'username'),
      password: requireString(body['password'], 'password'),
    });
    res.status(204).end();
  });

  // ---- /sessionserver/session/minecraft/*（会话与纹理）----

  router.post('/sessionserver/session/minecraft/join', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const accessToken = requireString(body['accessToken'], 'accessToken');
    const selectedProfile = requireString(body['selectedProfile'], 'selectedProfile');
    const serverId = requireString(body['serverId'], 'serverId');
    const verified = await deps.identity.verifyForJoin({
      accessToken,
      selectedProfile,
      serverId,
    });
    await deps.identity.registerMinecraftSession({
      tokenId: verified.tokenId,
      profileId: verified.profileId,
      serverId,
    });
    res.status(204).end();
  });

  router.get('/sessionserver/session/minecraft/hasJoined', async (req, res) => {
    const username = requireString(req.query['username'], 'username');
    const serverId = requireString(req.query['serverId'], 'serverId');

    const session = await deps.sessions.findActiveByServerId(serverId, now());
    // 协议要求：serverId 未命中或 username 与角色名不一致 → 204 空响应
    if (!session || session.profileName !== username) {
      res.status(204).end();
      return;
    }
    const state = await deps.profiles.findTextureState(session.profileId);
    if (!state) {
      res.status(204).end();
      return;
    }
    const textures = buildForProfile(
      deps.textureBuilder,
      state,
      deps.assetUrlResolver,
    );
    res.json({
      ...profileDto(session.profileId, session.profileName),
      properties: [textures],
    });
  });

  router.get('/sessionserver/session/minecraft/profile/:uuid', async (req, res) => {
    const canonical = normalizeUuid(String(req.params['uuid'] ?? ''));
    if (!canonical) {
      throw illegalArgument(`非法 Profile UUID: ${String(req.params['uuid'] ?? '')}`);
    }
    const state = await deps.profiles.findTextureState(canonical);
    // 预留角色（0003）：UUID 还存在、名字还占着，但当前不可用 ——
    // 按协议回 204，与「角色不存在」同一种响应，避免把「这个 ID 被某人占着
    // 只是暂时没用」暴露成可探测的信息。
    if (!state || state.status !== 'active') {
      res.status(204).end();
      return;
    }
    const unsigned = req.query['unsigned'] === 'true';
    const textures = buildForProfile(
      deps.textureBuilder,
      state,
      deps.assetUrlResolver,
      { unsigned },
    );
    res.json({
      ...profileDto(state.profileId, state.profileName),
      properties: [textures],
    });
  });

  // ---- POST /api/profiles/minecraft（批量角色名查询，协议端点）----
  // 注意：保持绝对路径（根挂载命中）；其余挂载前缀会生成无害的死路径。

  router.post('/api/profiles/minecraft', ...profileLookupLimit, async (req: Request, res: Response) => {
    const body = req.body;
    if (!Array.isArray(body)) {
      throw illegalArgument('请求体必须为角色名数组');
    }
    const names = [...new Set(body.filter((n): n is string => typeof n === 'string'))];
    if (names.length > MAX_BATCH_NAMES) {
      throw illegalArgument(`单次最多查询 ${MAX_BATCH_NAMES} 个角色名`);
    }
    const found: { id: string; name: string }[] = [];
    for (const name of names) {
      const profile = await deps.profiles.findByName(name);
      // 预留角色**同样报为已占用**（P5 第十一批用户拍板，推翻 0003 的防探测口径）：
      // 「被锁定的 ID 别人去用也必须显示被占用」—— 检测可用性、启动器解析
      // 都走这里，报出来才不会出现「显示可用、实际建不了」的自相矛盾。
      // 预留角色没有会话，即便解析出 UUID 也无法加入服务器，无安全影响。
      if (profile) {
        found.push(profileDto(profile.id, profile.name));
      }
    }
    res.json(found);
  });

  return router;
}
