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
 * 两步走：**先预览、再安装**。预览不写盘，把要装的东西整个摊出来 ——
 * manifest 摘要、文件清单、体积、tag 解析出的 commit sha，以及那份
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
  tag: string
  sha: string
  dir: string
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
}

interface FormValues {
  repo: string
  tag: string
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

  const reset = () => {
    setPreview(null)
    setReplace(false)
  }

  const doPreview = async () => {
    const values = await form.validateFields().catch(() => null)
    if (!values) return
    setBusy(true)
    setPreview(null)
    const result = await post<{ preview: PreviewResult }>('/api/admin/plugins/import/preview', values)
    setBusy(false)
    if (!result.ok) {
      message.error(result.message)
      return
    }
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
      message.error(result.message)
      return
    }
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
            rules={[
              { required: true },
              { pattern: /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, message: t('plugins.importRepoPattern') },
            ]}
            style={{ marginBottom: 8, minWidth: 260 }}
          >
            <Input placeholder="owner/name" autoComplete="off" />
          </Form.Item>
          <Form.Item
            name="tag"
            label={t('plugins.importTag')}
            rules={[{ required: true }]}
            style={{ marginBottom: 8, minWidth: 160 }}
          >
            <Input placeholder="v1.0.0" autoComplete="off" />
          </Form.Item>
          <Form.Item name="dir" label={t('plugins.importDir')} style={{ marginBottom: 8, minWidth: 200 }}>
            <Input placeholder={t('plugins.importDirPlaceholder')} autoComplete="off" />
          </Form.Item>
        </Space>
      </Form>

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
              {preview.repo}@{preview.tag} →{' '}
              <Typography.Text copyable style={{ fontSize: 12 }}>
                {preview.sha}
              </Typography.Text>
              {' · '}
              {t('plugins.importFileCount', { files: preview.files.length, size: formatBytes(preview.totalBytes) })}
            </Typography.Text>
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
