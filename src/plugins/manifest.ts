import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PLUGIN_API_VERSION, PLUGIN_ID_PATTERN, type PluginManifest } from './api.js';

/**
 * manifest 读取与校验。
 *
 * 校验放在加载之前、且**只加不减**，因为它有一个实际用途：面板要在超管按下启用之前，
 * 把「这个插件会暴露哪些 HTTP 入口、依赖什么外部东西、要哪些设置」摊开给他看。
 * 声明与实现不一致时（注册了没声明的路径）加载器会拒绝，见 loader.ts。
 */

export const MANIFEST_FILE = 'mcsts.plugin.json';

export interface ManifestIssue {
  field: string;
  message: string;
}

export type ManifestResult =
  | { ok: true; manifest: PluginManifest }
  | { ok: false; issues: ManifestIssue[] };

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const AUTHS = new Set(['public', 'user', 'admin', 'super', 'hmac']);
const KINDS = new Set(['router', 'hooks']);
const SETTING_TYPES = new Set(['string', 'int', 'bool', 'secret']);
const BINDING_SUBJECTS = new Set(['account', 'profile']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 路径必须是 / 开头、不含查询串、不含通配（通配会让声明失去可枚举性） */
function checkPath(value: string): boolean {
  return (
    typeof value === 'string' &&
    value.startsWith('/') &&
    !value.includes('?') &&
    !value.includes('*') &&
    !value.includes('..')
  );
}

export async function readManifest(dir: string): Promise<ManifestResult> {
  const issues: ManifestIssue[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(dir, MANIFEST_FILE), 'utf8'));
  } catch (err) {
    return {
      ok: false,
      issues: [
        {
          field: MANIFEST_FILE,
          message: `读取或解析失败：${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  }
  return validateManifest(raw, issues);
}

export function validateManifest(raw: unknown, issues: ManifestIssue[]): ManifestResult {
  const fail = (field: string, message: string): void => {
    issues.push({ field, message });
  };

  if (!isRecord(raw)) {
    return { ok: false, issues: [{ field: 'manifest', message: '必须是 JSON 对象' }] };
  }

  const id = raw['id'];
  if (typeof id !== 'string' || !PLUGIN_ID_PATTERN.test(id)) {
    fail('id', `必填，且必须匹配 ${PLUGIN_ID_PATTERN.source}（小写字母开头，允许数字与下划线，长度 2-32）`);
  }

  for (const field of ['name', 'version', 'main'] as const) {
    const value = raw[field];
    if (typeof value !== 'string' || value.trim() === '') {
      fail(field, '必填且为非空字符串');
    }
  }

  const main = raw['main'];
  if (typeof main === 'string' && (main.includes('..') || main.startsWith('/'))) {
    fail('main', '入口路径不得越出插件目录');
  }

  const apiVersion = raw['apiVersion'];
  if (typeof apiVersion !== 'number' || !Number.isInteger(apiVersion)) {
    fail('apiVersion', '必填且为整数');
  } else if (apiVersion !== PLUGIN_API_VERSION) {
    fail(
      'apiVersion',
      `插件要求 API v${apiVersion}，本站是 v${PLUGIN_API_VERSION}；不匹配一律拒载`,
    );
  }

  const requires = raw['requires'];
  if (requires !== undefined) {
    if (!Array.isArray(requires)) {
      fail('requires', '必须是数组');
    } else {
      requires.forEach((item, i) => {
        if (!isRecord(item) || typeof item['id'] !== 'string' || typeof item['label'] !== 'string') {
          fail(`requires[${i}]`, '每项需要 id 与 label');
        }
      });
    }
  }

  const settings = raw['settings'];
  if (settings !== undefined) {
    if (!Array.isArray(settings)) {
      fail('settings', '必须是数组');
    } else {
      settings.forEach((item, i) => {
        if (!isRecord(item)) {
          fail(`settings[${i}]`, '每项必须是对象');
          return;
        }
        if (typeof item['key'] !== 'string' || !/^[A-Z0-9_]{1,48}$/.test(item['key'])) {
          fail(`settings[${i}].key`, '需要全大写 SCREAMING_SNAKE_CASE（与站点设置同一拼写约定，写读才对得上）');
        }
        if (typeof item['type'] !== 'string' || !SETTING_TYPES.has(item['type'])) {
          fail(`settings[${i}].type`, `必须是 ${[...SETTING_TYPES].join(' / ')}`);
        }
        if (typeof item['label'] !== 'string') {
          fail(`settings[${i}].label`, '必填（面板要显示）');
        }
      });
    }
  }

  const endpoints = raw['endpoints'];
  const seen = new Set<string>();
  if (endpoints !== undefined) {
    if (!Array.isArray(endpoints)) {
      fail('endpoints', '必须是数组');
    } else {
      endpoints.forEach((item, i) => {
        if (!isRecord(item)) {
          fail(`endpoints[${i}]`, '每项必须是对象');
          return;
        }
        const { kind, method, path, auth } = item as Record<string, unknown>;
        if (typeof kind !== 'string' || !KINDS.has(kind)) {
          fail(`endpoints[${i}].kind`, "必须是 'router' 或 'hooks'");
        }
        if (typeof method !== 'string' || !METHODS.has(method)) {
          fail(`endpoints[${i}].method`, `必须是 ${[...METHODS].join(' / ')}`);
        }
        if (typeof path !== 'string' || !checkPath(path)) {
          fail(`endpoints[${i}].path`, '必须以 / 开头，且不含 ? / * / ..');
        }
        if (typeof auth !== 'string' || !AUTHS.has(auth)) {
          fail(`endpoints[${i}].auth`, `必须是 ${[...AUTHS].join(' / ')}`);
        }
        if (typeof kind === 'string' && typeof method === 'string' && typeof path === 'string') {
          const key = `${kind} ${method} ${path}`;
          if (seen.has(key)) fail(`endpoints[${i}]`, `${key} 重复声明`);
          seen.add(key);
        }
      });
    }
  }

  const binding = raw['binding'];
  if (binding !== undefined) {
    if (!isRecord(binding)) {
      fail('binding', '必须是对象（形如 { "subject": "profile" }）');
    } else if (typeof binding['subject'] !== 'string' || !BINDING_SUBJECTS.has(binding['subject'])) {
      fail('binding.subject', `必须是 ${[...BINDING_SUBJECTS].join(' / ')}`);
    }
  }

  if (issues.length > 0) return { ok: false, issues };

  const m = raw as unknown as PluginManifest;
  return {
    ok: true,
    manifest: {
      id: m.id,
      name: m.name,
      version: m.version,
      apiVersion: m.apiVersion,
      main: m.main,
      mcsts: typeof m.mcsts === 'string' ? m.mcsts : undefined,
      description: typeof m.description === 'string' ? m.description : undefined,
      author: typeof m.author === 'string' ? m.author : undefined,
      requires: m.requires,
      settings: m.settings,
      endpoints: m.endpoints,
      binding: m.binding,
    },
  };
}

/** manifest 指纹：面板用它提醒「代码换了但没重新确认」 */
export function manifestFingerprint(manifest: PluginManifest): string {
  return JSON.stringify({
    id: manifest.id,
    version: manifest.version,
    apiVersion: manifest.apiVersion,
    endpoints: manifest.endpoints ?? [],
    settings: manifest.settings ?? [],
    requires: manifest.requires ?? [],
    binding: manifest.binding ?? null,
  });
}
