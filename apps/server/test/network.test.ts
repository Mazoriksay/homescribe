import { describe, expect, it } from 'vitest';
import { createNetworkAllowList, isValidCidr } from '../src/network';

describe('network allow-list', () => {
  const allow = createNetworkAllowList(['127.0.0.0/8', '192.168.0.0/16', '::1/128', 'fc00::/7']);

  it('allows addresses inside the listed networks', () => {
    expect(allow('127.0.0.1')).toBe(true);
    expect(allow('192.168.1.20')).toBe(true);
    expect(allow('::1')).toBe(true);
    expect(allow('fd12:3456::1')).toBe(true);
  });

  it('normalises IPv4-mapped IPv6 addresses', () => {
    expect(allow('::ffff:192.168.1.20')).toBe(true);
    expect(allow('::ffff:8.8.8.8')).toBe(false);
  });

  it('rejects everything else, including garbage', () => {
    expect(allow('8.8.8.8')).toBe(false);
    expect(allow('2001:db8::1')).toBe(false);
    expect(allow(undefined)).toBe(false);
    expect(allow('')).toBe(false);
    expect(allow('not-an-ip')).toBe(false);
  });

  it('validates CIDR notation', () => {
    expect(isValidCidr('10.0.0.0/8')).toBe(true);
    expect(isValidCidr('fe80::/10')).toBe(true);
    expect(isValidCidr('10.0.0.0')).toBe(false);
    expect(isValidCidr('10.0.0.0/33')).toBe(false);
    expect(isValidCidr('::/129')).toBe(false);
    expect(isValidCidr('abc/8')).toBe(false);
  });
});
