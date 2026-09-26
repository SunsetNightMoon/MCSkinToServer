import { useEffect, useRef } from 'react'

interface SkinAvatarProps {
  skinUrl?: string
  size?: number
  className?: string
  /** 是否加 Minecraft 头像边框（默认开启） */
  border?: boolean
}

const DEFAULT_SKIN = '/steve.png'

/**
 * Minecraft 皮肤头像渲染（双层皮肤支持）
 *
 * 渲染逻辑：
 * 1. 底层头部：皮肤纹理 (8, 8) 8×8 区域 → 缩放到 64×64
 * 2. 外层头部：皮肤纹理 (40, 8) 8×8 区域 → 直接叠加（source-over 自动处理 alpha）
 * 3. 离屏 canvas 合成后缩放至目标尺寸
 * 4. 关闭抗锯齿，保持像素锐利
 *
 * 注意：不使用 getImageData，完全避免跨域 tainted canvas 问题
 */
export function SkinAvatar({ skinUrl, size = 64, className, border = true }: SkinAvatarProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    canvas.width = size
    canvas.height = size

    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.src = skinUrl || DEFAULT_SKIN

    img.onload = () => {
      const skinHeight = img.naturalHeight || 64

      // 离屏 canvas（64×64 标准头像尺寸）
      const off = document.createElement('canvas')
      off.width = 64
      off.height = 64
      const offCtx = off.getContext('2d')
      if (!offCtx) return
      offCtx.imageSmoothingEnabled = false

      // 1. 底层：头部正面 (8, 8) → 8×8 放大到 64×64
      offCtx.drawImage(img, 8, 8, 8, 8, 0, 0, 64, 64)

      // 2. 外层：头部覆盖 (40, 8) → 8×8 直接叠加
      //    source-over 模式自动处理 alpha，完全不透明则覆盖，半透明则混合
      //    64×64 皮肤才有外层（32 像素高的旧皮肤没有）
      if (skinHeight >= 64) {
        offCtx.drawImage(img, 40, 8, 8, 8, 0, 0, 64, 64)
      }

      // 3. 绘制到显示 canvas
      ctx.clearRect(0, 0, size, size)
      ctx.imageSmoothingEnabled = false
      ctx.drawImage(off, 0, 0, 64, 64, 0, 0, size, size)

      // 4. Minecraft 风格头像边框（1px 深色描边）
      if (border) {
        ctx.strokeStyle = 'rgba(0,0,0,0.25)'
        ctx.lineWidth = Math.max(1, Math.round(size / 64))
        ctx.strokeRect(0, 0, size, size)
      }
    }

    img.onerror = () => {
      ctx.clearRect(0, 0, size, size)
      ctx.fillStyle = '#c6c6c6'
      ctx.fillRect(0, 0, size, size)
      ctx.fillStyle = '#404040'
      ctx.font = `${Math.round(size * 0.5)}px Arial, sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText('?', size / 2, size / 2)
    }
  }, [skinUrl, size, border])

  return (
    <canvas
      ref={canvasRef}
      width={size}
      height={size}
      className={className}
      style={{
        display: 'block',
        imageRendering: 'pixelated',
        borderRadius: 3,
      }}
    />
  )
}
