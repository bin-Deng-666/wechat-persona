/** 把位置标记换成一条带地图链接的文本。 */
const LOCATION = /\[位置[:：]\s*(-?\d{1,3}(?:\.\d+)?)\s*[,，]\s*(-?\d{1,3}(?:\.\d+)?)\s*(?:[,，]\s*([^\]\n]{1,40}))?\]/gu

/**
 * 协议里没有位置消息项，所以用名字和地图链接表达定位。
 */
export function expandLocationTokens(text: string): string {
  return text.replace(LOCATION, (_whole, lat: string, lng: string, name?: string) => {
    const label = name?.trim() ?? ''
    const query = label === '' ? `${lat},${lng}` : `${label} ${lat},${lng}`
    const url = `https://maps.apple.com/?ll=${encodeURIComponent(lat)},${encodeURIComponent(lng)}&q=${encodeURIComponent(query)}`
    return `${label === '' ? '位置' : `📍 ${label}`}\n${url}`
  })
}
