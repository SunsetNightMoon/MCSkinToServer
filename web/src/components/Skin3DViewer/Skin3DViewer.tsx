import { useEffect, useRef, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { SkinViewer, IdleAnimation, WalkingAnimation, RunningAnimation } from 'skinview3d'
import * as THREE from 'three'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _3: any = THREE

type AnimMode = 'idle' | 'walk' | 'run'
type Theme = 'light' | 'dark'
type BackEquipment = 'cape' | 'elytra' | null

interface Props {
  skinUrl: string
  capeUrl?: string | null
  modelType?: 'default' | 'slim'
  width?: number
  height?: number
  initialBackView?: boolean
}

function getCurrentTheme(): Theme {
  return document.body.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'
}

/**
 * 在场景中添加地面软阴影（径向渐变椭圆）
 */
function addGroundShadow(viewer: any): () => void {
  const size = 128
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  const cx = size / 2
  const cy = size / 2
  const radius = size * 0.38

  ctx.clearRect(0, 0, size, size)
  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius)
  grad.addColorStop(0, 'rgba(0,0,0,0.35)')
  grad.addColorStop(0.5, 'rgba(0,0,0,0.15)')
  grad.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = grad
  ctx.beginPath()
  ctx.arc(cx, cy, radius, 0, Math.PI * 2)
  ctx.fill()

  const texture = new _3.CanvasTexture(canvas)
  texture.needsUpdate = true

  const geo = new _3.PlaneGeometry(1.8, 0.9)
  const mat = new _3.MeshBasicMaterial({
    map: texture,
    transparent: true,
    opacity: 1,
    depthWrite: false,
    side: _3.DoubleSide,
  })
  const mesh = new _3.Mesh(geo, mat)
  mesh.rotation.x = -Math.PI / 2
  mesh.position.y = -1.49
  mesh.name = '__groundShadow'
  viewer.scene.add(mesh)

  return () => {
    viewer.scene.remove(mesh)
    geo.dispose()
    mat.dispose()
    texture.dispose()
    ;(canvas as any).width = 0
  }
}

export function Skin3DViewer({ skinUrl, capeUrl, modelType = 'default', width = 360, height = 400, initialBackView = false }: Props) {
  const { t } = useTranslation()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const viewerRef = useRef<any>(null)
  const shadowDisposeRef = useRef<(() => void) | null>(null)
  const initialBackViewRef = useRef(initialBackView)

  const [rotating, setRotating] = useState(false)
  const [animMode, setAnimMode] = useState<AnimMode>('idle')
  const [theme, setTheme] = useState<Theme>(getCurrentTheme)
  const [backEquipment, setBackEquipment] = useState<BackEquipment>(capeUrl ? 'cape' : null)

  // 监听页面主题变化
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(getCurrentTheme()))
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])

  // 初始化 SkinViewer
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const viewer = new SkinViewer({
      canvas,
      width,
      height,
      skin: skinUrl,
      model: modelType,
      cape: capeUrl || undefined,
      enableControls: true,
    })

    viewer.renderer.setClearColor(0x000000, 0)
    viewer.autoRotate = false

    shadowDisposeRef.current = addGroundShadow(viewer)

    // 无披风时彻底隐藏 cape / elytra（避免默认白色 mesh 显示）
    if (!capeUrl) {
      viewer.playerObject.backEquipment = null
    }

    // 背面视角：把相机放到 z 轴负方向（从背面看人物）
    if (initialBackViewRef.current) {
      const distance = viewer.camera.position.length()
      viewer.camera.position.set(0, 0, -distance)
      viewer.camera.lookAt(0, 0, 0)
      viewer.controls.update()
    }

    viewerRef.current = viewer
    return () => {
      shadowDisposeRef.current?.()
      shadowDisposeRef.current = null
      viewer.dispose()
      viewerRef.current = null
    }
  }, [skinUrl, capeUrl, modelType, width, height])

  // 同步 backEquipment（披风 / 鞘翅 / 无）
  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return
    viewer.playerObject.backEquipment = backEquipment
  }, [backEquipment])

  // 动画模式
  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return
    let anim: any
    switch (animMode) {
      case 'walk': anim = new WalkingAnimation(); break
      case 'run': anim = new RunningAnimation(); break
      default: anim = new IdleAnimation()
    }
    viewer.animation = anim
  }, [animMode])

  // 旋转开关
  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return
    viewer.autoRotate = rotating
  }, [rotating])

  // 复位
  const handleReset = useCallback(() => {
    const viewer = viewerRef.current
    if (!viewer) return
    viewer.controls.reset()
    viewer.resetCameraPose()
    if (initialBackViewRef.current) {
      const distance = viewer.camera.position.length()
      viewer.camera.position.set(0, 0, -distance)
      viewer.camera.lookAt(0, 0, 0)
      viewer.controls.update()
    }
  }, [])

  // 小按钮样式（跟随页面主题）
  const tinyBtn = (label: string, active: boolean, onClick: () => void, disabled = false) => {
    const isDark = theme === 'dark'
    return (
      <button
        onClick={onClick}
        disabled={disabled}
        style={{
          border: `1px solid ${isDark ? '#444' : '#d9d9d9'}`,
          borderRadius: 4,
          padding: '2px 8px',
          cursor: disabled ? 'not-allowed' : 'pointer',
          fontSize: 11,
          background: active ? '#4f46e5' : (isDark ? '#2a2a2a' : '#fff'),
          color: active ? '#fff' : (isDark ? '#ccc' : '#333'),
          opacity: disabled ? 0.4 : 1,
        }}
      >{label}</button>
    )
  }

  const isDark = theme === 'dark'
  const hasCape = !!capeUrl

  return (
    <div style={{ width, display: 'flex', flexDirection: 'column', maxWidth: '100%' }}>
      <div style={{
        width, height,
        maxWidth: '100%',
        backgroundImage: [
          `linear-gradient(45deg, ${isDark ? '#2a2a2a' : '#F8F8F8'} 25%, transparent 25%)`,
          `linear-gradient(-45deg, ${isDark ? '#2a2a2a' : '#F8F8F8'} 25%, transparent 25%)`,
          `linear-gradient(45deg, transparent 75%, ${isDark ? '#2a2a2a' : '#F8F8F8'} 75%)`,
          `linear-gradient(-45deg, transparent 75%, ${isDark ? '#2a2a2a' : '#F8F8F8'} 75%)`,
        ].join(','),
        backgroundSize: '64px 64px',
        backgroundColor: isDark ? '#1a1a1a' : '#ffffff',
        backgroundPosition: '0 0, 0 32px, 32px -32px, -32px 0px',
        borderRadius: 8,
        overflow: 'hidden',
      }}>
        <canvas ref={canvasRef} style={{ display: 'block' }} />
      </div>

      <div style={{ display: 'flex', justifyContent: 'center', gap: 6, padding: '8px 0 0 0', flexWrap: 'wrap' }}>
        {tinyBtn('↻ ' + t('skinViewer.rotate'), rotating, () => setRotating(v => !v))}
        {tinyBtn(t('skinViewer.idle'), animMode === 'idle', () => setAnimMode('idle'))}
        {tinyBtn(t('skinViewer.walk'), animMode === 'walk', () => setAnimMode('walk'))}
        {tinyBtn(t('skinViewer.run'), animMode === 'run', () => setAnimMode('run'))}
        {hasCape && tinyBtn(t('skinViewer.elytra'), backEquipment === 'elytra', () => setBackEquipment(v => v === 'elytra' ? 'cape' : 'elytra'))}
        {tinyBtn(t('skinViewer.reset'), false, handleReset)}
      </div>
    </div>
  )
}
