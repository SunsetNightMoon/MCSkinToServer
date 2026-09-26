import { publicKeyPemOneLine } from './keys.js';

/**
 * GET /api/yggdrasil 元数据 DTO（authlib-injector 规范的最小实现）。
 * 根路径语义不得随环境漂移（蓝图 §5.3）：元数据路径在 P1 由 Express 装配决定。
 */

export interface BuildMetadataInput {
  /** 站点对外根 URL（如 https://skin.example）或 API 前缀 */
  baseUrl: string;
  publicKeyPem: string;
  /** 缺省时取 baseUrl 的 hostname */
  skinDomains?: string[];
}

export interface YggdrasilMetadataDto {
  /** 单行完整 PEM（authlib-injector 要求带 BEGIN/END 头尾，裸 base64 会解析失败） */
  signaturePublickey: string;
  skinDomains: string[];
  meta: {
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
  return {
    signaturePublickey: publicKeyPemOneLine(input.publicKeyPem),
    skinDomains: input.skinDomains?.length
      ? input.skinDomains
      : [defaultDomain],
    meta: {
      implementation: { name: 'MSCTS', version: '0.1.0' },
      features: {},
    },
  };
}
