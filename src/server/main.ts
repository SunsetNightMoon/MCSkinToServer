import { join } from 'node:path';
import { dialectDirName, loadConfig } from '../config.js';
import { createDatabase } from '../db/index.js';
import { runMigrations } from '../migrate/runner.js';
import { createStoragePort } from '../storage/index.js';
import { TokenService } from '../auth/tokens.js';
import { IdentityService } from '../auth/identity.js';
import { TokenRepository } from '../repositories/tokenRepository.js';
import { UserRepository } from '../repositories/userRepository.js';
import { ProfileRepository } from '../repositories/profileRepository.js';
import { MinecraftSessionRepository } from '../repositories/minecraftSessionRepository.js';
import { TextureProfileBuilder } from '../yggdrasil/textures.js';
import { AssetUrlResolver } from '../storage/assetUrl.js';
import { loadOrCreateKeyPair } from '../yggdrasil/keys.js';
import { createApp } from './app.js';

/**
 * 启动生命周期（蓝图 §5.1）：
 * loadConfig → connectDatabase → runMigrations（失败即退出，阻止启动）
 * → 依赖装配 → listen。运行时不读取/修改 .env 之外的配置来源。
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const db = await createDatabase(config);

  try {
    await runMigrations(
      db,
      join(config.migrationsRoot, dialectDirName(config.dialect)),
    );
  } catch (err) {
    await db.close().catch(() => undefined);
    console.error(
      '[mscts] migration failed, refusing to start:',
      err instanceof Error ? err.message : err,
    );
    process.exitCode = 1;
    return;
  }

  const storage = createStoragePort(config);
  const rsaKeyPair = loadOrCreateKeyPair(config.rsaPrivateKeyPath);
  const tokenRepository = new TokenRepository(db);
  const tokenService = new TokenService(tokenRepository);
  const userRepository = new UserRepository(db);
  const profileRepository = new ProfileRepository(db);
  const minecraftSessions = new MinecraftSessionRepository(db);
  const identity = new IdentityService({
    db,
    users: userRepository,
    profiles: profileRepository,
    tokens: tokenService,
    sessions: minecraftSessions,
  });
  const textureBuilder = new TextureProfileBuilder(rsaKeyPair.privateKeyPem);
  const assetUrlResolver = new AssetUrlResolver(storage);

  const app = createApp({
    config,
    database: db,
    storage,
    tokenService,
    rsaKeyPair,
    identity,
    profileRepository,
    minecraftSessions,
    textureBuilder,
    assetUrlResolver,
  });
  const port = Number(process.env['PORT'] ?? 3000);
  const server = app.listen(port, () => {
    console.log(`[mscts] listening on http://localhost:${port}`);
  });

  const shutdown = (): void => {
    server.closeAllConnections();
    server.close(() => {
      void db.close().then(() => process.exit(0));
    });
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void main().catch((err: unknown) => {
  console.error('[mscts] fatal:', err);
  process.exitCode = 1;
});
