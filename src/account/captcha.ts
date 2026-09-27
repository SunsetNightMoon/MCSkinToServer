import { randomUUID } from 'node:crypto';
import { AppError } from '../errors.js';
import { sha256Hex } from '../util/crypto.js';
import type { CaptchaRepository } from '../repositories/captchaRepository.js';
import { generateCaptchaCode, renderCaptchaPng } from './captchaImage.js';

/**
 * 自托管人机验证（0004 数学题 + Issue #3 图片题）。
 *
 * ## 定位：挡脚本，不挡人
 *
 * 数学题对有心人毫无难度 —— 它的目标是拦掉「拿一份邮箱列表跑批量注册」这类
 * 无成本脚本，不是对抗定向攻击。图片题把题干收进服务端、只回 PNG，脚本没法再
 * 直接读明文题目，但 OCR 仍打得开，所以定位一样。因此设计上优先**不误伤真人**：
 *
 * - 题目只有两个操作数，结果非负且 ≤ 81，心算一秒出答案。
 * - 有效期 10 分钟。**这个值不能太小**：旧版前端在页面挂载时就取题，用户可能
 *   先慢慢填邮箱和密码才提交。5 分钟会让「想了一会儿密码」变成「验证码已过期」。
 * - 答错不锁账号，只是这道题作废、换一道重来（旧版前端 catch 里会自动换题）。
 *
 * ## 与安全有关的三条硬规则
 *
 * 1. **一次一题**：`session_id` 由客户端提供（旧前端就是这么发的），后端据此找回
 *    当时的答案。校验必须「未使用 + 未过期」，且**消费是原子的**（仓储层一条
 *    UPDATE 决定胜负）—— 否则同一个答案可以无限次提交，验证码等于不存在。
 * 2. **先消费再比对**：答案错误也把这道题烧掉。若改成「比对错了就放回去」，
 *    攻击者可以拿同一道题把 0..200 全试一遍。
 * 3. **答错不透露细节**：不存在 / 已用过 / 已过期 / 答案错，四种情况返回**同一个
 *    错误码与同一句文案**（见 errors.ts 里 CAPTCHA_INVALID 的注释）。
 *
 * 答案只以 `sha256` 入库（明文只在内存里存在一瞬），与项目内其它一次性凭据同一习惯。
 */
export interface CaptchaQuestion {
  sessionId: string;
  /** 直接展示给用户的题干，例如 `3 + 7 = ?` */
  question: string;
  /** 有效期秒数（前端目前不展示倒计时，返回它只为将来可用） */
  expiresInSeconds: number;
}

export interface CaptchaServiceDeps {
  challenges: CaptchaRepository;
  /** 测试注入可推进的假钟 */
  now?: () => Date;
}

/** 题目有效期：见文件头「为什么不能太小」 */
export const CAPTCHA_TTL_SECONDS = 10 * 60;

/** session_id 只做形态校验：它是关联号，不是凭据 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{4,64}$/;

function requireSessionId(sessionId: unknown): string {
  const id = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!SESSION_ID_PATTERN.test(id)) {
    throw new AppError(
      'VALIDATION_ERROR',
      '缺少或非法的 sessionId（4-64 位字母/数字/下划线/连字符）',
    );
  }
  return id;
}

type Operator = '+' | '-' | '×';

interface GeneratedQuestion {
  text: string;
  answer: number;
}

/**
 * 生成一道可直接心算的题。
 *
 * - `+`：两个 1..20 的数，结果 ≤ 40
 * - `-`：被减数 5..30、减数保证结果 ≥ 1（**不做负数**，否则用户要先判断符号）
 * - `×`：两个 2..9 的数，结果 ≤ 81
 *
 * 刻意不做除法：整除约束会让题目出现「17 ÷ 17」这类看起来像陷阱的东西，
 * 而且结果分布会明显偏斜到 1 附近。
 */
export function generateQuestion(random: () => number = Math.random): GeneratedQuestion {
  const operators: Operator[] = ['+', '-', '×'];
  const op = operators[Math.floor(random() * operators.length)] ?? '+';
  const pick = (min: number, max: number): number =>
    min + Math.floor(random() * (max - min + 1));

  let a: number;
  let b: number;
  let answer: number;

  if (op === '+') {
    a = pick(1, 20);
    b = pick(1, 20);
    answer = a + b;
  } else if (op === '-') {
    a = pick(5, 30);
    b = pick(1, a - 4);
    answer = a - b;
  } else {
    a = pick(2, 9);
    b = pick(2, 9);
    answer = a * b;
  }

  return { text: `${a} ${op} ${b} = ?`, answer };
}

/** 把用户输入规范成可比对的整数串；非法输入返回 null */
export function normalizeAnswer(raw: unknown): string | null {
  if (typeof raw === 'number') {
    return Number.isInteger(raw) ? String(raw) : null;
  }
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!/^[+-]?\d{1,6}$/.test(trimmed)) return null;
  return String(Number.parseInt(trimmed, 10));
}

export class CaptchaService {
  private readonly challenges: CaptchaRepository;
  private readonly now: () => Date;

  constructor(deps: CaptchaServiceDeps) {
    this.challenges = deps.challenges;
    this.now = deps.now ?? (() => new Date());
  }

  /** 出题并落库。顺带清理过期行，保证表不会无限增长 */
  async generate(sessionId: unknown): Promise<CaptchaQuestion> {
    const id = requireSessionId(sessionId);
    const { text, answer } = generateQuestion();
    await this.issue(id, String(answer));

    return {
      sessionId: id,
      question: text,
      expiresInSeconds: CAPTCHA_TTL_SECONDS,
    };
  }

  /**
   * 出一道图片题，只回 PNG。
   *
   * 与 `generate` 的关键区别：**题干与答案都不进响应**。客户端只拿到一张图和
   * 自己的 sessionId，剩下的三条硬规则（一次一题、先消费再比对、错误不透露细节）
   * 与数学题完全共用同一套仓储与 `verify`。
   */
  async generateImage(
    sessionId: unknown,
  ): Promise<{ sessionId: string; png: Uint8Array }> {
    const id = requireSessionId(sessionId);
    const code = generateCaptchaCode();
    await this.issue(id, code);
    const png = await renderCaptchaPng(code);
    return { sessionId: id, png };
  }

  /** 写入一道新题（同一 sessionId 只保留最新一道） */
  private async issue(id: string, answer: string): Promise<void> {
    const now = this.now();
    await this.challenges.replace({
      id: randomUUID(),
      sessionId: id,
      answerHash: sha256Hex(answer),
      expiresAt: new Date(now.getTime() + CAPTCHA_TTL_SECONDS * 1000),
      createdAt: now,
    });

    // 清理放在写入之后：即便清理失败也不该影响出题
    try {
      await this.challenges.deleteExpired(now);
    } catch (err) {
      console.warn(
        '[captcha] 过期题清理失败（不影响出题）：',
        err instanceof Error ? err.message : err,
      );
    }
  }

  /**
   * 校验并消费。失败抛 `CAPTCHA_INVALID`（HTTP 400）。
   *
   * 顺序是**先消费、再比对**：答案错误也烧掉这道题，见文件头第 2 条。
   */
  async verify(sessionId: unknown, answer: unknown): Promise<void> {
    const id = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (id === '') {
      throw new AppError('CAPTCHA_INVALID', '请先完成人机验证');
    }

    const consumed = await this.challenges.consume(id, this.now());
    if (!consumed) {
      // 不存在 / 已用过 / 已过期 —— 统一文案，不给探测者额外信息
      throw new AppError('CAPTCHA_INVALID', '人机验证已失效，请换一道重试');
    }

    const expected = normalizeAnswer(answer);
    if (expected === null || sha256Hex(expected) !== consumed.answerHash) {
      throw new AppError('CAPTCHA_INVALID', '人机验证答案不正确，请换一道重试');
    }
  }
}
