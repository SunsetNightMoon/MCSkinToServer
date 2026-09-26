import { compatFetch as fetch } from "../../utils/apiCompat" // 数据层适配：/api/* 自动翻译为 MSCTS 端点
import { useState, useEffect } from 'react'
import { Table, Tag, Button, Space, message, Modal, Form, Select, DatePicker, Popconfirm, Typography, Tooltip, Spin, Radio } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { useTranslation } from 'react-i18next'

const { Text } = Typography
import { useAuthStore } from '../../store/authStore'
import dayjs from 'dayjs'

interface UserRecord {
  id: string
  user_uid: number
  email: string
  role: string
  level: number
  is_active: number
  email_verified: number
  banned_until: string | null
  created_at: string
  /** P5 第十批：用户名模式（single | multi），由 compat 层从 profileMode 映射 */
  profile_mode?: string
}

function getRoleName(level: number, t: (key: string) => string): string {
  switch (level) {
    case 2: return t('admin.superAdmin')
    case 1: return t('admin.admin')
    default: return t('admin.normalUser')
  }
}

function getRoleTagColor(level: number): string {
  switch (level) {
    case 2: return 'red'
    case 1: return 'blue'
    default: return 'default'
  }
}

function getBanStatus(bannedUntil: string | null, t: (key: string, options?: { [key: string]: any }) => string): { text: string; color: string } {
  if (!bannedUntil || bannedUntil === '') {
    return { text: t('admin.normal'), color: 'green' }
  }
  if (bannedUntil === 'permanent') {
    return { text: t('admin.permanentlyBanned'), color: 'red' }
  }
  if (new Date(bannedUntil) > new Date()) {
    return { text: t('admin.bannedUntil', { date: new Date(bannedUntil).toLocaleDateString() }), color: 'orange' }
  }
  return { text: t('admin.normal'), color: 'green' }
}

export default function UserManagement() {
  const { t } = useTranslation()
  const { user: currentUser, token } = useAuthStore()
  const [users, setUsers] = useState<UserRecord[]>([])
  const [loading, setLoading] = useState(true)

  // 角色编辑弹窗
  const [roleModalOpen, setRoleModalOpen] = useState(false)
  const [roleModalLoading, setRoleModalLoading] = useState(false)
  const [editingUser, setEditingUser] = useState<UserRecord | null>(null)
  const [roleForm] = Form.useForm()

  // 封禁弹窗
  const [banModalOpen, setBanModalOpen] = useState(false)
  const [banModalLoading, setBanModalLoading] = useState(false)
  const [banType, setBanType] = useState<'temporary' | 'permanent' | 'unban'>('unban')
  const [banForm] = Form.useForm()

  // 邮箱验证操作
  const [sendingVerification, setSendingVerification] = useState<string | null>(null)

  // 用户名模式弹窗（P5 第十批，仅超管）：代用户切换 single / multi
  const [modeModalOpen, setModeModalOpen] = useState(false)
  const [modeModalLoading, setModeModalLoading] = useState(false)
  const [modeSaving, setModeSaving] = useState(false)
  const [modeDetail, setModeDetail] = useState<{
    state: { mode: string; decisionRequired: boolean }
    activeProfiles: Array<{ id: string; name: string }>
    reservedProfiles: Array<{ id: string; name: string }>
  } | null>(null)
  const [pendingMode, setPendingMode] = useState<'single' | 'multi'>('single')
  const [pendingKeepId, setPendingKeepId] = useState<string | null>(null)

  useEffect(() => {
    loadUsers()
  }, [])

  const loadUsers = async () => {
    setLoading(true)
    try {
      const response = await fetch('/api/admin/users', {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      })
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.errorMessage || t('common.requestFailedWithStatus', { status: response.status }))
      }
      const data = await response.json()
      setUsers(data)
    } catch (error: any) {
      message.error(t('admin.loadUsersFailed', { message: error.message }))
      console.error(t('admin.loadUsersFailed'), error)
    } finally {
      setLoading(false)
    }
  }

  const handleToggleActive = async (userId: string, _isActive: boolean) => {
    try {
      const response = await fetch(`/api/admin/users/${userId}/toggle-active`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      })
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.errorMessage || t('common.operationFailedWithStatus', { status: response.status }))
      }
      message.success(t('common.operationSuccess'))
      loadUsers()
    } catch (error: any) {
      message.error(t('common.operationFailed', { message: error.message }))
      console.error(t('admin.toggleActiveFailed'), error)
    }
  }

  // 打开角色编辑弹窗
  const openRoleModal = (user: UserRecord) => {
    setEditingUser(user)
    roleForm.setFieldsValue({ level: user.level })
    setRoleModalOpen(true)
  }

  // 提交角色修改
  const handleRoleSubmit = async () => {
    if (!editingUser) return
    try {
      const values = await roleForm.validateFields()
      setRoleModalLoading(true)
      const response = await fetch(`/api/admin/users/${editingUser.id}/role`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(values),
      })
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.errorMessage || t('common.operationFailedWithStatus', { status: response.status }))
      }
      message.success(t('admin.roleUpdated'))
      setRoleModalOpen(false)
      loadUsers()
    } catch (error: any) {
      message.error(t('common.operationFailed', { message: error.message }))
      console.error(t('admin.updateRoleFailed'), error)
    } finally {
      setRoleModalLoading(false)
    }
  }

  // 打开封禁弹窗
  const openBanModal = (user: UserRecord, type: 'temporary' | 'permanent' | 'unban') => {
    setEditingUser(user)
    setBanType(type)
    banForm.resetFields()
    setBanModalOpen(true)
  }

  // 提交封禁
  const handleBanSubmit = async () => {
    if (!editingUser) return
    try {
      const values = await banForm.validateFields()
      setBanModalLoading(true)

      let bannedUntil: string | null = null
      if (banType === 'permanent') {
        bannedUntil = 'permanent'
      } else if (banType === 'temporary') {
        bannedUntil = values.expiryDate.format('YYYY-MM-DDTHH:mm:ss.sssZ')
      }

      const response = await fetch(`/api/admin/users/${editingUser.id}/ban`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ bannedUntil }),
      })
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.errorMessage || t('common.operationFailedWithStatus', { status: response.status }))
      }
      message.success(banType === 'unban' ? t('admin.unbanned') : t('admin.banSuccess'))
      setBanModalOpen(false)
      loadUsers()
    } catch (error: any) {
      message.error(t('common.operationFailed', { message: error.message }))
      console.error(t('admin.banFailed'), error)
    } finally {
      setBanModalLoading(false)
    }
  }

  const isSuperAdmin = currentUser && currentUser.level >= 2

  // 发送验证邮件
  const handleSendVerification = async (userId: string) => {
    setSendingVerification(userId)
    try {
      const res = await fetch(`/api/admin/users/${userId}/send-verification`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.errorMessage || t('admin.sendFailed'))
      message.success(t('admin.verificationEmailSent'))
    } catch (err: any) {
      message.error(err.message || t('admin.sendFailed'))
    } finally {
      setSendingVerification(null)
    }
  }

  // 手动验证邮箱
  const handleVerifyEmail = async (userId: string) => {
    try {
      const res = await fetch(`/api/admin/users/${userId}/verify-email`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.errorMessage || t('common.operationFailed'))
      message.success(t('admin.emailVerified'))
      loadUsers()
    } catch (err: any) {
      message.error(err.message || t('common.operationFailed'))
    }
  }

  // 切换账号激活状态（权限：只能操作 level < 当前用户的用户，不能操作自己）
  const canToggleActive = (record: UserRecord): boolean => {
    if (!currentUser) return false
    if (record.id === currentUser.id) return false
    if (record.level >= currentUser.level) return false
    return true
  }

  // 打开用户名模式弹窗：先拉目标用户的模式详情（含活跃/预留角色清单）
  const openModeModal = async (user: UserRecord) => {
    setEditingUser(user)
    setModeDetail(null)
    setModeModalOpen(true)
    setModeModalLoading(true)
    try {
      const res = await fetch(`/api/admin/users/${user.id}/profile-mode`, {
        headers: { 'Authorization': `Bearer ${token}` },
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.errorMessage || t('common.operationFailed'))
      setModeDetail(data)
      setPendingMode(data.state?.mode === 'multi' ? 'multi' : 'single')
      setPendingKeepId(data.activeProfiles?.[0]?.id ?? null)
    } catch (err: any) {
      message.error(err.message || t('common.operationFailed'))
      setModeModalOpen(false)
    } finally {
      setModeModalLoading(false)
    }
  }

  // 提交模式调整
  const handleModeSubmit = async () => {
    if (!editingUser || !modeDetail) return
    // 切为单用户名且目标账号有多个可用角色时，必须先定保留谁（后端也会拦）
    if (pendingMode === 'single' && (modeDetail.activeProfiles?.length ?? 0) > 1 && !pendingKeepId) {
      message.warning(t('profile.modeChooseKeepRequired'))
      return
    }
    setModeSaving(true)
    try {
      const res = await fetch(`/api/admin/users/${editingUser.id}/profile-mode`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          mode: pendingMode,
          keepProfileId: pendingMode === 'single' ? pendingKeepId : null,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.errorMessage || t('common.operationFailed'))
      message.success(t('admin.profileModeUpdated'))
      setModeModalOpen(false)
      loadUsers()
    } catch (err: any) {
      message.error(err.message || t('common.operationFailed'))
    } finally {
      setModeSaving(false)
    }
  }

  const columns: ColumnsType<UserRecord> = [
    {
      title: t('admin.userId'),
      dataIndex: 'user_uid',
      key: 'user_uid',
      width: 90,
      render: (uid: number) => <Text strong>{uid}</Text>,
    },
    {
      title: t('admin.email'),
      dataIndex: 'email',
      key: 'email',
      width: 220,
      ellipsis: true,
      render: (email: string) => <span style={{ whiteSpace: 'nowrap' }}>{email}</span>,
    },
    {
      title: t('admin.role'),
      dataIndex: 'level',
      key: 'level',
      width: 180,
      render: (level: number, record: UserRecord) => (
        <Space>
          <Tag color={getRoleTagColor(level)}>{getRoleName(level, t)}</Tag>
          {isSuperAdmin && record.id !== currentUser?.id && record.level < 2 && (
            <Button type="link" size="small" onClick={() => openRoleModal(record)}>
              {t('common.edit')}
            </Button>
          )}
        </Space>
      ),
    },
    {
      title: t('admin.profileMode'),
      dataIndex: 'profile_mode',
      key: 'profile_mode',
      width: 170,
      render: (mode: string | undefined, record: UserRecord) => (
        <Space>
          <Tag color={mode === 'multi' ? 'purple' : 'blue'}>
            {mode === 'multi' ? t('profile.modeMulti') : t('profile.modeSingle')}
          </Tag>
          {/* 代设用户名模式仅超管可见（等级 1 管理员也看不到入口） */}
          {isSuperAdmin && (
            <Button type="link" size="small" onClick={() => openModeModal(record)}>
              {t('admin.profileModeAdjust')}
            </Button>
          )}
        </Space>
      ),
    },
    {
      title: t('admin.accountStatus'),
      dataIndex: 'banned_until',
      key: 'banned_until',
      width: 180,
      render: (bannedUntil: string | null) => {
        const status = getBanStatus(bannedUntil, t)
        return <Tag color={status.color}>{status.text}</Tag>
      },
    },
    {
      title: t('admin.activeStatus'),
      dataIndex: 'is_active',
      key: 'is_active',
      width: 120,
      render: (isActive: number, record: UserRecord) => {
        if (!canToggleActive(record)) {
          return isActive ? (
            <Tag color="green">{t('admin.normal')}</Tag>
          ) : (
            <Tag color="red">{t('admin.disabled')}</Tag>
          )
        }
        return (
          <Button
            type="link"
            size="small"
            onClick={() => handleToggleActive(record.id, !isActive)}
          >
            {isActive ? (
              <Tag color="green">{t('admin.normal')}</Tag>
            ) : (
              <Tag color="red">{t('admin.disabled')}</Tag>
            )}
          </Button>
        )
      },
    },
    {
      title: t('admin.banAction'),
      key: 'ban',
      width: 180,
      render: (_: any, record: UserRecord) => {
        // 不能操作自己
        if (record.id === currentUser?.id) return <Text type="secondary">-</Text>
        // 不能操作同级或更高级的用户
        if (record.level >= (currentUser?.level ?? 0)) return <Text type="secondary">-</Text>

        const banStatus = getBanStatus(record.banned_until, t)
        const isBanned = banStatus.color !== 'green'

        if (isBanned) {
          return (
            <Popconfirm
              title={t('admin.confirmUnban')}
              onConfirm={() => openBanModal(record, 'unban')}
              okText={t('common.confirm')}
              cancelText={t('common.cancel')}
            >
              <Button type="link" size="small" danger>
                {t('admin.unban')}
              </Button>
            </Popconfirm>
          )
        }

        return (
          <Space size={4}>
            <Button
              type="link"
              size="small"
              danger
              onClick={() => openBanModal(record, 'temporary')}
            >
              {t('admin.temporaryBan')}
            </Button>
            <Button
              type="link"
              size="small"
              danger
              onClick={() => openBanModal(record, 'permanent')}
            >
              {t('admin.permanentBan')}
            </Button>
          </Space>
        )
      },
    },
    {
      title: t('admin.emailVerification'),
      dataIndex: 'email_verified',
      key: 'email_verified',
      width: 200,
      render: (verified: number, record: UserRecord) => {
        const isVerified = verified === 1
        return (
          <Space>
            <Tag color={isVerified ? 'green' : 'orange'}>
              {isVerified ? t('admin.verified') : t('admin.unverified')}
            </Tag>
            {!isVerified && (
              <Space size={4}>
                <Tooltip title={t('admin.manualVerifyTooltip')}>
                  <Button
                    type="link"
                    size="small"
                    onClick={() => handleVerifyEmail(record.id)}
                  >
                    {t('admin.verify')}
                  </Button>
                </Tooltip>
                <Tooltip title={t('admin.sendVerificationEmailTooltip')}>
                  <Button
                    type="link"
                    size="small"
                    loading={sendingVerification === record.id}
                    onClick={() => handleSendVerification(record.id)}
                  >
                    {t('admin.sendEmail')}
                  </Button>
                </Tooltip>
              </Space>
            )}
          </Space>
        )
      },
    },
    {
      title: t('admin.registrationTime'),
      dataIndex: 'created_at',
      key: 'created_at',
      width: 160,
      render: (date: string) => new Date(date).toLocaleString(),
    },
  ]

  return (
    <div>
      <h2>{t('admin.userManagement')}</h2>
      <Table
        columns={columns}
        dataSource={users}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 20 }}
        size="small"
      />

      {/* 角色编辑弹窗 */}
      <Modal
        title={`${t('admin.editRoleModal')} - ${editingUser?.email}`}
        open={roleModalOpen}
        onOk={handleRoleSubmit}
        onCancel={() => setRoleModalOpen(false)}
        confirmLoading={roleModalLoading}
        okText={t('admin.confirmModify')}
        cancelText={t('common.cancel')}
      >
        <Form form={roleForm} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item
            name="level"
            label={t('admin.roleLevel')}
            rules={[{ required: true, message: t('admin.pleaseSelectRole') }]}
          >
            <Select>
              <Select.Option value={0}>{t('admin.normalUser')}</Select.Option>
              <Select.Option value={1}>{t('admin.admin')}</Select.Option>
              {isSuperAdmin && editingUser?.id === currentUser?.id && (
                <Select.Option value={2}>{t('admin.superAdmin')}</Select.Option>
              )}
            </Select>
          </Form.Item>
          <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)', marginTop: 4 }}>
            <div>{t('admin.level2Desc')}</div>
            <div>{t('admin.level1Desc')}</div>
            <div>{t('admin.level0Desc')}</div>
          </div>
        </Form>
      </Modal>

      {/* 用户名模式弹窗（仅超管）：代用户切换 single / multi */}
      <Modal
        title={`${t('admin.profileModeTitle')} - ${editingUser?.email}`}
        open={modeModalOpen}
        onOk={handleModeSubmit}
        onCancel={() => setModeModalOpen(false)}
        confirmLoading={modeSaving}
        okText={t('admin.confirmModify')}
        cancelText={t('common.cancel')}
        okButtonProps={{ disabled: modeDetail !== null && pendingMode === modeDetail.state.mode }}
        width={520}
      >
        {modeModalLoading ? (
          <div style={{ padding: '24px 0', textAlign: 'center' }}>
            <Spin />
          </div>
        ) : modeDetail ? (
          <>
            <div style={{ marginBottom: 16 }}>
              <Text type="secondary">{t('admin.profileModeCurrent')}：</Text>
              <Tag color={modeDetail.state.mode === 'multi' ? 'purple' : 'blue'}>
                {modeDetail.state.mode === 'multi' ? t('profile.modeMulti') : t('profile.modeSingle')}
              </Tag>
            </div>
            <Radio.Group
              value={pendingMode}
              onChange={(e) => {
                const next = e.target.value as 'single' | 'multi'
                setPendingMode(next)
                if (next === 'single') {
                  setPendingKeepId(modeDetail.activeProfiles?.[0]?.id ?? null)
                }
              }}
              style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
            >
              <Radio value="single">
                <div style={{ fontWeight: 500 }}>{t('profile.modeSingle')}</div>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {t('profile.modeSingleDesc')}
                </Text>
              </Radio>
              <Radio value="multi">
                <div style={{ fontWeight: 500 }}>{t('profile.modeMulti')}</div>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {t('profile.modeMultiDesc')}
                </Text>
              </Radio>
            </Radio.Group>

            {/* 切为单用户名且目标有多于 1 个可用角色时，必须指定保留哪一个 */}
            {pendingMode === 'single' && (modeDetail.activeProfiles?.length ?? 0) > 1 && (
              <div style={{ marginTop: 20 }}>
                <Text strong style={{ fontSize: 13, display: 'block', marginBottom: 8 }}>
                  {t('profile.modeKeepWhich')}
                </Text>
                <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8, lineHeight: 1.7 }}>
                  {t('profile.modeKeepHint', { count: (modeDetail.activeProfiles?.length ?? 0) - 1 })}
                </Text>
                <Radio.Group
                  value={pendingKeepId}
                  onChange={(e) => setPendingKeepId(e.target.value as string)}
                  style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
                >
                  {modeDetail.activeProfiles.map((p) => (
                    <Radio key={p.id} value={p.id}>
                      <Text code>{p.name}</Text>
                    </Radio>
                  ))}
                </Radio.Group>
              </div>
            )}
          </>
        ) : null}
      </Modal>

      {/* 封禁弹窗 */}
      <Modal
        title={
          banType === 'unban'
            ? `${t('admin.unbanModalTitle')} - ${editingUser?.email}`
            : banType === 'permanent'
              ? `${t('admin.permanentBanModalTitle')} - ${editingUser?.email}`
              : `${t('admin.temporaryBanModalTitle')} - ${editingUser?.email}`
        }
        open={banModalOpen}
        onOk={handleBanSubmit}
        onCancel={() => setBanModalOpen(false)}
        confirmLoading={banModalLoading}
        okText={t('common.confirm')}
        cancelText={t('common.cancel')}
        okButtonProps={{ danger: banType !== 'unban' }}
      >
        {banType === 'unban' ? (
          <div style={{ marginTop: 16 }}>
            <p>{t('admin.confirmUnbanMessage')}</p>
            <p style={{ color: 'rgba(255,255,255,0.6)', fontSize: 13 }}>{t('admin.unbanExplanation')}</p>
          </div>
        ) : banType === 'permanent' ? (
          <div style={{ marginTop: 16 }}>
            <p style={{ color: '#ff4d4f', fontWeight: 'bold' }}>{t('admin.permanentBanWarning')}</p>
            <p>{t('admin.afterPermanentBan')}</p>
            <ul>
              <li>{t('admin.userCannotLogin')}</li>
              <li>{t('admin.tokensCleared')}</li>
              <li>{t('admin.banCannotBeAutoRemoved')}</li>
            </ul>
          </div>
        ) : (
          <Form form={banForm} layout="vertical" style={{ marginTop: 16 }}>
            <Form.Item
              name="expiryDate"
              label={t('admin.banExpiryDate')}
              rules={[{ required: true, message: t('admin.pleaseSelectBanExpiryDate') }]}
            >
              <DatePicker
                style={{ width: '100%' }}
                showTime
                format="YYYY-MM-DD HH:mm"
                disabledDate={(current) => current && current < dayjs().startOf('day')}
                placeholder={t('admin.selectBanExpiryDate')}
              />
            </Form.Item>
            <p style={{ color: 'rgba(255,255,255,0.6)', fontSize: 13 }}>
              {t('admin.banAutoRemoval')}
            </p>
          </Form>
        )}
      </Modal>
    </div>
  )
}
