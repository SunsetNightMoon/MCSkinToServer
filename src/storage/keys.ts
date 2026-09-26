import { AppError } from '../errors.js';

/**
 * blob 的内容寻址 objectKey：blobs/{sha256 前 2 位}/{sha256}.{ext}
 * 相同文件（同 hash）自然落在同一路径 —— 与 blobs 表 sha256 UNIQUE 对应。
 */
export function blobStorageKey(sha256: string, ext = 'png'): string {
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    throw new AppError('STORAGE_ERROR', `非法 sha256: ${sha256}`);
  }
  return `blobs/${sha256.slice(0, 2)}/${sha256}.${ext}`;
}
