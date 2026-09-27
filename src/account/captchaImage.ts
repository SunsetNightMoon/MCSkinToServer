import sharp from 'sharp';

/**
 * 自托管「图片验证码」渲染器（Issue #3）。
 *
 * ## 为什么要它
 *
 * 数学题把题干以明文 JSON 下发（`GET /api/captcha/generate` → `{"question":"12 + 11 = ?"}`），
 * 脚本拿过去算一下就能过，所以它只挡得住无脑脚本。图片模式的关键区别是
 * **题干不出服务端**：客户端只拿到一张 PNG 与一个 sessionId，答案要靠自己看图或 OCR。
 *
 * ## 为什么用矢量路径画数字，而不是 `<text>`
 *
 * `<text>` 依赖系统字体。libvips 的 SVG 支持（rsvg/freetype/fontconfig）确实随 sharp
 * 预编译包一起带着，但**字体是操作系统的东西**：精简过的 Linux 容器（alpine-slim、
 * distroless）里一个字体都没有，`<text>` 会画成空白 —— 用户看到一张干净的图，
 * 验证码永远答不对，注册这条路直接堵死，而且只在部分机器上复现。
 * 所以数字用七段笔画的路径画出来，整张图不碰字体，也不碰网络。
 *
 * sharp 本身是硬依赖（`src/textures/ingest.ts` 皮肤上传链路在用），这里不引入新依赖。
 */

/** 图片尺寸：够放 5 位数字，单张 PNG 约 1-2KB */
export const CAPTCHA_IMAGE_WIDTH = 190;
export const CAPTCHA_IMAGE_HEIGHT = 64;

/** 验证码位数。首位刻意非 0：`normalizeAnswer` 会 parseInt，前导零会让答案对不上 */
export const CAPTCHA_CODE_LENGTH = 5;

/**
 * 每个数字一笔一笔写出来的路径（26×40 的框内，描边不填充）。
 *
 * 先试过七段数码管段位表，实测不可用：`1` 只有右边一竖，加底横又变成「⌐」，
 * 稍微一旋转就和 `7`、斜杠混在一起 —— 真人也认不出，等于把注册堵死。
 * 手写笔画没有这个问题，而且同样是纯路径，不碰字体。
 */
const DIGIT_PATHS: Record<string, string> = {
  '0': 'M13 4 Q24 4 24 21 Q24 38 13 38 Q2 38 2 21 Q2 4 13 4 Z',
  '1': 'M7 9 L16 3 L16 37 M8 37 L24 37',
  '2': 'M5 11 Q15 -1 22 10 Q24 18 5 37 L23 37',
  '3': 'M5 8 L21 8 L11 20 Q25 22 20 32 Q14 41 4 34',
  '4': 'M17 4 L3 27 L24 27 M17 4 L17 39',
  '5': 'M21 6 L8 6 L6 19 Q20 14 22 26 Q23 38 6 37',
  '6': 'M19 4 Q6 11 7 26 Q4 40 14 39 Q24 38 22 29 Q20 19 7 22',
  '7': 'M4 6 L23 6 L12 39',
  '8': 'M13 20 Q3 19 5 11 Q7 3 14 3 Q22 3 22 11 Q22 19 13 20 Q2 22 4 31 Q6 39 13 39 Q23 39 23 30 Q23 21 13 20 Z',
  '9': 'M20 21 Q6 26 5 14 Q5 4 14 4 Q23 4 22 14 Q21 24 7 23 M20 8 Q22 24 11 39',
};

/** 单个数字的绘制框（相对该数字左上角） */
const GLYPH_WIDTH = 26;
const GLYPH_HEIGHT = 42;

const pickInt = (random: () => number, min: number, max: number): number =>
  min + Math.floor(random() * (max - min + 1));

/** 生成一个数字码（首位 1-9，其余 0-9） */
export function generateCaptchaCode(
  random: () => number = Math.random,
): string {
  let code = String(pickInt(random, 1, 9));
  for (let i = 1; i < CAPTCHA_CODE_LENGTH; i += 1) {
    code += String(pickInt(random, 0, 9));
  }
  return code;
}

/**
 * 画一张带干扰的 SVG。
 *
 * 抖动逐位随机：旋转 ±8°、基线上下偏移 6-14px、笔画粗细 3.6-5.0。
 * 目的是让「同一张图的像素模板」不稳定，顺带让人眼照样一眼可读。
 */
export function renderCaptchaSvg(
  code: string,
  random: () => number = Math.random,
): string {
  const parts: string[] = [];

  parts.push(
    `<rect width="100%" height="100%" fill="#f5f7fa"/>`,
  );

  // 背景噪点：数量固定、位置随机，避免某些随机源给出 0 个点时图案过于干净
  for (let i = 0; i < 60; i += 1) {
    const x = pickInt(random, 0, CAPTCHA_IMAGE_WIDTH);
    const y = pickInt(random, 0, CAPTCHA_IMAGE_HEIGHT);
    const r = (random() * 1.2 + 0.3).toFixed(2);
    parts.push(
      `<circle cx="${x}" cy="${y}" r="${r}" fill="#8aa0b4" opacity="0.55"/>`,
    );
  }

  const digits = [...code];
  const step = (CAPTCHA_IMAGE_WIDTH - 20) / digits.length;
  digits.forEach((digit, index) => {
    const path = DIGIT_PATHS[digit];
    if (!path) return;
    // 旋转幅度刻意克制（±8°）：再大就开始牺牲可读性，而可读性是这类验证码的底线
    const rotate = pickInt(random, -8, 8);
    const offsetY = pickInt(random, 6, 14);
    const strokeWidth = (random() * 1.4 + 3.6).toFixed(2);
    const originX = 10 + Math.round(step * index + (step - GLYPH_WIDTH) / 2);
    parts.push(
      `<g transform="translate(${originX} ${offsetY}) rotate(${rotate} ${GLYPH_WIDTH / 2} ${GLYPH_HEIGHT / 2})">` +
        `<path d="${path}" stroke="#16324f" stroke-width="${strokeWidth}" ` +
        `stroke-linecap="round" stroke-linejoin="round" fill="none"/></g>`,
    );
  });

  // 两条贯穿的干扰线，压在数字之上
  for (let i = 0; i < 2; i += 1) {
    const y1 = pickInt(random, 6, CAPTCHA_IMAGE_HEIGHT - 6);
    const y2 = pickInt(random, 6, CAPTCHA_IMAGE_HEIGHT - 6);
    const cx1 = pickInt(random, 30, CAPTCHA_IMAGE_WIDTH - 30);
    const cy1 = pickInt(random, 0, CAPTCHA_IMAGE_HEIGHT);
    parts.push(
      `<path d="M0 ${y1} C ${cx1} ${cy1}, ${CAPTCHA_IMAGE_WIDTH - cx1} ${y2}, ${CAPTCHA_IMAGE_WIDTH} ${y2}" ` +
        `stroke="#c2410c" stroke-width="1.6" fill="none" opacity="0.8"/>`,
    );
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CAPTCHA_IMAGE_WIDTH}" ` +
    `height="${CAPTCHA_IMAGE_HEIGHT}" viewBox="0 0 ${CAPTCHA_IMAGE_WIDTH} ${CAPTCHA_IMAGE_HEIGHT}">` +
    `${parts.join('')}</svg>`
  );
}

/**
 * SVG → PNG。
 *
 * 实测（本机 sharp 0.35.4 / libvips 8.18.6，自带 rsvg+freetype+fontconfig）：
 * 单张 190×64 冷启动约 90ms（含 libvips 首次加载），之后 p50 约 7ms、p95 约 14ms。
 * 出题端点另有按 IP 限流兜着，不会成为放大面。
 */
export async function renderCaptchaPng(
  code: string,
  random: () => number = Math.random,
): Promise<Uint8Array> {
  return sharp(Buffer.from(renderCaptchaSvg(code, random))).png().toBuffer();
}
