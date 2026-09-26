import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SkinViewer, IdleAnimation } from 'skinview3d'

interface Props {
  skinUrl: string
  capeUrl?: string | null
  modelType?: 'default' | 'slim'
  width?: number
  height?: number
}

/**
 * 3D缩略图 — 完全离屏渲染为PNG并缓存到sessionStorage
 *
 * 姿势（参考namemc风格 + 用户提供的截图）：
 * - 正面朝向，略微偏右（rotation.y ≈ 0.15~0.2）
 * - 俯视角度（rotation.x ≈ 0.25~0.35，相机从上往下看）
 * - IdleAnimation 手臂自然下垂
 *
 * 性能优化：
 *   首次渲染后 base64 存入 sessionStorage，后续直接读取
 *   同一 URL 不重复创建 WebGL 上下文
 *
 * ⚠️ 重要：canvas 绝不插入 React 管理的 DOM，避免 React reconciliation 崩溃。
 *    SkinViewer 自行管理 WebGL 上下文，外部不要手动调用 getContext。
 */
export function SkinThumbnail3D({
  skinUrl,
  capeUrl,
  modelType = 'default',
  width = 140,
  height = 180,
}: Props) {
  const { t } = useTranslation()
  const [imgSrc, setImgSrc] = useState<string | null>(null)
  const [status, setStatus] = useState<'loading' | 'rendering' | 'done' | 'error'>('loading')
  const viewerRef = useRef<SkinViewer | null>(null)
  const mountedRef = useRef(true)

  // 用URL生成唯一缓存key
  const cacheKey = `thumb_${skinUrl}_${capeUrl || ''}_${modelType}_${width}x${height}`

  useEffect(() => {
    mountedRef.current = true

    // 先检查缓存
    try {
      const cached = sessionStorage.getItem(cacheKey)
      if (cached) {
        if (mountedRef.current) {
          setImgSrc(cached)
          setStatus('done')
        }
        return () => { mountedRef.current = false }
      }
    } catch { /* sessionStorage 可能不可用 */ }

    if (mountedRef.current) {
      setStatus('rendering')
    }

    const timer = setTimeout(() => {
      if (!mountedRef.current) return

      // 离屏 canvas — 绝不插入 DOM，避免与 React 的 DOM 管理冲突
      const dpr = Math.min(window.devicePixelRatio, 2)
      const w = width * dpr
      const h = height * dpr

      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h

      let viewer: SkinViewer | null = null

      try {
        viewer = new SkinViewer({
          canvas,
          width: w,
          height: h,
          skin: skinUrl,
          model: modelType as any,
          enableControls: false,
        })

        viewer.renderer.setClearColor(0x000000, 0)
        viewer.autoRotate = false

        // 模型自身旋转：正面偏右约10度
        viewer.playerWrapper.rotation.y = 0.17
        // 俯视角度：约15度俯视
        viewer.playerWrapper.rotation.x = 0.26

        // 微调相机距离
        // @ts-ignore
        if (viewer.camera) viewer.camera.position.set(0, 0.5, 5)

        viewer.resetCameraPose()
        viewer.playerWrapper.rotation.y = 0.17
        viewer.playerWrapper.rotation.x = 0.26

        viewer.animation = new IdleAnimation()
        viewerRef.current = viewer

        const loadAndRender = async () => {
          if (!viewer || !mountedRef.current) return

          try {
            // 加载披风
            if (capeUrl) {
              await viewer.loadCape(capeUrl)
              viewer.playerWrapper.rotation.y = Math.PI - 0.17
            }

            // 等待纹理加载完成
            await new Promise(r => setTimeout(r, 600))

            if (!mountedRef.current || !viewer) return

            viewer.render()
            viewer.render()

            const dataUrl = canvas.toDataURL('image/png', 0.9)

            // 缓存
            try {
              sessionStorage.setItem(cacheKey, dataUrl)
            } catch { /* 存储满了就忽略 */ }

            if (mountedRef.current) {
              setImgSrc(dataUrl)
              setStatus('done')
            }
          } catch (err) {
            console.error('[SkinThumbnail3D] render error:', err)
            if (mountedRef.current) {
              setStatus('error')
            }
          } finally {
            // 无论成功失败都清理 WebGL 资源
            if (viewer) {
              viewer.dispose()
              viewerRef.current = null
            }
          }
        }

        loadAndRender()
      } catch (err) {
        console.error('[SkinThumbnail3D] init error:', err)
        if (mountedRef.current) {
          setStatus('error')
        }
        if (viewer) {
          viewer.dispose()
          viewerRef.current = null
        }
      }
    }, 50)

    return () => {
      mountedRef.current = false
      clearTimeout(timer)
      if (viewerRef.current) {
        try {
          viewerRef.current.dispose()
        } catch { /* ignore */ }
        viewerRef.current = null
      }
    }
  }, [cacheKey])

  return (
    <div
      style={{
        width,
        height,
        margin: '0 auto',
        backgroundImage: [
          'linear-gradient(45deg, #c0c0c0 25%, transparent 25%)',
          'linear-gradient(-45deg, #c0c0c0 25%, transparent 25%)',
          'linear-gradient(45deg, transparent 75%, #c0c0c0 75%)',
          'linear-gradient(-45deg, transparent 75%, #c0c0c0 75%)',
        ].join(','),
        backgroundSize: '20px 20px',
        backgroundColor: '#f0f0f0',
        backgroundPosition: '0 0, 0 10px, 10px -10px, -10px 0px',
        borderRadius: 4,
        overflow: 'hidden',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {imgSrc ? (
        <img
          src={imgSrc}
          alt="preview"
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'contain',
            display: 'block',
          }}
        />
      ) : status === 'loading' || status === 'rendering' ? (
        <div style={{ color: '#999', fontSize: 11 }}>{t('skinViewer.rendering')}</div>
      ) : (
        <div style={{ color: '#ccc', fontSize: 11 }}>{t('skinViewer.previewUnavailable')}</div>
      )}
    </div>
  )
}
