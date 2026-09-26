export interface User {
  id: string
  user_uid: number
  email: string
  role: string
  level: number
  is_active: boolean | number
  email_verified: boolean | number
  banned_until: string | null // null = 未封禁, 'permanent' = 永久封禁, 其他日期 = 封禁到指定日期
}

export interface Profile {
  id: string
  name: string
  user_id: string
  skin_id?: string
  cape_id?: string
}

export interface Skin {
  id: string
  user_id: string
  profile_id?: string
  file_path: string
  /** 详情页 3D 预览用：可选（MSCTS 详情接口不返回该字段） */
  cape_file_path?: string
  model_type: 'default' | 'slim'
  file_hash: string
  file_size: number
  width: number
  height: number
  name?: string
  description?: string
  license_type: string
  permission_level: 'private' | 'public_no_download' | 'public_downloadable'
  is_public: boolean
  is_downloadable: boolean
  approval_status: 'pending' | 'approved' | 'rejected'
  download_count: number
  view_count: number
  created_at: string
  tags?: string[]
  uploader_email?: string
  user_uid?: number
  uploader_name?: string // 上传者游戏名称（profile.name）
  is_ai_generated?: boolean | number
  admin_warning?: string | null
  warning_set_by_level?: number | null
}

export interface CreateSkinDTO {
  skin: File
  model_type: 'default' | 'slim'
  description?: string
  license_type: string
  permission_level: 'private' | 'public_no_download' | 'public_downloadable'
}

export interface Cape {
  id: string
  user_id: string
  file_path: string
  file_size: number
  width: number
  height: number
  name?: string
  description?: string
  license_type: string
  permission_level: 'private' | 'public_no_download' | 'public_downloadable'
  is_public: boolean
  is_downloadable: boolean
  approval_status: 'pending' | 'approved' | 'rejected'
  download_count: number
  view_count: number
  created_at: string
  user_uid?: number
  uploader_name?: string // 上传者游戏名称（profile.name）
  is_ai_generated?: boolean | number
  admin_warning?: string | null
  warning_set_by_level?: number | null
}

export interface RegisterDTO {
  email: string
  password: string
  profile_name: string
  captcha_session_id?: string
  captcha_answer?: string
  turnstile_token?: string
}

export interface LoginDTO {
  email: string
  password: string
  turnstile_token?: string
}
