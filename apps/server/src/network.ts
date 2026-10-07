import net from 'node:net';

/** Returns true for `a.b.c.d/n` or `ipv6/n` with a prefix length valid for the family. */
export function isValidCidr(cidr: string): boolean {
  const [address, prefix, ...rest] = cidr.split('/');
  if (address === undefined || prefix === undefined || rest.length > 0) return false;
  if (!/^\d{1,3}$/.test(prefix)) return false;
  const family = net.isIP(address);
  if (family === 0) return false;
  return Number(prefix) <= (family === 4 ? 32 : 128);
}

const IPV4_MAPPED = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

/**
 * Builds a predicate that tells whether a client socket address belongs to one
 * of the given CIDR networks. Only the socket address is ever checked; proxy
 * headers such as X-Forwarded-For are not trusted (SPEC.md §10).
 */
export function createNetworkAllowList(cidrs: readonly string[]) {
  const list = new net.BlockList();
  for (const cidr of cidrs) {
    if (!isValidCidr(cidr)) throw new Error(`Invalid CIDR: ${cidr}`);
    const [address, prefix] = cidr.split('/') as [string, string];
    list.addSubnet(address, Number(prefix), net.isIPv4(address) ? 'ipv4' : 'ipv6');
  }

  return (address: string | undefined): boolean => {
    if (!address) return false;
    const normalised = address.replace(IPV4_MAPPED, '$1');
    const family = net.isIP(normalised);
    if (family === 0) return false;
    return list.check(normalised, family === 4 ? 'ipv4' : 'ipv6');
  };
}
