/**
 * 终端登录：在命令行里扫码，把凭据写进插件的数据目录。
 *
 * 为什么需要它：桌面版的 GUI 跑在 Electron 里，`/api` 面板要 cookie，普通浏览器拿不到；
 * 而插件路由只能注册在 `/api` 下（宿主不会把别的路径转给插件）。
 * 于是登录这一步改成「不经过 HTTP」——终端打印二维码，扫完写文件，插件监听文件变化自动开跑。
 *
 *   npm run login
 *   node --experimental-strip-types scripts/login.ts --data-dir ~/.dsh/wechat-persona
 *
 * @module wechat-persona/scripts/login
 */

import { createInterface } from 'node:readline/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { writeFile } from 'node:fs/promises'
import qrcode from 'qrcode-generator'

import { createApiClient } from '../src/ilink/api.ts'
import { fetchQr, pollStatus } from '../src/ilink/login.ts'
import { advance, initialState, withInitialQr, withRefreshedQr, withVerifyCode, type LoginEffect, type LoginState } from '../src/ilink/login-machine.ts'
import { saveAccount } from '../src/auth/credentials.ts'
import { matrixToPng } from '../src/auth/png.ts'

/** 把二维码同时写成 PNG（方便聊天窗口里扫）。 */
async function writeQrPng(url: string, path: string): Promise<void> {
  const code = qrcode(0, 'M')
  code.addData(url)
  code.make()
  const count = code.getModuleCount()
  const matrix = Array.from({ length: count }, (_, row) =>
    Array.from({ length: count }, (_, col) => code.isDark(row, col)))
  await writeFile(path, matrixToPng(matrix, { scale: 8, margin: 4 }))
}

/** `--png <path>` 参数。 */
function pngPathOf(argv: readonly string[]): string | undefined {
  const index = argv.indexOf('--png')
  const value = index >= 0 ? argv[index + 1] : undefined
  return value !== undefined && value !== '' ? value : undefined
}

/** `--code-file <path>`：从文件读验证码（非交互环境用）。 */
function codeFileOf(argv: readonly string[]): string | undefined {
  const index = argv.indexOf('--code-file')
  const value = index >= 0 ? argv[index + 1] : undefined
  return value !== undefined && value !== '' ? value : undefined
}

/** 参数里的数据目录；默认与插件一致。 */
function dataDirOf(argv: readonly string[]): string {
  const index = argv.indexOf('--data-dir')
  const value = index >= 0 ? argv[index + 1] : undefined
  return value !== undefined && value !== '' ? value : join(homedir(), '.dsh', 'wechat-persona')
}

/** 终端里能扫的二维码。 */
function asciiQr(url: string): string {
  const code = qrcode(0, 'M')
  code.addData(url)
  code.make()
  // cellSize=1 时每个模块一个字符宽，配合半高块字符才接近正方形。
  return code.createASCII(1, 4)
}

async function printQr(url: string, pngPath?: string): Promise<void> {
  console.log('\n用手机微信扫描下面的二维码（或把链接发到手机打开）：\n')
  console.log(asciiQr(url))
  console.log(url)
  if (pngPath !== undefined) {
    await writeQrPng(url, pngPath)
    console.log(`二维码图片：${pngPath}`)
  }
  console.log('')
}

const sleep = async (ms: number): Promise<void> => { await new Promise(resolve => setTimeout(resolve, ms)) }

/**
 * 跑完一次登录。
 * @param dataDir - 凭据写到哪里。
 */
async function main(dataDir: string, pngPath?: string, codeFile?: string): Promise<number> {
  const api = createApiClient({ channelVersion: '0.1.0', botAgent: 'wechat-persona' })
  const rl = createInterface({ input: process.stdin, output: process.stdout })

  try {
    const qr = await fetchQr(api)
    let state: LoginState = withInitialQr(initialState(), { qrcode: qr.qrcode, qrcodeUrl: qr.qrcodeUrl })
    await printQr(qr.qrcodeUrl, pngPath)

    for (;;) {
      const response = await pollStatus(api, state)
      const transition = advance(state, response)
      state = transition.state

      const effect: LoginEffect = transition.effect
      if (effect.kind === 'poll') {
        await sleep(1_500)
        continue
      }
      if (effect.kind === 'announce-scanned') {
        console.log('已扫码，请在手机上确认登录')
        await sleep(1_000)
        continue
      }
      if (effect.kind === 'request-verify-code') {
        let code = ''
        if (codeFile === undefined) {
          code = (await rl.question(effect.retry ? '验证码不对，重新输入：' : '输入手机微信上显示的数字：')).trim()
        } else {
          // 非交互环境：等外部把验证码写进文件。
          console.log(`需要验证码：把手机微信显示的数字写入 ${codeFile}，我会自动读取。`)
          const { readFile } = await import('node:fs/promises')
          for (let waited = 0; waited < 300; waited += 1) {
            try {
              const text = (await readFile(codeFile, 'utf8')).trim()
              if (/^\d{4,8}$/u.test(text)) { code = text; break }
            } catch {
              // 文件还没写，继续等。
            }
            await sleep(1_000)
          }
          if (code === '') {
            console.error('等待验证码超时（5 分钟），请重新运行登录。')
            return 1
          }
        }
        state = withVerifyCode(state, code)
        continue
      }
      if (effect.kind === 'refresh-qr') {
        const next = await fetchQr(api)
        state = withRefreshedQr(state, { qrcode: next.qrcode, qrcodeUrl: next.qrcodeUrl })
        console.log('二维码已刷新')
        await printQr(next.qrcodeUrl, pngPath)
        continue
      }
      if (effect.kind === 'already-connected') {
        console.log('这个微信号已经绑定到另一个实例，无需重复登录。')
        return 1
      }
      if (effect.kind === 'failed') {
        console.error('登录失败：', effect.message)
        return 1
      }

      // connected
      await saveAccount(dataDir, {
        accountId: effect.credentials.accountId,
        baseUrl: effect.credentials.baseUrl,
        botToken: effect.credentials.botToken,
        ...(effect.credentials.userId === undefined ? {} : { userId: effect.credentials.userId }),
      })
      console.log(`\n登录成功：bot ${effect.credentials.accountId}`)
      console.log(`凭据已写入 ${join(dataDir, 'account.json')}`)
      console.log('正在运行的 DSH 会在几秒内自动开始收消息；没反应就重启一次 DSH。')
      return 0
    }
  } finally {
    rl.close()
  }
}

const argv = process.argv.slice(2)
// 交互式脚本：没有 TTY（例如挂在后台被 harness 拉起）时读验证码会挂住。
if (process.stdin.isTTY !== true) console.log('提示：当前不是交互终端，如果需要验证码将无法输入。')
const code = await main(dataDirOf(argv), pngPathOf(argv), codeFileOf(argv))
process.exitCode = code
