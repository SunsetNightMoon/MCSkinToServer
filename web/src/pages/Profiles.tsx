import { useCallback, useEffect, useState } from 'react';
import {
  Card,
  Table,
  Button,
  Modal,
  Form,
  Input,
  App as AntdApp,
  Typography,
  Popconfirm,
  Space,
} from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { api, ApiError } from '../api/client';
import type { ProfileRow } from '../api/types';
import dayjs from 'dayjs';

const NAME_COOLDOWN_MS = 30 * 24 * 3600 * 1000;

export function ProfilesPage() {
  const { message } = AntdApp.useApp();
  const [profiles, setProfiles] = useState<ProfileRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [renaming, setRenaming] = useState<ProfileRow | null>(null);
  const [createForm] = Form.useForm();
  const [renameForm] = Form.useForm();

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const res = await api<{ profiles: ProfileRow[] }>('/api/me/profiles');
      setProfiles(res.profiles);
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '加载角色失败');
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async (values: { name: string }): Promise<void> => {
    try {
      await api('/api/profiles', { method: 'POST', json: values });
      message.success('角色创建成功');
      setCreateOpen(false);
      createForm.resetFields();
      await load();
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '创建失败');
    }
  };

  const rename = async (values: { name: string }): Promise<void> => {
    if (!renaming) return;
    try {
      await api(`/api/profiles/${renaming.id}/name`, { method: 'POST', json: values });
      message.success('改名成功');
      setRenaming(null);
      renameForm.resetFields();
      await load();
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '改名失败');
    }
  };

  const remove = async (id: string): Promise<void> => {
    try {
      await api(`/api/profiles/${id}`, { method: 'DELETE' });
      message.success('角色已删除');
      await load();
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '删除失败');
    }
  };

  const cooldownRemaining = (p: ProfileRow): number => {
    if (p.nameChangedAt === p.createdAt) return 0; // 初始命名不算改名
    const elapsed = Date.now() - new Date(p.nameChangedAt).getTime();
    return Math.max(0, NAME_COOLDOWN_MS - elapsed);
  };

  return (
    <Card
      title="我的角色"
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
          新建角色
        </Button>
      }
    >
      <Table<ProfileRow>
        rowKey="id"
        loading={loading}
        dataSource={profiles}
        pagination={false}
        columns={[
          { title: '角色名', dataIndex: 'name' },
          {
            title: '创建时间',
            dataIndex: 'createdAt',
            render: (v: string) => dayjs(v).format('YYYY-MM-DD HH:mm'),
          },
          {
            title: '操作',
            render: (_, p) => {
              const remaining = cooldownRemaining(p);
              return (
                <Space>
                  <Button
                    size="small"
                    disabled={remaining > 0}
                    onClick={() => {
                      setRenaming(p);
                      renameForm.setFieldsValue({ name: p.name });
                    }}
                  >
                    改名
                    {remaining > 0
                      ? `（冷却 ${Math.ceil(remaining / 86400000)} 天）`
                      : ''}
                  </Button>
                  <Popconfirm
                    title="确认删除该角色？"
                    description="角色绑定的皮肤会一并解绑"
                    onConfirm={() => void remove(p.id)}
                  >
                    <Button size="small" danger disabled={profiles.length <= 1}>
                      删除
                    </Button>
                  </Popconfirm>
                </Space>
              );
            },
          },
        ]}
      />

      <Modal
        title="新建角色"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={() => createForm.submit()}
        okText="创建"
      >
        <Form form={createForm} layout="vertical" onFinish={(v) => void create(v as never)}>
          <Form.Item
            name="name"
            label="角色名"
            rules={[
              { required: true, message: '请输入角色名' },
              { pattern: /^[A-Za-z0-9_]{3,16}$/, message: '3-16 位字母/数字/下划线' },
            ]}
          >
            <Input placeholder="Steve_Minecraft" />
          </Form.Item>
          <Typography.Text type="secondary">每个账号最多 3 个角色</Typography.Text>
        </Form>
      </Modal>

      <Modal
        title={`改名：${renaming?.name ?? ''}`}
        open={renaming !== null}
        onCancel={() => setRenaming(null)}
        onOk={() => renameForm.submit()}
        okText="确认改名"
      >
        <Form form={renameForm} layout="vertical" onFinish={(v) => void rename(v as never)}>
          <Form.Item
            name="name"
            label="新角色名"
            rules={[
              { required: true, message: '请输入新角色名' },
              { pattern: /^[A-Za-z0-9_]{3,16}$/, message: '3-16 位字母/数字/下划线' },
            ]}
          >
            <Input />
          </Form.Item>
          <Typography.Text type="secondary">改名后进入 30 天冷却期</Typography.Text>
        </Form>
      </Modal>
    </Card>
  );
}
