import { compatFetch as fetch } from "../../utils/apiCompat" // 数据层适配：/api/* 自动翻译为 MSCTS 端点
import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate, useLocation } from 'react-router-dom'
import { Button, Tag, Card, Descriptions, Spin, message, Space, Divider, Typography, Alert, Switch, Modal, Input } from 'antd'
import { ArrowLeftOutlined, DownloadOutlined, HeartOutlined, HeartFilled, StarOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import type { Skin } from '../../types'
import { Skin3DViewer } from '../../components/Skin3DViewer/Skin3DViewer'
import { useAuthStore } from '../../store/authStore'
import { usePageTitle } from '../../hooks/usePageTitle'

const { Text, Paragraph } = Typography

const LICENSE_TAG_COLORS: Record<string, string> = {
  'CC0_1.0': 'green',
  'CC_BY_3.0': 'blue',
  'CC_BY_4.0': 'blue',
  'CC_BY-SA_3.0': 'cyan',
  'CC_BY-SA_4.0': 'cyan',
  'CC_BY-NC_3.0': 'purple',
  'CC_BY-NC_4.0': 'purple',
  'ARR': 'red',
  'Custom': 'default',
  'AI_CC0': 'geekblue',
}

export function SkinDetail() {
  const { t } = useTranslation()
  usePageTitle(t('detail.skinTitle'))
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const location = useLocation()
  const [skin, setSkin] = useState<Skin | null>(null)
  const [loading, setLoading] = useState(true)
  const [favoriteCount, setFavoriteCount] = useState(0)
  const { isAuthenticated, user, token } = useAuthStore()

  const skinId = id || ''

  const [isFavoritedByUser, setIsFavoritedByUser] = useState(false)
  const [warningModalVisible, setWarningModalVisible] = useState(false)
  const [warningText, setWarningText] = useState('')

  const isUploader = user ? Number(user.user_uid) === Number(skin?.user_uid) : false

  const handleBack = useCallback(() => {
    const s = location.state as { returnTab?: string; returnPage?: number } | null
    if (s?.returnTab) {
      const params = new URLSearchParams()
      params.set('tab', s.returnTab)
      if (s.returnPage && s.returnPage > 1) params.set(`${s.returnTab}Page`, String(s.returnPage))
      navigate(`/library?${params.toString()}`)
    } else {
      navigate('/library')
    }
  }, [location.state, navigate])

  useEffect(() => {
    loadSkinDetail()
  }, [id])

  useEffect(() => {
    if (!skin) return
    loadFavoriteStatus()
  }, [skinId, token])

  const loadSkinDetail = async () => {
    setLoading(true)
    try {
      const response = await fetch(`/api/library/skins/${id}`)
      const data = await response.json()
      setSkin(data)
    } catch (error) {
      console.error('Failed to load skin detail:', error)
      message.error(t('detail.loadFailed'))
    } finally {
      setLoading(false)
    }
  }

  const loadFavoriteStatus = async () => {
    try {
      const countRes = await fetch(`/api/skins/${skinId}/favorite-count`)
      if (countRes.ok) {
        const countData = await countRes.json()
        setFavoriteCount(countData.favoriteCount || 0)
      }

      if (token) {
        const statusRes = await fetch(`/api/skins/${skinId}/is-favorited`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (statusRes.ok) {
          const statusData = await statusRes.json()
          setIsFavoritedByUser(statusData.isFavorited)
        }
      } else {
        setIsFavoritedByUser(false)
      }
    } catch (error) {
      console.error('Failed to load favorite status:', error)
    }
  }

  const handleDownload = async () => {
    if (!skin) return

    try {
      // 先向后端要「可下载地址」：`GET /api/assets/:id/download` 会按 download_policy
      // 校验下载权限，并把 download_count +1。
      //
      // 这里以前直接 `fetch(skin.file_path)` —— 等于同时绕过校验与计数：
      // owner_only 的素材只要拿到 file_path 就能下，而 download_count 永远是 0
      // （后台「下载数」一列因此一直全是 0，看起来像统计没做）。
      const ticketRes = await fetch(`/api/assets/${skin.id}/download`)
      if (!ticketRes.ok) {
        const data = await ticketRes.json().catch(() => ({}))
        throw new Error(data.errorMessage || t('detail.downloadFailed'))
      }
      const { url } = await ticketRes.json()
      if (!url) throw new Error(t('detail.downloadFailed'))

      // 地址拿到后仍走 blob 下载：跨源时 <a download> 会被浏览器忽略，
      // 而素材存储已开 ACAO（见 app.ts 的本地存储静态挂载）
      const response = await fetch(url)
      const blob = await response.blob()
      const objectUrl = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = objectUrl
      a.download = `skin_${skin.id}.png`
      document.body.appendChild(a)
      a.click()
      window.URL.revokeObjectURL(objectUrl)
      document.body.removeChild(a)
      message.success(t('detail.downloadSuccess'))
    } catch (error: any) {
      // 403（无下载权限）等业务错误的文案由后端给出，直接展示比「下载失败」更有用
      message.error(error?.message || t('detail.downloadFailed'))
    }
  }

  const handleFavorite = async () => {
    if (!isAuthenticated || !token) {
      message.info(t('detail.loginToFavorite'))
      return
    }

    if (isUploader) {
      message.info(t('detail.uploaderNoActionSkin'))
      return
    }

    try {
      if (isFavoritedByUser) {
        const res = await fetch(`/api/skins/${skinId}/favorite`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!res.ok) {
          const err = await res.json()
          throw new Error(err.errorMessage || t('detail.unfavoriteFailed'))
        }
        setIsFavoritedByUser(false)
        setFavoriteCount(c => Math.max(0, c - 1))
        message.success(t('detail.unfavorited'))
      } else {
        const res = await fetch(`/api/skins/${skinId}/favorite`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!res.ok) {
          const err = await res.json()
          throw new Error(err.errorMessage || t('detail.favoriteFailed'))
        }
        setIsFavoritedByUser(true)
        setFavoriteCount(c => c + 1)
        message.success(t('detail.favoritedSuccess'))
      }

      loadFavoriteStatus()
    } catch (error: any) {
      message.error(error.message || t('detail.operationFailed'))
    }
  }

  const handleAddWarning = async () => {
    if (!warningText.trim()) return
    try {
      const res = await fetch(`/api/admin/skins/${skinId}/warning`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ warning: warningText.trim() })
      })
      if (!res.ok) throw new Error(t('detail.addFailed'))
      setSkin(prev => prev ? { ...prev, admin_warning: warningText.trim(), warning_set_by_level: user?.level } : null)
      message.success(t('detail.warningAdded'))
    } catch (e: any) {
      message.error(e.message || t('detail.operationFailed'))
    } finally {
      setWarningModalVisible(false)
    }
  }

  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: 50 }}>
        <Spin size="large" />
      </div>
    )
  }

  if (!skin) {
    return <div>{t('detail.skinNotFound')}</div>
  }

  const canDownload = skin.permission_level === 'public_downloadable'
  const isShownAsFavorited = isUploader || isFavoritedByUser

  return (
    <div style={{ padding: '20px' }}>
      <Button
        type="text"
        icon={<ArrowLeftOutlined />}
        onClick={handleBack}
        style={{ marginBottom: 20 }}
      >
        {t('detail.backToLibrary')}
      </Button>

      <div style={{ display: 'flex', gap: 40, flexWrap: 'wrap' }}>
        {/* 左侧：3D预览 */}
        <div style={{ flex: '0 0 auto' }}>
          <Skin3DViewer
            skinUrl={skin.file_path}
            capeUrl={skin.cape_file_path}
            modelType={skin.model_type}
            width={350}
            height={400}
          />
        </div>

        {/* 右侧：皮肤详情 */}
        <div style={{ flex: 1, minWidth: 300 }}>
          <h2 style={{ marginBottom: 12 }}>
            {skin.name || t('wardrobe.unnamedSkin')}
          </h2>

          {/* 标签 */}
          {skin.tags && skin.tags.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <Space size={[4, 4]} wrap>
                {skin.tags.map((tag: string) => (
                  <Tag key={tag} color="blue">{tag}</Tag>
                ))}
              </Space>
            </div>
          )}

          {/* 操作按钮 */}
          <Space style={{ marginBottom: 16 }}>
            <Button
              type={isShownAsFavorited ? 'primary' : 'default'}
              icon={isShownAsFavorited ? <HeartFilled /> : <HeartOutlined />}
              onClick={handleFavorite}
              disabled={isUploader}
              title={isUploader ? t('detail.uploaderDefaultFav') : undefined}
            >
              {isUploader ? t('detail.favorited') : isFavoritedByUser ? t('detail.favorited') : t('detail.favorite')}
            </Button>
            {canDownload && (
              <Button
                type="primary"
                icon={<DownloadOutlined />}
                onClick={handleDownload}
              >
                {t('detail.download')}
              </Button>
            )}
          </Space>

          {/* 统计信息 */}
          <div style={{ marginBottom: 16, display: 'flex', gap: 20, flexWrap: 'wrap' }}>
            <Text type="secondary">
              <HeartOutlined style={{ marginRight: 4 }} />
              {t('detail.favoriteCount', { count: favoriteCount })}
            </Text>
            <Text type="secondary">
              <DownloadOutlined style={{ marginRight: 4 }} />
              {t('detail.downloadCount', { count: skin.download_count })}
            </Text>
            <Text type="secondary">
              <StarOutlined style={{ marginRight: 4 }} />
              {t('detail.viewCount', { count: skin.view_count })}
            </Text>
          </div>

          <Divider style={{ margin: '12px 0' }} />

          {/* 详细信息表格 */}
          <Descriptions column={1} bordered size="small">
            <Descriptions.Item label={t('detail.uploader')}>
              {skin.uploader_name || `UID.${skin.user_uid}`}
              {isUploader && <Tag color="purple" style={{ marginLeft: 8 }}>{t('detail.myUpload')}</Tag>}
            </Descriptions.Item>
            <Descriptions.Item label={t('detail.modelType')}>
              {skin.model_type === 'default' ? t('wardrobe.classic') : t('wardrobe.slim')}
            </Descriptions.Item>
            <Descriptions.Item label={t('detail.licenseType')}>
              <Tag color={LICENSE_TAG_COLORS[skin.license_type]}>
                {skin.license_type}
              </Tag>
            </Descriptions.Item>
            <Descriptions.Item label={t('detail.permissionLevel')}>
              {skin.permission_level === 'private' && t('detail.private')}
              {skin.permission_level === 'public_no_download' && t('detail.publicNoDownload')}
              {skin.permission_level === 'public_downloadable' && t('detail.publicDownloadable')}
            </Descriptions.Item>
            <Descriptions.Item label={t('detail.approvalStatus')}>
              {skin.approval_status === 'pending' && <Tag color="orange">{t('detail.pending')}</Tag>}
              {skin.approval_status === 'approved' && <Tag color="green">{t('detail.approved')}</Tag>}
              {skin.approval_status === 'rejected' && <Tag color="red">{t('detail.rejected')}</Tag>}
            </Descriptions.Item>
          </Descriptions>

          {/* 管理员操作区 + 红色警告 */}
          {user && user.level >= 1 && (
            <Card size="small" style={{ marginTop: 16, border: '1px solid #d9d9d9' }}>
              <div style={{ marginBottom: 8 }}><b>{t('detail.adminActions')}</b></div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <span>{t('detail.aiGeneratedMark')}</span>
                <Switch
                  checked={!!skin.is_ai_generated}
                  onChange={async (checked) => {
                    try {
                      const res = await fetch(`/api/admin/skins/${skin.id}/ai-generated`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                        body: JSON.stringify({ is_ai_generated: checked })
                      });
                      if (!res.ok) throw new Error(t('detail.operationFailed'));
                      setSkin({ ...skin, is_ai_generated: checked ? 1 : 0 });
                      message.success(checked ? t('detail.markedAsAi') : t('detail.unmarkedAsAi'));
                    } catch (e: any) {
                      message.error(e.message || t('detail.operationFailed'));
                    }
                  }}
                />
                {user.level >= 2 && (
                  <>
                    {skin.admin_warning ? (
                      <Button size="small" danger onClick={async () => {
                        try {
                          const res = await fetch(`/api/admin/skins/${skin.id}/warning`, {
                            method: 'DELETE',
                            headers: { Authorization: `Bearer ${token}` }
                          });
                          if (!res.ok) throw new Error(t('detail.removeFailed'));
                          setSkin({ ...skin, admin_warning: null, warning_set_by_level: null });
                          message.success(t('detail.warningRemoved'));
                        } catch (e: any) {
                          message.error(e.message || t('detail.operationFailed'));
                        }
                      }}>{t('detail.removeWarning')}</Button>
                    ) : (
                      <Button size="small" danger onClick={() => {
                        setWarningText('');
                        setWarningModalVisible(true);
                      }}>{t('detail.addWarning')}</Button>
                    )}
                  </>
                )}
              </div>
            </Card>
          )}

          {/* 红色警告 */}
          {skin.admin_warning && (
            <Alert
              type="error"
              showIcon
              message={t('detail.adminWarning')}
              description={skin.admin_warning}
              style={{ marginTop: 16 }}
            />
          )}

          {/* 简介卡片 */}
          {skin.description && (
            <Card size="small" style={{ marginTop: 16 }} title={t('detail.description')}>
              <Paragraph style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{skin.description}</Paragraph>
            </Card>
          )}
        </div>
      </div>

      <Modal
        title={t('detail.addAdminWarning')}
        open={warningModalVisible}
        onOk={handleAddWarning}
        onCancel={() => setWarningModalVisible(false)}
        okText={t('app.confirm')}
        cancelText={t('app.cancel')}
        destroyOnClose
      >
        <Input.TextArea
          rows={4}
          placeholder={t('detail.warningPlaceholder')}
          value={warningText}
          onChange={e => setWarningText(e.target.value)}
        />
      </Modal>
    </div>
  )
}
