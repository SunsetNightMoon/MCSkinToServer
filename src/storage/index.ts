import type { AppConfig } from '../config.js';
import { LocalDiskStorage } from './local.js';
import type { StoragePort } from './types.js';

export { AssetUrlResolver } from './assetUrl.js';
export type { BlobLike } from './assetUrl.js';
export { blobStorageKey } from './keys.js';
export { LocalDiskStorage } from './local.js';
export type { StoragePort } from './types.js';

/** 按配置创建存储端口；S3 分支在 P5 加入（STORAGE_BACKEND=s3） */
export function createStoragePort(config: AppConfig): StoragePort {
  return new LocalDiskStorage(config.uploadDir, config.publicBaseUrl);
}
