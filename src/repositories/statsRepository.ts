import { phAt } from '../db/rows.js';
import { DEFAULT_STATS_TZ_OFFSET_MINUTES } from '../config.js';
import type { DatabaseConnection } from '../types.js';

/**
 * 管理后台统计仓储（P5 第五批补）。
 *
 * ## 为什么单独一个仓储
 *
 * 旧实现是前端 `apiCompat` 里**拼三个业务接口**凑出来的（`/api/admin/users`
 * 的 total + `/api/library` 的 total + 两次 `/api/admin/reviews` 的 items.length），
 * 有两个直接后果：
 *   1. 「皮肤总数」取的是**公开素材库**的计数（只含 public + approved），
 *      管理员看到的是「站上公开了几张皮」，而不是「站里有多少张皮」；
 *   2. 待审核数用 `items.length`，而 `/api/admin/reviews` **不分页也不带总数**，
 *      数据一多这个数就是错的。
 * 聚合就该在数据库里做一次，而不是拉几页数据在前端数。
 *
 * ## 口径（已与用户确认）
 *
 * - `userCount`     = 未注销用户数（`deleted_at IS NULL`）—— **状态口径**
 * - `skinCount`     = 全部皮肤资产，**含待审与被拒**
 * - `pendingCount`  = `review_status = 'pending'` 的资产数
 *
 * ## 「历史事件」与「当前状态」两种口径别混
 *
 * - `userRegistrations` 是**事件口径**：该日注册了多少人。注册后又注销的账号
 *   仍然计入当天 —— 历史事件不会因为后来发生的事而不再是事实。
 * - `pendingSubmissions` 是**状态口径**：该日创建的资产中**当前**仍为 pending 的数量
 *   （「当日提交、至今未审」）。**已知局限**：一条资产被审核后，它所在那一天的
 *   计数会下降。这不是 bug，是「提交时不留 pending 流水」这一既有设计决定的
 *   （`asset_reviews` 只在管理员审核时插行，见表注释）。要变成历史口径，
 *   需要在提交时插一条 `status='pending'` 流水。
 * - 两者刻意不强行对齐：把注册趋势也改成状态口径会让曲线随注销而回退，更难解释。
 *
 * ## 时区
 *
 * 时间戳一律以 UTC 存储（TEXT ISO-8601 / TIMESTAMPTZ），但「某天」是给人看的。
 * 直接按 UTC 日期分桶会让北京时间 00:00–08:00 的活动被算到**前一天**。
 * 因此分桶统一按 `tzOffsetMinutes`（默认 +480 = UTC+8）平移后再取日期，
 * 且 `days` 数组用**同一个偏移**生成，两边的日期边界必须一致。
 */

/** `days` 查询参数下限 */
export const MIN_STATS_DAYS = 1;
/** `days` 查询参数上限（再长图表也读不出来，且扫描量无谓变大） */
export const MAX_STATS_DAYS = 90;

export interface AdminStatsOverview {
  userCount: number;
  skinCount: number;
  pendingCount: number;
}

/**
 * 趋势序列。六个数组**等长且与 `days` 一一对应**（缺失日期补 0），
 * 前端按下标取值（`dailyStats.skinUploads[i]`），长度不一致会静默错位。
 */
export interface AdminStatsDaily {
  /** `YYYY-MM-DD`，升序，最后一项是偏移时区下的「今天」 */
  days: string[];
  skinUploads: number[];
  capeUploads: number[];
  userRegistrations: number[];
  pendingSubmissions: number[];
  banCounts: number[];
}

/**
 * 生成 `days` 数组：以 `now` 为终点、按 `offsetMinutes` 平移后的连续日期。
 *
 * 用「平移后的瞬时时间 + 毫秒运算」而不是本地时区 API：固定偏移没有夏令时，
 * 毫秒减法就是正确的日期退减，也不依赖服务器进程的 TZ 设置（生产容器常为 UTC）。
 */
export function buildDayKeys(days: number, offsetMinutes: number, now: Date): string[] {
  const shiftedNow = now.getTime() + offsetMinutes * 60_000;
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    out.push(new Date(shiftedNow - i * 86_400_000).toISOString().slice(0, 10));
  }
  return out;
}

/** 把 map 按 days 展平成等长数组，缺失补 0 */
function seriesFrom(days: string[], counts: Map<string, number>): number[] {
  return days.map((d) => counts.get(d) ?? 0);
}

export class StatsRepository {
  constructor(
    private readonly db: DatabaseConnection,
    private readonly tzOffsetMinutes: number = DEFAULT_STATS_TZ_OFFSET_MINUTES,
  ) {}

  /** 一条 SQL 出三个数：避免多次往返，也避免在前端数 items */
  async overview(): Promise<AdminStatsOverview> {
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT
         (SELECT COUNT(*) FROM users WHERE deleted_at IS NULL)      AS user_count,
         (SELECT COUNT(*) FROM assets WHERE kind = 'skin')          AS skin_count,
         (SELECT COUNT(*) FROM assets WHERE review_status = 'pending') AS pending_count`,
    );
    const row = rows[0] ?? {};
    return {
      userCount: Number(row['user_count'] ?? 0),
      skinCount: Number(row['skin_count'] ?? 0),
      pendingCount: Number(row['pending_count'] ?? 0),
    };
  }

  /**
   * 按日聚合。SQL 只产出**有数据的日子**，缺失日期由 `buildDayKeys` 补 0 ——
   * 这是必须在应用层做的一步：SQL 的 GROUP BY 天生不会产出空行，
   * 直接拿结果画图会让没有活动的日子整段消失、横轴被压缩。
   */
  async daily(days: number): Promise<AdminStatsDaily> {
    const dayKeys = buildDayKeys(days, this.tzOffsetMinutes, new Date());
    // 三条语句里 `dayExpr` 都是唯一的占位符（日期只出现在 SELECT/GROUP BY，
    // 不在 WHERE），所以每条各绑一份修正符即可，不存在编号错位。
    const modifier = this.dayExprModifier;
    const [assetRows, regRows, banRows] = await Promise.all([
      this.db.query<Record<string, unknown>>(
        `SELECT ${this.dayExpr('created_at')} AS d, kind, review_status, COUNT(*) AS n
           FROM assets
          GROUP BY d, kind, review_status`,
        [modifier],
      ),
      this.db.query<Record<string, unknown>>(
        `SELECT ${this.dayExpr('created_at')} AS d, COUNT(*) AS n
           FROM users
          GROUP BY d`,
        [modifier],
      ),
      this.db.query<Record<string, unknown>>(
        `SELECT ${this.dayExpr('banned_at')} AS d, COUNT(*) AS n
           FROM users
          WHERE banned_at IS NOT NULL
          GROUP BY d`,
        [modifier],
      ),
    ]);

    const skin = new Map<string, number>();
    const cape = new Map<string, number>();
    const pending = new Map<string, number>();
    for (const r of assetRows) {
      const d = String(r['d'] ?? '');
      const n = Number(r['n'] ?? 0);
      if (d === '') continue;
      if (r['kind'] === 'skin') skin.set(d, (skin.get(d) ?? 0) + n);
      else if (r['kind'] === 'cape') cape.set(d, (cape.get(d) ?? 0) + n);
      if (r['review_status'] === 'pending') pending.set(d, (pending.get(d) ?? 0) + n);
    }

    const reg = new Map<string, number>();
    for (const r of regRows) {
      const d = String(r['d'] ?? '');
      if (d !== '') reg.set(d, Number(r['n'] ?? 0));
    }

    const bans = new Map<string, number>();
    for (const r of banRows) {
      const d = String(r['d'] ?? '');
      if (d !== '') bans.set(d, Number(r['n'] ?? 0));
    }

    return {
      days: dayKeys,
      skinUploads: seriesFrom(dayKeys, skin),
      capeUploads: seriesFrom(dayKeys, cape),
      userRegistrations: seriesFrom(dayKeys, reg),
      pendingSubmissions: seriesFrom(dayKeys, pending),
      banCounts: seriesFrom(dayKeys, bans),
    };
  }

  /**
   * 把 UTC 存储的时间列换算成「偏移时区下的日期字符串」。
   *
   * - SQLite：时间列是 TEXT ISO-8601（带 `Z`），`date()` 直接认这个格式；
   *   修正符可以绑参（实测 3.49 支持），所以偏移不必拼进 SQL 文本。
   * - PostgreSQL：`timestamptz + interval` 仍是 timestamptz，若不显式
   *   `AT TIME ZONE 'UTC'`，`to_char` 会按**会话 TimeZone** 渲染 ——
   *   同一份数据在不同连接上可能落到不同日期。这里固定成 UTC 再格式化，
   *   让结果只取决于 `tzOffsetMinutes`。
   */
  private dayExpr(column: string): string {
    const ph = phAt(this.db.dialect, 0);
    if (this.db.dialect === 'postgres') {
      return `to_char((${column} + (${ph}::interval)) AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;
    }
    return `date(${column}, ${ph})`;
  }

  /** 与 `dayExpr` 的占位符一一对应的绑定值 */
  private get dayExprModifier(): string {
    return `${this.tzOffsetMinutes >= 0 ? '+' : ''}${this.tzOffsetMinutes} minutes`;
  }
}
