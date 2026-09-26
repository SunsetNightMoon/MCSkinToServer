/**
 * MSCTS 后端 DTO 类型（与 src/ 响应结构对应）。
 *
 * 兼容层 `src/utils/apiCompat.ts` 以 AssetItem 为输入契约，
 * 再翻译成旧版页面消费的 snake_case 形状。
 */

export interface ProfileRow {
  id: string;
  userId: string;
  name: string;
  nameChangedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface PublicUser {
  id: string;
  userUid: number;
  email: string;
  role: 'user' | 'admin' | 'super_admin';
  emailVerified: boolean;
}

export interface LoginResponse {
  user: PublicUser;
  profile: ProfileRow;
  token: string;
  expiresAt: string;
}

export interface AssetItem {
  id: string;
  kind: 'skin' | 'cape';
  modelType: 'default' | 'slim' | null;
  name: string;
  description: string;
  reviewStatus: 'pending' | 'approved' | 'rejected';
  visibility: 'private' | 'public';
  downloadPolicy: 'owner_only' | 'public';
  adminWarning?: string | null;
  aiGenerated?: boolean;
  license?: string | null;
  viewCount?: number;
  downloadCount?: number;
  favoriteCount?: number;
  previewUrl?: string;
  createdAt: string;
  /** 详情接口补充字段 */
  ownerUid?: number | null;
}

export interface LibraryPageDto {
  items: AssetItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface AssetDetailDto {
  asset: AssetItem;
  isFavorited: boolean;
  canDownload: boolean;
}

export interface AdminUserDto {
  id: string;
  userUid: number;
  email: string;
  role: 'user' | 'admin' | 'super_admin';
  isActive: boolean;
  emailVerified: boolean;
  bannedUntil: string | null;
  banPermanent: boolean;
  banReason: string | null;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
}
