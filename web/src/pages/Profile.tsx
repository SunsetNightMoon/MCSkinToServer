/**
 * 个人中心：账号信息卡 + 当前角色皮肤 3D 预览 + 我的收藏快捷入口。
 */

import { useEffect, useState } from 'react';
import { Descriptions, Tag, Button, App as AntdApp } from 'antd';
import { useNavigate } from 'react-router-dom';
import { StarOutlined } from '@ant-design/icons';
import { api, ApiError } from '../api/client';
import { useAuthStore } from '../store/auth';
import { Skin3DViewer } from '../components/Skin3DViewer';

interface MySkin {
  profileId: string;
  profileName: string;
  skinUrl: string | null;
  model: string | null;
}

export function ProfilePage() {
  const { message } = AntdApp.useApp();
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const [skin, setSkin] = useState<MySkin | null>(null);

  useEffect(() => {
    api<MySkin>('/api/me/skin')
      .then(setSkin)
      .catch((err) => {
        if (err instanceof ApiError) message.error(err.message);
      });
  }, [message]);

  return (
    <div>
      <h2 style={{ color: 'var(--text-primary)', margin: '0 0 16px' }}>个人中心</h2>
      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
        <div className="glass-card" style={{ borderRadius: 10, padding: 20, flex: 1, minWidth: 280 }}>
          <Descriptions column={1} size="small" bordered>
            <Descriptions.Item label="邮箱">{user?.email ?? '-'}</Descriptions.Item>
            <Descriptions.Item label="UID">#{user?.userUid ?? '-'}</Descriptions.Item>
            <Descriptions.Item label="角色">
              {user?.role === 'super_admin' ? (
                <Tag color="purple">超级管理员</Tag>
              ) : user?.role === 'admin' ? (
                <Tag color="blue">管理员</Tag>
              ) : (
                <Tag>普通用户</Tag>
              )}
            </Descriptions.Item>
            <Descriptions.Item label="默认角色">{skin?.profileName ?? '-'}</Descriptions.Item>
          </Descriptions>
          <div style={{ marginTop: 16, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Button icon={<StarOutlined />} onClick={() => navigate('/library')}>
              去收藏素材
            </Button>
            <Button type="primary" onClick={() => navigate('/wardrobe')}>
              管理我的衣柜
            </Button>
          </div>
        </div>

        <div className="glass-card" style={{ borderRadius: 10, padding: 20, flex: '0 0 auto' }}>
          <div style={{ marginBottom: 12, color: 'var(--text-muted)', fontSize: 13 }}>
            当前角色「{skin?.profileName ?? '-'}」的皮肤
          </div>
          {skin?.skinUrl ? (
            <Skin3DViewer
              skinUrl={skin.skinUrl}
              modelType={(skin.model as 'default' | 'slim') ?? 'default'}
              width={260}
              height={300}
            />
          ) : (
            <div style={{ color: 'var(--text-subtle)', padding: 24, textAlign: 'center' }}>
              还没有应用皮肤，去
              <Button type="link" size="small" onClick={() => navigate('/wardrobe')}>
                衣柜
              </Button>
              上传并应用一个吧
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
