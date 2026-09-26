import { compatFetch as fetch } from "../../utils/apiCompat" // 数据层适配：/api/* 自动翻译为 MSCTS 端点
import { useState, useEffect } from 'react'
import { Table, Tag, Button, message, Modal, Form, Input, Select, DatePicker, Popconfirm, Typography, Card, Statistic, Row, Col } from 'antd'
import { DeleteOutlined, PlusOutlined, ClearOutlined } from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'

const { Text, Paragraph } = Typography
import { useAuthStore } from '../../store/authStore'
import { useTranslation } from 'react-i18next'
import dayjs from 'dayjs'

interface BlacklistRecord {
  id: number
  email: string | null
  ip_address: string | null
  ban_type: 'permanent' | 'temporary'
  ban_until: string | null
  reason: string | null
  banned_by: string
  created_at: string
}

export default function BlacklistManagement() {
  const { t } = useTranslation()
  const { token } = useAuthStore()
  const [blacklist, setBlacklist] = useState<BlacklistRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [stats, setStats] = useState({ permanent: 0, temporary: 0, expired: 0 })

  // 添加黑名单弹窗
  const [addModalOpen, setAddModalOpen] = useState(false)
  const [addModalLoading, setAddModalLoading] = useState(false)
  const [addForm] = Form.useForm()

  // 清理过期黑名单
  const [cleaningExpired, setCleaningExpired] = useState(false)

  useEffect(() => {
    loadBlacklist()
  }, [])

  const loadBlacklist = async () => {
    setLoading(true)
    try {
      const response = await fetch('/api/admin/blacklist', {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      })
      if (!response.ok) throw new Error(t('common.requestFailed'))
      const data = await response.json()
      setBlacklist(data)

      // 计算统计
      const permanent = data.filter((item: BlacklistRecord) => item.ban_type === 'permanent').length
      const temporary = data.filter((item: BlacklistRecord) => item.ban_type === 'temporary').length
      const expired = data.filter((item: BlacklistRecord) => {
        if (item.ban_type === 'temporary' && item.ban_until) {
          return new Date(item.ban_until) <= new Date()
        }
        return false
      }).length

      setStats({ permanent, temporary, expired })
    } catch (error) {
      message.error(t('admin.loadBlacklistFailed', { message: (error as Error).message || String(error) }))
      console.error(t('admin.loadBlacklistFailed'), error)
    } finally {
      setLoading(false)
    }
  }

  const handleAddToBlacklist = async () => {
    try {
      const values = await addForm.validateFields()
      setAddModalLoading(true)

      const payload: any = {
        ban_type: values.ban_type,
        reason: values.reason || null,
      }

      if (values.email) {
        payload.email = values.email
      }
      if (values.ip_address) {
        payload.ip_address = values.ip_address
      }
      if (values.ban_type === 'temporary' && values.ban_until) {
        payload.ban_until = values.ban_until.toISOString()
      }

      const response = await fetch('/api/admin/blacklist', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      })

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.errorMessage || t('common.operationFailed'))
      }

      message.success(t('admin.addedToBlacklist'))
      setAddModalOpen(false)
      addForm.resetFields()
      loadBlacklist()
    } catch (error: any) {
      message.error(error.message || t('common.operationFailed'))
    } finally {
      setAddModalLoading(false)
    }
  }

  const handleDelete = async (id: number) => {
    try {
      const response = await fetch(`/api/admin/blacklist/${id}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      })

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.errorMessage || t('common.operationFailed'))
      }

      message.success(t('admin.removedFromBlacklist'))
      loadBlacklist()
    } catch (error: any) {
      message.error(error.message || t('common.operationFailed'))
    }
  }

  const handleCleanupExpired = async () => {
    setCleaningExpired(true)
    try {
      const response = await fetch('/api/admin/blacklist/cleanup', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      })

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.errorMessage || t('common.operationFailed'))
      }

      const data = await response.json()
      message.success(t('admin.cleanedExpired', { count: data.deletedCount }))
      loadBlacklist()
    } catch (error: any) {
      message.error(error.message || t('admin.cleanupFailed'))
    } finally {
      setCleaningExpired(false)
    }
  }

  const getBanTypeTag = (banType: string, banUntil: string | null) => {
    if (banType === 'permanent') {
      return <Tag color="red">{t('admin.permanentBan')}</Tag>
    } else {
      const isExpired = banUntil && new Date(banUntil) <= new Date()
      return (
        <Tag color={isExpired ? 'default' : 'orange'}>
          {t('admin.temporaryBan')} {isExpired ? t('admin.expired') : ''}
        </Tag>
      )
    }
  }

  const columns: ColumnsType<BlacklistRecord> = [
    {
      title: t('admin.id'),
      dataIndex: 'id',
      key: 'id',
      width: 60,
    },
    {
      title: t('admin.email'),
      dataIndex: 'email',
      key: 'email',
      width: 200,
      render: (email: string | null) => email ? <Text copyable={{ text: email }}>{email}</Text> : <Text type="secondary">-</Text>,
    },
    {
      title: t('admin.ipAddress'),
      dataIndex: 'ip_address',
      key: 'ip_address',
      width: 150,
      render: (ip: string | null) => ip ? <Text copyable={{ text: ip }}>{ip}</Text> : <Text type="secondary">-</Text>,
    },
    {
      title: t('admin.banType'),
      dataIndex: 'ban_type',
      key: 'ban_type',
      width: 120,
      render: (banType: string, record: BlacklistRecord) => getBanTypeTag(banType, record.ban_until),
    },
    {
      title: t('admin.banUntil'),
      dataIndex: 'ban_until',
      key: 'ban_until',
      width: 160,
      render: (banUntil: string | null) => {
        if (!banUntil) return <Text type="secondary">{t('admin.permanent')}</Text>
        const isExpired = new Date(banUntil) <= new Date()
        return (
          <Text type={isExpired ? 'secondary' : 'warning'}>
            {new Date(banUntil).toLocaleString()}
          </Text>
        )
      },
    },
    {
      title: t('admin.reason'),
      dataIndex: 'reason',
      key: 'reason',
      width: 150,
      render: (reason: string | null) => reason ? <Text ellipsis>{reason}</Text> : <Text type="secondary">-</Text>,
    },
    {
      title: t('admin.banTime'),
      dataIndex: 'created_at',
      key: 'created_at',
      width: 160,
      render: (date: string) => new Date(date).toLocaleString(),
    },
    {
      title: t('admin.action'),
      key: 'action',
      width: 100,
      render: (_: any, record: BlacklistRecord) => (
        <Popconfirm
          title={t('admin.confirmRemoveFromBlacklist')}
          onConfirm={() => handleDelete(record.id)}
          okText={t('common.confirm')}
          cancelText={t('common.cancel')}
        >
          <Button type="link" danger size="small" icon={<DeleteOutlined />}>
            {t('admin.remove')}
          </Button>
        </Popconfirm>
      ),
    },
  ]

  return (
    <div>
      <h2>{t('admin.blacklistManagement')}</h2>
      <Paragraph type="secondary" style={{ marginBottom: 20 }}>
        {t('admin.blacklistDescription')}
      </Paragraph>

      {/* 统计卡片 */}
      <Row gutter={16} style={{ marginBottom: 20 }}>
        <Col span={8}>
          <Card size="small">
            <Statistic
              title={t('admin.permanentBan')}
              value={stats.permanent}
              valueStyle={{ color: '#ff4d4f' }}
            />
          </Card>
        </Col>
        <Col span={8}>
          <Card size="small">
            <Statistic
              title={t('admin.temporaryBan')}
              value={stats.temporary}
              valueStyle={{ color: '#fa8c16' }}
            />
          </Card>
        </Col>
        <Col span={8}>
          <Card size="small">
            <Statistic
              title={t('admin.expired')}
              value={stats.expired}
              valueStyle={{ color: '#8c8c8c' }}
            />
          </Card>
        </Col>
      </Row>

      {/* 操作按钮 */}
      <div style={{ marginBottom: 16, display: 'flex', gap: 8 }}>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => {
            addForm.resetFields()
            setAddModalOpen(true)
          }}
        >
          {t('admin.addToBlacklistButton')}
        </Button>
          <Button
            icon={<ClearOutlined />}
            onClick={handleCleanupExpired}
            loading={cleaningExpired}
            disabled={stats.expired === 0}
          >
            {t('admin.cleanupExpired')}
          </Button>
      </div>

      {/* 黑名单列表 */}
      <Table
        columns={columns}
        dataSource={blacklist}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 20 }}
        size="small"
        scroll={{ x: 1000 }}
        locale={{ emptyText: t('common.noData') }}
      />

      {/* 添加黑名单弹窗 */}
      <Modal
        title={t('admin.addToBlacklist')}
        open={addModalOpen}
        onOk={handleAddToBlacklist}
        onCancel={() => {
          setAddModalOpen(false)
          addForm.resetFields()
        }}
        confirmLoading={addModalLoading}
        okText={t('common.add')}
        cancelText={t('common.cancel')}
        okButtonProps={{ danger: true }}
      >
        <Form form={addForm} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item
            name="email"
            label={t('admin.email')}
            extra={t('admin.emailOrIpExtra')}
          >
            <Input placeholder={t('admin.enterEmailToBan')} />
          </Form.Item>
          <Form.Item
            name="ip_address"
            label={t('admin.ipAddress')}
          >
            <Input placeholder={t('admin.enterIpToBan')} />
          </Form.Item>
          <Form.Item
            name="ban_type"
            label={t('admin.banType')}
            rules={[{ required: true, message: t('admin.pleaseSelectBanType') }]}
            initialValue="permanent"
          >
            <Select>
              <Select.Option value="permanent">{t('admin.permanentBan')}</Select.Option>
              <Select.Option value="temporary">{t('admin.temporaryBan')}</Select.Option>
            </Select>
          </Form.Item>
          <Form.Item
            noStyle
            shouldUpdate={(prevValues, currentValues) => prevValues.ban_type !== currentValues.ban_type}
          >
            {() => {
              const banType = addForm.getFieldValue('ban_type')
              return banType === 'temporary' ? (
                <Form.Item
                  name="ban_until"
                  label={t('admin.banUntil')}
                  rules={[{ required: true, message: t('admin.pleaseSelectBanUntil') }]}
                >
                  <DatePicker
                    showTime
                    style={{ width: '100%' }}
                    format="YYYY-MM-DD HH:mm"
                    disabledDate={(current) => current && current < dayjs().startOf('day')}
                  />
                </Form.Item>
              ) : null
            }}
          </Form.Item>
          <Form.Item
            name="reason"
            label={t('admin.banReason')}
          >
            <Input.TextArea placeholder={t('admin.banReasonPlaceholder')} rows={3} />
          </Form.Item>

          <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)', marginTop: 8 }}>
            <div style={{ color: '#ff4d4f', fontWeight: 500, marginBottom: 4 }}>{t('admin.warning')}</div>
            <div>• {t('admin.blacklistWarning1')}</div>
            <div>• {t('admin.blacklistWarning2')}</div>
            <div>• {t('admin.blacklistWarning3')}</div>
          </div>
        </Form>
      </Modal>
    </div>
  )
}
