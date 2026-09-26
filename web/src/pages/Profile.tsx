/**
 * 个人中心（plan3 UserProfile 布局）：账号信息卡（头像/邮箱/UID/角色/状态）、
 * 默认角色改名（30 天冷却）、当前皮肤 3D 预览、Yggdrasil 服务器卡片、功能区。
 * 旧版改密码/找回密码/注销账号：后端未提供，按钮以「即将上线」占位。
 */

import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Button,
  Descriptions,
  App as AntdApp,
  Tag,
  Divider,
  Typography,
  Modal,
  Form,
  Input,
  Spin,
  Alert,
  Space,
} from 'antd';
import {
  EditOutlined,
  CheckCircleOutlined,
  LinkOutlined,
  CopyOutlined,
  LockOutlined,
  KeyOutlined,
  SafetyOutlined,
} from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../api/client';
import { useAuthStore, useIsAdmin } from '../store/auth';
import { SkinAvatar } from '../components/SkinAvatar';
import { Skin3DViewer } from '../components/Skin3DViewer';
import { usePageTitle } from '../hooks/usePageTitle';
import type { ProfileRow } from '../api/types';

const { Text } = Typography;

function getRoleNameKey(role: string): string {
  switch (role) {
    case 'super_admin':
      return 'profile.superAdmin';
    case 'admin':
      return 'profile.admin';
    default:
      return 'profile.user';
  }
}

function getRoleTagColor(role: string): string {
  switch (role) {
    case 'super_admin':
      return 'red';
    case 'admin':
      return 'blue';
    default:
      return 'default';
  }
}

interface MySkin {
  profileId: string;
  profileName: string;
  skinUrl: string | null;
  model: string | null;
}

export function ProfilePage() {
  const { t } = useTranslation();
  usePageTitle(t('nav.profile'));
  const { message } = AntdApp.useApp();
  const user = useAuthStore((s) => s.user);
  const skinUrl = useAuthStore((s) => s.skinUrl);
  const isAdmin = useIsAdmin();
  const navigate = useNavigate();

  // 角色信息与当前皮肤
  const [profiles, setProfiles] = useState<ProfileRow[]>([]);
  const [mySkin, setMySkin] = useState<MySkin | null>(null);
  const [loadingProfiles, setLoadingProfiles] = useState(false);

  // 编辑名称
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [editName, setEditName] = useState('');
  const [savingName, setSavingName] = useState(false);

  // 获取角色信息和当前皮肤
  useEffect(() => {
    if (!user) return;
    const fetchProfiles = async (): Promise<void> => {
      setLoadingProfiles(true);
      try {
        const [p, s] = await Promise.all([
          api<{ profiles: ProfileRow[] }>('/api/me/profiles'),
          api<MySkin>('/api/me/skin'),
        ]);
        setProfiles(p.profiles);
        setMySkin(s);
      } catch (err) {
        console.error(t('profile.fetchProfileFailed'), err);
      } finally {
        setLoadingProfiles(false);
      }
    };
    void fetchProfiles();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  const primaryProfile = profiles[0];
  const currentGameName = primaryProfile?.name || mySkin?.profileName || '';

  // 计算改名冷却
  function getCooldownInfo(): { inCooldown: boolean; daysRemaining: number; canChangeAt?: Date } {
    const nameChangedAt = primaryProfile?.nameChangedAt;
    if (!nameChangedAt || nameChangedAt === primaryProfile?.createdAt)
      return { inCooldown: false, daysRemaining: 0 };
    const lastChanged = new Date(nameChangedAt);
    const cooldownEnd = new Date(lastChanged);
    cooldownEnd.setDate(cooldownEnd.getDate() + 30);
    const now = new Date();
    if (now < cooldownEnd) {
      const daysRemaining = Math.ceil(
        (cooldownEnd.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
      );
      return { inCooldown: true, daysRemaining, canChangeAt: cooldownEnd };
    }
    return { inCooldown: false, daysRemaining: 0 };
  }

  const cooldown = getCooldownInfo();

  const handleLogout = async () => {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch {
      // 忽略登出失败
    }
    useAuthStore.getState().clearAuth();
    message.success(t('profile.loggedOut'));
    navigate('/login');
  };

  // 保存名称
  const handleSaveName = async (): Promise<void> => {
    if (!primaryProfile?.id) {
      message.error(t('profile.noCharacterFound'));
      return;
    }
    if (!/^[a-zA-Z0-9_]{3,16}$/.test(editName)) {
      message.error(t('profiles.nameRule'));
      return;
    }
    setSavingName(true);
    try {
      await api(`/api/profiles/${primaryProfile.id}/name`, {
        method: 'POST',
        json: { name: editName },
      });
      message.success(t('profile.nameUpdated'));
      setIsEditModalOpen(false);
      const p = await api<{ profiles: ProfileRow[] }>('/api/me/profiles');
      setProfiles(p.profiles);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 429) {
          message.error(t('profile.nameChangeCooldown', { days: 30 }));
        } else {
          message.error(err.message);
        }
      } else {
        message.error(t('profile.updateFailed'));
      }
    } finally {
      setSavingName(false);
    }
  };

  // Yggdrasil API 根地址
  const yggUrl = window.location.origin;
  const authlibUrl = `authlib-injector:yggdrasil-server:${encodeURIComponent(yggUrl)}`;

  if (!user) {
    return <div style={{ padding: 20 }}>{t('profile.pleaseLoginFirst')}</div>;
  }

  const isVerified = user.emailVerified;

  return (
    <div style={{ maxWidth: 900, margin: '0 auto', padding: '20px' }}>
      <div
        style={{
          background: 'var(--bg-card)',
          border: '1px solid var(--border-color)',
          borderRadius: 12,
          padding: 24,
        }}
      >
        {/* 头部：头像 + 邮箱 + UID */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 20, marginBottom: 24 }}>
          <SkinAvatar skinUrl={skinUrl || undefined} size={80} />
          <div style={{ flex: 1 }}>
            <div
              style={{
                fontSize: 20,
                fontWeight: 'bold',
                marginBottom: 4,
                color: 'var(--text-primary)',
              }}
            >
              {currentGameName || user.email}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <Text type="secondary">
                {t('profile.uid')}: {user.userUid}
              </Text>
              <Divider type="vertical" />
              <Tag color={getRoleTagColor(user.role)}>{t(getRoleNameKey(user.role))}</Tag>
              {isVerified ? (
                <Tag color="green">{t('profile.verified')}</Tag>
              ) : (
                <Tag color="orange">{t('profile.unverified')}</Tag>
              )}
            </div>
          </div>
        </div>

        {/* 账号状态 */}
        <div
          style={{
            background: 'rgba(56, 158, 13, 0.12)',
            border: '1px solid rgba(56, 158, 13, 0.3)',
            borderRadius: 8,
            padding: '12px 16px',
            marginBottom: 24,
          }}
        >
          <Text strong style={{ color: '#95de64' }}>
            {t('profile.accountStatusNormal')}
          </Text>
        </div>

        {/* 详细信息 */}
        <Descriptions column={1} bordered size="small">
          <Descriptions.Item label={t('profile.userId')}>{user.userUid}</Descriptions.Item>
          <Descriptions.Item label={t('profile.playerName')}>
            <Space>
              <Text strong style={{ fontSize: 16 }}>
                {loadingProfiles ? <Spin size="small" /> : currentGameName || '—'}
              </Text>
              <Button
                size="small"
                icon={<EditOutlined />}
                onClick={() => {
                  setEditName(currentGameName);
                  setIsEditModalOpen(true);
                }}
              >
                {t('common.edit')}
              </Button>
            </Space>
            {cooldown.inCooldown && (
              <div style={{ marginTop: 4 }}>
                <Tag color="orange">
                  {t('profile.nameChangeCooldown', { days: cooldown.daysRemaining })}
                </Tag>
              </div>
            )}
          </Descriptions.Item>
          <Descriptions.Item label={t('profile.email')}>
            <Space>
              <Text>{user.email}</Text>
              {isVerified ? (
                <Tag color="green">{t('profile.verified')}</Tag>
              ) : (
                <Tag color="orange">{t('profile.unverified')}</Tag>
              )}
            </Space>
          </Descriptions.Item>
          <Descriptions.Item label={t('profile.role')}>
            <Tag color={getRoleTagColor(user.role)}>{t(getRoleNameKey(user.role))}</Tag>
          </Descriptions.Item>
          <Descriptions.Item label={t('profile.accountStatus')}>
            <Tag color="green">{t('profile.normal')}</Tag>
          </Descriptions.Item>
        </Descriptions>

        {/* 操作按钮 */}
        <div style={{ marginTop: 24, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <Button type="primary" onClick={() => navigate('/upload')}>
            {t('profile.uploadSkin')}
          </Button>
          <Button onClick={() => navigate('/my-skins')}>{t('profile.mySkins')}</Button>
          <Button onClick={() => navigate('/my-capes')}>{t('myCapes.title')}</Button>
          <Button onClick={() => navigate('/profiles')}>{t('profile.myCharacters')}</Button>
          {isAdmin && (
            <Button type="dashed" onClick={() => navigate('/admin')}>
              {t('profile.adminPanel')}
            </Button>
          )}
          <Button danger onClick={() => void handleLogout()} style={{ marginLeft: 'auto' }}>
            {t('profile.logout')}
          </Button>
        </div>
      </div>

      {/* 当前皮肤 3D 预览 */}
      <div
        style={{
          background: 'var(--bg-card)',
          border: '1px solid var(--border-color)',
          borderRadius: 12,
          padding: 24,
          marginTop: 20,
        }}
      >
        <div
          style={{
            fontSize: 16,
            fontWeight: 600,
            color: 'var(--text-primary)',
            marginBottom: 16,
          }}
        >
          {t('profile.currentSkinOf', { name: mySkin?.profileName ?? currentGameName ?? '-' })}
        </div>
        {mySkin?.skinUrl ? (
          <Skin3DViewer
            skinUrl={mySkin.skinUrl}
            modelType={(mySkin.model as 'default' | 'slim') ?? 'default'}
            width={280}
            height={320}
          />
        ) : (
          <div style={{ color: 'var(--text-subtle)', padding: 24, textAlign: 'center' }}>
            {t('profile.noSkinApplied')}
          </div>
        )}
      </div>

      {/* Yggdrasil 认证服务器卡片 */}
      <div
        style={{
          background: 'var(--bg-card)',
          border: '1px solid var(--border-color)',
          borderRadius: 12,
          padding: 24,
          marginTop: 20,
        }}
      >
        <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 20 }}>
          <LinkOutlined style={{ marginRight: 8 }} />
          {t('profile.addYggdrasilServer')}
        </div>

        <div
          style={{
            background: 'var(--bg-inner)',
            border: '1px dashed var(--border-color)',
            borderRadius: 12,
            padding: '32px 24px',
            textAlign: 'center',
            marginBottom: 20,
          }}
        >
          <div
            draggable={true}
            onDragStart={(e) => {
              e.dataTransfer.setData('text/plain', authlibUrl);
              e.dataTransfer.setData('text/uri-list', authlibUrl);
              e.dataTransfer.effectAllowed = 'all';
            }}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              padding: '14px 32px',
              background: '#238636',
              color: '#fff',
              borderRadius: 10,
              fontSize: 15,
              fontWeight: 600,
              textDecoration: 'none',
              cursor: 'grab',
              userSelect: 'none',
              boxShadow: '0 4px 16px rgba(35, 134, 54, 0.35)',
              transition: 'all 0.2s ease',
            }}
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M5 12h14M12 5l7 7-7 7" />
            </svg>
            {t('profile.dragToLauncher')}
          </div>
          <div style={{ marginTop: 12, fontSize: 13, color: 'var(--text-weak)' }}>
            {t('profile.supportsYggdrasil')}
          </div>
        </div>

        <Divider style={{ borderColor: 'var(--border-color)', margin: '16px 0' }} />

        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 10 }}>
            {t('profile.manualEntry')}
          </div>
          <Space.Compact style={{ width: '100%' }}>
            <Input value={yggUrl} readOnly style={{ fontFamily: 'monospace', fontSize: 13 }} />
            <Button
              icon={<CopyOutlined />}
              onClick={() => {
                void navigator.clipboard.writeText(yggUrl);
                message.success(t('profile.copied'));
              }}
            >
              {t('profile.copy')}
            </Button>
          </Space.Compact>
        </div>

        <div style={{ marginTop: 16, fontSize: 12, color: 'var(--text-subtle)', lineHeight: 1.8 }}>
          <div style={{ marginBottom: 4, fontWeight: 600, color: 'var(--text-muted)' }}>
            {t('profile.usageInstructions')}
          </div>
          <div>{t('profile.dragInstruction')}</div>
          <div>{t('profile.manualInstruction')}</div>
          <div>{t('profile.afterAdding')}</div>
        </div>
      </div>

      {/* 功能区（改密码/找回密码：后端未提供，即将上线） */}
      <div
        style={{
          background: 'rgba(82,196,26,0.06)',
          border: '1px solid rgba(82,196,26,0.3)',
          borderRadius: 12,
          padding: 24,
          marginTop: 20,
        }}
      >
        <div
          style={{
            fontSize: 16,
            fontWeight: 600,
            color: '#52c41a',
            marginBottom: 16,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <SafetyOutlined />
          {t('profile.securityZone')}
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16, lineHeight: 1.8 }}>
          <div>{t('profile.manageSecurity')}</div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 320 }}>
          <Button
            icon={<LockOutlined />}
            size="large"
            style={{ fontWeight: 500, justifyContent: 'flex-start' }}
            onClick={() => message.info(t('common.comingSoon'))}
          >
            {t('profile.modifyPassword')}
            <Tag color="orange" style={{ marginLeft: 'auto' }}>
              {t('common.comingSoon')}
            </Tag>
          </Button>
          <Button
            icon={<KeyOutlined />}
            size="large"
            style={{ fontWeight: 500, justifyContent: 'flex-start' }}
            onClick={() => message.info(t('common.comingSoon'))}
          >
            {t('profile.recoverPassword')}
            <Tag color="orange" style={{ marginLeft: 'auto' }}>
              {t('common.comingSoon')}
            </Tag>
          </Button>
        </div>
      </div>

      {/* 编辑名称弹窗 */}
      <Modal
        title={t('profile.editPlayerName')}
        open={isEditModalOpen}
        onCancel={() => setIsEditModalOpen(false)}
        footer={[
          <Button key="cancel" onClick={() => setIsEditModalOpen(false)}>
            {t('common.cancel')}
          </Button>,
          <Button
            key="save"
            type="primary"
            loading={savingName}
            disabled={cooldown.inCooldown}
            onClick={() => void handleSaveName()}
          >
            {t('common.save')}
          </Button>,
        ]}
      >
        {cooldown.inCooldown && (
          <Alert
            type="warning"
            message={t('profile.nameChangeCooldown', { days: cooldown.daysRemaining })}
            description={`${t('profile.canChangeNameAt')}：${cooldown.canChangeAt?.toLocaleDateString()}`}
            style={{ marginBottom: 16 }}
            showIcon
          />
        )}

        <Form layout="vertical">
          <Form.Item label={t('profile.currentName')}>
            <Input value={currentGameName} disabled />
          </Form.Item>
          <Form.Item label={t('profile.newName')}>
            <Input
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              placeholder={t('profile.nameLengthHint')}
              maxLength={16}
              disabled={cooldown.inCooldown}
            />
          </Form.Item>
        </Form>

        <div style={{ marginTop: 8 }}>
          <Alert
            type="info"
            icon={<CheckCircleOutlined />}
            message={t('profiles.renameCooldownHint')}
            showIcon
          />
        </div>
      </Modal>
    </div>
  );
}
