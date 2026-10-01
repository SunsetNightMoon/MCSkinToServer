import type { AppConfig } from '../config.js';
import { normalizePluginMirror } from '../config.js';
import { MASTER_SECRET_ENV } from '../util/secretBox.js';

/**
 * 启动配置自检：把「能跑，但缺了会出怪事」的配置项在启动日志里点名。
 *
 * ## 为什么要有这个
 *
 * 生产上踩过两类坑，都不是代码缺陷，而是配置面没有回声：
 * - 部署在反代之后却没设 `TRUST_PROXY`，于是所有按来源 IP 的限流把全网用户算成
 *   同一个桶，症状是「一部分用户莫名其妙被 429」，而日志里看不出为什么。
 * - 站点设置里的 SMTP 口令明文落库（没设 `MCSTS_SECRET`），数据库备份把它一起带出去。
 *
 * 这些配置**都有合法的缺省**，所以不能让启动失败；但「静默采用缺省」和「运维知道
 * 自己没用缺省」是两回事。这里只做一件事：在启动日志里逐项写清缺了会看到什么症状、
 * 以及能不能忽略。
 *
 * ## 口径
 *
 * - **只提示，不阻断**，且只在装配阶段打一次（不进请求路径，不给每个请求增加开销）。
 * - 不做「检测是否真的在反代后面」这种猜测：进程看不到链路，只有运维知道。
 *   因此本条写成条件句 —— 不在反代后可忽略，在反代后必须设。
 * - 判定全部是纯函数（输入 config / env / 站点根是否已声明），便于测试与将来复用。
 */

/** 一条缺项提示 */
export interface ConfigGap {
  /** 涉及的配置项名（环境变量名，或后台设置键） */
  item: string;
  /** 缺了会看到什么症状 + 该怎么处理 */
  hint: string;
}

export interface ConfigGapContext {
  config: Pick<AppConfig, 'rateLimit'>;
  /** 环境变量来源；缺省 process.env（测试注入用） */
  env?: NodeJS.ProcessEnv;
  /**
   * 站点根是否已显式声明：后台设置 `BASE_URL` 或部署变量 `PUBLIC_BASE_URL`。
   * false 时邮件里的链接只能按触发请求的 Host 猜。
   */
  siteOriginDeclared: boolean;
}

function isSet(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

/** 列出当前配置的缺项；全部合格时返回空数组 */
export function checkConfigGaps(ctx: ConfigGapContext): ConfigGap[] {
  const env = ctx.env ?? process.env;
  const gaps: ConfigGap[] = [];

  if (!isSet(env[MASTER_SECRET_ENV])) {
    gaps.push({
      item: MASTER_SECRET_ENV,
      hint:
        '未设置 → 站点设置里的凭据类值（SMTP_PASS、EXTERNAL_CAPTCHA_SECRET）按明文落库，' +
        '数据库备份/只读副本会把它们带出去。补一个至少 16 字符的值后，' +
        '必须**重新保存**这两项才会加密（不会追溯加密历史明文）。',
    });
  }

  if (!isSet(env['TRUST_PROXY'])) {
    gaps.push({
      item: 'TRUST_PROXY',
      hint:
        '未设置 → req.ip 取的是直连方地址。本站若在反向代理之后，所有按来源 IP 的限流' +
        '（注册、验证码出题、启动器 refresh / 角色名查询、令牌消费）会把全部用户算成同一个桶，' +
        '症状是一部分用户莫名其妙被 429；此时补 TRUST_PROXY=1（或反代层数）。' +
        '确认不在可信反代之后的可以忽略本条 —— 乱设会让客户端伪造 X-Forwarded-For 绕过限流。',
    });
  }

  if (!ctx.siteOriginDeclared) {
    gaps.push({
      item: 'BASE_URL（后台站点设置）',
      hint:
        '未填写 → 邮件里的验证/重置链接按触发请求的 Host 现场推导。直连 IP、域名变更中、' +
        '或 CDN 传来的 Host 不是用户看到的地址时，链接会指向错的地方。' +
        '在「系统设置 → 邮箱设置」里填好站点根即可。',
    });
  }

  if (ctx.config.rateLimit?.enabled === false) {
    gaps.push({
      item: 'RATE_LIMIT_DISABLED',
      hint:
        '限流已整体关闭（排障/压测用的开关）。认证端点失去防暴力尝试的加固层，' +
        '确认是临时状态；用毕请删掉这一行恢复默认。',
    });
  }

  if (isSet(env['SMTP_ALLOW_SELF_SIGNED']) && env['SMTP_ALLOW_SELF_SIGNED'] !== 'false') {
    gaps.push({
      item: 'SMTP_ALLOW_SELF_SIGNED',
      hint:
        '已开启 → 发信时不校验 SMTP 服务端证书（内网邮件网关的常见妥协）。' +
        '邮件里有重置密码链接，中间人因此能拿到它；生产应改用真实证书后关掉本项。',
    });
  }

  // 填了却填错，比没填更需要回声：normalizePluginMirror 对非法值按未设置处理（不让一个
  // 可选旋钮拦下启动），所以这里必须替它说清楚「现在实际打的是 github.com」。
  if (isSet(env['MCSTS_PLUGIN_MIRROR']) && normalizePluginMirror(env['MCSTS_PLUGIN_MIRROR']) === undefined) {
    gaps.push({
      item: 'MCSTS_PLUGIN_MIRROR',
      hint:
        '已设置但不是合法的 https 绝对地址 → 按未设置处理，插件导入仍会直连 github.com。' +
        '要的是「把完整请求 URL 拼在后面」的转发前缀，形如 https://gh-proxy.com，' +
        '且它必须同时转发 api.github.com 与 raw.githubusercontent.com。',
    });
  }

  return gaps;
}

/** 打启动日志：一条一行，前缀统一便于运维 grep。无缺项时保持安静。 */
export function logConfigGaps(ctx: ConfigGapContext): void {
  const gaps = checkConfigGaps(ctx);
  if (gaps.length === 0) return;
  console.warn(
    `[mcsts] 配置自检：${gaps.length} 项建议配置未设置（不影响启动，逐条如下）`,
  );
  for (const gap of gaps) {
    console.warn(`[mcsts] 配置自检 · ${gap.item} —— ${gap.hint}`);
  }
}
