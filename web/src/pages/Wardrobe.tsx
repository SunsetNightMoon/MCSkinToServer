/**
 * 衣柜（plan3 Wardrobe 结构）：左侧 3D 组合预览，右侧皮肤/披风选择区
 * （我的/收藏 Tab、卡片网格、应用/移除按钮）。应用走 MSCTS apply 端点。
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Row,
  Col,
  Card,
  Tag,
  Spin,
  Empty,
  Button,
  App as AntdApp,
  Space,
  Radio,
  Pagination,
  Select,
} from 'antd';
import { CheckOutlined, DeleteOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../api/client';
import { useAuthStore } from '../store/auth';
import { usePageTitle } from '../hooks/usePageTitle';
import { Skin3DViewer } from '../components/Skin3DViewer';
import { SkinThumbnail3D } from '../components/SkinThumbnail3D';
import type { AssetItem, ProfileRow } from '../api/types';

function useViewportSize() {
  const [size, setSize] = useState({ width: window.innerWidth, height: window.innerHeight });
  useEffect(() => {
    const onResize = () => setSize({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return size;
}

type ListTab = 'mine' | 'favorites';

const PAGE_SIZE = 8;

export function WardrobePage() {
  const { t } = useTranslation();
  usePageTitle(t('nav.wardrobe'));
  const { message } = AntdApp.useApp();
  const token = useAuthStore((s) => s.token);
  const setSkinUrl = useAuthStore((s) => s.setSkinUrl);

  // 数据列表
  const [skins, setSkins] = useState<AssetItem[]>([]);
  const [capes, setCapes] = useState<AssetItem[]>([]);
  const [favoritedSkins, setFavoritedSkins] = useState<AssetItem[]>([]);
  const [favoritedCapes, setFavoritedCapes] = useState<AssetItem[]>([]);

  // 加载状态
  const [loadingSkins, setLoadingSkins] = useState(true);
  const [loadingCapes, setLoadingCapes] = useState(true);
  const [loadingProfiles, setLoadingProfiles] = useState(true);
  const [loadingFavoritedSkins, setLoadingFavoritedSkins] = useState(false);
  const [loadingFavoritedCapes, setLoadingFavoritedCapes] = useState(false);

  // 错误状态
  const [skinsError, setSkinsError] = useState<string | null>(null);
  const [capesError, setCapesError] = useState<string | null>(null);

  // 应用状态
  const [applyingSkin, setApplyingSkin] = useState(false);
  const [applyingCape, setApplyingCape] = useState(false);

  // 当前选中的 ID
  const [selectedSkinId, setSelectedSkinId] = useState<string | null>(null);
  const [selectedCapeId, setSelectedCapeId] = useState<string | null>(null);

  // 角色列表与当前角色
  const [profiles, setProfiles] = useState<ProfileRow[]>([]);
  const [currentProfileId, setCurrentProfileId] = useState<string | null>(null);
  // 当前默认角色已应用的皮肤（用于「使用中」标记）
  const [appliedSkinUrl, setAppliedSkinUrl] = useState<string | null>(null);

  // Tab 状态
  const [skinTab, setSkinTab] = useState<ListTab>('mine');
  const [capeTab, setCapeTab] = useState<ListTab>('mine');

  // 分页状态
  const [skinPage, setSkinPage] = useState(1);
  const [capePage, setCapePage] = useState(1);

  const { width: vw } = useViewportSize();
  const viewerSize = useMemo(() => {
    if (vw < 420) return { width: 260, height: 300 };
    if (vw < 576) return { width: 280, height: 320 };
    if (vw < 768) return { width: 320, height: 360 };
    return { width: 360, height: 400 };
  }, [vw]);

  const currentProfile = useMemo(
    () => profiles.find((p) => p.id === currentProfileId) ?? profiles[0] ?? null,
    [profiles, currentProfileId],
  );

  // ======================== 数据加载 ========================

  // 加载角色列表 + 当前默认角色皮肤
  useEffect(() => {
    if (!token) {
      setLoadingProfiles(false);
      setLoadingSkins(false);
      setLoadingCapes(false);
      return;
    }

    void (async () => {
      try {
        const [p, s] = await Promise.all([
          api<{ profiles: ProfileRow[] }>('/api/me/profiles'),
          api<{ skinUrl: string | null; model: string | null }>('/api/me/skin'),
        ]);
        setProfiles(p.profiles);
        setCurrentProfileId(p.profiles[0]?.id ?? null);
        setAppliedSkinUrl(s.skinUrl);
      } catch (err) {
        console.error('加载角色信息失败:', err);
      } finally {
        setLoadingProfiles(false);
      }
    })();
  }, [token]);

  // 加载我的皮肤和披风
  useEffect(() => {
    if (!token) return;

    void (async () => {
      setLoadingSkins(true);
      setSkinsError(null);
      try {
        const res = await api<{ assets: AssetItem[] }>('/api/me/assets?kind=skin');
        setSkins(res.assets);
      } catch (err) {
        console.error('加载皮肤失败:', err);
        setSkinsError(err instanceof ApiError ? err.message : t('common.requestFailed'));
      } finally {
        setLoadingSkins(false);
      }
    })();

    void (async () => {
      setLoadingCapes(true);
      setCapesError(null);
      try {
        const res = await api<{ assets: AssetItem[] }>('/api/me/assets?kind=cape');
        setCapes(res.assets);
      } catch (err) {
        console.error('加载披风失败:', err);
        setCapesError(err instanceof ApiError ? err.message : t('common.requestFailed'));
      } finally {
        setLoadingCapes(false);
      }
    })();
  }, [token, t]);

  // 加载收藏（懒加载，切换 tab 时加载）
  const loadFavoritedSkins = useCallback(async (): Promise<void> => {
    if (!token) return;
    setLoadingFavoritedSkins(true);
    try {
      const res = await api<{ favorites: AssetItem[] }>('/api/me/favorites?kind=skin');
      setFavoritedSkins(res.favorites);
    } catch (err) {
      console.error('加载收藏皮肤失败:', err);
      message.error(err instanceof ApiError ? err.message : t('wardrobe.loadFavoritedSkinsFailed'));
    } finally {
      setLoadingFavoritedSkins(false);
    }
  }, [token, message, t]);

  const loadFavoritedCapes = useCallback(async (): Promise<void> => {
    if (!token) return;
    setLoadingFavoritedCapes(true);
    try {
      const res = await api<{ favorites: AssetItem[] }>('/api/me/favorites?kind=cape');
      setFavoritedCapes(res.favorites);
    } catch (err) {
      console.error('加载收藏披风失败:', err);
      message.error(err instanceof ApiError ? err.message : t('wardrobe.loadFavoritedCapesFailed'));
    } finally {
      setLoadingFavoritedCapes(false);
    }
  }, [token, message, t]);

  // Tab 切换时加载对应收藏数据 + 重置页码
  useEffect(() => {
    if (skinTab === 'favorites') void loadFavoritedSkins();
    setSkinPage(1);
  }, [skinTab, loadFavoritedSkins]);

  useEffect(() => {
    if (capeTab === 'favorites') void loadFavoritedCapes();
    setCapePage(1);
  }, [capeTab, loadFavoritedCapes]);

  // ======================== 3D 预览数据 ========================

  const selectedSkin = useMemo(() => {
    if (selectedSkinId === null) return null;
    return (
      skins.find((s) => s.id === selectedSkinId) ??
      favoritedSkins.find((s) => s.id === selectedSkinId) ??
      null
    );
  }, [selectedSkinId, skins, favoritedSkins]);

  const selectedCape = useMemo(() => {
    if (selectedCapeId === null) return null;
    return (
      capes.find((c) => c.id === selectedCapeId) ??
      favoritedCapes.find((c) => c.id === selectedCapeId) ??
      null
    );
  }, [selectedCapeId, capes, favoritedCapes]);

  const skinUrl = selectedSkin?.previewUrl ?? '/steve.png';
  const capeUrl = selectedCape?.previewUrl ?? null;
  const modelType = selectedSkin?.modelType === 'slim' ? 'slim' : 'default';

  // ======================== 应用 / 移除 ========================

  const handleApplySkin = async (): Promise<void> => {
    if (!currentProfile || selectedSkinId === null) return;
    setApplyingSkin(true);
    try {
      await api(`/api/assets/${selectedSkinId}/apply`, {
        method: 'POST',
        json: { profileId: currentProfile.id, slot: 'skin' },
      });
      message.success(t('wardrobe.skinApplied'));
      const applied =
        skins.find((s) => s.id === selectedSkinId) ??
        favoritedSkins.find((s) => s.id === selectedSkinId);
      setAppliedSkinUrl(applied?.previewUrl ?? null);
      if (applied?.previewUrl) setSkinUrl(applied.previewUrl);
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : t('wardrobe.applySkinFailed'));
    } finally {
      setApplyingSkin(false);
    }
  };

  const handleApplyCape = async (): Promise<void> => {
    if (!currentProfile || selectedCapeId === null) return;
    setApplyingCape(true);
    try {
      await api(`/api/assets/${selectedCapeId}/apply`, {
        method: 'POST',
        json: { profileId: currentProfile.id, slot: 'cape' },
      });
      message.success(t('wardrobe.capeApplied'));
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : t('wardrobe.applyCapeFailed'));
    } finally {
      setApplyingCape(false);
    }
  };

  const handleRemoveSkin = async (): Promise<void> => {
    if (!currentProfile) return;
    // remove 端点按素材 ID 调用：根据已应用皮肤 URL 反查素材
    const appliedAsset =
      skins.find((s) => s.previewUrl != null && s.previewUrl === appliedSkinUrl) ??
      favoritedSkins.find((s) => s.previewUrl != null && s.previewUrl === appliedSkinUrl);
    if (!appliedAsset) {
      message.error(t('wardrobe.removeSkinFailed'));
      return;
    }
    setApplyingSkin(true);
    try {
      await api(`/api/assets/${appliedAsset.id}/remove`, { method: 'POST' });
      message.success(t('wardrobe.skinRemoved'));
      setSelectedSkinId(null);
      setAppliedSkinUrl(null);
      setSkinUrl(null);
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : t('wardrobe.removeSkinFailed'));
    } finally {
      setApplyingSkin(false);
    }
  };

  // ======================== 点击卡片 ========================

  const handleSkinCardClick = useCallback((skinId: string) => {
    setSelectedSkinId((prev) => (prev === skinId ? null : skinId));
  }, []);

  const handleCapeCardClick = useCallback((capeId: string) => {
    setSelectedCapeId((prev) => (prev === capeId ? null : capeId));
  }, []);

  // ======================== 渲染辅助 ========================

  const isSkinApplied = selectedSkin?.previewUrl != null && appliedSkinUrl === selectedSkin.previewUrl;

  const displayedSkins = skinTab === 'mine' ? skins : favoritedSkins;
  // 收藏的披风中，过滤掉「我的披风」（已上传的不要重复出现在收藏页）
  const favoritedCapesFiltered = useMemo(() => {
    const myCapeIds = new Set(capes.map((c) => c.id));
    return favoritedCapes.filter((c) => !myCapeIds.has(c.id));
  }, [capes, favoritedCapes]);

  const displayedCapes = capeTab === 'mine' ? capes : favoritedCapesFiltered;

  const isLoadingSkins = skinTab === 'mine' ? loadingSkins : loadingFavoritedSkins;
  const isLoadingCapes = capeTab === 'mine' ? loadingCapes : loadingFavoritedCapes;

  const paginatedSkins = useMemo(() => {
    const start = (skinPage - 1) * PAGE_SIZE;
    return displayedSkins.slice(start, start + PAGE_SIZE);
  }, [displayedSkins, skinPage]);

  const paginatedCapes = useMemo(() => {
    const start = (capePage - 1) * PAGE_SIZE;
    return displayedCapes.slice(start, start + PAGE_SIZE);
  }, [displayedCapes, capePage]);

  const renderSkinCard = (skin: AssetItem) => {
    const isSelected = selectedSkinId === skin.id;
    const isApplied = skin.previewUrl != null && appliedSkinUrl === skin.previewUrl;
    return (
      <Col key={skin.id} xs={12} sm={8} md={6}>
        <Card
          hoverable
          size="small"
          onClick={() => handleSkinCardClick(skin.id)}
          style={{
            border: isSelected
              ? '2px solid #4f46e5'
              : isApplied
                ? '2px solid #52c41a'
                : '1px solid var(--border-color)',
            cursor: 'pointer',
            position: 'relative',
            height: 200,
          }}
          styles={{
            body: {
              padding: 8,
              height: '100%',
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'space-between',
            },
          }}
        >
          {isApplied && (
            <div
              style={{
                position: 'absolute',
                top: 4,
                right: 4,
                background: '#52c41a',
                color: '#fff',
                fontSize: 10,
                padding: '1px 6px',
                borderRadius: 10,
                zIndex: 1,
                lineHeight: '16px',
              }}
            >
              {t('wardrobe.inUse')}
            </div>
          )}
          <div
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              minHeight: 0,
            }}
          >
            <SkinThumbnail3D
              skinUrl={skin.previewUrl ?? '/steve.png'}
              modelType={skin.modelType === 'slim' ? 'slim' : 'default'}
              width={100}
              height={120}
            />
          </div>
          <div>
            <div
              style={{
                fontSize: 11,
                textAlign: 'center',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {skin.name || t('wardrobe.unnamedSkin')}
            </div>
            <div style={{ textAlign: 'center', marginTop: 4 }}>
              <Tag color={skin.modelType === 'slim' ? 'blue' : 'default'} style={{ margin: 0 }}>
                {skin.modelType === 'slim' ? t('wardrobe.slim') : t('wardrobe.classic')}
              </Tag>
            </div>
          </div>
        </Card>
      </Col>
    );
  };

  const renderCapeCard = (cape: AssetItem) => {
    const isSelected = selectedCapeId === cape.id;
    return (
      <Col key={cape.id} xs={12} sm={8} md={6}>
        <Card
          hoverable
          size="small"
          onClick={() => handleCapeCardClick(cape.id)}
          style={{
            border: isSelected ? '2px solid #4f46e5' : '1px solid var(--border-color)',
            cursor: 'pointer',
            position: 'relative',
            height: 200,
          }}
          styles={{
            body: {
              padding: 8,
              height: '100%',
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'space-between',
            },
          }}
        >
          <div
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              minHeight: 0,
            }}
          >
            <SkinThumbnail3D
              skinUrl="/steve.png"
              capeUrl={cape.previewUrl ?? undefined}
              modelType="default"
              width={100}
              height={120}
            />
          </div>
          <div>
            <div
              style={{
                fontSize: 11,
                textAlign: 'center',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {cape.name || t('wardrobe.unnamedCape')}
            </div>
            <div style={{ textAlign: 'center', marginTop: 4 }}>
              {cape.reviewStatus === 'pending' && (
                <Tag color="orange" style={{ margin: 0 }}>
                  {t('wardrobe.pending')}
                </Tag>
              )}
              {cape.reviewStatus === 'rejected' && (
                <Tag color="red" style={{ margin: 0 }}>
                  {t('wardrobe.rejected')}
                </Tag>
              )}
              {cape.reviewStatus === 'approved' && <Tag style={{ margin: 0 }}>OK</Tag>}
            </div>
          </div>
        </Card>
      </Col>
    );
  };

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto', padding: '0 0 20px 0' }}>
      {/* 标题和当前角色 */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 16,
          flexWrap: 'wrap',
          gap: 8,
        }}
      >
        <h2 style={{ margin: 0 }}>{t('wardrobe.myWardrobe')}</h2>
        <Space>
          {profiles.length > 1 && (
            <Select
              size="small"
              value={currentProfile?.id}
              onChange={setCurrentProfileId}
              style={{ minWidth: 140 }}
              options={profiles.map((p) => ({ value: p.id, label: p.name }))}
            />
          )}
          {currentProfile && (
            <Tag color="blue" icon={<CheckOutlined />}>
              {t('wardrobe.currentProfile')}: {currentProfile.name}
            </Tag>
          )}
        </Space>
      </div>

      <div style={{ display: 'flex', flexDirection: 'row', gap: 24, flexWrap: 'wrap' }}>
        {/* 左侧 3D 预览 */}
        <div style={{ flex: '0 0 auto' }}>
          <Skin3DViewer
            key={`${skinUrl}-${capeUrl}`}
            skinUrl={skinUrl}
            capeUrl={capeUrl}
            modelType={modelType}
            width={viewerSize.width}
            height={viewerSize.height}
          />
          <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-muted)', textAlign: 'center' }}>
            {selectedSkin || selectedCape
              ? t('wardrobe.previewCombined')
              : t('wardrobe.selectToPreview')}
          </div>
        </div>

        {/* 右侧选择区 */}
        <div style={{ flex: '1 1 400px', minWidth: 300 }}>
          {/* ===== 皮肤选择 ===== */}
          <div style={{ marginBottom: 24 }}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: 12,
              }}
            >
              <h3 style={{ margin: 0, color: 'var(--text-primary)' }}>{t('wardrobe.selectSkin')}</h3>
              <Space>
                {selectedSkinId !== null && !isSkinApplied && (
                  <Button
                    type="primary"
                    size="small"
                    icon={<CheckOutlined />}
                    loading={applyingSkin}
                    onClick={() => void handleApplySkin()}
                  >
                    {t('wardrobe.apply')}
                  </Button>
                )}
                {isSkinApplied && <Tag color="success">{t('wardrobe.applied')}</Tag>}
                {appliedSkinUrl && (
                  <Button
                    type="text"
                    danger
                    size="small"
                    icon={<DeleteOutlined />}
                    loading={applyingSkin}
                    onClick={() => void handleRemoveSkin()}
                  >
                    {t('wardrobe.remove')}
                  </Button>
                )}
              </Space>
            </div>

            <Radio.Group
              value={skinTab}
              onChange={(e) => {
                setSkinTab(e.target.value);
                setSkinPage(1);
              }}
              size="small"
              style={{ marginBottom: 12 }}
            >
              <Radio.Button value="mine">{t('wardrobe.mySkins')}</Radio.Button>
              <Radio.Button value="favorites">{t('wardrobe.favoritedSkins')}</Radio.Button>
            </Radio.Group>

            {isLoadingSkins || loadingProfiles ? (
              <div style={{ textAlign: 'center', padding: 20 }}>
                <Spin />
              </div>
            ) : skinTab === 'mine' && skinsError ? (
              <Empty
                description={
                  <div>
                    <div style={{ color: '#ff4d4f', marginBottom: 8 }}>
                      {t('common.loadFailed')}: {skinsError}
                    </div>
                    <Button size="small" onClick={() => window.location.reload()}>
                      {t('common.retry')}
                    </Button>
                  </div>
                }
                image={Empty.PRESENTED_IMAGE_SIMPLE}
              />
            ) : displayedSkins.length === 0 ? (
              <Empty
                description={
                  skinTab === 'mine' ? t('wardrobe.noSkins') : t('wardrobe.noFavoritedSkins')
                }
                image={Empty.PRESENTED_IMAGE_SIMPLE}
              />
            ) : (
              <>
                <Row gutter={[8, 8]}>{paginatedSkins.map(renderSkinCard)}</Row>
                {displayedSkins.length > PAGE_SIZE && (
                  <div style={{ textAlign: 'center', marginTop: 12 }}>
                    <Pagination
                      current={skinPage}
                      pageSize={PAGE_SIZE}
                      total={displayedSkins.length}
                      onChange={setSkinPage}
                      size="small"
                      showSizeChanger={false}
                    />
                  </div>
                )}
              </>
            )}
          </div>

          {/* ===== 披风选择 ===== */}
          <div>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: 12,
              }}
            >
              <h3 style={{ margin: 0, color: 'var(--text-primary)' }}>{t('wardrobe.selectCape')}</h3>
              <Space>
                {selectedCapeId !== null && (
                  <Button
                    type="primary"
                    size="small"
                    icon={<CheckOutlined />}
                    loading={applyingCape}
                    onClick={() => void handleApplyCape()}
                  >
                    {t('wardrobe.apply')}
                  </Button>
                )}
              </Space>
            </div>

            <Radio.Group
              value={capeTab}
              onChange={(e) => {
                setCapeTab(e.target.value);
                setCapePage(1);
              }}
              size="small"
              style={{ marginBottom: 12 }}
            >
              <Radio.Button value="mine">{t('wardrobe.myCapes')}</Radio.Button>
              <Radio.Button value="favorites">{t('wardrobe.favoritedCapes')}</Radio.Button>
            </Radio.Group>

            {isLoadingCapes || loadingProfiles ? (
              <div style={{ textAlign: 'center', padding: 20 }}>
                <Spin />
              </div>
            ) : capeTab === 'mine' && capesError ? (
              <Empty
                description={
                  <div>
                    <div style={{ color: '#ff4d4f', marginBottom: 8 }}>
                      {t('common.loadFailed')}: {capesError}
                    </div>
                    <Button size="small" onClick={() => window.location.reload()}>
                      {t('common.retry')}
                    </Button>
                  </div>
                }
                image={Empty.PRESENTED_IMAGE_SIMPLE}
              />
            ) : displayedCapes.length === 0 ? (
              <Empty
                description={
                  capeTab === 'mine' ? t('wardrobe.noCapes') : t('wardrobe.noFavoritedCapes')
                }
                image={Empty.PRESENTED_IMAGE_SIMPLE}
              />
            ) : (
              <>
                <Row gutter={[8, 8]}>{paginatedCapes.map(renderCapeCard)}</Row>
                {displayedCapes.length > PAGE_SIZE && (
                  <div style={{ textAlign: 'center', marginTop: 12 }}>
                    <Pagination
                      current={capePage}
                      pageSize={PAGE_SIZE}
                      total={displayedCapes.length}
                      onChange={setCapePage}
                      size="small"
                      showSizeChanger={false}
                    />
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
