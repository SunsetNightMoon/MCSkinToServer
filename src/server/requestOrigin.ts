import type { Request } from 'express';
import { normalizeOrigin } from '../site/siteUrl.js';

/**
 * 取「触发本次请求的浏览器地址」（协议 + Host）。
 *
 * Express 的 req.protocol 只在设置了 `trust proxy`（环境变量 TRUST_PROXY）时
 * 才认 X-Forwarded-Proto，req.get('host') 同理跟随反代传上来的 Host 头 ——
 * 这正是我们要的：域名服务器上前置 Nginx，兜底链接应当是用户实际访问的域名，
 * 而不是后台没配 BASE_URL 时写死的 localhost。
 */
export function requestOrigin(req: Request): string | undefined {
  const host = req.get('host');
  if (!host) return undefined;
  return normalizeOrigin(`${req.protocol}://${host}`);
}
