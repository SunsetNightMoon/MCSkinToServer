/** 后端 DTO 类型（与 src/ 响应结构对应） */

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
