import { compatFetch as fetch } from '../../utils/apiCompat'
import { useCallback, useEffect, useState } from 'react'
import {
  Alert,
  App,
  Badge,
  Button,
  Card,
  Col,
  Divider,
  Input,
  InputNumber,
  Popconfirm,
  Row,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd'
import { useTranslation } from 'react-i18next'

/**
 * 插件管理面板（仅超级管理员）。
 *
 * 定位很明确：**这里是「装了什么、它声称要什么」的台账，不是安全审计工具。**
 * 本站只提供接口，把某个插件装进站点是超管的决定；因此面板的职责是把该看清楚的东西
 * 摊开 —— manifest 声明的 HTTP 入口、外部依赖、设置项、加载状态与错误、启停记录 ——
 * 而不是假装能关住一个跑在本进程里的插件。
 *
 * UI 刻意做成「manifest 驱动 + 通用表单」：插件作者不需要写任何前端代码，
 * 也就不引入 React/AntD 版本耦合。真有复杂交互的需求要另开口子，那是以后的决定。
 */

interface EndpointSpec {
  kind: 'router' | 'hooks'
  method: string
  path: string
  auth: string
  note?: string
  rateLimit?: { max: number; windowMs: number }
}

interface SettingSpec {
  key: string
  label: string
  hint?: string
  type: string
  value?: string | number | boolean | null
  set?: boolean
  default?: string | number | boolean
}

interface PluginStatus {
  id: string
  name: string
  version: string
  apiVersion: number
  enabled: boolean
  state: 'ready' | 'disabled' | 'error' | 'invalid'
  error?: string
  manifest?: {
    description?: string
    author?: string
    mcsts?: string
    requires?: { id: string; label: string; note?: string }[]
    settings?: SettingSpec[]
    endpoints?: EndpointSpec[]
  }
}

interface LogEntry {
  at: string
  actor: string
  action: string
  pluginId: string
  detail?: string
}

const STATE_BADGE: Record<PluginStatus['state'], 'success' | 'default' | 'error' | 'warning'> = {
  ready: 'success',
  disabled: 'default',
  error: 'error',
  invalid: 'warning',
}

export function PluginManagement() {
  const { t } = useTranslation()
  const { message, modal } = App.useApp()
  const [statuses, setStatuses] = useState<PluginStatus[]>([])
  const [log, setLog] = useState<LogEntry[]>([])
  const [hookSecretSet, setHookSecretSet] = useState<Record<string, boolean>>({})
  const [loading, setLoading] = useState(false)
  const [drafts, setDrafts] = useState<Record<string, Record<string, string | number | boolean>>>({})

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/admin/plugins')
      if (!res.ok) throw new Error(await res.text())
      const body = await res.json()
      setStatuses(body.statuses ?? [])
      setLog(body.log ?? [])
      setHookSecretSet(body.hookSecretSet ?? {})
    } catch (err) {
      message.error(`${t('plugins.loadFailed')}: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setLoading(false)
    }
  }, [message, t])

  useEffect(() => {
    void load()
  }, [load])

  const act = async (path: string, body?: unknown): Promise<boolean> => {
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      if (!res.ok) {
        const text = await res.text()
        let hint = text
        try {
          hint = (JSON.parse(text) as { message?: string }).message ?? text
        } catch {
          /* 非 JSON 的错体就直接给原文 */
        }
        message.error(hint)
        return false
      }
      return true
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err))
      return false
    }
  }

  const saveSettings = async (id: string) => {
    const draft = drafts[id] ?? {}
    if (Object.keys(draft).length === 0) return
    const res = await fetch(`/api/admin/plugins/${id}/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(draft),
    })
    if (!res.ok) {
      message.error(await res.text())
      return
    }
    message.success(t('plugins.settingsSaved'))
    setDrafts((prev) => ({ ...prev, [id]: {} }))
    await load()
  }

  const showSecret = (secret: string) => {
    modal.info({
      title: t('plugins.secretShownTitle'),
      content: (
        <div>
          <Typography.Paragraph copyable style={{ wordBreak: 'break-all' }}>
            {secret}
          </Typography.Paragraph>
          <Alert type="warning" showIcon message={t('plugins.secretOnceHint')} />
        </div>
      ),
    })
  }

  return (
    <div style={{ padding: 16 }}>
      <Space style={{ marginBottom: 16 }}>
        <Button onClick={() => void load()} loading={loading}>
          {t('plugins.reload')}
        </Button>
        <Popconfirm title={t('plugins.scanConfirm')} onConfirm={async () => { await act('/api/admin/plugins/scan'); await load() }}>
          <Button>{t('plugins.scan')}</Button>
        </Popconfirm>
      </Space>

      <Alert type="info" showIcon style={{ marginBottom: 16 }} message={t('plugins.responsibilityNotice')} />

      <Row gutter={[16, 16]}>
        {statuses.map((plugin) => (
          <Col key={plugin.id} xs={24} xl={12}>
            <Card
              title={
                <Space>
                  <Badge status={STATE_BADGE[plugin.state]} />
                  <span>{plugin.name}</span>
                  <Tag>{plugin.version}</Tag>
                  {plugin.enabled && <Tag color="green">{t('plugins.enabled')}</Tag>}
                </Space>
              }
              extra={
                <Space>
                  {plugin.state === 'ready' || plugin.enabled ? (
                    <Button danger size="small" onClick={async () => { await act(`/api/admin/plugins/${plugin.id}/disable`); await load() }}>
                      {t('plugins.disable')}
                    </Button>
                  ) : (
                    <Button type="primary" size="small" onClick={async () => { await act(`/api/admin/plugins/${plugin.id}/enable`); await load() }}>
                      {t('plugins.enable')}
                    </Button>
                  )}
                </Space>
              }
            >
              <Typography.Text type="secondary" copyable={{ text: plugin.id }}>
                {plugin.id}
              </Typography.Text>
              {plugin.manifest?.description && <p style={{ marginTop: 8 }}>{plugin.manifest.description}</p>}
              {plugin.error && <Alert type="error" showIcon message={plugin.error} style={{ marginTop: 8 }} />}
              {plugin.manifest?.mcsts && (
                <p style={{ marginTop: 8 }}>
                  <Typography.Text type="secondary">
                    {t('plugins.requiresSite')}: {plugin.manifest.mcsts} · API v{plugin.apiVersion}
                  </Typography.Text>
                </p>
              )}

              {(plugin.manifest?.requires ?? []).length > 0 && (
                <>
                  <Divider orientation="left" plain>
                    {t('plugins.externalRequires')}
                  </Divider>
                  {plugin.manifest?.requires?.map((req) => (
                    <Alert key={req.id} type="warning" showIcon message={req.label} description={req.note} style={{ marginBottom: 8 }} />
                  ))}
                </>
              )}

              {(plugin.manifest?.endpoints ?? []).length > 0 && (
                <>
                  <Divider orientation="left" plain>
                    {t('plugins.endpoints')}
                  </Divider>
                  <Table<EndpointSpec>
                    size="small"
                    pagination={false}
                    rowKey={(row) => `${row.kind}-${row.method}-${row.path}`}
                    dataSource={plugin.manifest?.endpoints ?? []}
                    columns={[
                      { title: t('plugins.endpointKind'), dataIndex: 'kind', width: 88 },
                      { title: t('plugins.endpointMethod'), dataIndex: 'method', width: 80 },
                      {
                        title: t('plugins.endpointPath'),
                        dataIndex: 'path',
                        render: (value: string, row) => (row.kind === 'hooks' ? `/api/plugins/${plugin.id}/hooks${value}` : `/api/plugins/${plugin.id}${value}`),
                      },
                      { title: t('plugins.endpointAuth'), dataIndex: 'auth', width: 88 },
                      { title: t('plugins.endpointNote'), dataIndex: 'note' },
                    ]}
                  />
                </>
              )}

              {(plugin.manifest?.settings ?? []).length > 0 && (
                <>
                  <Divider orientation="left" plain>
                    {t('plugins.settings')}
                  </Divider>
                  <Space direction="vertical" style={{ width: '100%' }}>
                    {plugin.manifest?.settings?.map((spec) => (
                      <div key={spec.key}>
                        <Typography.Text strong>{spec.label}</Typography.Text>
                        <Typography.Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>
                          {spec.key}
                        </Typography.Text>
                        {spec.type === 'int' ? (
                          <InputNumber
                            style={{ width: '100%', marginTop: 4 }}
                            placeholder={String(spec.value ?? spec.default ?? '')}
                            value={drafts[plugin.id]?.[spec.key] as number | undefined}
                            onChange={(value) => setDrafts((prev) => ({ ...prev, [plugin.id]: { ...(prev[plugin.id] ?? {}), [spec.key]: value ?? 0 } }))}
                          />
                        ) : spec.type === 'bool' ? (
                          <Switch
                            style={{ marginTop: 4 }}
                            checked={Boolean(drafts[plugin.id]?.[spec.key] ?? spec.value ?? false)}
                            onChange={(checked) => setDrafts((prev) => ({ ...prev, [plugin.id]: { ...(prev[plugin.id] ?? {}), [spec.key]: checked } }))}
                          />
                        ) : (
                          <Input
                            type={spec.type === 'secret' ? 'password' : 'text'}
                            style={{ marginTop: 4 }}
                            placeholder={spec.type === 'secret'
                              ? hookSecretSet[plugin.id] || spec.set
                                ? t('plugins.secretSetPlaceholder')
                                : t('plugins.secretUnsetPlaceholder')
                              : String(spec.value ?? spec.default ?? '')}
                            value={String(drafts[plugin.id]?.[spec.key] ?? '')}
                            onChange={(e) => setDrafts((prev) => ({ ...prev, [plugin.id]: { ...(prev[plugin.id] ?? {}), [spec.key]: e.target.value } }))}
                          />
                        )}
                        {spec.hint && (
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                            {spec.hint}
                          </Typography.Text>
                        )}
                      </div>
                    ))}
                    <Button size="small" onClick={() => void saveSettings(plugin.id)}>
                      {t('plugins.saveSettings')}
                    </Button>
                  </Space>
                </>
              )}

              {plugin.manifest?.endpoints?.some((e) => e.auth === 'hmac') && (
                <>
                  <Divider orientation="left" plain>
                    {t('plugins.serverSecret')}
                  </Divider>
                  <Space>
                    <Button
                      size="small"
                      onClick={async () => {
                        const res = await fetch(`/api/admin/plugins/${plugin.id}/hook-secret`, {
                          method: 'POST',
                          headers: { 'content-type': 'application/json' },
                          body: JSON.stringify({ action: 'generate' }),
                        })
                        if (!res.ok) {
                          message.error(await res.text())
                          return
                        }
                        const body = (await res.json()) as { secret?: string }
                        if (body.secret) showSecret(body.secret)
                        await load()
                      }}
                    >
                      {hookSecretSet[plugin.id] ? t('plugins.rotateSecret') : t('plugins.generateSecret')}
                    </Button>
                    {hookSecretSet[plugin.id] && (
                      <Popconfirm
                        title={t('plugins.clearSecretConfirm')}
                        onConfirm={async () => {
                          await act(`/api/admin/plugins/${plugin.id}/hook-secret`, { action: 'clear' })
                          await load()
                        }}
                      >
                        <Button size="small" danger>
                          {t('plugins.clearSecret')}
                        </Button>
                      </Popconfirm>
                    )}
                  </Space>
                  <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8 }}>
                    {t('plugins.serverSecretHint')}
                  </Typography.Paragraph>
                </>
              )}
            </Card>
          </Col>
        ))}
        {statuses.length === 0 && !loading && (
          <Col span={24}>
            <Alert type="info" showIcon message={t('plugins.noneFound')} description={t('plugins.noneFoundDesc')} />
          </Col>
        )}
      </Row>

      {log.length > 0 && (
        <>
          <Divider orientation="left">{t('plugins.auditLog')}</Divider>
          <Table<LogEntry>
            size="small"
            rowKey={(row) => `${row.at}-${row.pluginId}-${row.action}`}
            dataSource={log}
            pagination={{ pageSize: 10 }}
            columns={[
              { title: t('plugins.logAt'), dataIndex: 'at', width: 190 },
              { title: t('plugins.logPlugin'), dataIndex: 'pluginId', width: 140 },
              { title: t('plugins.logAction'), dataIndex: 'action', width: 120 },
              { title: t('plugins.logDetail'), dataIndex: 'detail' },
            ]}
          />
        </>
      )}
    </div>
  )
}
