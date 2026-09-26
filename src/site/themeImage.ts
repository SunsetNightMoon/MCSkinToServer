import { sha256Hex } from '../util/crypto.js';
import { AppError } from '../errors.js';
import type { SettingRepository } from '../repositories/settingRepository.js';
import type { StoragePort } from '../storage/types.js';

/**
 * 站点图片上传/移除（P5 第七批补 + 第八批扩）。
 *
 * ## 为什么需要它
 *
 * 管理后台有 6 组「上传即用」的图片位：
 * 4 组主题背景图（明亮/暗色/登录页/登录嵌入）+ 2 个站点图标（favicon / 顶栏徽标），
 * 调的是 `POST /api/admin/upload-theme-image?type=…` 与 `DELETE /api/admin/theme-image/:type`，
 * 而后端曾经**从来没有这两个路由** —— 上传一定 501「敬请期待」。
 * 展示侧（`LIGHT_BG_IMAGE` / `SITE_FAVICON` 等键在白名单里、前台会读）一直是通的，
 * 所以症状是「设置项能用、按钮没用」，比整块功能缺失更难发现。
 *
 * ## 为什么自己不建表
 *
 * 键 → 值的映射本来就在 `system_settings` 里（这些键已在 `PUBLIC_SETTING_KEYS`
 * 白名单中）。这里只负责「把字节写进存储 + 把 URL 写进设置」，
 * 不额外造一层数据表 —— 少一张表就少一处不一致。
 *
 * ## 两条刻意的取舍
 *
 * 1. **上传后立刻写设置**（不等用户再点「保存」）：按钮语义是「换图标/换背景」，
 *    写进表单却要用户再保存一次，等于「上传完了但没生效」，是同一个困惑的另一半。
 *    `remove` 同理立刻清空 —— 两边一致。
 * 2. **objectKey 带内容哈希**（`theme/<type>-<sha12>.<ext>`）：同名复用会让浏览器
 *    继续用缓存里的旧图。上传/移除时会顺手删掉上一个 object（best-effort），
 *    所以不会越堆越多。
 *
 * ## SVG 的两种口径（用户拍板，2026-09-25）
 *
 * **SVG 只给 favicon / logo 两个站点图标用，4 组背景图一律拒收。**
 * 理由不是对称，而是暴露面：
 *
 * - 背景图/内嵌图是拿来当**页面**用的（`open()`、CSS background 直接铺满视口），
 *   SVG 一旦被当文档打开，内嵌 `<script>` 就执行 —— 而这里没有任何净化手段。
 * - favicon/logo 是拿来当**资源**引用的（`<img src>` / `<link rel=icon>`），
 *   这两种引用方式下 SVG 内脚本**不执行**；而且上传者本就是管理员，
 *   手填一个外链 SVG 的效果一模一样 —— 拦它不减少任何风险，只损失功能。
 *
 * 站点图标的格式集与背景图不同：多 SVG 与 ICO，少限制（见 `TYPE_FORMATS`）。
 */

/** 类型名 → 设置键。类型名同时是公开 API 的 `?type=` 取值（与旧前端调用保持一致） */
export const THEME_IMAGE_SETTING_KEYS = {
  'light-bg': 'LIGHT_BG_IMAGE',
  'dark-bg': 'DARK_BG_IMAGE',
  'login-bg': 'LOGIN_BG_IMAGE',
  'login-embed': 'LOGIN_EMBED_IMAGE',
  favicon: 'SITE_FAVICON',
  logo: 'SITE_LOGO',
} as const;

export type ThemeImageType = keyof typeof THEME_IMAGE_SETTING_KEYS;

/** 存储前缀；`remove` 靠它从旧 URL 反推 objectKey */
export const THEME_IMAGE_PREFIX = 'theme/';

/** 单文件上限。与路由层的 `raw({limit})` 同值，这里是第二道闸（服务层可复用） */
export const MAX_THEME_IMAGE_BYTES = 8 * 1024 * 1024;

function at(bytes: Uint8Array, offset: number, text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    if (bytes[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

/** 允许的 Content-Type（扩展名由它决定，不信任文件名） */
const IMAGE_TYPES: Readonly<Record<string, { ext: string; ok: (b: Uint8Array) => boolean }>> = {
  'image/png': {
    ext: 'png',
    ok: (b) => b.length > 8 && b[0] === 0x89 && at(b, 1, 'PNG'),
  },
  'image/jpeg': {
    ext: 'jpg',
    ok: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  'image/webp': {
    ext: 'webp',
    ok: (b) => b.length > 12 && at(b, 0, 'RIFF') && at(b, 8, 'WEBP'),
  },
  'image/gif': {
    ext: 'gif',
    ok: (b) => b.length > 6 && at(b, 0, 'GIF8'),
  },
  'image/svg+xml': {
    ext: 'svg',
    ok: isSvgBytes,
  },
  // .ico 的官方 MIME；有的浏览器/工具发 image/vnd.microsoft.icon，一并收
  'image/x-icon': {
    ext: 'ico',
    ok: (b) => b.length > 4 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0,
  },
  'image/vnd.microsoft.icon': {
    ext: 'ico',
    ok: (b) => b.length > 4 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0,
  },
};

/** 背景图/内嵌图：只收位图（SVG 明确拒收，见文件头） */
const BITMAP_FORMATS: readonly string[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
/** 站点图标（favicon / logo）：位图 + SVG + ICO */
const ICON_FORMATS: readonly string[] = [...BITMAP_FORMATS, 'image/svg+xml', 'image/x-icon', 'image/vnd.microsoft.icon'];

/** 每个图片位允许的格式（后台报错文案直接从这里生成，两处不会漂移） */
const TYPE_FORMATS: Readonly<Record<ThemeImageType, readonly string[]>> = {
  'light-bg': BITMAP_FORMATS,
  'dark-bg': BITMAP_FORMATS,
  'login-bg': BITMAP_FORMATS,
  'login-embed': BITMAP_FORMATS,
  favicon: ICON_FORMATS,
  logo: ICON_FORMATS,
};

/** 报错文案里的格式名（按固定顺序，别直接打印 MIME） */
const FORMAT_LABELS: Readonly<Record<string, string>> = {
  'image/png': 'PNG',
  'image/jpeg': 'JPEG',
  'image/webp': 'WebP',
  'image/gif': 'GIF',
  'image/svg+xml': 'SVG',
  'image/x-icon': 'ICO',
  'image/vnd.microsoft.icon': 'ICO',
};

/** SVG 判定：BOM/空白后以 `<?xml` / `<!DOCTYPE` / `<svg` 开头，且前 1KB 内确实出现 `<svg` */
function isSvgBytes(b: Uint8Array): boolean {
  let i = 0;
  if (b.length > 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) i = 3;
  while (
    i < b.length &&
    (b[i] === 0x20 || b[i] === 0x09 || b[i] === 0x0a || b[i] === 0x0d)
  ) {
    i += 1;
  }
  const starts = (t: string): boolean => at(b, i, t);
  // `<?xml` 与 `<!DOCTYPE` 只是「像」，必须真的含 <svg 才认 —— 防 HTML 冒充
  if (starts('<?xml') || starts('<!DOCTYPE') || starts('<!doctype')) {
    const head = Buffer.from(b.slice(i, i + 1024)).toString('latin1');
    return /<svg[\s>]/i.test(head);
  }
  return starts('<svg') || starts('<SVG');
}

export function isThemeImageType(value: unknown): value is ThemeImageType {
  return typeof value === 'string' && value in THEME_IMAGE_SETTING_KEYS;
}

export function parseThemeImageType(value: unknown): ThemeImageType {
  if (!isThemeImageType(value)) {
    throw new AppError(
      'VALIDATION_ERROR',
      `type 必须为 ${Object.keys(THEME_IMAGE_SETTING_KEYS).join(' / ')}`,
    );
  }
  return value;
}

/** 归一化 Content-Type：`image/jpeg; charset=…` 这类带参数的一并接受 */
function normalizeContentType(raw: string | undefined): string {
  return (raw ?? '').split(';')[0]!.trim().toLowerCase();
}

/**
 * 从对外 URL 反推 objectKey。
 *
 * 用正则而不是「减去 publicBaseUrl 前缀」：素材前缀是可配的（生产走 CDN 时
 * 与站点根不同域），减前缀的写法会在换域名的实例上静默失配，老文件永远删不掉。
 */
function objectKeyFromUrl(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  const m = /(theme\/[A-Za-z0-9._-]+)$/.exec(url);
  // noUncheckedIndexedAccess：捕获组下标读到的是 string | undefined
  return m?.[1] ?? null;
}

export interface ThemeImageDependencies {
  storage: StoragePort;
  settings: SettingRepository;
  /** 便于测试注入假钟（设置行的 updated_at） */
  now?: () => Date;
}

export class ThemeImageService {
  private readonly storage: StoragePort;
  private readonly settings: SettingRepository;
  private readonly now: () => Date;

  constructor(deps: ThemeImageDependencies) {
    this.storage = deps.storage;
    this.settings = deps.settings;
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * 上传并立刻写进设置，返回新 URL。
   * 校验顺序刻意是「类型 → 大小 → 内容 → 落盘」：任何一步失败都不该留下半套状态。
   */
  async upload(
    type: ThemeImageType,
    bytes: Uint8Array,
    contentType: string | undefined,
  ): Promise<{ url: string; objectKey: string }> {
    const normalized = normalizeContentType(contentType);
    const spec = IMAGE_TYPES[normalized];
    const allowed = TYPE_FORMATS[type];
    if (!spec || !allowed.includes(normalized)) {
      const names = allowed.map((f) => FORMAT_LABELS[f] ?? f).join(' / ');
      throw new AppError(
        'VALIDATION_ERROR',
        `该图片位仅支持 ${names}${
          allowed.includes('image/svg+xml') ? '' : '（不接受 SVG：它是可执行文档）'
        }`,
      );
    }
    if (bytes.length === 0) {
      throw new AppError('VALIDATION_ERROR', '上传内容为空');
    }
    if (bytes.length > MAX_THEME_IMAGE_BYTES) {
      throw new AppError(
        'VALIDATION_ERROR',
        `图片过大（上限 ${Math.floor(MAX_THEME_IMAGE_BYTES / 1024 / 1024)}MB）`,
      );
    }
    if (!spec.ok(bytes)) {
      throw new AppError(
        'VALIDATION_ERROR',
        `文件内容不是有效的 ${normalized}（扩展名与字节码不符）`,
      );
    }

    const hash = sha256Hex(bytes).slice(0, 12);
    const objectKey = `${THEME_IMAGE_PREFIX}${type}-${hash}.${spec.ext}`;
    const url = this.storage.publicUrl(objectKey);

    // 旧 key 必须在写设置**之前**取：写完再读只会读到刚写进去的新值，
    // 于是「删上一版」永远删不到东西（自己踩过这个顺序坑）
    const previous = await this.currentObjectKey(type);

    await this.storage.put(objectKey, bytes, normalized);
    await this.settings.setMany({ [THEME_IMAGE_SETTING_KEYS[type]]: url }, this.now());

    // 内容相同（哈希相同）时 key 一样，不必删；其余情况删掉上一版，避免目录越堆越多
    if (previous && previous !== objectKey) {
      await this.storage.delete(previous).catch(() => undefined);
    }

    return { url, objectKey };
  }

  /** 移除：清设置 + 删文件。设置一定被清（即使文件早就不在了） */
  async remove(type: ThemeImageType): Promise<{ removed: boolean }> {
    const before = await this.currentObjectKey(type);
    await this.settings.setMany({ [THEME_IMAGE_SETTING_KEYS[type]]: '' }, this.now());
    if (!before) return { removed: false };
    await this.storage.delete(before).catch(() => undefined);
    return { removed: true };
  }

  /** 当前设置指向的 objectKey（非本服务写入的外链返回 null） */
  private async currentObjectKey(type: ThemeImageType): Promise<string | null> {
    const all = await this.settings.getAll();
    return objectKeyFromUrl(all[THEME_IMAGE_SETTING_KEYS[type]]);
  }
}
