/**
 * 公开素材库（plan3 SkinLibrary 结构）：皮肤/披风 Tabs、搜索、排序、
 * SkinThumbnail3D 卡片网格、分页；点击卡片跳独立详情页并携带返回状态。
 */

import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Input, Row, Col, Pagination, Card, Tag, Spin, Tabs, Empty, App as AntdApp } from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../api/client';
import { usePageTitle } from '../hooks/usePageTitle';import { SkinThumbnail3D } from '../components/SkinThumbnail3D';
import type { AssetItem } from '../api/types';

type Kind = 'skin' | 'cape';
type Sort = 'latest' | 'views' | 'downloads';

const PAGE_SIZE = 12;

function AssetCard({
  item,
  onClick,
}: {
  item: AssetItem;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  const isSkin = item.kind === 'skin';
  const isPending = item.reviewStatus === 'pending';
  const isRejected = item.reviewStatus === 'rejected';

  return (
    <Card
      hoverable
      cover={
        <div style={{ padding: 16, textAlign: 'center', position: 'relative' }}>
          {isSkin ? (
            <SkinThumbnail3D
              skinUrl={item.previewUrl ?? '/steve.png'}
              modelType={item.modelType === 'slim' ? 'slim' : 'default'}
              width={140}
              height={180}
            />
          ) : (
            <SkinThumbnail3D
              skinUrl="/steve.png"
              capeUrl={item.previewUrl ?? undefined}
              modelType="default"
              width={140}
              height={180}
            />
          )}
          {isPending && (
            <div
              style={{
                position: 'absolute',
                top: 16,
                left: 16,
                right: 16,
                bottom: 16,
                background: 'rgba(255,165,0,0.15)',
                borderRadius: 4,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Tag color="orange" style={{ fontSize: 14, padding: '4px 12px' }}>
                {t('library.pending')}
              </Tag>
            </div>
          )}
          {isRejected && (
            <div
              style={{
                position: 'absolute',
                top: 16,
                left: 16,
                right: 16,
                bottom: 16,
                background: 'rgba(255,0,0,0.1)',
                borderRadius: 4,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Tag color="red" style={{ fontSize: 14, padding: '4px 12px' }}>
                {t('library.rejected')}
              </Tag>
            </div>
          )}
        </div>
      }
      onClick={onClick}
    >
      <Card.Meta
        title={item.name || (isSkin ? t('wardrobe.unnamedSkin') : t('wardrobe.unnamedCape'))}
        description={
          <div>
            <div style={{ marginTop: 6 }}>
              {isSkin && item.modelType ? (
                <Tag color={item.modelType === 'slim' ? 'blue' : 'default'}>
                  {item.modelType === 'slim' ? t('library.slimModel') : t('library.classicModel')}
                </Tag>
              ) : null}
              {item.aiGenerated ? <Tag color="geekblue">AI</Tag> : null}
            </div>
            <div style={{ marginTop: 6, color: 'var(--text-muted)', fontSize: 12 }}>
              {t('library.downloads')}: {item.downloadCount ?? 0} | {t('library.views')}:{' '}
              {item.viewCount ?? 0}
            </div>
          </div>
        }
      />
    </Card>
  );
}

function AssetGrid({
  kind,
  page,
  setPage,
  activeTab,
  search,
  sort,
}: {
  kind: Kind;
  page: number;
  setPage: (p: number) => void;
  activeTab: string;
  search: string;
  sort: Sort;
}) {
  const navigate = useNavigate();
  const { message } = AntdApp.useApp();
  const { t } = useTranslation();
  const [items, setItems] = useState<AssetItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const res = await api<{ items: AssetItem[]; total: number }>(
        `/api/library?kind=${kind}&page=${page}&pageSize=${PAGE_SIZE}&sort=${sort}${
          search ? `&search=${encodeURIComponent(search)}` : ''
        }`,
      );
      setItems(res.items || []);
      setTotal(res.total || 0);
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : t('common.requestFailed'));
    } finally {
      setLoading(false);
    }
  }, [kind, page, sort, search, message, t]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div>
      {loading ? (
        <div style={{ textAlign: 'center', padding: 50 }}>
          <Spin size="large" />
        </div>
      ) : items.length === 0 ? (
        <Empty
          description={kind === 'skin' ? t('library.noSkins') : t('library.noCapes')}
          style={{ padding: 60 }}
        />
      ) : (
        <>
          <Row gutter={[16, 16]}>
            {items.map((item) => (
              <Col key={item.id} xs={24} sm={12} md={8} lg={6} xl={4}>
                <AssetCard
                  item={item}
                  onClick={() =>
                    navigate(`/${item.kind}/${item.id}`, {
                      state: { returnTab: activeTab, returnPage: page },
                    })
                  }
                />
              </Col>
            ))}
          </Row>
          <Pagination
            current={page}
            pageSize={PAGE_SIZE}
            total={total}
            onChange={setPage}
            style={{ marginTop: 20, textAlign: 'center' }}
          />
        </>
      )}
    </div>
  );
}

export function LibraryPage() {
  const { t } = useTranslation();
  usePageTitle(t('nav.library'));
  const [searchParams, setSearchParams] = useSearchParams();
  const [skinPage, setSkinPage] = useState(
    () => Math.max(1, Number(searchParams.get('skinPage')) || 1),
  );
  const [capePage, setCapePage] = useState(
    () => Math.max(1, Number(searchParams.get('capePage')) || 1),
  );
  const [activeTab, setActiveTab] = useState(
    searchParams.get('tab') === 'cape' ? 'cape' : 'skin',
  );
  const [sort, setSort] = useState<Sort>('latest');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');

  // 同步 URL 参数（返回列表时恢复 tab 与页码）
  const syncParams = useCallback(() => {
    const params = new URLSearchParams();
    if (activeTab === 'cape') params.set('tab', 'cape');
    if (skinPage > 1) params.set('skinPage', String(skinPage));
    if (capePage > 1) params.set('capePage', String(capePage));
    setSearchParams(params, { replace: true });
  }, [activeTab, skinPage, capePage, setSearchParams]);

  useEffect(() => {
    syncParams();
  }, [activeTab, skinPage, capePage, syncParams]);

  const doSearch = (): void => {
    setSearch(searchInput.trim());
    setSkinPage(1);
    setCapePage(1);
  };

  return (
    <div>
      <h2>{t('nav.library')}</h2>
      <div style={{ marginBottom: 16, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <Input
          placeholder={t('library.searchPlaceholder')}
          prefix={<SearchOutlined />}
          style={{ width: 260 }}
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          onPressEnter={doSearch}
          allowClear
        />
        <select
          value={sort}
          onChange={(e) => {
            setSort(e.target.value as Sort);
            setSkinPage(1);
            setCapePage(1);
          }}
          className="ant-select"
          style={{
            height: 32,
            borderRadius: 6,
            border: '1px solid var(--border-color)',
            background: 'var(--bg-inner)',
            color: 'var(--text-primary)',
            padding: '0 8px',
            fontSize: 13,
          }}
        >
          <option value="latest">{t('library.sortLatest')}</option>
          <option value="views">{t('library.sortViews')}</option>
          <option value="downloads">{t('library.sortDownloads')}</option>
        </select>
        {search && (
          <a
            onClick={() => {
              setSearch('');
              setSearchInput('');
            }}
            style={{ lineHeight: '32px' }}
          >
            {search}
          </a>
        )}
      </div>

      <Tabs
        activeKey={activeTab}
        onChange={(key) => setActiveTab(key)}
        items={[
          {
            key: 'skin',
            label: t('nav.skin'),
            children: (
              <AssetGrid
                kind="skin"
                page={skinPage}
                setPage={setSkinPage}
                activeTab={activeTab}
                search={search}
                sort={sort}
              />
            ),
          },
          {
            key: 'cape',
            label: t('nav.cape'),
            children: (
              <AssetGrid
                kind="cape"
                page={capePage}
                setPage={setCapePage}
                activeTab={activeTab}
                search={search}
                sort={sort}
              />
            ),
          },
        ]}
      />
    </div>
  );
}
