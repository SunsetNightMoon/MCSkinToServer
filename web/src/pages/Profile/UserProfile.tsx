import { compatFetch as fetch } from "../../utils/apiCompat" // 数据层适配：/api/* 自动翻译为 MSCTS 端点
import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Button, Descriptions, message, Tag, Divider, Typography,
  Modal, Form, Input, Spin, Alert, Space,
} from 'antd'
import { EditOutlined, CheckCircleOutlined, CloseCircleOutlined, MailOutlined, LinkOutlined, CopyOutlined, ExclamationCircleOutlined, LockOutlined, SafetyOutlined, KeyOutlined } from '@ant-design/icons'
import { useAuthStore } from '../../store/authStore'
import { SkinAvatar } from '../../components/SkinAvatar'
import { profileService } from '../../services/profileService'
import { usePageTitle } from '../../hooks/usePageTitle'
import { useTranslation } from 'react-i18next'

const { Text } = Typography

function getRoleNameKey(level: number): string {
  switch (level) {
    case 2: return 'profile.superAdmin'
    case 1: return 'profile.admin'
    default: return 'profile.user'
  }
}

function getRoleTagColor(level: number): string {
  switch (level) {
    case 2: return 'red'
    case 1: return 'blue'
    default: return 'default'
  }
}

interface ProfileInfo {
  id: string
  name: string
  skin_id?: string
  cape_id?: string
  name_changed_at?: string | null
}

export function UserProfile() {
  const { t } = useTranslation()
  usePageTitle(t('nav.profile'))
  const { user, token, skinUrl, profileName, setProfileName, clearAuth, updateUser, setSkinUrl } = useAuthStore()
  const navigate = useNavigate()

  // 角色信息
  const [profiles, setProfiles] = useState<ProfileInfo[]>([])
  const [loadingProfiles, setLoadingProfiles] = useState(false)

  // 编辑名称
  const [isEditModalOpen, setIsEditModalOpen] = useState(false)
  const [editName, setEditName] = useState('')
  const [checkResult, setCheckResult] = useState<{ available: boolean; message: string } | null>(null)
  const [checkingName, setCheckingName] = useState(false)
  const [savingName, setSavingName] = useState(false)
  // 发送验证邮件
  const [sendingVerify, setSendingVerify] = useState(false)

  // 注销账号
  const [deleteModalOpen, setDeleteModalOpen] = useState(false)
  const [deletePassword, setDeletePassword] = useState('')
  const [deletingAccount, setDeletingAccount] = useState(false)

  // 功能区 - 修改密码
  const [changePwdModalOpen, setChangePwdModalOpen] = useState(false)
  const [oldPassword, setOldPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [changingPassword, setChangingPassword] = useState(false)

  // 功能区 - 找回密码
  const [forgotPwdStep, setForgotPwdStep] = useState<0 | 1>(0)
  const [forgotPwdModalOpen, setForgotPwdModalOpen] = useState(false)
  const [resetCode, setResetCode] = useState('')
  const [forgotNewPassword, setForgotNewPassword] = useState('')
  const [forgotConfirmPassword, setForgotConfirmPassword] = useState('')
  const [sendingResetEmail, setSendingResetEmail] = useState(false)
  const [resettingPassword, setResettingPassword] = useState(false)

  // 获取角色信息和最新用户数据
  useEffect(() => {
    if (!user) return
    const fetchProfiles = async () => {
      setLoadingProfiles(true)
      try {
        const data = await profileService.getMe()
        // 同步更新用户信息（角色、验证状态等可能已被管理员修改）
        if (data.user) {
          updateUser(data.user)
        }
        if (data.skinUrl !== undefined) {
          setSkinUrl(data.skinUrl || null)
        }
        if (data.profiles) {
          setProfiles(data.profiles)
        }
      } catch (err: any) {
        console.error(t('profile.fetchProfileFailed'), err)
      } finally {
        setLoadingProfiles(false)
      }
    }
    fetchProfiles()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id])

  const primaryProfile = profiles[0]
  const currentGameName = primaryProfile?.name || profileName || ''
  const nameChangedAt = primaryProfile?.name_changed_at ?? undefined

  /**
   * Yggdrasil 认证服务器地址（展示给用户，并作为可拖拽的 authlib-injector 地址）。
   *
   * 取值 = `<API 根>` + `/api/yggdrasil`，其中 API 根是：
   *  1. VITE_API_URL —— 显式指定。本地开发由 web/.env.development 指向后端端口 3000；
   *     前后端分域或独立 API 域名时也用它。
   *  2. window.location.origin —— 生产部署默认值（站点自身域名）。
   *
   * 为什么必须带 `/api/yggdrasil` 这一段路径，而不是直接给裸域名：
   *  启动器拿到这个地址后第一件事是 `GET <地址>` 取元数据 JSON。生产部署里站点根路径
   *  `/` 必须留给 SPA（HashRouter 的文档入口就是 `/`），`GET /` 返回的是 index.html，
   *  启动器会判定「这不是认证服务器」。`/api/yggdrasil` 既能返回元数据，又落在反代
   *  必然转发给后端的 `/api` 前缀内，因此两种部署形态下都成立。
   *  （实测对照见 README「生产部署」：裸域名在本地可用、在生产不可用；带路径两者都可用。）
   *
   * ⚠️ 不要用开发服务器端口（5173）冒充认证服务器：vite 只代理了 `/authserver` 等固定
   * 前缀，`POST /authenticate` 与 `GET /` 都不通（实测 404 / HTML）；且启动器按此地址
   * 区分账号，同一后端用 5173 与 3000 添加会被视为两台不同服务器。
   */
  const apiBaseUrl = (
    import.meta.env.VITE_API_URL || window.location.origin
  ).replace(/\/+$/, '')
  // 允许把 VITE_API_URL 直接写成完整元数据地址，避免拼成 .../api/yggdrasil/api/yggdrasil
  const yggUrl = /\/api\/yggdrasil$/i.test(apiBaseUrl)
    ? apiBaseUrl
    : `${apiBaseUrl}/api/yggdrasil`
  const authlibUrl = `authlib-injector:yggdrasil-server:${encodeURIComponent(yggUrl)}`

  // 计算冷却
  function getCooldownInfo(): { inCooldown: boolean; daysRemaining: number; canChangeAt?: Date } {
    if (!nameChangedAt) return { inCooldown: false, daysRemaining: 0 }
    const lastChanged = new Date(nameChangedAt)
    const cooldownEnd = new Date(lastChanged)
    cooldownEnd.setDate(cooldownEnd.getDate() + 30)
    const now = new Date()
    if (now < cooldownEnd) {
      const daysRemaining = Math.ceil((cooldownEnd.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
      return { inCooldown: true, daysRemaining, canChangeAt: cooldownEnd }
    }
    return { inCooldown: false, daysRemaining: 0 }
  }

  const cooldown = getCooldownInfo()

  // 发送验证邮件
  const handleSendVerification = async () => {
    setSendingVerify(true)
    try {
      const res = await fetch('/api/auth/send-verification', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.errorMessage || t('profile.sendFailed'))
      message.success(t('profile.verificationEmailSent'))
    } catch (err: any) {
      message.error(err.message || t('profile.sendFailed'))
    } finally {
      setSendingVerify(false)
    }
  }

  // 注销账号
  const handleDeleteAccount = async () => {
    if (!deletePassword) {
      message.error(t('profile.enterPassword'))
      return
    }

    setDeletingAccount(true)
    try {
      const res = await fetch('/api/auth/delete-account', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ password: deletePassword }),
      })

      const data = await res.json()
      if (!res.ok) {
        throw new Error(data.errorMessage || t('profile.deleteFailed'))
      }

      message.success(t('profile.accountDeleted'))
      clearAuth()
      navigate('/login')
    } catch (err: any) {
      message.error(err.message || t('profile.deleteFailed'))
    } finally {
      setDeletingAccount(false)
    }
  }

  // 修改密码
  const handleChangePassword = async () => {
    if (!oldPassword || !newPassword || !confirmPassword) {
      message.error(t('profile.fillAllFields'))
      return
    }
    if (newPassword.length < 6) {
      message.error(t('profile.passwordMinLength'))
      return
    }
    if (newPassword !== confirmPassword) {
      message.error(t('profile.passwordMismatch'))
      return
    }

    setChangingPassword(true)
    try {
      const res = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ oldPassword, newPassword }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.errorMessage || t('profile.modifyFailed'))

      message.success(t('profile.passwordChanged'))
      setChangePwdModalOpen(false)
      setOldPassword('')
      setNewPassword('')
      setConfirmPassword('')
      // 修改密码后要求重新登录
      clearAuth()
      navigate('/login')
    } catch (err: any) {
      message.error(err.message || t('profile.modifyFailed'))
    } finally {
      setChangingPassword(false)
    }
  }

  // 发送密码重置邮件
  const handleSendResetEmail = async () => {
    setSendingResetEmail(true)
    try {
      const res = await fetch('/api/auth/send-reset-email', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.errorMessage || t('profile.sendFailed'))

      message.success(t('profile.resetEmailSent'))
      setForgotPwdStep(1)
    } catch (err: any) {
      message.error(err.message || t('profile.sendFailed'))
    } finally {
      setSendingResetEmail(false)
    }
  }

  // 使用验证码重置密码
  const handleResetPassword = async () => {
    if (!resetCode || !forgotNewPassword || !forgotConfirmPassword) {
      message.error(t('profile.fillAllFields'))
      return
    }
    if (forgotNewPassword.length < 6) {
      message.error(t('profile.passwordMinLength'))
      return
    }
    if (forgotNewPassword !== forgotConfirmPassword) {
      message.error(t('profile.passwordMismatch'))
      return
    }

    setResettingPassword(true)
    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ code: resetCode, newPassword: forgotNewPassword }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.errorMessage || t('profile.resetFailed'))

      message.success(t('profile.passwordReset'))
      setForgotPwdModalOpen(false)
      setForgotPwdStep(0)
      setResetCode('')
      setForgotNewPassword('')
      setForgotConfirmPassword('')
      clearAuth()
      navigate('/login')
    } catch (err: any) {
      message.error(err.message || t('profile.resetFailed'))
    } finally {
      setResettingPassword(false)
    }
  }

  const handleLogout = () => {
    clearAuth()
    message.success(t('profile.loggedOut'))
    navigate('/login')
  }

  // 打开编辑弹窗
  const openEditModal = () => {
    setEditName(currentGameName)
    setCheckResult(null)
    setIsEditModalOpen(true)
  }

  // 检测名称可用性
  const handleCheckName = async () => {
    if (!editName || editName.length < 3 || editName.length > 16) {
      setCheckResult({ available: false, message: t('profile.nameLengthError') })
      return
    }
    if (!/^[a-zA-Z0-9_]+$/.test(editName)) {
      setCheckResult({ available: false, message: t('profile.nameFormatError') })
      return
    }
    if (editName === currentGameName) {
      setCheckResult({ available: false, message: t('profile.sameNameError') })
      return
    }
    setCheckingName(true)
    try {
      const result = await profileService.checkNameAvailability(editName)
      setCheckResult(result)
    } catch (err: any) {
      setCheckResult({ available: false, message: err.response?.data?.errorMessage || t('profile.checkFailed') })
    } finally {
      setCheckingName(false)
    }
  }

  // 保存名称
  const handleSaveName = async () => {
    if (!primaryProfile?.id) {
      message.error(t('profile.noCharacterFound'))
      return
    }
    setSavingName(true)
    try {
      const result = await profileService.updateName(primaryProfile.id, editName)
      message.success(result.message || t('profile.nameUpdated'))
      setProfileName(editName)
      // 刷新角色信息
      const meData = await profileService.getMe()
      if (meData.profiles) {
        setProfiles(meData.profiles)
      }
      setIsEditModalOpen(false)
    } catch (err: any) {
      const errMsg = err.response?.data?.errorMessage || t('profile.updateFailed')
      if (err.response?.status === 429) {
        const days = err.response?.data?.days_remaining
        message.error(t('profile.nameChangeCooldown', { days }))
      } else {
        message.error(errMsg)
      }
    } finally {
      setSavingName(false)
    }
  }

  if (!user) {
    return <div style={{ padding: 20 }}>{t('profile.pleaseLoginFirst')}</div>
  }

  // 兼容后端返回的 number 类型（SQLite 返回 0/1）
  const isVerified = user.email_verified === true || user.email_verified === 1

  // 封禁状态判断
  const bannedUntil = user.banned_until as string | null
  const isBanned = bannedUntil !== null && bannedUntil !== '' && (
    bannedUntil === 'permanent' || new Date(bannedUntil) > new Date()
  )
  const isPermanentBan = bannedUntil === 'permanent'
  const banExpiryText = !isPermanentBan && bannedUntil
    ? t('profile.unbanDate', { date: new Date(bannedUntil).toLocaleDateString('zh-CN') })
    : null

  return (
    <div style={{ maxWidth: 900, margin: '0 auto', padding: '20px' }}>
      <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, padding: 24 }}>
        {/* 头部：头像 + 邮箱 + UID */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 20, marginBottom: 24 }}>
          <SkinAvatar skinUrl={skinUrl || undefined} size={80} />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 20, fontWeight: 'bold', marginBottom: 4, color: 'var(--text-primary)' }}>
              {currentGameName || user.email}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <Text type="secondary">{t('profile.uid')}: {user.user_uid}</Text>
              <Divider type="vertical" />
              <Tag color={getRoleTagColor(user.level)}>{t(getRoleNameKey(user.level))}</Tag>
              {isVerified ? (
                <Tag color="green">{t('profile.verified')}</Tag>
              ) : (
                <Tag color="orange">{t('profile.unverified')}</Tag>
              )}
            </div>
          </div>
        </div>

        {/* 账号状态 */}
        {isBanned ? (
          <div style={{
            background: 'rgba(207, 19, 34, 0.12)',
            border: '1px solid rgba(207, 19, 34, 0.3)',
            borderRadius: 8,
            padding: '12px 16px',
            marginBottom: 24,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Text strong style={{ color: '#ff7875' }}>{t('profile.accountBanned')}</Text>
              {isPermanentBan ? (
                <Tag color="red">{t('profile.permanentlyBanned')}</Tag>
              ) : banExpiryText ? (
                <Tag color="orange">{banExpiryText}</Tag>
              ) : null}
            </div>
            {banExpiryText && (
              <Text type="secondary" style={{ fontSize: 12 }}>
                {t('profile.banExpiryDate')}：{new Date(bannedUntil!).toLocaleDateString('zh-CN', {
                  year: 'numeric', month: 'long', day: 'numeric'
                })}
              </Text>
            )}
          </div>
        ) : (
          <div style={{
            background: 'rgba(56, 158, 13, 0.12)',
            border: '1px solid rgba(56, 158, 13, 0.3)',
            borderRadius: 8,
            padding: '12px 16px',
            marginBottom: 24,
          }}>
            <Text strong style={{ color: '#95de64' }}>{t('profile.accountStatusNormal')}</Text>
          </div>
        )}

        {/* 详细信息 */}
        <Descriptions column={1} bordered size="small">
          <Descriptions.Item label={t('profile.userId')}>{user.user_uid}</Descriptions.Item>
          <Descriptions.Item label={t('profile.playerName')}>
            <Space>
              <Text strong style={{ fontSize: 16 }}>
                {loadingProfiles ? <Spin size="small" /> : (currentGameName || '—')}
              </Text>
              <Button size="small" icon={<EditOutlined />} onClick={openEditModal}>
                {t('common.edit')}
              </Button>
            </Space>
            {cooldown.inCooldown && (
              <div style={{ marginTop: 4 }}>
                <Tag color="orange">
                  {t('profile.nameChangeCooldown', { days: cooldown.daysRemaining })}
                </Tag>
              </div>
            )}
          </Descriptions.Item>
          <Descriptions.Item label={t('profile.email')}>
            <Space>
              <Text>{user.email}</Text>
              {isVerified ? (
                <Tag color="green">{t('profile.verified')}</Tag>
              ) : (
                <>
                  <Tag color="orange">{t('profile.unverified')}</Tag>
                  <Button size="small" icon={<MailOutlined />} loading={sendingVerify} onClick={handleSendVerification}>
                    {t('profile.verifyNow')}
                  </Button>
                </>
              )}
            </Space>
          </Descriptions.Item>
          <Descriptions.Item label={t('profile.role')}>
            <Tag color={getRoleTagColor(user.level)}>{t(getRoleNameKey(user.level))}</Tag>
            <Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>
              (Level {user.level})
            </Text>
          </Descriptions.Item>
          <Descriptions.Item label={t('profile.accountStatus')}>
            {isBanned ? (
              isPermanentBan ? (
                <Tag color="red">{t('profile.banned')} &lt;{t('profile.permanentlyBanned')}&gt;</Tag>
              ) : (
                <Tag color="orange">
                  {t('profile.banned')} &lt;{new Date(bannedUntil!).toLocaleDateString('zh-CN')} {t('profile.unbanDate')}&gt;
                </Tag>
              )
            ) : (
              <Tag color="green">{t('profile.normal')}</Tag>
            )}
          </Descriptions.Item>
        </Descriptions>

        {/* 操作按钮 */}
        <div style={{ marginTop: 24, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <Button type="primary" onClick={() => navigate('/upload')}>
            {t('profile.uploadSkin')}
          </Button>
          <Button onClick={() => navigate('/my-skins')}>
            {t('profile.mySkins')}
          </Button>
          <Button onClick={() => navigate('/my-capes')}>
            {t('myCapes.title')}
          </Button>
          {user.level >= 1 && (
            <Button type="dashed" onClick={() => navigate('/admin')}>
              {t('profile.adminPanel')}
            </Button>
          )}
          <Button danger onClick={handleLogout} style={{ marginLeft: 'auto' }}>
            {t('profile.logout')}
          </Button>
        </div>
      </div>

      {/* Yggdrasil 认证服务器卡片 */}
      <div style={{
        background: 'var(--bg-card)',
        border: '1px solid var(--border-color)',
        borderRadius: 12,
        padding: 24,
        marginTop: 20,
      }}>
        <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 20 }}>
          <LinkOutlined style={{ marginRight: 8 }} />
          {t('profile.addYggdrasilServer')}
        </div>

        <div style={{
          background: 'var(--bg-inner)',
          border: '1px dashed var(--border-color)',
          borderRadius: 12,
          padding: '32px 24px',
          textAlign: 'center',
          marginBottom: 20,
        }}>
          <div
            draggable={true}
            onDragStart={(e) => {
              e.dataTransfer.setData('text/plain', authlibUrl)
              e.dataTransfer.setData('text/uri-list', authlibUrl)
              e.dataTransfer.effectAllowed = 'all'
            }}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              padding: '14px 32px',
              background: '#238636',
              color: '#fff',
              borderRadius: 10,
              fontSize: 15,
              fontWeight: 600,
              textDecoration: 'none',
              cursor: 'grab',
              userSelect: 'none',
              boxShadow: '0 4px 16px rgba(35, 134, 54, 0.35)',
              transition: 'all 0.2s ease',
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.filter = 'brightness(1.12)'
              ;(e.currentTarget as HTMLElement).style.transform = 'translateY(-2px)'
              ;(e.currentTarget as HTMLElement).style.boxShadow = '0 8px 24px rgba(35, 134, 54, 0.45)'
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.filter = 'brightness(1)'
              ;(e.currentTarget as HTMLElement).style.transform = 'translateY(0)'
              ;(e.currentTarget as HTMLElement).style.boxShadow = '0 4px 16px rgba(35, 134, 54, 0.35)'
            }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12h14M12 5l7 7-7 7"/>
            </svg>
            {t('profile.dragToLauncher')}
          </div>
          <div style={{ marginTop: 12, fontSize: 13, color: 'var(--text-weak)' }}>
            {t('profile.supportsYggdrasil')}
          </div>
        </div>

        <Divider style={{ borderColor: 'var(--border-color)', margin: '16px 0' }} />

        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 10 }}>
            {t('profile.manualEntry')}
          </div>
          <Space.Compact style={{ width: '100%' }}>
            <Input
              value={yggUrl}
              readOnly
              style={{ fontFamily: 'monospace', fontSize: 13 }}
            />
            <Button
              icon={<CopyOutlined />}
              onClick={() => {
                navigator.clipboard.writeText(yggUrl)
                message.success(t('profile.copied'))
              }}
            >
              {t('profile.copy')}
            </Button>
          </Space.Compact>
        </div>

        <div style={{ marginTop: 16, fontSize: 12, color: 'var(--text-subtle)', lineHeight: 1.8 }}>
          <div style={{ marginBottom: 4, fontWeight: 600, color: 'var(--text-muted)' }}>{t('profile.usageInstructions')}</div>
          <div>{t('profile.dragInstruction')}</div>
          <div>{t('profile.manualInstruction')}</div>
          <div>{t('profile.afterAdding')}</div>
        </div>
      </div>

      {/* 功能区 + 危险区 */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: 16,
        marginTop: 20,
      }}>
        {/* 功能区卡片 - 所有用户可见 */}
        <div style={{
          background: 'rgba(82,196,26,0.06)',
          border: '1px solid rgba(82,196,26,0.3)',
          borderRadius: 12,
          padding: 24,
          gridColumn: user.level >= 2 ? '1 / -1' : undefined,
        }}>
          <div style={{ fontSize: 16, fontWeight: 600, color: '#52c41a', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
            <SafetyOutlined />
            {t('profile.securityZone')}
          </div>
          <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16, lineHeight: 1.8 }}>
            <div>{t('profile.manageSecurity')}</div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <Button
              icon={<LockOutlined />}
              size="large"
              onClick={() => {
                setOldPassword('')
                setNewPassword('')
                setConfirmPassword('')
                setChangePwdModalOpen(true)
              }}
              style={{ fontWeight: 500, justifyContent: 'flex-start' }}
            >
              {t('profile.modifyPassword')}
            </Button>
            <Button
              icon={<KeyOutlined />}
              size="large"
              onClick={() => {
                setForgotPwdStep(0)
                setResetCode('')
                setForgotNewPassword('')
                setForgotConfirmPassword('')
                setForgotPwdModalOpen(true)
              }}
              style={{ fontWeight: 500, justifyContent: 'flex-start' }}
            >
              {t('profile.recoverPassword')}
            </Button>
          </div>
        </div>

        {/* 危险区卡片 - 仅非超级管理员可见 */}
        {user.level < 2 && (
          <div style={{
            background: 'rgba(255,77,79,0.06)',
            border: '1px solid rgba(255,77,79,0.3)',
            borderRadius: 12,
            padding: 24,
          }}>
            <div style={{ fontSize: 16, fontWeight: 600, color: '#ff4d4f', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
              <ExclamationCircleOutlined />
              {t('profile.dangerZone')}
            </div>
            <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16, lineHeight: 1.8 }}>
              <div>{t('profile.permanentlyDeleteWarning')}<Text strong style={{ color: '#ff4d4f' }}>{t('profile.permanentlyDelete')}</Text>{t('profile.deleteWarning')}</div>
              <div>{t('profile.accountInfo')}</div>
              <div>{t('profile.uploadedSkins')}</div>
              <div>{t('profile.characterInfo')}</div>
              <div>{t('profile.favoriteRecords')}</div>
              <div style={{ marginTop: 8, color: 'var(--text-subtle)' }}>{t('profile.cannotRecover')}</div>
            </div>
            <Button
              danger
              size="large"
              onClick={() => {
                setDeletePassword('')
                setDeleteModalOpen(true)
              }}
              style={{ fontWeight: 500 }}
            >
              {t('profile.deleteMyAccount')}
            </Button>
          </div>
        )}
      </div>

      {/* 注销账号确认弹窗 */}
      <Modal
        title={
          <span style={{ color: '#ff4d4f' }}>
            <ExclamationCircleOutlined style={{ marginRight: 8 }} />
            {t('profile.confirmDeleteAccount')}
          </span>
        }
        open={deleteModalOpen}
        onCancel={() => {
          setDeleteModalOpen(false)
          setDeletePassword('')
        }}
        footer={[
          <Button key="cancel" onClick={() => {
            setDeleteModalOpen(false)
            setDeletePassword('')
          }}>
            {t('profile.cancel')}
          </Button>,
          <Button
            key="delete"
            type="primary"
            danger
            loading={deletingAccount}
            disabled={!deletePassword}
            onClick={handleDeleteAccount}
          >
            {t('profile.confirmDelete')}
          </Button>,
        ]}
      >
        <div style={{ marginTop: 16, marginBottom: 16 }}>
          <div style={{ marginBottom: 12, color: 'var(--text-secondary)' }}>
            {t('profile.permanentlyDeleteAccount')}<Text strong style={{ color: '#ff4d4f' }}>{t('profile.permanentlyDeleteData')}</Text>{t('profile.accountAndAllData')}
          </div>
          <div style={{ marginBottom: 16, padding: 12, background: 'rgba(255,77,79,0.08)', borderRadius: 8, fontSize: 13, color: 'var(--text-muted)' }}>
            <div style={{ marginBottom: 4, fontWeight: 500, color: 'var(--text-secondary)' }}>{t('profile.dataWillBeDeleted')}</div>
            <div>{t('profile.emailAndPassword')}</div>
            <div>{t('profile.skinsAndCapes')}</div>
            <div>{t('profile.gameId')}</div>
            <div>{t('profile.favorites')}</div>
          </div>
          <div style={{ marginBottom: 8, color: 'var(--text-muted)' }}>{t('profile.enterPasswordToConfirm')}</div>
          <Input.Password
            value={deletePassword}
            onChange={(e) => setDeletePassword(e.target.value)}
            placeholder={t('profile.enterLoginPassword')}
            onPressEnter={handleDeleteAccount}
            style={{ fontSize: 14 }}
          />
        </div>
      </Modal>

      {/* 修改密码弹窗 */}
      <Modal
        title={<span><LockOutlined style={{ marginRight: 8 }} />{t('profile.changePassword')}</span>}
        open={changePwdModalOpen}
        onCancel={() => {
          setChangePwdModalOpen(false)
          setOldPassword('')
          setNewPassword('')
          setConfirmPassword('')
        }}
        footer={[
          <Button key="cancel" onClick={() => {
            setChangePwdModalOpen(false)
            setOldPassword('')
            setNewPassword('')
            setConfirmPassword('')
          }}>
            {t('profile.cancel')}
          </Button>,
          <Button
            key="change"
            type="primary"
            loading={changingPassword}
            disabled={!oldPassword || !newPassword || !confirmPassword}
            onClick={handleChangePassword}
          >
            {t('profile.confirmModify')}
          </Button>,
        ]}
      >
        <Form layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item label={t('profile.oldPassword')} required>
            <Input.Password
              value={oldPassword}
              onChange={(e) => setOldPassword(e.target.value)}
              placeholder={t('profile.enterCurrentPassword')}
            />
          </Form.Item>
          <Form.Item label={t('profile.newPassword')} required>
            <Input.Password
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder={t('profile.enterNewPassword')}
            />
          </Form.Item>
          <Form.Item label={t('profile.confirmNewPassword')} required>
            <Input.Password
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder={t('profile.reenterNewPassword')}
              onPressEnter={handleChangePassword}
            />
          </Form.Item>
        </Form>
      </Modal>

      {/* 找回密码弹窗 */}
      <Modal
        title={<span><KeyOutlined style={{ marginRight: 8 }} />{forgotPwdStep === 0 ? t('profile.retrievePassword') : t('profile.enterVerificationCode')}</span>}
        open={forgotPwdModalOpen}
        onCancel={() => {
          setForgotPwdModalOpen(false)
          setForgotPwdStep(0)
          setResetCode('')
          setForgotNewPassword('')
          setForgotConfirmPassword('')
        }}
        footer={forgotPwdStep === 0 ? [
          <Button key="cancel" onClick={() => {
            setForgotPwdModalOpen(false)
            setForgotPwdStep(0)
          }}>
            {t('profile.cancel')}
          </Button>,
          <Button
            key="send"
            type="primary"
            loading={sendingResetEmail}
            onClick={handleSendResetEmail}
          >
            {t('profile.sendResetEmail')}
          </Button>,
        ] : [
          <Button key="back" onClick={() => setForgotPwdStep(0)}>
            {t('profile.previousStep')}
          </Button>,
          <Button
            key="reset"
            type="primary"
            loading={resettingPassword}
            disabled={!resetCode || !forgotNewPassword || !forgotConfirmPassword}
            onClick={handleResetPassword}
          >
            {t('profile.confirmReset')}
          </Button>,
        ]}
      >
        {forgotPwdStep === 0 ? (
          <div style={{ marginTop: 16 }}>
            <p style={{ color: 'var(--text-secondary)', marginBottom: 12 }}>
              {t('profile.weWillSendResetEmail')}<Text strong>{user.email}</Text>{t('profile.sendResetEmailMessage')}
            </p>
            <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>
              {t('profile.verificationCodeValidity')}
            </p>
          </div>
        ) : (
          <Form layout="vertical" style={{ marginTop: 16 }}>
            <Form.Item label={t('profile.verificationCode')} required>
              <Input
                value={resetCode}
                onChange={(e) => setResetCode(e.target.value)}
                placeholder={t('profile.enter8DigitCode')}
                maxLength={8}
              />
            </Form.Item>
            <Form.Item label={t('profile.newPassword')} required>
              <Input.Password
                value={forgotNewPassword}
                onChange={(e) => setForgotNewPassword(e.target.value)}
                placeholder={t('profile.enterNewPasswordMin6')}
              />
            </Form.Item>
            <Form.Item label={t('profile.confirmNewPassword')} required>
              <Input.Password
                value={forgotConfirmPassword}
                onChange={(e) => setForgotConfirmPassword(e.target.value)}
                placeholder={t('profile.reenterNewPassword')}
                onPressEnter={handleResetPassword}
              />
            </Form.Item>
          </Form>
        )}
      </Modal>

      {/* 编辑名称弹窗 */}
      <Modal
        title={t('profile.editPlayerName')}
        open={isEditModalOpen}
        onCancel={() => setIsEditModalOpen(false)}
        footer={[
          <Button key="cancel" onClick={() => setIsEditModalOpen(false)}>
            {t('profile.cancel')}
          </Button>,
          <Button
            key="save"
            type="primary"
            loading={savingName}
            disabled={!checkResult?.available || cooldown.inCooldown}
            onClick={handleSaveName}
          >
            {t('common.save')}
          </Button>,
        ]}
      >
        {cooldown.inCooldown && (
          <Alert
            type="warning"
            message={t('profile.nameChangeCooldown', { days: cooldown.daysRemaining })}
            description={`${t('profile.canChangeNameAt')}：${cooldown.canChangeAt?.toLocaleDateString('zh-CN')}`}
            style={{ marginBottom: 16 }}
            showIcon
          />
        )}

        <Form layout="vertical">
          <Form.Item label={t('profile.currentName')}>
            <Input value={currentGameName} disabled />
          </Form.Item>
          <Form.Item label={t('profile.newName')}>
            <Space.Compact style={{ width: '100%' }}>
              <Input
                value={editName}
                onChange={(e) => {
                  setEditName(e.target.value)
                  setCheckResult(null)
                }}
                placeholder={t('profile.nameLengthHint')}
                maxLength={16}
                disabled={cooldown.inCooldown}
              />
              <Button
                onClick={handleCheckName}
                loading={checkingName}
                disabled={!editName || cooldown.inCooldown}
              >
                {t('profile.checkAvailability')}
              </Button>
            </Space.Compact>
          </Form.Item>
        </Form>

        {checkResult && (
          <div style={{ marginTop: 8 }}>
            {checkResult.available ? (
              <Alert
                type="success"
                icon={<CheckCircleOutlined />}
                message={checkResult.message}
                showIcon
              />
            ) : (
              <Alert
                type="error"
                icon={<CloseCircleOutlined />}
                message={checkResult.message}
                showIcon
              />
            )}
          </div>
        )}
      </Modal>
    </div>
  )
}
