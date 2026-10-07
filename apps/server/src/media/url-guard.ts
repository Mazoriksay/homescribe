import { lookup } from 'node:dns/promises';
import net from 'node:net';

/** Addresses a link import must not reach by default (SPEC.md §7.7). */
const INTERNAL = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT, also used by Tailscale
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  INTERNAL.addSubnet(address, prefix, 'ipv4');
}
for (const [address, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  INTERNAL.addSubnet(address, prefix, 'ipv6');
}

export function isInternalAddress(address: string): boolean {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address)?.[1];
  const ip = mapped ?? address;
  const family = net.isIP(ip);
  if (family === 0) return true;
  return INTERNAL.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

export class UrlNotAllowedError extends Error {}

export type Lookup = (host: string) => Promise<{ address: string }[]>;

const defaultLookup: Lookup = (host) => lookup(host, { all: true, verbatim: true });

/**
 * Rejects links whose host is, or resolves to, an internal address. Best
 * effort: yt-dlp may follow redirects later, and DNS can change in between.
 */
export async function assertPublicUrl(raw: string, resolve: Lookup = defaultLookup): Promise<void> {
  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UrlNotAllowedError('Only http and https links are supported');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new UrlNotAllowedError('Links to this server or the local network are not allowed');
  }
  let addresses: string[];
  if (net.isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = (await resolve(host)).map((entry) => entry.address);
    } catch {
      throw new UrlNotAllowedError(`Cannot resolve ${host}`);
    }
  }
  if (addresses.length === 0 || addresses.some(isInternalAddress)) {
    throw new UrlNotAllowedError('Links to this server or the local network are not allowed');
  }
}
