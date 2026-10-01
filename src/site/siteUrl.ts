import type { SettingRepository } from '../repositories/settingRepository.js';

/**
 * 站点地址解析（P5）。
 *
 * 存在两个容易混淆的地址，本模块负责把它们钉死成一个口径：
 *
 * 1. **站点根（origin）** —— 用户浏览器里访问的地址，如 `https://skin.example.com`。
 *    权威来源是后台设置项 `BASE_URL`（管理员会改域名，不能要求运维改 .env 重启）。
 *    用途：邮件里的验证/重置链接、界面展示的认证服务器地址。
 *
 * 2. **素材前缀（assetBaseUrl）** —— 纹理等静态资源的对外前缀，如
 *    `https://skin.example.com/uploads`。权威来源是环境变量 `PUBLIC_BASE_URL`，
 *    因为静态挂载点是**部署形态**的一部分（本地磁盘 / 将来 S3 会换成 CDN 域名），
 *    管理员在后台改它没有意义。未设置时才由站点根推导 `${origin}/uploads`。
 *
 * 为什么两者不能合并成一个：把素材前缀交给后台设置，就会出现「管理员把站点 URL
 * 填成域名 A，但资源实际由 CDN 域名 B 提供」这种无法表达的情况；反之让站点根
 * 由环境变量决定，则每次换域名都要动服务器配置。
 *
 * ## 同步 / 异步的分工
 *
 * `StoragePort.publicUrl()` 是同步方法（被 Yggdrasil 纹理 builder 等大量同步
 * 路径调用），不可能为了读一次数据库把它改成 async。因此这里把「读设置」收敛到
 * 显式的 `refresh()`：它把结果写进进程内缓存，之后所有同步 getter 读缓存。
 * 读取带 TTL（缺省 30s），并且管理端保存设置后会主动 `refresh()`，
 * 所以管理员改完地址是立即生效的，TTL 只是兜底。
 *
 * 缓存失败时不抛错：站点地址不是权威数据源，读不到就沿用上一次的值（或环境变量兜底），
 * 让请求继续，而不是把整个站点拖挂。与 CachePort 的错误契约保持一致。
 */

const DEFAULT_TTL_MS = 30 * 1000;
const DEFAULT_FALLBACK_PORT = 3000;
/**
 * 未声明站点根时的兜底：跟随实际监听端口。
 *
 * 写死 3000 会让换端口跑的实例（本地 rig、包内冒烟）签出指向别处的素材 URL ——
 * 签名是本站的、图却去另一个端口拉，基岩伴生插件与网页预览都会静默失败。
 */
function fallbackOrigin(port?: number): string {
  const p = typeof port === 'number' && Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_FALLBACK_PORT;
  return `http://localhost:${p}`;
}
/** 静态资源挂载点，与 server/app.ts 的 express.static 挂载路径必须一致 */
export const ASSET_MOUNT_PATH = '/uploads';

/** 本模块消费的站点设置键（BASE_URL 不进公开白名单，见 settingRepository） */
export const SiteUrlSettingKeys = {
  baseUrl: 'BASE_URL',
} as const;

/** 去掉结尾斜杠；空串原样返回 */
function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

/**
 * 把任意 URL / host 归一成「协议 + 主机」的站点根（去掉路径与尾斜杠）。
 * 只接受 http/https；解析不出协议时按 host 处理并补上 https。
 */
export function normalizeOrigin(raw: string): string | undefined {
  const value = raw.trim();
  if (value === '') return undefined;
  try {
    const url = new URL(value.includes('://') ? value : `https://${value}`);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return `${url.protocol}//${url.host}`;
  } catch {
    return undefined;
  }
}

/**
 * 从素材前缀反推站点根：`http://h:3000/uploads` → `http://h:3000`。
 * 只在没有 BASE_URL 设置、也没有其它线索时作为兜底使用，因此对
 * 不以 `/uploads` 结尾的值采取「原样当作站点根」而非报错。
 */
export function originFromAssetBase(assetBase: string): string {
  const trimmed = stripTrailingSlash(assetBase.trim());
  if (trimmed === '') return fallbackOrigin();
  if (trimmed.endsWith(ASSET_MOUNT_PATH)) {
    const stripped = stripTrailingSlash(
      trimmed.slice(0, -ASSET_MOUNT_PATH.length),
    );
    return stripped === '' ? fallbackOrigin() : stripped;
  }
  return trimmed;
}

export interface SiteUrlResolverDependencies {
  /** 站点设置仓储；未注入时只用环境变量兜底（测试场景） */
  settings?: Pick<SettingRepository, 'get'>;
  /** 环境变量 PUBLIC_BASE_URL；未提供时由站点根推导 */
  envPublicBaseUrl?: string;
  /** 环境变量 YGGDRASIL_SKIN_DOMAINS 的解析结果；非空则直接采用 */
  envSkinDomains?: string[];
  /** 缓存 TTL（毫秒）；0 = 每次读取都查库 */
  ttlMs?: number;
  /** 实际监听端口；只在站点根从未声明时用于兜底（见 fallbackOrigin） */
  listenPort?: number;
  /** 时钟可注入（测试） */
  now?: () => number;
}

export class SiteUrlResolver {
  private readonly settings?: Pick<SettingRepository, 'get'>;
  private readonly envAssetBaseUrl: string;
  private readonly envSkinDomains: string[];
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly listenPort: number | undefined;

  private origin: string;
  private assetBase: string;
  private loadedAt: number;
  /**
   * 站点根是否已被「显式声明」（后台 BASE_URL 或部署 PUBLIC_BASE_URL）。
   * false 时 origin 只是 localhost 兜底 —— 邮件链接允许用触发请求的 Host
   * 作为更准的猜测（见 link() 的 requestOrigin）。
   */
  private originDeclared: boolean;

  constructor(deps: SiteUrlResolverDependencies = {}) {
    this.settings = deps.settings;
    this.envAssetBaseUrl = stripTrailingSlash((deps.envPublicBaseUrl ?? '').trim());
    this.envSkinDomains = deps.envSkinDomains ?? [];
    this.ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
    this.now = deps.now ?? (() => Date.now());
    this.listenPort = deps.listenPort;

    // 构造时先用环境变量给出可用值，保证 refresh() 之前 getter 也不返回 undefined
    this.originDeclared = this.envAssetBaseUrl !== '';
    this.origin =
      this.envAssetBaseUrl !== ''
        ? originFromAssetBase(this.envAssetBaseUrl)
        : fallbackOrigin(this.listenPort);
    this.assetBase = this.computeAssetBase(this.origin);
    // loadedAt = 0 让首次 ensureFresh() 必定查库
    this.loadedAt = 0;
  }

  /** 素材前缀：环境变量优先（部署形态），否则由站点根推导 */
  private computeAssetBase(origin: string): string {
    return this.envAssetBaseUrl !== ''
      ? this.envAssetBaseUrl
      : `${origin}${ASSET_MOUNT_PATH}`;
  }

  /** TTL 内的读取直接返回缓存；TTL 到或从未加载过时才查库 */
  async ensureFresh(): Promise<void> {
    if (this.ttlMs > 0 && this.loadedAt !== 0 && this.now() - this.loadedAt < this.ttlMs) {
      return;
    }
    await this.refresh();
  }

  /**
   * 立即重读站点设置并刷新缓存。管理端保存设置后调用它，使地址改动即时生效。
   * 先把 loadedAt 推进再读库：并发调用时只有一个真正查库，其余看到新鲜时间戳直接返回，
   * 避免管理端连续保存时打出并发查询。读失败时沿用旧值，偏差由下一个 TTL 周期自愈。
   */
  async refresh(): Promise<void> {
    this.loadedAt = this.now();
    if (!this.settings) return;

    let raw: unknown;
    try {
      raw = await this.settings.get(SiteUrlSettingKeys.baseUrl);
    } catch {
      return;
    }

    const configured = typeof raw === 'string' ? stripTrailingSlash(raw.trim()) : '';
    if (configured !== '') {
      this.origin = configured;
      this.originDeclared = true;
    } else {
      this.originDeclared = this.envAssetBaseUrl !== '';
      this.origin = this.originFromEnv();
    }
    this.assetBase = this.computeAssetBase(this.origin);
  }

  /** 没有 BASE_URL 设置时的兜底站点根 */
  private originFromEnv(): string {
    if (this.envAssetBaseUrl !== '') {
      return originFromAssetBase(this.envAssetBaseUrl);
    }
    return fallbackOrigin(this.listenPort);
  }

  /** 站点根（无尾斜杠），同步读缓存 */
  originSync(): string {
    return this.origin;
  }

  /**
   * 站点根是否为**显式声明**的值（后台 BASE_URL 或部署 PUBLIC_BASE_URL）。
   * false 表示 origin 只是兜底猜测 —— 启动配置自检用它提醒「邮件链接会跟着请求 Host 走」。
   */
  isOriginDeclared(): boolean {
    return this.originDeclared;
  }

  /** 素材前缀（无尾斜杠），同步读缓存；供 StoragePort.publicUrl 使用 */
  assetBaseUrlSync(): string {
    return this.assetBase;
  }

  /**
   * Yggdrasil 元数据的 skinDomains。
   * 环境变量显式配置时以它为准（多域名/带点前缀等高级写法）；
   * 否则按 config.ts 的注释承诺，用站点根的 hostname 派生 —— 而不是返回空数组
   * 让下游自己去猜（那正是改动前注释与实现不符的地方）。
   */
  skinDomains(): string[] {
    if (this.envSkinDomains.length > 0) return [...this.envSkinDomains];
    try {
      return [new URL(this.origin).hostname];
    } catch {
      return ['localhost'];
    }
  }

  /**
   * 生成一个前端路由链接。前端用 HashRouter，所以路径要挂在 `#` 之后：
   * `https://host/#/verify-email?token=xxx`。写成 `https://host/verify-email`
   * 会让浏览器直接请求服务器而 404 —— 静态托管只看得到 `index.html`。
   *
   * `requestOrigin`：触发本次发信的请求方地址（协议 + Host）。
   * 仅当站点根从未显式声明（BASE_URL / PUBLIC_BASE_URL 都没配）时采用 ——
   * 否则域名服务器上没来得及配 BASE_URL 的新装站点，验证邮件会打出
   * localhost 链接（用户根本点不开）。显式声明永远优先，请求方 Host 只在
   * 兜底位上替换 localhost，不影响已配置站点的行为。
   */
  async link(
    path: string,
    query?: Record<string, string>,
    opts?: { requestOrigin?: string },
  ): Promise<string> {
    await this.ensureFresh();
    const normalized = path.startsWith('/') ? path : `/${path}`;
    const search = query
      ? `?${new URLSearchParams(query).toString()}`
      : '';
    return `${this.effectiveOrigin(opts?.requestOrigin)}/#${normalized}${search}`;
  }

  /** 站点根 + 指定绝对路径（用于非哈希路径，如 /uploads 之外的静态资源） */
  async absolute(path: string, opts?: { requestOrigin?: string }): Promise<string> {
    await this.ensureFresh();
    return `${this.effectiveOrigin(opts?.requestOrigin)}${path.startsWith('/') ? path : `/${path}`}`;
  }

  /** 未显式声明站点根时，用请求方 origin 替换 localhost 兜底；无效输入原样回落 */
  private effectiveOrigin(requestOrigin?: string): string {
    if (this.originDeclared) return this.origin;
    return normalizeOrigin(requestOrigin ?? '') ?? this.origin;
  }
}
