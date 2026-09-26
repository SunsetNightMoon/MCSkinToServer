/**
 * 我的披风管理（plan3 MyCapes 结构）：表格（预览/名称/权限/状态/统计/时间）、
 * 编辑弹窗（名称/描述/可见性/下载策略）、删除确认。
 */

import { useState, useEffect, useCallback } from 'react';
import { Table, Tag, Button, Space, App as AntdApp, Modal, Form, Input, Select } from 'antd';
import { EditOutlined, DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../api/client';
import { useAuthStore } from '../store/auth';
import { usePageTitle } from '../hooks/usePageTitle';
import type { AssetItem } from '../api/types';

export default function MyCapes() {
  const { t } = useTranslation();
  usePageTitle(t('myCapes.title'));
  const { message } = AntdApp.useApp();
  const user = useAuthStore((s) => s.user);
  const navigate = useNavigate();
  const [assets, setAssets] = useState<AssetItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editing, setEditing] = useState<AssetItem | null>(null);
  const [editForm] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<AssetItem | null>(null);

  const loadAssets = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const res = await api<{ assets: AssetItem[] }>('/api/me/assets?kind=cape');
      setAssets(res.assets);
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : t('myCapes.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [message, t]);

  useEffect(() => {
    void loadAssets();
  }, [loadAssets]);

  const handleEdit = (asset: AssetItem) => {
    setEditing(asset);
    editForm.setFieldsValue({
      name: asset.name,
      description: asset.description || '',
      visibility: asset.visibility,
      downloadPolicy: asset.downloadPolicy,
    });
    setEditModalOpen(true);
  };

  const handleEditSubmit = async (): Promise<void> => {
    if (!editing) return;
    try {
      const values = await editForm.validateFields();
      setSubmitting(true);
      await api(`/api/assets/${editing.id}`, {
        method: 'PATCH',
        json: {
          name: values.name,
          description: values.description || null,
          visibility: values.visibility,
          downloadPolicy: values.downloadPolicy,
        },
      });
      message.success(t('myCapes.updated'));
      setEditModalOpen(false);
      await loadAssets();
    } catch (err) {
      if (err instanceof ApiError) message.error(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (): Promise<void> => {
    if (!deleteTarget) return;
    try {
      await api(`/api/assets/${deleteTarget.id}`, { method: 'DELETE' });
      message.success(t('myCapes.deleted'));
      setDeleteTarget(null);
      await loadAssets();
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : t('myCapes.deleteFailed'));
    }
  };

  const getStatusTag = (status: string) => {
    const map: Record<string, { color: string; text: string }> = {
      pending: { color: 'orange', text: t('myCapes.pending') },
      approved: { color: 'green', text: t('myCapes.approved') },
      rejected: { color: 'red', text: t('myCapes.rejected') },
    };
    const s = map[status] || { color: 'default', text: status };
    return (
      <Tag color={s.color} style={{ whiteSpace: 'normal', wordBreak: 'break-word' }}>
        {s.text}
      </Tag>
    );
  };

  const columns: ColumnsType<AssetItem> = [
    {
      title: t('myCapes.preview'),
      key: 'preview',
      width: 100,
      render: (_, r) =>
        r.previewUrl ? (
          <img
            src={r.previewUrl}
            alt=""
            style={{
              width: 64,
              height: 'auto',
              border: '1px solid var(--border-color)',
              imageRendering: 'pixelated',
              display: 'block',
            }}
          />
        ) : null,
    },
    {
      title: t('myCapes.name'),
      dataIndex: 'name',
      key: 'name',
      ellipsis: true,
    },
    {
      title: t('myCapes.permission'),
      key: 'permission',
      width: 160,
      render: (_, r) => (
        <Space size={4} wrap>
          <Tag style={{ whiteSpace: 'normal', wordBreak: 'break-word' }}>
            {r.visibility === 'public' ? t('myCapes.visibilityPublic') : t('myCapes.visibilityPrivate')}
          </Tag>
          {r.downloadPolicy === 'public' && <Tag>{t('myCapes.downloadPublic')}</Tag>}
        </Space>
      ),
    },
    {
      title: t('myCapes.status'),
      dataIndex: 'reviewStatus',
      key: 'reviewStatus',
      width: 100,
      render: (s: string) => getStatusTag(s),
    },
    {
      title: t('myCapes.viewDownload'),
      key: 'stats',
      width: 100,
      render: (_, r) => `${r.viewCount ?? 0} / ${r.downloadCount ?? 0}`,
    },
    {
      title: t('myCapes.uploadTime'),
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 170,
      render: (d: string) => new Date(d).toLocaleString(),
    },
    {
      title: t('myCapes.action'),
      key: 'action',
      width: 140,
      render: (_, r) => (
        <Space>
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => handleEdit(r)}>
            {t('myCapes.edit')}
          </Button>
          <Button
            type="link"
            size="small"
            danger
            icon={<DeleteOutlined />}
            onClick={() => setDeleteTarget(r)}
          >
            {t('myCapes.delete')}
          </Button>
        </Space>
      ),
    },
  ];

  if (!user) return <div style={{ padding: 20 }}>{t('myCapes.pleaseLogin')}</div>;

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: 20 }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 16,
        }}
      >
        <h2 style={{ margin: 0 }}>{t('myCapes.title')}</h2>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => navigate('/upload?type=cape')}
        >
          {t('myCapes.uploadNewCape')}
        </Button>
      </div>

      <Table
        columns={columns}
        dataSource={assets}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 20 }}
        size="small"
        locale={{ emptyText: t('common.noData') }}
      />

      {/* 编辑弹窗 */}
      <Modal
        title={t('myCapes.editTitle')}
        open={editModalOpen}
        onOk={() => void handleEditSubmit()}
        onCancel={() => setEditModalOpen(false)}
        confirmLoading={submitting}
        okText={t('myCapes.save')}
        cancelText={t('myCapes.cancel')}
      >
        <Form form={editForm} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item
            name="name"
            label={t('myCapes.capeName')}
            rules={[{ required: true, message: t('myCapes.pleaseEnterName') }]}
          >
            <Input placeholder={t('myCapes.capeName')} maxLength={64} />
          </Form.Item>
          <Form.Item name="description" label={t('myCapes.description')}>
            <Input.TextArea
              rows={3}
              placeholder={t('myCapes.descriptionPlaceholder')}
              maxLength={255}
            />
          </Form.Item>
          <Form.Item
            name="visibility"
            label={t('myCapes.visibility')}
            extra={t('myCapes.visibilityHint')}
            rules={[{ required: true }]}
          >
            <Select>
              <Select.Option value="private">{t('myCapes.visibilityPrivate')}</Select.Option>
              <Select.Option value="public">{t('myCapes.visibilityPublic')}</Select.Option>
            </Select>
          </Form.Item>
          <Form.Item name="downloadPolicy" label={t('myCapes.downloadPolicy')} rules={[{ required: true }]}>
            <Select>
              <Select.Option value="owner_only">{t('myCapes.downloadOwnerOnly')}</Select.Option>
              <Select.Option value="public">{t('myCapes.downloadPublic')}</Select.Option>
            </Select>
          </Form.Item>
        </Form>
      </Modal>

      {/* 删除确认 */}
      <Modal
        title={t('myCapes.deleteConfirmTitle')}
        open={!!deleteTarget}
        onOk={() => void handleDelete()}
        onCancel={() => setDeleteTarget(null)}
        okText={t('myCapes.confirmDelete')}
        cancelText={t('myCapes.cancel')}
        okButtonProps={{ danger: true }}
      >
        {deleteTarget && (
          <div>
            <p
              dangerouslySetInnerHTML={{
                __html: t('myCapes.deleteConfirm', { name: deleteTarget.name }),
              }}
            />
            <p style={{ color: 'var(--text-muted)', fontSize: 12 }}>{t('myCapes.deleteWarning')}</p>
          </div>
        )}
      </Modal>
    </div>
  );
}
