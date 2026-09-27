import type { RequestHandler } from 'express';
import { normalizeOrigin } from '../site/siteUrl.js';
import type { SiteUrlResolver } from '../site/siteUrl.js';
import type { RuntimeSettings } from '../site/runtimeSettings.js';

/**
 * `/uploads` 静态资源的跨源读取控制（Issue #4）。
 *
 * ## 它管的是什么，不管的是什么
 *
 * `Access-Control-Allow-Origin` 只决定**别的站点的 JS 能不能把这张图读进 canvas**
 * （`toDataURL` / `getImageData`），也就是「把本站素材当素材库抠走、二次合成」这条路。
 * 它**不防热链**：`<img src="https://本站/uploads/…">` 是普通子资源请求，浏览器对图片
 * 显示不做 CORS 检查，有没有这个头都能正常显示、带宽照样消耗。真要省带宽得在
 * 网关/CDN 层按 Referer 处理（README 有配方），那是单台主机的策略，不进本仓库。
 *
 * 改动前这里写死 `*`，等于对全世界放开读像素。现在默认只放行：
 *
 * 1. **同源**：请求的 `Origin` 与本次请求自己的 `Host` 一致。这一条不依赖任何配置，
 *    所以管理员没设 `BASE_URL` 时也不会把自家站点的 3D 预览/头像打裂。
 * 2. **站点自身来源**：`SiteUrlResolver` 解析出的站点根。素材挂在独立图床/CDN 域名下时，
 *    页面来源通常就是它。
 * 3. **`UPLOAD_CORS_ORIGINS` 白名单**：管理员显式加的其它来源；写 `*` 退回全放行。
 *
 * ## 为什么必须带 Vary: Origin
 *
 * 回显具体来源就意味着「同一个 URL 的响应内容随请求来源而变」。共享缓存（CDN、反代）
 * 若不看 `Vary` 只按 URL 建键，就会把 A 站拿到的 `ACAO: A` 缓存下来发给 B 站 ——
 * 表现为「我这边好、他那边图裂」这种极难复现的故障。所以 **无论是否命中白名单，
 * `/uploads` 的响应一律带 `Vary: Origin`**，并且只回显**归一化后的白名单值**，
 * 绝不把请求头原样写进响应（那才是真的开放重定向式的注入面）。
 */

export interface UploadsCorsDependencies {
  /** 读 `UPLOAD_CORS_ORIGINS`；未注入时按「白名单为空」处理 */
  runtimeSettings?: RuntimeSettings;
  /** 站点根来源；未注入时只依赖同源判定 */
  siteUrlResolver?: SiteUrlResolver;
}

export function createUploadsCorsMiddleware(
  deps: UploadsCorsDependencies,
): RequestHandler {
  return async (req, res, next) => {
    // 先挂 Vary：命中与否都要让缓存按来源分键，漏一次就是线上串味
    res.append('Vary', 'Origin');

    const requestOrigin = normalizeOrigin(req.get('origin') ?? '');
    if (!requestOrigin) {
      // 没有 Origin（直接打开图片、<img> 热链、启动器取纹理）：本来就不需要 CORS 头
      next();
      return;
    }

    const allowlist = deps.runtimeSettings
      ? await deps.runtimeSettings.uploadCorsOrigins()
      : [];

    if (allowlist.includes('*')) {
      res.set('Access-Control-Allow-Origin', '*');
      next();
      return;
    }

    // 同源判定用请求自己的 Host，而不是配置里的站点根：
    // BASE_URL 没配或配错时，自家站点的预览不该因此坏掉
    const selfOrigin = normalizeOrigin(`${req.protocol}://${req.get('host') ?? ''}`);
    if (deps.siteUrlResolver) {
      // TTL 内只是一次时间戳比较，不会每个请求都查库；管理端保存设置时会主动失效
      await deps.siteUrlResolver.ensureFresh();
    }
    const siteOrigin = deps.siteUrlResolver
      ? normalizeOrigin(deps.siteUrlResolver.originSync())
      : undefined;

    const allowed = new Set(
      [selfOrigin, siteOrigin, ...allowlist]
        .filter((value): value is string => value !== undefined)
        .map((value) => value.toLowerCase()),
    );

    if (allowed.has(requestOrigin.toLowerCase())) {
      res.set('Access-Control-Allow-Origin', requestOrigin);
    }
    next();
  };
}
