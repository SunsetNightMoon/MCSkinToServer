import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import type { DatabaseConnection } from '../types.js';
import { AppError } from '../errors.js';
import { forbiddenOperation } from '../yggdrasil/errors.js';
import { toShortUuid } from '../yggdrasil/uuid.js';
import type { IssuedToken, TokenService } from './tokens.js';
import type { UserRole } from '../repositories/tokenRepository.js';
import type { UserRepository, UserRow } from '../repositories/userRepository.js';
import type {
  ProfileRepository,
  ProfileRow,
} from '../repositories/profileRepository.js';
import type { MinecraftSessionRepository } from '../repositories/minecraftSessionRepository.js';
import type { AssetUrlResolver } from '../storage/assetUrl.js';

/**
 * 身份应用服务（蓝图 §7.1）：注册 / 登录 / Yggdrasil 五端点 / 角色管理。
 *
 * 领域规则集中在这里，HTTP 层只做输入解析与 DTO 映射：
 * - 注册：email 规范化小写、密码 ≥ 8、角色名 3-16 位 [A-Za-z0-9_]，单事务建用户+默认角色
 * - 封禁语义：ban_permanent 或 banned_until 未到期 → USER_BANNED（临时封禁到期自动恢复）
 * - 改名冷却：30 天，基准 name_changed_at
 * - Yggdrasil 令牌：token_type='yggdrasil'，clientToken 原样存储回显
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NAME_RE = /^[A-Za-z0-9_]{3,16}$/;
const NAME_COOLDOWN_MS = 30 * 24 * 3600 * 1000;
const BCRYPT_COST = 10;
export const MAX_PROFILES_PER_USER = 3;
const MINECRAFT_SESSION_TTL_MS = 30 * 1000;
/** 注销后的账号恢复宽限期（15 天）；到期由 purgeExpiredAccounts 清除个人数据 */
export const ACCOUNT_DELETE_GRACE_MS = 15 * 24 * 3600 * 1000;

export interface PublicUser {
  id: string;
  userUid: number;
  email: string;
  role: UserRole;
  emailVerified: boolean;
}

export interface ProfileSummary {
  id: string;
  name: string;
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
  /** 时钟可注入 */
  now?: () => Date;
}

function toPublicUser(user: UserRow): PublicUser {
  return {
    id: user.id,
    userUid: user.userUid,
    email: user.email,
    role: user.role,
    emailVerified: user.emailVerified,
  };
}

export class IdentityService {
  private readonly db: DatabaseConnection;
  private readonly users: UserRepository;
  private readonly profiles: ProfileRepository;
  private readonly tokens: TokenService;
  private readonly sessions: MinecraftSessionRepository;
  private readonly assetUrlResolver?: AssetUrlResolver;
  private readonly now: () => Date;

  constructor(deps: IdentityDependencies) {
    this.db = deps.db;
    this.users = deps.users;
    this.profiles = deps.profiles;
    this.tokens = deps.tokens;
    this.sessions = deps.sessions;
    this.assetUrlResolver = deps.assetUrlResolver;
    this.now = deps.now ?? (() => new Date());
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
    return bcrypt.hash(password, BCRYPT_COST);
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

  private async loadUserForAuth(email: string): Promise<UserRow> {
    const user = await this.users.findByEmail(email);
    // 用户不存在与密码错误统一报错，不泄露账号是否存在
    if (!user) {
      throw new AppError('INVALID_CREDENTIALS', '邮箱或密码不正确');
    }
    return user;
  }

  /** Yggdrasil 侧凭据错误必须走 ForbiddenOperationException（403） */
  private async assertYggdrasilCredentials(
    email: string,
    password: string,
  ): Promise<UserRow> {
    const user = await this.users.findByEmail(email);
    if (
      !user ||
      typeof password !== 'string' ||
      !(await bcrypt.compare(password, user.passwordHash))
    ) {
      throw forbiddenOperation('Invalid credentials');
    }
    // 已注销账号不再具备 Yggdrasil 登录能力（宽限期内可先恢复）
    if (user.deletedAt) {
      throw forbiddenOperation('Account deleted');
    }
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
    if (await this.profiles.findByName(input.profileName)) {
      throw new AppError('NAME_TAKEN', '该角色名已被占用');
    }

    const passwordHash = await bcrypt.hash(input.password, BCRYPT_COST);

    // 单事务：用户 + 默认角色必须同时成功
    const created = await this.db.transaction(async () => {
      const userId = randomUUID();
      const userUid = await this.users.insert({
        id: userId,
        email,
        passwordHash,
        role: 'user',
        now,
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
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      lastLoginAt: null,
      deletedAt: null,
      purgedAt: null,
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
    const user = await this.loadUserForAuth(input.email);
    await this.assertPassword(user, input.password);
    // 先验密码再报注销/封禁状态，避免向未持密码者泄露账号状态
    this.assertNotDeleted(user);
    if (!user.isActive) {
      throw new AppError('USER_DISABLED', '账号已被停用');
    }
    this.assertNotBanned(user);
    if (input.requireEmailVerified === true && !user.emailVerified) {
      throw new AppError(
        'EMAIL_NOT_VERIFIED',
        '邮箱尚未验证，请先完成邮箱验证后再登录',
      );
    }

    await this.users.updateLastLogin(user.id, this.now());
    const token = await this.tokens.issue({ tokenType: 'web', userId: user.id });
    const profile = await this.profiles.findFirstByUserId(user.id);
    return {
      user: toPublicUser(user),
      // 兜底：理论上注册即建角色；缺失时登录仍放行（不阻塞账号访问）
      profile: profile ?? {
        id: '',
        userId: user.id,
        name: '',
        nameChangedAt: '',
        createdAt: '',
        updatedAt: '',
      },
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
    const list = await this.profiles.listByUserId(user.id);
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
    const firstProfile = await this.profiles.findFirstByUserId(user.id);
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

  // ---- 角色管理（Web）----

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
    await this.profiles.insert({ id, userId, name, now: this.now() });
    return (await this.profiles.findById(id))!;
  }

  async renameProfile(userId: string, profileId: string, newName: string): Promise<ProfileRow> {
    this.assertValidProfileName(newName);
    const profile = await this.profiles.findById(profileId);
    if (!profile || profile.userId !== userId) {
      throw new AppError('NOT_FOUND', '角色不存在');
    }
    // 初始命名（name_changed_at === created_at）不算改名，首次改名不受冷却限制
    const neverRenamed = profile.nameChangedAt === profile.createdAt;
    const elapsed = this.now().getTime() - new Date(profile.nameChangedAt).getTime();
    if (!neverRenamed && elapsed < NAME_COOLDOWN_MS) {
      const days = Math.ceil((NAME_COOLDOWN_MS - elapsed) / 86400000);
      throw new AppError('NAME_COOLDOWN', `改名冷却中，还需约 ${days} 天`);
    }
    if (await this.profiles.findByName(newName)) {
      throw new AppError('NAME_TAKEN', '该角色名已被占用');
    }
    await this.profiles.rename(profileId, newName, this.now());
    return (await this.profiles.findById(profileId))!;
  }

  async deleteProfile(userId: string, profileId: string): Promise<void> {
    const profile = await this.profiles.findById(profileId);
    if (!profile || profile.userId !== userId) {
      throw new AppError('NOT_FOUND', '角色不存在');
    }
    const count = await this.profiles.countByUserId(userId);
    if (count <= 1) {
      throw new AppError('VALIDATION_ERROR', '至少保留一个角色');
    }
    await this.profiles.delete(profileId);
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

    const hash = await bcrypt.hash(input.newPassword, BCRYPT_COST);
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
    const user = await this.loadUserForAuth(input.email);
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
    const profile = await this.profiles.findFirstByUserId(user.id);
    return {
      user: toPublicUser(user),
      profile: profile ?? {
        id: '',
        userId: user.id,
        name: '',
        nameChangedAt: '',
        createdAt: '',
        updatedAt: '',
      },
      token,
    };
  }

  // ---- Web 头像 / 管理员用户管理 ----

  /** 当前登录用户的默认角色皮肤（顶栏头像用） */
  async getMySkin(
    userId: string,
  ): Promise<{ profileId: string; profileName: string; skinUrl: string | null; model: string | null }> {
    const profile = await this.profiles.findFirstByUserId(userId);
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
