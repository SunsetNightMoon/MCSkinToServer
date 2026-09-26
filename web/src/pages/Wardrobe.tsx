import { useCallback, useEffect, useState } from 'react';
import {
  Card,
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
} from 'antd';
import { UploadOutlined, AppstoreOutlined } from '@ant-design/icons';
import { api, apiUpload, ApiError } from '../api/client';
import type { AssetItem, ProfileRow } from '../api/types';

type Kind = 'skin' | 'cape';

export function WardrobePage() {
  const { message } = AntdApp.useApp();
  const [kind, setKind] = useState<Kind>('skin');
  const [assets, setAssets] = useState<AssetItem[]>([]);
  const [profiles, setProfiles] = useState<ProfileRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState<AssetItem | null>(null);
  const [applyProfileId, setApplyProfileId] = useState<string | null>(null);

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

  const upload = async (file: File): Promise<void> => {
    const model = kind === 'skin' ? '&model=default' : '';
    try {
      const res = await apiUpload<{ deduped: boolean }>(
        `/api/assets?kind=${kind}&name=${encodeURIComponent(file.name.replace(/\.png$/i, ''))}${model}`,
        file,
      );
      message.success(res.deduped ? '上传成功（内容与已有素材相同，已复用）' : '上传成功');
      await load();
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '上传失败');
    }
  };

  const apply = async (): Promise<void> => {
    if (!applying || !applyProfileId) return;
    try {
      await api(`/api/assets/${applying.id}/apply`, {
        method: 'POST',
        json: { profileId: applyProfileId, slot: applying.kind },
      });
      message.success(`已应用到角色`);
      setApplying(null);
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '应用失败');
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

  const reviewTag = (s: AssetItem['reviewStatus']): React.ReactNode =>
    s === 'approved' ? (
      <Tag color="green">已审核</Tag>
    ) : s === 'rejected' ? (
      <Tag color="red">已拒绝</Tag>
    ) : (
      <Tag>待审核</Tag>
    );

  return (
    <Card
      title={
        <Space>
          <span>我的衣柜</span>
          <Select<Kind>
            value={kind}
            style={{ width: 120 }}
            onChange={(v) => setKind(v)}
            options={[
              { value: 'skin', label: '皮肤' },
              { value: 'cape', label: '披风' },
            ]}
          />
        </Space>
      }
      extra={
        <Upload
          accept=".png,image/png"
          showUploadList={false}
          beforeUpload={(file) => {
            void upload(file);
            return false; // 阻止 antd 自动上传，走自定义 apiUpload
          }}
        >
          <Button type="primary" icon={<UploadOutlined />}>
            上传{kind === 'skin' ? '皮肤' : '披风'}（PNG）
          </Button>
        </Upload>
      }
    >
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
            render: () => (
              <AppstoreOutlined style={{ fontSize: 20, color: '#bbb' }} />
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
            title: '下载策略',
            dataIndex: 'downloadPolicy',
            width: 120,
            render: (v: AssetItem['downloadPolicy']) =>
              v === 'public' ? <Tag color="blue">公开</Tag> : <Tag>仅自己</Tag>,
          },
          {
            title: '操作',
            width: 220,
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

      <Modal
        title={`应用「${applying?.name ?? ''}」到角色`}
        open={applying !== null}
        onOk={() => void apply()}
        onCancel={() => setApplying(null)}
        okText="应用"
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <Typography.Text>选择要应用{applying?.kind === 'skin' ? '皮肤' : '披风'}的角色：</Typography.Text>
          <Select
            style={{ width: '100%' }}
            value={applyProfileId ?? undefined}
            onChange={setApplyProfileId}
            options={profiles.map((p) => ({ value: p.id, label: p.name }))}
          />
          <Typography.Text type="secondary">同一角色的同类型槽位会被覆盖</Typography.Text>
        </Space>
      </Modal>
    </Card>
  );
}
