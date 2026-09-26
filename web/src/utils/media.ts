/**
 * 判断文件是否为视频（用于背景/内嵌媒体渲染）
 * 支持 .webm 和 .mp4，自动忽略 URL 查询参数和 hash
 */
export const isVideoFile = (url: string): boolean => {
  if (!url) return false;
  // 去掉查询参数和 hash 后再检测扩展名
  const pathOnly = url.split('?')[0].split('#')[0].toLowerCase();
  return pathOnly.endsWith('.webm') || pathOnly.endsWith('.mp4');
};
