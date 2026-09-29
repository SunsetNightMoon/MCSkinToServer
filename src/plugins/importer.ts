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
 * 2. **版本可固定**：只接受 tag，并且把它解析成 commit sha 后再取文件 ——
 *    tag 可以被删掉重打，sha 不会；面板上记的就是那个 sha；
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

export interface ImportSource {
  /** `owner/name` */
  repo: string;
  /** 只接受 tag；分支与裸 sha 都不给（见文件头说明） */
  tag: string;
  /** monorepo 里的子目录；仓库根就留空 */
  dir?: string;
}

export interface ImporterDeps {
  /** 安装目标根目录（MCSTS_PLUGIN_DIR） */
  pluginDir: string;
  now: () => Date;
  /** 测试注入用；默认打 GitHub 官方端点 */
  apiBase?: string;
  rawBase?: string;
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
  tag: string;
  /** tag 解析出来的 commit sha */
  sha: string;
  dir: string;
  manifest: PluginManifest;
  marker: { path: string; ok: true } | { path: string; ok: false; reason: string };
  files: ImportFile[];
  totalBytes: number;
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

function fail(message: string, detail?: string): never {
  throw new AppError('PLUGIN_IMPORT_REJECTED', detail ? `${message}：${detail}` : message);
}

function normalizeSource(source: ImportSource): { owner: string; name: string; repo: string; tag: string; dir: string } {
  const matched = REPO_PATTERN.exec(String(source.repo ?? '').trim());
  if (!matched) fail('仓库格式必须是 owner/name');
  const tag = String(source.tag ?? '').trim();
  if (!TAG_PATTERN.test(tag)) fail('tag 不合法', '只接受 tag 名称，且必须是 URL 安全字符');
  const rawDir = String(source.dir ?? '')
    .trim()
    .replace(/^\/+|\/+$/g, '');
  if (rawDir.includes('..') || rawDir.includes('\\') || /[\x00-\x1f]/.test(rawDir)) {
    fail('子目录路径不合法');
  }
  return { owner: matched![1]!, name: matched![2]!, repo: `${matched![1]}/${matched![2]}`, tag, dir: rawDir };
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

  constructor(private readonly deps: ImporterDeps) {
    this.apiBase = (deps.apiBase ?? API_BASE).replace(/\/+$/, '');
    this.rawBase = (deps.rawBase ?? RAW_BASE).replace(/\/+$/, '');
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
      // 「问不到 GitHub」不是「你填错了仓库」：给 502 + 可重试的文案，
      // 而不是让它冒成 500「内部错误」（实测面板上就只剩这四个字，看不出根因）
      throw new AppError(
        'PLUGIN_IMPORT_UNREACHABLE',
        `无法访问 GitHub：${describeNetworkError(err)}`,
        { cause: err instanceof Error ? err : undefined },
      );
    }
    if (res.status === 404) fail(notFound);
    if (res.status === 403 || res.status === 429 || res.status >= 500) {
      throw new AppError(
        'PLUGIN_IMPORT_UNREACHABLE',
        `GitHub 返回 ${res.status}（限流或上游故障），请稍后重试；私有仓库需要配 MCSTS_GH_TOKEN`,
      );
    }
    if (!res.ok) fail(`GitHub 返回 ${res.status}`, url.replace(/^https?:\/\//, ''));
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
    const sha = await this.resolveTag(src.repo, src.tag);
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
      tag: src.tag,
      sha,
      dir: src.dir,
      manifest,
      marker,
      files,
      totalBytes: total,
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
        'tag 指向的 commit 与预览时不一致',
        `预览 ${expectedSha.slice(0, 10)}，现在 ${plan.sha.slice(0, 10)}；请重新预览后再安装`,
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
