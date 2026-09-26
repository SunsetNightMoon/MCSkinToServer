import { dirname, resolve } from 'node:path';
import type { Server } from 'node:http';
import { loadConfig, type AppConfig } from '../config.js';
import { SecretBox } from '../util/secretBox.js';
import { createSetupApp } from './setupApp.js';
import { buildInstalledApp } from './bootstrap.js';

/**
 * 启动生命周期（蓝图 §5.1）：
 * loadConfig → 安装分流：
 * - installing：只起「安装模式最小应用」（不连库不装配业务依赖）。
 *   向导 complete 后**原地软重启**（P5 第十二批补充）：用刚落盘的 setup.json
 *   重新 loadConfig → buildInstalledApp → 构建成功后才关旧 listen 新。
 *   先构建再关旧是刻意的：装配失败（如库连不上）时旧服务还在，
 *   状态接口仍回 installing，前端停在「正在配置中」而不是白屏死站。
 * - installed / auto：完整装配 + listen（见 bootstrap.ts）。
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const port = Number(process.env['PORT'] ?? 3000);

  if (config.installMode === 'installing') {
    startInstallMode(config, port);
    return;
  }

  const { app, closeResources } = await buildInstalledApp(config);
  const server = app.listen(port, () => {
    console.log(`[mcsts] listening on http://localhost:${port}`);
  });
  registerShutdown(server, closeResources);
}

function startInstallMode(config: AppConfig, port: number): void {
  const dataDir = resolve(process.cwd(), dirname(config.sqlitePath));
  let restarting = false;
  let setupServer: Server | undefined;

  const softRestart = async (): Promise<void> => {
    // complete 端点的幂等闸门（setup.json 存在即 403）已保证只会触发一次；
    // 这个标志防御重复回调让两条装配链赛跑着同时换绑端口。
    if (restarting) return;
    restarting = true;
    console.log('[mcsts] 安装完成，正在切换为正常模式（原地重启）…');
    try {
      const installedConfig = loadConfig();
      const { app, closeResources } = await buildInstalledApp(installedConfig);
      if (setupServer) {
        setupServer.closeAllConnections();
        await new Promise<void>((done) => setupServer!.close(() => done()));
      }
      const server = app.listen(port, () => {
        console.log(`[mcsts] 安装已生效：http://localhost:${port}`);
      });
      // 换绑后信号处理交给新服务；旧服务的资源本来就没有
      registerShutdown(server, closeResources, true);
    } catch (err) {
      console.error(
        '[mcsts] 安装后自动切换失败，站点仍在安装模式。请重启后端进程：',
        err instanceof Error ? err.message : err,
      );
      restarting = false;
    }
  };

  const setupApp = createSetupApp(
    config,
    { dataDir, sqlitePath: config.sqlitePath },
    SecretBox.fromEnv() ?? undefined,
    { onInstalled: () => void softRestart() },
  );
  setupServer = setupApp.listen(port, () => {
    console.log(
      `[mcsts] install mode — open /setup to run the wizard (port ${port})`,
    );
  });
  registerShutdown(setupServer, async () => undefined);
}

function registerShutdown(
  server: Server,
  closeResources: () => Promise<void>,
  replace = false,
): void {
  const shutdown = (): void => {
    server.closeAllConnections();
    server.close(() => {
      void closeResources().then(() => process.exit(0));
    });
    setTimeout(() => process.exit(0), 3000).unref();
  };
  if (replace) {
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void main().catch((err: unknown) => {
  console.error('[mcsts] fatal:', err);
  process.exitCode = 1;
});
