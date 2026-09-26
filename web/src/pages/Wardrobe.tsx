/**
 * 我的衣柜（皮肤/披风管理）：完整上传面板（拖拽 + 模型选择 + 命名）、
 * 素材编辑（名称/描述/公开可见/下载策略）、应用到角色（3D 预览）、删除。
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Table,
  Button,
  Modal,
  Select,
  App as AntdApp,
  Upload,
  Tag,
  Space,
  Typography,
  Popconfirm,
  Form,
  Input,
  Switch,
} from 'antd';
import { InboxOutlined, AppstoreOutlined, EditOutlined } from '@ant-design/icons';
import { api, apiUpload, ApiError } from '../api/client';
import { Skin3DViewer } from '../components/Skin3DViewer';
import type { AssetItem, ProfileRow } from '../api/types';

type Kind = 'skin' | 'cape';

export function WardrobePage() {
  const { message } = AntdApp.useApp();
  const [kind, setKind] = useState<Kind>('skin');
  const [assets, setAssets] = useState<AssetItem[]>([]);
  const [profiles, setProfiles] = useState<ProfileRow[]>([]);
  const [loading, setLoading] = useState(false);

  // 上传面板
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadPreview, setUploadPreview] = useState<string | null>(null);
  const [uploadModel, setUploadModel] = useState<'default' | 'slim'>('default');
  const [uploadName, setUploadName] = useState('');
  const [uploading, setUploading] = useState(false);

  // 应用 / 编辑
  const [applying, setApplying] = useState<AssetItem | null>(null);
  const [applyProfileId, setApplyProfileId] = useState<string | null>(null);
  const [editing, setEditing] = useState<AssetItem | null>(null);
  const [editForm] = Form.useForm();
  const [saving, setSaving] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const [a, p] = await Promise.all([
        api<{ assets: AssetItem[] }>(`/api/me/assets?kind=${kind}`),
        api<{ profiles: ProfileRow[] }>('/api/me/profiles'),
      ]);
      setAssets(a.assets);
      setProfiles(p.profiles);
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '加载衣柜失败');
    } finally {
      setLoading(false);
    }
  }, [kind, message]);

  useEffect(() => {
    void load();
  }, [load]);

  const resetUpload = (): void => {
    setUploadFile(null);
    setUploadPreview(null);
    setUploadModel('default');
    setUploadName('');
  };

  const pickFile = (file: File): boolean => {
    if (!/\.png$/i.test(file.name)) {
      message.error('仅支持 PNG 格式');
      return false;
    }
    setUploadFile(file);
    setUploadName(file.name.replace(/\.png$/i, ''));
    const reader = new FileReader();
    reader.onload = () => setUploadPreview(String(reader.result));
    reader.readAsDataURL(file);
    return false; // 阻止 antd 自动上传
  };

  const doUpload = async (): Promise<void> => {
    if (!uploadFile) return;
    setUploading(true);
    try {
      const model = kind === 'skin' ? `&model=${uploadModel}` : '';
      const name = uploadName.trim() || uploadFile.name.replace(/\.png$/i, '');
      const res = await apiUpload<{ deduped: boolean }>(
        `/api/assets?kind=${kind}&name=${encodeURIComponent(name)}${model}`,
        uploadFile,
      );
      message.success(res.deduped ? '上传成功（内容与已有素材相同，已复用）' : '上传成功');
      setUploadOpen(false);
      resetUpload();
      await load();
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '上传失败');
    } finally {
      setUploading(false);
    }
  };

  const apply = async (): Promise<void> => {
    if (!applying || !applyProfileId) return;
    try {
      await api(`/api/assets/${applying.id}/apply`, {
        method: 'POST',
        json: { profileId: applyProfileId, slot: applying.kind },
      });
      message.success('已应用到角色');
      setApplying(null);
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '应用失败');
    }
  };

  const saveEdit = async (): Promise<void> => {
    if (!editing) return;
    setSaving(true);
    try {
      const values = await editForm.validateFields();
      await api(`/api/assets/${editing.id}`, {
        method: 'PATCH',
        json: {
          name: values.name,
          description: values.description || null,
          visibility: values.visibility ? 'public' : 'private',
          downloadPolicy: values.downloadPolicy,
        },
      });
      message.success('已保存');
      setEditing(null);
      await load();
    } catch (err) {
      if (err instanceof ApiError) message.error(err.message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string): Promise<void> => {
    try {
      await api(`/api/assets/${id}`, { method: 'DELETE' });
      message.success('素材已删除');
      await load();
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '删除失败');
    }
  };

  const openEdit = (a: AssetItem): void => {
    setEditing(a);
    editForm.setFieldsValue({
      name: a.name,
      description: a.description ?? '',
      visibility: a.visibility === 'public',
      downloadPolicy: a.downloadPolicy,
    });
  };

  const reviewTag = (s: AssetItem['reviewStatus']): React.ReactNode =>
    s === 'approved' ? (
      <Tag color="green">已审核</Tag>
    ) : s === 'rejected' ? (
      <Tag color="red">已拒绝</Tag>
    ) : (
      <Tag>待审核</Tag>
    );

  return (
    <div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 16,
          flexWrap: 'wrap',
          gap: 12,
        }}
      >
        <h2 style={{ color: 'var(--text-primary)', margin: 0 }}>我的衣柜</h2>
        <Space>
          <Select<Kind>
            value={kind}
            style={{ width: 120 }}
            onChange={(v) => setKind(v)}
            options={[
              { value: 'skin', label: '皮肤' },
              { value: 'cape', label: '披风' },
            ]}
          />
          <Button type="primary" icon={<InboxOutlined />} onClick={() => setUploadOpen(true)}>
            上传{kind === 'skin' ? '皮肤' : '披风'}
          </Button>
        </Space>
      </div>

      <div className="glass-card" style={{ borderRadius: 10, padding: 16 }}>
        <Table<AssetItem>
          rowKey="id"
          loading={loading}
          dataSource={assets}
          pagination={{ pageSize: 10 }}
          columns={[
            {
              title: '预览',
              dataIndex: 'previewUrl',
              width: 80,
              render: (_, a) =>
                a.previewUrl ? (
                  <img
                    src={a.previewUrl}
                    alt={a.name}
                    style={{ width: 40, imageRendering: 'pixelated' }}
                  />
                ) : (
                  <AppstoreOutlined style={{ fontSize: 20, color: 'var(--text-faint)' }} />
                ),
            },
            {
              title: '名称',
              dataIndex: 'name',
              render: (v: string, a) => (
                <Space>
                  {v}
                  {reviewTag(a.reviewStatus)}
                  {a.kind === 'skin' && a.modelType ? (
                    <Tag>{a.modelType === 'slim' ? '纤细' : '经典'}</Tag>
                  ) : null}
                  {a.aiGenerated ? <Tag color="purple">AI 生成</Tag> : null}
                  {a.adminWarning ? <Tag color="orange">⚠ {a.adminWarning}</Tag> : null}
                </Space>
              ),
            },
            {
              title: '状态',
              width: 160,
              render: (_, a) => (
                <Space size={4}>
                  {a.visibility === 'public' ? (
                    <Tag color="blue">已公开</Tag>
                  ) : (
                    <Tag>私有</Tag>
                  )}
                  {a.downloadPolicy === 'public' ? (
                    <Tag style={{ fontSize: 11 }}>可下载</Tag>
                  ) : null}
                </Space>
              ),
            },
            {
              title: '操作',
              width: 260,
              render: (_, a) => (
                <Space>
                  <Button
                    size="small"
                    type="primary"
                    onClick={() => {
                      setApplying(a);
                      setApplyProfileId(profiles[0]?.id ?? null);
                    }}
                  >
                    应用到角色
                  </Button>
                  <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(a)}>
                    编辑
                  </Button>
                  <Popconfirm title="确认删除该素材？" onConfirm={() => void remove(a.id)}>
                    <Button size="small" danger>
                      删除
                    </Button>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
      </div>

      {/* 上传面板 */}
      <Modal
        title={`上传${kind === 'skin' ? '皮肤' : '披风'}`}
        open={uploadOpen}
        onCancel={() => {
          setUploadOpen(false);
          resetUpload();
        }}
        onOk={() => void doUpload()}
        okText="上传"
        okButtonProps={{ disabled: uploadFile === null, loading: uploading }}
        width={520}
      >
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          {uploadPreview ? (
            <div style={{ textAlign: 'center', padding: 8 }}>
              <img
                src={uploadPreview}
                alt="预览"
                style={{ maxHeight: 120, imageRendering: 'pixelated' }}
              />
            </div>
          ) : (
            <Upload.Dragger
              accept=".png,image/png"
              showUploadList={false}
              beforeUpload={(file) => pickFile(file)}
            >
              <p className="ant-upload-drag-icon">
                <InboxOutlined />
              </p>
              <p className="ant-upload-text">点击或拖拽 PNG 到此处</p>
              <p className="ant-upload-hint">
                {kind === 'skin' ? '皮肤 64×64 或 64×32，≤ 2MB' : '披风 64×32，≤ 2MB'}
              </p>
            </Upload.Dragger>
          )}
          {kind === 'skin' ? (
            <div>
              <Typography.Text style={{ display: 'block', marginBottom: 4 }}>
                模型类型
              </Typography.Text>
              <Select
                value={uploadModel}
                style={{ width: '100%' }}
                onChange={setUploadModel}
                options={[
                  { value: 'default', label: '经典（Steve 宽臂）' },
                  { value: 'slim', label: '纤细（Alex 细臂）' },
                ]}
              />
            </div>
          ) : null}
          <div>
            <Typography.Text style={{ display: 'block', marginBottom: 4 }}>名称</Typography.Text>
            <Input
              value={uploadName}
              onChange={(e) => setUploadName(e.target.value)}
              placeholder="素材名称"
              maxLength={64}
            />
          </div>
        </Space>
      </Modal>

      {/* 编辑弹窗 */}
      <Modal
        title={`编辑素材：${editing?.name ?? ''}`}
        open={editing !== null}
        onOk={() => void saveEdit()}
        confirmLoading={saving}
        onCancel={() => setEditing(null)}
        okText="保存"
      >
        <Form form={editForm} layout="vertical">
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }]}>
            <Input maxLength={64} />
          </Form.Item>
          <Form.Item name="description" label="描述">
            <Input.TextArea rows={2} placeholder="展示在详情页（可选）" maxLength={255} />
          </Form.Item>
          <Form.Item
            name="visibility"
            label="公开可见"
            valuePropName="checked"
            extra="公开需通过审核后才会出现在公开库"
          >
            <Switch />
          </Form.Item>
          <Form.Item name="downloadPolicy" label="下载策略">
            <Select
              options={[
                { value: 'owner_only', label: '仅自己可下载' },
                { value: 'public', label: '所有人可下载' },
              ]}
            />
          </Form.Item>
        </Form>
      </Modal>

      {/* 应用到角色 */}
      <Modal
        title={`应用「${applying?.name ?? ''}」到角色`}
        open={applying !== null}
        onOk={() => void apply()}
        onCancel={() => setApplying(null)}
        okText="应用"
        width={applying?.kind === 'skin' ? 640 : 480}
      >
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
          {applying?.kind === 'skin' && applying.previewUrl ? (
            <Skin3DViewer
              skinUrl={applying.previewUrl}
              modelType={applying.modelType ?? 'default'}
              width={240}
              height={280}
            />
          ) : null}
          <div style={{ flex: 1, minWidth: 220 }}>
            <Space direction="vertical" style={{ width: '100%' }}>
              <Typography.Text>
                选择要应用{applying?.kind === 'skin' ? '皮肤' : '披风'}的角色：
              </Typography.Text>
              <Select
                style={{ width: '100%' }}
                value={applyProfileId ?? undefined}
                onChange={setApplyProfileId}
                options={profiles.map((p) => ({ value: p.id, label: p.name }))}
              />
              <Typography.Text type="secondary">
                同一角色的同类型槽位会被覆盖
              </Typography.Text>
            </Space>
          </div>
        </div>
      </Modal>
    </div>
  );
}
