import { useState, useEffect } from 'react'
import { useAuthStore } from '../../store/authStore'
import { useSiteStore } from '../../store/siteStore'
import { clearSiteTitleCache } from '../../hooks/usePageTitle'
import { fetchWithAuth } from '../../utils/api'
import { Form, Input, Switch, Button, message, Card, Spin, Modal, Upload, Space, Slider, Alert } from 'antd'
import { SendOutlined, EditOutlined, CloseOutlined, UploadOutlined, PlusOutlined, MinusCircleOutlined } from '@ant-design/icons'
import Editor from '@monaco-editor/react'
import './SystemSettings.css'
import { isVideoFile } from '../../utils/media'
import { settingBool } from '../../utils/settingBool'
import { parseHomepageButtons, type HomepageButton } from '../../utils/homepageButtons'
import { SITE_DEFAULTS } from '../../store/siteStore'
import { useTranslation } from 'react-i18next'

const { TextArea } = Input

/* ============================================================
   全局自动更新 Switch（复用组件）
   ============================================================ */
function GlobalAutoApplySwitch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  const { t } = useTranslation()
  return (
    <Switch
      checked={checked}
      onChange={onChange}
      checkedChildren={t('admin.globalAutoApply')}
      unCheckedChildren={t('admin.globalAutoApply')}
      style={{ marginLeft: 12 }}
    />
  )
}

/* ============================================================
   注册设置卡片
   ============================================================ */
function RegistrationSettings({ autoApply, onAutoApplyChange }: { autoApply: boolean; onAutoApplyChange: (v: boolean) => void }) {
  const { t } = useTranslation()
  const [form] = Form.useForm()
  const [loading, setLoading] = useState(false)
  const [loadingSettings, setLoadingSettings] = useState(true)

  const loadSettings = async () => {
    setLoadingSettings(true)
    try {
      const res = await fetchWithAuth('/api/admin/settings', {
      })
      if (!res.ok) throw new Error(t('admin.loadFailed'))
      const data = await res.json()
      // 必须用容错解析：这三个开关由 AntD Switch 提交，库里是 **JSON 布尔**，
      // 而旧代码用 `!== 'false'` / `=== 'true'` 跟字符串比较 —— 布尔 false 会被判成 true，
      // 表现为「关掉注册后重新加载又显示成开启」。见 utils/settingBool.ts。
      form.setFieldsValue({
        ALLOW_REGISTRATION: settingBool(
          data.ALLOW_REGISTRATION,
          SITE_DEFAULTS.allowRegistration,
        ),
        REQUIRE_EMAIL_VERIFICATION: settingBool(
          data.REQUIRE_EMAIL_VERIFICATION,
          false,
        ),
        ENABLE_CAPTCHA: settingBool(data.ENABLE_CAPTCHA, false),
      })
    } catch (err: any) {
      message.error(err.message || t('admin.loadSettingsFailed'))
    } finally {
      setLoadingSettings(false)
    }
  }

  useEffect(() => { loadSettings() }, [])

  const handleSave = async (values: any) => {
    setLoading(true)
    try {
      const res = await fetchWithAuth('/api/admin/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.errorMessage || t('common.operationFailed'))
      }
      message.success(t('admin.registrationSettingsSaved'))
      clearSiteTitleCache()
      if (autoApply) {
        useSiteStore.getState().loadSettings()
      }
    } catch (err: any) {
      message.error(err.message || t('common.operationFailed'))
    } finally {
      setLoading(false)
    }
  }

  if (loadingSettings) {
    return <Card style={{ marginBottom: 16 }}><Spin /></Card>
  }

  return (
    <Card title={t('admin.registrationSettings')} style={{ marginBottom: 16 }}>
      <Form form={form} layout="vertical" onFinish={handleSave}>
        <Form.Item
          label={t('admin.allowRegistration')}
          name="ALLOW_REGISTRATION"
          valuePropName="checked"
          tooltip={t('admin.allowRegistrationTooltip')}
        >
          <Switch checkedChildren={t('common.on')} unCheckedChildren={t('common.off')} />
        </Form.Item>

        <Form.Item
          label={t('admin.requireEmailVerification')}
          name="REQUIRE_EMAIL_VERIFICATION"
          valuePropName="checked"
          tooltip={t('admin.requireEmailVerificationTooltip')}
        >
          <Switch checkedChildren={t('common.on')} unCheckedChildren={t('common.off')} />
        </Form.Item>

        <Form.Item
          label={t('admin.enableCaptcha')}
          name="ENABLE_CAPTCHA"
          valuePropName="checked"
          tooltip={t('admin.enableCaptchaTooltip')}
        >
          <Switch checkedChildren={t('common.on')} unCheckedChildren={t('common.off')} />
        </Form.Item>

        <Form.Item>
          <Button type="primary" htmlType="submit" loading={loading}>
            {t('admin.saveRegistrationSettings')}
          </Button>
          <GlobalAutoApplySwitch checked={autoApply} onChange={onAutoApplyChange} />
        </Form.Item>
      </Form>
    </Card>
  )
}

/* ============================================================
   站点设置卡片
   ============================================================ */
function SiteSettings({ autoApply, onAutoApplyChange }: { autoApply: boolean; onAutoApplyChange: (v: boolean) => void }) {
  const { t } = useTranslation()
  const [form] = Form.useForm()
  const [loading, setLoading] = useState(false)
  const [loadingSettings, setLoadingSettings] = useState(true)
  const [extraButtons, setExtraButtons] = useState<HomepageButton[]>([])
  /** 「高度自定义首页」总开关：关闭 = 原版选项；开启 = HTML/CSS 编辑器 */
  const [customEnabled, setCustomEnabled] = useState(false)
  const [customHtml, setCustomHtml] = useState('')
  const [customCss, setCustomCss] = useState('')
  // 站点图标/徽标的本服务地址（上传后展示预览；手填外链也有预览，但不参与文件清理）
  const [faviconPreview, setFaviconPreview] = useState<string>('')
  const [logoPreview, setLogoPreview] = useState<string>('')

  const loadSettings = async () => {
    setLoadingSettings(true)
    try {
      const res = await fetchWithAuth('/api/admin/settings', {
      })
      if (!res.ok) throw new Error(t('admin.loadFailed'))
      const data = await res.json()
      // 后端可能返回已解析数组（早期/手工写入，生产域名服务器即此形态）或 JSON 字符串，
      // 统一交给 parseHomepageButtons，杜绝 JSON.parse(数组) 抛错回落空数组的假「未保存」。
      setExtraButtons(parseHomepageButtons(data.HOMEPAGE_BUTTONS))
      // 后端以 JSON 文本存取，布尔或字符串两种历史形态都兼容
      setCustomEnabled(
        data.HOMEPAGE_CUSTOM_ENABLED === true || String(data.HOMEPAGE_CUSTOM_ENABLED) === 'true',
      )
      setCustomHtml(String(data.HOMEPAGE_CUSTOM_HTML || ''))
      setCustomCss(String(data.HOMEPAGE_CUSTOM_CSS || ''))
      form.setFieldsValue({
        SITE_TITLE: String(data.SITE_TITLE || t('landing.welcomePrefix')),
        SITE_DESCRIPTION: String(data.SITE_DESCRIPTION || t('admin.defaultSiteDescription')),
        SITE_FAVICON: String(data.SITE_FAVICON || '/favicon.svg'),
        SITE_LOGO: String(data.SITE_LOGO || ''),
        HOMEPAGE_TITLE_TEXT: String(data.HOMEPAGE_TITLE_TEXT || t('landing.welcomePrefix')),
        HOMEPAGE_TEXT: String(data.HOMEPAGE_TEXT || t('landing.welcomeText')),
        HOMEPAGE_BUTTON_TEXT: String(data.HOMEPAGE_BUTTON_TEXT || t('landing.enterProfile')),
      })
      // 只有显式设置过的图标才出预览（缺省值 /favicon.svg 是静态资源，不是上传物）
      setFaviconPreview(String(data.SITE_FAVICON || ''))
      setLogoPreview(String(data.SITE_LOGO || ''))
    } catch (err: any) {
      message.error(err.message || t('admin.loadSettingsFailed'))
    } finally {
      setLoadingSettings(false)
    }
  }

  useEffect(() => { loadSettings() }, [])

  // ---- 站点图标/徽标：上传 / 移除 ----
  //
  // 后端与主题背景图共用同一对端点（/api/admin/upload-theme-image?type=…），
  // 兼容层会把 FormData 拆成 raw 字节；上传成功即写设置键（与主题图同一语义），
  // 移除时后端只删「本服务上传的文件」，手填的外链只清设置键不动磁盘。
  const uploadIcon = async (
    type: 'favicon' | 'logo',
    file: File,
    formKey: 'SITE_FAVICON' | 'SITE_LOGO',
    setPreview: (url: string) => void,
    successMsg: string,
  ) => {
    try {
      const formData = new FormData();
      formData.append('image', file);
      const res = await fetchWithAuth(`/api/admin/upload-theme-image?type=${type}`, {
        method: 'POST',
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.errorMessage || t('admin.uploadFailed'));
      setPreview(data.url);
      form.setFieldsValue({ [formKey]: data.url });
      // 上传端点不走 PUT /api/admin/settings，必须自己失效站点设置缓存，
      // 否则页面会拿着旧值继续展示「没有图标」。
      clearSiteTitleCache();
      message.success(successMsg);
    } catch (err: any) {
      message.error(err.message || t('admin.uploadFailed'));
    }
    return false;
  };

  const removeIcon = async (
    type: 'favicon' | 'logo',
    formKey: 'SITE_FAVICON' | 'SITE_LOGO',
    setPreview: (url: string) => void,
    successMsg: string,
  ) => {
    try {
      const res = await fetchWithAuth(`/api/admin/theme-image/${type}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.errorMessage || t('admin.deleteFailed'));
      }
      setPreview('');
      form.setFieldsValue({ [formKey]: '' });
      clearSiteTitleCache();
      message.success(successMsg);
    } catch (err: any) {
      message.error(err.message || t('admin.deleteFailed'));
    }
  };

  const handleUploadFavicon = (file: File) =>
    uploadIcon('favicon', file, 'SITE_FAVICON', setFaviconPreview, t('admin.faviconUploaded'));
  const handleRemoveFavicon = () =>
    removeIcon('favicon', 'SITE_FAVICON', setFaviconPreview, t('admin.faviconRemoved'));
  const handleUploadLogo = (file: File) =>
    uploadIcon('logo', file, 'SITE_LOGO', setLogoPreview, t('admin.logoUploaded'));
  const handleRemoveLogo = () =>
    removeIcon('logo', 'SITE_LOGO', setLogoPreview, t('admin.logoRemoved'));

  const handleSave = async (values: any) => {
    setLoading(true)
    try {
      const payload = {
        ...values,
        HOMEPAGE_BUTTONS: JSON.stringify(extraButtons),
        HOMEPAGE_CUSTOM_ENABLED: customEnabled,
        // 仅在开启时提交正文：关闭开关不该把已经写好的 HTML/CSS 抹掉，
        // 这样管理员可以随时切回自定义模式继续编辑
        ...(customEnabled
          ? { HOMEPAGE_CUSTOM_HTML: customHtml, HOMEPAGE_CUSTOM_CSS: customCss }
          : {}),
      }
      const res = await fetchWithAuth('/api/admin/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.errorMessage || t('common.operationFailed'))
      }
      clearSiteTitleCache()
      message.success(t('admin.siteSettingsSaved'))
      if (autoApply) {
        useSiteStore.getState().loadSettings()
      }
    } catch (err: any) {
      message.error(err.message || t('common.operationFailed'))
    } finally {
      setLoading(false)
    }
  }

  const addButton = () => {
    if (extraButtons.length >= 4) {
      message.warning(t('admin.maxButtonsWarning'))
      return
    }
    setExtraButtons([...extraButtons, { text: '', link: '' }])
  }

  const removeButton = (index: number) => {
    setExtraButtons(extraButtons.filter((_, i) => i !== index))
  }

  const updateButton = (index: number, field: keyof HomepageButton, value: string) => {
    const updated = [...extraButtons]
    updated[index][field] = value
    setExtraButtons(updated)
  }

  if (loadingSettings) {
    return <Card style={{ marginBottom: 16 }}><Spin /></Card>
  }

  return (
    <Card title={t('admin.siteSettings')} style={{ marginBottom: 16 }}>
      <Form form={form} layout="vertical" onFinish={handleSave}>
        {/* 总开关：关闭 → 原版选项；开启 → HTML/CSS 自定义 */}
        <Form.Item
          label={t('admin.customHomepage')}
          tooltip={t('admin.customHomepageTooltip')}
        >
          <Switch
            checked={customEnabled}
            onChange={setCustomEnabled}
            checkedChildren={t('common.on')}
            unCheckedChildren={t('common.off')}
          />
        </Form.Item>

        {customEnabled ? (
          <>
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 16 }}
              message={t('admin.customHomepageWarning')}
            />

            <Form.Item
              label={t('admin.customHomepageHtml')}
              tooltip={t('admin.customHomepageHtmlTooltip')}
            >
              <div className="custom-homepage-editor">
                <Editor
                  height="45vh"
                  language="html"
                  theme="vs-dark"
                  value={customHtml}
                  onChange={(value) => setCustomHtml(value || '')}
                  loading={
                    <div style={{ color: '#ccc', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#1e1e1e' }}>
                      {t('admin.loadingEditor')}
                    </div>
                  }
                  options={{
                    minimap: { enabled: false },
                    fontSize: 13,
                    lineNumbers: 'on',
                    roundedSelection: false,
                    scrollBeyondLastLine: false,
                    automaticLayout: true,
                    tabSize: 2,
                    wordWrap: 'on',
                    padding: { top: 12, bottom: 12 },
                    renderLineHighlight: 'all',
                  }}
                />
              </div>
            </Form.Item>

            <Form.Item
              label={t('admin.customHomepageCss')}
              tooltip={t('admin.customHomepageCssTooltip')}
            >
              <div className="custom-homepage-editor">
                <Editor
                  height="32vh"
                  language="css"
                  theme="vs-dark"
                  value={customCss}
                  onChange={(value) => setCustomCss(value || '')}
                  loading={
                    <div style={{ color: '#ccc', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#1e1e1e' }}>
                      {t('admin.loadingEditor')}
                    </div>
                  }
                  options={{
                    minimap: { enabled: false },
                    fontSize: 13,
                    lineNumbers: 'on',
                    roundedSelection: false,
                    scrollBeyondLastLine: false,
                    automaticLayout: true,
                    tabSize: 2,
                    wordWrap: 'on',
                    padding: { top: 12, bottom: 12 },
                    renderLineHighlight: 'all',
                  }}
                />
              </div>
            </Form.Item>
          </>
        ) : (
          <>
            <Form.Item
              label={t('admin.siteTitle')}
              name="SITE_TITLE"
              rules={[{ required: true, message: t('admin.pleaseEnterSiteTitle') }]}
            >
              <Input placeholder="CatTavernSkins" />
            </Form.Item>

            <Form.Item
              label={t('admin.siteDescription')}
              name="SITE_DESCRIPTION"
              rules={[{ required: true, message: t('admin.pleaseEnterSiteDescription') }]}
            >
              <TextArea rows={3} placeholder={t('admin.defaultSiteDescription')} />
            </Form.Item>

            <Form.Item
              label={t('admin.siteFavicon')}
              name="SITE_FAVICON"
              tooltip={t('admin.siteFaviconTooltip')}
            >
              <Input
                placeholder="/favicon.svg"
                addonAfter={
                  <Upload
                    accept=".svg,.png,.webp,.gif,.jpg,.jpeg,.ico"
                    showUploadList={false}
                    beforeUpload={handleUploadFavicon}
                  >
                    <UploadOutlined style={{ cursor: 'pointer' }} />
                  </Upload>
                }
              />
            </Form.Item>
            {faviconPreview && (
              <Form.Item label={t('admin.faviconPreview')}>
                <div style={{ position: 'relative', display: 'inline-block' }}>
                  <img
                    src={faviconPreview}
                    alt="favicon"
                    style={{ width: 48, height: 48, objectFit: 'contain', display: 'block' }}
                  />
                  <Button
                    type="primary"
                    danger
                    size="small"
                    style={{ position: 'absolute', top: -8, right: -8, zIndex: 10 }}
                    onClick={handleRemoveFavicon}
                  >
                    {t('common.remove')}
                  </Button>
                </div>
              </Form.Item>
            )}

            <Form.Item
              label={t('admin.siteLogo')}
              name="SITE_LOGO"
              tooltip={t('admin.siteLogoTooltip')}
            >
              <Input
                placeholder="/logo.png"
                addonAfter={
                  <Upload
                    accept=".svg,.png,.webp,.gif,.jpg,.jpeg,.ico"
                    showUploadList={false}
                    beforeUpload={handleUploadLogo}
                  >
                    <UploadOutlined style={{ cursor: 'pointer' }} />
                  </Upload>
                }
              />
            </Form.Item>
            {logoPreview && (
              <Form.Item label={t('admin.logoPreview')}>
                <div style={{ position: 'relative', display: 'inline-block' }}>
                  <img
                    src={logoPreview}
                    alt="logo"
                    style={{ maxWidth: 160, maxHeight: 48, display: 'block' }}
                  />
                  <Button
                    type="primary"
                    danger
                    size="small"
                    style={{ position: 'absolute', top: -8, right: -8, zIndex: 10 }}
                    onClick={handleRemoveLogo}
                  >
                    {t('common.remove')}
                  </Button>
                </div>
              </Form.Item>
            )}

            <Form.Item
              label={t('admin.homepageTitlePrefix')}
              name="HOMEPAGE_TITLE_TEXT"
              rules={[{ required: true, message: t('admin.pleaseEnterHomepageTitlePrefix') }]}
              tooltip={t('admin.homepageTitlePrefixTooltip')}
            >
              <Input placeholder={t('admin.welcomeTo')} />
            </Form.Item>

            <Form.Item
              label={t('admin.homepageSubtitle')}
              name="HOMEPAGE_TEXT"
              rules={[{ required: true, message: t('admin.pleaseEnterHomepageSubtitle') }]}
              tooltip={t('admin.homepageSubtitleTooltip')}
            >
              <Input placeholder="WELCOME TO SKIN2!" />
            </Form.Item>

            <Form.Item
              label={t('admin.homepageMainButton')}
              name="HOMEPAGE_BUTTON_TEXT"
              rules={[{ required: true, message: t('admin.pleaseEnterMainButtonText') }]}
              tooltip={t('admin.homepageMainButtonTooltip')}
            >
              <Input placeholder={t('admin.enterPersonalCenter')} />
            </Form.Item>

            <Form.Item label={t('admin.homepageExtraButtons')}>
              <div className="homepage-extra-buttons">
                <div style={{ marginBottom: 8, fontSize: 12, color: 'var(--text-subtle)' }}>
                  {t('admin.maxButtonsHint', { current: extraButtons.length })}
                </div>
                <Space direction="vertical" style={{ width: '100%' }}>
                {extraButtons.map((btn, idx) => (
                  <Card
                    key={idx}
                    size="small"
                    style={{ background: 'var(--bg-inner)', border: '1px solid var(--border-color)', boxShadow: 'none' }}
                    bodyStyle={{ padding: 12, background: 'transparent' }}
                  >
                    <Space direction="vertical" style={{ width: '100%' }}>
                      <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                        <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{t('admin.buttonNumber', { number: idx + 1 })}</span>
                        <Button
                          type="text"
                          danger
                          size="small"
                          icon={<MinusCircleOutlined />}
                          onClick={() => removeButton(idx)}
                        >
                          {t('common.delete')}
                        </Button>
                      </Space>
                      <Input
                        placeholder={t('admin.buttonText')}
                        value={btn.text}
                        onChange={(e) => updateButton(idx, 'text', e.target.value)}
                      />
                      <Input
                        placeholder={t('admin.buttonLink')}
                        value={btn.link}
                        onChange={(e) => updateButton(idx, 'link', e.target.value)}
                      />
                    </Space>
                  </Card>
                ))}
                {extraButtons.length < 4 && (
                  <div
                    className="admin-add-btn-square"
                    onClick={addButton}
                    title={t('admin.addButton')}
                  >
                    <PlusOutlined />
                  </div>
                )}
                </Space>
              </div>
            </Form.Item>
          </>
        )}

        <Form.Item>
          <Button type="primary" htmlType="submit" loading={loading}>
            {t('admin.saveSiteSettings')}
          </Button>
          <GlobalAutoApplySwitch checked={autoApply} onChange={onAutoApplyChange} />
        </Form.Item>
      </Form>
    </Card>
  )
}

/* ============================================================
   主题设置卡片（背景图 + 透明度）
   ============================================================ */
function ThemeSettings({ autoApply, onAutoApplyChange }: { autoApply: boolean; onAutoApplyChange: (v: boolean) => void }) {
  const { t } = useTranslation()
  const [form] = Form.useForm()
  const [loading, setLoading] = useState(false)
  const [loadingSettings, setLoadingSettings] = useState(true)
  const [lightBgPreview, setLightBgPreview] = useState<string>('');
  const [darkBgPreview, setDarkBgPreview] = useState<string>('');
  const [loginBgPreview, setLoginBgPreview] = useState<string>('');
  const [loginEmbedPreview, setLoginEmbedPreview] = useState<string>('');
  // 预览视频本地静音状态（覆盖全局设置，方便测试）
  const [previewMuted, setPreviewMuted] = useState<boolean>(true);
  // 从全局设置初始化预览静音状态
  const videoMutedGlobal = useSiteStore((s) => s.videoMuted);
  useEffect(() => {
    setPreviewMuted(videoMutedGlobal);
  }, [videoMutedGlobal]);

  const loadSettings = async () => {
    setLoadingSettings(true)
    try {
      const res = await fetchWithAuth('/api/admin/settings', {
      })
      if (!res.ok) throw new Error(t('admin.loadFailed'))
      const data = await res.json()
      form.setFieldsValue({
        LIGHT_BG_IMAGE: String(data.LIGHT_BG_IMAGE || ''),
        DARK_BG_IMAGE: String(data.DARK_BG_IMAGE || ''),
        LOGIN_BG_IMAGE: String(data.LOGIN_BG_IMAGE || ''),
        LOGIN_EMBED_IMAGE: String(data.LOGIN_EMBED_IMAGE || ''),
        VIDEO_MUTED: String(data.VIDEO_MUTED || 'true').toLowerCase() === 'true',
        LIGHT_BG_OVERLAY_OPACITY: parseInt(data.LIGHT_BG_OVERLAY_OPACITY) || 30,
        DARK_BG_OVERLAY_OPACITY: parseInt(data.DARK_BG_OVERLAY_OPACITY) || 30,
      })
      if (data.LIGHT_BG_IMAGE) {
        setLightBgPreview(data.LIGHT_BG_IMAGE);
      }
      if (data.DARK_BG_IMAGE) {
        setDarkBgPreview(data.DARK_BG_IMAGE);
      }
      if (data.LOGIN_BG_IMAGE) {
        setLoginBgPreview(data.LOGIN_BG_IMAGE);
      }
      if (data.LOGIN_EMBED_IMAGE) {
        setLoginEmbedPreview(data.LOGIN_EMBED_IMAGE);
      }
    } catch (err: any) {
      message.error(err.message || t('admin.loadSettingsFailed'))
    } finally {
      setLoadingSettings(false)
    }
  }

  useEffect(() => { loadSettings() }, [])

  const handleSave = async (values: any) => {
    setLoading(true)
    try {
      const payload = {
        LIGHT_BG_IMAGE: values.LIGHT_BG_IMAGE || '',
        DARK_BG_IMAGE: values.DARK_BG_IMAGE || '',
        LOGIN_BG_IMAGE: values.LOGIN_BG_IMAGE || '',
        LOGIN_EMBED_IMAGE: values.LOGIN_EMBED_IMAGE || '',
        VIDEO_MUTED: values.VIDEO_MUTED !== undefined ? String(values.VIDEO_MUTED) : 'true',
        LIGHT_BG_OVERLAY_OPACITY: values.LIGHT_BG_OVERLAY_OPACITY || 30,
        DARK_BG_OVERLAY_OPACITY: values.DARK_BG_OVERLAY_OPACITY || 30,
      }
      const res = await fetchWithAuth('/api/admin/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.errorMessage || t('common.saveFailed'))
      }
      message.success(t('admin.themeSettingsSaved'))
      clearSiteTitleCache()
      if (autoApply) {
        useSiteStore.getState().loadSettings()
      }
    } catch (err: any) {
      message.error(err.message || t('common.operationFailed'))
    } finally {
      setLoading(false)
    }
  }

  const handleUploadLightBg = async (file: File) => {
    const formData = new FormData();
    formData.append('image', file);
    try {
      const res = await fetchWithAuth('/api/admin/upload-theme-image?type=light-bg', {
        method: 'POST',
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.errorMessage || t('admin.uploadFailed'));
      setLightBgPreview(data.url);
      form.setFieldsValue({ LIGHT_BG_IMAGE: data.url });
      clearSiteTitleCache();
      message.success(t('admin.lightBgUploaded'));
    } catch (err: any) {
      message.error(err.message || t('admin.uploadFailed'));
    }
    return false;
  };

  const handleRemoveLightBg = async () => {
    try {
      const res = await fetchWithAuth('/api/admin/theme-image/light-bg', { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.errorMessage || t('admin.deleteFailed'));
      }
      setLightBgPreview('');
      form.setFieldsValue({ LIGHT_BG_IMAGE: '' });
      clearSiteTitleCache();
      message.success(t('admin.lightBgRemoved'));
    } catch (err: any) {
      message.error(err.message || t('admin.deleteFailed'));
    }
  };

  const handleUploadDarkBg = async (file: File) => {
    const formData = new FormData();
    formData.append('image', file);
    try {
      const res = await fetchWithAuth('/api/admin/upload-theme-image?type=dark-bg', {
        method: 'POST',
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.errorMessage || t('admin.uploadFailed'));
      setDarkBgPreview(data.url);
      form.setFieldsValue({ DARK_BG_IMAGE: data.url });
      clearSiteTitleCache();
      message.success(t('admin.darkBgUploaded'));
    } catch (err: any) {
      message.error(err.message || t('admin.uploadFailed'));
    }
    return false;
  };

  const handleRemoveDarkBg = async () => {
    try {
      const res = await fetchWithAuth('/api/admin/theme-image/dark-bg', { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.errorMessage || t('admin.deleteFailed'));
      }
      setDarkBgPreview('');
      form.setFieldsValue({ DARK_BG_IMAGE: '' });
      clearSiteTitleCache();
      message.success(t('admin.darkBgRemoved'));
    } catch (err: any) {
      message.error(err.message || t('admin.deleteFailed'));
    }
  };

  const handleUploadLoginBg = async (file: File) => {
    const formData = new FormData();
    formData.append('image', file);
    try {
      const res = await fetchWithAuth('/api/admin/upload-theme-image?type=login-bg', {
        method: 'POST',
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.errorMessage || t('admin.uploadFailed'));
      setLoginBgPreview(data.url);
      form.setFieldsValue({ LOGIN_BG_IMAGE: data.url });
      clearSiteTitleCache();
      message.success(t('admin.loginBgUploaded'));
    } catch (err: any) {
      message.error(err.message || t('admin.uploadFailed'));
    }
    return false;
  };

  const handleRemoveLoginBg = async () => {
    try {
      const res = await fetchWithAuth('/api/admin/theme-image/login-bg', { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.errorMessage || t('admin.deleteFailed'));
      }
      setLoginBgPreview('');
      form.setFieldsValue({ LOGIN_BG_IMAGE: '' });
      clearSiteTitleCache();
      message.success(t('admin.loginBgRemoved'));
    } catch (err: any) {
      message.error(err.message || t('admin.deleteFailed'));
    }
  };

  const handleUploadLoginEmbed = async (file: File) => {
    const formData = new FormData();
    formData.append('image', file);
    try {
      const res = await fetchWithAuth('/api/admin/upload-theme-image?type=login-embed', {
        method: 'POST',
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.errorMessage || t('admin.uploadFailed'));
      setLoginEmbedPreview(data.url);
      form.setFieldsValue({ LOGIN_EMBED_IMAGE: data.url });
      clearSiteTitleCache();
      message.success(t('admin.loginEmbedUploaded'));
    } catch (err: any) {
      message.error(err.message || t('admin.uploadFailed'));
    }
    return false;
  };

  const handleRemoveLoginEmbed = async () => {
    try {
      const res = await fetchWithAuth('/api/admin/theme-image/login-embed', { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.errorMessage || t('admin.deleteFailed'));
      }
      setLoginEmbedPreview('');
      form.setFieldsValue({ LOGIN_EMBED_IMAGE: '' });
      clearSiteTitleCache();
      message.success(t('admin.loginEmbedRemoved'));
    } catch (err: any) {
      message.error(err.message || t('admin.deleteFailed'));
    }
  };

  if (loadingSettings) {
    return <Card style={{ marginBottom: 16 }}><Spin /></Card>
  }

  return (
    <Card title={t('admin.themeSettings')} style={{ marginBottom: 16 }}>
      <Form form={form} layout="vertical" onFinish={handleSave}>
        {/* 亮色模式背景图 */}
        <Form.Item label={t('admin.lightModeBgImage')} name="LIGHT_BG_IMAGE" tooltip={t('admin.lightModeBgImageTooltip')}>
          <Input
            placeholder="https://example.com/light-bg.jpg"
            addonAfter={
              <Upload accept=".jpg,.jpeg,.png,.apng,.webp,.webm,.mp4" showUploadList={false} beforeUpload={handleUploadLightBg}>
                <UploadOutlined style={{ cursor: 'pointer' }} />
              </Upload>
            }
          />
        </Form.Item>

        {lightBgPreview && (
          <Form.Item label={t('admin.lightBgPreview')}>
            <div style={{ position: 'relative', width: '100%', height: 200, borderRadius: 8, overflow: 'hidden' }}>
              {isVideoFile(lightBgPreview) ? (
                <video
                  src={lightBgPreview}
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  autoPlay
                  loop
                  muted={previewMuted}
                  playsInline
                />
              ) : (
                <div style={{ width: '100%', height: '100%', backgroundImage: `url(${lightBgPreview})`, backgroundSize: 'cover', backgroundPosition: 'center' }} />
              )}
              <Button
                type="primary"
                danger
                size="small"
                style={{ position: 'absolute', top: 8, right: 8, zIndex: 10 }}
                onClick={handleRemoveLightBg}
              >
                {t('common.remove')}
              </Button>
              {isVideoFile(lightBgPreview) && (
                <Button
                  type="text"
                  shape="circle"
                  size="small"
                  onClick={(e) => { e.preventDefault(); setPreviewMuted(m => !m); }}
                  style={{
                    position: 'absolute',
                    bottom: 8,
                    right: 8,
                    background: 'rgba(0,0,0,0.55)',
                    border: '1px solid rgba(255,255,255,0.25)',
                    color: '#fff',
                    fontSize: 16,
                    width: 32,
                    height: 32,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: 0,
                  }}
                >
                  {previewMuted ? '🔇' : '🔊'}
                </Button>
              )}
            </div>
          </Form.Item>
        )}

        {/* 暗色模式背景图 */}
        <Form.Item label={t('admin.darkModeBgImage')} name="DARK_BG_IMAGE" tooltip={t('admin.darkModeBgImageTooltip')}>
          <Input
            placeholder="https://example.com/dark-bg.jpg"
            addonAfter={
              <Upload accept=".jpg,.jpeg,.png,.apng,.webp,.webm,.mp4" showUploadList={false} beforeUpload={handleUploadDarkBg}>
                <UploadOutlined style={{ cursor: 'pointer' }} />
              </Upload>
            }
          />
        </Form.Item>

        {darkBgPreview && (
          <Form.Item label={t('admin.darkBgPreview')}>
            <div style={{ position: 'relative', width: '100%', height: 200, borderRadius: 8, overflow: 'hidden' }}>
              {isVideoFile(darkBgPreview) ? (
                <video
                  src={darkBgPreview}
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  autoPlay
                  loop
                  muted={previewMuted}
                  playsInline
                />
              ) : (
                <div style={{ width: '100%', height: '100%', backgroundImage: `url(${darkBgPreview})`, backgroundSize: 'cover', backgroundPosition: 'center' }} />
              )}
              <Button
                type="primary"
                danger
                size="small"
                style={{ position: 'absolute', top: 8, right: 8, zIndex: 10 }}
                onClick={handleRemoveDarkBg}
              >
                {t('common.remove')}
              </Button>
              {isVideoFile(darkBgPreview) && (
                <Button
                  type="text"
                  shape="circle"
                  size="small"
                  onClick={(e) => { e.preventDefault(); setPreviewMuted(m => !m); }}
                  style={{
                    position: 'absolute',
                    bottom: 8,
                    right: 8,
                    background: 'rgba(0,0,0,0.55)',
                    border: '1px solid rgba(255,255,255,0.25)',
                    color: '#fff',
                    fontSize: 16,
                    width: 32,
                    height: 32,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: 0,
                  }}
                >
                  {previewMuted ? '🔇' : '🔊'}
                </Button>
              )}
            </div>
          </Form.Item>
        )}

        {/* 登录/注册页面背景图 */}
        <Form.Item label={t('admin.loginBgImage')} name="LOGIN_BG_IMAGE" tooltip={t('admin.loginBgImageTooltip')}>
          <Input
            placeholder="https://example.com/login-bg.jpg"
            addonAfter={
              <Upload accept=".jpg,.jpeg,.png,.apng,.webp,.webm,.mp4" showUploadList={false} beforeUpload={handleUploadLoginBg}>
                <UploadOutlined style={{ cursor: 'pointer' }} />
              </Upload>
            }
          />
        </Form.Item>

        {loginBgPreview && (
          <Form.Item label={t('admin.loginBgPreview')}>
            <div style={{ position: 'relative', width: '100%', height: 200, borderRadius: 8, overflow: 'hidden' }}>
              {isVideoFile(loginBgPreview) ? (
                <video
                  src={loginBgPreview}
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  autoPlay
                  loop
                  muted={previewMuted}
                  playsInline
                />
              ) : (
                <div style={{ width: '100%', height: '100%', backgroundImage: `url(${loginBgPreview})`, backgroundSize: 'cover', backgroundPosition: 'center' }} />
              )}
              <Button
                type="primary"
                danger
                size="small"
                style={{ position: 'absolute', top: 8, right: 8, zIndex: 10 }}
                onClick={handleRemoveLoginBg}
              >
                {t('common.remove')}
              </Button>
              {isVideoFile(loginBgPreview) && (
                <Button
                  type="text"
                  shape="circle"
                  size="small"
                  onClick={(e) => { e.preventDefault(); setPreviewMuted(m => !m); }}
                  style={{
                    position: 'absolute',
                    bottom: 8,
                    right: 8,
                    background: 'rgba(0,0,0,0.55)',
                    border: '1px solid rgba(255,255,255,0.25)',
                    color: '#fff',
                    fontSize: 16,
                    width: 32,
                    height: 32,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: 0,
                  }}
                >
                  {previewMuted ? '🔇' : '🔊'}
                </Button>
              )}
            </div>
          </Form.Item>
        )}

        {/* 登录/注册内嵌图片 */}
        <Form.Item label={t('admin.loginEmbedImage')} name="LOGIN_EMBED_IMAGE" tooltip={t('admin.loginEmbedImageTooltip')}>
          <Input
            placeholder="https://example.com/embed-image.png"
            addonAfter={
              <Upload accept=".jpg,.jpeg,.png,.apng,.webp,.webm,.mp4" showUploadList={false} beforeUpload={handleUploadLoginEmbed}>
                <UploadOutlined style={{ cursor: 'pointer' }} />
              </Upload>
            }
          />
        </Form.Item>

        {loginEmbedPreview && (
          <Form.Item label={t('admin.embedImagePreview')}>
            <div style={{ position: 'relative', width: '100%', height: 200, borderRadius: 8, overflow: 'hidden' }}>
              {isVideoFile(loginEmbedPreview) ? (
                <video
                  src={loginEmbedPreview}
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  autoPlay
                  loop
                  muted={previewMuted}
                  playsInline
                />
              ) : (
                <div style={{ width: '100%', height: '100%', backgroundImage: `url(${loginEmbedPreview})`, backgroundSize: 'cover', backgroundPosition: 'center' }} />
              )}
              <Button
                type="primary"
                danger
                size="small"
                style={{ position: 'absolute', top: 8, right: 8, zIndex: 10 }}
                onClick={handleRemoveLoginEmbed}
              >
                {t('common.remove')}
              </Button>
              {isVideoFile(loginEmbedPreview) && (
                <Button
                  type="text"
                  shape="circle"
                  size="small"
                  onClick={(e) => { e.preventDefault(); setPreviewMuted(m => !m); }}
                  style={{
                    position: 'absolute',
                    bottom: 8,
                    right: 8,
                    background: 'rgba(0,0,0,0.55)',
                    border: '1px solid rgba(255,255,255,0.25)',
                    color: '#fff',
                    fontSize: 16,
                    width: 32,
                    height: 32,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: 0,
                  }}
                >
                  {previewMuted ? '🔇' : '🔊'}
                </Button>
              )}
            </div>
          </Form.Item>
        )}

        {/* WebM 视频静音 */}
        <Form.Item label={t('admin.videoMuted')} name="VIDEO_MUTED" valuePropName="checked" tooltip={t('admin.videoMutedTooltip')}>
          <Switch checkedChildren={t('admin.muted')} unCheckedChildren={t('admin.soundOn')} />
        </Form.Item>

        {/* 亮色蒙版透明度 */}
        <Form.Item label={t('admin.lightOverlayOpacity')} name="LIGHT_BG_OVERLAY_OPACITY" tooltip={t('admin.lightOverlayOpacityTooltip')}>
          <Slider min={0} max={100} marks={{ 0: '0%', 50: '50%', 100: '100%' }} />
        </Form.Item>

        {/* 暗色蒙版透明度 */}
        <Form.Item label={t('admin.darkOverlayOpacity')} name="DARK_BG_OVERLAY_OPACITY" tooltip={t('admin.darkOverlayOpacityTooltip')}>
          <Slider min={0} max={100} marks={{ 0: '0%', 50: '50%', 100: '100%' }} />
        </Form.Item>

        <Form.Item>
          <Button type="primary" htmlType="submit" loading={loading}>
            {t('admin.saveThemeSettings')}
          </Button>
          <GlobalAutoApplySwitch checked={autoApply} onChange={onAutoApplyChange} />
        </Form.Item>
      </Form>
    </Card>
  )
}

/* ============================================================
   邮箱设置卡片
   ============================================================ */
function EmailSettings({ autoApply, onAutoApplyChange }: { autoApply: boolean; onAutoApplyChange: (v: boolean) => void }) {
  const { t } = useTranslation()
  const [form] = Form.useForm()
  const [loading, setLoading] = useState(false)
  const [loadingSettings, setLoadingSettings] = useState(true)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null)
  /** 库里是否已有 SMTP 密码（后端只回传该布尔，不回传密文） */
  const [smtpPassSet, setSmtpPassSet] = useState(false)

  // 邮件模板弹窗
  const [templateModalVisible, setTemplateModalVisible] = useState(false)
  const [templateSubject, setTemplateSubject] = useState('')
  const [templateHtml, setTemplateHtml] = useState('')
  const [savingTemplate, setSavingTemplate] = useState(false)
  const [loadingTemplate, setLoadingTemplate] = useState(false)

  const loadSettings = async () => {
    setLoadingSettings(true)
    try {
      const res = await fetchWithAuth('/api/admin/settings', {
      })
      if (!res.ok) throw new Error(t('admin.loadFailed'))
      const data = await res.json()
      form.setFieldsValue({
        // 未设置时用「管理员当前访问的地址」而不是写死 localhost:3000：
        // BASE_URL 是邮件链接的权威来源，若这里默认成 localhost，管理员填完 SMTP
        // 直接保存，就会把线上站点的验证链接永久写成 http://localhost:3000。
        BASE_URL: String(data.BASE_URL || window.location.origin),
        SMTP_HOST: String(data.SMTP_HOST || ''),
        SMTP_PORT: parseInt(data.SMTP_PORT) || 587,
        // 同上：Switch 存的是布尔，不能跟字符串比较
        SMTP_SECURE: settingBool(data.SMTP_SECURE, false),
        SMTP_USER: String(data.SMTP_USER || ''),
        // 后端永不回传密文，只给 SMTP_PASS_SET 标志；留空即「不修改」
        SMTP_PASS: '',
        SMTP_FROM: String(data.SMTP_FROM || ''),
        SMTP_FROM_NAME: String(data.SMTP_FROM_NAME || ''),
      })
      setSmtpPassSet(data.SMTP_PASS_SET === true)
    } catch (err: any) {
      message.error(err.message || t('admin.loadSettingsFailed'))
    } finally {
      setLoadingSettings(false)
    }
  }

  useEffect(() => { loadSettings() }, [])

  const handleSave = async (values: any) => {
    setLoading(true)
    setTestResult(null)
    try {
      const payload: any = { ...values }
      if (!payload.SMTP_PASS) {
        delete payload.SMTP_PASS
      }

      const res = await fetchWithAuth('/api/admin/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.errorMessage || t('common.saveFailed'))
      }
      message.success(t('admin.emailSettingsSaved'))
      loadSettings()
      if (autoApply) {
        useSiteStore.getState().loadSettings()
      }
    } catch (err: any) {
      message.error(err.message || t('common.operationFailed'))
    } finally {
      setLoading(false)
    }
  }

  // 测试 SMTP 连接
  const handleTestSmtp = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const res = await fetchWithAuth('/api/admin/test-smtp', {
        method: 'POST',
      })
      const data = await res.json()
      setTestResult({ success: data.success, message: data.message || data.error || t('common.unknownError') })
      if (data.success) {
        message.success(data.message || t('admin.smtpConnected'))
      } else {
        message.error(data.error || t('admin.smtpFailed'))
      }
    } catch (err: any) {
        setTestResult({ success: false, message: err.message || t('common.requestFailed') })
        message.error(err.message || t('common.requestFailed'))
    } finally {
      setTesting(false)
    }
  }

  // 加载邮件模板
  const loadTemplate = async () => {
    setLoadingTemplate(true)
    try {
      const res = await fetchWithAuth('/api/admin/email-template', {
      })
      const data = await res.json()
      setTemplateSubject(data.subject || '')
      setTemplateHtml(data.html || '')
    } catch (err: any) {
      message.error(t('admin.loadEmailTemplateFailed'))
    } finally {
      setLoadingTemplate(false)
    }
  }

  // 打开模板编辑弹窗
  const openTemplateModal = () => {
    loadTemplate()
    setTemplateModalVisible(true)
  }

  // 保存邮件模板
  const handleSaveTemplate = async () => {
    if (!templateSubject.trim()) {
      message.error(t('admin.emailSubjectRequired'))
      return
    }
    if (!templateHtml.trim()) {
      message.error(t('admin.emailContentRequired'))
      return
    }
    setSavingTemplate(true)
    try {
      const res = await fetchWithAuth('/api/admin/email-template', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject: templateSubject, html: templateHtml }),
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.errorMessage || t('common.saveFailed'))
      }
      message.success(t('admin.emailTemplateSaved'))
      setTemplateModalVisible(false)
    } catch (err: any) {
      message.error(err.message || t('common.operationFailed'))
    } finally {
      setSavingTemplate(false)
    }
  }

  // 重置模板为默认
  const handleResetTemplate = () => {
    const emailVar = '{{EMAIL}}';
    const verifyUrlVar = '{{VERIFY_URL}}';
    const yearVar = '{{YEAR}}';
    // 与后端 templates.ts 的 SITE_LOGO_IMG 同语义：未设置徽标时为空串，不渲染破图
    const logoImgVar = '{{SITE_LOGO_IMG}}';
    setTemplateHtml(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <title>${t('admin.emailVerificationTitle')}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0d1117; color: #c9d1d9; margin: 0; padding: 20px; }
    .container { max-width: 480px; margin: 40px auto; background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 32px; }
    .header { text-align: center; margin-bottom: 24px; }
    .header h1 { margin: 0; font-size: 20px; color: #58a6ff; }
    .btn { display: inline-block; padding: 12px 28px; background: #238636; color: #fff; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 15px; }
    .btn:hover { background: #2ea043; }
    .footer { margin-top: 24px; font-size: 12px; color: #8b949e; text-align: center; }
    .code { background: #0d1117; border: 1px solid #30363d; border-radius: 6px; padding: 12px; font-family: monospace; font-size: 13px; word-break: break-all; color: #58a6ff; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      ${logoImgVar}
      <h1>🎮 Minecraft Skin Server</h1>
    </div>
    <p>${t('admin.emailTemplateHello')} ${emailVar}，</p>
    <p>${t('admin.emailTemplateVerificationRequest')}</p>
    <p style="text-align:center; margin: 28px 0;">
      <a href="${verifyUrlVar}" class="btn">${t('admin.emailTemplateVerifyButton')}</a>
    </p>
    <p>${t('admin.emailTemplateOrCopy')}</p>
    <div class="code">${verifyUrlVar}</div>
    <p style="font-size:13px;color:#8b949e;margin-top:20px;">${t('admin.emailTemplateLinkValid')}</p>
    <div class="footer">Minecraft Skin Server &copy; ${yearVar}</div>
  </div>
</body>
</html>`)
    setTemplateSubject(t('admin.defaultEmailSubject'))
    message.info(t('admin.templateResetToDefault'))
  }

  if (loadingSettings) {
    return <Card style={{ marginBottom: 16 }}><Spin /></Card>
  }

  return (
    <>
      <Card title={t('admin.emailSettings')} style={{ marginBottom: 16 }}>
        <Form form={form} layout="vertical" onFinish={handleSave}>
          <Form.Item
            label={t('admin.siteUrl')}
            name="BASE_URL"
            rules={[{ required: true, message: t('admin.pleaseEnterSiteUrl') }]}
            tooltip={t('admin.siteUrlTooltip')}
          >
            <Input placeholder="https://skin.example.com" />
          </Form.Item>

          <Form.Item
            label={t('admin.smtpHost')}
            name="SMTP_HOST"
            rules={[{ required: true, message: t('admin.pleaseEnterSmtpHost') }]}
          >
            <Input placeholder="smtp.163.com" />
          </Form.Item>

          <Form.Item
            label={t('admin.smtpPort')}
            name="SMTP_PORT"
            rules={[{ required: true, message: t('admin.pleaseEnterSmtpPort') }]}
          >
            <Input type="number" placeholder="465 或 587" />
          </Form.Item>

          <Form.Item
            label={t('admin.smtpSecure')}
            name="SMTP_SECURE"
            valuePropName="checked"
          >
            <Switch checkedChildren={t('common.yes')} unCheckedChildren={t('common.no')} />
          </Form.Item>

          <Form.Item
            label={t('admin.smtpUser')}
            name="SMTP_USER"
            rules={[{ required: true, message: t('admin.pleaseEnterSmtpUser') }]}
            tooltip={t('admin.smtpUserTooltip')}
          >
            <Input placeholder="your_email@163.com" />
          </Form.Item>

          <Form.Item
            label={t('admin.smtpPass')}
            name="SMTP_PASS"
            tooltip={t('admin.smtpPassTooltip')}
            extra={
              // 密码以密文入库、永不回显，所以必须明确告诉管理员「已保存」，
              // 否则输入框看着是空的，他会以为没存上而反复重填
              smtpPassSet ? t('admin.smtpPassSavedHint') : undefined
            }
          >
            <Input.Password
              placeholder={
                smtpPassSet
                  ? t('admin.smtpPassPlaceholderSaved')
                  : t('admin.smtpPassPlaceholder')
              }
            />
          </Form.Item>

          <Form.Item
            label={t('admin.smtpFrom')}
            name="SMTP_FROM"
            rules={[{ required: true, message: t('admin.pleaseEnterSmtpFrom') }]}
            tooltip={t('admin.smtpFromTooltip')}
          >
            <Input placeholder="noreply@example.com" />
          </Form.Item>

          <Form.Item
            label={t('admin.smtpFromName')}
            name="SMTP_FROM_NAME"
            tooltip={t('admin.smtpFromNameTooltip')}
          >
            <Input placeholder="Minecraft Skin Server" />
          </Form.Item>

          <Form.Item>
            <Button
              icon={<SendOutlined />}
              onClick={handleTestSmtp}
              loading={testing}
            >
              {t('admin.testSmtpConnection')}
            </Button>
            {testResult && (
              <span style={{
                marginLeft: 12,
                color: testResult.success ? '#52c41a' : '#ff4d4f',
                fontSize: 13,
              }}>
                {testResult.success ? '✅ ' : '❌ '}{testResult.message}
              </span>
            )}
          </Form.Item>

          <Form.Item label={t('admin.verificationEmailTemplate')}>
            <Button
              icon={<EditOutlined />}
              onClick={openTemplateModal}
              loading={loadingTemplate}
            >
              {t('admin.editEmailTemplate')}
            </Button>
            <div style={{ marginTop: 4, fontSize: 12, color: 'var(--text-subtle)' }}>
              {t('admin.templatePlaceholders')}<code style={{ background: '#1e3a5f', color: '#58a6ff', padding: '2px 6px', borderRadius: 4, fontSize: 12 }}>{'{{EMAIL}}'}</code>、<code style={{ background: '#1e3a5f', color: '#58a6ff', padding: '2px 6px', borderRadius: 4, fontSize: 12 }}>{'{{VERIFY_URL}}'}</code>、<code style={{ background: '#1e3a5f', color: '#58a6ff', padding: '2px 6px', borderRadius: 4, fontSize: 12 }}>{'{{YEAR}}'}</code>
            </div>
          </Form.Item>

          <Form.Item>
            <Button type="primary" htmlType="submit" loading={loading}>
              {t('admin.saveEmailSettings')}
            </Button>
            <Button style={{ marginLeft: 10 }} onClick={() => form.resetFields()}>
              {t('common.reset')}
            </Button>
            <GlobalAutoApplySwitch checked={autoApply} onChange={onAutoApplyChange} />
          </Form.Item>
        </Form>
      </Card>

      {/* 邮件模板编辑弹窗 */}
      <Modal
        title={
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', paddingRight: 16 }}>
            <span style={{ color: '#cccccc', fontWeight: 500 }}>{t('admin.editEmailTemplate')}</span>
            <CloseOutlined
              onClick={() => setTemplateModalVisible(false)}
              style={{ color: '#cccccc', fontSize: 16, cursor: 'pointer', padding: 4, borderRadius: 4 }}
              onMouseEnter={(e) => { (e.target as HTMLElement).style.backgroundColor = '#3c3c3c'; }}
              onMouseLeave={(e) => { (e.target as HTMLElement).style.backgroundColor = 'transparent'; }}
            />
          </div>
        }
        open={templateModalVisible}
        onCancel={() => setTemplateModalVisible(false)}
        width={800}
        closable={false}
        styles={{
          header: { backgroundColor: '#252526', borderBottom: '1px solid #3c3c3c', padding: '12px 24px' },
          body: { padding: 0, backgroundColor: 'transparent' },
          content: { backgroundColor: '#1e1e1e' },
          footer: { backgroundColor: '#252526', borderTop: '1px solid #3c3c3c', padding: '12px 24px' },
        }}
        footer={[
          <Button key="reset" onClick={handleResetTemplate} style={{ borderColor: '#3c3c3c', color: '#cccccc' }}>
            {t('admin.resetToDefault')}
          </Button>,
          <Button key="cancel" onClick={() => setTemplateModalVisible(false)} style={{ borderColor: '#3c3c3c', color: '#cccccc' }}>
            {t('common.cancel')}
          </Button>,
          <Button key="save" type="primary" loading={savingTemplate} onClick={handleSaveTemplate}>
            {t('admin.saveTemplate')}
          </Button>,
        ]}
      >
        <div style={{ marginBottom: 16 }}>
          <div style={{ marginBottom: 4, fontSize: 13, color: 'var(--text-secondary)' }}>{t('admin.emailSubject')}</div>
          <Input
            value={templateSubject}
            onChange={(e) => setTemplateSubject(e.target.value)}
            placeholder={t('admin.emailSubjectPlaceholder')}
          />
        </div>
        <div style={{ marginBottom: 8, fontSize: 13, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <span>{t('admin.emailContentHtml')}</span>
          <span style={{ fontSize: 12, color: 'var(--text-subtle)' }}>{t('admin.availablePlaceholders')}</span>
          <span style={{ fontSize: 12, fontFamily: 'monospace', background: '#1e3a5f', color: '#58a6ff', padding: '2px 8px', borderRadius: 4, border: '1px solid #1f6feb' }}>{'{{EMAIL}}'}</span>
          <span style={{ fontSize: 12, color: 'var(--text-subtle)' }}>= {t('admin.placeholderEmail')}</span>
          <span style={{ fontSize: 12, fontFamily: 'monospace', background: '#1e3a5f', color: '#58a6ff', padding: '2px 8px', borderRadius: 4, border: '1px solid #1f6feb' }}>{'{{VERIFY_URL}}'}</span>
          <span style={{ fontSize: 12, color: 'var(--text-subtle)' }}>= {t('admin.placeholderVerifyUrl')}</span>
          <span style={{ fontSize: 12, fontFamily: 'monospace', background: '#1e3a5f', color: '#58a6ff', padding: '2px 8px', borderRadius: 4, border: '1px solid #1f6feb' }}>{'{{YEAR}}'}</span>
          <span style={{ fontSize: 12, color: 'var(--text-subtle)' }}>= {t('admin.placeholderYear')}</span>
          <span style={{ fontSize: 12, fontFamily: 'monospace', background: '#1e3a5f', color: '#58a6ff', padding: '2px 8px', borderRadius: 4, border: '1px solid #1f6feb' }}>{'{{SITE_LOGO_IMG}}'}</span>
          <span style={{ fontSize: 12, color: 'var(--text-subtle)' }}>= {t('admin.placeholderSiteLogoImg')}</span>
        </div>
        <div style={{ borderRadius: 8, overflow: 'hidden', border: '1px solid #30363d' }}>
          <Editor
            height="55vh"
            language="html"
            theme="vs-dark"
            value={templateHtml}
            onChange={(value) => setTemplateHtml(value || '')}
            loading={
              <div style={{ color: '#ccc', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#1e1e1e' }}>
                {t('admin.loadingEditor')}
              </div>
            }
            options={{
              minimap: { enabled: false },
              fontSize: 13,
              lineNumbers: 'on',
              roundedSelection: false,
              scrollBeyondLastLine: false,
              automaticLayout: true,
              tabSize: 2,
              wordWrap: 'on',
              padding: { top: 12, bottom: 12 },
              renderLineHighlight: 'all',
            }}
          />
        </div>
      </Modal>
    </>
  )
}

/* ============================================================
   版权设置卡片
   ============================================================ */
function CopyrightSettings({ autoApply, onAutoApplyChange }: { autoApply: boolean; onAutoApplyChange: (v: boolean) => void }) {
  const { t } = useTranslation()
  const [form] = Form.useForm()
  const [loading, setLoading] = useState(false)
  const [loadingSettings, setLoadingSettings] = useState(true)

  const loadSettings = async () => {
    setLoadingSettings(true)
    try {
      const res = await fetchWithAuth('/api/admin/settings', {
      })
      if (!res.ok) throw new Error(t('admin.loadFailed'))
      const data = await res.json()
      form.setFieldsValue({
        COPYRIGHT_TEXT: data.COPYRIGHT_TEXT || '© 2024 Minecraft Skin Server',
        COPYRIGHT_BEIAN: data.COPYRIGHT_BEIAN || '',
      })
    } catch (err: any) {
      message.error(err.message || t('admin.loadSettingsFailed'))
    } finally {
      setLoadingSettings(false)
    }
  }

  useEffect(() => { loadSettings() }, [])

  const handleSave = async (values: any) => {
    setLoading(true)
    try {
      const payload = {
        COPYRIGHT_TEXT: values.COPYRIGHT_TEXT || '',
        COPYRIGHT_BEIAN: values.COPYRIGHT_BEIAN || '',
      }
      const res = await fetchWithAuth('/api/admin/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.errorMessage || t('common.saveFailed'))
      }
      message.success(t('admin.copyrightSettingsSaved'))
      if (autoApply) {
        useSiteStore.getState().loadSettings()
      }
    } catch (err: any) {
      message.error(err.message || t('common.operationFailed'))
    } finally {
      setLoading(false)
    }
  }

  if (loadingSettings) {
    return <Card style={{ marginBottom: 16 }}><Spin /></Card>
  }

  return (
    <Card title={t('admin.copyrightSettings')} style={{ marginBottom: 16 }}>
      <Form form={form} layout="vertical" onFinish={handleSave}>
        <Form.Item
          label={t('admin.customCopyright')}
          name="COPYRIGHT_TEXT"
          rules={[{ required: true, message: t('admin.pleaseEnterCopyright') }]}
          tooltip={t('admin.customCopyrightTooltip')}
        >
          <Input placeholder={t('admin.copyrightPlaceholder')} />
        </Form.Item>

        <Form.Item
          label={t('admin.beianInfo')}
          name="COPYRIGHT_BEIAN"
          tooltip={t('admin.beianInfoTooltip')}
        >
          <Input placeholder={t('admin.beianPlaceholder')} />
        </Form.Item>

        <Form.Item>
          <div style={{ 
            fontSize: 13, 
            color: '#faad14', 
            lineHeight: 1.8,
            background: 'rgba(250,173,20,0.1)',
            border: '1px solid rgba(250,173,20,0.3)',
            borderRadius: 8,
            padding: '12px 16px',
          }}>
            ⚠️ <strong>{t('admin.copyrightWarningTitle')}</strong>
            <br />
            {t('admin.copyrightWarning1')}<code style={{ background: '#1e3a5f', color: '#58a6ff', padding: '2px 6px', borderRadius: 4, fontSize: 12 }}>Powered by MCSkinToServer</code>
            <br />
            {t('admin.copyrightWarning2')}
            <br />
            {t('admin.copyrightWarning3')}
          </div>
        </Form.Item>

        <Form.Item>
          <Button type="primary" htmlType="submit" loading={loading}>
            {t('admin.saveCopyrightSettings')}
          </Button>
          <GlobalAutoApplySwitch checked={autoApply} onChange={onAutoApplyChange} />
        </Form.Item>
      </Form>
    </Card>
  )
}

/* ============================================================
   主组件
   ============================================================ */
export function SystemSettings() {
  const { t } = useTranslation()
  const { token } = useAuthStore()
  const [autoApply, setAutoApply] = useState(() => {
    try {
      return localStorage.getItem('admin_auto_apply') !== 'false'
    } catch {
      return true
    }
  })

  const handleAutoApplyChange = (checked: boolean) => {
    setAutoApply(checked)
    try {
      localStorage.setItem('admin_auto_apply', String(checked))
    } catch {}
  }

  if (!token) {
    return <div style={{ padding: 40, textAlign: 'center' }}><Spin size="large" /></div>
  }

  return (
    <div>
      <h2>{t('admin.systemSettings')}</h2>
      <RegistrationSettings autoApply={autoApply} onAutoApplyChange={handleAutoApplyChange} />
      <SiteSettings autoApply={autoApply} onAutoApplyChange={handleAutoApplyChange} />
      <ThemeSettings autoApply={autoApply} onAutoApplyChange={handleAutoApplyChange} />
      <EmailSettings autoApply={autoApply} onAutoApplyChange={handleAutoApplyChange} />
      <CopyrightSettings autoApply={autoApply} onAutoApplyChange={handleAutoApplyChange} />
    </div>
  )
}
