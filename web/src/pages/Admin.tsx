/**
 * 管理后台（审核队列 + 用户管理，plan3 AdminDashboard 呈现风格：Tabs 布局）
 * - 审核：待审列表、通过/拒绝（附理由）、管理员警告 / AI 标记、审核记录
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
  Descriptions,
  Empty,
} from 'antd';
import { CheckOutlined, CloseOutlined, SearchOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../api/client';
import { useAuthStore } from '../store/auth';
import { usePageTitle } from '../hooks/usePageTitle';
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

interface ReviewRecord {
  id: string;
  assetId: string;
  status: 'approved' | 'rejected';
  reason: string | null;
  createdAt: string;
}

function AdminPage() {
  const { t } = useTranslation();
  usePageTitle(t('admin.dashboard'));
  const { message, modal } = AntdApp.useApp();
  const myId = useAuthStore((s) => s.user?.id);
  const myRole = useAuthStore((s) => s.user?.role);
  const isSuper = myRole === 'super_admin';

  // ---- 审核队列 ----
  const [pending, setPending] = useState<AssetItem[]>([]);
  const [pendingLoading, setPendingLoading] = useState(false);
  const [reviewTarget, setReviewTarget] = useState<AssetItem | null>(null);
  const [reviewReason, setReviewReason] = useState('');
  const [historyTarget, setHistoryTarget] = useState<AssetItem | null>(null);
  const [history, setHistory] = useState<ReviewRecord[] | null>(null);
  const [warnForm] = Form.useForm();

  const loadPending = useCallback(async (): Promise<void> => {
    setPendingLoading(true);
    try {
      const res = await api<{ items: AssetItem[] }>('/api/admin/reviews');
      setPending(res.items);
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : t('admin.reviewLoadFailed'));
    } finally {
      setPendingLoading(false);
    }
  }, [message, t]);

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
        `/api/admin/users?page=${usersPage}&pageSize=20${
          usersSearch ? `&search=${encodeURIComponent(usersSearch)}` : ''
        }`,
      );
      setUsers(res.items);
      setUsersTotal(res.total);
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : t('admin.usersLoadFailed'));
    } finally {
      setUsersLoading(false);
    }
  }, [usersPage, usersSearch, message, t]);

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
      message.success(status === 'approved' ? t('admin.reviewApproved') : t('admin.reviewRejected'));
      setReviewTarget(null);
      setReviewReason('');
      await loadPending();
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : t('common.requestFailed'));
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
      message.success(t('admin.saved'));
      await loadPending();
    } catch (err) {
      if (err instanceof ApiError) message.error(err.message);
    }
  };

  const openHistory = async (asset: AssetItem): Promise<void> => {
    setHistoryTarget(asset);
    setHistory(null);
    try {
      const res = await api<{ reviews: ReviewRecord[] }>(`/api/admin/assets/${asset.id}/reviews`);
      setHistory(res.reviews);
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : t('common.requestFailed'));
      setHistory([]);
    }
  };

  // ---- 用户操作 ----
  const patchUser = async (id: string, body: Record<string, unknown>): Promise<void> => {
    try {
      await api(`/api/admin/users/${id}`, { method: 'PATCH', json: body });
      await loadUsers();
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : t('common.requestFailed'));
    }
  };

  const userRoleTag = (role: string) =>
    role === 'super_admin' ? (
      <Tag color="purple">{t('admin.superAdmin')}</Tag>
    ) : role === 'admin' ? (
      <Tag color="blue">{t('admin.admin')}</Tag>
    ) : (
      <Tag>{t('admin.normalUser')}</Tag>
    );

  const userBanInfo = (u: AdminUserRow) =>
    u.banPermanent ? (
      <Tag color="red">{t('admin.permanentBan')}</Tag>
    ) : u.bannedUntil ? (
      <Tag color="orange">
        {t('admin.bannedUntilDate', { date: new Date(u.bannedUntil).toLocaleDateString() })}
      </Tag>
    ) : (
      <span style={{ color: 'var(--text-subtle)' }}>{t('admin.normal')}</span>
    );

  return (
    <div>
      <h2 style={{ color: 'var(--text-primary)', margin: '0 0 16px' }}>{t('admin.dashboard')}</h2>
      <div className="glass-card" style={{ borderRadius: 10, padding: 16 }}>
        <Tabs
          items={[
            {
              key: 'review',
              label: t('admin.reviewQueue'),
              children: (
                <Table<AssetItem>
                  rowKey="id"
                  loading={pendingLoading}
                  dataSource={pending}
                  pagination={{ pageSize: 10 }}
                  columns={[
                    {
                      title: t('admin.preview'),
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
                    { title: t('admin.name'), dataIndex: 'name' },
                    {
                      title: t('admin.kindCol'),
                      width: 80,
                      render: (_, a) => (a.kind === 'skin' ? t('nav.skin') : t('nav.cape')),
                    },
                    {
                      title: `${t('admin.adminWarningField')} / AI`,
                      render: (_, a) => (
                        <Space>
                          {a.aiGenerated ? <Tag color="purple">AI</Tag> : null}
                          {a.adminWarning ? <Tag color="orange">{a.adminWarning}</Tag> : null}
                        </Space>
                      ),
                    },
                    {
                      title: t('admin.actionCol'),
                      width: 320,
                      render: (_, a) => (
                        <Space>
                          <Button
                            size="small"
                            type="primary"
                            icon={<CheckOutlined />}
                            onClick={() => void review(a, 'approved', '')}
                          >
                            {t('admin.approve')}
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
                            {t('admin.reject')}
                          </Button>
                          <Button
                            size="small"
                            onClick={() => {
                              warnForm.setFieldsValue({
                                adminWarning: a.adminWarning ?? '',
                                aiGenerated: a.aiGenerated ?? false,
                              });
                              modal.confirm({
                                title: t('admin.markTitle', { name: a.name }),
                                content: (
                                  <Form form={warnForm} layout="vertical">
                                    <Form.Item
                                      name="adminWarning"
                                      label={t('admin.adminWarningField')}
                                    >
                                      <Input placeholder={t('admin.adminWarningPlaceholder')} />
                                    </Form.Item>
                                    <Form.Item name="aiGenerated" valuePropName="checked">
                                      <label>
                                        <input type="checkbox" style={{ marginRight: 6 }} />
                                        {t('admin.aiGeneratedField')}
                                      </label>
                                    </Form.Item>
                                  </Form>
                                ),
                                onOk: () => saveModeration(a.id),
                              });
                            }}
                          >
                            {t('admin.mark')}
                          </Button>
                          <Button size="small" onClick={() => void openHistory(a)}>
                            {t('admin.reviewHistory')}
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
              label: t('admin.userManagement'),
              children: (
                <>
                  <Space style={{ marginBottom: 12 }}>
                    <Input
                      allowClear
                      prefix={<SearchOutlined />}
                      placeholder={t('admin.searchEmail')}
                      style={{ width: 260 }}
                      onPressEnter={(e) => {
                        setUsersSearch((e.target as HTMLInputElement).value.trim());
                        setUsersPage(1);
                      }}
                    />
                    <Button icon={<SearchOutlined />}>{t('common.search')}</Button>
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
                      { title: t('admin.uid'), dataIndex: 'userUid', width: 70 },
                      { title: t('admin.email'), dataIndex: 'email' },
                      { title: t('admin.roleCol'), width: 110, render: (_, u) => userRoleTag(u.role) },
                      { title: t('admin.banStatus'), width: 140, render: (_, u) => userBanInfo(u) },
                      {
                        title: t('admin.registerTime'),
                        dataIndex: 'createdAt',
                        width: 110,
                        render: (v: string) => new Date(v).toLocaleDateString(),
                      },
                      {
                        title: t('admin.actionCol'),
                        width: 300,
                        render: (_, u) => {
                          const banned = u.banPermanent || u.bannedUntil !== null;
                          return (
                            <Space>
                              <Popconfirm
                                title={
                                  banned ? t('admin.unbanConfirm') : t('admin.banConfirm')
                                }
                                onConfirm={() =>
                                  void patchUser(u.id, {
                                    ban: banned
                                      ? null
                                      : {
                                          permanent: false,
                                          until: new Date(Date.now() + 7 * 86400000).toISOString(),
                                          reason: t('admin.ban7days'),
                                        },
                                  })
                                }
                              >
                                <Button size="small" danger={!banned}>
                                  {banned ? t('admin.unban') : t('admin.ban7days')}
                                </Button>
                              </Popconfirm>
                              <Button
                                size="small"
                                onClick={() => {
                                  setBanTarget(u);
                                  banForm.resetFields();
                                }}
                              >
                                {t('admin.customBan')}
                              </Button>
                              {isSuper && (
                                <Select
                                  size="small"
                                  value={u.role}
                                  style={{ width: 110 }}
                                  disabled={u.id === myId}
                                  onChange={(role) => void patchUser(u.id, { role })}
                                  options={[
                                    { value: 'user', label: t('admin.normalUser') },
                                    { value: 'admin', label: t('admin.admin') },
                                    { value: 'super_admin', label: t('admin.superAdmin') },
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
        title={t('admin.rejectTitle', { name: reviewTarget?.name ?? '' })}
        open={reviewTarget !== null}
        onOk={() => reviewTarget && void review(reviewTarget, 'rejected', reviewReason)}
        onCancel={() => setReviewTarget(null)}
        okText={t('admin.confirmReject')}
        okButtonProps={{ danger: true }}
      >
        <Input.TextArea
          value={reviewReason}
          onChange={(e) => setReviewReason(e.target.value)}
          placeholder={t('admin.rejectReasonPlaceholder')}
          rows={3}
        />
      </Modal>

      {/* 审核记录弹窗 */}
      <Modal
        title={t('admin.reviewHistory')}
        open={historyTarget !== null}
        onCancel={() => setHistoryTarget(null)}
        footer={null}
      >
        {history === null ? (
          <div style={{ textAlign: 'center', padding: 24 }}>
            {t('common.loading')}
          </div>
        ) : history.length === 0 ? (
          <Empty description={t('admin.noReviews')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          <Descriptions
            column={1}
            size="small"
            bordered
            items={history.map((r) => ({
              key: r.id,
              label: new Date(r.createdAt).toLocaleString(),
              children: (
                <Space>
                  <Tag color={r.status === 'approved' ? 'green' : 'red'}>
                    {r.status === 'approved' ? t('admin.approved') : t('admin.rejected')}
                  </Tag>
                  {r.reason ? <span>{r.reason}</span> : null}
                </Space>
              ),
            }))}
          />
        )}
      </Modal>

      {/* 自定义封禁弹窗 */}
      <Modal
        title={t('admin.banUserTitle', { email: banTarget?.email ?? '' })}
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
              message.success(t('admin.banned'));
            })
            .catch(() => undefined)
        }
        onCancel={() => setBanTarget(null)}
        okText={t('admin.confirmBan')}
        okButtonProps={{ danger: true }}
      >
        <Form form={banForm} layout="vertical" initialValues={{ mode: 'temporary' }}>
          <Form.Item name="mode" label={t('admin.banTypeCol')}>
            <Select
              options={[
                { value: 'temporary', label: t('admin.temporaryBan') },
                { value: 'permanent', label: t('admin.permanentBan') },
              ]}
            />
          </Form.Item>
          <Form.Item
            name="until"
            label={t('admin.banUntilCol')}
            dependencies={['mode']}
            rules={[{ required: true, message: t('admin.banUntilCol') }]}
          >
            <Input type="datetime-local" />
          </Form.Item>
          <Form.Item name="reason" label={t('admin.banReasonCol')}>
            <Input.TextArea rows={2} placeholder={t('admin.banReasonPlaceholder')} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

export default AdminPage;
