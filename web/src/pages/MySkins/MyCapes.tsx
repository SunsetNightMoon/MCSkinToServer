import { compatFetch as fetch } from "../../utils/apiCompat" // 数据层适配：/api/* 自动翻译为 MSCTS 端点
import { useState, useEffect, useCallback, useMemo } from 'react'
import { Table, Tag, Button, Space, message, Modal, Form, Input, Select } from 'antd'
import { EditOutlined, DeleteOutlined, PlusOutlined } from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '../../store/authStore'
import { usePageTitle } from '../../hooks/usePageTitle'
import { useTranslation } from 'react-i18next'

interface Cape {
  id: number
  file_path: string
  name: string
  description: string
  license_type: string
  permission_level: string
  approval_status: string
  download_count: number
  view_count: number
  created_at: string
}

function getPermissionText(level: string, t: (key: string) => string): string {
  switch (level) {
    case 'private': return t('myCapes.private')
    case 'public_no_download': return t('myCapes.publicNoDownload')
    case 'public_downloadable': return t('myCapes.publicDownloadable')
    default: return level
  }
}

function getStatusTag(status: string, t: (key: string) => string) {
  const map: Record<string, { color: string; text: string }> = {
    pending: { color: 'orange', text: t('myCapes.pending') },
    approved: { color: 'green', text: t('myCapes.approved') },
    rejected: { color: 'red', text: t('myCapes.rejected') },
  }
  const s = map[status] || { color: 'default', text: status }
  return <Tag color={s.color} style={{ whiteSpace: 'normal', wordBreak: 'break-word' }}>{s.text}</Tag>
}

export default function MyCapes() {
  const { t } = useTranslation()
  usePageTitle(t('myCapes.title'))
  const { user, token } = useAuthStore()
  const navigate = useNavigate()
  const [capes, setCapes] = useState<Cape[]>([])
  const [loading, setLoading] = useState(true)
  const [editModalOpen, setEditModalOpen] = useState(false)
  const [editingCape, setEditingCape] = useState<Cape | null>(null)
  const [editForm] = Form.useForm()
  const [submitting, setSubmitting] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<Cape | null>(null)

  // 协议类型选项（与上传页保持一致）
  const LICENSE_OPTIONS = useMemo(() => [
    { value: 'CC0_1.0', label: t('upload.license.CC0_1.0') },
    { value: 'CC_BY_3.0', label: t('upload.license.CC_BY_3.0') },
    { value: 'CC_BY_4.0', label: t('upload.license.CC_BY_4.0') },
    { value: 'CC_BY-SA_3.0', label: t('upload.license.CC_BY-SA_3.0') },
    { value: 'CC_BY-SA_4.0', label: t('upload.license.CC_BY-SA_4.0') },
    { value: 'CC_BY-NC_3.0', label: t('upload.license.CC_BY-NC_3.0') },
    { value: 'CC_BY-NC_4.0', label: t('upload.license.CC_BY-NC_4.0') },
    { value: 'ARR', label: t('upload.license.ARR') },
    { value: 'AI_CC0', label: t('upload.license.AI_CC0') },
    { value: 'Custom', label: t('upload.license.Custom') },
  ], [t])

  const loadCapes = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/capes/mine', {
        headers: { 'Authorization': `Bearer ${token}` },
      })
      const data = await res.json()
      setCapes(data.capes || data)
    } catch (e) {
      message.error(t('myCapes.loadFailed'))
    } finally {
      setLoading(false)
    }
  }, [token, t])

  useEffect(() => { loadCapes() }, [loadCapes])

  const handleEdit = (cape: Cape) => {
    setEditingCape(cape)
    editForm.setFieldsValue({
      name: cape.name,
      description: cape.description || '',
      permission_level: cape.permission_level,
      license_type: cape.license_type,
    })
    setEditModalOpen(true)
  }

  const handleEditSubmit = async () => {
    if (!editingCape) return
    try {
      const values = await editForm.validateFields()
      setSubmitting(true)
      const res = await fetch(`/api/capes/${editingCape.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(values),
      })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.errorMessage || t('myCapes.updateFailed'))
      }
      message.success(t('myCapes.updated'))
      setEditModalOpen(false)
      loadCapes()
    } catch (e: any) {
      message.error(e.message || t('myCapes.updateFailed'))
    } finally {
      setSubmitting(false)
    }
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    try {
      const res = await fetch(`/api/capes/${deleteTarget.id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` },
      })
      if (!res.ok) throw new Error(t('myCapes.deleteFailed'))
      message.success(t('myCapes.deleted'))
      setDeleteTarget(null)
      loadCapes()
    } catch (e: any) {
      message.error(e.message || t('myCapes.deleteFailed'))
    }
  }

  const columns: ColumnsType<Cape> = [
    {
      title: t('myCapes.preview'),
      key: 'preview',
      width: 100,
      render: (_, r) => (
        <img src={r.file_path.startsWith('./') ? r.file_path.replace(/^\./, '') : r.file_path}
          alt="" style={{ width: 64, height: 'auto', border: '1px solid #d9d9d9', imageRendering: 'pixelated', display: 'block' }} />
      ),
    },
    {
      title: t('myCapes.name'),
      dataIndex: 'name',
      key: 'name',
      ellipsis: true,
    },
    {
      title: t('myCapes.permission'),
      dataIndex: 'permission_level',
      key: 'permission_level',
      width: 160,
      render: (lv: string) => <Tag style={{ whiteSpace: 'normal', wordBreak: 'break-word' }}>{getPermissionText(lv, t)}</Tag>,
    },
    {
      title: t('myCapes.status'),
      dataIndex: 'approval_status',
        key: 'approval_status',
        width: 100,
        render: (s: string) => getStatusTag(s, t),
      },
      {
        title: t('myCapes.viewDownload'),
        key: 'stats',
        width: 100,
        render: (_, r) => `${r.view_count || 0} / ${r.download_count || 0}`,
      },
      {
        title: t('myCapes.uploadTime'),
        dataIndex: 'created_at',
        key: 'created_at',
        width: 170,
        render: (d: string) => new Date(d).toLocaleString(),
      },
      {
        title: t('myCapes.action'),
        key: 'action',
        width: 140,
        render: (_, r) => (
          <Space>
            <Button type="link" size="small" icon={<EditOutlined />} onClick={() => handleEdit(r)}>{t('myCapes.edit')}</Button>
            <Button type="link" size="small" danger icon={<DeleteOutlined />} onClick={() => setDeleteTarget(r)}>{t('myCapes.delete')}</Button>
          </Space>
        ),
      },
    ]

  if (!user) return <div style={{ padding: 20 }}>{t('myCapes.pleaseLogin')}</div>

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>{t('myCapes.title')}</h2>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate('/upload?type=cape')}>{t('myCapes.uploadNewCape')}</Button>
      </div>

      <Table
        columns={columns}
        dataSource={capes}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 20 }}
        size="small"
        locale={{ emptyText: t('common.noData') }}
      />

      {/* 编辑弹窗 */}
      <Modal
        title={t('myCapes.editTitle')}
        open={editModalOpen}
        onOk={handleEditSubmit}
        onCancel={() => setEditModalOpen(false)}
        confirmLoading={submitting}
        okText={t('myCapes.save')}
        cancelText={t('myCapes.cancel')}
      >
        <Form form={editForm} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item name="name" label={t('myCapes.capeName')} rules={[{ required: true, message: t('myCapes.pleaseEnterName') }]}>
            <Input placeholder={t('myCapes.capeName')} maxLength={50} />
          </Form.Item>
          <Form.Item name="description" label={t('myCapes.description')}>
            <Input.TextArea rows={3} placeholder={t('myCapes.descriptionPlaceholder')} maxLength={200} />
          </Form.Item>
          <Form.Item name="license_type" label={t('myCapes.licenseType')} rules={[{ required: true, message: t('myCapes.pleaseSelectLicense') }]}>
            <Select placeholder={t('myCapes.pleaseSelectLicense')} options={LICENSE_OPTIONS} />
          </Form.Item>
          <Form.Item name="permission_level" label={t('myCapes.permissionLevel')} rules={[{ required: true }]}>
            <Select>
              <Select.Option value="private">{t('myCapes.private')}</Select.Option>
              <Select.Option value="public_no_download">{t('myCapes.publicNoDownload')}</Select.Option>
              <Select.Option value="public_downloadable">{t('myCapes.publicDownloadable')}</Select.Option>
            </Select>
          </Form.Item>
        </Form>
      </Modal>

      {/* 删除确认 */}
      <Modal
        title={t('myCapes.deleteConfirmTitle')}
        open={!!deleteTarget}
        onOk={handleDelete}
        onCancel={() => setDeleteTarget(null)}
        okText={t('myCapes.confirmDelete')}
        cancelText={t('myCapes.cancel')}
        okButtonProps={{ danger: true }}
      >
        {deleteTarget && (
          <div>
            <p dangerouslySetInnerHTML={{ __html: t('myCapes.deleteConfirm', { name: deleteTarget.name }) }} />
            <p style={{ color: 'rgba(0,0,0,0.6)', fontSize: 12 }}>{t('myCapes.deleteWarning')}</p>
          </div>
        )}
      </Modal>
    </div>
  )
}
