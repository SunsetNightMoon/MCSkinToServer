import { compatFetch as fetch } from "../../utils/apiCompat" // 数据层适配：/api/* 自动翻译为 MCSTS 端点
import { useState, useEffect, useCallback } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Input, Row, Col, Pagination, Card, Tag, Spin, Tabs, Empty } from 'antd'
import { SearchOutlined } from '@ant-design/icons'
import type { Skin, Cape } from '../../types'
import { SkinThumbnail3D } from '../../components/SkinThumbnail3D/SkinThumbnail3D'
import { useTranslation } from 'react-i18next'
import { usePageTitle } from '../../hooks/usePageTitle'

const LICENSE_TAG_COLORS: Record<string, string> = {
  'CC0_1.0': 'green',
  'CC_BY_3.0': 'blue',
  'CC_BY_4.0': 'blue',
  'CC_BY-SA_3.0': 'cyan',
  'CC_BY-SA_4.0': 'cyan',
  'CC_BY-NC_3.0': 'purple',
  'CC_BY-NC_4.0': 'purple',
  'ARR': 'red',
  'AI_CC0': 'geekblue',
  'Custom': 'default',
}

function SkinCard({ skin, onClick }: { skin: Skin; onClick: () => void }) {
  const previewModel = skin.model_type === 'slim' ? 'slim' : 'default'
  const { t } = useTranslation()

  return (
    <Card
      hoverable
      cover={
        <div style={{ padding: 16, textAlign: 'center' }}>
          <SkinThumbnail3D
            skinUrl={skin.file_path}
            modelType={previewModel}
            width={140}
            height={180}
          />
        </div>
      }
      onClick={onClick}
    >
      <Card.Meta
        title={skin.name ? skin.name : (skin.model_type === 'slim' ? t('library.slimModel') : t('library.classicModel'))}
        description={
          <div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t('library.uploader')}: {skin.uploader_name || `UID.${skin.user_uid}`}</div>
            <div style={{ marginTop: 6 }}>
              <Tag color={LICENSE_TAG_COLORS[skin.license_type]}>{skin.license_type}</Tag>
            </div>
            <div style={{ marginTop: 6, color: 'var(--text-muted)', fontSize: 12 }}>
              {t('library.downloads')}: {skin.download_count} | {t('library.views')}: {skin.view_count}
            </div>
          </div>
        }
      />
    </Card>
  )
}

function CapeCard({ cape, onClick }: { cape: Cape & { approval_status?: string }; onClick: () => void }) {
  const isPending = cape.approval_status === 'pending'
  const isRejected = cape.approval_status === 'rejected'
  const { t } = useTranslation()

  return (
    <Card
      hoverable
      cover={
        <div style={{ padding: 16, textAlign: 'center', position: 'relative' }}>
          <SkinThumbnail3D
            skinUrl="/steve.png"
            capeUrl={cape.file_path}
            modelType="default"
            width={140}
            height={180}
          />
          {isPending && (
            <div style={{
              position: 'absolute', top: 16, left: 16, right: 16, bottom: 16,
              background: 'rgba(255,165,0,0.15)', borderRadius: 4,
              display: 'flex', alignItems: 'center', justifyContent: 'center'
            }}>
              <Tag color="orange" style={{ fontSize: 14, padding: '4px 12px' }}>{t('library.pending')}</Tag>
            </div>
          )}
          {isRejected && (
            <div style={{
              position: 'absolute', top: 16, left: 16, right: 16, bottom: 16,
              background: 'rgba(255,0,0,0.1)', borderRadius: 4,
              display: 'flex', alignItems: 'center', justifyContent: 'center'
            }}>
              <Tag color="red" style={{ fontSize: 14, padding: '4px 12px' }}>{t('library.rejected')}</Tag>
            </div>
          )}
        </div>
      }
      onClick={onClick}
    >
      <Card.Meta
        title={cape.name || t('library.unnamedCape')}
        description={
          <div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t('library.uploader')}: {cape.uploader_name || `UID.${cape.user_uid}`}</div>
            <div style={{ marginTop: 6 }}>
              <Tag color={LICENSE_TAG_COLORS[cape.license_type]}>{cape.license_type}</Tag>
              <Tag>{cape.width}×{cape.height}</Tag>
            </div>
            <div style={{ marginTop: 6, color: 'var(--text-muted)', fontSize: 12 }}>
              {t('library.downloads')}: {cape.download_count} | {t('library.views')}: {cape.view_count}
            </div>
          </div>
        }
      />
    </Card>
  )
}

const PAGE_SIZE = 12

function SkinGrid({ page, setPage, activeTab }: { page: number; setPage: (p: number) => void; activeTab: string }) {
  const navigate = useNavigate()
  const [skins, setSkins] = useState<Skin[]>([])
  const [loading, setLoading] = useState(true)
  const [total, setTotal] = useState(0)
  const [search, setSearch] = useState('')
  const { t } = useTranslation()

  const load = useCallback((p: number) => {
    setLoading(true)
    fetch(`/api/library/skins?page=${p}&limit=${PAGE_SIZE}`)
      .then(r => r.json())
      .then(data => {
        setSkins(data.skins || [])
        setTotal(data.total || 0)
      })
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { load(page) }, [page, load])

  const filtered = search
    ? skins.filter(s => String(s.id).includes(search) || s.description?.includes(search) || s.name?.includes(search))
    : skins

  return (
    <div>
      <div style={{ marginBottom: 16, display: 'flex', gap: 10 }}>
        <Input
          placeholder={t('library.searchPlaceholder')}
          prefix={<SearchOutlined />}
          style={{ width: 260 }}
          value={search}
          onChange={e => setSearch(e.target.value)}
          allowClear
        />
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: 50 }}><Spin size="large" /></div>
      ) : filtered.length === 0 ? (
        <Empty description={t('library.noSkins')} style={{ padding: 60 }} />
      ) : (
        <>
          <Row gutter={[16, 16]}>
            {filtered.map(skin => (
              <Col key={skin.id} xs={24} sm={12} md={8} lg={6} xl={4}>
                <SkinCard skin={skin} onClick={() => navigate(`/skin/${skin.id}`, { state: { returnTab: activeTab, returnPage: page } })} />
              </Col>
            ))}
          </Row>
          <Pagination current={page} pageSize={PAGE_SIZE} total={total} onChange={setPage}
            style={{ marginTop: 20, textAlign: 'center' }} />
        </>
      )}
    </div>
  )
}

function CapeGrid({ page, setPage, activeTab }: { page: number; setPage: (p: number) => void; activeTab: string }) {
  const navigate = useNavigate()
  const [capes, setCapes] = useState<Cape[]>([])
  const [loading, setLoading] = useState(true)
  const [total, setTotal] = useState(0)
  const [search, setSearch] = useState('')
  const { t } = useTranslation()

  useEffect(() => {
    setLoading(true)
    fetch(`/api/library/capes?page=${page}&limit=${PAGE_SIZE}`)
      .then(r => r.json())
      .then(data => {
        setCapes(data.capes || [])
        setTotal(data.total || 0)
      })
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [page])

  // 与皮肤标签页保持同一口径：只过滤当前页已加载的数据
  const filtered = search
    ? capes.filter(c => String(c.id).includes(search) || c.description?.includes(search) || c.name?.includes(search))
    : capes

  return (
    <div>
      <div style={{ marginBottom: 16, display: 'flex', gap: 10 }}>
        <Input
          placeholder={t('library.searchCapePlaceholder')}
          prefix={<SearchOutlined />}
          style={{ width: 260 }}
          value={search}
          onChange={e => setSearch(e.target.value)}
          allowClear
        />
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: 50 }}><Spin size="large" /></div>
      ) : filtered.length === 0 ? (
        <Empty description={t('library.noCapes')} style={{ padding: 60 }} />
      ) : (
        <>
          <Row gutter={[16, 16]}>
            {filtered.map(cape => (
              <Col key={cape.id} xs={24} sm={12} md={8} lg={6} xl={4}>
                <CapeCard cape={cape} onClick={() => navigate(`/cape/${cape.id}`, { state: { returnTab: activeTab, returnPage: page } })} />
              </Col>
            ))}
          </Row>
          <Pagination current={page} pageSize={PAGE_SIZE} total={total} onChange={setPage}
            style={{ marginTop: 20, textAlign: 'center' }} />
        </>
      )}
    </div>
  )
}

export function SkinLibrary() {
  const { t } = useTranslation()
  usePageTitle(t('nav.library'))
  const [searchParams, setSearchParams] = useSearchParams()
  const [skinPage, setSkinPage] = useState(() => Math.max(1, Number(searchParams.get('skinPage')) || 1))
  const [capePage, setCapePage] = useState(() => Math.max(1, Number(searchParams.get('capePage')) || 1))
  const [activeTab, setActiveTab] = useState(searchParams.get('tab') === 'cape' ? 'cape' : 'skin')

  // Sync URL params when state changes
  const syncParams = useCallback(() => {
    const params = new URLSearchParams()
    if (activeTab === 'cape') params.set('tab', 'cape')
    if (skinPage > 1) params.set('skinPage', String(skinPage))
    if (capePage > 1) params.set('capePage', String(capePage))
    setSearchParams(params, { replace: true })
  }, [activeTab, skinPage, capePage, setSearchParams])

  useEffect(() => { syncParams() }, [activeTab, skinPage, capePage, syncParams])

  return (
    <div>
      <h2>{t('nav.library')}</h2>
      <Tabs
        activeKey={activeTab}
        onChange={key => setActiveTab(key)}
        items={[
          { key: 'skin', label: t('nav.skin'), children: <SkinGrid page={skinPage} setPage={setSkinPage} activeTab={activeTab} /> },
          { key: 'cape', label: t('nav.cape'), children: <CapeGrid page={capePage} setPage={setCapePage} activeTab={activeTab} /> },
        ]}
      />
    </div>
  )
}
