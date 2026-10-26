/** 全角数字/字母 → 半角。中文输入法下「１」「２」很常见。 */
export function normalizeDigits(text: string): string {
  return text.replace(/[０-９]/gu, char => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
}
