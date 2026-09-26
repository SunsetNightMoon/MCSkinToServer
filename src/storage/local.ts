import { mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { AppError } from '../errors.js';
import type { StoragePort } from './types.js';

/**
 * 本地磁盘 provider（P2）。
 * - 文件写入 {root}/{objectKey}；Express 静态挂载点由配置决定
 * - publicBaseUrl 含挂载前缀（如 http://localhost:3000/uploads）
 * - S3/MinIO provider 在 P5 实现同一端口
 */
export class LocalDiskStorage implements StoragePort {
  private readonly root: string;
  private readonly publicBaseUrlProvider: () => string;

  /**
   * @param publicBaseUrl 素材前缀。传函数而不是字符串，是为了让站点根（BASE_URL）
   *   在**运行期**被管理员改动后，新生成的素材 URL 立即跟着变 —— 传字符串会把
   *   启动那一刻的值冻死，改域名后老实例仍在吐旧地址。
   *   仍然兼容直接传字符串（测试与简单装配不需要动态性）。
   */
  constructor(root: string, publicBaseUrl: string | (() => string)) {
    this.root = resolve(root);
    this.publicBaseUrlProvider =
      typeof publicBaseUrl === 'function' ? publicBaseUrl : () => publicBaseUrl;
  }

  private pathFor(objectKey: string): string {
    const p = resolve(this.root, objectKey);
    if (!p.startsWith(this.root + sep)) {
      throw new AppError('STORAGE_ERROR', `非法 objectKey: ${objectKey}`);
    }
    return p;
  }

  async put(
    objectKey: string,
    bytes: Uint8Array,
    _contentType: string,
  ): Promise<void> {
    // 本地模式下 Content-Type 由静态中间件按扩展名推断；参数保留以满足端口形状
    void _contentType;
    const p = this.pathFor(objectKey);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, bytes);
  }

  async delete(objectKey: string): Promise<void> {
    await unlink(this.pathFor(objectKey)).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') throw err;
    });
  }

  async exists(objectKey: string): Promise<boolean> {
    try {
      await stat(this.pathFor(objectKey));
      return true;
    } catch {
      return false;
    }
  }

  publicUrl(objectKey: string): string {
    const base = this.publicBaseUrlProvider().replace(/\/+$/, '');
    return `${base}/${objectKey}`;
  }
}
