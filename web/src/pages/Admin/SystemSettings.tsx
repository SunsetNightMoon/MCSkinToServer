import { useState, useEffect } from 'react'
import { useAuthStore } from '../../store/authStore'
import { useSiteStore } from '../../store/siteStore'
import { clearSiteTitleCache } from '../../hooks/usePageTitle'
import { fetchWithAuth } from '../../utils/api'
import { Form, Input, Switch, Button, message, Card, Spin, Modal, Upload, Space, Slider } from 'antd'
import { SendOutlined, EditOutlined, CloseOutlined, UploadOutlined, PlusOutlined, MinusCircleOutlined } from '@ant-design/icons'
import Editor from '@monaco-editor/react'
import './SystemSettings.css'
import { isVideoFile } from '../../utils/media'
import { useTranslation } from 'react-i18next'

const { TextArea } = Input

interface HomepageButton {
  text: string
  link: string
}

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
      form.setFieldsValue({
        allow_registration: data.ALLOW_REGISTRATION !== 'false',
        require_email_verification: data.REQUIRE_EMAIL_VERIFICATION === 'true',
        enable_captcha: data.ENABLE_CAPTCHA !== 'false',
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
          name="allow_registration"
          valuePropName="checked"
          tooltip={t('admin.allowRegistrationTooltip')}
        >
          <Switch checkedChildren={t('common.on')} unCheckedChildren={t('common.off')} />
        </Form.Item>

        <Form.Item
          label={t('admin.requireEmailVerification')}
          name="require_email_verification"
          valuePropName="checked"
          tooltip={t('admin.requireEmailVerificationTooltip')}
        >
          <Switch checkedChildren={t('common.on')} unCheckedChildren={t('common.off')} />
        </Form.Item>

        <Form.Item
          label={t('admin.enableCaptcha')}
          name="enable_captcha"
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

  const loadSettings = async () => {
    setLoadingSettings(true)
    try {
      const res = await fetchWithAuth('/api/admin/settings', {
      })
      if (!res.ok) throw new Error(t('admin.loadFailed'))
      const data = await res.json()
      const buttons: HomepageButton[] = (() => {
        try {
          const parsed = JSON.parse(data.HOMEPAGE_BUTTONS || '[]')
          return Array.isArray(parsed) ? parsed : []
        } catch {
          return []
        }
      })()
      setExtraButtons(buttons)
      form.setFieldsValue({
        site_title: String(data.SITE_TITLE || t('landing.welcomePrefix')),
        site_description: String(data.SITE_DESCRIPTION || t('admin.defaultSiteDescription')),
        site_favicon: String(data.SITE_FAVICON || '/favicon.svg'),
        homepage_title_text: String(data.HOMEPAGE_TITLE_TEXT || t('landing.welcomePrefix')),
        homepage_text: String(data.HOMEPAGE_TEXT || t('landing.welcomeText')),
        homepage_button_text: String(data.HOMEPAGE_BUTTON_TEXT || t('landing.enterProfile')),
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
        ...values,
        homepage_buttons: JSON.stringify(extraButtons),
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
        <Form.Item
          label={t('admin.siteTitle')}
          name="site_title"
          rules={[{ required: true, message: t('admin.pleaseEnterSiteTitle') }]}
        >
          <Input placeholder="CatTavernSkins" />
        </Form.Item>

        <Form.Item
          label={t('admin.siteDescription')}
          name="site_description"
          rules={[{ required: true, message: t('admin.pleaseEnterSiteDescription') }]}
        >
          <TextArea rows={3} placeholder={t('admin.defaultSiteDescription')} />
        </Form.Item>

        <Form.Item
          label={t('admin.siteFavicon')}
          name="site_favicon"
        >
          <Input placeholder="/favicon.svg" />
        </Form.Item>

        <Form.Item
          label={t('admin.homepageTitlePrefix')}
          name="homepage_title_text"
          rules={[{ required: true, message: t('admin.pleaseEnterHomepageTitlePrefix') }]}
          tooltip={t('admin.homepageTitlePrefixTooltip')}
        >
          <Input placeholder={t('admin.welcomeTo')} />
        </Form.Item>

        <Form.Item
          label={t('admin.homepageSubtitle')}
          name="homepage_text"
          rules={[{ required: true, message: t('admin.pleaseEnterHomepageSubtitle') }]}
          tooltip={t('admin.homepageSubtitleTooltip')}
        >
          <Input placeholder="WELCOME TO SKIN2!" />
        </Form.Item>

        <Form.Item
          label={t('admin.homepageMainButton')}
          name="homepage_button_text"
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
        light_bg_image: String(data.LIGHT_BG_IMAGE || ''),
        dark_bg_image: String(data.DARK_BG_IMAGE || ''),
        login_bg_image: String(data.LOGIN_BG_IMAGE || ''),
        login_embed_image: String(data.LOGIN_EMBED_IMAGE || ''),
        video_muted: String(data.VIDEO_MUTED || 'true').toLowerCase() === 'true',
        light_bg_overlay_opacity: parseInt(data.LIGHT_BG_OVERLAY_OPACITY) || 30,
        dark_bg_overlay_opacity: parseInt(data.DARK_BG_OVERLAY_OPACITY) || 30,
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
        light_bg_image: values.light_bg_image || '',
        dark_bg_image: values.dark_bg_image || '',
        login_bg_image: values.login_bg_image || '',
        login_embed_image: values.login_embed_image || '',
        video_muted: values.video_muted !== undefined ? String(values.video_muted) : 'true',
        light_bg_overlay_opacity: values.light_bg_overlay_opacity || 30,
        dark_bg_overlay_opacity: values.dark_bg_overlay_opacity || 30,
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
      form.setFieldsValue({ light_bg_image: data.url });
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
      form.setFieldsValue({ light_bg_image: '' });
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
      form.setFieldsValue({ dark_bg_image: data.url });
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
      form.setFieldsValue({ dark_bg_image: '' });
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
      form.setFieldsValue({ login_bg_image: data.url });
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
      form.setFieldsValue({ login_bg_image: '' });
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
      form.setFieldsValue({ login_embed_image: data.url });
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
      form.setFieldsValue({ login_embed_image: '' });
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
        <Form.Item label={t('admin.lightModeBgImage')} name="light_bg_image" tooltip={t('admin.lightModeBgImageTooltip')}>
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
        <Form.Item label={t('admin.darkModeBgImage')} name="dark_bg_image" tooltip={t('admin.darkModeBgImageTooltip')}>
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
        <Form.Item label={t('admin.loginBgImage')} name="login_bg_image" tooltip={t('admin.loginBgImageTooltip')}>
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
        <Form.Item label={t('admin.loginEmbedImage')} name="login_embed_image" tooltip={t('admin.loginEmbedImageTooltip')}>
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
        <Form.Item label={t('admin.videoMuted')} name="video_muted" valuePropName="checked" tooltip={t('admin.videoMutedTooltip')}>
          <Switch checkedChildren={t('admin.muted')} unCheckedChildren={t('admin.soundOn')} />
        </Form.Item>

        {/* 亮色蒙版透明度 */}
        <Form.Item label={t('admin.lightOverlayOpacity')} name="light_bg_overlay_opacity" tooltip={t('admin.lightOverlayOpacityTooltip')}>
          <Slider min={0} max={100} marks={{ 0: '0%', 50: '50%', 100: '100%' }} />
        </Form.Item>

        {/* 暗色蒙版透明度 */}
        <Form.Item label={t('admin.darkOverlayOpacity')} name="dark_bg_overlay_opacity" tooltip={t('admin.darkOverlayOpacityTooltip')}>
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
        base_url: String(data.BASE_URL || 'http://localhost:3000'),
        smtp_host: String(data.SMTP_HOST || ''),
        smtp_port: parseInt(data.SMTP_PORT) || 587,
        smtp_secure: data.SMTP_SECURE === 'true',
        smtp_user: String(data.SMTP_USER || ''),
        smtp_pass: '',
        smtp_from: String(data.SMTP_FROM || ''),
        smtp_from_name: String(data.SMTP_FROM_NAME || ''),
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
    setTestResult(null)
    try {
      const payload: any = { ...values }
      if (!payload.smtp_pass) {
        delete payload.smtp_pass
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
            name="base_url"
            rules={[{ required: true, message: t('admin.pleaseEnterSiteUrl') }]}
            tooltip={t('admin.siteUrlTooltip')}
          >
            <Input placeholder="https://skin.example.com" />
          </Form.Item>

          <Form.Item
            label={t('admin.smtpHost')}
            name="smtp_host"
            rules={[{ required: true, message: t('admin.pleaseEnterSmtpHost') }]}
          >
            <Input placeholder="smtp.163.com" />
          </Form.Item>

          <Form.Item
            label={t('admin.smtpPort')}
            name="smtp_port"
            rules={[{ required: true, message: t('admin.pleaseEnterSmtpPort') }]}
          >
            <Input type="number" placeholder="465 或 587" />
          </Form.Item>

          <Form.Item
            label={t('admin.smtpSecure')}
            name="smtp_secure"
            valuePropName="checked"
          >
            <Switch checkedChildren={t('common.yes')} unCheckedChildren={t('common.no')} />
          </Form.Item>

          <Form.Item
            label={t('admin.smtpUser')}
            name="smtp_user"
            rules={[{ required: true, message: t('admin.pleaseEnterSmtpUser') }]}
            tooltip={t('admin.smtpUserTooltip')}
          >
            <Input placeholder="your_email@163.com" />
          </Form.Item>

          <Form.Item
            label={t('admin.smtpPass')}
            name="smtp_pass"
            tooltip={t('admin.smtpPassTooltip')}
          >
            <Input.Password placeholder={t('admin.smtpPassPlaceholder')} />
          </Form.Item>

          <Form.Item
            label={t('admin.smtpFrom')}
            name="smtp_from"
            rules={[{ required: true, message: t('admin.pleaseEnterSmtpFrom') }]}
            tooltip={t('admin.smtpFromTooltip')}
          >
            <Input placeholder="noreply@example.com" />
          </Form.Item>

          <Form.Item
            label={t('admin.smtpFromName')}
            name="smtp_from_name"
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
        copyright_text: data.COPYRIGHT_TEXT || '© 2024 Minecraft Skin Server',
        copyright_beian: data.COPYRIGHT_BEIAN || '',
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
        copyright_text: values.copyright_text || '',
        copyright_beian: values.copyright_beian || '',
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
          name="copyright_text"
          rules={[{ required: true, message: t('admin.pleaseEnterCopyright') }]}
          tooltip={t('admin.customCopyrightTooltip')}
        >
          <Input placeholder={t('admin.copyrightPlaceholder')} />
        </Form.Item>

        <Form.Item
          label={t('admin.beianInfo')}
          name="copyright_beian"
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
            {t('admin.copyrightWarning1')}<code style={{ background: '#1e3a5f', color: '#58a6ff', padding: '2px 6px', borderRadius: 4, fontSize: 12 }}>Powered by CatTavernSkins</code>
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
