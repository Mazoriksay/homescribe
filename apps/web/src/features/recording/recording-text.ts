/** "Russian" for `ru` in the UI language; the code itself when unknown. */
export function languageName(code: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** Tool output without memory addresses such as `[wav @ 0x64cdfd927340]`. */
export function cleanToolOutput(message: string): string {
  return message.replace(/ @ 0x[0-9a-f]+\]/gi, ']').trim();
}
