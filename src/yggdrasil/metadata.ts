import { publicKeyPemOneLine } from './keys.js';
import type { AuthlibInjectorLinks } from './authlibInjectorMeta.js';

/**
 * GET /api/yggdrasil 元数据 DTO（authlib-injector 规范的最小实现）。
 * 根路径语义不得随环境漂移（蓝图 §5.3）：元数据路径在 P1 由 Express 装配决定。
 *
 * 启动器（HMCL）解析的是**这份文档**：显示名取 `meta.serverName`，
 * 主页/注册外链取 `meta.links`，两者缺失时回退成裸 URL。
 * 规范里没有 `/.well-known/authlib-injector` 这条发现链，别把命名指望它。
 */

export interface BuildMetadataInput {
  /** 站点对外根 URL（如 https://skin.example）或 API 前缀 */
  baseUrl: string;
  publicKeyPem: string;
  /** 缺省时取 baseUrl 的 hostname */
  skinDomains?: string[];
  /** 认证服务器显示名（站点标题）；空值不下发，让启动器自行回退 */
  serverName?: string;
  /** 面向用户的链接（homepage/register/profile/password/user_page） */
  links?: AuthlibInjectorLinks;
}

export interface YggdrasilMetadataDto {
  /** 单行完整 PEM（authlib-injector 要求带 BEGIN/END 头尾，裸 base64 会解析失败） */
  signaturePublickey: string;
  skinDomains: string[];
  meta: {
    serverName?: string;
    links?: AuthlibInjectorLinks;
    implementation: { name: string; version: string };
    features: Record<string, never>;
  };
}

export function buildMetadataDto(input: BuildMetadataInput): YggdrasilMetadataDto {
  let defaultDomain: string;
  try {
    defaultDomain = new URL(input.baseUrl).hostname;
  } catch {
    defaultDomain = 'localhost';
  }
  const serverName = input.serverName?.trim();
  return {
    signaturePublickey: publicKeyPemOneLine(input.publicKeyPem),
    skinDomains: input.skinDomains?.length
      ? input.skinDomains
      : [defaultDomain],
    meta: {
      ...(serverName ? { serverName } : {}),
      ...(input.links ? { links: input.links } : {}),
      implementation: { name: 'MCSTS', version: '2-26.3.8' },
      features: {},
    },
  };
}
