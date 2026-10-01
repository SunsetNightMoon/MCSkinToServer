import { createHash, randomBytes } from 'node:crypto';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { AppError } from '../errors.js';
import { MANIFEST_FILE, readManifest, validateManifest } from './manifest.js';
import type { PluginManifest } from './api.js';

/**
 * 从 GitHub 拉取插件源码装进插件目录（**只到「发现」为止，不启用**）。
 *
 * ## 为什么敢做这件事
 * 本站对插件的立场写在面板顶部那句提示里：站点只提供接口，装不装由超管决定，
 * 行为由安装者负责。所以导入器**不做**签名校验、不做沙盒、不承诺拦住恶意代码 ——
 * 那些都是假的安全感。它只保证三件确实能做到的事：
 *
 * 1. **来源可核对**：仓库里必须有一份标记文件（见 `PLUGIN_MARKER_DIR`），
 *    内容与 manifest 一致，证明这个仓库认领了这个识别代号；
 * 2. **版本可固定、且不用手输**：扫仓库的 tag，挑最新的**语义化版本**（`v1.2.3`），
 *    再把它解析成 commit sha 取文件 —— tag 可以被删掉重打，sha 不会；面板上记的就是那个 sha。
 *    认不出语义化版本就拒装（不再接受手输 tag / 分支 / 裸 sha：那正是「装错一份代码」的入口）；
 * 3. **落盘前可预览**：先列清单（文件、体积、manifest 摘要、标记核对结果）给超管过目，
 *    确认后才写盘；任何一项校验不过，磁盘上不会留下半个文件。
 *
 * ## 明确不做
 * 不解析 `package.json`、不装依赖、不跑任何作者提供的脚本。
 * 插件只能用 `plugin-api.d.ts` 里的契约与站点标准库；要第三方依赖，那是另一个决定。
 */

/** 识别代号标记文件的目录（仓库根）：`.mcsts-plugin/<id>.json` */
export const PLUGIN_MARKER_DIR = '.mcsts-plugin';

const API_BASE = 'https://api.github.com';
const RAW_BASE = 'https://raw.githubusercontent.com';

const MAX_FILES = 200;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
/** 一次导入要打好几个 GitHub 端点；没有超时的话，上游卡住就会一直占着这个请求 */
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * 只允许文本形态的文件落盘。
 * 二进制（含 .wasm / .exe / 图片）一律拒：本进程会 `import()` 这个目录里的代码，
 * 而「插件是纯文本、可以逐行读过」是对安装者最有用的保证。
 */
const ALLOWED_EXTENSIONS = new Set([
  '.ts',
  '.mts',
  '.cts',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.md',
  '.txt',
]);

const REPO_PATTERN = /^([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})$/;
const TAG_PATTERN = /^[A-Za-z0-9_.-]{1,200}$/;

/**
 * 可自动识别的发布 tag：语义化版本，允许 `v` 前缀与预发布后缀（`v1.2.3`、`1.2.3-rc.1`）。
 *
 * 为什么按语义化版本筛，而不是「取列表里最后一个 tag」：GitHub 的 `/tags` 返回顺序不是
 * 时间序，而仓库里常留着 `test`、`backup-2024`、`latest` 这类噪声 tag。装错一份代码是
 * 会被 `import()` 进来的，所以认不出语义化版本时宁可拒绝、要求作者把 tag 规范好。
 */
const SEMVER_TAG =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/** 一页取多少个 tag（GitHub 的上限就是 100） */
const TAGS_PER_PAGE = 100;
/**
 * 最多翻几页。3 页 = 300 个 tag，任何插件仓库都够；设上限是因为每页都要一次往返，
 * 而「一个仓库几千个 tag」多半是粘错了仓库，不该让面板跟着干等。
 */
const TAGS_MAX_PAGES = 3;

export interface ImportSource {
  /**
   * 仓库地址；**版本号由系统自动识别**，超管直接粘 clone 地址即可。
   *
   * 接受的形态见 `parseRepoInput`：`owner/name`、`https://github.com/o/r(.git)`、
   * `git@github.com:o/r.git`、`ssh://git@github.com/o/r.git`，以及
   * 「镜像前缀 + 完整 GitHub 地址」（`https://gh-proxy.com/https://github.com/o/r.git`）。
   *
   * 这个字段只决定「装哪个仓库」，**不决定往哪台主机发请求** —— 请求主机由部署侧的
   * `MCSTS_PLUGIN_MIRROR` 决定。分界是有意的：让面板输入直接决定请求目标，等于给
   * 超管账号开一个能打内网任意地址的探针（SSRF）。
   */
  repoInput: string;
  /** monorepo 里的子目录；仓库根就留空 */
  dir?: string;
}

export interface ImporterDeps {
  /** 安装目标根目录（MCSTS_PLUGIN_DIR） */
  pluginDir: string;
  now: () => Date;
  /**
   * 测试注入用的主机覆盖；默认打 GitHub 官方端点。
   * 显式给了它们就**不再套 `mirror`**，免得测试里悄悄打到真实镜像。
   */
  apiBase?: string;
  rawBase?: string;
  /**
   * 部署侧镜像前缀（`MCSTS_PLUGIN_MIRROR`）：把**每个**请求 URL 原样拼在它后面发出，
   * 例如 `https://gh-proxy.com` → `https://gh-proxy.com/https://api.github.com/repos/...`。
   * 给直连 GitHub 不畅的环境用；它必须同时转发 API 与 raw 两个域名，否则导入会在取清单
   * 或取文件那一步失败，而错误文案会带上实际请求的主机，不至于让人对着「fetch failed」猜。
   */
  mirror?: string;
  /** 私有仓库或限流时才需要；站点设置里不存，只读环境变量 */
  token?: string;
  fetchImpl?: typeof fetch;
}

export interface ImportFile {
  /** 仓库内路径（POSIX 分隔） */
  path: string;
  /** 落盘后的相对路径（相对插件目录） */
  local: string;
  size: number;
  /** git blob sha（= 内容本身，可与下载结果逐字节核对） */
  blobSha: string;
}

export interface ImportPreview {
  repo: string;
  /** 自动识别出来的发布 tag */
  tag: string;
  /** tag 解析出来的 commit sha */
  sha: string;
  dir: string;
  manifest: PluginManifest;
  marker: { path: string; ok: true } | { path: string; ok: false; reason: string };
  files: ImportFile[];
  totalBytes: number;
  /**
   * 扫过的 tag 个数（翻到的那些，不是全仓库）。列表里混着 `test`/`latest` 这类噪声时，
   * 超管需要看得见「它确实扫过多少个」才会信自动挑中的那一个。
   */
  tagsScanned: number;
  /**
   * 选中的 tag 去掉 `v` 前缀后是否等于 manifest 里写的 `version`。
   * **只提示、不拦**：作者在 `v1.2.3` 与 `1.2.3` 之间漂移是常态，硬拦会把能用的仓库拒掉；
   * 真正硬拦的是识别代号标记与逐字节 blob sha。不一致时面板上会看到一条警告。
   */
  versionMatchesManifest: boolean;
}

export interface ImportResult extends ImportPreview {
  installedTo: string;
  importedAt: string;
}

interface TreeEntry {
  path: string;
  type: string;
  sha: string;
  size?: number;
}

/** `GET /repos/{repo}/tags` 的一项；sha 可能是 tag 对象（附注 tag），所以还要再解析成 commit */
interface TagEntry {
  name: string;
  sha?: string;
}

function fail(message: string, detail?: string): never {
  throw new AppError('PLUGIN_IMPORT_REJECTED', detail ? `${message}：${detail}` : message);
}

/**
 * 完整（或嵌在镜像前缀里的）GitHub 仓库地址。
 * 名字段**贪婪**吃到下一个 `/`、`?` 或 `#` 为止，`.git` 交给 toRepo 去尾 ——
 * 用懒惰量词在这儿会栽：`demo-plugin` 会被截成 `d`。
 */
const GITHUB_REPO_URL = /https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]{1,100})\/([^/?#\s]+)/i;
/** `git@github.com:o/r(.git)` 与 `ssh://git@github.com/o/r(.git)` */
const GITHUB_SSH_URL =
  /^(?:ssh:\/\/)?git@github\.com[:/]([A-Za-z0-9_.-]{1,100})\/([^/?#\s]+)$/i;

function toRepo(owner: string | undefined, name: string | undefined): string | null {
  if (!owner || !name) return null;
  const clean = name.replace(/\.git$/, '');
  if (!REPO_PATTERN.test(`${owner}/${clean}`)) return null;
  return `${owner}/${clean}`;
}

/** 从一个 URL 里取主机名；不是合法 URL 时返回 null */
function urlHost(value: string): string | null {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** 错误文案用的「哪台主机」：带端口，测试里的假 GitHub 才分得清打在哪儿 */
function hostOf(value: string): string | null {
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
}

/**
 * 把超管粘进面板的各种写法归一成 `owner/name`。
 *
 * ## 为什么对「不是 github.com 的域名」直接拒绝，而不是照样取 owner/name
 *
 * 请求主机只由部署配置决定，所以粘 `https://gitee.com/o/r` 并不会打到 Gitee ——
 * 但那会被解析成 GitHub 上的同名仓库：**装回来的不是用户以为的那份代码**。
 * 认错仓库比报错严重，所以宁可拒并点名主机。
 *
 * 直连 GitHub 不畅的正解是把镜像配在 `MCSTS_PLUGIN_MIRROR`（部署侧），
 * 或者粘「镜像前缀 + 完整 GitHub 地址」这种形态 —— 后者照样能在这里挖出 github.com 段。
 */
export function parseRepoInput(input: unknown): string {
  const raw = String(input ?? '').trim().replace(/\/+$/, '');
  if (raw === '') fail('请填写插件仓库地址');

  const bare = REPO_PATTERN.exec(raw);
  const fromBare = toRepo(bare?.[1], bare?.[2]);
  if (fromBare) return fromBare;

  const https = GITHUB_REPO_URL.exec(raw);
  const fromHttps = toRepo(https?.[1], https?.[2]);
  if (fromHttps) return fromHttps;

  const ssh = GITHUB_SSH_URL.exec(raw);
  const fromSsh = toRepo(ssh?.[1], ssh?.[2]);
  if (fromSsh) return fromSsh;

  const host = urlHost(raw);
  if (host) {
    fail(
      `只支持 GitHub 的插件仓库，这个地址的主机是 ${host}`,
      '可以粘 https://github.com/owner/repo.git、git@github.com:owner/repo.git、owner/repo，' +
        '或「镜像前缀 + 完整 GitHub 地址」；直连不畅请让运维把镜像配在 MCSTS_PLUGIN_MIRROR',
    );
  }
  fail('认不出这个仓库地址', '请填写 owner/repo 或完整的 GitHub 仓库地址');
}

/** 语义化版本比较：a<b 返回 -1，a>b 返回 1，相等返回 0 */
function compareSemver(a: RegExpExecArray, b: RegExpExecArray): number {
  for (const i of [1, 2, 3] as const) {
    const left = BigInt(a[i]!);
    const right = BigInt(b[i]!);
    if (left !== right) return left < right ? -1 : 1;
  }
  const preA = a[4];
  const preB = b[4];
  // 「正式版 > 预发布版」是 semver 的规矩：1.2.3 要比 1.2.3-rc.1 新
  if (preA === undefined && preB === undefined) return 0;
  if (preA === undefined) return 1;
  if (preB === undefined) return -1;
  const partsA = preA.split('.');
  const partsB = preB.split('.');
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i += 1) {
    const left = partsA[i];
    const right = partsB[i];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    const leftNum = /^\d+$/.test(left);
    const rightNum = /^\d+$/.test(right);
    if (leftNum && rightNum) {
      const l = BigInt(left);
      const r = BigInt(right);
      if (l !== r) return l < r ? -1 : 1;
      continue;
    }
    if (leftNum !== rightNum) return leftNum ? -1 : 1; // 数字标识符优先级低于字母标识符
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}

/**
 * 从 tag 列表里挑出**最新的语义化版本**。认不出任何一个时返回 null（调用方据此拒绝导入）。
 *
 * 导出来单独一层是为了可测：这一条决定了「装的是哪一份代码」，而它完全不看网络返回的
 * 顺序 —— 拿真实 GitHub 数据没法稳定覆盖到 `1.2.10` vs `1.2.9`、`2.0.0-rc.1` vs `2.0.0`
 * 这些边界。
 */
export function newestSemverTag(tags: TagEntry[]): TagEntry | null {
  let best: TagEntry | null = null;
  let bestMatch: RegExpExecArray | null = null;
  for (const tag of tags) {
    const matched = SEMVER_TAG.exec(String(tag.name ?? '').trim());
    if (!matched) continue;
    if (bestMatch === null || compareSemver(matched, bestMatch) > 0) {
      best = tag;
      bestMatch = matched;
    }
  }
  return best;
}

function normalizeSource(source: ImportSource): { repo: string; dir: string } {
  const repo = parseRepoInput(source.repoInput);
  const rawDir = String(source.dir ?? '')
    .trim()
    .replace(/^\/+|\/+$/g, '');
  if (rawDir.includes('..') || rawDir.includes('\\') || /[\x00-\x1f]/.test(rawDir)) {
    fail('子目录路径不合法');
  }
  return { repo, dir: rawDir };
}

/** git 的 blob sha：`sha1("blob <len>\\0" + content)`，用来逐字节核对下载结果 */
function gitBlobSha(content: Buffer): string {
  return createHash('sha1')
    .update(`blob ${content.length}\u0000`, 'utf8')
    .update(content)
    .digest('hex');
}

function allowedExtension(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1);
  if (name === '' || name.startsWith('.')) return false;
  // 取最后一个点：`types.d.ts` 这类双扩展名要按 `.ts` 判，而不是 `.d`
  return ALLOWED_EXTENSIONS.has(name.slice(name.lastIndexOf('.')));
}

export class PluginImporter {
  private readonly apiBase: string;
  private readonly rawBase: string;
  /** 错误文案里点名「实际打的是哪台主机」：配了镜像却还写着 GitHub 会把人带偏 */
  private readonly upstream: string;

  constructor(private readonly deps: ImporterDeps) {
    // 镜像前缀把**完整请求 URL**（含协议与主机）拼在自己后面，这是 gh-proxy 一类的通用形态：
    // https://gh-proxy.com/https://api.github.com/repos/... 。显式注入的 apiBase/rawBase 优先，
    // 测试里打的都是假 GitHub 的本地地址，不该再被套进镜像前缀。
    const mirror = (deps.mirror ?? '').trim().replace(/\/+$/, '');
    const viaMirror = (base: string): string =>
      mirror === '' ? base : `${mirror}/${base}`;
    this.apiBase = (deps.apiBase ?? viaMirror(API_BASE)).replace(/\/+$/, '');
    this.rawBase = (deps.rawBase ?? viaMirror(RAW_BASE)).replace(/\/+$/, '');
    this.upstream = hostOf(this.apiBase) ?? this.apiBase;
  }

  private async send(url: string, notFound: string): Promise<Response> {
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'user-agent': 'mcsts-plugin-importer',
    };
    if (this.deps.token) headers['authorization'] = `Bearer ${this.deps.token}`;
    const impl = this.deps.fetchImpl ?? fetch;
    let res: Response;
    try {
      res = await impl(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (err) {
      // 「问不到上游」不是「你填错了仓库」：给 502 + 可重试的文案，
      // 而不是让它冒成 500「内部错误」（实测面板上就只剩这四个字，看不出根因）
      throw new AppError(
        'PLUGIN_IMPORT_UNREACHABLE',
        `无法访问 ${this.upstream}：${describeNetworkError(err)}`,
        { cause: err instanceof Error ? err : undefined },
      );
    }
    if (res.status === 404) fail(notFound);
    if (res.status === 403 || res.status === 429 || res.status >= 500) {
      throw new AppError(
        'PLUGIN_IMPORT_UNREACHABLE',
        `${this.upstream} 返回 ${res.status}（限流或上游故障），请稍后重试；私有仓库需要配 MCSTS_GH_TOKEN`,
      );
    }
    if (!res.ok) fail(`${this.upstream} 返回 ${res.status}`, url.replace(/^https?:\/\//, ''));
    return res;
  }

  private async json<T>(url: string, notFound: string): Promise<T> {
    const res = await this.send(url, notFound);
    return (await res.json()) as T;
  }

  private async buffer(url: string, notFound: string): Promise<Buffer> {
    const res = await this.send(url, notFound);
    return Buffer.from(await res.arrayBuffer());
  }

  /** tag → commit sha。只认 tag，且后续所有取文件都按 sha 走，不受 tag 被重打影响 */
  private async resolveTag(repo: string, tag: string): Promise<string> {
    const body = await this.json<{ sha?: string }>(
      `${this.apiBase}/repos/${repo}/commits/${encodeURIComponent(tag)}`,
      `GitHub 上没有这个 tag：${repo}@${tag}`,
    );
    if (typeof body.sha !== 'string' || body.sha.length < 7) fail('无法把 tag 解析成 commit sha');
    return body.sha;
  }

  /**
   * 取 tag 列表（分页翻到没有为止，最多 `TAGS_MAX_PAGES` 页）。
   * 顺序**刻意不信任**：GitHub 的 `/tags` 返回顺序不是时间序，挑版本全靠语义化比较。
   */
  private async listTags(repo: string): Promise<TagEntry[]> {
    const collected: TagEntry[] = [];
    for (let page = 1; page <= TAGS_MAX_PAGES; page += 1) {
      const body = await this.json<TagEntry[]>(
        `${this.apiBase}/repos/${repo}/tags?per_page=${TAGS_PER_PAGE}&page=${page}`,
        `GitHub 上取不到 ${repo} 的 tag 列表（仓库不存在、改名了，或私有而没配 MCSTS_GH_TOKEN）`,
      );
      if (!Array.isArray(body)) break;
      collected.push(...body);
      if (body.length < TAGS_PER_PAGE) break;
    }
    return collected;
  }

  /**
   * 自动识别发布版本：列 tag → 挑最新的语义化版本 → 解析成 commit sha。
   *
   * 认不出任何一个语义化 tag 就**拒绝**，并列出扫到的那些让作者知道该改什么。
   * 这里不给「用默认分支 HEAD」的口子：分支会往前走，而导入的承诺是
   * 「预览看到的那一份 = 装进磁盘的那一份」，只有 tag→sha 撑得住这句话。
   */
  private async pickRelease(repo: string): Promise<{ tag: string; sha: string; scanned: number }> {
    const tags = await this.listTags(repo);
    const chosen = newestSemverTag(tags);
    if (!chosen) {
      fail(
        tags.length === 0
          ? `仓库 ${repo} 一个 tag 都没有`
          : `仓库 ${repo} 没有可识别的语义化版本 tag（形如 v1.2.3）`,
        tags.length === 0
          ? '插件按 tag 发布，才能保证预览与安装拿到同一份代码；请先在插件仓库打一个语义化版本 tag'
          : `扫过的 tag：${tags
              .slice(0, 8)
              .map((item) => item.name)
              .join('、')}${tags.length > 8 ? '…' : ''}`,
      );
    }
    if (!TAG_PATTERN.test(chosen.name)) {
      fail(`识别到的 tag「${chosen.name}」不能安全地用于请求`, 'tag 名只能含字母、数字、点、下划线和连字符');
    }
    return { tag: chosen.name, sha: await this.resolveTag(repo, chosen.name), scanned: tags.length };
  }

  private async tree(repo: string, sha: string): Promise<TreeEntry[]> {
    const body = await this.json<{ tree?: TreeEntry[]; truncated?: boolean }>(
      `${this.apiBase}/repos/${repo}/git/trees/${sha}?recursive=1`,
      `取不到 ${repo}@${sha.slice(0, 10)} 的文件清单`,
    );
    if (body.truncated === true) {
      fail('仓库文件清单被 GitHub 截断', '插件目录请放在独立仓库或浅子目录里，超大仓库无法核对全量文件');
    }
    if (!Array.isArray(body.tree)) fail('拿不到文件清单');
    return body.tree;
  }

  /**
   * 预览：把要装的东西摊开给超管看。
   * 这一步不写盘；任何校验不过都直接抛错，磁盘上不留痕迹。
   */
  async preview(source: ImportSource): Promise<ImportPreview> {
    const src = normalizeSource(source);
    const release = await this.pickRelease(src.repo);
    const sha = release.sha;
    const entries = await this.tree(src.repo, sha);

    const inDir = (path: string): boolean => (src.dir === '' ? true : path.startsWith(`${src.dir}/`));
    const blobs = entries.filter(
      (item) => item.type === 'blob' && !item.path.startsWith('.git/') && inDir(item.path),
    );

    const manifestPath = joinPosix(src.dir, MANIFEST_FILE);
    const manifestEntry = blobs.find((item) => item.path === manifestPath);
    if (!manifestEntry) {
      fail(`插件目录里找不到 ${MANIFEST_FILE}`, src.dir === '' ? MANIFEST_FILE : `${src.dir}/${MANIFEST_FILE}`);
    }

    const manifestContent = await this.buffer(
      `${this.rawBase}/${src.repo}/${sha}/${encodePath(manifestPath)}`,
      `清单里有 ${manifestPath}，下载却取不到它`,
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(manifestContent.toString('utf8'));
    } catch (err) {
      return fail(`${MANIFEST_FILE} 不是合法 JSON`, err instanceof Error ? err.message : String(err));
    }
    const checked = validateManifest(parsed, []);
    if (!checked.ok) {
      fail(
        `${MANIFEST_FILE} 校验未通过`,
        checked.issues.map((i) => `${i.field}: ${i.message}`).join('；'),
      );
    }
    const manifest = checked.manifest;

    // 识别代号标记：仓库根的 .mcsts-plugin/<id>.json，内容与 manifest 一致
    const markerPath = `${PLUGIN_MARKER_DIR}/${manifest.id}.json`;
    const markerEntry = entries.find((item) => item.type === 'blob' && item.path === markerPath);
    let marker: ImportPreview['marker'];
    if (!markerEntry) {
      marker = {
        path: markerPath,
        ok: false,
        reason: `仓库里没有 ${markerPath}：无法证明这个仓库认领了识别代号 ${manifest.id}`,
      };
    } else {
      const markerContent = await this.buffer(
        `${this.rawBase}/${src.repo}/${sha}/${encodePath(markerPath)}`,
        `清单里有 ${markerPath}，下载却取不到它`,
      );
      marker = checkMarker(markerContent, markerPath, manifest, src.repo);
    }

    const files: ImportFile[] = [];
    let total = 0;
    const rejected: string[] = [];
    for (const item of blobs) {
      if (item.path.startsWith(`${PLUGIN_MARKER_DIR}/`)) continue;
      const local = src.dir === '' ? item.path : item.path.slice(src.dir.length + 1);
      if (local === '' || local.includes('..') || local.startsWith('/')) {
        rejected.push(`${item.path}（越出插件目录）`);
        continue;
      }
      if (!allowedExtension(item.path)) {
        rejected.push(`${item.path}（不是允许的文本文件类型）`);
        continue;
      }
      const size = typeof item.size === 'number' ? item.size : 0;
      if (size > MAX_FILE_BYTES) {
        rejected.push(`${item.path}（单文件 ${size} B 超过 ${MAX_FILE_BYTES} B）`);
        continue;
      }
      total += size;
      files.push({ path: item.path, local, size, blobSha: item.sha });
    }
    if (rejected.length > 0) {
      fail('文件清单里有不允许的内容', rejected.slice(0, 8).join('、'));
    }
    if (files.length === 0 || files.length > MAX_FILES) {
      fail(`插件文件数 ${files.length} 不在 1-${MAX_FILES} 范围内`);
    }
    if (total > MAX_TOTAL_BYTES) {
      fail(`插件总体积 ${total} B 超过 ${MAX_TOTAL_BYTES} B`);
    }
    if (!files.some((item) => item.path === manifestPath)) {
      fail(`${MANIFEST_FILE} 没进文件清单`);
    }

    return {
      repo: src.repo,
      tag: release.tag,
      sha,
      dir: src.dir,
      manifest,
      marker,
      files,
      totalBytes: total,
      tagsScanned: release.scanned,
      // 只把 `v` 前缀去掉就比：作者普遍在 tag 上写 v1.2.3、manifest 里写 1.2.3
      versionMatchesManifest:
        release.tag.replace(/^v/i, '') === String(manifest.version ?? '').trim(),
    };
  }

  /**
   * 安装：按预览给出的 sha 重新取一遍并逐字节核对，最后原子换目录。
   *
   * `sha` 必须由预览带回来，安装时再解析一次 tag 做比对 —— 否则「预览看到的」和
   * 「实际装进磁盘的」可能不是同一份东西（tag 被人重打过）。
   */
  async install(source: ImportSource, expectedSha: string, actor: string, replace: boolean): Promise<ImportResult> {
    const plan = await this.preview(source);
    if (plan.sha !== expectedSha) {
      fail(
        '仓库的发布版本在预览之后变了',
        `预览时是 ${expectedSha.slice(0, 10)}（自动选中的 tag 也可能换了），现在是 ${plan.sha.slice(0, 10)}；` +
          '请重新预览后再安装 —— 要装的就该是预览里看过的那一份',
      );
    }
    if (!plan.marker.ok) fail('识别代号标记未通过，不能安装', plan.marker.reason);

    const target = join(this.deps.pluginDir, plan.manifest.id);
    const exists = await stat(target).then(() => true).catch(() => false);
    if (exists && !replace) {
      fail(`插件 ${plan.manifest.id} 已经装在目录里`, '要覆盖请先在面板上勾选确认替换');
    }

    const stagingRoot = join(this.deps.pluginDir, `.import-${randomBytes(6).toString('hex')}`);
    const staging = join(stagingRoot, plan.manifest.id);
    await mkdir(staging, { recursive: true });
    try {
      for (const file of plan.files) {
        const content = await this.buffer(
          `${this.rawBase}/${plan.repo}/${plan.sha}/${encodePath(file.path)}`,
          `清单里有 ${file.path}，下载却取不到它`,
        );
        if (content.length > MAX_FILE_BYTES) {
          fail(`${file.path} 实际体积超过上限`);
        }
        if (gitBlobSha(content) !== file.blobSha) {
          fail(`${file.path} 内容与仓库清单不符`, '下载结果被改动过，安装中止');
        }
        const dest = join(staging, file.local);
        await mkdir(dirname(dest), { recursive: true });
        await writeFile(dest, content);
      }

      const provenance = {
        repo: plan.repo,
        tag: plan.tag,
        sha: plan.sha,
        importedAt: this.deps.now().toISOString(),
        importedBy: actor,
        files: plan.files.map((item) => ({ path: item.local, size: item.size, blobSha: item.blobSha })),
      };
      await writeFile(join(staging, '.mcsts-import.json'), `${JSON.stringify(provenance, null, 2)}\n`, 'utf8');

      // 落盘前最后一道闸：暂存目录里的 manifest 必须能被加载器同一套校验读通
      const recheck = await readManifest(staging);
      if (!recheck.ok || recheck.manifest.id !== plan.manifest.id) {
        fail(
          '暂存目录里的 manifest 读不过加载器校验',
          recheck.ok ? 'id 与预览不一致' : recheck.issues.map((i) => `${i.field}: ${i.message}`).join('；'),
        );
      }

      const backup = exists ? `${target}.replacing-${randomBytes(4).toString('hex')}` : undefined;
      if (backup) await rename(target, backup);
      try {
        await rename(staging, target);
      } catch (err) {
        if (backup) await rename(backup, target).catch(() => undefined);
        throw err;
      }
      if (backup) await rm(backup, { recursive: true, force: true }).catch(() => undefined);
    } finally {
      // 成功时 staging 已被 rename 走，这里只会删掉空的暂存根；失败时清掉半成品
      await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    }

    return { ...plan, installedTo: target, importedAt: this.deps.now().toISOString() };
  }
}

/**
 * Node 的 `fetch` 把真实原因藏在 `err.cause` 里（`fetch failed` 本身没有信息量）。
 * 超管要能一眼看出是 DNS 不通、连不上还是超时，否则只能对着「fetch failed」猜。
 */
function describeNetworkError(err: unknown): string {
  const e = err as { message?: string; cause?: { message?: string; code?: string } } | undefined;
  // code（UND_ERR_* / ENOTFOUND / ECONNREFUSED）与 message 都要带：
  // 前者区分「DNS 不通 / 连不上 / 超时」，后者给人看
  const detail = [e?.cause?.message, e?.cause?.code].filter(Boolean).join(' ');
  return [e?.message, detail].filter(Boolean).join('：') || String(err);
}

function joinPosix(dir: string, file: string): string {
  return dir === '' ? file : `${dir}/${file}`;
}

/** raw 端点要按路径段编码，但不能把 `/` 也编掉 */
function encodePath(path: string): string {
  return path.split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

function checkMarker(
  content: Buffer,
  markerPath: string,
  manifest: PluginManifest,
  repo: string,
): ImportPreview['marker'] {
  let marker: unknown;
  try {
    marker = JSON.parse(content.toString('utf8'));
  } catch (err) {
    return {
      path: markerPath,
      ok: false,
      reason: `${markerPath} 不是合法 JSON：${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (typeof marker !== 'object' || marker === null || Array.isArray(marker)) {
    return { path: markerPath, ok: false, reason: `${markerPath} 必须是 JSON 对象` };
  }
  const record = marker as Record<string, unknown>;
  const mismatches: string[] = [];
  if (record['id'] !== manifest.id) mismatches.push(`id ${String(record['id'])} ≠ ${manifest.id}`);
  if (record['name'] !== manifest.name) mismatches.push(`name ${String(record['name'])} ≠ ${manifest.name}`);
  if (record['author'] !== (manifest.author ?? '')) {
    mismatches.push(`author ${String(record['author'])} ≠ ${manifest.author ?? '(manifest 未填 author)'}`);
  }
  if (record['repository'] !== repo) mismatches.push(`repository ${String(record['repository'])} ≠ ${repo}`);
  if (mismatches.length > 0) {
    return { path: markerPath, ok: false, reason: `标记与 manifest 不一致：${mismatches.join('；')}` };
  }
  return { path: markerPath, ok: true };
}
