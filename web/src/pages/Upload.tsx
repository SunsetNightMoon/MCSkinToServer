/**
 * 上传页（plan3 SkinUpload 结构）：皮肤/披风 Tabs、左侧 3D 预览（模型切换）、
 * 右侧表单（名称、PNG 文件、模型类型、描述）。
 * MSCTS 后端为 raw PNG 上传（POST /api/assets?kind=&name=&model=），≤2MB；
 * 描述/可见性/下载策略在上传后于「我的上传」编辑（后端无上传时元数据接口）。
 */

import { useState, useMemo, useEffect } from 'react';
import { Form, Upload, Input, Button, App as AntdApp, Radio, Alert, Tabs } from 'antd';
import { UploadOutlined } from '@ant-design/icons';
import type { UploadFile, UploadProps } from 'antd/es/upload/interface';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { apiUpload, ApiError } from '../api/client';
import { Skin3DViewer } from '../components/Skin3DViewer';
import { usePageTitle } from '../hooks/usePageTitle';

function useViewportSize() {
  const [size, setSize] = useState({ width: window.innerWidth, height: window.innerHeight });
  useEffect(() => {
    const onResize = () => setSize({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return size;
}

const MAX_SIZE = 2 * 1024 * 1024;

/* ─────────────────────── 皮肤上传面板 ─────────────────────── */
function SkinTab() {
  const { t } = useTranslation();
  const { message } = AntdApp.useApp();

  const [form] = Form.useForm();
  const [file, setFile] = useState<UploadFile | null>(null);
  const [modelType, setModelType] = useState<'default' | 'slim'>('default');
  const [loading, setLoading] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const { width: vw } = useViewportSize();
  const viewerSize = useMemo(() => {
    if (vw < 420) return { width: 260, height: 300 };
    if (vw < 576) return { width: 280, height: 320 };
    if (vw < 768) return { width: 320, height: 360 };
    return { width: 360, height: 400 };
  }, [vw]);

  const skinUrl = useMemo(() => previewUrl || '/steve.png', [previewUrl]);

  const beforeUploadSkin: UploadProps['beforeUpload'] = (f) => {
    if (f.type !== 'image/png') {
      message.error(t('upload.onlyPng'));
      return false;
    }
    if (f.size > MAX_SIZE) {
      message.error(t('upload.fileSizeLimit'));
      return false;
    }
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(URL.createObjectURL(f));
    setFile(f);
    return false;
  };

  const onFinish = async (values: { name: string; model_type?: string }): Promise<void> => {
    if (!file) {
      message.error(t('upload.pleaseUploadSkin'));
      return;
    }
    setLoading(true);
    try {
      const model = modelType === 'slim' ? '&model=slim' : '&model=default';
      await apiUpload<{ deduped: boolean }>(
        `/api/assets?kind=skin&name=${encodeURIComponent(values.name)}${model}`,
        file as unknown as File,
      );
      message.success(t('upload.skinUploadSuccess'));
      form.resetFields();
      setFile(null);
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
        setPreviewUrl(null);
      }
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : t('upload.uploadFailed'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <Alert
        message={t('upload.skinUploadGuide')}
        description={t('upload.skinUploadDesc')}
        type="info"
        showIcon
        style={{ marginBottom: 20 }}
      />
      <Alert
        message={t('upload.postUploadHint')}
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
          <div
            style={{
              marginTop: 12,
              display: 'flex',
              gap: 8,
              alignItems: 'center',
              flexWrap: 'wrap',
              justifyContent: 'center',
            }}
          >
            <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
              {t('upload.model')}：
            </span>
            <Radio.Group
              value={modelType}
              onChange={(e) => setModelType(e.target.value)}
              optionType="button"
              buttonStyle="solid"
              size="small"
            >
              <Radio.Button value="default">{t('upload.classicModel')}</Radio.Button>
              <Radio.Button value="slim">{t('upload.slimModel')}</Radio.Button>
            </Radio.Group>
          </div>
          {!file && (
            <div
              style={{
                marginTop: 8,
                fontSize: 12,
                color: 'var(--text-muted)',
                textAlign: 'center',
              }}
            >
              {t('upload.uploadToPreview')}
            </div>
          )}
        </div>

        {/* 右侧表单 */}
        <div style={{ flex: '1 1 300px', minWidth: 280 }}>
          <Form form={form} layout="vertical" onFinish={(v) => void onFinish(v as never)}>
            <Form.Item
              label={t('upload.skinName')}
              name="name"
              rules={[{ required: true, message: t('upload.pleaseEnterSkinName') }]}
            >
              <Input placeholder={t('upload.skinNamePlaceholder')} maxLength={64} showCount />
            </Form.Item>

            <Form.Item label={t('upload.skinFile')} required>
              <Upload
                beforeUpload={beforeUploadSkin}
                fileList={file ? [file] : []}
                maxCount={1}
                accept=".png"
                onRemove={() => {
                  if (previewUrl) {
                    URL.revokeObjectURL(previewUrl);
                    setPreviewUrl(null);
                  }
                  setFile(null);
                }}
              >
                <Button icon={<UploadOutlined />}>{t('upload.selectSkinPng')}</Button>
              </Upload>
            </Form.Item>

            <Form.Item label={t('upload.modelType')} name="model_type" initialValue="default">
              <Radio.Group
                value={modelType}
                onChange={(e) => {
                  setModelType(e.target.value);
                  form.setFieldValue('model_type', e.target.value);
                }}
              >
                <Radio value="default">{t('upload.classicDefault')}</Radio>
                <Radio value="slim">{t('upload.slimAlex')}</Radio>
              </Radio.Group>
            </Form.Item>

            <Form.Item>
              <Button type="primary" htmlType="submit" loading={loading} block size="large">
                {t('upload.uploadSkin')}
              </Button>
            </Form.Item>
          </Form>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────── 披风上传面板 ─────────────────────── */
function CapeTab() {
  const { t } = useTranslation();
  const { message } = AntdApp.useApp();

  const [form] = Form.useForm();
  const [file, setFile] = useState<UploadFile | null>(null);
  const [loading, setLoading] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const { width: vw } = useViewportSize();
  const viewerSize = useMemo(() => {
    if (vw < 420) return { width: 260, height: 300 };
    if (vw < 576) return { width: 280, height: 320 };
    if (vw < 768) return { width: 320, height: 360 };
    return { width: 360, height: 400 };
  }, [vw]);

  const beforeUpload: UploadProps['beforeUpload'] = (f) => {
    if (f.type !== 'image/png') {
      message.error(t('upload.onlyPng'));
      return false;
    }
    if (f.size > MAX_SIZE) {
      message.error(t('upload.capeFileSizeLimit'));
      return false;
    }
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(URL.createObjectURL(f));
    setFile(f);
    return false;
  };

  const onFinish = async (values: { name: string }): Promise<void> => {
    if (!file) {
      message.error(t('upload.pleaseUploadCape'));
      return;
    }
    setLoading(true);
    try {
      await apiUpload<{ deduped: boolean }>(
        `/api/assets?kind=cape&name=${encodeURIComponent(values.name)}`,
        file as unknown as File,
      );
      message.success(t('upload.capeUploadSuccess'));
      form.resetFields();
      setFile(null);
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
        setPreviewUrl(null);
      }
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : t('upload.uploadFailed'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <Alert
        message={t('upload.capeUploadGuide')}
        description={t('upload.capeUploadDesc')}
        type="info"
        showIcon
        style={{ marginBottom: 20 }}
      />
      <Alert
        message={t('upload.postUploadHint')}
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
          <div
            style={{
              marginTop: 8,
              fontSize: 12,
              color: 'var(--text-muted)',
              textAlign: 'center',
            }}
          >
            {file ? t('upload.cape3DPreview') : t('upload.uploadCapeToPreview')}
          </div>
        </div>

        {/* 右侧表单 */}
        <div style={{ flex: '1 1 300px', minWidth: 280 }}>
          <Form form={form} layout="vertical" onFinish={(v) => void onFinish(v as never)}>
            <Form.Item
              label={t('upload.capeName')}
              name="name"
              rules={[{ required: true, message: t('upload.pleaseEnterCapeName') }]}
            >
              <Input placeholder={t('upload.capeNamePlaceholder')} maxLength={64} showCount />
            </Form.Item>

            <Form.Item label={t('upload.capeFile')} required>
              <Upload
                beforeUpload={beforeUpload}
                fileList={file ? [file] : []}
                maxCount={1}
                accept=".png"
                onRemove={() => {
                  if (previewUrl) {
                    URL.revokeObjectURL(previewUrl);
                    setPreviewUrl(null);
                  }
                  setFile(null);
                }}
              >
                <Button icon={<UploadOutlined />}>{t('upload.selectCapePng')}</Button>
              </Upload>
              <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-muted)' }}>
                {t('upload.capeSizeHint')}
              </div>
            </Form.Item>

            <Form.Item>
              <Button type="primary" htmlType="submit" loading={loading} block size="large">
                {t('upload.uploadCape')}
              </Button>
            </Form.Item>
          </Form>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────── 主页面 ─────────────────────── */
export function UploadPage() {
  const { t } = useTranslation();
  usePageTitle(t('nav.upload'));
  const [searchParams, setSearchParams] = useSearchParams();
  const [activeKey, setActiveKey] = useState(() => {
    const type = searchParams.get('type');
    return type === 'cape' ? 'cape' : 'skin';
  });

  const handleTabChange = (key: string) => {
    setActiveKey(key);
    setSearchParams({ type: key });
  };

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
  );
}
