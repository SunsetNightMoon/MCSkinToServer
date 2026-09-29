import { compatFetch as fetch } from '../../utils/apiCompat'
import { useCallback, useEffect, useState } from 'react'
import {
  Alert,
  Badge,
  Button,
  Card,
  Col,
  Divider,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Row,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Typography,
  message,
} from 'antd'
import { useTranslation } from 'react-i18next'
import { ExclamationCircleOutlined } from '@ant-design/icons'
import { PluginImportModal } from './PluginImportModal'

/**
 * 插件管理面板（仅超级管理员）。
 *
 * 定位很明确：**这里是「装了什么、它声称要什么」的台账，不是安全审计工具。**
 * 本站只提供接口，把某个插件装进站点是超管的决定；因此面板的职责是把该看清楚的东西
 * 摊开 —— manifest 声明的 HTTP 入口、外部依赖、设置项、加载状态与错误、启停记录 ——
 * 而不是假装能关住一个跑在本进程里的插件。
 *
 * 版式：**列表只放判断需要的东西**（名字、状态、描述、版本要求），
 * 明细（入口表 / 依赖 / 设置 / 密钥）收进「设置」弹窗。
 * 一屏堆十行表格的卡片会让人只想关掉页面，而台账要的是能扫一眼就管得住。
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
  /** 磁盘上的入口比内存里的模块新：重载换不掉代码，只有重启站点才行 */
  staleCode?: boolean
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

/** 卡片只到「能判断要不要点开」为止；依赖与入口的明细都在设置弹窗里 */
function hasRequires(plugin: PluginStatus) {
  return (plugin.manifest?.requires ?? []).length > 0
}

export function PluginManagement() {
  const { t } = useTranslation()
  const [statuses, setStatuses] = useState<PluginStatus[]>([])
  const [log, setLog] = useState<LogEntry[]>([])
  const [hookSecretSet, setHookSecretSet] = useState<Record<string, boolean>>({})
  const [loading, setLoading] = useState(false)
  const [drafts, setDrafts] = useState<Record<string, Record<string, string | number | boolean>>>({})
  const [detailId, setDetailId] = useState<string | null>(null)
  const [importOpen, setImportOpen] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/admin/plugins')
      if (!res.ok) throw new Error(await res.text())
      const body = await res.json()
      const list: PluginStatus[] = body.statuses ?? []
      // manifest 里的 settings 只有 key/label/default，**当前值**在另一个端点。
      // 不在这里合并，表单就永远显示成「什么都没配」—— 超管看不出实际配置是什么。
      await Promise.all(
        list.map(async (plugin) => {
          const specs = plugin.manifest?.settings
          if (!specs?.length) return
          const r = await fetch(`/api/admin/plugins/${plugin.id}/settings`)
          if (!r.ok) return
          const saved = (await r.json()).settings as { key: string; value?: unknown; set?: boolean }[]
          for (const spec of specs) {
            const hit = saved.find((s) => s.key === spec.key)
            if (hit) Object.assign(spec, { value: hit.value, set: hit.set })
          }
        }),
      )
      setStatuses(list)
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

  /** 成功时回响应体（对象恒为真），失败时提示并回 null */
  const act = async (path: string, body?: unknown): Promise<any | null> => {
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
        return null
      }
      return await res.json().catch(() => ({}))
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err))
      return null
    }
  }

  const saveSettings = async (id: string) => {
    const draft = drafts[id] ?? {}
    if (Object.keys(draft).length === 0) {
      message.info(t('plugins.nothingToSave'))
      return
    }
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
    Modal.info({
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

  const detail = statuses.find((item) => item.id === detailId) ?? null

  const renderSettingsTab = (plugin: PluginStatus) => (
    <Space direction="vertical" style={{ width: '100%' }} size={12}>
      {(plugin.manifest?.settings ?? []).length === 0 && (
        <Alert type="info" showIcon message={t('plugins.noSettings')} />
      )}
      {plugin.manifest?.settings?.map((spec) => (
        <div key={spec.key}>
          <Typography.Text strong>{spec.label}</Typography.Text>
          <Typography.Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>
            {spec.key}
          </Typography.Text>
          {spec.type === 'int' ? (
            <InputNumber
              style={{ width: '100%', marginTop: 4 }}
              // 当前值直接填进输入框，而不是当 placeholder 提示：
              // 灰字提示会被读成「示例值」，超管看不出这其实是生效中的配置
              placeholder={String(spec.default ?? '')}
              value={(drafts[plugin.id]?.[spec.key] as number | undefined) ?? (typeof spec.value === 'number' ? spec.value : undefined)}
              onChange={(value) => setDrafts((prev) => ({ ...prev, [plugin.id]: { ...(prev[plugin.id] ?? {}), [spec.key]: value ?? '' } }))}
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
                : String(spec.default ?? '')}
              // secret 永远不回填：后端只回「是否已设置」，明文不下发
              value={String(drafts[plugin.id]?.[spec.key] ?? (spec.type === 'secret' ? '' : spec.value ?? ''))}
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
      {(plugin.manifest?.settings ?? []).length > 0 && (
        <Button size="small" onClick={() => void saveSettings(plugin.id)}>
          {t('plugins.saveSettings')}
        </Button>
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
    </Space>
  )

  const renderEndpointsTab = (plugin: PluginStatus) => (
    <Table<EndpointSpec>
      size="small"
      pagination={false}
      // 窄屏（手机后台、半屏分栏）下宁可让表格自己横向滚，也不要裁掉「用途」
      scroll={{ x: 'max-content' }}
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
  )

  const renderRequiresTab = (plugin: PluginStatus) => (
    <Space direction="vertical" style={{ width: '100%' }} size={8}>
      {(plugin.manifest?.requires ?? []).length === 0 && (
        <Alert type="info" showIcon message={t('plugins.noRequires')} />
      )}
      {plugin.manifest?.requires?.map((req) => (
        <Alert key={req.id} type="warning" showIcon message={req.label} description={req.note} />
      ))}
    </Space>
  )

  return (
    <div style={{ padding: 16 }}>
      <Space style={{ marginBottom: 16 }} wrap>
        <Button onClick={() => void load()} loading={loading}>
          {t('plugins.reload')}
        </Button>
        <Popconfirm
          title={t('plugins.scanConfirm')}
          onConfirm={async () => {
            if (await act('/api/admin/plugins/scan')) message.success(t('plugins.scanDone'))
            await load()
          }}
        >
          <Button>{t('plugins.scan')}</Button>
        </Popconfirm>
        <Button type="primary" onClick={() => setImportOpen(true)}>
          {t('plugins.import')}
        </Button>
      </Space>

      <Alert type="info" showIcon style={{ marginBottom: 16 }} message={t('plugins.responsibilityNotice')} />

      <Row gutter={[16, 16]}>
        {statuses.map((plugin) => (
          <Col key={plugin.id} xs={24} md={12} xxl={8}>
            <Card
              size="small"
              title={
                <Space>
                  <Badge status={STATE_BADGE[plugin.state]} />
                  <span>{plugin.name}</span>
                  <Tag>{plugin.version}</Tag>
                  {plugin.enabled && <Tag color="green">{t('plugins.enabled')}</Tag>}
                </Space>
              }
              actions={[
                plugin.state === 'ready' || plugin.enabled ? (
                  <Button
                    key="toggle"
                    type="link"
                    danger
                    onClick={async () => {
                      await act(`/api/admin/plugins/${plugin.id}/disable`)
                      await load()
                    }}
                  >
                    {t('plugins.disable')}
                  </Button>
                ) : (
                  <Button
                    key="toggle"
                    type="link"
                    onClick={async () => {
                      await act(`/api/admin/plugins/${plugin.id}/enable`)
                      await load()
                    }}
                  >
                    {t('plugins.enable')}
                  </Button>
                ),
                <Button
                  key="reload"
                  type="link"
                  onClick={async () => {
                    const result = await act(`/api/admin/plugins/${plugin.id}/reload`)
                    if (result?.staleCode) message.warning(t('plugins.reloadedStale'))
                    else if (result) message.success(t('plugins.reloaded'))
                    await load()
                  }}
                >
                  {t('plugins.reloadOne')}
                </Button>,
                <Button key="settings" type="link" onClick={() => setDetailId(plugin.id)}>
                  {t('plugins.openSettings')}
                </Button>,
              ]}
            >
              <Typography.Text type="secondary" copyable={{ text: plugin.id }}>
                {plugin.id}
              </Typography.Text>
              <Typography.Paragraph style={{ marginTop: 8 }} ellipsis={{ rows: 3 }}>
                {plugin.manifest?.description ?? t('plugins.noDescription')}
              </Typography.Paragraph>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {t('plugins.requiresSite')}: {plugin.manifest?.mcsts ?? '-'} · API v{plugin.apiVersion}
              </Typography.Text>
              {plugin.error && <Alert type="error" showIcon message={plugin.error} style={{ marginTop: 8 }} />}
              {hasRequires(plugin) && (
                <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>
                  {/* 不用 type="warning"：主题表把 .ant-typography 的颜色整体接管了，
                      语义色会被覆盖成普通白字；图标没人接管，才拿它当警示色 */}
                  <ExclamationCircleOutlined style={{ color: '#faad14', marginRight: 6 }} />
                  {t('plugins.requiresHint')}
                </Typography.Paragraph>
              )}
              {plugin.staleCode && (
                <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 6, marginBottom: 0 }}>
                  <ExclamationCircleOutlined style={{ color: '#ff4d4f', marginRight: 6 }} />
                  {t('plugins.staleCodeHint')}
                </Typography.Paragraph>
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

      <PluginImportModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={() => void load()}
      />

      <Modal
        open={detail !== null}
        onCancel={() => setDetailId(null)}
        footer={<Button onClick={() => setDetailId(null)}>{t('plugins.close')}</Button>}
        width={860}
        title={
          detail
            ? `${detail.name} ${detail.version} · ${detail.id}`
            : ''
        }
      >
        {detail && (
          <Tabs
            items={[
              { key: 'settings', label: t('plugins.settings'), children: renderSettingsTab(detail) },
              { key: 'endpoints', label: `${t('plugins.endpoints')} (${(detail.manifest?.endpoints ?? []).length})`, children: renderEndpointsTab(detail) },
              { key: 'requires', label: `${t('plugins.externalRequires')} (${(detail.manifest?.requires ?? []).length})`, children: renderRequiresTab(detail) },
            ]}
          />
        )}
      </Modal>
    </div>
  )
}
