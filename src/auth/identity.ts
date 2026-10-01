import bcrypt from 'bcryptjs';
import {
  DEFAULT_BCRYPT_COST,
  hashPasswordWithCost,
  needsRehash,
} from './password.js';
import { randomUUID } from 'node:crypto';
import type { DatabaseConnection } from '../types.js';
import { AppError } from '../errors.js';
import { forbiddenOperation } from '../yggdrasil/errors.js';
import { toShortUuid } from '../yggdrasil/uuid.js';
import type { IssuedToken, TokenService } from './tokens.js';
import type { UserRole } from '../repositories/tokenRepository.js';
import type {
  ProfileMode,
  UserRepository,
  UserRow,
} from '../repositories/userRepository.js';
import type {
  ProfileRepository,
  ProfileRow,
} from '../repositories/profileRepository.js';
import type { MinecraftSessionRepository } from '../repositories/minecraftSessionRepository.js';
import type { SettingRepository } from '../repositories/settingRepository.js';
import { RuntimeSettingKeys } from '../site/runtimeSettings.js';
import type { AssetUrlResolver } from '../storage/assetUrl.js';
import { requireCanonicalUuid } from '../util/uuid.js';
import { emitPluginEvent } from '../plugins/events.js';

/**
 * 身份应用服务（蓝图 §7.1）：注册 / 登录 / Yggdrasil 五端点 / 角色管理。
 *
 * 领域规则集中在这里，HTTP 层只做输入解析与 DTO 映射：
 * - 注册：email 规范化小写、密码 ≥ 8、角色名 3-16 位 [A-Za-z0-9_]，单事务建用户+默认角色
 * - 封禁语义：ban_permanent 或 banned_until 未到期 → USER_BANNED（临时封禁到期自动恢复）
 * - 改名冷却：30 天，基准 name_changed_at
 * - Yggdrasil 令牌：token_type='yggdrasil'，clientToken 原样存储回显
 * - **用户名模式（0003）**：见下方「用户名模式」一节
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NAME_RE = /^[A-Za-z0-9_]{3,16}$/;
const NAME_COOLDOWN_MS = 30 * 24 * 3600 * 1000;
/**
 * bcrypt cost 不在这里写死：由 `IdentityDependencies.bcryptCost` 从配置注入，
 * 与安装向导共用同一个来源（见 src/auth/password.ts 的权衡说明）。
 */
/**
 * 单账号角色总数上限（活跃 + 预留）。**仅多用户名模式受此约束** ——
 * 单用户名模式更严：只能有 1 个 active，新建接口直接拒绝。
 */
export const MAX_PROFILES_PER_USER = 10;
/** 单用户名模式下可用（active）角色的数量上限 */
export const SINGLE_MODE_ACTIVE_LIMIT = 1;
const MINECRAFT_SESSION_TTL_MS = 30 * 1000;
/** 注销后的账号恢复宽限期（15 天）；到期由 purgeExpiredAccounts 清除个人数据 */
export const ACCOUNT_DELETE_GRACE_MS = 15 * 24 * 3600 * 1000;

export interface PublicUser {
  id: string;
  userUid: number;
  email: string;
  role: UserRole;
  emailVerified: boolean;
  /** 0003：当前用户名模式 */
  profileMode: ProfileMode;
  /**
   * true = 存量多角色用户尚未选择保留哪个 ID。
   * 放在登录/注册响应里（而不是只给一个单独接口）是因为前端必须在**拿到会话的那一刻**
   * 就知道要不要弹选择框 —— 否则用户会先看到角色列表，再被一个迟到的弹窗打断。
   */
  modeChoiceRequired: boolean;
}

export interface ProfileSummary {
  id: string;
  name: string;
}

/**
 * 用户名模式与角色状态快照（0003）。
 *
 * 刻意把「上限」也一并返回，而不是让前端硬编码 10 / 1：
 * 上限是后端规则，前端只负责展示「3/10」这类计数，规则改动不该要求前端跟着发版。
 */
export interface ProfileModeState {
  mode: ProfileMode;
  /** true = 存量多角色用户尚未选择保留哪个 ID，前端必须弹窗且禁用相关写操作 */
  decisionRequired: boolean;
  decidedAt: string | null;
  modeChangedAt: string | null;
  /** 模式允许的角色总数上限（活跃 + 预留） */
  maxProfiles: number;
  /** 当前模式下可用（active）角色的数量上限：single=1，multi=10 */
  activeLimit: number;
  activeCount: number;
  reservedCount: number;
  /**
   * 单用户名模式下「换 ID」（改名 / 启用预留角色）的冷却结束时刻；
   * null = 当前无冷却（多用户名模式、从未改过名、或窗口已过）。
   */
  cooldownUntil: string | null;
  cooldownDaysRemaining: number | null;
}

export interface RegisterResult {
  user: PublicUser;
  profile: ProfileRow;
  /**
   * 会话令牌。
   *
   * **可空是必要的**：站点开启「要求邮箱验证」时，注册成功但不得签发会话 ——
   * 否则「必须验证邮箱」就成了摆设，用户拿着刚注册的 token 照样能用全部功能。
   * 把这一点写进类型而不是悄悄返回一个空串，是为了让每个消费方都必须显式处理
   * 「这次没有会话」的情况（HTTP 层据此回 `requiresVerification: true`）。
   */
  token: IssuedToken | null;
}

/** Yggdrasil 会话响应（authenticate / refresh 共用结构） */
export interface YggdrasilSession {
  accessToken: string;
  clientToken: string;
  availableProfiles: ProfileSummary[];
  selectedProfile: ProfileSummary | null;
  user: { id: string; email: string };
}

export interface IdentityDependencies {
  db: DatabaseConnection;
  users: UserRepository;
  profiles: ProfileRepository;
  tokens: TokenService;
  sessions: MinecraftSessionRepository;
  /** Web 头像/预览 URL 生成（getMySkin 用），可缺省（测试） */
  assetUrlResolver?: AssetUrlResolver;
  /**
   * 全局用户名模式读写（P5 第十一批）。可缺省（测试按单模式）：
   * 注册初值与管理面板全局切换都走它。
   */
  settings?: Pick<SettingRepository, 'get' | 'setMany'>;
  /** 时钟可注入 */
  now?: () => Date;
  /**
   * bcrypt cost（Issue #5）。缺省 `DEFAULT_BCRYPT_COST`（10，与改动前一致）；
   * 正常部署由 `AppConfig.bcryptCost` 注入，安装向导走同一个值。
   */
  bcryptCost?: number;
}

function toPublicUser(user: UserRow): PublicUser {
  return {
    id: user.id,
    userUid: user.userUid,
    email: user.email,
    role: user.role,
    emailVerified: user.emailVerified,
    profileMode: user.profileMode,
    modeChoiceRequired: user.profileModeDecidedAt === null,
  };
}

/**
 * 缺失角色时的占位。
 *
 * 注册即建默认角色，所以理论上取不到；但登录/恢复账号这两条路径不该因此阻塞
 * 用户的账号访问，于是用空角色放行。
 *
 * 抽成函数而不是就地写字面量：ProfileRow 每加一列就要改所有副本，
 * 而这个占位出现在两处（loginWeb / restoreAccount），上一次加 status 时
 * 就是这样漏掉一处的 —— 类型检查把它抓了出来。
 */
function emptyProfile(userId: string): ProfileRow {
  return {
    id: '',
    userId,
    name: '',
    nameChangedAt: '',
    createdAt: '',
    updatedAt: '',
    status: 'active',
    statusChangedAt: null,
  };
}

export class IdentityService {
  private readonly db: DatabaseConnection;
  private readonly users: UserRepository;
  private readonly profiles: ProfileRepository;
  private readonly tokens: TokenService;
  private readonly sessions: MinecraftSessionRepository;
  private readonly assetUrlResolver?: AssetUrlResolver;
  private readonly settings?: Pick<SettingRepository, 'get' | 'setMany'>;
  private readonly now: () => Date;
  private readonly bcryptCost: number;

  constructor(deps: IdentityDependencies) {
    this.db = deps.db;
    this.users = deps.users;
    this.profiles = deps.profiles;
    this.tokens = deps.tokens;
    this.sessions = deps.sessions;
    this.assetUrlResolver = deps.assetUrlResolver;
    this.settings = deps.settings;
    this.now = deps.now ?? (() => new Date());
    this.bcryptCost = deps.bcryptCost ?? DEFAULT_BCRYPT_COST;
  }

  /**
   * 全站用户名模式（P5 第十一批）。未设置 = 'single'。
   *
   * 直接读库不走 RuntimeSettings 的 TTL 缓存：全局切换后必须立即可见，
   * 否则「切完 30 秒内注册的用户」会拿到旧值，出现与全站不一致的账号。
   */
  private async readGlobalProfileMode(): Promise<ProfileMode> {
    if (!this.settings) return 'single';
    const raw = await this.settings.get(RuntimeSettingKeys.profileMode);
    return raw === 'multi' ? 'multi' : 'single';
  }

  // ---- 校验 ----

  assertValidEmail(email: string): void {
    if (typeof email !== 'string' || !EMAIL_RE.test(email) || email.length > 254) {
      throw new AppError('VALIDATION_ERROR', '邮箱格式不正确');
    }
  }

  assertValidPassword(password: string): void {
    if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
      throw new AppError('VALIDATION_ERROR', '密码长度须为 8-128 位');
    }
  }

  assertValidProfileName(name: string): void {
    if (typeof name !== 'string' || !NAME_RE.test(name)) {
      throw new AppError('VALIDATION_ERROR', '角色名须为 3-16 位字母/数字/下划线');
    }
  }

  /**
   * 密码哈希（P5）。公开出来给「重置密码」复用 —— 重置与注册必须使用同一个
   * bcrypt cost，否则两条路径的强度会各自漂移，而这类不一致在生产里几乎发现不了。
   * 内置强度校验，调用方不需要（也不应该）自己再校验一次。
   */
  async hashPassword(password: string): Promise<string> {
    this.assertValidPassword(password);
    return hashPasswordWithCost(password, this.bcryptCost);
  }

  // ---- 封禁与凭据 ----

  private assertNotBanned(user: UserRow): void {
    if (user.banPermanent) {
      throw new AppError(
        'USER_BANNED',
        user.banReason ? `账号已被永久封禁：${user.banReason}` : '账号已被永久封禁',
      );
    }
    if (
      user.bannedUntil !== null &&
      new Date(user.bannedUntil).getTime() > this.now().getTime()
    ) {
      throw new AppError(
        'USER_BANNED',
        user.banReason
          ? `账号被封禁至 ${user.bannedUntil}：${user.banReason}`
          : `账号被封禁至 ${user.bannedUntil}`,
      );
    }
  }

  private async assertPassword(user: UserRow, password: string): Promise<void> {
    if (typeof password !== 'string' || !(await bcrypt.compare(password, user.passwordHash))) {
      throw new AppError('INVALID_CREDENTIALS', '邮箱或密码不正确');
    }
  }

  /**
   * 登录成功后的哈希平滑升级（Issue #5）。
   *
   * cost 写在哈希串里（`$2a$10$…`），所以「这条还是旧强度」是可判定的；而此刻
   * 明文就在手上、校验也已经通过，正是唯一不需要额外凭据就能重算的时机。
   * 管理员把 `BCRYPT_COST` 调高后，全站随用户自然登录收敛，不必强制改密码。
   *
   * 三条边界：
   * - **只在登录路径调用**。改密/注销等路径随后本来就会写新哈希，在这里重算是白算一遍。
   * - **失败绝不阻断登录**：升级是纯增益，写库出错只留一条警告，用户照常登录成功。
   * - **不降级**：管理员把配置调回低值时不重写（见 `needsRehash`）。
   */
  private async upgradePasswordHash(user: UserRow, password: string): Promise<void> {
    if (!needsRehash(user.passwordHash, this.bcryptCost)) return;
    try {
      const hash = await hashPasswordWithCost(password, this.bcryptCost);
      await this.users.updatePassword(user.id, hash, this.now());
    } catch (err) {
      console.warn(
        '[auth] 密码哈希升级失败（不影响本次登录）：',
        err instanceof Error ? err.message : err,
      );
    }
  }

  /**
   * 把「登录时填的地址」解析成账号：主邮箱，或**已验证**的备用邮箱。
   *
   * 三种拿不到账号的情况一律走同一句凭据错误，不对外区分：
   * 地址查不到、输入不是字符串、以及**跨列冲突**（同一地址既是 A 的主邮箱又是 B 的
   * 备用邮箱 —— 数据库管不了这种重复，只能靠注册/绑定时的应用层查重，历史脏数据
   * 或旁路写入都可能造出来）。冲突时只记一条服务端日志：它意味着数据不变量被破坏，
   * 需要人去查；但对客户端绝不能有区别，否则这个端点就变成冲突探测器。
   */
  private async resolveLoginAccount(
    address: unknown,
  ): Promise<{ user: UserRow; viaBackup: boolean } | null> {
    const text = typeof address === 'string' ? address.trim() : '';
    if (text === '') return null;
    const match = await this.users.findForLogin(text);
    if (!match) return null;
    if (match.conflict) {
      console.warn(
        `[auth] 登录地址命中多个账号（邮箱唯一性被破坏，需要人工核查）：user=${match.user.id}`,
      );
      return null;
    }
    return { user: match.user, viaBackup: match.slot === 'backup' };
  }

  /**
   * 登录限流用的「提交标识 → 账号 id」。
   *
   * 限流键如果按**提交的字符串**取，一个绑了备用邮箱的账号就有两个互不相干的桶：
   * 主邮箱把 5 次/5 分钟打满，换备用邮箱继续，配额直接翻倍 —— 备用邮箱是**同一个账号**的
   * 登录入口，不是第二个账号。启动器侧同理（`username` 也可以是备用邮箱）。
   *
   * 所以这里复用 `resolveLoginAccount` 的同一套解析口径（宁可重复一次索引查询，
   * 也不另写一份「什么算同一个账号」的判断 —— 两份口径迟早会漂移）。
   * 解析不出来时返回 null，由调用方回落到按提交值取键：否则随机邮箱的尝试会挤进
   * 同一个桶，那才是真给用户关门的洞。
   */
  async resolveAuthBucketUserId(address: unknown): Promise<string | null> {
    const text = typeof address === 'string' ? address.trim() : '';
    // 上限与 assertValidEmail 的 254 同口径：超长串一定是伪造输入，不值得为它打一次
    // 索引查询（限流器仍会按提交值计数，不会因此失去保护）。
    if (text === '' || text.length > 254) return null;
    const resolved = await this.resolveLoginAccount(text);
    return resolved?.user.id ?? null;
  }

  private async loadUserForAuth(
    email: string,
  ): Promise<{ user: UserRow; viaBackup: boolean }> {
    const resolved = await this.resolveLoginAccount(email);
    // 用户不存在与密码错误统一报错，不泄露账号是否存在
    if (!resolved) {
      throw new AppError('INVALID_CREDENTIALS', '邮箱或密码不正确');
    }
    return resolved;
  }

  /** Yggdrasil 侧凭据错误必须走 ForbiddenOperationException（403） */
  private async assertYggdrasilCredentials(
    email: string,
    password: string,
  ): Promise<UserRow> {
    const resolved = await this.resolveLoginAccount(email);
    if (
      !resolved ||
      typeof password !== 'string' ||
      !(await bcrypt.compare(password, resolved.user.passwordHash))
    ) {
      throw forbiddenOperation('Invalid credentials');
    }
    const { user } = resolved;
    // 已注销账号不再具备 Yggdrasil 登录能力（宽限期内可先恢复）
    if (user.deletedAt) {
      throw forbiddenOperation('Account deleted');
    }
    // 启动器登录同样承担哈希升级：很多账号从不在网页登录，只走这条路径
    await this.upgradePasswordHash(user, password);
    return user;
  }

  // ---- 注册 / Web 登录 ----

  /**
   * 注册。
   *
   * `issueSession: false` 由「要求邮箱验证」场景使用：用户与默认角色照常创建，
   * 但不签发会话，必须点完验证链接才能登录。默认 true 保持原行为不变。
   */
  async register(input: {
    email: string;
    password: string;
    profileName: string;
    issueSession?: boolean;
  }): Promise<RegisterResult> {
    this.assertValidEmail(input.email);
    this.assertValidPassword(input.password);
    this.assertValidProfileName(input.profileName);

    const email = input.email.toLowerCase();
    const now = this.now();

    if (await this.users.findByEmail(email)) {
      throw new AppError('EMAIL_TAKEN', '该邮箱已被注册');
    }
    // 跨列占用：数据库的两个唯一索引各管一列（lower(email) 与 lower(backup_email)），
    // 管不到「A 的主邮箱 == B 的备用邮箱」。改邮箱/绑备用那条路径由
    // `assertAddressAvailable` 补了这道检查，注册此前只查主邮箱 —— 于是可以拿别人
    // 已绑定的备用邮箱注册成主邮箱，一个地址就绑到两个号上。备用邮箱现在能登录，
    // 这个口子必须堵掉。
    if (await this.users.findByBackupEmail(email)) {
      throw new AppError('EMAIL_TAKEN', '该邮箱已被其他账号用作备用邮箱');
    }
    if (await this.profiles.findByName(input.profileName)) {
      throw new AppError('NAME_TAKEN', '该角色名已被占用');
    }

    const passwordHash = await hashPasswordWithCost(input.password, this.bcryptCost);

    // 单事务：用户 + 默认角色必须同时成功
    const created = await this.db.transaction(async () => {
      const userId = randomUUID();
      const userUid = await this.users.insert({
        id: userId,
        email,
        passwordHash,
        role: 'user',
        now,
        // 注册初值跟全站走（P5 第十一批）：全局是 multi 的新账号可直接纳名池/加角色
        profileMode: await this.readGlobalProfileMode(),
      });
      const profileId = randomUUID();
      await this.profiles.insert({
        id: profileId,
        userId,
        name: input.profileName,
        now,
      });
      return { userId, userUid, profileId };
    });

    // 插件事件：注册**落库之后**才发（事务里发会让回滚的注册也惊动插件）
    emitPluginEvent('user.registered', {
      userId: created.userId,
      profileId: created.profileId,
      profileName: input.profileName,
    });

    const user: UserRow = {
      id: created.userId,
      userUid: created.userUid,
      email,
      passwordHash,
      role: 'user',
      isActive: true,
      emailVerified: false,
      bannedUntil: null,
      banPermanent: false,
      banReason: null,
      bannedAt: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      lastLoginAt: null,
      deletedAt: null,
      purgedAt: null,
      // 新账号角色数为 0，视作已决定（库内 profile_mode_decided_at 同此口径）
      profileMode: 'single',
      profileModeDecidedAt: now.toISOString(),
      modeChangedAt: null,
      backupEmail: null,
      backupEmailVerified: false,
      backupEmailVerifiedAt: null,
    };
    const token =
      input.issueSession === false
        ? null
        : await this.tokens.issue({ tokenType: 'web', userId: user.id });
    const profile = (await this.profiles.findById(created.profileId))!;
    return { user: toPublicUser(user), profile, token };
  }

  /**
   * Web 登录。
   *
   * `requireEmailVerified` 由站点的 REQUIRE_EMAIL_VERIFICATION 开关决定：
   * 开启时未验证账号被拒（403 EMAIL_NOT_VERIFIED），前端据此展示「重发验证邮件」。
   *
   * 检查点刻意放在**密码校验与状态检查之后、签发令牌之前**：
   * - 放在密码校验之前 → 未持密码的人也能探出「这个邮箱注册过但没验证」
   * - 放在签发之后 → 只能作废刚发的令牌，多一次写库且容易漏掉某条返回路径
   */
  async loginWeb(input: {
    email: string;
    password: string;
    requireEmailVerified?: boolean;
  }): Promise<RegisterResult> {
    const { user, viaBackup } = await this.loadUserForAuth(input.email);
    await this.assertPassword(user, input.password);
    // 先验密码再报注销/封禁状态，避免向未持密码者泄露账号状态
    this.assertNotDeleted(user);
    if (!user.isActive) {
      throw new AppError('USER_DISABLED', '账号已被停用');
    }
    this.assertNotBanned(user);
    // 用**已验证的备用邮箱**登录时，视为满足「要求邮箱验证」这道门槛。
    // 备用邮箱存在的意义就是主邮箱收不到信时的兜底；这里再卡一道主邮箱已验证，
    // 等于把兜底堵死 —— 账号只能靠超管人工处理。
    if (input.requireEmailVerified === true && !user.emailVerified && !viaBackup) {
      throw new AppError(
        'EMAIL_NOT_VERIFIED',
        '邮箱尚未验证，请先完成邮箱验证后再登录',
      );
    }

    await this.users.updateLastLogin(user.id, this.now());
    // 走到这里说明密码确实正确、账号也确实可登录 —— 才是要升级哈希的时机
    await this.upgradePasswordHash(user, input.password);
    const token = await this.tokens.issue({ tokenType: 'web', userId: user.id });
    const profile = await this.profiles.findFirstActiveByUserId(user.id);
    return {
      user: toPublicUser(user),
      // 兜底：理论上注册即建角色；缺失时登录仍放行（不阻塞账号访问）
      profile: profile ?? emptyProfile(user.id),
      token,
    };
  }

  // ---- Yggdrasil ----

  private async buildSession(
    user: UserRow,
    issued: IssuedToken,
    clientToken: string,
    selectedProfileId: string | null,
  ): Promise<YggdrasilSession> {
    // 只列 active：预留口里的角色名字还被占着，但当前**不可用**，
    // 出现在 availableProfiles 里会让启动器给出一个选了就 join 不进去的选项。
    const list = await this.profiles.listActiveByUserId(user.id);
    const selected =
      selectedProfileId !== null
        ? (list.find((p) => p.id === selectedProfileId) ?? null)
        : null;
    return {
      accessToken: issued.token,
      clientToken,
      availableProfiles: list.map((p) => ({ id: toShortUuid(p.id), name: p.name })),
      selectedProfile: selected
        ? { id: toShortUuid(selected.id), name: selected.name }
        : null,
      user: { id: toShortUuid(user.id), email: user.email },
    };
  }

  async authenticateYggdrasil(input: {
    email: string;
    password: string;
    clientToken?: string | null;
  }): Promise<YggdrasilSession> {
    const user = await this.assertYggdrasilCredentials(input.email, input.password);
    if (!user.isActive) {
      // Yggdrasil 侧统一走 ForbiddenOperationException
      throw forbiddenOperation('账号已被停用');
    }
    this.assertNotBanned(user);

    const clientToken =
      input.clientToken ?? randomUUID().replaceAll('-', '');
    await this.users.updateLastLogin(user.id, this.now());
    const firstProfile = await this.profiles.findFirstActiveByUserId(user.id);
    const issued = await this.tokens.issue({
      tokenType: 'yggdrasil',
      userId: user.id,
      profileId: firstProfile?.id ?? null,
      clientToken,
    });
    return this.buildSession(user, issued, clientToken, firstProfile?.id ?? null);
  }

  async refreshYggdrasil(input: {
    accessToken: string;
    clientToken: string;
  }): Promise<YggdrasilSession> {
    const verify = await this.tokens.verify(input.accessToken, input.clientToken);
    if (!verify.ok) {
      throw forbiddenOperation('无效的 accessToken 或 clientToken 不匹配');
    }
    if (verify.context.tokenType !== 'yggdrasil') {
      throw forbiddenOperation('该令牌不能用于 Yggdrasil 会话');
    }

    const user = (await this.users.findById(verify.context.userId))!;
    // 每次刷新换发新 token 并吊销旧 token（服务端单会话语义）
    await this.tokens.revoke(input.accessToken);
    const issued = await this.tokens.issue({
      tokenType: 'yggdrasil',
      userId: user.id,
      profileId: verify.context.profileId,
      clientToken: input.clientToken,
    });
    return this.buildSession(user, issued, input.clientToken, verify.context.profileId);
  }

  async validateYggdrasil(input: {
    accessToken: string;
    clientToken?: string | null;
  }): Promise<void> {
    const verify = await this.tokens.verify(
      input.accessToken,
      input.clientToken ?? undefined,
    );
    if (!verify.ok || verify.context.tokenType !== 'yggdrasil') {
      throw forbiddenOperation('无效的 accessToken');
    }
  }

  async invalidateYggdrasil(accessToken: string): Promise<void> {
    // 幂等：token 不存在也返回成功（协议约定 invalidate 不报错）
    await this.tokens.revoke(accessToken);
  }

  async signoutYggdrasil(input: {
    username: string;
    password: string;
  }): Promise<void> {
    const user = await this.assertYggdrasilCredentials(input.username, input.password);
    await this.tokens.revokeAllForUser(user.id, 'yggdrasil');
  }

  /** join 端点：校验 yggdrasil token 且 selectedProfile 匹配，返回内部 profileId */
  async verifyForJoin(input: {
    accessToken: string;
    selectedProfile: string;
    serverId: string;
  }): Promise<{ profileId: string; tokenId: string }> {
    for (const field of [input.accessToken, input.selectedProfile, input.serverId]) {
      if (typeof field !== 'string' || field.length === 0) {
        throw new AppError('VALIDATION_ERROR', 'accessToken / selectedProfile / serverId 均为必填');
      }
    }
    const verify = await this.tokens.verify(input.accessToken);
    if (!verify.ok || verify.context.tokenType !== 'yggdrasil') {
      throw forbiddenOperation('无效的 accessToken');
    }
    if (
      verify.context.profileId === null ||
      toShortUuid(verify.context.profileId) !== input.selectedProfile.toLowerCase()
    ) {
      throw forbiddenOperation('selectedProfile 与令牌绑定的角色不一致');
    }
    return { profileId: verify.context.profileId, tokenId: verify.context.tokenId };
  }

  /** join 成功后登记短会话（供 hasJoined 查询） */
  async registerMinecraftSession(input: {
    tokenId: string;
    profileId: string;
    serverId: string;
  }): Promise<void> {
    const now = this.now();
    const { MinecraftSessionRepository } = await import(
      '../repositories/minecraftSessionRepository.js'
    );
    const repo = new MinecraftSessionRepository(this.db);
    await repo.insert({
      tokenId: input.tokenId,
      profileId: input.profileId,
      serverId: input.serverId,
      now,
      expiresAt: new Date(now.getTime() + MINECRAFT_SESSION_TTL_MS),
    });
  }

  // ---- 用户名模式（0003）----
  //
  // 三种模式/状态，必须先分清，后面所有判断都建立在这上面：
  //
  //   'single' + 已决定   ：只能有 1 个 active。改名与「启用预留角色」共用**同一个**
  //                         30 天窗口，基准是当前 active 角色的 name_changed_at。
  //   'multi'  + 已决定   ：无冷却；active + reserved 合计 ≤ 10。新建的角色即 active。
  //   任意模式 + 未决定    ：存量多角色用户的中间态（迁移把 decided_at 留成 NULL）。
  //                         除「首次决定」外的任何写操作都拒绝（MODE_CHOICE_REQUIRED），
  //                         否则会出现「用户还没选，后端已经替他定了」的状态漂移。
  //
  // 预留（reserved）角色为什么保留在库里：多 -> 单 时被换下的角色如果直接删掉，
  // 用户等满冷却后想换回来的那个名字已经被别人抢注了。保留名字占位，
  // 代价只是「这个名字暂时查不到可用角色」。

  /** 模式未决定时拦下一切写操作（读操作放行：前端要先能列出角色给用户选） */
  private assertModeDecided(user: UserRow): void {
    if (user.profileModeDecidedAt === null) {
      throw new AppError(
        'MODE_CHOICE_REQUIRED',
        '请先选择要保留的角色 ID，再继续其他操作',
      );
    }
  }

  /**
   * 生成一次身份变更的时间戳。
   *
   * 「这个角色改过名没有」在数据上用 `name_changed_at !== created_at` 表示（P1 起沿用），
   * 目的是给注册时按邮箱前缀自动生成的初始名留一次免费改名 —— 否则新用户要顶着
   * 一个邮箱前缀当 ID 等满 30 天。
   *
   * 但同一毫秒内改名会让两者相等，于是被判定成「从未改名」：免费改名被重复发放，
   * 30 天窗口也不会启动。生产里这条路径隔着一次 bcrypt 和一次 HTTP 往返，撞不上；
   * 可它把一条规则的成立条件押在时钟精度上，属于不该留的脆弱点。
   * 这里把时间戳抬到严格大于 created_at，让判定与精度解耦。
   */
  private identityChangeStamp(profile: ProfileRow, now: Date): Date {
    const created = new Date(profile.createdAt).getTime();
    return new Date(Math.max(now.getTime(), created + 1));
  }

  /**
   * 单用户名模式下的「换 ID」冷却。
   *
   * 基准刻意是**当前 active 角色**的 name_changed_at，而不是 users 上的某个时间戳：
   * 改名与「把预留角色搬进来」是同一件事（换掉正在用的那个 ID）的两种形式，
   * 共用一个 30 天窗口才能在语义上成立 —— 否则用户可以「改名不用冷却，靠换角色实现」。
   *
   * 返回 null 表示当前无冷却。三种情况：多用户名模式、从未改过名（初始命名不算改名）、
   * 或者窗口已经跑完。
   */
  private singleModeCooldown(
    active: ProfileRow | null,
    now: Date,
  ): { until: string; daysRemaining: number } | null {
    if (!active) return null;
    // 初始命名（name_changed_at === created_at）不算改名，首次改名不受冷却限制
    if (active.nameChangedAt === active.createdAt) return null;
    const stamp = new Date(active.nameChangedAt).getTime();
    // elapsed 下限取 0：identityChangeStamp 可能写出比「现在」晚 1 毫秒的时间戳
    // （同一毫秒内改名时），不减这一刀会算出「还需 31 天」这种莫名其妙的数字。
    const elapsed = Math.max(0, now.getTime() - stamp);
    if (elapsed >= NAME_COOLDOWN_MS) return null;
    return {
      until: new Date(stamp + NAME_COOLDOWN_MS).toISOString(),
      daysRemaining: Math.ceil((NAME_COOLDOWN_MS - elapsed) / 86400000),
    };
  }

  /**
   * 模式与角色状态快照（个人中心 / 首次选择弹窗 / 预留口可见性判定）。
   *
   * 前端**不应该**自己算预留口该不该显示：那需要组合「模式 + 待决定 + 预留数量」
   * 三个字段，任何一处判断漂移都会让用户看到一个点了会报错的入口。
   */
  async getProfileModeState(userId: string): Promise<ProfileModeState> {
    const user = await this.users.findById(userId);
    if (!user) throw new AppError('NOT_FOUND', '用户不存在');

    const [active, reserved] = await Promise.all([
      this.profiles.listActiveByUserId(userId),
      this.profiles.listReservedByUserId(userId),
    ]);
    const now = this.now();
    const cooldown =
      user.profileMode === 'single'
        ? this.singleModeCooldown(active[0] ?? null, now)
        : null;

    return {
      mode: user.profileMode,
      decisionRequired: user.profileModeDecidedAt === null,
      decidedAt: user.profileModeDecidedAt,
      modeChangedAt: user.modeChangedAt,
      maxProfiles: MAX_PROFILES_PER_USER,
      activeLimit:
        user.profileMode === 'single'
          ? SINGLE_MODE_ACTIVE_LIMIT
          : MAX_PROFILES_PER_USER,
      activeCount: active.length,
      reservedCount: reserved.length,
      cooldownUntil: cooldown?.until ?? null,
      cooldownDaysRemaining: cooldown?.daysRemaining ?? null,
    };
  }

  /**
   * 首次选择保留 ID（P5 第十一批收窄：只决定「留谁」，不再决定模式）。
   *
   * 模式是全站统一的（`PROFILE_MODE` 设置），用户侧唯一还存在的模式相关
   * 决策就是这一条：全局切到 single 时名下有多个使用中 ID 的账号会进入
   * 「待选择」态（decided_at = NULL），下次进个人中心强制弹窗选保留谁，
   * 其余角色转预留并从此开始 30 天窗口。
   *
   * 已决定的账号调用这里 → 403：模式由站点统一设置，个人无任何切换入口。
   */
  async decideKeepId(input: {
    userId: string;
    keepProfileId?: string | null;
  }): Promise<ProfileModeState> {
    const user = await this.users.findById(input.userId);
    if (!user) throw new AppError('NOT_FOUND', '用户不存在');
    if (user.profileModeDecidedAt !== null) {
      throw new AppError(
        'FORBIDDEN',
        '用户名模式由站点统一设置，个人无权调整',
      );
    }

    const mode = user.profileMode;
    const now = this.now();
    const profiles = await this.profiles.listByUserId(input.userId);

    let keep: ProfileRow | null = null;
    if (mode === 'single') {
      if (profiles.length === 0) {
        // 理论不可能（注册即建角色），但不引入额外分支：直接确定模式即可
      } else if (input.keepProfileId) {
        keep = profiles.find((p) => p.id === input.keepProfileId) ?? null;
        if (!keep) throw new AppError('NOT_FOUND', '角色不存在');
      } else if (profiles.length === 1) {
        keep = profiles[0]!;
      } else {
        throw new AppError('VALIDATION_ERROR', '请选择要保留的角色 ID');
      }
    }

    const demoted: ProfileRow[] = [];
    await this.db.transaction(async () => {
      if (mode === 'single' && keep && profiles.length > 1) {
        demoted.push(...profiles.filter((p) => p.id !== keep.id && p.status === 'active'));
        await this.profiles.setStatusForAllExcept(
          input.userId,
          keep.id,
          'reserved',
          now,
        );
        // 3 个可用 ID 变成 1 个 = 一次身份变更，窗口从这里开始
        await this.profiles.markNameChanged(
          keep.id,
          this.identityChangeStamp(keep, now),
        );
      }
      await this.users.decideMode(input.userId, mode, now);
    });
    // 事务落定后再广播：绑定了这些角色的插件要据此丢弃绑定、释放外部身份
    for (const p of demoted) {
      emitPluginEvent('profile.reserved', { userId: input.userId, profileId: p.id, name: p.name });
    }

    return this.getProfileModeState(input.userId);
  }

  /**
   * 管理面板：全站用户名模式（仅超级管理员）。
   *
   * P5 第十一批（用户拍板）：用户名模式不再按账号各自设置 —— 由超级管理员
   * 在管理面板统一切换，影响全部账号。这里返回当前模式与切换影响面统计，
   * 供确认弹窗展示「有多少账号会被强制选择保留 ID」。
   */
  async getGlobalProfileMode(actor: {
    userId: string;
    role: UserRole;
  }): Promise<{
    mode: ProfileMode;
    stats: {
      totalUsers: number;
      multiActiveUsers: number;
      undecidedUsers: number;
    };
  }> {
    if (actor.role !== 'super_admin') {
      throw new AppError('FORBIDDEN', '仅超级管理员可以查看用户名模式');
    }
    const mode = await this.readGlobalProfileMode();
    return { mode, stats: await this.users.countProfileModeStats() };
  }

  /**
   * 管理面板：切换全站用户名模式（仅超级管理员）。
   *
   * 切到 single：名下有多个使用中 ID 的账号进入「待选择」态（decided_at 置
   * NULL），下次进个人中心强制弹窗选保留 ID，选定的留下、其余转预留（30 天
   * 窗口随之启动）；只有 ≤1 个可用 ID 的账号不受影响。
   * 切到 multi：仅同步各用户的模式副本，无强制动作（multi 无冷却、无强制选择）。
   *
   * 设置写入与用户副本迁移**故意不分同一个事务**：SettingRepository 与本服务
   * 可能持有不同连接，跨仓库事务不可靠。先写设置（事实源）再刷副本，中途
   * 失败重跑一次即可收敛 —— 本方法对「已是目标模式」幂等，直接返回不迁移。
   */
  async setGlobalProfileMode(
    actor: { userId: string; role: UserRole },
    mode: ProfileMode,
  ): Promise<{
    mode: ProfileMode;
    stats: {
      totalUsers: number;
      multiActiveUsers: number;
      undecidedUsers: number;
    };
  }> {
    if (actor.role !== 'super_admin') {
      throw new AppError('FORBIDDEN', '仅超级管理员可以调整用户名模式');
    }
    if (mode !== 'single' && mode !== 'multi') {
      throw new AppError('VALIDATION_ERROR', '无效的用户名模式');
    }
    if (!this.settings) {
      throw new AppError(
        'VALIDATION_ERROR',
        '当前实例未接入设置存储，无法切换全局用户名模式',
      );
    }

    const current = await this.readGlobalProfileMode();
    if (current === mode) {
      return { mode, stats: await this.users.countProfileModeStats() };
    }

    const now = this.now();
    await this.settings.setMany(
      { [RuntimeSettingKeys.profileMode]: mode },
      now,
    );
    await this.users.syncProfileModeForAll(mode, now);
    if (mode === 'single') {
      await this.users.markMultiActiveUndecided(now);
    }

    return { mode, stats: await this.users.countProfileModeStats() };
  }

  /**
   * 启用预留口里的一个角色（单用户名模式下唯一的「换 ID」路径之一）。
   *
   * 它消耗与改名同一个 30 天窗口：换角色和改名字对「这个账号当前叫什么」而言
   * 是同一件事。启用后当前 active 转预留（数据留着，随时可以再换回来）。
   */
  async activateReservedProfile(
    userId: string,
    profileId: string,
  ): Promise<ProfileModeState> {
    requireCanonicalUuid(profileId, '角色不存在');
    const user = await this.users.findById(userId);
    if (!user) throw new AppError('NOT_FOUND', '用户不存在');
    this.assertModeDecided(user);
    if (user.profileMode !== 'single') {
      throw new AppError(
        'VALIDATION_ERROR',
        '多用户名模式下角色本身就是可用的，无需启用预留角色',
      );
    }

    const target = await this.profiles.findById(profileId);
    if (!target || target.userId !== userId) {
      throw new AppError('NOT_FOUND', '角色不存在');
    }
    if (target.status !== 'reserved') {
      throw new AppError('VALIDATION_ERROR', '该角色已是可用状态');
    }

    const now = this.now();
    const current = await this.profiles.findFirstActiveByUserId(userId);
    const cooldown = this.singleModeCooldown(current, now);
    if (cooldown) {
      throw new AppError(
        'MODE_COOLDOWN',
        `更换角色 ID 的冷却中，还需约 ${cooldown.daysRemaining} 天`,
      );
    }

    await this.db.transaction(async () => {
      if (current) {
        await this.profiles.setStatus(current.id, 'reserved', now);
      }
      await this.profiles.setStatus(target.id, 'active', now);
      // 换了正在用的 ID = 一次身份变更，窗口从此刻重新开始
      await this.profiles.markNameChanged(
        target.id,
        this.identityChangeStamp(target, now),
      );
    });
    // 换下的旧角色同理会牵动插件绑定，事务落定后广播
    if (current) {
      emitPluginEvent('profile.reserved', {
        userId,
        profileId: current.id,
        name: current.name,
      });
    }

    return this.getProfileModeState(userId);
  }

  // ---- 角色管理（Web）----

  /** 全部角色（含预留），按创建时间升序；前端按 status 分成「我的角色」与预留口 */
  async listProfiles(userId: string): Promise<ProfileRow[]> {
    return this.profiles.listByUserId(userId);
  }

  /**
   * 角色列表 + 每个角色当前绑定的皮肤/披风。
   *
   * Web 衣柜需要这些字段：`skinId` / `capeId` 用于卡片「已应用」高亮（前端按素材
   * ID 比对），`skinUrl` / `capeUrl` 用于 3D 预览。Yggdrasil 协议链路不走这里
   * （它用 findTextureState，不需要素材 ID）。
   */
  async listProfilesWithTextures(userId: string): Promise<
    Array<
      ProfileRow & {
        skinId: string | null;
        capeId: string | null;
        skinUrl: string | null;
        capeUrl: string | null;
        model: 'default' | 'slim' | null;
      }
    >
  > {
    const [profiles, bindings] = await Promise.all([
      this.profiles.listByUserId(userId),
      this.profiles.listTextureBindingsByUserId(userId),
    ]);
    const bindingByProfile = new Map(
      bindings.map((binding) => [binding.profileId, binding]),
    );
    const resolver = this.assetUrlResolver;

    return profiles.map((profile) => {
      const binding = bindingByProfile.get(profile.id);
      const skin = binding?.skin ?? null;
      const cape = binding?.cape ?? null;
      return {
        ...profile,
        skinId: binding?.skinAssetId ?? null,
        capeId: binding?.capeAssetId ?? null,
        skinUrl: skin && resolver ? resolver.forBlob(skin) : null,
        capeUrl: cape && resolver ? resolver.forBlob(cape) : null,
        model: skin?.modelType ?? null,
      };
    });
  }

  async createProfile(userId: string, name: string): Promise<ProfileRow> {
    this.assertValidProfileName(name);
    const user = await this.users.findById(userId);
    if (!user) throw new AppError('NOT_FOUND', '用户不存在');
    this.assertModeDecided(user);
    if (user.profileMode === 'single') {
      // 单用户名模式的「只有一个 ID」不是靠数量上限表达（上限是 1 个 active，
      // 而预留角色也占总数），而是干脆不接受新建：用户的第 2 个 ID 只能来自
      // 「曾是多用户名模式」，否则等于绕开 30 天窗口凭空多出一个可用名字。
      throw new AppError(
        'VALIDATION_ERROR',
        `单用户名模式下每个账号只能有一个角色 ID；如需多个 ID 请先切换到多用户名模式`,
      );
    }
    if (await this.profiles.findByName(name)) {
      throw new AppError('NAME_TAKEN', '该角色名已被占用');
    }
    const count = await this.profiles.countByUserId(userId);
    if (count >= MAX_PROFILES_PER_USER) {
      throw new AppError(
        'VALIDATION_ERROR',
        `每个账号最多 ${MAX_PROFILES_PER_USER} 个角色`,
      );
    }
    const id = randomUUID();
    await this.profiles.insert({
      id,
      userId,
      name,
      now: this.now(),
      status: 'active',
    });
    return (await this.profiles.findById(id))!;
  }

  async renameProfile(userId: string, profileId: string, newName: string): Promise<ProfileRow> {
    this.assertValidProfileName(newName);
    // 格式闸门：非规范 UUID 与「角色不存在」同响应（PG uuid 列会为此抛 22P02 → 兜底 500）
    requireCanonicalUuid(profileId, '角色不存在');
    const user = await this.users.findById(userId);
    if (!user) throw new AppError('NOT_FOUND', '用户不存在');
    this.assertModeDecided(user);
    const profile = await this.profiles.findById(profileId);
    if (!profile || profile.userId !== userId) {
      throw new AppError('NOT_FOUND', '角色不存在');
    }
    // 预留角色是「暂时不可用」的占位：允许改名等于给了单用户名模式一个
    // 免费的抢注通道（改个想要的名字先占着，等冷却期满再启用）。
    if (profile.status === 'reserved') {
      throw new AppError(
        'PROFILE_RESERVED',
        '预留中的角色 ID 不能改名；如需启用请等冷却期满后使用「启用预留角色」',
      );
    }
    // 单用户名模式下改名消耗与「启用预留角色」共用的 30 天窗口；多用户名模式无冷却。
    // 错误码沿用 NAME_COOLDOWN（而不是 MODE_COOLDOWN）：改名的调用方从 P1 起就按这个码
    // 处理文案，换码会让既有前端静默退化成通用提示，而收益只是码名更「统一」。
    if (user.profileMode === 'single') {
      const cooldown = this.singleModeCooldown(profile, this.now());
      if (cooldown) {
        throw new AppError(
          'NAME_COOLDOWN',
          `改名冷却中，还需约 ${cooldown.daysRemaining} 天`,
        );
      }
    }
    if (await this.profiles.findByName(newName)) {
      throw new AppError('NAME_TAKEN', '该角色名已被占用');
    }
    await this.profiles.rename(
      profileId,
      newName,
      this.identityChangeStamp(profile, this.now()),
    );
    const renamed = await this.profiles.findById(profileId);
    emitPluginEvent('profile.renamed', {
      userId,
      profileId,
      from: profile.name,
      to: renamed?.name ?? newName,
    });
    return renamed!;
  }

  async deleteProfile(userId: string, profileId: string): Promise<void> {
    requireCanonicalUuid(profileId, '角色不存在');
    const user = await this.users.findById(userId);
    if (!user) throw new AppError('NOT_FOUND', '用户不存在');
    this.assertModeDecided(user);
    const profile = await this.profiles.findById(profileId);
    if (!profile || profile.userId !== userId) {
      throw new AppError('NOT_FOUND', '角色不存在');
    }
    const count = await this.profiles.countByUserId(userId);
    if (count <= 1) {
      throw new AppError('VALIDATION_ERROR', '至少保留一个角色');
    }
    // 单用户名模式下删掉唯一的 active 会让账号一个可用 ID 都不剩，
    // 而恢复它的唯一路径又卡在 30 天冷却上 —— 等于把用户锁死。
    if (user.profileMode === 'single' && profile.status === 'active') {
      throw new AppError(
        'VALIDATION_ERROR',
        '单用户名模式下不能删除当前生效的角色 ID；请先在预留口中启用另一个角色',
      );
    }
    // 删预留角色是允许的：它只是放弃一个占位（能力减少，不构成身份变更，不需要冷却）
    await this.profiles.delete(profileId);
    emitPluginEvent('profile.deleted', {
      userId,
      profileId,
      name: profile.name,
    });
  }

  // ---- 账号生命周期（改密 / 注销 / 恢复）----

  /** 已注销账号：宽限期内提示可恢复，超期提示已不可恢复 */
  private assertNotDeleted(user: UserRow): void {
    if (!user.deletedAt) return;
    const elapsed = this.now().getTime() - new Date(user.deletedAt).getTime();
    if (elapsed < ACCOUNT_DELETE_GRACE_MS) {
      const days = Math.ceil((ACCOUNT_DELETE_GRACE_MS - elapsed) / 86400000);
      throw new AppError(
        'ACCOUNT_DELETED',
        `该账号已注销，还可在 ${days} 天内恢复`,
      );
    }
    throw new AppError('ACCOUNT_DELETED', '该账号已注销且已超过恢复期限');
  }

  /**
   * 修改密码：需提供旧密码；成功后吊销该用户**全部**会话
   * （前端收到成功即清登录态并跳登录页，因此整体吊销不会打断流程）。
   */
  async changePassword(input: {
    userId: string;
    oldPassword: string;
    newPassword: string;
  }): Promise<void> {
    const user = await this.users.findById(input.userId);
    if (!user) throw new AppError('NOT_FOUND', '用户不存在');
    await this.assertPassword(user, input.oldPassword);
    this.assertValidPassword(input.newPassword);

    const hash = await hashPasswordWithCost(input.newPassword, this.bcryptCost);
    const now = this.now();
    await this.users.updatePassword(user.id, hash, now);
    // 改密即失效全部令牌：Web 与 Yggdrasil 会话一并作废
    await this.tokens.revokeAllForUser(user.id);
  }

  /**
   * 注销账号：需密码确认，随后进入 15 天可恢复宽限期。
   * 个人数据此时不清除（宽限期内要能恢复），到期由 purgeExpiredAccounts 清除。
   */
  async deleteAccount(input: {
    userId: string;
    password: string;
  }): Promise<{ recoverableUntil: string }> {
    const user = await this.users.findById(input.userId);
    if (!user) throw new AppError('NOT_FOUND', '用户不存在');
    await this.assertPassword(user, input.password);

    const now = this.now();
    if (!user.deletedAt) {
      await this.users.markDeleted(user.id, now);
    }
    await this.tokens.revokeAllForUser(user.id);

    const base = user.deletedAt
      ? new Date(user.deletedAt).getTime()
      : now.getTime();
    return {
      recoverableUntil: new Date(base + ACCOUNT_DELETE_GRACE_MS).toISOString(),
    };
  }

  /** 恢复已注销账号：仅限宽限期内；成功后直接建立登录会话 */
  async restoreAccount(input: {
    email: string;
    password: string;
  }): Promise<RegisterResult> {
    const { user } = await this.loadUserForAuth(input.email);
    await this.assertPassword(user, input.password);
    if (!user.deletedAt) {
      throw new AppError('VALIDATION_ERROR', '该账号未处于注销状态');
    }
    const elapsed = this.now().getTime() - new Date(user.deletedAt).getTime();
    if (elapsed >= ACCOUNT_DELETE_GRACE_MS) {
      throw new AppError('ACCOUNT_DELETED', '已超过 15 天恢复期限，账号无法恢复');
    }

    const now = this.now();
    await this.users.clearDeleted(user.id, now);
    const token = await this.tokens.issue({ tokenType: 'web', userId: user.id });
    const profile = await this.profiles.findFirstActiveByUserId(user.id);
    return {
      user: toPublicUser(user),
      profile: profile ?? emptyProfile(user.id),
      token,
    };
  }

  // ---- Web 头像 / 管理员用户管理 ----

  /** 当前登录用户的默认角色皮肤（顶栏头像用） */
  async getMySkin(
    userId: string,
  ): Promise<{ profileId: string; profileName: string; skinUrl: string | null; model: string | null }> {
    const profile = await this.profiles.findFirstActiveByUserId(userId);
    if (!profile) {
      throw new AppError('NOT_FOUND', '角色不存在');
    }
    const state = await this.profiles.findTextureState(profile.id);
    const skinUrl =
      state?.skin && this.assetUrlResolver
        ? this.assetUrlResolver.forBlob(state.skin)
        : null;
    return {
      profileId: profile.id,
      profileName: profile.name,
      skinUrl,
      model: state?.skin?.modelType ?? null,
    };
  }

  /** 管理员用户列表（admin 及以上） */
  async listUsersForAdmin(options: {
    page: number;
    pageSize: number;
    search?: string;
  }): Promise<{
    items: Array<Omit<UserRow, 'passwordHash'>>;
    total: number;
  }> {
    const pageSize = Math.min(Math.max(options.pageSize, 1), 100);
    const page = Math.max(options.page, 1);
    const { rows, total } = await this.users.listUsers({
      offset: (page - 1) * pageSize,
      limit: pageSize,
      search: options.search,
    });
    return {
      items: rows.map(({ passwordHash: _ph, ...rest }) => rest),
      total,
    };
  }

  /**
   * 管理员更新用户（角色 / 封禁 / 激活）。
   * 规则：角色调整仅 super_admin；任何管理员不能修改 super_admin（除非自己是 super_admin）；不能封禁自己。
   */
  async adminUpdateUser(
    actor: { userId: string; role: UserRole },
    targetUserId: string,
    patch: {
      role?: UserRole;
      isActive?: boolean;
      ban?: { permanent?: boolean; until?: string | null; reason?: string | null } | null;
    },
  ): Promise<Omit<UserRow, 'passwordHash'>> {
    requireCanonicalUuid(targetUserId, '用户不存在');
    const target = await this.users.findById(targetUserId);
    if (!target) {
      throw new AppError('NOT_FOUND', '用户不存在');
    }
    const actorIsSuper = actor.role === 'super_admin';

    if (patch.role !== undefined) {
      if (!actorIsSuper) {
        throw new AppError('FORBIDDEN', '仅超级管理员可以调整角色');
      }
      if (targetUserId === actor.userId && patch.role !== 'super_admin') {
        throw new AppError('VALIDATION_ERROR', '不能降级自己的超级管理员角色');
      }
    }
    if (target.role === 'super_admin' && !actorIsSuper) {
      throw new AppError('FORBIDDEN', '无法修改超级管理员');
    }

    const fields: Parameters<UserRepository['updateAdminFields']>[1] = {};
    if (patch.role !== undefined) fields.role = patch.role;
    if (patch.isActive !== undefined) fields.isActive = patch.isActive;

    if (patch.ban !== undefined) {
      if (targetUserId === actor.userId) {
        throw new AppError('VALIDATION_ERROR', '不能封禁自己');
      }
      if (patch.ban === null || (!patch.ban.permanent && !patch.ban.until)) {
        // 解封
        fields.banPermanent = false;
        fields.bannedUntil = null;
        fields.banReason = null;
        // 时间戳必须一并清空：留着它会让「封禁趋势」把解封后的日子仍算作封禁，
        // 也会让「重新封禁」看起来像是同一次（覆盖为新时刻才对）
        fields.bannedAt = null;
      } else {
        const permanent = patch.ban.permanent === true;
        if (!permanent) {
          const until = patch.ban.until ? new Date(patch.ban.until) : null;
          if (!until || Number.isNaN(until.getTime()) || until.getTime() <= this.now().getTime()) {
            throw new AppError('VALIDATION_ERROR', '临时封禁必须提供未来的到期时间');
          }
          fields.bannedUntil = until.toISOString();
        } else {
          fields.bannedUntil = null;
        }
        fields.banPermanent = permanent;
        fields.banReason = patch.ban.reason ?? null;
        // 无论永久还是临时，都记下本次下达时刻（重复封禁会覆盖为最新一次）
        fields.bannedAt = this.now().toISOString();
      }
    }

    if (Object.keys(fields).length === 0) {
      throw new AppError('VALIDATION_ERROR', '没有需要更新的字段');
    }
    await this.users.updateAdminFields(targetUserId, fields, this.now());
    const updated = (await this.users.findById(targetUserId))!;
    const { passwordHash: _ph, ...rest } = updated;
    return rest;
  }
}
