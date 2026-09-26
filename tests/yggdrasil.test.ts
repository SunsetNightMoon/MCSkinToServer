import assert from 'node:assert/strict';
import { createVerify } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { ProfileRepository } from '../src/repositories/profileRepository.js';
import { SqliteConnection } from '../src/db/sqlite.js';
import { runMigrations } from '../src/migrate/runner.js';
import {
  AssetUrlResolver,
  LocalDiskStorage,
  blobStorageKey,
} from '../src/storage/index.js';
import { TextureProfileBuilder } from '../src/yggdrasil/textures.js';
import { buildForProfile } from '../src/yggdrasil/buildForProfile.js';
import { buildMetadataDto } from '../src/yggdrasil/metadata.js';
import { buildAuthlibInjectorMeta } from '../src/yggdrasil/authlibInjectorMeta.js';
import { loadOrCreateKeyPair, publicKeyDerBase64, publicKeyPemOneLine } from '../src/yggdrasil/keys.js';
import {
  toCanonicalUuid,
  toShortUuid,
} from '../src/yggdrasil/uuid.js';
import { forbiddenOperation, illegalArgument } from '../src/yggdrasil/errors.js';
import { sha256Hex } from '../src/util/crypto.js';

/**
 * 任务 7：Yggdrasil 兼容测试套件（不依赖前端/HTTP）。
 * 锁定：UUID 边界格式、RSA 密钥管理、textures property 的
 * JSON 序列化 + Base64 + RSA-SHA1 固定测试向量、unsigned 语义、
 * 模型 metadata 语义、rejected 素材排除规则、metadata DTO。
 */

const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'schema');
const VECTOR = JSON.parse(
  await readFile(join(SCHEMA_DIR, '..', 'tests', 'fixtures', 'yggdrasil-vector.json'), 'utf8'),
) as {
  privateKeyPem: string;
  publicKeyPem: string;
  input: {
    profileId: string;
    profileName: string;
    skin: { url: string; modelType: 'default' | 'slim' };
    cape: { url: string };
    unsigned: boolean;
    now: string;
  };
  expectedValue: string;
  expectedSignature: string;
};

// ---------------------------------------------------------------------------
// UUID 边界格式
// ---------------------------------------------------------------------------

test('yggdrasil: UUID 边界格式转换', () => {
  const canonical = '12345678-90ab-cdef-1234-567890abcdef';
  const short = '1234567890abcdef1234567890abcdef';
  assert.equal(toShortUuid(canonical), short);
  assert.equal(toShortUuid(short), short);
  assert.equal(toShortUuid(canonical.toUpperCase()), short);
  assert.equal(toCanonicalUuid(short), canonical);
  assert.equal(toCanonicalUuid(canonical), canonical);
  assert.throws(() => toShortUuid('zz'), (e: unknown) => {
    return e instanceof Error && e.name === 'YggdrasilError';
  });
});

test('yggdrasil: 协议错误映射', () => {
  const bad = illegalArgument('missing credentials');
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.toBody(), {
    error: 'IllegalArgumentException',
    errorMessage: 'missing credentials',
  });
  const forbidden = forbiddenOperation('Invalid token');
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.errorName, 'ForbiddenOperationException');
});

// ---------------------------------------------------------------------------
// RSA 密钥管理
// ---------------------------------------------------------------------------

test('yggdrasil: 密钥生成/加载 roundtrip', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mcsts-keys-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const keyPath = join(dir, 'yggdrasil.pem');

  const first = loadOrCreateKeyPair(keyPath);
  assert.ok(existsSync(keyPath));
  assert.match(first.privateKeyPem, /BEGIN PRIVATE KEY/);
  assert.match(first.publicKeyPem, /BEGIN PUBLIC KEY/);

  const second = loadOrCreateKeyPair(keyPath);
  assert.equal(second.privateKeyPem, first.privateKeyPem);
  assert.equal(second.publicKeyPem, first.publicKeyPem);
});

test('yggdrasil: SPKI PEM → DER base64', () => {
  const der = publicKeyDerBase64(VECTOR.publicKeyPem);
  assert.doesNotMatch(der, /[-\s]/);
  const decoded = Buffer.from(der, 'base64');
  assert.equal(decoded[0], 0x30); // DER SEQUENCE
  assert.ok(decoded.length > 200); // 2048 位 SPKI
});

// ---------------------------------------------------------------------------
// textures property 固定测试向量（签名行为锁定）
// ---------------------------------------------------------------------------

test('yggdrasil: 固定测试向量（序列化 + RSA-SHA1 签名）', () => {
  const builder = new TextureProfileBuilder(VECTOR.privateKeyPem);
  const prop = builder.buildTextureProperty({
    ...VECTOR.input,
    now: new Date(VECTOR.input.now),
  });

  assert.equal(prop.name, 'textures');
  assert.equal(prop.value, VECTOR.expectedValue);
  assert.equal(prop.signature, VECTOR.expectedSignature);

  // payload 结构与字段顺序
  const payload = JSON.parse(
    Buffer.from(prop.value, 'base64').toString('utf8'),
  ) as Record<string, unknown>;
  assert.deepEqual(payload, {
    timestamp: new Date(VECTOR.input.now).getTime().toString(),
    profileId: '1234567890abcdef1234567890abcdef',
    profileName: VECTOR.input.profileName,
    isPublic: true,
    textures: {
      SKIN: {
        url: VECTOR.input.skin.url,
        metadata: { model: 'slim' },
      },
      CAPE: { url: VECTOR.input.cape.url },
    },
  });
  // 字段顺序锁定（authlib 兼容性与向量稳定性依赖）
  assert.deepEqual(Object.keys(payload as object), [
    'timestamp',
    'profileId',
    'profileName',
    'isPublic',
    'textures',
  ]);

  // 用公钥验证签名
  const verified = createVerify('RSA-SHA1')
    .update(prop.value, 'utf8')
    .verify(VECTOR.publicKeyPem, Buffer.from(prop.signature!, 'base64'));
  assert.equal(verified, true);
});

test('yggdrasil: unsigned / 无密钥 / 模型语义', () => {
  const builder = new TextureProfileBuilder(VECTOR.privateKeyPem);

  const unsigned = builder.buildTextureProperty({
    ...VECTOR.input,
    now: new Date(VECTOR.input.now),
    unsigned: true,
  });
  assert.equal(unsigned.value, VECTOR.expectedValue);
  assert.equal(unsigned.signature, undefined);

  const noKey = new TextureProfileBuilder(null).buildTextureProperty({
    profileId: VECTOR.input.profileId,
    profileName: 'X',
    now: new Date(VECTOR.input.now),
  });
  assert.equal(noKey.signature, undefined);
  const payload = JSON.parse(Buffer.from(noKey.value, 'base64').toString('utf8'));
  assert.deepEqual(payload.textures, {});

  // default 模型不输出 metadata
  const def = new TextureProfileBuilder(VECTOR.privateKeyPem).buildTextureProperty({
    profileId: VECTOR.input.profileId,
    profileName: 'X',
    skin: { url: 'http://x/s.png', modelType: 'default' },
    now: new Date(VECTOR.input.now),
  });
  const defPayload = JSON.parse(Buffer.from(def.value, 'base64').toString('utf8'));
  assert.equal(defPayload.textures.SKIN.metadata, undefined);
});

// ---------------------------------------------------------------------------
// metadata DTO
// ---------------------------------------------------------------------------

test('yggdrasil: metadata DTO', () => {
  const meta = buildMetadataDto({
    baseUrl: 'https://skin.example.com',
    publicKeyPem: VECTOR.publicKeyPem,
  });
  assert.equal(meta.signaturePublickey, publicKeyPemOneLine(VECTOR.publicKeyPem));
  assert.deepEqual(meta.skinDomains, ['skin.example.com']);
  assert.equal(meta.meta.implementation.name, 'MCSTS');

  const custom = buildMetadataDto({
    baseUrl: 'https://skin.example.com',
    publicKeyPem: VECTOR.publicKeyPem,
    skinDomains: ['a.example.com', 'b.example.com'],
  });
  assert.deepEqual(custom.skinDomains, ['a.example.com', 'b.example.com']);
});

// ---------------------------------------------------------------------------
// ProfileRepository 纹理状态 + buildForProfile 组合链路（SQLite）
// ---------------------------------------------------------------------------

test('yggdrasil: findTextureState 排除 rejected + buildForProfile 链路', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mcsts-ygg-'));
  const db = new SqliteConnection(join(dir, 't.db'));
  t.after(async () => {
    await db.close().catch(() => undefined);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  await runMigrations(db, join(SCHEMA_DIR, 'sqlite'));

  const now = new Date().toISOString();
  const userId = 'u-1';
  const profileId = '0123456789abcdef0123456789abcdef';
  const canonicalProfileId = toCanonicalUuid(profileId);

  await db.run(
    `INSERT INTO users (id, user_uid, email, password_hash, role, is_active,
       email_verified, ban_permanent, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'user', 1, 0, 0, ?, ?)`,
    [userId, 1, 't@t.local', 'x', now, now],
  );
  await db.run(
    `INSERT INTO profiles (id, user_id, name, name_changed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [canonicalProfileId, userId, 'Arona', now, now, now],
  );

  const skinHash = sha256Hex('skin-1');
  const capeHash = sha256Hex('cape-1');
  const rejectedHash = sha256Hex('cape-rejected');

  const insertBlob = (id: string, hash: string) =>
    db.run(
      `INSERT INTO blobs (id, sha256, storage_key, content_type, byte_size, width, height, created_at)
       VALUES (?, ?, ?, 'image/png', 100, 64, 64, ?)`,
      [id, hash, blobStorageKey(hash), now],
    );
  const insertAsset = (
    id: string,
    kind: 'skin' | 'cape',
    blobId: string,
    model: 'slim' | null,
    status: 'approved' | 'rejected',
  ) =>
    db.run(
      `INSERT INTO assets (id, owner_user_id, kind, blob_id, model_type, name,
         visibility, download_policy, review_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'public', 'public', ?, ?, ?)`,
      [id, userId, kind, blobId, model, `asset-${id}`, status, now, now],
    );

  await insertBlob('blob-skin', skinHash);
  await insertBlob('blob-cape', capeHash);
  await insertBlob('blob-rejected', rejectedHash);
  await insertAsset('asset-skin', 'skin', 'blob-skin', 'slim', 'approved');
  await insertAsset('asset-cape-ok', 'cape', 'blob-cape', null, 'approved');
  await insertAsset('asset-cape-rej', 'cape', 'blob-rejected', null, 'rejected');
  await db.run(
    `INSERT INTO profile_assets (id, profile_id, asset_id, slot, assigned_at)
     VALUES ('pa-1', ?, 'asset-skin', 'skin', ?)`,
    [canonicalProfileId, now],
  );
  await db.run(
    `INSERT INTO profile_assets (id, profile_id, asset_id, slot, assigned_at)
     VALUES ('pa-2', ?, 'asset-cape-ok', 'cape', ?)`,
    [canonicalProfileId, now],
  );

  // 未绑定 rejected 素材时：皮肤 + 披风都在
  const repo = new ProfileRepository(db);
  const state = await repo.findTextureState(canonicalProfileId);
  assert.ok(state);
  assert.equal(state.profileName, 'Arona');
  assert.equal(state.skin?.modelType, 'slim');
  assert.equal(state.skin?.storageKey, blobStorageKey(skinHash));
  assert.equal(state.cape?.storageKey, blobStorageKey(capeHash));

  // 绑定 rejected 披风 → 纹理输出中排除
  await db.run('UPDATE profile_assets SET asset_id = ? WHERE id = ?', [
    'asset-cape-rej',
    'pa-2',
  ]);
  const stateRejected = await repo.findTextureState(canonicalProfileId);
  assert.ok(stateRejected);
  assert.ok(stateRejected.skin);
  assert.equal(stateRejected.cape, null);

  // 不存在的角色
  assert.equal(
    await repo.findTextureState(toCanonicalUuid('f'.repeat(32))),
    null,
  );

  // buildForProfile 组合链路（URL 来自 AssetUrlResolver）
  const storage = new LocalDiskStorage(dir, 'http://localhost:3000/uploads');
  const resolver = new AssetUrlResolver(storage);
  const builder = new TextureProfileBuilder(VECTOR.privateKeyPem);
  const prop = buildForProfile(builder, stateRejected, resolver, {
    now: new Date(VECTOR.input.now),
  });
  const payload = JSON.parse(
    Buffer.from(prop.value, 'base64').toString('utf8'),
  ) as { textures: Record<string, { url: string }> };
  assert.ok(payload.textures.SKIN);
  assert.equal(
    payload.textures.SKIN.url,
    `http://localhost:3000/uploads/${blobStorageKey(skinHash)}`,
  );
  assert.equal(payload.textures.CAPE, undefined);
  assert.ok(prop.signature);
});

test('authlib-injector 元数据：站点根尾斜杠吞掉、serverName 与链接跟随站点根', () => {
  const meta = buildAuthlibInjectorMeta({
    origin: 'https://skin.example.com/',
    serverName: '猫旅之夜',
    openRegistration: false,
  });
  assert.equal(meta.serverName, '猫旅之夜');
  assert.equal(meta.openregistration, false);
  assert.equal(meta.root, 'https://skin.example.com/api/yggdrasil');
  // HashRouter：路由页链接必须挂在 # 之后，直连路径会被静态托管 404
  assert.equal(meta.links.register, 'https://skin.example.com/#/register');
  assert.equal(meta.links.password, 'https://skin.example.com/#/forgot-password');
  assert.equal(meta.links.homepage, 'https://skin.example.com/');
});
