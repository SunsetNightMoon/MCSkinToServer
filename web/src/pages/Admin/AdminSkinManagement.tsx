import { compatFetch as fetch } from "../../utils/apiCompat" // 数据层适配：/api/* 自动翻译为 MCSTS 端点
import { useState, useEffect } from 'react'
import { Table, Tag, Button, Space, message, Modal, Form, Input, Select, Popconfirm } from 'antd'
import { EditOutlined, DeleteOutlined } from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import { useAuthStore } from '../../store/authStore'
import { useTranslation } from 'react-i18next'

interface Skin {
  id: string
  user_uid: number
  uploader_name: string
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

export default function AdminSkinManagement() {
  const { t } = useTranslation()
  const [skins, setSkins] = useState<Skin[]>([])
  const [loading, setLoading] = useState(true)
  const [total, setTotal] = useState(0)
  const { token } = useAuthStore()
  const [page, setPage] = useState(1)
  const pageSize = 10

  const [editModalOpen, setEditModalOpen] = useState(false)
  const [editingSkin, setEditingSkin] = useState<Skin | null>(null)
  const [editForm] = Form.useForm()
  const [submitting, setSubmitting] = useState(false)

  const loadSkins = async (p: number = page) => {
    setLoading(true)
    try {
      const res = await fetch(`/api/admin/skins?page=${p}&limit=${pageSize}`, {
        headers: { 'Authorization': `Bearer ${token}` },
      })
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.errorMessage || t('common.requestFailedWithStatus', { status: res.status }))
      }
      const data = await res.json()
      setSkins(data.skins || data)
      if (data.total !== undefined) setTotal(data.total)
    } catch (e: any) {
      message.error(t('admin.loadSkinsFailed', { message: e.message }))
      console.error(t('admin.loadSkinsFailed'), e)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadSkins(1) }, [])

  const handlePageChange = (p: number) => {
    setPage(p)
    loadSkins(p)
  }

  const handleEdit = (skin: Skin) => {
    setEditingSkin(skin)
    editForm.setFieldsValue({
      name: skin.name,
      description: skin.description || '',
      license_type: skin.license_type,
      permission_level: skin.permission_level,
    })
    setEditModalOpen(true)
  }

  const handleEditSubmit = async () => {
    if (!editingSkin) return
    try {
      const values = await editForm.validateFields()
      setSubmitting(true)
      const res = await fetch(`/api/admin/skins/${editingSkin.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(values),
      })
      if (!res.ok) throw new Error(t('admin.updateFailed'))
      message.success(t('admin.skinUpdated'))
      setEditModalOpen(false)
      loadSkins(page)
    } catch (e) {
      message.error(t('admin.updateFailed'))
    } finally {
      setSubmitting(false)
    }
  }

  const handleDelete = async (skin: Skin) => {
    try {
      const res = await fetch(`/api/admin/skins/${skin.id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` },
      })
      if (!res.ok) throw new Error(t('admin.deleteFailed'))
      message.success(t('admin.skinDeleted'))
      loadSkins(page)
    } catch (e) {
      message.error(t('admin.deleteFailed'))
    }
  }

  const columns: ColumnsType<Skin> = [
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
      render: (_: any, r: Skin) => (
        <img
          src={r.file_path.startsWith('./') ? r.file_path.replace(/^\./, '') : r.file_path}
          alt=""
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
      render: (_: any, r: Skin) => r.uploader_name || `UID.${r.user_uid}`,
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
      render: (_: any, r: Skin) => `${r.view_count || 0} / ${r.download_count || 0}`,
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
      render: (_: any, r: Skin) => (
        <Space>
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => handleEdit(r)}>{t('common.edit')}</Button>
          <Popconfirm title={t('admin.confirmDeleteSkin')} onConfirm={() => handleDelete(r)} okText={t('common.confirm')} cancelText={t('common.cancel')}>
            <Button type="link" size="small" danger icon={<DeleteOutlined />}>{t('admin.delete')}</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <div>
      <h2>{t('admin.skinManagement')}</h2>
      <p style={{ color: 'var(--text-muted)', marginBottom: 16, fontSize: 13 }}>
        {t('admin.totalSkins', { total: total || skins.length })}
      </p>
      <Table
        columns={columns}
        dataSource={skins}
        rowKey="id"
        loading={loading}
        pagination={total > pageSize ? { current: page, total, pageSize, onChange: handlePageChange } : false}
        size="small"
        scroll={{ x: 900 }}
      />

      {/* 编辑弹窗 */}
      <Modal
        title={t('admin.editSkinInfo')}
        open={editModalOpen}
        onOk={handleEditSubmit}
        onCancel={() => setEditModalOpen(false)}
        confirmLoading={submitting}
        okText={t('common.save')}
        cancelText={t('common.cancel')}
      >
        <Form form={editForm} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item name="name" label={t('admin.skinName')} rules={[{ required: true, message: t('admin.pleaseEnterName') }]}>
            <Input placeholder={t('admin.skinNamePlaceholder')} maxLength={50} />
          </Form.Item>
          <Form.Item name="description" label={t('admin.description')}>
            <Input.TextArea rows={3} placeholder={t('admin.skinDescriptionPlaceholder')} maxLength={200} />
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
