import { compatFetch as fetch } from "../../utils/apiCompat" // 数据层适配：/api/* 自动翻译为 MCSTS 端点
import { useState, useEffect } from 'react'
import { Table, Tag, Button, Space, message, Modal, Form, Input, Select, Popconfirm } from 'antd'
import { EditOutlined, DeleteOutlined } from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import { useAuthStore } from '../../store/authStore'
import { useTranslation } from 'react-i18next'

interface Cape {
  id: string
  user_uid: number
  uploader_name: string
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

function getPermissionTag(level: string, t: (key: string) => string) {
  const map: Record<string, { color: string; text: string }> = {
    private: { color: 'default', text: t('admin.private') },
    public_no_download: { color: 'blue', text: t('admin.publicNoDownload') },
    public_downloadable: { color: 'green', text: t('admin.publicDownloadable') },
  }
  const s = map[level] || { color: 'default', text: level }
  return <Tag color={s.color} style={{ whiteSpace: 'normal', wordBreak: 'break-word' }}>{s.text}</Tag>
}

function getStatusTag(status: string, t: (key: string) => string) {
  const map: Record<string, { color: string; text: string }> = {
    pending: { color: 'orange', text: t('admin.pending') },
    approved: { color: 'green', text: t('admin.approved') },
    rejected: { color: 'red', text: t('admin.rejected') },
  }
  const s = map[status] || { color: 'default', text: status }
  return <Tag color={s.color} style={{ whiteSpace: 'normal', wordBreak: 'break-word' }}>{s.text}</Tag>
}

export default function AdminCapeManagement() {
  const { t } = useTranslation()
  const [capes, setCapes] = useState<Cape[]>([])
  const [loading, setLoading] = useState(true)
  const [total, setTotal] = useState(0)
  const { token } = useAuthStore()
  const [page, setPage] = useState(1)
  const pageSize = 10

  const [editModalOpen, setEditModalOpen] = useState(false)
  const [editingCape, setEditingCape] = useState<Cape | null>(null)
  const [editForm] = Form.useForm()
  const [submitting, setSubmitting] = useState(false)

  const loadCapes = async (p: number = page) => {
    setLoading(true)
    try {
      const res = await fetch(`/api/admin/capes?page=${p}&limit=${pageSize}`, {
        headers: { 'Authorization': `Bearer ${token}` },
      })
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.errorMessage || t('common.requestFailedWithStatus', { status: res.status }))
      }
      const data = await res.json()
      setCapes(data.capes || data)
      if (data.total !== undefined) setTotal(data.total)
    } catch (e: any) {
      message.error(t('admin.loadCapesFailed', { message: e.message }))
      console.error(t('admin.loadCapesFailed'), e)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadCapes(1) }, [])

  const handlePageChange = (p: number) => {
    setPage(p)
    loadCapes(p)
  }

  const handleEdit = (cape: Cape) => {
    setEditingCape(cape)
    editForm.setFieldsValue({
      name: cape.name,
      description: cape.description || '',
      license_type: cape.license_type,
      permission_level: cape.permission_level,
    })
    setEditModalOpen(true)
  }

  const handleEditSubmit = async () => {
    if (!editingCape) return
    try {
      const values = await editForm.validateFields()
      setSubmitting(true)
      const res = await fetch(`/api/admin/capes/${editingCape.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(values),
      })
      if (!res.ok) throw new Error(t('admin.updateFailed'))
      message.success(t('admin.capeUpdated'))
      setEditModalOpen(false)
      loadCapes(page)
    } catch (e) {
      message.error(t('admin.updateFailed'))
    } finally {
      setSubmitting(false)
    }
  }

  const handleDelete = async (cape: Cape) => {
    try {
      const res = await fetch(`/api/admin/capes/${cape.id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` },
      })
      if (!res.ok) throw new Error(t('admin.deleteFailed'))
      message.success(t('admin.capeDeleted'))
      loadCapes(page)
    } catch (e) {
      message.error(t('admin.deleteFailed'))
    }
  }

  const columns: ColumnsType<Cape> = [
    {
      title: t('admin.id'),
      dataIndex: 'id',
      key: 'id',
      width: 230,
      ellipsis: true,
      render: (id: string) => <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{id}</span>,
    },
    {
      title: t('admin.preview'),
      key: 'preview',
      width: 80,
      render: (_: any, r: Cape) => (
        <img
          src={r.file_path.startsWith('./') ? r.file_path.replace(/^\./, '') : r.file_path}
          alt={r.name}
          style={{
            width: 64,
            height: 'auto',
            maxHeight: 64,
            border: '1px solid #d9d9d9',
            borderRadius: 4,
            imageRendering: 'pixelated',
            display: 'block',
            objectFit: 'contain',
          }}
        />
      ),
    },
    {
      title: t('admin.name'),
      dataIndex: 'name',
      key: 'name',
      ellipsis: true,
      width: 120,
    },
    {
      title: t('admin.uploader'),
      key: 'uploader',
      width: 110,
      render: (_: any, r: Cape) => r.uploader_name || `UID.${r.user_uid}`,
    },
    {
      title: t('admin.permission'),
      dataIndex: 'permission_level',
      key: 'permission_level',
      width: 160,
      render: (text: string) => getPermissionTag(text, t),
    },
    {
      title: t('admin.status'),
      dataIndex: 'approval_status',
      key: 'approval_status',
      width: 100,
      render: (text: string) => getStatusTag(text, t),
    },
    {
      title: t('admin.viewDownload'),
      key: 'stats',
      width: 90,
      render: (_: any, r: Cape) => `${r.view_count || 0} / ${r.download_count || 0}`,
    },
    {
      title: t('admin.uploadTime'),
      dataIndex: 'created_at',
      key: 'created_at',
      width: 160,
      render: (d: string) => new Date(d).toLocaleString(),
    },
    {
      title: t('admin.action'),
      key: 'action',
      width: 130,
      render: (_: any, r: Cape) => (
        <Space>
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => handleEdit(r)}>{t('common.edit')}</Button>
          <Popconfirm title={t('admin.confirmDeleteCape')} onConfirm={() => handleDelete(r)} okText={t('common.confirm')} cancelText={t('common.cancel')}>
            <Button type="link" size="small" danger icon={<DeleteOutlined />}>{t('admin.delete')}</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <div>
      <h2>{t('admin.capeManagement')}</h2>
      <p style={{ color: 'var(--text-muted)', marginBottom: 16, fontSize: 13 }}>
        {t('admin.totalCapes', { total: total || capes.length })}
      </p>
      <Table
        columns={columns}
        dataSource={capes}
        rowKey="id"
        loading={loading}
        pagination={total > pageSize ? { current: page, total, pageSize, onChange: handlePageChange } : false}
        size="small"
        scroll={{ x: 900 }}
      />

      {/* 编辑弹窗 */}
      <Modal
        title={t('admin.editCapeInfo')}
        open={editModalOpen}
        onOk={handleEditSubmit}
        onCancel={() => setEditModalOpen(false)}
        confirmLoading={submitting}
        okText={t('common.save')}
        cancelText={t('common.cancel')}
      >
        <Form form={editForm} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item name="name" label={t('admin.capeName')} rules={[{ required: true, message: t('admin.pleaseEnterName') }]}>
            <Input placeholder={t('admin.capeNamePlaceholder')} maxLength={50} />
          </Form.Item>
          <Form.Item name="description" label={t('admin.description')}>
            <Input.TextArea rows={3} placeholder={t('admin.capeDescriptionPlaceholder')} maxLength={200} />
          </Form.Item>
          <Form.Item name="license_type" label={t('admin.licenseType')} rules={[{ required: true, message: t('admin.pleaseSelectLicense') }]}>
            <Select>
              <Select.Option value="ARR">{t('admin.licenseARR')}</Select.Option>
              <Select.Option value="CC0">{t('admin.licenseCC0')}</Select.Option>
              <Select.Option value="CC-BY">{t('admin.licenseCCBY')}</Select.Option>
              <Select.Option value="CC-BY-SA">{t('admin.licenseCCBYSA')}</Select.Option>
            </Select>
          </Form.Item>
          <Form.Item name="permission_level" label={t('admin.permissionLevel')} rules={[{ required: true }]}>
            <Select>
              <Select.Option value="private">{t('admin.private')}</Select.Option>
              <Select.Option value="public_no_download">{t('admin.publicNoDownload')}</Select.Option>
              <Select.Option value="public_downloadable">{t('admin.publicDownloadable')}</Select.Option>
            </Select>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
