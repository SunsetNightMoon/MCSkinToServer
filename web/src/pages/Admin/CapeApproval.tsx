import { compatFetch as fetch } from "../../utils/apiCompat" // 数据层适配：/api/* 自动翻译为 MCSTS 端点
import { useState, useEffect } from 'react'
import { Table, Tag, Button, Space, message, Modal, Descriptions } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { useAuthStore } from '../../store/authStore'
import { useTranslation } from 'react-i18next'

interface Cape {
  id: string
  user_uid: number
  uploader_name?: string
  file_path: string
  name?: string
  description?: string
  license_type: string
  permission_level: string
  approval_status: string
  created_at: string
}

function CapeApproval() {
  const { t } = useTranslation()
  const [capes, setCapes] = useState<Cape[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedCape, setSelectedCape] = useState<Cape | null>(null)
  const [detailVisible, setDetailVisible] = useState(false)
  const { token } = useAuthStore()

  useEffect(() => {
    loadPendingCapes()
  }, [])

  const loadPendingCapes = async () => {
    setLoading(true)
    try {
      const response = await fetch('/api/admin/capes/pending', {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      })
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.errorMessage || t('common.requestFailedWithStatus', { status: response.status }))
      }
      const data = await response.json()
      setCapes(data)
    } catch (error: any) {
      message.error(t('admin.loadCapesFailed', { message: error.message }))
      console.error(t('admin.loadCapesFailed'), error)
    } finally {
      setLoading(false)
    }
  }

  const handleApprove = async (capeId: string) => {
    try {
      const response = await fetch(`/api/admin/capes/${capeId}/approve`, {
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
      loadPendingCapes()
    } catch (error: any) {
      message.error(t('common.operationFailed', { message: error.message }))
      console.error(t('admin.approveCapeFailed'), error)
    }
  }

  const handleReject = (capeId: string) => {
    Modal.confirm({
      title: t('admin.rejectCape'),
      content: t('admin.confirmRejectCape'),
      onOk: async () => {
        try {
          const response = await fetch(`/api/admin/capes/${capeId}/reject`, {
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
          loadPendingCapes()
        } catch (error: any) {
          message.error(t('common.operationFailed', { message: error.message }))
          console.error(t('admin.rejectCapeFailed'), error)
        }
      },
    })
  }

  const handleViewDetail = (cape: Cape) => {
    setSelectedCape(cape)
    setDetailVisible(true)
  }

  const columns: ColumnsType<Cape> = [
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
      render: (name: string | undefined, record: Cape) => name || `UID${record.user_uid}`,
    },
    {
      title: t('admin.name'),
      dataIndex: 'name',
      key: 'name',
      width: 120,
      render: (name: string) => name || '-',
    },
    {
      title: t('admin.preview'),
      key: 'preview',
      width: 70,
      render: (_, record: Cape) => (
        <img
          src={record.file_path.startsWith('./') ? record.file_path.replace(/^\./, '') : record.file_path}
          alt="Cape"
          style={{ width: 60, height: 'auto', objectFit: 'contain', borderRadius: 4, background: 'rgba(255,255,255,0.05)', imageRendering: 'pixelated' }}
          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
        />
      ),
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
      render: (_, record: Cape) => (
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
      <h2>{t('admin.capeApproval')}</h2>
      <Table
        columns={columns}
        dataSource={capes}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 10, showTotal: (total) => t('common.totalItems', { total }) }}
        size="small"
      />

      <Modal
        title={t('admin.capeDetail')}
        open={detailVisible}
        onCancel={() => setDetailVisible(false)}
        footer={null}
        width={600}
      >
        {selectedCape && (
          <div>
            <div style={{ textAlign: 'center', marginBottom: 20 }}>
              <img
                src={selectedCape.file_path}
                alt="Cape"
                style={{ maxWidth: '100%', border: '1px solid #d9d9d9' }}
              />
            </div>
            <Descriptions column={1} bordered size="small">
              <Descriptions.Item label={t('admin.id')}>{selectedCape.id}</Descriptions.Item>
              <Descriptions.Item label={t('admin.uploader')}>{selectedCape.uploader_name || `UID${selectedCape.user_uid}`}</Descriptions.Item>
              <Descriptions.Item label={t('admin.name')}>{selectedCape.name || '-'}</Descriptions.Item>
              <Descriptions.Item label={t('admin.description')}>{selectedCape.description || '-'}</Descriptions.Item>
              <Descriptions.Item label={t('admin.license')}>
                <Tag>{selectedCape.license_type}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label={t('admin.permissionLevel')}>
                {selectedCape.permission_level === 'private' && t('admin.private')}
                {selectedCape.permission_level === 'public_no_download' && t('admin.publicNoDownload')}
                {selectedCape.permission_level === 'public_downloadable' && t('admin.publicDownloadable')}
              </Descriptions.Item>
              <Descriptions.Item label={t('admin.approvalStatus')}>
                {selectedCape.approval_status === 'pending' && <Tag color="orange">{t('admin.pending')}</Tag>}
                {selectedCape.approval_status === 'approved' && <Tag color="green">{t('admin.approved')}</Tag>}
                {selectedCape.approval_status === 'rejected' && <Tag color="red">{t('admin.rejected')}</Tag>}
              </Descriptions.Item>
              <Descriptions.Item label={t('admin.uploadTime')}>
                {new Date(selectedCape.created_at).toLocaleString()}
              </Descriptions.Item>
            </Descriptions>
          </div>
        )}
      </Modal>
    </div>
  )
}

export default CapeApproval
