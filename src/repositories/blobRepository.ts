import type { DatabaseConnection } from '../types.js';
import { phAt, toIso } from '../db/rows.js';

/**
 * blobs 表 repository —— 内容寻址的不可变文件对象（按 sha256 全局去重）。
 * 数据库只存 storage_key，URL 一律由 AssetUrlResolver 生成（蓝图 §4）。
 */

export interface BlobRow {
  id: string;
  /** 小写 hex */
  sha256: string;
  storageKey: string;
  contentType: string;
  byteSize: number;
  width: number;
  height: number;
  createdAt: string;
}

export interface NewBlobRow {
  id: string;
  sha256: string;
  storageKey: string;
  contentType: string;
  byteSize: number;
  width: number;
  height: number;
  now: Date;
}

const BLOB_COLUMNS =
  'id, sha256, storage_key, content_type, byte_size, width, height, created_at';

function mapBlobRow(raw: Record<string, unknown>): BlobRow {
  return {
    id: raw['id'] as string,
    sha256: raw['sha256'] as string,
    storageKey: raw['storage_key'] as string,
    contentType: raw['content_type'] as string,
    byteSize: Number(raw['byte_size']),
    width: Number(raw['width']),
    height: Number(raw['height']),
    createdAt: toIso(raw['created_at'])!,
  };
}

export class BlobRepository {
  constructor(private readonly db: DatabaseConnection) {}

  async insert(blob: NewBlobRow): Promise<void> {
    await this.db.run(
      `INSERT INTO blobs (id, sha256, storage_key, content_type, byte_size, width, height, created_at)
       VALUES (${[0, 1, 2, 3, 4, 5, 6, 7].map((i) => phAt(this.db.dialect, i)).join(', ')})`,
      [
        blob.id,
        blob.sha256,
        blob.storageKey,
        blob.contentType,
        blob.byteSize,
        blob.width,
        blob.height,
        blob.now.toISOString(),
      ],
    );
  }

  async findBySha256(sha256: string): Promise<BlobRow | null> {
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT ${BLOB_COLUMNS} FROM blobs WHERE sha256 = ${phAt(this.db.dialect, 0)}`,
      [sha256],
    );
    return rows[0] ? mapBlobRow(rows[0]) : null;
  }

  async findById(id: string): Promise<BlobRow | null> {
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT ${BLOB_COLUMNS} FROM blobs WHERE id = ${phAt(this.db.dialect, 0)}`,
      [id],
    );
    return rows[0] ? mapBlobRow(rows[0]) : null;
  }

  /** 引用该 blob 的 asset 数量（删除 blob 前的安全检查，FK 默认 RESTRICT） */
  async countAssetReferences(blobId: string): Promise<number> {
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT COUNT(*) AS n FROM assets WHERE blob_id = ${phAt(this.db.dialect, 0)}`,
      [blobId],
    );
    return Number(rows[0]!['n']);
  }

  async delete(id: string): Promise<void> {
    await this.db.run(
      `DELETE FROM blobs WHERE id = ${phAt(this.db.dialect, 0)}`,
      [id],
    );
  }
}
