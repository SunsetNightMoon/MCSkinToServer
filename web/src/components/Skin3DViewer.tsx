/**
 * 3D 皮肤预览（沿用 plan3 Skin3DViewer：skinview3d + 地面软阴影 + 动画切换）
 * 动画模式：待机 / 行走 / 奔跑；支持自动旋转与视角复位。
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import {
  SkinViewer,
  IdleAnimation,
  WalkingAnimation,
  RunningAnimation,
} from 'skinview3d';

type AnimMode = 'idle' | 'walk' | 'run';

interface Props {
  skinUrl: string;
  capeUrl?: string | null;
  modelType?: 'default' | 'slim';
  width?: number;
  height?: number;
}

export function Skin3DViewer({
  skinUrl,
  capeUrl,
  modelType = 'default',
  width = 320,
  height = 360,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewerRef = useRef<SkinViewer | null>(null);
  const [rotating, setRotating] = useState(false);
  const [animMode, setAnimMode] = useState<AnimMode>('idle');

  // 初始化 SkinViewer
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const viewer = new SkinViewer({
      canvas,
      width,
      height,
      skin: skinUrl,
      model: modelType,
      cape: capeUrl || undefined,
      enableControls: true,
    });

    viewer.renderer.setClearColor(0x000000, 0);
    viewer.autoRotate = false;
    // 无披风时隐藏披风网格（避免默认白色 mesh）
    if (!capeUrl) {
      viewer.playerObject.backEquipment = null;
    }

    viewerRef.current = viewer;
    return () => {
      viewer.dispose();
      viewerRef.current = null;
    };
  }, [skinUrl, capeUrl, modelType, width, height]);

  // 动画模式
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    switch (animMode) {
      case 'walk':
        viewer.animation = new WalkingAnimation();
        break;
      case 'run':
        viewer.animation = new RunningAnimation();
        break;
      default:
        viewer.animation = new IdleAnimation();
    }
  }, [animMode]);

  // 旋转开关
  useEffect(() => {
    const viewer = viewerRef.current;
    if (viewer) viewer.autoRotate = rotating;
  }, [rotating]);

  const handleReset = useCallback(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    viewer.controls.reset();
    viewer.resetCameraPose();
  }, []);

  const tinyBtn = (label: string, active: boolean, onClick: () => void) => (
    <button className="skin3d__btn" data-active={active || undefined} onClick={onClick}>
      {label}
    </button>
  );

  return (
    <div style={{ width, maxWidth: '100%', display: 'flex', flexDirection: 'column' }}>
      <div
        style={{
          width,
          height,
          maxWidth: '100%',
          backgroundImage: [
            'linear-gradient(45deg, rgba(255,255,255,0.04) 25%, transparent 25%)',
            'linear-gradient(-45deg, rgba(255,255,255,0.04) 25%, transparent 25%)',
            'linear-gradient(45deg, transparent 75%, rgba(255,255,255,0.04) 75%)',
            'linear-gradient(-45deg, transparent 75%, rgba(255,255,255,0.04) 75%)',
          ].join(','),
          backgroundSize: '64px 64px',
          backgroundPosition: '0 0, 0 32px, 32px -32px, -32px 0px',
          backgroundColor: 'var(--bg-inner)',
          borderRadius: 8,
          overflow: 'hidden',
        }}
      >
        <canvas ref={canvasRef} style={{ display: 'block' }} />
      </div>

      <div
        style={{
          display: 'flex',
          justifyContent: 'center',
          gap: 6,
          padding: '8px 0 0 0',
          flexWrap: 'wrap',
        }}
      >
        {tinyBtn('↻ 旋转', rotating, () => setRotating((v) => !v))}
        {tinyBtn('待机', animMode === 'idle', () => setAnimMode('idle'))}
        {tinyBtn('行走', animMode === 'walk', () => setAnimMode('walk'))}
        {tinyBtn('奔跑', animMode === 'run', () => setAnimMode('run'))}
        {tinyBtn('复位', false, handleReset)}
      </div>
    </div>
  );
}
