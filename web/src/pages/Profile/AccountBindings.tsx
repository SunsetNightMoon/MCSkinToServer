import { compatFetch as fetch } from '../../utils/apiCompat'
import { useCallback, useEffect, useState } from 'react'
import { Alert, Button, Popconfirm, Select, Space, Spin, Typography, message } from 'antd'
import { LinkOutlined, ReloadOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '../../store/authStore'

/**
 * 账号设置区的「通用绑定页」（P6 第三批）。
 *
 * 定位：框架提供页面与路由，**内容全部来自插件** —— 这里渲染的每一个字，
 * 除框架自己的文案（走多语言）外，都是插件的 manifest/处理器原样回传的
 * （插件作者的措辞框架不翻译，与插件管理面板「作者文字原样透传」同一口径）。
 *
 * 目录来自 /api/bindings：只有「已启用且登记了 ctx.binding()」的插件才会出现。
 * 目录为空就整块隐藏 —— 没装绑定插件的站点不应该看到一个空设置区。
 */

interface BindingCatalogEntry {
  pluginId: string
  name: string
  description?: string
  subject: 'account' | 'profile'
  revocable: boolean
}

interface BindingField {
  label: string
  value: string
}

interface BindingRow {
  id: string
  fields: BindingField[]
  boundAt?: string
}

interface ProfileInfo {
  id: string
  name: string
  status?: 'active' | 'reserved'
}

async function readError(res: Response): Promise<string> {
  const body = await res.json().catch(() => null)
  const msg = (body as { message?: string } | null)?.message
  return msg ?? `HTTP ${res.status}`
}

function formatRemain(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`
}

export function AccountBindings({ profiles }: { profiles: ProfileInfo[] }) {
  const { t } = useTranslation()
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)
  const [catalog, setCatalog] = useState<BindingCatalogEntry[] | null>(null)

  useEffect(() => {
    if (!isAuthenticated) {
      setCatalog([])
      return
    }
    let dead = false
    fetch('/api/bindings')
      .then(async (res) =>
        res.ok ? (((await res.json()) as { bindings?: BindingCatalogEntry[] }).bindings ?? []) : [],
      )
      .catch(() => [])
      .then((list) => {
        if (!dead) setCatalog(list)
      })
    return () => {
      dead = true
    }
  }, [isAuthenticated])

  if (!catalog || catalog.length === 0) return null

  return (
    <div
      style={{
        background: 'var(--bg-card)',
        border: '1px solid var(--border-color)',
        borderRadius: 12,
        padding: 24,
        marginTop: 20,
      }}
    >
      <div
        style={{
          fontSize: 16,
          fontWeight: 600,
          color: 'var(--text-primary)',
          marginBottom: 4,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <LinkOutlined />
        {t('bindings.title')}
      </div>
      <Typography.Paragraph type="secondary" style={{ fontSize: 13, marginBottom: 16 }}>
        {t('bindings.subtitle')}
      </Typography.Paragraph>
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        {catalog.map((entry) => (
          <BindingCard key={entry.pluginId} entry={entry} profiles={profiles} />
        ))}
      </Space>
    </div>
  )
}

function BindingCard({ entry, profiles }: { entry: BindingCatalogEntry; profiles: ProfileInfo[] }) {
  const { t } = useTranslation()
  const activeProfiles = profiles.filter((p) => (p.status ?? 'active') === 'active')
  const [profileId, setProfileId] = useState<string>(activeProfiles[0]?.id ?? '')
  const [rows, setRows] = useState<BindingRow[] | null>(null)
  const [instructions, setInstructions] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [issued, setIssued] = useState<{ code: string; expiresAt: string } | null>(null)
  const [nowTick, setNowTick] = useState(() => Date.now())

  // 角色被删/换页后 profileId 可能失效：回到第一个可用角色，而不是抱着旧 id 发请求
  useEffect(() => {
    if (entry.subject !== 'profile') return
    if (!activeProfiles.some((p) => p.id === profileId)) {
      setProfileId(activeProfiles[0]?.id ?? '')
    }
  }, [entry.subject, profileId, activeProfiles])

  const load = useCallback(async () => {
    if (entry.subject === 'profile' && !profileId) {
      setRows([])
      return
    }
    setBusy(true)
    try {
      const qs = entry.subject === 'profile' ? `?profileId=${encodeURIComponent(profileId)}` : ''
      const res = await fetch(`/api/plugins/${entry.pluginId}/binding${qs}`)
      if (!res.ok) throw new Error(await readError(res))
      const body = (await res.json()) as { bindings?: BindingRow[]; instructions?: string }
      setRows(body.bindings ?? [])
      setInstructions(body.instructions ?? null)
      setError(null)
    } catch (err) {
      setRows([])
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [entry.pluginId, entry.subject, profileId])

  useEffect(() => {
    void load()
  }, [load])

  // 倒计时每秒一拍；归零自己收场，不留一个永远 0:00 的码在页面上
  useEffect(() => {
    if (!issued) return
    const timer = setInterval(() => setNowTick(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [issued])
  const remainMs = issued ? Math.max(0, Date.parse(issued.expiresAt) - nowTick) : 0
  useEffect(() => {
    if (issued && remainMs === 0) setIssued(null)
  }, [issued, remainMs])

  const issue = async () => {
    setBusy(true)
    try {
      const res = await fetch(`/api/plugins/${entry.pluginId}/binding/issue`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(entry.subject === 'profile' ? { profileId } : {}),
      })
      if (!res.ok) throw new Error(await readError(res))
      const body = (await res.json()) as { code: string; expiresAt: string }
      setNowTick(Date.now())
      setIssued(body)
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const revoke = async (bindingId: string) => {
    setBusy(true)
    try {
      const res = await fetch(`/api/plugins/${entry.pluginId}/binding/revoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          entry.subject === 'profile' ? { profileId, bindingId } : { bindingId },
        ),
      })
      if (!res.ok) throw new Error(await readError(res))
      await load()
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const showInstructions = instructions ?? null

  return (
    <div
      style={{
        border: '1px solid var(--border-color)',
        borderRadius: 8,
        padding: 16,
      }}
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Space align="start" style={{ width: '100%', justifyContent: 'space-between' }} wrap>
          <div>
            <Typography.Text strong style={{ color: 'var(--text-primary)' }}>
              {entry.name}
            </Typography.Text>
            {entry.description && (
              <div style={{ fontSize: 12, color: 'var(--text-subtle, var(--text-muted))' }}>
                {entry.description}
              </div>
            )}
          </div>
          <Space>
            {entry.subject === 'profile' && activeProfiles.length > 0 && (
              <Select
                size="small"
                style={{ minWidth: 140 }}
                value={profileId || undefined}
                placeholder={t('bindings.pickProfile')}
                onChange={(value: string) => setProfileId(value)}
                options={activeProfiles.map((p) => ({ value: p.id, label: p.name }))}
              />
            )}
            <Button
              size="small"
              icon={<ReloadOutlined />}
              loading={busy && rows === null}
              onClick={() => void load()}
            >
              {t('bindings.refresh')}
            </Button>
          </Space>
        </Space>

        {entry.subject === 'profile' && activeProfiles.length === 0 && (
          <Alert type="warning" showIcon message={t('bindings.noProfile')} />
        )}

        {error && <Alert type="error" showIcon message={`${t('bindings.loadFailed')}: ${error}`} />}

        {issued && (
          <Alert
            type="info"
            showIcon
            message={
              <Space direction="vertical" size={6} style={{ width: '100%' }}>
                <div style={{ fontSize: 13 }}>{t('bindings.codeHint')}</div>
                <div
                  style={{
                    fontFamily: 'monospace',
                    fontSize: 28,
                    letterSpacing: 6,
                    fontWeight: 700,
                    userSelect: 'all',
                    color: 'var(--text-primary)',
                  }}
                >
                  {issued.code}
                </div>
                <div style={{ fontSize: 12, opacity: 0.75 }}>
                  {t('bindings.remain', { time: formatRemain(remainMs) })}
                </div>
                {showInstructions && (
                  <div style={{ fontSize: 13 }}>
                    {showInstructions.replaceAll('{{code}}', issued.code)}
                  </div>
                )}
              </Space>
            }
          />
        )}

        {!issued && showInstructions && (
          <Typography.Paragraph
            type="secondary"
            style={{ fontSize: 13, marginBottom: 0 }}
          >
            {showInstructions.replaceAll('{{code}}', t('bindings.codePlaceholder'))}
          </Typography.Paragraph>
        )}

        <Space wrap>
          <Button
            type="primary"
            icon={<LinkOutlined />}
            loading={busy}
            disabled={entry.subject === 'profile' && !profileId}
            onClick={() => void issue()}
          >
            {t('bindings.generate')}
          </Button>
          {rows !== null && rows.length === 0 && !busy && (
            <Typography.Text type="secondary">{t('bindings.empty')}</Typography.Text>
          )}
        </Space>

        {(rows ?? []).map((row) => (
          <div
            key={row.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
              padding: '8px 12px',
              border: '1px solid var(--border-color)',
              borderRadius: 8,
              flexWrap: 'wrap',
            }}
          >
            <Space direction="vertical" size={2}>
              <Space wrap size={16}>
                {row.fields.map((field, i) => (
                  <span key={i} style={{ fontSize: 13 }}>
                    <Typography.Text type="secondary">{field.label}：</Typography.Text>
                    <Typography.Text strong copyable={{ text: field.value }}>
                      {field.value}
                    </Typography.Text>
                  </span>
                ))}
              </Space>
              {row.boundAt && (
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  {t('bindings.boundAt', {
                    time: new Date(row.boundAt).toLocaleString(),
                  })}
                </span>
              )}
            </Space>
            {entry.revocable && (
              <Popconfirm
                title={t('bindings.revokeConfirm')}
                okText={t('bindings.revoke')}
                onConfirm={() => void revoke(row.id)}
              >
                <Button size="small" danger loading={busy}>
                  {t('bindings.revoke')}
                </Button>
              </Popconfirm>
            )}
          </div>
        ))}
        {rows === null && !error && (
          <div style={{ textAlign: 'center', padding: 8 }}>
            <Spin size="small" />
          </div>
        )}
      </Space>
    </div>
  )
}
