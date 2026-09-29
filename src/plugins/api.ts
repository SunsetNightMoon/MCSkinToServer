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
  | 'profile.deleted'
  | 'account.purged';

export interface PluginEventPayloads {
  'user.registered': { userId: string; profileId: string; profileName: string };
  'profile.renamed': { userId: string; profileId: string; from: string; to: string };
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
}

export interface PluginContext {
  readonly pluginId: string;
  /** 拼出带前缀的表名：ctx.table('bindings') → 'plugin_bedrock_link_bindings' */
  table(name: string): string;
  db: PluginDb;
  settings: PluginSettings;
  tokens: PluginTokens;
  events: PluginEvents;
  site: PluginSite;
  logger: PluginLogger;
  /** 网页侧入口（站点会话/角色鉴权） */
  route(options: PluginRouteOptions, handler: PluginHandler): void;
  /** 机器回调入口（HMAC 或公开）；实际路径带 /hooks 前缀 */
  hook(options: PluginRouteOptions, handler: PluginHandler): void;
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
