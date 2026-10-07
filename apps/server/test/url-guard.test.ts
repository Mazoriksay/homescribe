import { describe, expect, it } from 'vitest';
import { assertPublicUrl, isInternalAddress, UrlNotAllowedError } from '../src/media/url-guard';

const lookup = (table: Record<string, string[]>) => async (host: string) => {
  const addresses = table[host];
  if (!addresses) throw new Error('ENOTFOUND');
  return addresses.map((address) => ({ address }));
};

describe('isInternalAddress', () => {
  it('flags loopback, private, link-local, CGNAT and mapped addresses', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.20.0.1',
      '192.168.1.5',
      '169.254.169.254',
      '100.101.102.103',
      '198.18.0.1',
      '198.19.255.254',
      '0.0.0.0',
      '::1',
      'fd00::1',
      'fe80::1',
      '::ffff:192.168.1.5',
      'not-an-ip',
    ]) {
      expect(isInternalAddress(ip), ip).toBe(true);
    }
  });

  it('lets public addresses through', () => {
    for (const ip of ['8.8.8.8', '142.250.74.46', '2001:4860:4860::8888', '::ffff:8.8.8.8']) {
      expect(isInternalAddress(ip), ip).toBe(false);
    }
  });
});

describe('assertPublicUrl', () => {
  const dns = lookup({
    'www.youtube.com': ['142.250.74.46', '2a00:1450:4001::200e'],
    'nas.lan': ['192.168.1.5'],
    'sneaky.example.com': ['93.184.215.14', '127.0.0.1'],
  });

  it('accepts public hosts', async () => {
    await expect(
      assertPublicUrl('https://www.youtube.com/watch?v=x', dns),
    ).resolves.toBeUndefined();
    await expect(assertPublicUrl('http://8.8.8.8/a.mp3', dns)).resolves.toBeUndefined();
  });

  it('rejects internal hosts, internal IP literals and any internal DNS answer', async () => {
    for (const url of [
      'http://localhost:8080/api',
      'http://app.localhost/',
      'http://127.0.0.1/',
      'http://[::1]/',
      'http://nas.lan/video.mp4',
      'http://sneaky.example.com/',
      'http://unknown.invalid/',
      'ftp://www.youtube.com/',
    ]) {
      await expect(assertPublicUrl(url, dns), url).rejects.toBeInstanceOf(UrlNotAllowedError);
    }
  });
});
