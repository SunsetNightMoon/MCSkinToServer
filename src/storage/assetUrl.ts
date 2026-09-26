import type { StoragePort } from './types.js';

/**
 * AssetUrlResolver（蓝图 §4）：对外纹理 URL 的唯一出口。
 * Yggdrasil textures builder、Web 素材接口都从这里拿 URL，
 * 确保本地与 S3 输出格式一致、缓存头与 Content-Type 在 provider 层统一。
 */
export interface BlobLike {
  storageKey: string;
}

export class AssetUrlResolver {
  constructor(private readonly storage: StoragePort) {}

  forObjectKey(objectKey: string): string {
    return this.storage.publicUrl(objectKey);
  }

  /** asset -> blob -> storage.publicUrl(storageKey) 链路的最后一跳 */
  forBlob(blob: BlobLike): string {
    return this.forObjectKey(blob.storageKey);
  }
}
