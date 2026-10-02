/**
 * 插件系统的**对外契约**（唯一允许插件作者依赖的类型来源）。
 *
 * ## 责任边界（写在这里，因为它是接口设计的前提）
 *
 * 本项目只提供接口，供开发者制作功能性插件；**安装与启用是超级管理员的决定**。
 * 插件在本进程内运行，因此本项目不对某个插件的行为负责，也不假装能关住它 ——
 * 恶意代码在进程内是关不住的，任何「沙盒」都是假安全感。这里刻意做的是另一件事：
 * 让接口稳定、让 manifest 与实际行为可比对、让装了什么看得见。
 *
 * 由此推出三条规矩：
 * 1. 插件**不 import 本体任何内部模块**，只接 `PluginContext`。类型来自本文件
 *    （作者侧复制一份 `plugin-api.d.ts`）。这样核心内部怎么重构都不影响插件。
 * 2. 兼容性只承诺 `PLUGIN_API_VERSION`：本文件里已发布成员只加不改不删，
 *    破坏性改动就把这个整数 +1，加载器在版本不匹配时直接拒载并说清原因。
 * 3. 表名前缀 `plugin_<id>_` 是**约定 + 助手函数**（`ctx.table()`），不是安全边界；
 *    它防的是无意撞名，不防恶意。
 */

/** 插件 API 版本。破坏性改动必须 +1，同时在开发日志记一次「为什么必须破坏」。 */
export const PLUGIN_API_VERSION = 1;

/** 插件 id 的合法形态：必须是合法 SQL 标识符片段（前缀方案依赖它），且不允许连字符 */
export const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9_]{1,31}$/;

/** manifest 里声明的外部依赖（例如 GeyserMC —— 没有它基岩玩家进不了 Java 服务器） */
export interface PluginRequirement {
  id: string;
  label: string;
  /** 给人看的话：为什么需要、缺了会怎样。不许写成技术检测，我们探测不到对方的服务器 */
  note?: string;
}

/** 插件自有设置的声明；`secret` 型走加密入库 + 面板只回 `_SET` 标志的既有口径 */
export interface PluginSettingSpec {
  key: string;
  type: 'string' | 'int' | 'bool' | 'secret';
  label: string;
  hint?: string;
  default?: string | number | boolean;
}

/** HTTP 入口声明。加载器会拒绝注册未在 manifest 里声明过的路径 —— 这是「manifest 与实际行为一致」的技术落实 */
export interface PluginEndpointSpec {
  /** 'router' = 走站点会话/角色鉴权（网页用）；'hooks' = 走机器回调（HMAC 或公开） */
  kind: 'router' | 'hooks';
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** 相对路径；router 挂在 /api/plugins/<id><path>，hooks 挂在 /api/plugins/<id>/hooks<path> */
  path: string;
  auth: 'public' | 'user' | 'admin' | 'super' | 'hmac';
  /** 声明用途，面板上显示给超管看 */
  note?: string;
  rateLimit?: { max: number; windowMs: number };
}

/** ============ 通用绑定页（账号设置区）============ */

/**
 * 绑定主体与（可选的）玩家输入声明：
 * - `subject='profile'`：每个角色一条绑定，页面给角色选择器，核心验属后把 profileId/profileName 交给插件；
 * - `subject='account'`：整个账号一条，插件收到的 profileId 恒为 null；
 * - `input`：声明了才允许插件登记 `claim()` —— 绑定页会出现一个输入框（如填 XUID），
 *   `pattern` 由**核心预校验**后才把值交给插件，插件收到的 value 一定合格式。
 */
export interface PluginBindingInput {
  label: string;
  hint?: string;
  /** 输入格式正则（如 "^[0-9]{6,21}$"）；核心在 claim 到达插件前用它挡掉不合格式的值 */
  pattern?: string;
  placeholder?: string;
}

export interface PluginBindingSpec {
  subject: 'account' | 'profile';
  input?: PluginBindingInput;
  /** 写 false 表示不提供一次性码模式：核心不要求 issue 处理器、issue 路由回 501、目录 issuable=false（绑定页收起生成码按钮） */
  issue?: boolean;
}

/** 核心完成会话鉴权与角色归属校验之后交给处理器的操作者 */
export interface PluginBindingActor {
  userId: string;
  profileId: string | null;
  /** profileId 对应角色的当前名字；subject='account' 时为 null */
  profileName: string | null;
  role: 'user' | 'admin' | 'super_admin';
  ip: string;
}

export interface PluginBindingField {
  label: string;
  value: string;
  /** 敏感值（如 XUID——申请制下泄露即可被抢注）：页面默认整串打星，玩家点眼睛自行查看 */
  secret?: boolean;
}

/** 绑定列表里的一行。id 是解绑句柄，必须在本插件内唯一（例如 XUID） */
export interface PluginBindingRow {
  id: string;
  /** 页面按声明顺序渲染的键值对 */
  fields: PluginBindingField[];
  /** ISO 时间，页面显示「何时绑定」 */
  boundAt?: string;
  /** 签发态标签：pending=等待远端确认（如玩家申请后还没进过服）；不填按 active 渲染 */
  status?: 'pending' | 'active';
}

export interface PluginBindingListResult {
  bindings: PluginBindingRow[];
  /** 给玩家的游戏内操作说明；页面会把其中的 {{code}} 替换成刚生成的码 */
  instructions?: string;
}

export interface PluginBindingIssueResult {
  /** 展示给玩家的短码。绑定类流程建议直接用 ctx.tokens.issue() 返回的 token */
  code: string;
  /** ISO 过期时间，页面据此做倒计时 */
  expiresAt: string;
}

export interface PluginBindingClaimResult {
  /** 原样显示给玩家的回执文案（作者语言，框架不翻译）；不填用页面的通用成功提示 */
  message?: string;
}

/**
 * 通用绑定页的处理函数集合，经 `ctx.binding()` 登记。
 *
 * 页面路由（/api/plugins/<id>/binding 一族）与发现目录都由核心提供，插件只登记行为；
 * 返回值形态由核心在运行时校验 —— 契约违背会明确报错，而不是渲染出半坏页面。
 */
export interface PluginBindingHandlers {
  list(actor: PluginBindingActor): PluginBindingListResult | Promise<PluginBindingListResult>;
  /**
   * 一次性码入口。默认必须登记；manifest 写了 `binding.issue:false` 时改为**必须不登记**
   * （核心把 issue 路由收成 501，登记了也永远跑不到）。纯申请制插件走 issue:false + claim。
   */
  issue?(actor: PluginBindingActor): PluginBindingIssueResult | Promise<PluginBindingIssueResult>;
  /** 不登记则页面不提供解绑按钮（有些绑定只许管理员清） */
  revoke?(actor: PluginBindingActor & { bindingId: string }): void | Promise<void>;
  /**
   * 玩家提交一个值发起申请（如网页侧填 XUID）。只有 manifest 声明了 `binding.input` 才允许登记；
   * value 已由核心按声明的 pattern 预校验。典型配对：远端服务器在**实测到该身份进服**时
   * 经 hooks 把它确认生效（status pending → active）—— 申请是意愿，进服是持有证明。
   */
  claim?(actor: PluginBindingActor & { value: string }): void | PluginBindingClaimResult | Promise<void | PluginBindingClaimResult>;
}

/** mcsts.plugin.json 的结构 */
export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  apiVersion: number;
  /** 展示与提示用（不做假精确的版本比较） */
  mcsts?: string;
  /** 入口文件（相对插件目录），如 'index.ts' */
  main: string;
  description?: string;
  author?: string;
  requires?: PluginRequirement[];
  settings?: PluginSettingSpec[];
  endpoints?: PluginEndpointSpec[];
  /**
   * 声明「这个插件要在账号设置区的通用绑定页出现」。
   * 没声明却调用 `ctx.binding()` → 拒载（与 endpoints 同一套「声明可核」逻辑）。
   */
  binding?: PluginBindingSpec;
}

/** 插件里注册的处理函数拿到的请求视图：只给需要的字段，不把 Express 的整个 req 交出去 */
export interface PluginRequest {
  method: string;
  /** manifest 里声明的那段路径（不含挂载前缀） */
  path: string;
  params: Record<string, string>;
  query: Record<string, string>;
  /** 已解析的 JSON 体；无体时为 {} */
  body: Record<string, unknown>;
  header(name: string): string | undefined;
  /** 来源 IP（已按 TRUST_PROXY 规则解析） */
  ip: string;
  /** auth 为 user/admin/super 时有值 */
  user: { userId: string; profileId: string | null; role: 'user' | 'admin' | 'super_admin' } | null;
}

/**
 * 响应的最小面。刻意不复用 Express 的 Response 类型：插件作者在仓库外，
 * 不该因此装一遍 express 依赖；窄接口也让我们以后换框架时不必改契约。
 */
export interface PluginResponse {
  status(code: number): PluginResponse;
  setHeader(name: string, value: string | number): PluginResponse;
  json(body: unknown): void;
  send(body: string | Uint8Array): void;
}

export type PluginHandler = (req: PluginRequest, res: PluginResponse) => void | Promise<void>;

export interface PluginRouteOptions {
  method: PluginEndpointSpec['method'];
  path: string;
  auth: PluginEndpointSpec['auth'];
  rateLimit?: { max: number; windowMs: number };
}

/** 窄化的数据库入口。SQL 由插件自己写，表名请用 `ctx.table()` 拼 */
export interface PluginDb {
  readonly dialect: 'sqlite' | 'postgres';
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  run(sql: string, params?: unknown[]): Promise<void>;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: () => Promise<T>): Promise<T>;
}

export interface PluginSettings {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
  /**
   * HMAC 类密钥的便捷读取：返回的是**明文**（已解密），
   * 只给插件用，永远不会经面板回传。
   */
  getSecret(key: string): Promise<string | null>;
}

/**
 * 一次性令牌：绑定流程（网页生成码 → 游戏内消费码）需要它。
 *
 * 这个原语由框架提供而不是让插件各自实现，是因为**消费必须是原子的**：
 * 「查一下没用过再标记已用」是两个语句，双击或客户端预取就会并发命中同一枚。
 * consume() 把全部判定写进 UPDATE 的 WHERE，靠数据库原子性定胜负（更新 1 行才算赢）。
 */
export interface PluginTokenRow {
  id: string;
  /** 插件自定义的归属键（例如角色 UUID） */
  subject: string;
  data: Record<string, unknown>;
  expiresAt: string;
}

export interface PluginTokens {
  issue(input: {
    subject: string;
    ttlMs: number;
    data?: Record<string, unknown>;
  }): Promise<{ token: string; expiresAt: string }>;
  /** 明文令牌 → 行；无效/过期/已被消费一律返回 null（不区分，避免变成探测器） */
  consume(token: string): Promise<PluginTokenRow | null>;
  purgeExpired(): Promise<number>;
}

export type PluginEventName =
  | 'user.registered'
  | 'profile.renamed'
  | 'profile.reserved'
  | 'profile.deleted'
  | 'account.purged';

export interface PluginEventPayloads {
  'user.registered': { userId: string; profileId: string; profileName: string };
  'profile.renamed': { userId: string; profileId: string; from: string; to: string };
  /**
   * 角色被换下、转为预留（多→单切换、或单模式下换 ID 换下旧角色）。
   * 角色没删（名字占位防抢注），但它不再是该账号的可用身份 ——
   * 把「身份 ↔ 外部账号」绑在一起的插件应据此丢弃该角色的绑定（释放对方身份供重绑）。
   */
  'profile.reserved': { userId: string; profileId: string; name: string };
  'profile.deleted': { userId: string; profileId: string; name: string };
  'account.purged': { userId: string; profileIds: string[] };
}

export interface PluginEvents {
  on<K extends PluginEventName>(
    name: K,
    handler: (payload: PluginEventPayloads[K]) => void | Promise<void>,
  ): void;
}

export interface PluginLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/** 站点侧只读信息（够用即可，不给配置对象本体） */
export interface PluginSite {
  siteTitle(): Promise<string>;
  /** 站点对外根（BASE_URL 未配时按请求 Host 兜底的那套解析） */
  publicOrigin(): Promise<string>;
  /**
   * 站点 Yggdrasil RSA **公钥**（PEM）。用途：伴生插件把玩家带来的 textures property
   * 发回来验签 —— 只有本站私钥签得出的签名才过，等于「验签证是否真实存在」。
   * 只给公钥；私钥永远不经插件 API 出手。站点尚未生成密钥时返回 null。
   */
  publicKeyPem(): Promise<string | null>;
}

/** 站点 Yggdrasil 签名链产出的纹理 property（与启动器 hasJoined 同一条构建链路） */
export interface PluginTextureProperty {
  /** base64 的 textures JSON（含 SKIN/CAPE 的 url 与 model） */
  value: string;
  /** RSA-SHA1 签名（base64）；站点无私钥时为 null */
  signature: string | null;
}

/** 纹理能力：给伴生端（如基岩服务器）取「某角色当前皮肤/披风」的签名 property */
export interface PluginTextures {
  /**
   * 构建指定角色当前生效素材的纹理 property；角色不存在返回 null。
   * 被拒素材与预留角色已在仓储层排除；角色没皮肤时 value 里就没有 SKIN 项，由调用方决定回落。
   */
  buildProperty(profileId: string): Promise<PluginTextureProperty | null>;
}

export interface PluginContext {
  readonly pluginId: string;
  /** 拼出带前缀的表名：ctx.table('bindings') → 'plugin_bedrock_link_bindings' */
  table(name: string): string;
  db: PluginDb;
  settings: PluginSettings;
  tokens: PluginTokens;
  textures: PluginTextures;
  events: PluginEvents;
  site: PluginSite;
  logger: PluginLogger;
  /** 网页侧入口（站点会话/角色鉴权） */
  route(options: PluginRouteOptions, handler: PluginHandler): void;
  /** 机器回调入口（HMAC 或公开）；实际路径带 /hooks 前缀 */
  hook(options: PluginRouteOptions, handler: PluginHandler): void;
  /**
   * 接入账号设置区的通用绑定页；manifest 必须先声明 `binding`，否则拒载。
   * 一个插件只能登记一次；`revoke` 不登记就没有解绑按钮。
   */
  binding(handlers: PluginBindingHandlers): void;
}

/** setup 返回的清理函数：插件被停用时调用（摘事件回调、关掉自己的连接等） */
export type PluginDispose = () => void | Promise<void>;

/**
 * 插件入口的默认导出签名。同步返回 dispose、或 await 完初始化再返回都合法 ——
 * 建表天然是异步的，只允许同步返回会逼作者把初始化甩成无人管的悬空 Promise。
 */
export type PluginSetup = (
  ctx: PluginContext,
) => PluginDispose | void | Promise<PluginDispose | void>;

export interface PluginEntry {
  default?: PluginSetup;
  setup?: PluginSetup;
}
