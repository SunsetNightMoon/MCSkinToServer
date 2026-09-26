import type { AppConfig } from '../config.js';
import { LocalDiskStorage } from './local.js';
import type { StoragePort } from './types.js';

export { AssetUrlResolver } from './assetUrl.js';
export type { BlobLike } from './assetUrl.js';
export { blobStorageKey } from './keys.js';
export { LocalDiskStorage } from './local.js';
export type { StoragePort } from './types.js';

/**
 * 按配置创建存储端口；S3 分支在 P5 加入（STORAGE_BACKEND=s3）。
 *
 * @param publicBaseUrl 可选的素材前缀提供者。main.ts 传 SiteUrlResolver 的同步 getter，
 *   使 BASE_URL 改动立刻反映到新生成的素材 URL；省略时回落环境变量
 *   `PUBLIC_BASE_URL`（既有测试与嵌入式用法行为不变）。
 */
export function createStoragePort(
  config: AppConfig,
  publicBaseUrl?: () => string,
): StoragePort {
  return new LocalDiskStorage(
    config.uploadDir,
    publicBaseUrl ?? ((): string => config.publicBaseUrl),
  );
}
