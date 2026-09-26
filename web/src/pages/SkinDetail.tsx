/**
 * 皮肤详情页（plan3 SkinDetail 结构）：大 3D 预览区 + 信息侧栏 + 收藏/下载按钮 + 返回列表。
 * API 适配 MSCTS：GET /api/assets/:id、favorite、download、admin PATCH。
 */

import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import {
  Button,
  Tag,
  Card,
  Descriptions,
  Spin,
  App as AntdApp,
  Space,
  Divider,
  Typography,
  Alert,
  Switch,
  Modal,
  Input,
} from 'antd';
import {
  ArrowLeftOutlined,
  DownloadOutlined,
  HeartOutlined,
  HeartFilled,
  StarOutlined,
} from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../api/client';
import { useAuthStore, useIsAdmin } from '../store/auth';
import { Skin3DViewer } from '../components/Skin3DViewer';
import { usePageTitle } from '../hooks/usePageTitle';
import type { AssetItem } from '../api/types';

const { Text, Paragraph } = Typography;

export function SkinDetail() {
  const { t } = useTranslation();
  usePageTitle(t('detail.skinTitle'));
  const { message } = AntdApp.useApp();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const token = useAuthStore((s) => s.token);
  const isAuthenticated = token !== null;
  const isAdmin = useIsAdmin();

  const [asset, setAsset] = useState<AssetItem | null>(null);
  const [canDownload, setCanDownload] = useState(false);
  const [loading, setLoading] = useState(true);
  const [favoriteCount, setFavoriteCount] = useState(0);
  const [isFavoritedByUser, setIsFavoritedByUser] = useState(false);
  const [warningModalVisible, setWarningModalVisible] = useState(false);
  const [warningText, setWarningText] = useState('');

  const assetId = id || '';

  const handleBack = useCallback(() => {
    const s = location.state as { returnTab?: string; returnPage?: number } | null;
    if (s?.returnTab) {
      const params = new URLSearchParams();
      params.set('tab', s.returnTab);
      if (s.returnPage && s.returnPage > 1) params.set(`${s.returnTab}Page`, String(s.returnPage));
      navigate(`/library?${params.toString()}`);
    } else {
      navigate('/library');
    }
  }, [location.state, navigate]);

  useEffect(() => {
    let cancelled = false;
    const loadAssetDetail = async (): Promise<void> => {
      setLoading(true);
      try {
        const data = await api<{ asset: AssetItem; isFavorited: boolean; canDownload: boolean }>(
          `/api/assets/${assetId}`,
        );
        if (cancelled) return;
        setAsset(data.asset);
        setCanDownload(data.canDownload);
        setIsFavoritedByUser(data.isFavorited);
      } catch (err) {
        console.error('Failed to load asset detail:', err);
        if (!cancelled) message.error(t('detail.loadFailed'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void loadAssetDetail();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assetId]);

  useEffect(() => {
    if (!asset) return;
    let cancelled = false;
    const loadFavoriteStatus = async (): Promise<void> => {
      try {
        const res = await api<{ favoriteCount: number }>(`/api/assets/${assetId}/favorite-count`);
        if (!cancelled) setFavoriteCount(res.favoriteCount || 0);
      } catch {
        /* 计数失败不影响主流程 */
      }
    };
    void loadFavoriteStatus();
    return () => {
      cancelled = true;
    };
  }, [asset, assetId]);

  const handleDownload = async (): Promise<void> => {
    try {
      const res = await api<{ url: string }>(`/api/assets/${assetId}/download`);
      window.open(res.url, '_blank');
      message.success(t('detail.downloadSuccess'));
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : t('detail.downloadFailed'));
    }
  };

  const handleFavorite = async (): Promise<void> => {
    if (!isAuthenticated || !token) {
      message.info(t('detail.loginToFavorite'));
      return;
    }

    try {
      if (isFavoritedByUser) {
        await api(`/api/assets/${assetId}/favorite`, { method: 'DELETE' });
        setIsFavoritedByUser(false);
        setFavoriteCount((c) => Math.max(0, c - 1));
        message.success(t('detail.unfavorited'));
      } else {
        await api(`/api/assets/${assetId}/favorite`, { method: 'POST' });
        setIsFavoritedByUser(true);
        setFavoriteCount((c) => c + 1);
        message.success(t('detail.favoritedSuccess'));
      }
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : t('detail.operationFailed'));
    }
  };

  const toggleAiMark = async (checked: boolean): Promise<void> => {
    try {
      await api(`/api/admin/assets/${assetId}`, {
        method: 'PATCH',
        json: { aiGenerated: checked },
      });
      if (asset) setAsset({ ...asset, aiGenerated: checked });
      message.success(checked ? t('detail.markedAsAi') : t('detail.unmarkedAsAi'));
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : t('detail.operationFailed'));
    }
  };

  const handleAddWarning = async (): Promise<void> => {
    if (!warningText.trim()) return;
    try {
      await api(`/api/admin/assets/${assetId}`, {
        method: 'PATCH',
        json: { adminWarning: warningText.trim() },
      });
      if (asset) setAsset({ ...asset, adminWarning: warningText.trim() });
      message.success(t('detail.warningAdded'));
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : t('detail.operationFailed'));
    } finally {
      setWarningModalVisible(false);
    }
  };

  const handleRemoveWarning = async (): Promise<void> => {
    try {
      await api(`/api/admin/assets/${assetId}`, {
        method: 'PATCH',
        json: { adminWarning: null },
      });
      if (asset) setAsset({ ...asset, adminWarning: null });
      message.success(t('detail.warningRemoved'));
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : t('detail.operationFailed'));
    }
  };

  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: 50 }}>
        <Spin size="large" />
      </div>
    );
  }

  if (!asset) {
    return <div>{t('detail.skinNotFound')}</div>;
  }

  const isShownAsFavorited = isFavoritedByUser;

  return (
    <div style={{ padding: '20px' }}>
      <Button
        type="text"
        icon={<ArrowLeftOutlined />}
        onClick={handleBack}
        style={{ marginBottom: 20 }}
      >
        {t('detail.backToLibrary')}
      </Button>

      <div style={{ display: 'flex', gap: 40, flexWrap: 'wrap' }}>
        {/* 左侧：3D预览 */}
        <div style={{ flex: '0 0 auto' }}>
          <Skin3DViewer
            skinUrl={asset.previewUrl ?? '/steve.png'}
            modelType={asset.modelType === 'slim' ? 'slim' : 'default'}
            width={350}
            height={400}
          />
        </div>

        {/* 右侧：皮肤详情 */}
        <div style={{ flex: 1, minWidth: 300 }}>
          <h2 style={{ marginBottom: 12 }}>{asset.name || t('wardrobe.unnamedSkin')}</h2>

          {/* 操作按钮 */}
          <Space style={{ marginBottom: 16 }}>
            <Button
              type={isShownAsFavorited ? 'primary' : 'default'}
              icon={isShownAsFavorited ? <HeartFilled /> : <HeartOutlined />}
              onClick={() => void handleFavorite()}
            >
              {isShownAsFavorited ? t('detail.favorited') : t('detail.favorite')}
            </Button>
            {canDownload && (
              <Button
                type="primary"
                icon={<DownloadOutlined />}
                onClick={() => void handleDownload()}
              >
                {t('detail.download')}
              </Button>
            )}
          </Space>

          {/* 统计信息 */}
          <div style={{ marginBottom: 16, display: 'flex', gap: 20, flexWrap: 'wrap' }}>
            <Text type="secondary">
              <HeartOutlined style={{ marginRight: 4 }} />
              {t('detail.favoriteCount', { count: favoriteCount })}
            </Text>
            <Text type="secondary">
              <DownloadOutlined style={{ marginRight: 4 }} />
              {t('detail.downloadCount', { count: asset.downloadCount ?? 0 })}
            </Text>
            <Text type="secondary">
              <StarOutlined style={{ marginRight: 4 }} />
              {t('detail.viewCount', { count: asset.viewCount ?? 0 })}
            </Text>
          </div>

          <Divider style={{ margin: '12px 0' }} />

          {/* 详细信息表格 */}
          <Descriptions column={1} bordered size="small">
            <Descriptions.Item label={t('detail.type')}>
              <Tag color="blue">{t('nav.skin')}</Tag>
            </Descriptions.Item>
            <Descriptions.Item label={t('detail.modelType')}>
              {asset.modelType === 'slim' ? t('wardrobe.slim') : t('wardrobe.classic')}
            </Descriptions.Item>
            <Descriptions.Item label={t('detail.license')}>
              {asset.license ?? '-'}
            </Descriptions.Item>
            <Descriptions.Item label={t('detail.downloadPolicy')}>
              {asset.downloadPolicy === 'public'
                ? t('detail.downloadPublic')
                : t('detail.downloadOwnerOnly')}
            </Descriptions.Item>
            <Descriptions.Item label={t('detail.approvalStatus')}>
              {asset.reviewStatus === 'pending' && <Tag color="orange">{t('detail.pending')}</Tag>}
              {asset.reviewStatus === 'approved' && <Tag color="green">{t('detail.approved')}</Tag>}
              {asset.reviewStatus === 'rejected' && <Tag color="red">{t('detail.rejected')}</Tag>}
            </Descriptions.Item>
          </Descriptions>

          {/* 管理员操作区 */}
          {isAdmin && (
            <Card size="small" style={{ marginTop: 16 }}>
              <div style={{ marginBottom: 8 }}>
                <b>{t('detail.adminActions')}</b>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <span>{t('detail.aiGeneratedMark')}</span>
                <Switch
                  checked={!!asset.aiGenerated}
                  onChange={(checked) => void toggleAiMark(checked)}
                />
                {asset.adminWarning ? (
                  <Button size="small" danger onClick={() => void handleRemoveWarning()}>
                    {t('detail.removeWarning')}
                  </Button>
                ) : (
                  <Button
                    size="small"
                    danger
                    onClick={() => {
                      setWarningText('');
                      setWarningModalVisible(true);
                    }}
                  >
                    {t('detail.addWarning')}
                  </Button>
                )}
              </div>
            </Card>
          )}

          {/* 红色警告 */}
          {asset.adminWarning && (
            <Alert
              type="error"
              showIcon
              message={t('detail.adminWarning')}
              description={asset.adminWarning}
              style={{ marginTop: 16 }}
            />
          )}

          {/* 简介卡片 */}
          {asset.description && (
            <Card size="small" style={{ marginTop: 16 }} title={t('detail.description')}>
              <Paragraph style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
                {asset.description}
              </Paragraph>
            </Card>
          )}
        </div>
      </div>

      <Modal
        title={t('detail.addAdminWarning')}
        open={warningModalVisible}
        onOk={() => void handleAddWarning()}
        onCancel={() => setWarningModalVisible(false)}
        okText={t('app.confirm')}
        cancelText={t('app.cancel')}
        destroyOnClose
      >
        <Input.TextArea
          rows={4}
          placeholder={t('detail.warningPlaceholder')}
          value={warningText}
          onChange={(e) => setWarningText(e.target.value)}
        />
      </Modal>
    </div>
  );
}
