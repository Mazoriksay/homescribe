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
      mode: 'local',
      baseUrl: 'http://localhost:8000',
      model: 'Systran/faster-whisper-large-v3',
      language: null,
      apiKey: null,
      timeoutMs: 3_600_000,
      vadFilter: true,
    });
    expect(config.webDistDir).toBe(path.join(root, 'apps/web/dist'));
    expect(config.frameAncestors).toEqual([]);
    expect(config.llm).toEqual({
      mode: 'local',
      baseUrl: 'http://localhost:11434',
      model: 'llama3.1:8b',
      apiKey: null,
      timeoutMs: 600_000,
      chunkChars: 12_000,
    });
    expect(config.discoveryHosts).toEqual(['localhost', 'host.docker.internal']);
    expect(config.basePath).toBe('');
    expect(config.ytdlp).toEqual({
      path: 'yt-dlp',
      autoUpdate: true,
      cookiesFile: '/srv/app/data/cookies.txt',
      timeoutMs: 7_200_000,
      allowPrivate: false,
    });
  });

  it('reads yt-dlp settings and boolean flags', () => {
    const config = loadConfig(
      { YTDLP_AUTO_UPDATE: 'false', URL_IMPORT_ALLOW_PRIVATE: 'true', YTDLP_PATH: '/opt/yt-dlp' },
      root,
    );
    expect(config.ytdlp).toMatchObject({
      path: '/opt/yt-dlp',
      autoUpdate: false,
      allowPrivate: true,
    });
    expect(() => loadConfig({ YTDLP_AUTO_UPDATE: 'maybe' }, root)).toThrow(/YTDLP_AUTO_UPDATE/);
    expect(loadConfig({ YTDLP_COOKIES_FILE: 'secrets/yt.txt' }, root).ytdlp.cookiesFile).toBe(
      '/srv/app/secrets/yt.txt',
    );
  });

  it('normalises BASE_PATH and rejects odd values', () => {
    expect(loadConfig({ BASE_PATH: '/homescribe/' }, root).basePath).toBe('/homescribe');
    expect(loadConfig({ BASE_PATH: '/apps/notes' }, root).basePath).toBe('/apps/notes');
    expect(loadConfig({ BASE_PATH: '/' }, root).basePath).toBe('');
    for (const bad of ['homescribe', '/a b', '/x?y=1', '/<script>', '//double']) {
      expect(() => loadConfig({ BASE_PATH: bad }, root), bad).toThrow(/BASE_PATH/);
    }
  });

  it('reads LLM and discovery settings', () => {
    const config = loadConfig(
      {
        LLM_MODE: 'off',
        LLM_BASE_URL: 'http://gpu-box:1234/',
        AI_DISCOVERY_HOSTS: 'localhost, gpu-box, 192.168.1.20, [fd00::5]',
      },
      root,
    );
    expect(config.llm.mode).toBe('off');
    expect(config.llm.baseUrl).toBe('http://gpu-box:1234');
    expect(config.discoveryHosts).toEqual(['localhost', 'gpu-box', '192.168.1.20', '[fd00::5]']);
    expect(() => loadConfig({ AI_DISCOVERY_HOSTS: 'http://gpu-box:1234' }, root)).toThrow(
      /AI_DISCOVERY_HOSTS/,
    );
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
