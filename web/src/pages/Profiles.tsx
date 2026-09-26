/**
 * 我的角色管理：新建 / 改名（30 天冷却）/ 删除（至少保留 1 个角色）。
 * 冷却与保留规则由后端校验，前端按 nameChangedAt 计算提示。
 */

import { useCallback, useEffect, useState } from 'react';
import {
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
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../api/client';
import { usePageTitle } from '../hooks/usePageTitle';
import type { ProfileRow } from '../api/types';
import dayjs from 'dayjs';

const NAME_COOLDOWN_MS = 30 * 24 * 3600 * 1000;

export function ProfilesPage() {
  const { t } = useTranslation();
  usePageTitle(t('profiles.title'));
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
      message.error(err instanceof ApiError ? err.message : t('common.requestFailed'));
    } finally {
      setLoading(false);
    }
  }, [message, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async (values: { name: string }): Promise<void> => {
    try {
      await api('/api/profiles', { method: 'POST', json: values });
      message.success(t('profiles.created'));
      setCreateOpen(false);
      createForm.resetFields();
      await load();
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : t('common.requestFailed'));
    }
  };

  const rename = async (values: { name: string }): Promise<void> => {
    if (!renaming) return;
    try {
      await api(`/api/profiles/${renaming.id}/name`, { method: 'POST', json: values });
      message.success(t('profiles.renamed'));
      setRenaming(null);
      renameForm.resetFields();
      await load();
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : t('common.requestFailed'));
    }
  };

  const remove = async (id: string): Promise<void> => {
    try {
      await api(`/api/profiles/${id}`, { method: 'DELETE' });
      message.success(t('profiles.deleted'));
      await load();
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : t('common.requestFailed'));
    }
  };

  const cooldownRemaining = (p: ProfileRow): number => {
    if (p.nameChangedAt === p.createdAt) return 0; // 初始命名不算改名
    const elapsed = Date.now() - new Date(p.nameChangedAt).getTime();
    return Math.max(0, NAME_COOLDOWN_MS - elapsed);
  };

  return (
    <div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 16,
        }}
      >
        <h2 style={{ color: 'var(--text-primary)', margin: 0 }}>{t('profiles.title')}</h2>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
          {t('profiles.create')}
        </Button>
      </div>

      <div className="glass-card" style={{ borderRadius: 10, padding: 16 }}>
        <Table<ProfileRow>
          rowKey="id"
          loading={loading}
          dataSource={profiles}
          pagination={false}
          columns={[
            { title: t('profiles.name'), dataIndex: 'name' },
            {
              title: t('profiles.createdAt'),
              dataIndex: 'createdAt',
              render: (v: string) => dayjs(v).format('YYYY-MM-DD HH:mm'),
            },
            {
              title: t('profiles.action'),
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
                      {t('profiles.rename')}
                      {remaining > 0 ? t('profiles.cooldownDays', { days: Math.ceil(remaining / 86400000) }) : ''}
                    </Button>
                    <Popconfirm
                      title={t('profiles.deleteTitle')}
                      description={t('profiles.deleteDesc')}
                      onConfirm={() => void remove(p.id)}
                    >
                      <Button size="small" danger disabled={profiles.length <= 1}>
                        {t('profiles.delete')}
                      </Button>
                    </Popconfirm>
                  </Space>
                );
              },
            },
          ]}
        />

        <Modal
          title={t('profiles.create')}
          open={createOpen}
          onCancel={() => setCreateOpen(false)}
          onOk={() => createForm.submit()}
          okText={t('profiles.createOk')}
        >
          <Form form={createForm} layout="vertical" onFinish={(v) => void create(v as never)}>
            <Form.Item
              name="name"
              label={t('profiles.name')}
              rules={[
                { required: true, message: t('profiles.nameRequired') },
                { pattern: /^[A-Za-z0-9_]{3,16}$/, message: t('profiles.nameRule') },
              ]}
            >
              <Input placeholder={t('profiles.namePlaceholder')} />
            </Form.Item>
            <Typography.Text type="secondary">{t('profiles.maxHint')}</Typography.Text>
          </Form>
        </Modal>

        <Modal
          title={t('profiles.renameTitle', { name: renaming?.name ?? '' })}
          open={renaming !== null}
          onCancel={() => setRenaming(null)}
          onOk={() => renameForm.submit()}
          okText={t('profiles.rename')}
        >
          <Form form={renameForm} layout="vertical" onFinish={(v) => void rename(v as never)}>
            <Form.Item
              name="name"
              label={t('profiles.newNameLabel')}
              rules={[
                { required: true, message: t('profiles.nameRequired') },
                { pattern: /^[A-Za-z0-9_]{3,16}$/, message: t('profiles.nameRule') },
              ]}
            >
              <Input />
            </Form.Item>
            <Typography.Text type="secondary">
              {t('profiles.renameCooldownHint')}
            </Typography.Text>
          </Form>
        </Modal>
      </div>
    </div>
  );
}
