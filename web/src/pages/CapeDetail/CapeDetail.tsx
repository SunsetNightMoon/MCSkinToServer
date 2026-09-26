import { compatFetch as fetch } from "../../utils/apiCompat" // 数据层适配：/api/* 自动翻译为 MSCTS 端点
import { useState, useEffect } from 'react'
import { useParams, useNavigate, useLocation } from 'react-router-dom'
import { Button, Tag, Card, Descriptions, Spin, message, Space, Divider, Typography, Alert, Switch, Modal, Input } from 'antd'
import { ArrowLeftOutlined, DownloadOutlined, HeartOutlined, HeartFilled, StarOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import type { Cape } from '../../types'
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

export function CapeDetail() {
  const { t } = useTranslation()
  usePageTitle(t('detail.capeTitle'))
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const location = useLocation()
  const [cape, setCape] = useState<Cape | null>(null)
  const [loading, setLoading] = useState(true)
  const [favoriteCount, setFavoriteCount] = useState(0)
  const { isAuthenticated, user, token } = useAuthStore()

  const capeId = id || ''

  const [isFavoritedByUser, setIsFavoritedByUser] = useState(false)
  const [warningModalVisible, setWarningModalVisible] = useState(false)
  const [warningText, setWarningText] = useState('')

  const isUploader = user ? Number(user.user_uid) === Number(cape?.user_uid) : false

  useEffect(() => {
    loadCapeDetail()
  }, [id])

  useEffect(() => {
    if (!cape) return
    loadFavoriteStatus()
  }, [capeId, token])

  const loadCapeDetail = async () => {
    setLoading(true)
    try {
      const response = await fetch(`/api/library/capes/${id}`)
      const data = await response.json()
      setCape(data)
    } catch (error) {
      console.error('Failed to load cape detail:', error)
      message.error(t('detail.loadFailed'))
    } finally {
      setLoading(false)
    }
  }

  const loadFavoriteStatus = async () => {
    try {
      const countRes = await fetch(`/api/capes/${capeId}/favorite-count`)
      if (countRes.ok) {
        const countData = await countRes.json()
        setFavoriteCount(countData.favoriteCount || 0)
      }

      if (token) {
        const statusRes = await fetch(`/api/capes/${capeId}/is-favorited`, {
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
    if (!cape) return

    try {
      const response = await fetch(cape.file_path)
      const blob = await response.blob()
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `cape_${cape.id}.png`
      document.body.appendChild(a)
      a.click()
      window.URL.revokeObjectURL(url)
      document.body.removeChild(a)
      message.success(t('detail.downloadSuccess'))
    } catch (error) {
      message.error(t('detail.downloadFailed'))
    }
  }

  const handleFavorite = async () => {
    if (!isAuthenticated || !token) {
      message.info(t('detail.loginToFavorite'))
      return
    }

    if (isUploader) {
      message.info(t('detail.uploaderNoActionCape'))
      return
    }

    try {
      if (isFavoritedByUser) {
        const res = await fetch(`/api/capes/${capeId}/favorite`, {
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
        const res = await fetch(`/api/capes/${capeId}/favorite`, {
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
      const res = await fetch(`/api/admin/capes/${capeId}/warning`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ warning: warningText.trim() })
      })
      if (!res.ok) throw new Error(t('detail.addFailed'))
      setCape(prev => prev ? { ...prev, admin_warning: warningText.trim(), warning_set_by_level: user?.level } : null)
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

  if (!cape) {
    return <div>{t('detail.capeNotFound')}</div>
  }

  const canDownload = cape.permission_level === 'public_downloadable'
  const isShownAsFavorited = isUploader || isFavoritedByUser

  return (
    <div style={{ padding: '20px' }}>
      <Button
        type="text"
        icon={<ArrowLeftOutlined />}
        onClick={() => {
          const s = location.state as { returnTab?: string; returnPage?: number } | null
          if (s?.returnTab) {
            const params = new URLSearchParams()
            params.set('tab', s.returnTab)
            if (s.returnPage && s.returnPage > 1) params.set(`${s.returnTab}Page`, String(s.returnPage))
            navigate(`/library?${params.toString()}`)
          } else {
            navigate('/library')
          }
        }}
        style={{ marginBottom: 20 }}
      >
        {t('detail.backToLibrary')}
      </Button>

      <div style={{ display: 'flex', gap: 40, flexWrap: 'wrap' }}>
        {/* 左侧：3D预览 */}
        <div style={{ flex: '0 0 auto' }}>
          <Skin3DViewer
            skinUrl="/steve.png"
            capeUrl={cape.file_path}
            modelType="default"
            width={350}
            height={400}
            initialBackView={true}
          />
        </div>

        {/* 右侧：披风详情 */}
        <div style={{ flex: 1, minWidth: 300 }}>
          <h2 style={{ marginBottom: 12 }}>
            {cape.name || t('wardrobe.unnamedCape')}
          </h2>

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
              {t('detail.downloadCount', { count: cape.download_count })}
            </Text>
            <Text type="secondary">
              <StarOutlined style={{ marginRight: 4 }} />
              {t('detail.viewCount', { count: cape.view_count })}
            </Text>
          </div>

          <Divider style={{ margin: '12px 0' }} />

          {/* 详细信息表格 */}
          <Descriptions column={1} bordered size="small">
            <Descriptions.Item label={t('detail.uploader')}>
              {cape.uploader_name || `UID.${cape.user_uid}`}
              {isUploader && <Tag color="purple" style={{ marginLeft: 8 }}>{t('detail.myUpload')}</Tag>}
            </Descriptions.Item>
            <Descriptions.Item label={t('detail.size')}>
              {cape.width} × {cape.height}
            </Descriptions.Item>
            <Descriptions.Item label={t('detail.licenseType')}>
              <Tag color={LICENSE_TAG_COLORS[cape.license_type]}>
                {cape.license_type}
              </Tag>
            </Descriptions.Item>
            <Descriptions.Item label={t('detail.permissionLevel')}>
              {cape.permission_level === 'private' && t('detail.private')}
              {cape.permission_level === 'public_no_download' && t('detail.publicNoDownload')}
              {cape.permission_level === 'public_downloadable' && t('detail.publicDownloadable')}
            </Descriptions.Item>
            <Descriptions.Item label={t('detail.approvalStatus')}>
              {cape.approval_status === 'pending' && <Tag color="orange">{t('detail.pending')}</Tag>}
              {cape.approval_status === 'approved' && <Tag color="green">{t('detail.approved')}</Tag>}
              {cape.approval_status === 'rejected' && <Tag color="red">{t('detail.rejected')}</Tag>}
            </Descriptions.Item>
          </Descriptions>

          {/* 管理员操作区 + 红色警告 */}
          {user && user.level >= 1 && (
            <Card size="small" style={{ marginTop: 16, border: '1px solid #d9d9d9' }}>
              <div style={{ marginBottom: 8 }}><b>{t('detail.adminActions')}</b></div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <span>{t('detail.aiGeneratedMark')}</span>
                <Switch
                  checked={!!cape.is_ai_generated}
                  onChange={async (checked) => {
                    try {
                      const res = await fetch(`/api/admin/capes/${cape.id}/ai-generated`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                        body: JSON.stringify({ is_ai_generated: checked })
                      });
                      if (!res.ok) throw new Error(t('detail.operationFailed'));
                      setCape({ ...cape, is_ai_generated: checked ? 1 : 0 });
                      message.success(checked ? t('detail.markedAsAi') : t('detail.unmarkedAsAi'));
                    } catch (e: any) {
                      message.error(e.message || t('detail.operationFailed'));
                    }
                  }}
                />
                {user.level >= 2 && (
                  <>
                    {cape.admin_warning ? (
                      <Button size="small" danger onClick={async () => {
                        try {
                          const res = await fetch(`/api/admin/capes/${cape.id}/warning`, {
                            method: 'DELETE',
                            headers: { Authorization: `Bearer ${token}` }
                          });
                          if (!res.ok) throw new Error(t('detail.removeFailed'));
                          setCape({ ...cape, admin_warning: null, warning_set_by_level: null });
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
          {cape.admin_warning && (
            <Alert
              type="error"
              showIcon
              message={t('detail.adminWarning')}
              description={cape.admin_warning}
              style={{ marginTop: 16 }}
            />
          )}

          {/* 简介卡片 */}
          {cape.description && (
            <Card size="small" style={{ marginTop: 16 }} title={t('detail.description')}>
              <Paragraph style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{cape.description}</Paragraph>
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
