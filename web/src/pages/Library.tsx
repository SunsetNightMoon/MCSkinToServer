/**
 * 公开素材库（plan3 设计）：类型筛选 + 搜索 + 排序 + 卡片网格 + 详情 Modal（3D/收藏/下载）
 * 「我的收藏」页签复用同款卡片。
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Select,
  Pagination,
  Modal,
  Button,
  Tag,
  Space,
  App as AntdApp,
  Typography,
  Descriptions,
  Empty,
  Spin,
  Input,
  Tabs,
} from 'antd';
import { DownloadOutlined, StarOutlined, StarFilled, SearchOutlined } from '@ant-design/icons';
import { api, ApiError } from '../api/client';
import { useAuthStore } from '../store/auth';
import { Skin3DViewer } from '../components/Skin3DViewer';
import type { LibraryPageDto, AssetDetailDto, AssetItem } from '../api/types';

type Kind = 'skin' | 'cape';
type Sort = 'latest' | 'views' | 'downloads';

export function LibraryPage() {
  const { message } = AntdApp.useApp();
  const token = useAuthStore((s) => s.token);
  const [kind, setKind] = useState<Kind>('skin');
  const [sort, setSort] = useState<Sort>('latest');
  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const pageSize = 20;
  const [data, setData] = useState<LibraryPageDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState<AssetDetailDto | null>(null);
  const [tab, setTab] = useState('public');

  // 我的收藏
  const [favs, setFavs] = useState<AssetItem[]>([]);
  const [favsLoading, setFavsLoading] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const res = await api<LibraryPageDto>(
        `/api/library?kind=${kind}&page=${page}&pageSize=${pageSize}&sort=${sort}${search ? `&search=${encodeURIComponent(search)}` : ''}`,
      );
      setData(res);
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '加载公开库失败');
    } finally {
      setLoading(false);
    }
  }, [kind, page, sort, search, message]);

  const loadFavs = useCallback(async (): Promise<void> => {
    if (!token) return;
    setFavsLoading(true);
    try {
      const res = await api<{ favorites: AssetItem[] }>(`/api/me/favorites?kind=${kind}`);
      setFavs(res.favorites);
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '加载收藏失败');
    } finally {
      setFavsLoading(false);
    }
  }, [token, kind, message]);

  useEffect(() => {
    if (tab === 'public') void load();
  }, [tab, load]);

  useEffect(() => {
    if (tab === 'favorites') void loadFavs();
  }, [tab, loadFavs]);

  const openDetail = async (id: string): Promise<void> => {
    try {
      const d = await api<AssetDetailDto>(`/api/assets/${id}`);
      setDetail(d);
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '加载详情失败');
    }
  };

  const toggleFavorite = async (d: AssetDetailDto): Promise<void> => {
    if (!token) {
      message.info('请先登录后再收藏');
      return;
    }
    try {
      await api(`/api/assets/${d.asset.id}/favorite`, { method: d.isFavorited ? 'DELETE' : 'POST' });
      setDetail({ ...d, isFavorited: !d.isFavorited });
      message.success(d.isFavorited ? '已取消收藏' : '已收藏');
      if (tab === 'favorites') void loadFavs();
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '操作失败');
    }
  };

  const download = async (id: string): Promise<void> => {
    try {
      const res = await api<{ url: string }>(`/api/assets/${id}/download`);
      window.open(res.url, '_blank');
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '下载失败');
    }
  };

  const renderGrid = (items: AssetItem[]) =>
    items.length === 0 ? (
      <div className="glass-card" style={{ borderRadius: 10, padding: 48, textAlign: 'center' }}>
        <Empty description={tab === 'favorites' ? '还没有收藏任何素材' : '没有匹配的素材'} />
      </div>
    ) : (
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
          gap: 16,
        }}
      >
        {items.map((item) => (
          <div key={item.id} className="asset-card" onClick={() => void openDetail(item.id)}>
            <div className="asset-card__preview">
              <img
                src={item.previewUrl}
                alt={item.name}
                style={{ maxHeight: 150, imageRendering: 'pixelated' }}
              />
            </div>
            <div className="asset-card__body">
              <div className="asset-card__name">{item.name}</div>
              <div className="asset-card__meta">
                {item.kind === 'skin' && item.modelType ? (
                  <Tag style={{ fontSize: 11, lineHeight: '18px', marginInlineEnd: 0 }}>
                    {item.modelType === 'slim' ? '纤细' : '经典'}
                  </Tag>
                ) : null}
                {item.aiGenerated ? (
                  <Tag color="purple" style={{ fontSize: 11, lineHeight: '18px', marginInlineEnd: 0 }}>
                    AI
                  </Tag>
                ) : null}
                <span>
                  👁 {item.viewCount ?? 0} · ⬇ {item.downloadCount ?? 0} · ⭐ {item.favoriteCount ?? 0}
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>
    );

  return (
    <div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 8,
          flexWrap: 'wrap',
          gap: 12,
        }}
      >
        <h2 style={{ color: 'var(--text-primary)', margin: 0 }}>素材库</h2>
        <Space wrap>
          <Input
            allowClear
            prefix={<SearchOutlined />}
            placeholder="按名称搜索"
            style={{ width: 200 }}
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onPressEnter={() => {
              setSearch(searchInput.trim());
              setPage(1);
            }}
          />
          <Select<Kind>
            value={kind}
            style={{ width: 100 }}
            onChange={(v) => {
              setKind(v);
              setPage(1);
            }}
            options={[
              { value: 'skin', label: '皮肤' },
              { value: 'cape', label: '披风' },
            ]}
          />
          <Select<Sort>
            value={sort}
            style={{ width: 130 }}
            onChange={setSort}
            options={[
              { value: 'latest', label: '最新上传' },
              { value: 'views', label: '最多浏览' },
              { value: 'downloads', label: '最多下载' },
            ]}
          />
        </Space>
      </div>

      <Tabs
        activeKey={tab}
        onChange={setTab}
        items={[
          {
            key: 'public',
            label: '公开库',
            children: (
              <>
                {loading ? (
                  <div style={{ textAlign: 'center', padding: 80 }}>
                    <Spin size="large" />
                  </div>
                ) : (
                  renderGrid(data?.items ?? [])
                )}
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}>
                  <Pagination
                    current={page}
                    pageSize={pageSize}
                    total={data?.total ?? 0}
                    onChange={setPage}
                    showSizeChanger={false}
                    hideOnSinglePage
                  />
                </div>
              </>
            ),
          },
          ...(token
            ? [
                {
                  key: 'favorites',
                  label: '我的收藏',
                  children: favsLoading ? (
                    <div style={{ textAlign: 'center', padding: 80 }}>
                      <Spin size="large" />
                    </div>
                  ) : (
                    renderGrid(favs)
                  ),
                },
              ]
            : []),
        ]}
      />

      <Modal
        title={detail?.asset.name}
        open={detail !== null}
        onCancel={() => setDetail(null)}
        width={detail?.asset.kind === 'skin' ? 720 : 560}
        footer={
          <Space>
            <Button
              icon={detail?.isFavorited ? <StarFilled style={{ color: '#faad14' }} /> : <StarOutlined />}
              onClick={() => detail && void toggleFavorite(detail)}
            >
              {detail?.isFavorited ? '已收藏' : '收藏'}
            </Button>
            {detail?.canDownload && (
              <Button
                type="primary"
                icon={<DownloadOutlined />}
                onClick={() => void download(detail.asset.id)}
              >
                下载
              </Button>
            )}
          </Space>
        }
      >
        {detail && (
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
            {detail.asset.kind === 'skin' && detail.asset.previewUrl ? (
              <Skin3DViewer
                skinUrl={detail.asset.previewUrl}
                modelType={detail.asset.modelType ?? 'default'}
                width={280}
                height={320}
              />
            ) : (
              <div
                style={{
                  flex: '0 0 auto',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: 'var(--bg-inner)',
                  borderRadius: 8,
                  padding: 24,
                  minWidth: 240,
                  minHeight: 180,
                }}
              >
                <img
                  src={detail.asset.previewUrl}
                  alt={detail.asset.name}
                  style={{ maxWidth: 200, imageRendering: 'pixelated' }}
                />
              </div>
            )}
            <div style={{ flex: 1, minWidth: 240 }}>
              <Descriptions column={1} size="small" bordered>
                <Descriptions.Item label="类型">
                  {detail.asset.kind === 'skin' ? '皮肤' : '披风'}
                  {detail.asset.kind === 'skin' && detail.asset.modelType
                    ? `（${detail.asset.modelType === 'slim' ? '纤细' : '经典'}）`
                    : ''}
                </Descriptions.Item>
                {detail.asset.description ? (
                  <Descriptions.Item label="描述">{detail.asset.description}</Descriptions.Item>
                ) : null}
                <Descriptions.Item label="许可">{detail.asset.license ?? '-'}</Descriptions.Item>
                <Descriptions.Item label="浏览 / 下载">
                  {detail.asset.viewCount} / {detail.asset.downloadCount}
                </Descriptions.Item>
                <Descriptions.Item label="收藏">{detail.asset.favoriteCount}</Descriptions.Item>
                {detail.asset.adminWarning ? (
                  <Descriptions.Item label="⚠ 管理员提示">
                    <Typography.Text type="danger">{detail.asset.adminWarning}</Typography.Text>
                  </Descriptions.Item>
                ) : null}
              </Descriptions>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
