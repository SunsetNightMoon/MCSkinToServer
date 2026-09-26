/**
 * 管理后台（审核队列 + 用户管理）
 * - 审核：待审列表、通过/拒绝（附理由）、管理员警告 / AI 标记
 * - 用户：列表搜索、封禁/解封、角色调整（仅 super_admin 可改角色）
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Tabs,
  Table,
  Button,
  Tag,
  Space,
  App as AntdApp,
  Modal,
  Input,
  Select,
  Form,
  Popconfirm,
  Image,
} from 'antd';
import { CheckOutlined, CloseOutlined, SearchOutlined } from '@ant-design/icons';
import { api, ApiError } from '../api/client';
import { useAuthStore } from '../store/auth';
import type { AssetItem } from '../api/types';

interface AdminUserRow {
  id: string;
  userUid: number;
  email: string;
  role: 'user' | 'admin' | 'super_admin';
  emailVerified: boolean;
  bannedUntil: string | null;
  banPermanent: boolean;
  banReason: string | null;
  createdAt: string;
  lastLoginAt: string | null;
}

function AdminPage() {
  const { message } = AntdApp.useApp();
  const myId = useAuthStore((s) => s.user?.id);
  const myRole = useAuthStore((s) => s.user?.role);
  const isSuper = myRole === 'super_admin';

  // ---- 审核队列 ----
  const [pending, setPending] = useState<AssetItem[]>([]);
  const [pendingLoading, setPendingLoading] = useState(false);
  const [reviewTarget, setReviewTarget] = useState<AssetItem | null>(null);
  const [reviewReason, setReviewReason] = useState('');
  const [warnForm] = Form.useForm();

  const loadPending = useCallback(async (): Promise<void> => {
    setPendingLoading(true);
    try {
      const res = await api<{ items: AssetItem[] }>('/api/admin/reviews');
      setPending(res.items);
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '加载待审核列表失败');
    } finally {
      setPendingLoading(false);
    }
  }, [message]);

  // ---- 用户管理 ----
  const [users, setUsers] = useState<AdminUserRow[]>([]);
  const [usersTotal, setUsersTotal] = useState(0);
  const [usersPage, setUsersPage] = useState(1);
  const [usersSearch, setUsersSearch] = useState('');
  const [usersLoading, setUsersLoading] = useState(false);
  const [banTarget, setBanTarget] = useState<AdminUserRow | null>(null);
  const [banForm] = Form.useForm();

  const loadUsers = useCallback(async (): Promise<void> => {
    setUsersLoading(true);
    try {
      const res = await api<{ items: AdminUserRow[]; total: number }>(
        `/api/admin/users?page=${usersPage}&pageSize=20${usersSearch ? `&search=${encodeURIComponent(usersSearch)}` : ''}`,
      );
      setUsers(res.items);
      setUsersTotal(res.total);
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '加载用户列表失败');
    } finally {
      setUsersLoading(false);
    }
  }, [usersPage, usersSearch, message]);

  useEffect(() => {
    void loadPending();
  }, [loadPending]);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  // ---- 审核操作 ----
  const review = async (
    asset: AssetItem,
    status: 'approved' | 'rejected',
    reason: string,
  ): Promise<void> => {
    try {
      await api(`/api/admin/assets/${asset.id}/review`, {
        method: 'POST',
        json: { status, reason: reason || undefined },
      });
      message.success(status === 'approved' ? '已通过' : '已拒绝');
      setReviewTarget(null);
      setReviewReason('');
      await loadPending();
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '操作失败');
    }
  };

  const saveModeration = async (assetId: string): Promise<void> => {
    try {
      const values = await warnForm.validateFields();
      await api(`/api/admin/assets/${assetId}`, {
        method: 'PATCH',
        json: {
          adminWarning: values.adminWarning || null,
          aiGenerated: values.aiGenerated,
        },
      });
      message.success('已保存');
      await loadPending();
    } catch (err) {
      if (err instanceof ApiError) message.error(err.message);
    }
  };

  // ---- 用户操作 ----
  const patchUser = async (id: string, body: Record<string, unknown>): Promise<void> => {
    try {
      await api(`/api/admin/users/${id}`, { method: 'PATCH', json: body });
      await loadUsers();
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '操作失败');
    }
  };

  const userRoleTag = (role: string) =>
    role === 'super_admin' ? (
      <Tag color="purple">超管</Tag>
    ) : role === 'admin' ? (
      <Tag color="blue">管理员</Tag>
    ) : (
      <Tag>用户</Tag>
    );

  const userBanInfo = (u: AdminUserRow) =>
    u.banPermanent ? (
      <Tag color="red">永久封禁</Tag>
    ) : u.bannedUntil ? (
      <Tag color="orange">至 {new Date(u.bannedUntil).toLocaleDateString()}</Tag>
    ) : (
      <span style={{ color: 'var(--text-subtle)' }}>正常</span>
    );

  return (
    <div>
      <h2 style={{ color: 'var(--text-primary)', margin: '0 0 16px' }}>管理后台</h2>
      <div className="glass-card" style={{ borderRadius: 10, padding: 16 }}>
        <Tabs
          items={[
            {
              key: 'review',
              label: '审核队列',
              children: (
                <Table<AssetItem>
                  rowKey="id"
                  loading={pendingLoading}
                  dataSource={pending}
                  pagination={{ pageSize: 10 }}
                  columns={[
                    {
                      title: '预览',
                      width: 70,
                      render: (_, a) =>
                        a.previewUrl ? (
                          <Image
                            src={a.previewUrl}
                            width={36}
                            style={{ imageRendering: 'pixelated' }}
                            preview={false}
                          />
                        ) : null,
                    },
                    { title: '名称', dataIndex: 'name' },
                    { title: '类型', width: 80, render: (_, a) => (a.kind === 'skin' ? '皮肤' : '披风') },
                    {
                      title: '管理员警告 / AI',
                      render: (_, a) => (
                        <Space>
                          {a.aiGenerated ? <Tag color="purple">AI</Tag> : null}
                          {a.adminWarning ? <Tag color="orange">{a.adminWarning}</Tag> : null}
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
                            icon={<CheckOutlined />}
                            onClick={() => void review(a, 'approved', '')}
                          >
                            通过
                          </Button>
                          <Button
                            size="small"
                            danger
                            icon={<CloseOutlined />}
                            onClick={() => {
                              setReviewTarget(a);
                              setReviewReason('');
                            }}
                          >
                            拒绝
                          </Button>
                          <Button
                            size="small"
                            onClick={() => {
                              warnForm.setFieldsValue({
                                adminWarning: a.adminWarning ?? '',
                                aiGenerated: a.aiGenerated ?? false,
                              });
                              Modal.confirm({
                                title: `标记管理：${a.name}`,
                                content: (
                                  <Form form={warnForm} layout="vertical">
                                    <Form.Item name="adminWarning" label="管理员警告（公开显示）">
                                      <Input placeholder="留空清除" />
                                    </Form.Item>
                                    <Form.Item name="aiGenerated" valuePropName="checked">
                                      <label>
                                        <input type="checkbox" style={{ marginRight: 6 }} />
                                        AI 生成素材
                                      </label>
                                    </Form.Item>
                                  </Form>
                                ),
                                onOk: () => saveModeration(a.id),
                              });
                            }}
                          >
                            标记
                          </Button>
                        </Space>
                      ),
                    },
                  ]}
                />
              ),
            },
            {
              key: 'users',
              label: '用户管理',
              children: (
                <>
                  <Space style={{ marginBottom: 12 }}>
                    <Input
                      allowClear
                      prefix={<SearchOutlined />}
                      placeholder="按邮箱搜索"
                      style={{ width: 260 }}
                      onPressEnter={(e) => {
                        setUsersSearch((e.target as HTMLInputElement).value.trim());
                        setUsersPage(1);
                      }}
                    />
                    <Button
                      icon={<SearchOutlined />}
                      onClick={(e) => {
                        const input = (e.target as HTMLElement).closest('.ant-input-group')?.querySelector('input');
                        setUsersSearch(input?.value.trim() ?? '');
                        setUsersPage(1);
                      }}
                    >
                      搜索
                    </Button>
                  </Space>
                  <Table<AdminUserRow>
                    rowKey="id"
                    loading={usersLoading}
                    dataSource={users}
                    pagination={{
                      current: usersPage,
                      pageSize: 20,
                      total: usersTotal,
                      onChange: setUsersPage,
                    }}
                    columns={[
                      { title: 'UID', dataIndex: 'userUid', width: 70 },
                      { title: '邮箱', dataIndex: 'email' },
                      { title: '角色', width: 90, render: (_, u) => userRoleTag(u.role) },
                      { title: '封禁状态', width: 130, render: (_, u) => userBanInfo(u) },
                      {
                        title: '注册时间',
                        dataIndex: 'createdAt',
                        width: 110,
                        render: (v: string) => new Date(v).toLocaleDateString(),
                      },
                      {
                        title: '操作',
                        width: 280,
                        render: (_, u) => {
                          const banned = u.banPermanent || u.bannedUntil !== null;
                          return (
                            <Space>
                              <Popconfirm
                                title={banned ? '解除封禁？' : '确认封禁？'}
                                onConfirm={() =>
                                  void patchUser(u.id, { ban: banned ? null : { permanent: false, until: new Date(Date.now() + 7 * 86400000).toISOString(), reason: '7 天临时封禁' } })
                                }
                              >
                                <Button size="small" danger={!banned}>
                                  {banned ? '解封' : '封禁 7 天'}
                                </Button>
                              </Popconfirm>
                              <Button
                                size="small"
                                onClick={() => {
                                  setBanTarget(u);
                                  banForm.resetFields();
                                }}
                              >
                                自定义封禁
                              </Button>
                              {isSuper && (
                                <Select
                                  size="small"
                                  value={u.role}
                                  style={{ width: 110 }}
                                  disabled={u.id === myId}
                                  onChange={(role) => void patchUser(u.id, { role })}
                                  options={[
                                    { value: 'user', label: '用户' },
                                    { value: 'admin', label: '管理员' },
                                    { value: 'super_admin', label: '超管' },
                                  ]}
                                />
                              )}
                            </Space>
                          );
                        },
                      },
                    ]}
                  />
                </>
              ),
            },
          ]}
        />
      </div>

      {/* 拒绝理由弹窗 */}
      <Modal
        title={`拒绝素材：${reviewTarget?.name ?? ''}`}
        open={reviewTarget !== null}
        onOk={() => reviewTarget && void review(reviewTarget, 'rejected', reviewReason)}
        onCancel={() => setReviewTarget(null)}
        okText="确认拒绝"
        okButtonProps={{ danger: true }}
      >
        <Input.TextArea
          value={reviewReason}
          onChange={(e) => setReviewReason(e.target.value)}
          placeholder="拒绝理由（将记入审核流水）"
          rows={3}
        />
      </Modal>

      {/* 自定义封禁弹窗 */}
      <Modal
        title={`封禁用户：${banTarget?.email ?? ''}`}
        open={banTarget !== null}
        onOk={() =>
          banForm
            .validateFields()
            .then(async (values) => {
              await patchUser(banTarget!.id, {
                ban:
                  values.mode === 'permanent'
                    ? { permanent: true, reason: values.reason }
                    : { permanent: false, until: new Date(values.until).toISOString(), reason: values.reason },
              });
              setBanTarget(null);
              message.success('已封禁');
            })
            .catch(() => undefined)
        }
        onCancel={() => setBanTarget(null)}
        okText="确认封禁"
        okButtonProps={{ danger: true }}
      >
        <Form form={banForm} layout="vertical" initialValues={{ mode: 'temporary' }}>
          <Form.Item name="mode" label="封禁类型">
            <Select
              options={[
                { value: 'temporary', label: '临时封禁' },
                { value: 'permanent', label: '永久封禁' },
              ]}
            />
          </Form.Item>
          <Form.Item name="until" label="到期时间" dependencies={['mode']} rules={[{ required: true, message: '请选择到期时间' }]}>
            <Input type="datetime-local" />
          </Form.Item>
          <Form.Item name="reason" label="封禁理由">
            <Input.TextArea rows={2} placeholder="可选" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

export default AdminPage;
