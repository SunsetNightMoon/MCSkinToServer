import { useCallback, useEffect, useState } from 'react';
import {
  Card,
  List,
  Select,
  Pagination,
  Modal,
  Button,
  Tag,
  Space,
  App as AntdApp,
  Typography,
  Image,
  Descriptions,
} from 'antd';
import { DownloadOutlined, StarOutlined, StarFilled } from '@ant-design/icons';
import { api, ApiError } from '../api/client';
import { useAuthStore } from '../store/auth';
import type { LibraryPageDto, AssetDetailDto } from '../api/types';

type Kind = 'skin' | 'cape';
type Sort = 'latest' | 'views' | 'downloads';

export function LibraryPage() {
  const { message } = AntdApp.useApp();
  const token = useAuthStore((s) => s.token);
  const [kind, setKind] = useState<Kind>('skin');
  const [sort, setSort] = useState<Sort>('latest');
  const [page, setPage] = useState(1);
  const pageSize = 20;
  const [data, setData] = useState<LibraryPageDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState<AssetDetailDto | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const res = await api<LibraryPageDto>(
        `/api/library?kind=${kind}&page=${page}&pageSize=${pageSize}&sort=${sort}`,
      );
      setData(res);
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '加载公开库失败');
    } finally {
      setLoading(false);
    }
  }, [kind, page, sort, message]);

  useEffect(() => {
    void load();
  }, [load]);

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

  return (
    <Card
      title="公开素材库"
      extra={
        <Space>
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
      }
    >
      <List
        loading={loading}
        grid={{ gutter: 16, column: 4 }}
        dataSource={data?.items ?? []}
        renderItem={(item) => (
          <List.Item>
            <Card
              hoverable
              cover={
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'center',
                    background: '#f5f7fa',
                    padding: 12,
                    minHeight: 180,
                    alignItems: 'center',
                  }}
                >
                  <Image
                    src={item.previewUrl}
                    alt={item.name}
                    width={140}
                    preview={false}
                    style={{ imageRendering: 'pixelated' }}
                  />
                </div>
              }
              onClick={() => void openDetail(item.id)}
            >
              <Card.Meta
                title={<span style={{ fontSize: 14 }}>{item.name}</span>}
                description={
                  <Space direction="vertical" size={0}>
                    <Space size={4}>
                      {item.kind === 'skin' && item.modelType ? (
                        <Tag>{item.modelType === 'slim' ? '纤细' : '经典'}</Tag>
                      ) : null}
                      {item.aiGenerated ? <Tag color="purple">AI</Tag> : null}
                    </Space>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      👁 {item.viewCount ?? 0} · ⬇ {item.downloadCount ?? 0} · ⭐{' '}
                      {item.favoriteCount ?? 0}
                    </Typography.Text>
                  </Space>
                }
              />
            </Card>
          </List.Item>
        )}
      />
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
        <Pagination
          current={page}
          pageSize={pageSize}
          total={data?.total ?? 0}
          onChange={setPage}
          showSizeChanger={false}
        />
      </div>

      <Modal
        title={detail?.asset.name}
        open={detail !== null}
        onCancel={() => setDetail(null)}
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
          <>
            <div style={{ display: 'flex', justifyContent: 'center', background: '#f5f7fa', padding: 16, marginBottom: 16 }}>
              <Image
                src={detail.asset.previewUrl}
                width={200}
                style={{ imageRendering: 'pixelated' }}
              />
            </div>
            <Descriptions column={1} size="small">
              <Descriptions.Item label="类型">
                {detail.asset.kind === 'skin' ? '皮肤' : '披风'}
                {detail.asset.kind === 'skin' && detail.asset.modelType
                  ? `（${detail.asset.modelType === 'slim' ? '纤细' : '经典'}）`
                  : ''}
              </Descriptions.Item>
              <Descriptions.Item label="许可">{detail.asset.license ?? '-'}</Descriptions.Item>
              <Descriptions.Item label="浏览 / 下载">
                {detail.asset.viewCount} / {detail.asset.downloadCount}
              </Descriptions.Item>
              <Descriptions.Item label="收藏">{detail.asset.favoriteCount}</Descriptions.Item>
              {detail.asset.description ? (
                <Descriptions.Item label="描述">{detail.asset.description}</Descriptions.Item>
              ) : null}
              {detail.asset.adminWarning ? (
                <Descriptions.Item label="⚠ 管理员提示">
                  <Typography.Text type="danger">{detail.asset.adminWarning}</Typography.Text>
                </Descriptions.Item>
              ) : null}
            </Descriptions>
          </>
        )}
      </Modal>
    </Card>
  );
}
