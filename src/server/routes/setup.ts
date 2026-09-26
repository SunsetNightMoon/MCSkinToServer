import { Router, type Request, type Response } from 'express';
import { AppError } from '../../errors.js';
import type { AppConfig } from '../../config.js';
import type { SecretBox } from '../../util/secretBox.js';
import {
  assertSetupOpen,
  completeSetup,
  testDatabase,
  testRedis,
  testSmtp,
  type CompleteSetupInput,
  type SetupProbeDeps,
} from '../../setup/setupService.js';
import { isSetupCompleted } from '../../setup/setupState.js';

/**
 * 安装向导端点（P5 第十二批）。
 *
 * - GET  /api/setup/status    安装状态（前端路由守卫用；匿名可访问）
 * - POST /api/setup/test-db   探测数据库（参数来自请求体，不依赖已装状态）
 * - POST /api/setup/test-email 探测 SMTP
 * - POST /api/setup/test-redis 探测 Redis（可选组件，探测失败不拦安装）
 * - POST /api/setup/complete  完成安装（唯一写入口；已安装 → 410 语义的 403）
 *
 * **已安装后全部拒绝**：数据库类型选定后不可更改（产品硬约束），
 * 所以 complete 只许走一次；探测端点同理 —— 装完再探没有意义，还可能
 * 被用来探测「装过的站点用的是什么库」。status 例外：前端任何时刻都要
 * 用它的返回值决定渲染向导还是正常应用。
 */

export interface SetupRouteDependencies {
  /** 探测用的路径信息（安装模式下没有运行时连接，SQLite 探测按文件路径做） */
  probe: SetupProbeDeps;
  config: AppConfig;
  /** SMTP_PASS 加密（未注入主密钥时按明文落库，与管理端 settings 同语义） */
  secretBox?: SecretBox;
  /** complete 成功且响应发出后触发：进程内软重启为正常模式 */
  onInstalled?: () => void;
}

export function createSetupRoutes(deps: SetupRouteDependencies): Router {
  const router = Router();

  router.get('/api/setup/status', (_req: Request, res: Response) => {
    // mode = **进程真实状态**，不是文件状态：complete 落盘后到软重启完成前，
    // setup_completed 已是 true 但业务接口还不可用，前端必须凭 mode 判断
    // 「已生效」才能放行进入站点（否则会撞上 403 SETUP_REQUIRED）。
    res.json({ setup_completed: isSetupCompleted(), mode: 'installing' });
  });

  router.post('/api/setup/test-db', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await testDatabase(
      {
        dbType: String(body['db_type'] ?? ''),
        dbHost: str(body, 'db_host'),
        dbPort: body['db_port'] as number | string | undefined,
        dbName: str(body, 'db_name'),
        dbUser: str(body, 'db_user'),
        dbPassword: str(body, 'db_password'),
      },
      deps.probe,
    );
    // 探测失败也回 200 + ok:false（与旧版 plan3 同口径）：前端是「体检按钮」，
    // 4xx 会让它落到通用错误处理，丢掉了具体原因（连接被拒/认证失败/库不存在）。
    res.json({ success: result.ok, message: result.message });
  });

  router.post('/api/setup/test-email', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await testSmtp({
      mailHost: str(body, 'mail_host') ?? '',
      mailPort: body['mail_port'] as number | string | undefined,
      mailUser: str(body, 'mail_user'),
      mailPass: str(body, 'mail_pass'),
      mailFrom: str(body, 'mail_from'),
    });
    res.json({ success: result.ok, message: result.message });
  });

  router.post('/api/setup/test-redis', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await testRedis({
      redisHost: str(body, 'redis_host') ?? '',
      redisPort: body['redis_port'] as number | string | undefined,
      redisPassword: str(body, 'redis_password'),
    });
    res.json({ success: result.ok, message: result.message });
  });

  router.post('/api/setup/complete', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const input: CompleteSetupInput = {
      siteName: str(body, 'site_name') ?? '',
      dbType: str(body, 'db_type') === 'postgresql' ? 'postgresql' : 'sqlite',
      dbHost: str(body, 'db_host'),
      dbPort: toInt(body['db_port']),
      dbName: str(body, 'db_name'),
      dbUser: str(body, 'db_user'),
      dbPassword: str(body, 'db_password'),
      redisEnabled: body['redis_enabled'] === true,
      redisHost: str(body, 'redis_host'),
      redisPort: toInt(body['redis_port']),
      redisPassword: str(body, 'redis_password'),
      mailHost: str(body, 'mail_host'),
      mailPort: toInt(body['mail_port']),
      mailUser: str(body, 'mail_user'),
      mailPass: str(body, 'mail_pass'),
      mailFrom: str(body, 'mail_from'),
      defaultLanguage: str(body, 'default_language'),
      adminUsername: str(body, 'admin_username') ?? '',
      adminEmail: str(body, 'admin_email') ?? '',
      adminPassword: str(body, 'admin_password') ?? '',
    };
    if (input.dbType === 'postgresql') {
      if (!input.dbHost || !input.dbName || !input.dbUser) {
        throw new AppError('VALIDATION_ERROR', 'PostgreSQL 信息不完整（需要主机 / 库名 / 用户）');
      }
    }
    // 幂等闸门放最前：已落 setup.json 的一切再操作都拒绝（不可更改的硬约束）
    assertSetupOpen();
    const result = await completeSetup(input, { config: deps.config, secretBox: deps.secretBox });
    // 软重启会关掉当前 server，必须等本响应完整发出后再触发
    res.on('finish', () => deps.onInstalled?.());
    res.json({
      success: true,
      message: '安装完成，正在生效',
      db_type: result.dbType,
      admin_user_uid: result.adminUserUid,
    });
  });

  return router;
}

function str(body: Record<string, unknown>, key: string): string | undefined {
  const v = body[key];
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t === '' ? undefined : t;
}

function toInt(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.floor(v);
  const n = Number(String(v ?? '').trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}
