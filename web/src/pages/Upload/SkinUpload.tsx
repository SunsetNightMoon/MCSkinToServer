import { compatFetch as fetch } from "../../utils/apiCompat" // 数据层适配：/api/* 自动翻译为 MCSTS 端点
import { useState, useMemo, useEffect, useCallback } from 'react'
import { Form, Upload, Select, Input, Button, message, Radio, Alert, Tabs } from 'antd'
import { UploadOutlined } from '@ant-design/icons'
import type { UploadFile, UploadProps } from 'antd/es/upload/interface'
import { useSearchParams } from 'react-router-dom'
import { Skin3DViewer } from '../../components/Skin3DViewer/Skin3DViewer'
import { TurnstileWidget } from '../../components/TurnstileWidget/TurnstileWidget'
import { usePageTitle } from '../../hooks/usePageTitle'
import { useTranslation } from 'react-i18next'

function useViewportSize() {
  const [size, setSize] = useState({ width: window.innerWidth, height: window.innerHeight })
  useEffect(() => {
    const onResize = () => setSize({ width: window.innerWidth, height: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return size
}

/* ─────────────────────── 皮肤上传面板 ─────────────────────── */
function SkinTab() {
  const { t } = useTranslation()

  const LICENSE_OPTIONS = [
    { value: 'CC0_1.0', label: t('upload.license.CC0_1.0') },
    { value: 'CC_BY_3.0', label: t('upload.license.CC_BY_3.0') },
    { value: 'CC_BY_4.0', label: t('upload.license.CC_BY_4.0') },
    { value: 'CC_BY-SA_3.0', label: t('upload.license.CC_BY-SA_3.0') },
    { value: 'CC_BY-SA_4.0', label: t('upload.license.CC_BY-SA_4.0') },
    { value: 'CC_BY-NC_3.0', label: t('upload.license.CC_BY-NC_3.0') },
    { value: 'CC_BY-NC_4.0', label: t('upload.license.CC_BY-NC_4.0') },
    { value: 'ARR', label: t('upload.license.ARR') },
    { value: 'AI_CC0', label: t('upload.license.AI_CC0') },
    { value: 'Custom', label: t('upload.license.Custom') },
  ]

  const PERMISSION_OPTIONS = [
    { value: 'private', label: t('upload.permission.private') },
    { value: 'public_no_download', label: t('upload.permission.public_no_download') },
    { value: 'public_downloadable', label: t('upload.permission.public_downloadable') },
  ]

  const [form] = Form.useForm()
  const [file, setFile] = useState<UploadFile | null>(null)
  const [modelType, setModelType] = useState<'default' | 'slim'>('default')
  const [loading, setLoading] = useState(false)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [selectedLicense, setSelectedLicense] = useState<string>('')
  const [captchaType, setCaptchaType] = useState<'turnstile' | 'math' | 'none'>('none')
  const [turnstileToken, setTurnstileToken] = useState<string>('')
  const [turnstileSiteKey, setTurnstileSiteKey] = useState<string>('')

  useEffect(() => {
    const fetchCaptchaType = async () => {
      try {
        const response = await fetch('/api/captcha/captcha-type')
        const data = await response.json()
        setCaptchaType(data.type)
        if (data.type === 'turnstile' && data.siteKey) {
          setTurnstileSiteKey(data.siteKey)
        }
      } catch {}
    }
    fetchCaptchaType()
  }, [])

  const handleTurnstileVerify = useCallback((token: string) => {
    setTurnstileToken(token)
  }, [])

  const handleTurnstileError = useCallback((error: string) => {
    message.error(error)
    setTurnstileToken('')
  }, [])

  // 选择公有领域协议时，禁止"公开不可下载"，自动切换到"公开可下载"
  useEffect(() => {
    const isPublicDomain = selectedLicense === 'CC0_1.0' || selectedLicense === 'AI_CC0'
    if (isPublicDomain && form.getFieldValue('permission_level') === 'public_no_download') {
      form.setFieldValue('permission_level', 'public_downloadable')
    }
  }, [selectedLicense, form])

  const { width: vw } = useViewportSize()
  const viewerSize = useMemo(() => {
    if (vw < 420) return { width: 260, height: 300 }
    if (vw < 576) return { width: 280, height: 320 }
    if (vw < 768) return { width: 320, height: 360 }
    return { width: 360, height: 400 }
  }, [vw])

  const skinUrl = useMemo(() => previewUrl || '/steve.png', [previewUrl])

  const beforeUploadSkin: UploadProps['beforeUpload'] = (file) => {
    if (file.type !== 'image/png') { message.error(t('upload.onlyPng')); return false }
    if (file.size > 1 * 1024 * 1024) { message.error(t('upload.fileSizeLimit')); return false }
    if (previewUrl) URL.revokeObjectURL(previewUrl)
    setPreviewUrl(URL.createObjectURL(file))
    setFile(file)
    return false
  }

  const onFinish = async (values: any) => {
    if (!file) { message.error(t('upload.pleaseUploadSkin')); return }
    if (captchaType === 'turnstile' && !turnstileToken) {
      message.error(t('upload.pleaseCompleteCaptcha'))
      return
    }
    setLoading(true)
    try {
      const formData = new FormData()
      formData.append('skin', file as any)
      formData.append('name', values.name)
      formData.append('model_type', values.model_type || 'default')
      formData.append('description', values.description || '')
      formData.append('license_type', values.license_type)
      formData.append('permission_level', values.permission_level)

      if (captchaType === 'turnstile' && turnstileToken) {
        formData.append('turnstile_token', turnstileToken)
      }

      const authStorage = localStorage.getItem('auth-storage')
      const token = authStorage ? JSON.parse(authStorage).state.token : null

      const response = await fetch('/api/skins/upload', {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: formData,
      })
      const data = await response.json()

      if (response.ok) {
        message.success(t('upload.skinUploadSuccess'))
        form.resetFields()
        setFile(null)
        if (previewUrl) { URL.revokeObjectURL(previewUrl); setPreviewUrl(null) }
      } else {
        message.error(data.errorMessage || t('upload.uploadFailed'))
        if (captchaType === 'turnstile') {
          setTurnstileToken('')
        }
      }
    } catch { message.error(t('common.error')) }
    finally { setLoading(false) }
  }

  return (
    <div>
      <Alert
        message={t('upload.skinUploadGuide')}
        description={t('upload.skinUploadDesc')}
        type="info"
        showIcon
        style={{ marginBottom: 20 }}
      />

      <div style={{ display: 'flex', flexDirection: 'row', gap: 24, flexWrap: 'wrap' }}>
        {/* 左侧 3D 预览 */}
        <div style={{ flex: '0 0 auto' }}>
          <Skin3DViewer
            skinUrl={skinUrl}
            modelType={modelType}
            width={viewerSize.width}
            height={viewerSize.height}
          />
          <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'center' }}>
            <span style={{ fontSize: 13, color: 'rgba(255,255,255, 0.9)' }}>{t('upload.model')}：</span>
            <Radio.Group
              value={modelType}
              onChange={e => setModelType(e.target.value)}
              optionType="button"
              buttonStyle="solid"
              size="small"
            >
              <Radio.Button value="default">{t('upload.classicModel')}</Radio.Button>
              <Radio.Button value="slim">{t('upload.slimModel')}</Radio.Button>
            </Radio.Group>
          </div>
          {!file && <div style={{ marginTop: 8, fontSize: 12, color: 'rgba(255,255,255,0.6)', textAlign: 'center' }}>{t('upload.uploadToPreview')}</div>}
        </div>

        {/* 右侧表单 */}
        <div style={{ flex: '1 1 300px', minWidth: 280 }}>
          <Form form={form} layout="vertical" onFinish={onFinish}>
            <Form.Item label={t('upload.skinName')} name="name" rules={[{ required: true, message: t('upload.pleaseEnterSkinName') }]}>
              <Input placeholder={t('upload.skinNamePlaceholder')} maxLength={50} showCount />
            </Form.Item>

            <Form.Item label={t('upload.skinFile')} required>
              <Upload beforeUpload={beforeUploadSkin} fileList={file ? [file] : []} maxCount={1} accept=".png"
                onRemove={() => { if (previewUrl) { URL.revokeObjectURL(previewUrl); setPreviewUrl(null) }; setFile(null) }}>
                <Button icon={<UploadOutlined />}>{t('upload.selectSkinPng')}</Button>
              </Upload>
            </Form.Item>

            <Form.Item label={t('upload.modelType')} name="model_type" initialValue="default">
              <Radio.Group value={modelType} onChange={e => { setModelType(e.target.value); form.setFieldValue('model_type', e.target.value) }}>
                <Radio value="default">{t('upload.classicDefault')}</Radio>
                <Radio value="slim">{t('upload.slimAlex')}</Radio>
              </Radio.Group>
            </Form.Item>

            <Form.Item label={t('upload.description')} name="description">
              <Input.TextArea rows={2} placeholder={t('upload.descriptionPlaceholder')} />
            </Form.Item>

            <Form.Item label={t('upload.licenseType')} name="license_type" rules={[{ required: true, message: t('upload.pleaseSelectLicense') }]}>
              <Select
                options={LICENSE_OPTIONS}
                placeholder={t('upload.pleaseSelectLicense')}
                onChange={value => setSelectedLicense(value)}
              />
            </Form.Item>

            <Alert
              type="warning"
              showIcon
              message={t('upload.aiSkinTitle')}
              description={t('upload.aiSkinDesc')}
              style={{ marginBottom: 16 }}
            />

            <Form.Item label={t('upload.permissionSetting')} name="permission_level" rules={[{ required: true, message: t('upload.pleaseSelectPermission') }]} initialValue="private">
              <Radio.Group style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {PERMISSION_OPTIONS.map(opt => {
                  const isPublicDomain = selectedLicense === 'CC0_1.0' || selectedLicense === 'AI_CC0'
                  const disabled = isPublicDomain && opt.value === 'public_no_download'
                  return (
                    <Radio key={opt.value} value={opt.value} disabled={disabled}>
                      {opt.label}{disabled && t('upload.publicDomainNoRestrict')}
                    </Radio>
                  )
                })}
              </Radio.Group>
            </Form.Item>

            {captchaType === 'turnstile' && (
              <TurnstileWidget
                siteKey={turnstileSiteKey}
                mode="invisible"
                onVerify={handleTurnstileVerify}
                onError={handleTurnstileError}
              />
            )}

            <Form.Item>
              <Button type="primary" htmlType="submit" loading={loading} block size="large">
                {t('upload.uploadSkin')}
              </Button>
            </Form.Item>
          </Form>
        </div>
      </div>
    </div>
  )
}

/* ─────────────────────── 披风上传面板 ─────────────────────── */
function CapeTab() {
  const { t } = useTranslation()

  const LICENSE_OPTIONS = [
    { value: 'CC0_1.0', label: t('upload.license.CC0_1.0') },
    { value: 'CC_BY_3.0', label: t('upload.license.CC_BY_3.0') },
    { value: 'CC_BY_4.0', label: t('upload.license.CC_BY_4.0') },
    { value: 'CC_BY-SA_3.0', label: t('upload.license.CC_BY-SA_3.0') },
    { value: 'CC_BY-SA_4.0', label: t('upload.license.CC_BY-SA_4.0') },
    { value: 'CC_BY-NC_3.0', label: t('upload.license.CC_BY-NC_3.0') },
    { value: 'CC_BY-NC_4.0', label: t('upload.license.CC_BY-NC_4.0') },
    { value: 'ARR', label: t('upload.license.ARR') },
    { value: 'AI_CC0', label: t('upload.license.AI_CC0') },
    { value: 'Custom', label: t('upload.license.Custom') },
  ]

  const PERMISSION_OPTIONS = [
    { value: 'private', label: t('upload.permission.private') },
    { value: 'public_no_download', label: t('upload.permission.public_no_download') },
    { value: 'public_downloadable', label: t('upload.permission.public_downloadable') },
  ]

  const [form] = Form.useForm()
  const [file, setFile] = useState<UploadFile | null>(null)
  const [loading, setLoading] = useState(false)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [selectedLicense, setSelectedLicense] = useState<string>('ARR')
  const [captchaType, setCaptchaType] = useState<'turnstile' | 'math' | 'none'>('none')
  const [turnstileToken, setTurnstileToken] = useState<string>('')
  const [turnstileSiteKey, setTurnstileSiteKey] = useState<string>('')

  useEffect(() => {
    const fetchCaptchaType = async () => {
      try {
        const response = await fetch('/api/captcha/captcha-type')
        const data = await response.json()
        setCaptchaType(data.type)
        if (data.type === 'turnstile' && data.siteKey) {
          setTurnstileSiteKey(data.siteKey)
        }
      } catch {}
    }
    fetchCaptchaType()
  }, [])

  const handleTurnstileVerify = useCallback((token: string) => {
    setTurnstileToken(token)
  }, [])

  const handleTurnstileError = useCallback((error: string) => {
    message.error(error)
    setTurnstileToken('')
  }, [])

  // 选择公有领域协议时，禁止"公开不可下载"，自动切换到"公开可下载"
  useEffect(() => {
    const isPublicDomain = selectedLicense === 'CC0_1.0' || selectedLicense === 'AI_CC0'
    if (isPublicDomain && form.getFieldValue('permission_level') === 'public_no_download') {
      form.setFieldValue('permission_level', 'public_downloadable')
    }
  }, [selectedLicense, form])

  const { width: vw } = useViewportSize()
  const viewerSize = useMemo(() => {
    if (vw < 420) return { width: 260, height: 300 }
    if (vw < 576) return { width: 280, height: 320 }
    if (vw < 768) return { width: 320, height: 360 }
    return { width: 360, height: 400 }
  }, [vw])

  const beforeUpload: UploadProps['beforeUpload'] = (file) => {
    if (file.type !== 'image/png') { message.error(t('upload.onlyPng')); return false }
    if (file.size > 1 * 1024 * 1024) { message.error(t('upload.capeFileSizeLimit')); return false }
    if (previewUrl) URL.revokeObjectURL(previewUrl)
    setPreviewUrl(URL.createObjectURL(file))
    setFile(file)
    return false
  }

  const onFinish = async (values: any) => {
    if (!file) { message.error(t('upload.pleaseUploadCape')); return }
    if (captchaType === 'turnstile' && !turnstileToken) {
      message.error(t('upload.pleaseCompleteCaptcha'))
      return
    }
    setLoading(true)
    try {
      const formData = new FormData()
      formData.append('cape', file as any)
      formData.append('name', values.name)
      formData.append('description', values.description || '')
      formData.append('license_type', values.license_type || 'ARR')
      formData.append('permission_level', values.permission_level || 'private')

      if (captchaType === 'turnstile' && turnstileToken) {
        formData.append('turnstile_token', turnstileToken)
      }

      const authStorage = localStorage.getItem('auth-storage')
      const token = authStorage ? JSON.parse(authStorage).state.token : null

      const response = await fetch('/api/skins/upload-cape', {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: formData,
      })
      const data = await response.json()

      if (response.ok) {
        message.success(t('upload.capeUploadSuccess'))
        form.resetFields()
        setFile(null)
        if (previewUrl) { URL.revokeObjectURL(previewUrl); setPreviewUrl(null) }
      } else {
        message.error(data.errorMessage || t('upload.uploadFailed'))
        if (captchaType === 'turnstile') {
          setTurnstileToken('')
        }
      }
    } catch { message.error(t('common.error')) }
    finally { setLoading(false) }
  }

  return (
    <div>
      <Alert
        message={t('upload.capeUploadGuide')}
        description={t('upload.capeUploadDesc')}
        type="info"
        showIcon
        style={{ marginBottom: 20 }}
      />

      <div style={{ display: 'flex', flexDirection: 'row', gap: 24, flexWrap: 'wrap' }}>
        {/* 左侧 3D 预览（默认 Steve 模型，背面视角） */}
        <div style={{ flex: '0 0 auto' }}>
          <Skin3DViewer
            skinUrl="/steve.png"
            capeUrl={previewUrl}
            modelType="default"
            width={viewerSize.width}
            height={viewerSize.height}
            initialBackView={true}
          />
          <div style={{ marginTop: 8, fontSize: 12, color: 'rgba(255,255,255,0.6)', textAlign: 'center' }}>
            {file ? t('upload.cape3DPreview') : t('upload.uploadCapeToPreview')}
          </div>
        </div>

        {/* 右侧表单 */}
        <div style={{ flex: '1 1 300px', minWidth: 280 }}>
          <Form form={form} layout="vertical" onFinish={onFinish}>
            <Form.Item label={t('upload.capeName')} name="name" rules={[{ required: true, message: t('upload.pleaseEnterCapeName') }]}>
              <Input placeholder={t('upload.capeNamePlaceholder')} maxLength={50} showCount />
            </Form.Item>

            <Form.Item label={t('upload.capeFile')} required>
              <Upload beforeUpload={beforeUpload} fileList={file ? [file] : []} maxCount={1} accept=".png"
                onRemove={() => { if (previewUrl) { URL.revokeObjectURL(previewUrl); setPreviewUrl(null) }; setFile(null) }}>
                <Button icon={<UploadOutlined />}>{t('upload.selectCapePng')}</Button>
              </Upload>
              <div style={{ marginTop: 6, fontSize: 12, color: 'rgba(255,255,255,0.6)' }}>{t('upload.capeSizeHint')}</div>
            </Form.Item>

            <Form.Item label={t('upload.description')} name="description">
              <Input.TextArea rows={2} placeholder={t('upload.descriptionPlaceholder')} />
            </Form.Item>

            <Form.Item label={t('upload.licenseType')} name="license_type" initialValue="ARR">
              <Select
                options={LICENSE_OPTIONS}
                placeholder={t('upload.pleaseSelectCapeLicense')}
                onChange={value => setSelectedLicense(value)}
              />
            </Form.Item>

            <Alert
              type="warning"
              showIcon
              message={t('upload.aiCapeTitle')}
              description={t('upload.aiCapeDesc')}
              style={{ marginBottom: 16 }}
            />

            <Form.Item label={t('upload.permissionSetting')} name="permission_level" rules={[{ required: true, message: t('upload.pleaseSelectPermission') }]} initialValue="private">
              <Radio.Group style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {PERMISSION_OPTIONS.map(opt => {
                  const isPublicDomain = selectedLicense === 'CC0_1.0' || selectedLicense === 'AI_CC0'
                  const disabled = isPublicDomain && opt.value === 'public_no_download'
                  return (
                    <Radio key={opt.value} value={opt.value} disabled={disabled}>
                      {opt.label}{disabled && t('upload.publicDomainNoRestrict')}
                    </Radio>
                  )
                })}
              </Radio.Group>
            </Form.Item>

            {captchaType === 'turnstile' && (
              <TurnstileWidget
                siteKey={turnstileSiteKey}
                mode="invisible"
                onVerify={handleTurnstileVerify}
                onError={handleTurnstileError}
              />
            )}

            <Form.Item>
              <Button type="primary" htmlType="submit" loading={loading} block size="large">
                {t('upload.uploadCape')}
              </Button>
            </Form.Item>
          </Form>
        </div>
      </div>
    </div>
  )
}

/* ─────────────────────── 主页面 ─────────────────────── */
export function SkinUpload() {
  const { t } = useTranslation()
  usePageTitle(t('nav.upload'))
  const [searchParams, setSearchParams] = useSearchParams()
  const [activeKey, setActiveKey] = useState(() => {
    const type = searchParams.get('type')
    return type === 'cape' ? 'cape' : 'skin'
  })

  const handleTabChange = (key: string) => {
    setActiveKey(key)
    setSearchParams({ type: key })
  }

  return (
    <div style={{ maxWidth: 900, margin: '0 auto', padding: '0 0 20px 0' }}>
      <h2>{t('nav.upload')}</h2>
      <Tabs
        activeKey={activeKey}
        onChange={handleTabChange}
        items={[
          { key: 'skin', label: t('upload.skinTab'), children: <SkinTab /> },
          { key: 'cape', label: t('upload.capeTab'), children: <CapeTab /> },
        ]}
      />
    </div>
  )
}
