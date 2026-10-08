import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { crc32 } from 'node:zlib';

/** Chrome wants 1–4 dot-separated numbers; anything else (a branch build) gets 0.0.0. */
export function manifestVersion(version: string): string {
  const plain = version.replace(/^v/, '');
  return /^\d+(\.\d+){0,3}$/.test(plain) ? plain : '0.0.0';
}

/**
 * An MS-DOS date and time (APPNOTE 4.4.6). Zero is not a valid date, and
 * Windows Explorer refuses to unpack entries that carry it.
 */
export function dosDateTime(at: Date): { time: number; date: number } {
  return {
    time: (at.getHours() << 11) | (at.getMinutes() << 5) | Math.floor(at.getSeconds() / 2),
    date: ((at.getFullYear() - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate(),
  };
}

export type ExtensionBrowser = 'chromium' | 'firefox';

/**
 * The manifest for one browser family. The source carries both background
 * forms; Chrome lists `background.scripts` and the gecko settings as errors,
 * Firefox has no service workers and no use for the Chrome `key`.
 */
export function browserManifest(
  manifest: Record<string, unknown>,
  version: string,
  browser: ExtensionBrowser,
): Record<string, unknown> {
  const {
    background,
    key,
    browser_specific_settings: gecko,
    ...rest
  } = manifest as {
    background: { service_worker: string; scripts: string[] };
    key: string;
    browser_specific_settings: unknown;
  } & Record<string, unknown>;
  return browser === 'firefox'
    ? {
        ...rest,
        version: manifestVersion(version),
        background: { scripts: background.scripts },
        browser_specific_settings: gecko,
      }
    : {
        ...rest,
        version: manifestVersion(version),
        key,
        background: { service_worker: background.service_worker },
      };
}

async function listFiles(dir: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(path.join(dir, prefix), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await listFiles(dir, relative)));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

/**
 * The extension folder as a zip for one browser family (stored, not compressed: it is a few
 * kilobytes), with the server's version in manifest.json. Minimal ZIP
 * (PKWARE APPNOTE 4.3.7, 4.3.12, 4.3.16), UTF-8 names, no extra fields.
 */
export async function extensionZip(
  dir: string,
  version: string,
  browser: ExtensionBrowser = 'chromium',
  at = new Date(),
): Promise<Buffer> {
  const { time, date } = dosDateTime(at);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const name of await listFiles(dir)) {
    let data = await readFile(path.join(dir, name));
    if (name === 'manifest.json') {
      const manifest = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
      data = Buffer.from(
        `${JSON.stringify(browserManifest(manifest, version, browser), null, 2)}\n`,
      );
    }
    const fileName = Buffer.from(name, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(fileName.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, fileName, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // made by
    central.writeUInt16LE(20, 6); // needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(fileName.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, fileName);

    offset += local.length + fileName.length + data.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(centrals.length / 2, 8);
  end.writeUInt16LE(centrals.length / 2, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}
