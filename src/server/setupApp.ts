import express, { type Express } from 'express';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { AppError } from '../errors.js';
import type { AppConfig } from '../config.js';
import type { SecretBox } from '../util/secretBox.js';
import { errorHandler } from './errorHandler.js';
import { createSetupRoutes } from './routes/setup.js';
import type { SetupProbeDeps } from '../setup/setupService.js';

/**
 * 安装模式的最小 Express 应用（P5 第十二批）。
 *
 * 只在 `config.installMode === 'installing'` 时使用：此时数据库还没建、
 * 全部业务仓储都不可用，所以**不挂任何业务路由**，只保留三件事：
 * 1. `/api/setup/*` 与 `/health/*` —— 安装向导与存活探测
 * 2. 静态托管 `web/dist` + SPA 兜底 —— 前端路由守卫据 status 渲染向导
 * 3. 其余 `/api/*` 一律 403 `SETUP_REQUIRED` —— 装完之前没人能碰业务接口
 *
 * 与完整 `createApp` 分开而不是在里面加开关：安装模式连数据库连接都没有，
 * 复用 createApp 就得给它塞一堆 null 依赖，反而把「未安装」这条本该一眼
 * 看穿的分支埋进了一堆可选判断里。两个 app 各自简单，边界清晰。
 */
export function createSetupApp(
  config: AppConfig,
  probe: SetupProbeDeps,
  secretBox?: SecretBox,
  hooks?: {
    /** complete 成功且响应已发出后回调：main.ts 用它做进程内软重启 */
    onInstalled?: () => void;
  },
): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));

  // 存活/就绪探测：安装模式下就绪 = 安装端点可达，不查数据库
  app.get('/health/live', (_req, res) => res.json({ status: 'ok' }));
  app.get('/health/ready', (_req, res) =>
    res.json({ status: 'ok', database: 'installing' }),
  );

  // 安装端点（status / test-db / test-email / test-redis / complete）
  app.use(createSetupRoutes({ config, probe, secretBox, onInstalled: hooks?.onInstalled }));

  // ---- 静态托管前端（安装向导就是前端 SPA 的 /setup 路由）----
  // 前端产物目录：优先 CWD/web/dist，其次仓库根的 web/dist（两种部署形态都覆盖）
  const candidates = [
    resolve(process.cwd(), 'web/dist'),
    resolve(process.cwd(), '../web/dist'),
  ];
  const distDir = candidates.find((d) => existsSync(resolve(d, 'index.html')));
  if (distDir) {
    app.use(express.static(distDir, { index: 'index.html' }));
    // SPA 兜底：非 /api 的未命中路径回 index.html（HashRouter 主要靠 # 路由，
    // 但直接访问 /setup 这类路径时仍需兜底，否则刷新会 404）
    app.get(/^(?!\/(api|health|uploads)).*/, (_req, res) => {
      res.sendFile(resolve(distDir, 'index.html'));
    });
  } else {
    // 没有前端产物：给个明确提示而不是静默 404（运维忘了 build 时能快速定位）
    app.get('*', (_req, res) => {
      res
        .status(503)
        .json({
          error: 'NOT_FOUND',
          message: '前端产物缺失：请运行 `npm --prefix web run build` 后再启动',
        });
    });
  }

  // ---- 业务接口闸门：安装未完成的站点，除 setup/health 外一律 403 ----
  // 放在静态之后、errorHandler 之前。抛 AppError 由 errorHandler 统一映射。
  app.use('/api', (_req, res, next) => {
    throw new AppError('SETUP_REQUIRED', '站点尚未完成安装，请先访问 /setup 完成安装向导');
  });

  // 未匹配的 /api 之外路径
  app.use((_req, res) => {
    res.status(404).json({ error: 'NOT_FOUND', message: 'Not Found' });
  });

  app.use(errorHandler);
  return app;
}
