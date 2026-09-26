import { compatFetch as fetch } from "../../utils/apiCompat" // 数据层适配：/api/* 自动翻译为 MCSTS 端点
import { useState, useEffect, useCallback } from 'react'
import { Table, Tag, Button, Space, message, Modal, Form, Input, Select } from 'antd'
import { EditOutlined, DeleteOutlined, PlusOutlined } from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '../../store/authStore'
import { usePageTitle } from '../../hooks/usePageTitle'
import { useTranslation } from 'react-i18next'

interface Skin {
  id: number
  file_path: string
  name: string
  description: string
  model_type: string
  license_type: string
  permission_level: string
  approval_status: string
  download_count: number
  view_count: number
  created_at: string
}

function getPermissionText(level: string, t: (key: string) => string): string {
  switch (level) {
    case 'private': return t('mySkins.private')
    case 'public_no_download': return t('mySkins.publicNoDownload')
    case 'public_downloadable': return t('mySkins.publicDownloadable')
    default: return level
  }
}

function getStatusTag(status: string, t: (key: string) => string) {
  const map: Record<string, { color: string; text: string }> = {
    pending: { color: 'orange', text: t('mySkins.pending') },
    approved: { color: 'green', text: t('mySkins.approved') },
    rejected: { color: 'red', text: t('mySkins.rejected') },
  }
  const s = map[status] || { color: 'default', text: status }
  return <Tag color={s.color} style={{ whiteSpace: 'normal', wordBreak: 'break-word' }}>{s.text}</Tag>
}

export default function MySkins() {
  const { t } = useTranslation()
  usePageTitle(t('mySkins.title'))
  const { user, token } = useAuthStore()
  const navigate = useNavigate()
  const [skins, setSkins] = useState<Skin[]>([])
  const [loading, setLoading] = useState(true)
  const [editModalOpen, setEditModalOpen] = useState(false)
  const [editingSkin, setEditingSkin] = useState<Skin | null>(null)
  const [editForm] = Form.useForm()
  const [submitting, setSubmitting] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<Skin | null>(null)

  const loadSkins = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/skins', {
        headers: { 'Authorization': `Bearer ${token}` },
      })
      const data = await res.json()
      setSkins(data)
    } catch (e) {
      message.error(t('mySkins.loadFailed'))
    } finally {
      setLoading(false)
    }
  }, [token, t])

  useEffect(() => { loadSkins() }, [loadSkins])

  const handleEdit = (skin: Skin) => {
    setEditingSkin(skin)
    editForm.setFieldsValue({
      name: skin.name,
      description: skin.description || '',
      permission_level: skin.permission_level,
      license_type: skin.license_type,
    })
    setEditModalOpen(true)
  }

  const handleEditSubmit = async () => {
    if (!editingSkin) return
    try {
      const values = await editForm.validateFields()
      setSubmitting(true)
      const res = await fetch(`/api/skins/${editingSkin.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(values),
      })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.errorMessage || t('mySkins.updateFailed'))
      }
      message.success(t('mySkins.updated'))
      setEditModalOpen(false)
      loadSkins()
    } catch (e: any) {
      message.error(e.message || t('mySkins.updateFailed'))
    } finally {
      setSubmitting(false)
    }
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    try {
      const res = await fetch(`/api/skins/${deleteTarget.id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` },
      })
      if (!res.ok) throw new Error(t('mySkins.deleteFailed'))
      message.success(t('mySkins.deleted'))
      setDeleteTarget(null)
      loadSkins()
    } catch (e: any) {
      message.error(e.message || t('mySkins.deleteFailed'))
    }
  }

  const columns: ColumnsType<Skin> = [
    {
      title: t('mySkins.preview'),
      key: 'preview',
      width: 100,
      render: (_, r) => (
        <img src={r.file_path.startsWith('./') ? r.file_path.replace(/^\./, '') : r.file_path}
          alt="" style={{ width: 64, height: 'auto', maxHeight: 64, border: '1px solid #d9d9d9', imageRendering: 'pixelated', display: 'block' }} />
      ),
    },
    {
      title: t('mySkins.name'),
      dataIndex: 'name',
      key: 'name',
      ellipsis: true,
    },
    {
      title: t('mySkins.model'),
      dataIndex: 'model_type',
      key: 'model_type',
      width: 80,
      render: (modelType: string) => modelType === 'slim' ? t('mySkins.slim') : t('mySkins.classic'),
    },
    {
      title: t('mySkins.permission'),
      dataIndex: 'permission_level',
      key: 'permission_level',
      width: 160,
      render: (lv: string) => <Tag style={{ whiteSpace: 'normal', wordBreak: 'break-word' }}>{getPermissionText(lv, t)}</Tag>,
    },
    {
      title: t('mySkins.status'),
      dataIndex: 'approval_status',
      key: 'approval_status',
      width: 100,
      render: (s: string) => getStatusTag(s, t),
    },
    {
      title: t('mySkins.viewDownload'),
      key: 'stats',
      width: 100,
      render: (_, r) => `${r.view_count || 0} / ${r.download_count || 0}`,
    },
    {
      title: t('mySkins.uploadTime'),
      dataIndex: 'created_at',
      key: 'created_at',
      width: 170,
      render: (d: string) => new Date(d).toLocaleString(),
    },
    {
      title: t('mySkins.action'),
      key: 'action',
      width: 140,
      render: (_, r) => (
        <Space>
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => handleEdit(r)}>{t('mySkins.edit')}</Button>
          <Button type="link" size="small" danger icon={<DeleteOutlined />} onClick={() => setDeleteTarget(r)}>{t('mySkins.delete')}</Button>
        </Space>
      ),
    },
  ]

  if (!user) return <div style={{ padding: 20 }}>{t('mySkins.pleaseLogin')}</div>

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>{t('mySkins.title')}</h2>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate('/upload')}>{t('mySkins.uploadNewSkin')}</Button>
      </div>

      <Table
        columns={columns}
        dataSource={skins}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 20 }}
        size="small"
        locale={{ emptyText: t('common.noData') }}
      />

      {/* 编辑弹窗 */}
      <Modal
        title={t('mySkins.editTitle')}
        open={editModalOpen}
        onOk={handleEditSubmit}
        onCancel={() => setEditModalOpen(false)}
        confirmLoading={submitting}
        okText={t('mySkins.save')}
        cancelText={t('mySkins.cancel')}
      >
        <Form form={editForm} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item name="name" label={t('mySkins.skinName')} rules={[{ required: true, message: t('mySkins.pleaseEnterName') }]}>
            <Input placeholder={t('mySkins.skinName')} maxLength={50} />
          </Form.Item>
          <Form.Item name="description" label={t('mySkins.description')}>
            <Input.TextArea rows={3} placeholder={t('mySkins.descriptionPlaceholder')} maxLength={200} />
          </Form.Item>
          <Form.Item name="license_type" label={t('mySkins.licenseType')} rules={[{ required: true, message: t('mySkins.pleaseSelectLicense') }]}>
            <Select placeholder={t('mySkins.pleaseSelectLicense')}>
              <Select.Option value="ARR">{t('mySkins.arr')}</Select.Option>
              <Select.Option value="CC0">{t('mySkins.cc0')}</Select.Option>
              <Select.Option value="CC-BY">{t('mySkins.ccBy')}</Select.Option>
              <Select.Option value="CC-BY-SA">{t('mySkins.ccBySa')}</Select.Option>
            </Select>
          </Form.Item>
          <Form.Item name="permission_level" label={t('mySkins.permissionLevel')} rules={[{ required: true }]}>
            <Select>
              <Select.Option value="private">{t('mySkins.private')}（{t('mySkins.privateDesc')}）</Select.Option>
              <Select.Option value="public_no_download">{t('mySkins.publicNoDownload')}</Select.Option>
              <Select.Option value="public_downloadable">{t('mySkins.publicDownloadable')}</Select.Option>
            </Select>
          </Form.Item>
        </Form>
      </Modal>

      {/* 删除确认 */}
      <Modal
        title={t('mySkins.deleteConfirmTitle')}
        open={!!deleteTarget}
        onOk={handleDelete}
        onCancel={() => setDeleteTarget(null)}
        okText={t('mySkins.confirmDelete')}
        cancelText={t('mySkins.cancel')}
        okButtonProps={{ danger: true }}
      >
        {deleteTarget && (
          <div>
            <p dangerouslySetInnerHTML={{ __html: t('mySkins.deleteConfirm', { name: deleteTarget.name }) }} />
            <p style={{ color: 'rgba(255,255,255,0.6)', fontSize: 12 }}>{t('mySkins.deleteWarning')}</p>
          </div>
        )}
      </Modal>
    </div>
  )
}
