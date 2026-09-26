/**
 * Minecraft 皮肤头像渲染（沿用 plan3 SkinAvatar 双层头部逻辑）
 *
 * 1. 底层头部：皮肤纹理 (8, 8) 8×8 → 缩放 64×64
 * 2. 外层头部：皮肤纹理 (40, 8) 8×8 叠加（source-over 自动 alpha 混合）
 * 3. 关闭抗锯齿保持像素锐利；不用 getImageData 避免跨域 tainted canvas
 */

import { useEffect, useRef } from 'react';

interface SkinAvatarProps {
  skinUrl?: string;
  size?: number;
  className?: string;
  border?: boolean;
}

/** 内置默认头像：canvas 画一个 Steve 风格像素脸（无外部资源依赖） */
function drawDefaultFace(ctx: CanvasRenderingContext2D, size: number): void {
  const off = document.createElement('canvas');
  off.width = 8;
  off.height = 8;
  const c = off.getContext('2d')!;
  c.fillStyle = '#b57e5a'; // 脸底色
  c.fillRect(0, 0, 8, 8);
  c.fillStyle = '#3b2c20'; // 头发
  c.fillRect(0, 0, 8, 2);
  c.fillStyle = '#ffffff'; // 眼白
  c.fillRect(1, 4, 2, 1);
  c.fillRect(5, 4, 2, 1);
  c.fillStyle = '#3b5dc9'; // 瞳孔
  c.fillRect(2, 4, 1, 1);
  c.fillRect(5, 4, 1, 1);
  c.fillStyle = '#8a5a3e'; // 鼻
  c.fillRect(3, 5, 2, 2);
  c.fillStyle = '#6f4a33'; // 嘴
  c.fillRect(3, 7, 2, 1);
  ctx.clearRect(0, 0, size, size);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(off, 0, 0, 8, 8, 0, 0, size, size);
}

export function SkinAvatar({ skinUrl, size = 36, className, border = false }: SkinAvatarProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    canvas.width = size;
    canvas.height = size;

    if (!skinUrl) {
      drawDefaultFace(ctx, size);
      return;
    }

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = skinUrl;

    img.onload = () => {
      const skinHeight = img.naturalHeight || 64;
      const off = document.createElement('canvas');
      off.width = 64;
      off.height = 64;
      const offCtx = off.getContext('2d');
      if (!offCtx) return;
      offCtx.imageSmoothingEnabled = false;

      // 1. 底层：头部正面 (8, 8) 8×8 → 64×64
      offCtx.drawImage(img, 8, 8, 8, 8, 0, 0, 64, 64);
      // 2. 外层：头部覆盖 (40, 8) 8×8（仅 64×64 皮肤有）
      if (skinHeight >= 64) {
        offCtx.drawImage(img, 40, 8, 8, 8, 0, 0, 64, 64);
      }
      // 3. 绘制到显示 canvas
      ctx.clearRect(0, 0, size, size);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(off, 0, 0, 64, 64, 0, 0, size, size);
      // 4. 描边
      if (border) {
        ctx.strokeStyle = 'rgba(0,0,0,0.25)';
        ctx.lineWidth = Math.max(1, Math.round(size / 64));
        ctx.strokeRect(0, 0, size, size);
      }
    };

    img.onerror = () => drawDefaultFace(ctx, size);
  }, [skinUrl, size, border]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{
        width: size,
        height: size,
        imageRendering: 'pixelated',
        display: 'block',
      }}
    />
  );
}
