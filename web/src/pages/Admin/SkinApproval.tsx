import { compatFetch as fetch } from "../../utils/apiCompat" // 数据层适配：/api/* 自动翻译为 MCSTS 端点
import { useState, useEffect } from 'react'
import { Table, Tag, Button, Space, message, Modal, Descriptions } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { useAuthStore } from '../../store/authStore'
import { useTranslation } from 'react-i18next'

interface Skin {
  id: string;
  user_uid: number;
  uploader_name?: string;
  file_path: string;
  model_type: string;
  license_type: string;
  permission_level: string;
  approval_status: string;
  download_count: number;
  view_count: number;
  created_at: string;
}

function SkinApproval() {
  const { t } = useTranslation()
  const [skins, setSkins] = useState<Skin[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedSkin, setSelectedSkin] = useState<Skin | null>(null)
  const [detailVisible, setDetailVisible] = useState(false)
  const { token } = useAuthStore()

  useEffect(() => {
    loadPendingSkins()
  }, [])

  const loadPendingSkins = async () => {
    setLoading(true)
    try {
      const response = await fetch('/api/admin/skins/pending', {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      })
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.errorMessage || t('common.requestFailedWithStatus', { status: response.status }))
      }
      const data = await response.json()
      setSkins(data)
    } catch (error: any) {
      message.error(t('admin.loadSkinsFailed', { message: error.message }))
      console.error(t('admin.loadSkinsFailed'), error)
    } finally {
      setLoading(false)
    }
  }

  const handleApprove = async (skinId: string) => {
    try {
      const response = await fetch(`/api/admin/skins/${skinId}/approve`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      })
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.errorMessage || t('common.operationFailedWithStatus', { status: response.status }))
      }
      message.success(t('admin.approved'))
      loadPendingSkins()
    } catch (error: any) {
      message.error(t('common.operationFailed', { message: error.message }))
      console.error(t('admin.approveSkinFailed'), error)
    }
  }

  const handleReject = (skinId: string) => {
    Modal.confirm({
      title: t('admin.rejectSkin'),
      content: t('admin.confirmRejectSkin'),
      onOk: async () => {
        try {
          const response = await fetch(`/api/admin/skins/${skinId}/reject`, {
            method: 'PUT',
            headers: {
              'Authorization': `Bearer ${token}`,
            },
          })
          if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.errorMessage || t('common.operationFailedWithStatus', { status: response.status }))
          }
          message.success(t('admin.rejected'))
          loadPendingSkins()
        } catch (error: any) {
          message.error(t('common.operationFailed', { message: error.message }))
          console.error(t('admin.rejectSkinFailed'), error)
        }
      },
    })
  }

  const handleViewDetail = (skin: Skin) => {
    setSelectedSkin(skin)
    setDetailVisible(true)
  }

  const columns: ColumnsType<Skin> = [
    {
      title: t('admin.id'),
      dataIndex: 'id',
      key: 'id',
      width: 80,
    },
    {
      title: t('admin.uploader'),
      dataIndex: 'uploader_name',
      key: 'uploader_name',
      width: 100,
      render: (name: string | undefined, record: Skin) => name || `UID.${record.user_uid}`,
    },
    {
      title: t('admin.preview'),
      key: 'preview',
      width: 70,
      render: (_, record: Skin) => (
        <img
          src={record.file_path.startsWith('./') ? record.file_path.replace(/^\./, '') : record.file_path}
          alt="Skin"
          style={{ width: 40, height: 40, border: '1px solid #d9d9d9', imageRendering: 'pixelated' }}
        />
      ),
    },
    {
      title: t('admin.model'),
      dataIndex: 'model_type',
      key: 'model_type',
      width: 80,
      render: (type: string) => type === 'default' ? t('admin.classic') : t('admin.slim'),
    },
    {
      title: t('admin.license'),
      dataIndex: 'license_type',
      key: 'license_type',
      width: 120,
      render: (type: string) => <Tag>{type}</Tag>,
    },
    {
      title: t('admin.permission'),
      dataIndex: 'permission_level',
      key: 'permission_level',
      width: 120,
      render: (level: string) => {
        const map: Record<string, string> = {
          private: t('admin.private'),
          public_no_download: t('admin.publicNoDownload'),
          public_downloadable: t('admin.publicDownloadable'),
        }
        return map[level] || level
      },
    },
    {
      title: t('admin.status'),
      dataIndex: 'approval_status',
      key: 'approval_status',
      width: 100,
      render: (status: string) => {
        const colorMap: Record<string, string> = {
          pending: 'orange',
          approved: 'green',
          rejected: 'red',
        }
        const textMap: Record<string, string> = {
          pending: t('admin.pending'),
          approved: t('admin.approved'),
          rejected: t('admin.rejected'),
        }
        return <Tag color={colorMap[status]}>{textMap[status]}</Tag>
      },
    },
    {
      title: t('admin.uploadTime'),
      dataIndex: 'created_at',
      key: 'created_at',
      width: 180,
      render: (date: string) => new Date(date).toLocaleString(),
    },
    {
      title: t('admin.action'),
      key: 'action',
      width: 200,
      render: (_, record: Skin) => (
        <Space>
          <Button type="link" onClick={() => handleViewDetail(record)}>
            {t('common.view')}
          </Button>
          {record.approval_status === 'pending' && (
            <>
              <Button 
                type="primary" 
                size="small"
                onClick={() => handleApprove(record.id)}
              >
                {t('admin.approve')}
              </Button>
              <Button 
                type="primary" 
                danger
                size="small"
                onClick={() => handleReject(record.id)}
              >
                {t('admin.reject')}
              </Button>
            </>
          )}
        </Space>
      ),
    },
  ]

  return (
    <div>
      <h2>{t('admin.skinApproval')}</h2>
      <Table 
        columns={columns} 
        dataSource={skins} 
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 10, showTotal: (total) => t('common.totalItems', { total }) }}
        size="small"
      />

      <Modal
        title={t('admin.skinDetail')}
        open={detailVisible}
        onCancel={() => setDetailVisible(false)}
        footer={null}
        width={600}
      >
        {selectedSkin && (
          <div>
            <div style={{ textAlign: 'center', marginBottom: 20 }}>
              <img 
                src={selectedSkin.file_path} 
                alt="Skin" 
                style={{ maxWidth: '100%', border: '1px solid #d9d9d9' }}
              />
            </div>
            <Descriptions column={1} bordered size="small">
              <Descriptions.Item label={t('admin.id')}>{selectedSkin.id}</Descriptions.Item>
              <Descriptions.Item label={t('admin.uploader')}>{selectedSkin.uploader_name || `UID.${selectedSkin.user_uid}`}</Descriptions.Item>
              <Descriptions.Item label={t('admin.modelType')}>
                {selectedSkin.model_type === 'default' ? t('admin.classic') : t('admin.slim')}
              </Descriptions.Item>
              <Descriptions.Item label={t('admin.license')}>
                <Tag>{selectedSkin.license_type}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label={t('admin.permissionLevel')}>
                {selectedSkin.permission_level === 'private' && t('admin.private')}
                {selectedSkin.permission_level === 'public_no_download' && t('admin.publicNoDownload')}
                {selectedSkin.permission_level === 'public_downloadable' && t('admin.publicDownloadable')}
              </Descriptions.Item>
              <Descriptions.Item label={t('admin.approvalStatus')}>
                {selectedSkin.approval_status === 'pending' && <Tag color="orange">{t('admin.pending')}</Tag>}
                {selectedSkin.approval_status === 'approved' && <Tag color="green">{t('admin.approved')}</Tag>}
                {selectedSkin.approval_status === 'rejected' && <Tag color="red">{t('admin.rejected')}</Tag>}
              </Descriptions.Item>
              <Descriptions.Item label={t('admin.downloadCount')}>{selectedSkin.download_count}</Descriptions.Item>
              <Descriptions.Item label={t('admin.viewCount')}>{selectedSkin.view_count}</Descriptions.Item>
              <Descriptions.Item label={t('admin.uploadTime')}>
                {new Date(selectedSkin.created_at).toLocaleString()}
              </Descriptions.Item>
            </Descriptions>
          </div>
        )}
      </Modal>
    </div>
  )
}

export default SkinApproval
