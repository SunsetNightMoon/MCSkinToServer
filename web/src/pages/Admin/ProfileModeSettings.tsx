import { useEffect, useState } from 'react'
import { Alert, Button, Card, Modal, Radio, Spin, Statistic, Tag, Typography, message } from 'antd'
import { UserSwitchOutlined } from '@ant-design/icons'
import { fetchWithAuth } from '../../utils/api'
import { useTranslation } from 'react-i18next'

const { Text } = Typography

interface ProfileModeStats {
  totalUsers: number
  multiActiveUsers: number
  undecidedUsers: number
}

interface ProfileModePayload {
  mode: 'single' | 'multi'
  stats: ProfileModeStats
}

/**
 * 管理面板「用户名模式」页（P5 第十一批，仅超管）。
 *
 * 模式是**全站统一**的站点级设置：single = 每账号一个使用中 ID（换 ID/改名共用
 * 30 天窗口）；multi = 每账号最多 10 个 ID、无冷却。切换影响全部账号 ——
 * 切到 single 时名下有多个使用中 ID 的账号会进入「待选择」态，下次进个人中心
 * 强制弹窗选保留 ID。个人中心不再提供任何切换入口。
 */
export default function ProfileModeSettings() {
  const { t } = useTranslation()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [current, setCurrent] = useState<ProfileModePayload | null>(null)
  const [pendingMode, setPendingMode] = useState<'single' | 'multi'>('single')

  const load = async () => {
    setLoading(true)
    try {
      const res = await fetchWithAuth('/api/admin/profile-mode')
      if (!res.ok) throw new Error(t('admin.loadFailed'))
      const data: ProfileModePayload = await res.json()
      setCurrent(data)
      setPendingMode(data.mode)
    } catch (err: any) {
      message.error(err.message || t('admin.loadFailed'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const dirty = current !== null && pendingMode !== current.mode

  const handleSave = () => {
    if (!current || !dirty) return
    const switchingToSingle = pendingMode === 'single'
    Modal.confirm({
      title: t('admin.profileModeConfirmTitle', {
        mode: switchingToSingle ? t('profile.modeSingle') : t('profile.modeMulti'),
      }),
      content: switchingToSingle
        ? t('admin.profileModeConfirmToSingle', { count: current.stats.multiActiveUsers })
        : t('admin.profileModeConfirmToMulti'),
      okText: t('common.confirm'),
      cancelText: t('common.cancel'),
      onOk: async () => {
        setSaving(true)
        try {
          const res = await fetchWithAuth('/api/admin/profile-mode', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode: pendingMode }),
          })
          const data = await res.json()
          if (!res.ok) throw new Error(data.errorMessage || t('common.operationFailed'))
          message.success(t('admin.profileModeUpdated'))
          await load()
        } catch (err: any) {
          message.error(err.message || t('common.operationFailed'))
        } finally {
          setSaving(false)
        }
      },
    })
  }

  if (loading) {
    return (
      <Card>
        <div style={{ padding: '48px 0', textAlign: 'center' }}>
          <Spin />
        </div>
      </Card>
    )
  }

  const stats = current?.stats

  return (
    <div>
      <Card title={<span><UserSwitchOutlined style={{ marginRight: 8 }} />{t('admin.profileModePageTitle')}</span>}>
        <div style={{ marginBottom: 24, display: 'flex', alignItems: 'center', gap: 12 }}>
          <Text type="secondary">{t('admin.profileModeCurrent')}：</Text>
          <Tag color={current?.mode === 'multi' ? 'purple' : 'blue'} style={{ fontSize: 13 }}>
            {current?.mode === 'multi' ? t('profile.modeMulti') : t('profile.modeSingle')}
          </Tag>
        </div>

        <Radio.Group
          value={pendingMode}
          onChange={(e) => setPendingMode(e.target.value as 'single' | 'multi')}
          style={{ display: 'flex', flexDirection: 'column', gap: 16, marginBottom: 24 }}
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

        <Button
          type="primary"
          disabled={!dirty}
          loading={saving}
          onClick={handleSave}
        >
          {t('admin.profileModeApply')}
        </Button>
        {current && !dirty && (
          <Text type="secondary" style={{ marginLeft: 12, fontSize: 12 }}>
            {t('admin.profileModeNoChange')}
          </Text>
        )}
      </Card>

      {stats && (
        <Card title={t('admin.profileModeStatsTitle')} style={{ marginTop: 16 }}>
          <div style={{ display: 'flex', gap: 48, flexWrap: 'wrap' }}>
            <Statistic title={t('admin.profileModeStatTotal')} value={stats.totalUsers} />
            <Statistic title={t('admin.profileModeStatMultiActive')} value={stats.multiActiveUsers} />
            <Statistic title={t('admin.profileModeStatUndecided')} value={stats.undecidedUsers} />
          </div>
          {stats.undecidedUsers > 0 && (
            <Alert
              type="warning"
              showIcon
              style={{ marginTop: 20 }}
              message={t('admin.profileModeUndecidedHint', { count: stats.undecidedUsers })}
            />
          )}
        </Card>
      )}
    </div>
  )
}
