import { compatFetch as fetch } from "../../utils/apiCompat" // 数据层适配：/api/* 自动翻译为 MSCTS 端点
import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Button, Descriptions, message, Tag, Divider, Typography,
  Modal, Form, Input, Spin, Alert, Space, Radio, Popconfirm,
} from 'antd'
import { EditOutlined, CheckCircleOutlined, CloseCircleOutlined, MailOutlined, LinkOutlined, CopyOutlined, ExclamationCircleOutlined, LockOutlined, SafetyOutlined, KeyOutlined, UserSwitchOutlined, ClockCircleOutlined, PlusOutlined, DeleteOutlined } from '@ant-design/icons'
import { useAuthStore } from '../../store/authStore'
import { SkinAvatar } from '../../components/SkinAvatar'
import { profileService } from '../../services/profileService'
import {
  accountSecurityService,
  type ProfileModeState,
  type EmailSecurityStatus,
  type EmailChangeRequestResult,
} from '../../services/accountSecurityService'
import { usePageTitle } from '../../hooks/usePageTitle'
import { useTranslation } from 'react-i18next'
// 密码长度口径：与后端（8-128 位）保持一致，见 utils/passwordPolicy.ts 的说明
import { MIN_PASSWORD_LENGTH } from '../../utils/passwordPolicy'

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
  /**
   * 0003：`reserved` = 预留态。数据与名字都保留（否则冷却期满就换不回来了），
   * 但当前不作为会话角色使用，也不出现在启动器的可选角色列表里。
   */
  status?: 'active' | 'reserved'
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
  /**
   * 找回密码弹窗。
   *
   * 流程为「发链接」而非「页面内输入验证码」：重置邮件里带的是一次性链接，
   * 用户点链接进入 /reset-password 页设置新密码。
   *
   * 为什么不做站内验证码：那需要在库里另存一份短码并配尝试次数上限，
   * 而短码空间小、可被在线爆破，安全性明显低于 256 bit 的链接令牌。
   * 旧版规划过 8 位验证码（i18n 里还留着 enter8DigitCode 等键），但后端从未实现。
   */
  const [forgotPwdModalOpen, setForgotPwdModalOpen] = useState(false)
  /** 本次弹窗里重置邮件是否已成功发出 */
  const [resetEmailSent, setResetEmailSent] = useState(false)
  const [sendingResetEmail, setSendingResetEmail] = useState(false)

  // ---- 0003：用户名模式 ----
  const [modeState, setModeState] = useState<ProfileModeState | null>(null)
  const [modeModalOpen, setModeModalOpen] = useState(false)
  /** 弹窗里选中的目标模式 */
  const [pendingMode, setPendingMode] = useState<'single' | 'multi'>('single')
  /** 切/决定为单用户名时选中的「保留哪个 ID」 */
  const [pendingKeepId, setPendingKeepId] = useState<string | null>(null)
  const [savingMode, setSavingMode] = useState(false)
  /** 正在启用的预留角色 id（按钮 loading 用） */
  const [activatingId, setActivatingId] = useState<string | null>(null)

  // ---- 0003：邮箱安全 ----
  const [emailStatus, setEmailStatus] = useState<EmailSecurityStatus | null>(null)
  const [backupModalOpen, setBackupModalOpen] = useState(false)
  const [backupInput, setBackupInput] = useState('')
  const [sendingBackup, setSendingBackup] = useState(false)
  const [changeModalOpen, setChangeModalOpen] = useState(false)
  const [changeTarget, setChangeTarget] = useState<'primary' | 'backup'>('primary')
  const [changeInput, setChangeInput] = useState('')
  const [requestingChange, setRequestingChange] = useState(false)
  /** 本次发起改邮箱后服务端回的信息（授权信发给了谁），用于「去收信」面板 */
  const [changeSent, setChangeSent] = useState<EmailChangeRequestResult | null>(null)

  /**
   * 拉取当前用户的角色列表。
   *
   * 独立成函数而不是只写在 effect 里：模式切换、启用预留角色、删角色之后都要重拉，
   * 否则界面会停在旧状态（例如冷却已启动，用户却还能再点一次「启用」）。
   */
  const loadProfiles = async () => {
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

  /**
   * 拉取用户名模式与邮箱安全状态。
   *
   * 邮箱状态挂了单独的 catch：它是增量能力，未接线的部署上 `/api/me/email-status`
   * 可能不存在，不该因此把整页拖垮（模式信息仍应正常显示）。
   */
  const loadAccountSecurity = async () => {
    try {
      const [mode, mail] = await Promise.all([
        accountSecurityService.getProfileMode(),
        accountSecurityService.getEmailStatus().catch(() => null),
      ])
      setModeState(mode)
      if (mail) {
        setEmailStatus(mail)
        // 主邮箱可能在这次操作里刚被改掉 / 刚被验证（改邮箱、点验证链接），
        // 而 store 里的 user 是**登录那一刻的快照**。不同步的话「邮箱」一行会出现
        // 新地址配旧验证标记、甚至显示旧地址的错位 —— 界面上两个字段来自两个时间点。
        updateUser({ email: mail.email, email_verified: mail.emailVerified })
      }
      // 存量多角色账号：一进页面就把「先选一个 ID」的弹窗推出来。
      // 不推的话用户点任何写操作都只会拿到 409，却不知道要做什么。
      if (mode.decisionRequired && !modeModalOpen) {
        setPendingMode('single')
        setPendingKeepId(null)
        setModeModalOpen(true)
      }
    } catch (err) {
      console.error('加载账号安全状态失败', err)
    }
  }

  // 获取角色信息和最新用户数据
  useEffect(() => {
    if (!user) return
    loadProfiles()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id])

  useEffect(() => {
    if (!user) return
    loadAccountSecurity()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id])

  /**
   * 有进行中的改邮箱请求时，轮询服务端的幂等收敛点。
   *
   * 两封邮件通常在不同标签页 / 不同设备上被点开，本页无从得知对方进度；
   * 后端提供了 `finalize` 这个收敛端点，轮询它就能在「两枚都确认了」的瞬间
   * 自动把变更落地，顺带自愈「两枚被并发点开」的死锁（详见后端注释）。
   * 页面不可见时不发请求 —— 后台标签页不该持续打接口。
   */
  useEffect(() => {
    const pending = emailStatus?.pendingChange
    if (!user || !pending) return
    const timer = window.setInterval(async () => {
      if (document.visibilityState !== 'visible') return
      try {
        const res = await accountSecurityService.finalizeEmailChange()
        if (res.completed) {
          message.success(t('profile.changeEmailDone'))
          setChangeModalOpen(false)
        }
        await loadAccountSecurity()
        if (res.completed) await loadProfiles()
      } catch {
        // 轮询失败静默处理：可能只是网络抖动，下一轮会再来
      }
    }, 8000)
    return () => window.clearInterval(timer)
    // exhaustive-deps 会要求把 loadAccountSecurity/loadProfiles 也列进来，
    // 但它们是每次渲染重建的函数，列进去会让定时器不停重建。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, emailStatus?.pendingChange?.id, emailStatus?.pendingChange?.verifyConfirmed, emailStatus?.pendingChange?.authorizeConfirmed])

  /**
   * 0003：角色按状态分组。
   *
   * 「预留口」只在**单用户名模式 + 确实存在预留角色**时可见 ——
   * 从没开过多用户（没有预留角色）、或当前就是多用户名模式的账号，看不到这一块。
   * 这正是产品要求里「单用户模式没打开过 / 是多 ID 的情况下看不到多用户预留口」的实现点。
   *
   * 先于 primaryProfile 求值：当前角色必须是 **active** 的那个。
   * 直接取 `profiles[0]` 在单用户名模式下会取到预留角色（预留角色排在前面时），
   * 于是页面会把一个不可用的 ID 当成「玩家名称」显示出来。
   */
  const activeProfiles = profiles.filter((p) => (p.status ?? 'active') === 'active')
  const reservedProfiles = profiles.filter((p) => p.status === 'reserved')
  const primaryProfile = activeProfiles[0] ?? profiles[0]
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

  /**
   * 旧版冷却估算：name_changed_at + 30 天。
   *
   * 只在 `modeState` 拿不到时使用（后端还是 0003 之前的版本 / 请求还没回来）。
   */
  const legacyCooldown = (() => {
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
  })()

  /**
   * 改名 / 换 ID 的冷却信息。
   *
   * 0003 起**以后端为准**：单用户名模式下改名与「启用预留角色」共用同一个 30 天窗口，
   * 且「从未改名」不设冷却（后端把这种情形的时间戳抬到严格大于 created_at，
   * 再把 name_changed_at === created_at 判为「从未改名」）。这两条规则后端都已实现，
   * 并由 `/api/me/profile-mode` 直接给出 cooldownUntil / cooldownDaysRemaining。
   *
   * 这里曾经只按 name_changed_at + 30 天做本地估算，后果是**新注册用户一进页面就被
   * 告知「改名冷却中：30 天后可再次改名」，而且改名输入框被 disabled 锁死** ——
   * 后端其实允许他免费改名一次。本地估算区分不了「从未改名」与「刚改过名」，
   * 因为两者的 name_changed_at 都有值（注册时就写入了 created_at）。
   */
  const cooldown: { inCooldown: boolean; daysRemaining: number; canChangeAt?: Date } =
    modeState === null
      ? legacyCooldown
      : modeState.cooldownDaysRemaining === null
        ? { inCooldown: false, daysRemaining: 0 }
        : {
            inCooldown: true,
            daysRemaining: modeState.cooldownDaysRemaining,
            canChangeAt: modeState.cooldownUntil
              ? new Date(modeState.cooldownUntil)
              : undefined,
          }

  const modeIsSingle = modeState?.mode === 'single'
  const showReservedSlots = modeIsSingle && reservedProfiles.length > 0
  const modeCooldownActive = (modeState?.cooldownDaysRemaining ?? 0) > 0

  // ---- 0003：用户名模式操作 ----

  /** 打开模式弹窗。切为单用户名时默认预选第一个 active 角色，避免必然的报错 */
  const openModeModal = (target: 'single' | 'multi') => {
    setPendingMode(target)
    setPendingKeepId(target === 'single' ? (activeProfiles[0]?.id ?? null) : null)
    setModeModalOpen(true)
  }

  const handleSaveMode = async () => {
    // 多选一时必须先定保留谁。后端会用 MODE_CHOICE_REQUIRED / VALIDATION_ERROR 拦，
    // 但让用户先看到提示比先吃一个报错好。
    if (pendingMode === 'single' && activeProfiles.length > 1 && !pendingKeepId) {
      message.warning(t('profile.modeChooseKeepRequired'))
      return
    }
    setSavingMode(true)
    try {
      const next = await accountSecurityService.saveProfileMode(
        pendingMode,
        pendingMode === 'single' ? pendingKeepId : null,
      )
      setModeState(next)
      await loadProfiles()
      // 决定/切换完成后，若首次选择还没落地则不会再弹
      setModeModalOpen(false)
      message.success(t('profile.modeSaved'))
    } catch (err: any) {
      message.error(err?.response?.data?.errorMessage || t('profile.modeSaveFailed'))
    } finally {
      setSavingMode(false)
    }
  }

  const handleActivateReserved = async (profileId: string) => {
    setActivatingId(profileId)
    try {
      const next = await accountSecurityService.activateReservedProfile(profileId)
      setModeState(next)
      await loadProfiles()
      message.success(t('profile.reservedActivated'))
    } catch (err: any) {
      // 冷却未满 / 角色已不是预留态，都靠后端的错误码文案说清楚（MODE_COOLDOWN 等）
      message.error(
        err?.response?.data?.errorMessage || t('profile.reservedActivateFailed'),
      )
    } finally {
      setActivatingId(null)
    }
  }

  // ---- 0003：邮箱安全操作 ----

  const handleSendBackupEmail = async () => {
    const email = backupInput.trim()
    if (!email || !email.includes('@')) {
      message.warning(t('profile.emailInvalid'))
      return
    }
    setSendingBackup(true)
    try {
      const res = await accountSecurityService.requestBackupEmail(email)
      if (res.alreadyVerified) {
        message.info(t('profile.backupAlreadyVerified'))
      } else if (res.sent) {
        message.success(t('profile.backupEmailSent', { email: res.pendingEmail }))
      } else {
        // 已有一枚待验证的备用邮箱时后端不重发，如实告知而不是假装成功
        message.warning(t('profile.backupEmailNotSent'))
      }
      setBackupModalOpen(false)
      setBackupInput('')
      await loadAccountSecurity()
    } catch (err: any) {
      message.error(
        err?.response?.data?.errorMessage || t('profile.backupEmailFailed'),
      )
    } finally {
      setSendingBackup(false)
    }
  }

  const handleRemoveBackup = async () => {
    try {
      await accountSecurityService.removeBackupEmail()
      message.success(t('profile.backupRemoved'))
      // 解除备用邮箱会连带取消「用备用邮箱授权」的进行中请求，必须重拉状态
      await loadAccountSecurity()
    } catch (err: any) {
      message.error(
        err?.response?.data?.errorMessage || t('profile.backupRemoveFailed'),
      )
    }
  }

  const openChangeEmailModal = (target: 'primary' | 'backup') => {
    setChangeTarget(target)
    setChangeInput('')
    setChangeSent(null)
    setChangeModalOpen(true)
  }

  const handleRequestChange = async () => {
    const email = changeInput.trim()
    if (!email || !email.includes('@')) {
      message.warning(t('profile.emailInvalid'))
      return
    }
    setRequestingChange(true)
    try {
      const res = await accountSecurityService.requestEmailChange(
        changeTarget,
        email,
      )
      setChangeSent(res)
      await loadAccountSecurity()
    } catch (err: any) {
      message.error(
        err?.response?.data?.errorMessage || t('profile.changeEmailFailed'),
      )
    } finally {
      setRequestingChange(false)
    }
  }

  /** 手动触发一次收敛检查（自动轮询之外的「我已点完两封」按钮） */
  const handleFinalizeChange = async () => {
    try {
      const res = await accountSecurityService.finalizeEmailChange()
      if (res.completed) {
        message.success(t('profile.changeEmailDone'))
        setChangeModalOpen(false)
        await loadProfiles()
      } else {
        message.info(t('profile.changeEmailWaiting'))
      }
      await loadAccountSecurity()
    } catch (err: any) {
      message.error(
        err?.response?.data?.errorMessage || t('profile.changeEmailFailed'),
      )
    }
  }

  const handleCancelChange = async () => {
    try {
      await accountSecurityService.cancelEmailChange()
      message.success(t('profile.changeCancelled'))
      setChangeSent(null)
      setChangeModalOpen(false)
      await loadAccountSecurity()
    } catch (err: any) {
      message.error(
        err?.response?.data?.errorMessage || t('profile.changeEmailFailed'),
      )
    }
  }

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
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
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

  // 发送密码重置邮件（已登录：后端按会话身份取邮箱，无需再填）
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
      setResetEmailSent(true)
    } catch (err: any) {
      message.error(err.message || t('profile.sendFailed'))
    } finally {
      setSendingResetEmail(false)
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
      const code = err.response?.data?.error
      // 0003：单用户名模式的改名冷却由后端以 403 NAME_COOLDOWN 拒绝；
      // 「启用预留角色」用的是同一个 30 天窗口，错误码是 MODE_COOLDOWN。
      // 旧代码判的是 429 + days_remaining，而 MSCTS 从不返回这两个东西 ——
      // 分支永远走不到，用户只能看到后端那句原始文案（能懂，但丢了剩余天数）。
      if (code === 'NAME_COOLDOWN' || code === 'MODE_COOLDOWN') {
        const days = modeState?.cooldownDaysRemaining
        message.error(
          days ? t('profile.nameChangeCooldown', { days }) : errMsg,
        )
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
            <Space direction="vertical" size={6} style={{ width: '100%' }}>
              {/* 主邮箱 */}
              <Space wrap>
                <Text>{emailStatus?.email || user.email}</Text>
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
                <Button size="small" onClick={() => openChangeEmailModal('primary')}>
                  {t('profile.changePrimaryEmail')}
                </Button>
              </Space>

              {/* 备用邮箱 */}
              {emailStatus?.backupEmail ? (
                <Space wrap>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {t('profile.backupEmail')}:
                  </Text>
                  <Text>{emailStatus.backupEmail}</Text>
                  {emailStatus.backupEmailVerified ? (
                    <Tag color="green">{t('profile.verified')}</Tag>
                  ) : (
                    <Tag color="orange">{t('profile.unverified')}</Tag>
                  )}
                  <Button size="small" onClick={() => openChangeEmailModal('backup')}>
                    {t('profile.changeBackupEmail')}
                  </Button>
                  <Popconfirm
                    title={t('profile.removeBackupConfirm')}
                    okText={t('common.confirm')}
                    cancelText={t('common.cancel')}
                    onConfirm={handleRemoveBackup}
                  >
                    <Button size="small" danger icon={<DeleteOutlined />}>
                      {t('profile.removeBackup')}
                    </Button>
                  </Popconfirm>
                </Space>
              ) : (
                <Button
                  size="small"
                  type="dashed"
                  icon={<PlusOutlined />}
                  onClick={() => {
                    setBackupInput('')
                    setBackupModalOpen(true)
                  }}
                >
                  {t('profile.addBackupEmail')}
                </Button>
              )}

              {emailStatus?.backupEmailRecommended && (
                <Text type="warning" style={{ fontSize: 12 }}>
                  {t('profile.backupRecommended')}
                </Text>
              )}

              {/*
                进行中的改邮箱请求。两枚链接可能分别在两台设备上被点开，
                本页靠轮询后端的收敛端点自动完成，用户也可以手动催一下。
              */}
              {emailStatus?.pendingChange && (
                <Alert
                  type="info"
                  showIcon
                  message={t('profile.pendingChange', { email: emailStatus.pendingChange.newEmail })}
                  description={
                    <div style={{ fontSize: 12, lineHeight: 1.9 }}>
                      <div>
                        {emailStatus.pendingChange.verifyConfirmed ? '✅' : '⬜'}{' '}
                        {t('profile.pendingVerifySide')}
                      </div>
                      <div>
                        {emailStatus.pendingChange.authorizeConfirmed ? '✅' : '⬜'}{' '}
                        {t('profile.pendingAuthorizeSide')}
                      </div>
                      <Text type="secondary">{t('profile.pendingAutoCheck')}</Text>
                    </div>
                  }
                  action={
                    <Space direction="vertical" size={4}>
                      <Button size="small" onClick={handleFinalizeChange}>
                        {t('profile.checkNow')}
                      </Button>
                      <Popconfirm
                        title={t('profile.cancelChangeConfirm')}
                        okText={t('common.confirm')}
                        cancelText={t('common.cancel')}
                        onConfirm={handleCancelChange}
                      >
                        <Button size="small" danger>
                          {t('common.cancel')}
                        </Button>
                      </Popconfirm>
                    </Space>
                  }
                />
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

      {/* 用户名模式卡片（0003） */}
      {modeState && (
        <div style={{
          background: 'var(--bg-card)',
          border: '1px solid var(--border-color)',
          borderRadius: 12,
          padding: 24,
          marginTop: 20,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, marginBottom: 12 }}>
            <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 8 }}>
              <UserSwitchOutlined />
              {t('profile.usernameMode')}
            </div>
            <Tag color={modeIsSingle ? 'blue' : 'purple'}>
              {modeIsSingle ? t('profile.modeSingle') : t('profile.modeMulti')}
            </Tag>
          </div>

          <Text type="secondary" style={{ fontSize: 13, display: 'block', marginBottom: 12, lineHeight: 1.8 }}>
            {modeIsSingle ? t('profile.modeSingleDesc') : t('profile.modeMultiDesc')}
          </Text>

          <Space size={16} wrap style={{ marginBottom: 12 }}>
            <Text style={{ fontSize: 13 }}>
              {t('profile.modeActiveCount', { count: modeState.activeCount, limit: modeState.activeLimit })}
            </Text>
            {reservedProfiles.length > 0 && (
              <Text style={{ fontSize: 13 }}>
                {t('profile.modeReservedCount', { count: reservedProfiles.length })}
              </Text>
            )}
          </Space>

          {modeCooldownActive && (
            <div style={{ marginBottom: 12 }}>
              <Tag color="orange" icon={<ClockCircleOutlined />}>
                {t('profile.modeCooldown', { days: modeState.cooldownDaysRemaining })}
              </Tag>
            </div>
          )}

          {/*
            预留口。只在「单用户名模式 + 确有预留角色」时渲染：
            从没开过多用户、或当前就是多用户模式的账号看不到这一块。
          */}
          {showReservedSlots && (
            <div style={{ marginBottom: 12 }}>
              <Text strong style={{ fontSize: 13, display: 'block', marginBottom: 4 }}>
                {t('profile.reservedSlots')}
              </Text>
              <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8, lineHeight: 1.7 }}>
                {t('profile.reservedHint')}
              </Text>
              <Space direction="vertical" style={{ width: '100%' }} size={8}>
                {reservedProfiles.map((p) => (
                  <div
                    key={p.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 12,
                      border: '1px solid var(--border-color)',
                      borderRadius: 8,
                      padding: '8px 12px',
                    }}
                  >
                    <Text code>{p.name}</Text>
                    <Button
                      size="small"
                      type="primary"
                      ghost
                      disabled={modeCooldownActive}
                      loading={activatingId === p.id}
                      onClick={() => handleActivateReserved(p.id)}
                    >
                      {t('profile.reservedUse')}
                    </Button>
                  </div>
                ))}
              </Space>
            </div>
          )}

          <Space wrap>
            {modeIsSingle ? (
              <Button onClick={() => openModeModal('multi')}>
                {t('profile.switchToMulti')}
              </Button>
            ) : (
              <Button onClick={() => openModeModal('single')}>
                {t('profile.switchToSingle')}
              </Button>
            )}
          </Space>
        </div>
      )}

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
                setResetEmailSent(false)
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

      {/* 找回密码弹窗（发链接流程，见 resetEmailSent 的注释） */}
      <Modal
        title={<span><KeyOutlined style={{ marginRight: 8 }} />{t('profile.retrievePassword')}</span>}
        open={forgotPwdModalOpen}
        onCancel={() => {
          setForgotPwdModalOpen(false)
          setResetEmailSent(false)
        }}
        footer={
          resetEmailSent
            ? [
                <Button
                  key="close"
                  type="primary"
                  onClick={() => {
                    setForgotPwdModalOpen(false)
                    setResetEmailSent(false)
                  }}
                >
                  {t('profile.gotIt')}
                </Button>,
              ]
            : [
                <Button
                  key="cancel"
                  onClick={() => {
                    setForgotPwdModalOpen(false)
                    setResetEmailSent(false)
                  }}
                >
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
              ]
        }
      >
        <div style={{ marginTop: 16 }}>
          {resetEmailSent ? (
            <>
              <Alert
                type="success"
                showIcon
                message={t('profile.resetLinkSentTitle')}
                description={t('profile.resetLinkSentDesc')}
                style={{ marginBottom: 12 }}
              />
              <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 0 }}>
                {t('profile.resetLinkValidity')}
              </p>
            </>
          ) : (
            <>
              <p style={{ color: 'var(--text-secondary)', marginBottom: 12 }}>
                {t('profile.weWillSendResetEmail')}<Text strong>{user.email}</Text>{t('profile.sendResetEmailMessage')}
              </p>
              <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 0 }}>
                {t('profile.resetLinkHint')}
              </p>
            </>
          )}
        </div>
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

      {/*
        用户名模式弹窗。同时承载两件事：
        - 存量多角色账号的「首次选择」（modeState.decisionRequired）
        - 后续的模式切换
        对用户而言都是「保存我的选择」，前端不需要区分 —— 由服务端决定走哪条路。
      */}
      <Modal
        title={
          <span>
            <UserSwitchOutlined style={{ marginRight: 8 }} />
            {modeState?.decisionRequired
              ? t('profile.modeFirstChoice')
              : t('profile.modeSwitchTitle')}
          </span>
        }
        open={modeModalOpen}
        onCancel={() => setModeModalOpen(false)}
        confirmLoading={savingMode}
        onOk={handleSaveMode}
        okText={t('common.save')}
        cancelText={t('common.cancel')}
        width={520}
      >
        {modeState?.decisionRequired && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 16 }}
            message={t('profile.modeFirstChoiceHint')}
          />
        )}

        <Radio.Group
          value={pendingMode}
          onChange={(e) => {
            const next = e.target.value as 'single' | 'multi'
            setPendingMode(next)
            if (next === 'single') {
              setPendingKeepId(activeProfiles[0]?.id ?? null)
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

        {/* 切为单用户名且当前有多个可用角色时，必须指定保留哪一个 */}
        {pendingMode === 'single' && activeProfiles.length > 1 && (
          <div style={{ marginTop: 20 }}>
            <Text strong style={{ fontSize: 13, display: 'block', marginBottom: 8 }}>
              {t('profile.modeKeepWhich')}
            </Text>
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8, lineHeight: 1.7 }}>
              {t('profile.modeKeepHint', { count: activeProfiles.length - 1 })}
            </Text>
            <Radio.Group
              value={pendingKeepId}
              onChange={(e) => setPendingKeepId(e.target.value as string)}
              style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
            >
              {activeProfiles.map((p) => (
                <Radio key={p.id} value={p.id}>
                  <Text code>{p.name}</Text>
                </Radio>
              ))}
            </Radio.Group>
          </div>
        )}
      </Modal>

      {/* 添加备用邮箱 */}
      <Modal
        title={
          <span>
            <PlusOutlined style={{ marginRight: 8 }} />
            {t('profile.addBackupEmail')}
          </span>
        }
        open={backupModalOpen}
        onCancel={() => setBackupModalOpen(false)}
        confirmLoading={sendingBackup}
        onOk={handleSendBackupEmail}
        okText={t('profile.sendVerifyMail')}
        cancelText={t('common.cancel')}
        width={480}
      >
        <Text type="secondary" style={{ fontSize: 13, display: 'block', marginBottom: 16, lineHeight: 1.8 }}>
          {t('profile.backupEmailExplain')}
        </Text>
        <Input
          value={backupInput}
          onChange={(e) => setBackupInput(e.target.value)}
          placeholder={t('profile.backupEmailPlaceholder')}
          onPressEnter={handleSendBackupEmail}
        />
      </Modal>

      {/* 更改邮箱（主邮箱 / 备用邮箱共用一个向导） */}
      <Modal
        title={
          <span>
            <MailOutlined style={{ marginRight: 8 }} />
            {changeTarget === 'primary'
              ? t('profile.changePrimaryEmail')
              : t('profile.changeBackupEmail')}
          </span>
        }
        open={changeModalOpen}
        onCancel={() => setChangeModalOpen(false)}
        footer={
          changeSent || emailStatus?.pendingChange
            ? [
                <Button key="close" onClick={() => setChangeModalOpen(false)}>
                  {t('common.close')}
                </Button>,
              ]
            : [
                <Button
                  key="cancel"
                  onClick={() => setChangeModalOpen(false)}
                  disabled={requestingChange}
                >
                  {t('common.cancel')}
                </Button>,
                <Button
                  key="ok"
                  type="primary"
                  loading={requestingChange}
                  onClick={handleRequestChange}
                >
                  {t('profile.sendChangeMail')}
                </Button>,
              ]
        }
        width={520}
      >
        {/* 第一步：填新地址 */}
        {!changeSent && !emailStatus?.pendingChange && (
          <>
            <Text type="secondary" style={{ fontSize: 13, display: 'block', marginBottom: 16, lineHeight: 1.8 }}>
              {changeTarget === 'primary'
                ? t('profile.changePrimaryExplain')
                : t('profile.changeBackupExplain')}
            </Text>
            <Input
              value={changeInput}
              onChange={(e) => setChangeInput(e.target.value)}
              placeholder={t('profile.newEmailPlaceholder')}
              onPressEnter={handleRequestChange}
            />
          </>
        )}

        {/* 第二步：去两封信里点链接 */}
        {(changeSent || emailStatus?.pendingChange) && (
          <>
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 16 }}
              message={t('profile.changeMailSent', {
                email: changeSent?.newEmail || emailStatus?.pendingChange?.newEmail || '',
              })}
              description={
                <div style={{ fontSize: 12, lineHeight: 1.9 }}>
                  <div>
                    {t('profile.changeMailVerifyTo', {
                      email: changeSent?.newEmail || emailStatus?.pendingChange?.newEmail || '',
                    })}
                  </div>
                  <div>
                    {t('profile.changeMailAuthorizeTo', {
                      email:
                        changeSent?.authorizeEmail ||
                        (emailStatus?.pendingChange?.authorizeVia === 'backup'
                          ? (emailStatus.backupEmail ?? '')
                          : (emailStatus?.email ?? '')),
                    })}
                  </div>
                  {changeSent?.fallbackToSelf && (
                    <Text type="warning">{t('profile.changeFallbackToSelf')}</Text>
                  )}
                </div>
              }
            />

            {/* 两侧各自的确认进度 —— 两枚都齐了变更才生效 */}
            <Space direction="vertical" size={6} style={{ width: '100%', marginBottom: 12 }}>
              <Text style={{ fontSize: 13 }}>
                {emailStatus?.pendingChange?.verifyConfirmed ? '✅' : '⬜'}{' '}
                {t('profile.pendingVerifySide')}
              </Text>
              <Text style={{ fontSize: 13 }}>
                {emailStatus?.pendingChange?.authorizeConfirmed ? '✅' : '⬜'}{' '}
                {t('profile.pendingAuthorizeSide')}
              </Text>
            </Space>

            <Space wrap>
              <Button type="primary" onClick={handleFinalizeChange}>
                {t('profile.checkNow')}
              </Button>
              <Popconfirm
                title={t('profile.cancelChangeConfirm')}
                okText={t('common.confirm')}
                cancelText={t('common.cancel')}
                onConfirm={handleCancelChange}
              >
                <Button danger>{t('profile.cancelChange')}</Button>
              </Popconfirm>
            </Space>
          </>
        )}
      </Modal>
    </div>
  )
}
