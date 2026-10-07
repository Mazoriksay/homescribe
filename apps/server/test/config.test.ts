import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config';

const root = '/srv/app';

describe('loadConfig', () => {
  it('uses documented defaults for an empty environment', () => {
    const config = loadConfig({}, root);
    expect(config.host).toBe('0.0.0.0');
    expect(config.port).toBe(8080);
    expect(config.dataDir).toBe(path.join(root, 'data'));
    expect(config.maxUploadBytes).toBe(2048 * 1024 * 1024);
    expect(config.allowedNetworks).toContain('192.168.0.0/16');
    expect(config.stt).toEqual({
      baseUrl: 'http://localhost:8000',
      model: 'Systran/faster-whisper-large-v3',
      language: null,
      apiKey: null,
      timeoutMs: 3_600_000,
    });
    expect(config.webDistDir).toBe(path.join(root, 'apps/web/dist'));
    expect(config.frameAncestors).toEqual([]);
  });

  it('reads the origins allowed to embed the UI', () => {
    const config = loadConfig(
      { FRAME_ANCESTORS: 'http://hub.lan:3000  https://home.example' },
      root,
    );
    expect(config.frameAncestors).toEqual(['http://hub.lan:3000', 'https://home.example']);
  });

  it('rejects anything in FRAME_ANCESTORS that is not a bare origin', () => {
    for (const value of [
      '*',
      'hub.lan',
      'http://hub.lan/path',
      "http://hub.lan; script-src 'unsafe-inline'",
      'javascript:alert(1)',
    ]) {
      expect(() => loadConfig({ FRAME_ANCESTORS: value }, root), value).toThrow(/FRAME_ANCESTORS/);
    }
  });

  it('reads values from the environment and treats empty strings as unset', () => {
    const config = loadConfig(
      {
        PORT: '9000',
        DATA_DIR: '/var/lib/homescribe',
        ALLOWED_NETWORKS: ' 10.1.0.0/16 , ::1/128 ',
        STT_BASE_URL: 'http://gpu-box:8000/',
        STT_LANGUAGE: 'ru',
        STT_API_KEY: '',
        MAX_UPLOAD_MB: '10',
      },
      root,
    );
    expect(config.port).toBe(9000);
    expect(config.dataDir).toBe('/var/lib/homescribe');
    expect(config.allowedNetworks).toEqual(['10.1.0.0/16', '::1/128']);
    expect(config.stt.baseUrl).toBe('http://gpu-box:8000');
    expect(config.stt.language).toBe('ru');
    expect(config.stt.apiKey).toBeNull();
    expect(config.maxUploadBytes).toBe(10 * 1024 * 1024);
  });

  it('names the variable when a value is invalid', () => {
    expect(() => loadConfig({ PORT: 'eighty' }, root)).toThrow(ConfigError);
    expect(() => loadConfig({ PORT: 'eighty' }, root)).toThrow(/PORT/);
    expect(() => loadConfig({ STT_BASE_URL: 'not a url' }, root)).toThrow(/STT_BASE_URL/);
    expect(() => loadConfig({ ALLOWED_NETWORKS: '10.0.0.0/33' }, root)).toThrow(/ALLOWED_NETWORKS/);
  });
});
