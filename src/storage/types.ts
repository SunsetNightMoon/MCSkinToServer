/**
 * 存储端口（蓝图 §4）：本地磁盘与 S3 的统一抽象。
 * 数据库只存 objectKey；对外 URL 一律经由 publicUrl() 生成，
 * S3 key 永远不再被当成 URL 拼接（plan3 的 P1 风险）。
 */
export interface StoragePort {
  /** 写入对象；objectKey 由调用方决定（blob 为内容寻址 key） */
  put(objectKey: string, bytes: Uint8Array, contentType: string): Promise<void>;

  /** 删除对象；对象不存在时静默成功（幂等） */
  delete(objectKey: string): Promise<void>;

  exists(objectKey: string): Promise<boolean>;

  /** 对外公开 URL；本地与 S3 的格式差异在本端口内部消化 */
  publicUrl(objectKey: string): string;
}
