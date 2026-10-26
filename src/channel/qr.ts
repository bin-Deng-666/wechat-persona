/**
 * 把登录 URL 渲染成二维码 SVG。
 *
 * iLink 的 `qrcode_img_content` 是一段用 JS 画码的 HTML 页面，不是图片，
 * 所以 `<img src>` 什么也不显示——必须在这里把 URL 编成码。
 *
 * @module wechat-persona/channel/qr
 */

import qrcode from 'qrcode-generator'

/** 每个模块多少像素。 */
const CELL_SIZE = 4

/** 静默区（模块数）。标准要求 4：扫描器靠四周的空白找边界。 */
const QUIET_ZONE_MODULES = 4

/**
 * 渲染一张二维码。
 * @param url - 要编码的值（服务端给的登录 URL）。
 * @returns 自包含的 SVG 文档。
 */
export function renderQrSvg(url: string): string {
  const code = qrcode(0, 'M')
  code.addData(url)
  code.make()
  return code.createSvgTag({
    cellSize: CELL_SIZE,
    margin: QUIET_ZONE_MODULES * CELL_SIZE,
    scalable: true,
  })
}
