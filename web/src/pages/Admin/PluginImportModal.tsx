import { compatFetch as fetch } from '../../utils/apiCompat'
import { useState } from 'react'
import {
  Alert,
  Button,
  Checkbox,
  Divider,
  Form,
  Input,
  Modal,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from 'antd'
import { useTranslation } from 'react-i18next'

/**
 * GitHub 导入弹窗（仅超级管理员）。
 *
 * 只填一个**仓库地址**：版本号由后端从仓库的 tag 里自动识别（取最新的语义化版本），
 * 不再手输 tag —— 手输正是「装错一份代码」的入口，而认不出语义化版本的仓库本来就该拒。
 * 地址这一栏可以粘 clone 地址、网页地址、`owner/name`，或「镜像前缀 + 完整 GitHub 地址」。
 *
 * 两步走：**先预览、再安装**。预览不写盘，把要装的东西整个摊出来 ——
 * manifest 摘要、文件清单、体积、自动选中的 tag 与它解析出的 commit sha，以及那份
 * 「识别代号标记」的核对结果。标记不通过时安装按钮直接禁用：
 * 这不是可选警告，而是这个仓库凭什么被认成该插件的唯一凭据。
 *
 * 装完只是「发现」，不会自动启用 —— 与手工把目录放进 MCSTS_PLUGIN_DIR 完全一致。
 */

interface EndpointSpec {
  kind: string
  method: string
  path: string
  auth: string
  note?: string
}

interface PreviewResult {
  repo: string
  /** 后端自动识别出来的发布 tag */
  tag: string
  /** tag 解析出的 commit sha */
  sha: string
  dir: string
  /** true = 提交时子目录留空，由整棵树里唯一一份 manifest 反推出来的位置 */
  dirAutoDetected?: boolean
  manifest: {
    id: string
    name: string
    version: string
    apiVersion: number
    description?: string
    author?: string
    endpoints?: EndpointSpec[]
  }
  marker: { path: string; ok: boolean; reason?: string }
  files: { path: string; local: string; size: number; blobSha: string }[]
  totalBytes: number
  /** 扫过多少个 tag（列表顺序不可信，全靠语义化比较挑） */
  tagsScanned?: number
  /** false = tag 与 manifest 里写的 version 对不上；只提示，不拦安装 */
  versionMatchesManifest?: boolean
}

interface FormValues {
  repo: string
  dir?: string
}

/** 后端把导入失败统一收成 PLUGIN_IMPORT_REJECTED，message 里就是原因 */
async function post<T>(path: string, body: unknown): Promise<{ ok: true; data: T } | { ok: false; message: string }> {
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const text = await res.text()
    let parsed: Record<string, unknown> = {}
    try {
      parsed = JSON.parse(text) as Record<string, unknown>
    } catch {
      /* 非 JSON 错误体，下面按原文回给调用方 */
    }
    if (!res.ok) {
      return { ok: false, message: String(parsed['message'] ?? parsed['errorMessage'] ?? text ?? `HTTP ${res.status}`) }
    }
    return { ok: true, data: parsed as T }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

export function PluginImportModal(props: { open: boolean; onClose: () => void; onImported: () => void }) {
  const { t } = useTranslation()
  const [form] = Form.useForm<FormValues>()
  const [preview, setPreview] = useState<PreviewResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [replace, setReplace] = useState(false)
  /**
   * 失败原因留在弹窗里，而不是只弹一条三秒就消失的 toast：
   * 预览/安装要打好几个 GitHub 请求，失败文案很长（限流、缺标记、清单不符…），
   * 实测 toast 一闪而过，超管根本来不及看清是上游不通还是仓库不合规。
   */
  const [failure, setFailure] = useState<string | null>(null)

  const reset = () => {
    setPreview(null)
    setReplace(false)
    setFailure(null)
  }

  const doPreview = async () => {
    const values = await form.validateFields().catch(() => null)
    if (!values) return
    setBusy(true)
    setPreview(null)
    const result = await post<{ preview: PreviewResult }>('/api/admin/plugins/import/preview', values)
    setBusy(false)
    if (!result.ok) {
      setFailure(result.message)
      message.error(t('plugins.importPreviewFailed'))
      return
    }
    setFailure(null)
    setPreview(result.data.preview)
  }

  const doInstall = async () => {
    if (!preview) return
    const values = form.getFieldsValue()
    setBusy(true)
    const result = await post<{ id: string; files: number }>('/api/admin/plugins/import', {
      ...values,
      sha: preview.sha,
      replace,
    })
    setBusy(false)
    if (!result.ok) {
      setFailure(result.message)
      message.error(t('plugins.importInstallFailed'))
      return
    }
    setFailure(null)
    message.success(t('plugins.importDone', { id: result.data.id, files: result.data.files }))
    reset()
    props.onImported()
    props.onClose()
  }

  return (
    <Modal
      open={props.open}
      title={t('plugins.importTitle')}
      width={760}
      onCancel={() => {
        reset()
        props.onClose()
      }}
      footer={[
        <Button key="cancel" onClick={props.onClose}>
          {t('plugins.close')}
        </Button>,
        <Button key="preview" loading={busy} onClick={() => void doPreview()}>
          {t('plugins.importPreview')}
        </Button>,
        <Button
          key="install"
          type="primary"
          disabled={!preview || preview.marker.ok === false}
          loading={busy}
          onClick={() => void doInstall()}
        >
          {t('plugins.importInstall')}
        </Button>,
      ]}
    >
      <Alert type="warning" showIcon style={{ marginBottom: 16 }} message={t('plugins.importRisk')} />

      <Form form={form} layout="vertical" onValuesChange={reset}>
        <Space align="start" size={12} style={{ width: '100%' }} wrap>
          <Form.Item
            name="repo"
            label={t('plugins.importRepo')}
            // 不在前端再写一套「什么算合法地址」：能认哪些形态由后端 parseRepoInput 说了算，
            // 两处各写一份迟早漂移（历史上这类分叉都是靠测试才发现的）。
            rules={[{ required: true, message: t('plugins.importRepoRequired') }]}
            extra={t('plugins.importRepoHint')}
            style={{ marginBottom: 8, minWidth: 380 }}
          >
            <Input placeholder="https://github.com/owner/repo.git" autoComplete="off" />
          </Form.Item>
          <Form.Item name="dir" label={t('plugins.importDir')} style={{ marginBottom: 8, minWidth: 200 }}>
            <Input placeholder={t('plugins.importDirPlaceholder')} autoComplete="off" />
          </Form.Item>
        </Space>
      </Form>

      {failure && (
        <Alert
          type="error"
          showIcon
          closable
          onClose={() => setFailure(null)}
          style={{ marginBottom: 12 }}
          message={t('plugins.importFailedTitle')}
          description={failure}
        />
      )}

      {preview && (
        <>
          <Divider orientation="left" plain>
            {t('plugins.importSummary')}
          </Divider>
          <Space direction="vertical" size={4} style={{ width: '100%' }}>
            <Typography.Text>
              <Tag color={preview.marker.ok ? 'green' : 'red'}>
                {preview.marker.ok ? t('plugins.importMarkerOk') : t('plugins.importMarkerFail')}
              </Tag>
              <Typography.Text type="secondary">{preview.manifest.id}</Typography.Text>
              {' · '}
              {preview.manifest.name} {preview.manifest.version} · API v{preview.manifest.apiVersion}
            </Typography.Text>
            {preview.manifest.description && (
              <Typography.Paragraph style={{ marginBottom: 0 }}>{preview.manifest.description}</Typography.Paragraph>
            )}
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t('plugins.importAutoVersion')}：{preview.repo}@{preview.tag} →{' '}
              <Typography.Text copyable style={{ fontSize: 12 }}>
                {preview.sha}
              </Typography.Text>
              {preview.tagsScanned !== undefined && (
                <> · {t('plugins.importTagsScanned', { n: preview.tagsScanned })}</>
              )}
              {preview.dirAutoDetected && (
                <> · {t('plugins.importDirAuto', { dir: preview.dir })}</>
              )}
              {' · '}
              {t('plugins.importFileCount', { files: preview.files.length, size: formatBytes(preview.totalBytes) })}
            </Typography.Text>
            {preview.versionMatchesManifest === false && (
              <Alert
                type="warning"
                showIcon
                style={{ marginTop: 4 }}
                message={t('plugins.importVersionMismatch', {
                  tag: preview.tag,
                  version: preview.manifest.version,
                })}
              />
            )}
            {(preview.manifest.endpoints ?? []).length > 0 && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {t('plugins.importEndpoints')}:{' '}
                {(preview.manifest.endpoints ?? [])
                  .map((item) => `${item.method} /api/plugins/${preview.manifest.id}${item.path}`)
                  .join('、')}
              </Typography.Text>
            )}
          </Space>
          {!preview.marker.ok && (
            <Alert
              type="error"
              showIcon
              style={{ marginTop: 12 }}
              message={t('plugins.importMarkerPath', { path: preview.marker.path })}
              description={preview.marker.reason}
            />
          )}

          <Divider orientation="left" plain>
            {t('plugins.importFiles')}
          </Divider>
          <Table
            size="small"
            pagination={false}
            rowKey="path"
            scroll={{ y: 200, x: 'max-content' }}
            dataSource={preview.files}
            columns={[
              { title: t('plugins.importFilePath'), dataIndex: 'local' },
              { title: t('plugins.importFileSize'), dataIndex: 'size', width: 100, render: (value: number) => formatBytes(value) },
              {
                title: t('plugins.importFileBlob'),
                dataIndex: 'blobSha',
                width: 130,
                render: (value: string) => (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {value.slice(0, 10)}
                  </Typography.Text>
                ),
              },
            ]}
          />

          <Checkbox
            checked={replace}
            onChange={(e) => setReplace(e.target.checked)}
            style={{ marginTop: 12 }}
          >
            {t('plugins.importReplace')}
          </Checkbox>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 4, marginBottom: 0 }}>
            {t('plugins.importReplaceHint')}
          </Typography.Paragraph>
        </>
      )}
    </Modal>
  )
}
