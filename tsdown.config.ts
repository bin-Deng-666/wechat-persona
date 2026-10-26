import type { UserConfig } from 'tsdown'

/**
 * Host 半边构建。浏览器半边是手写 JS，由 scripts/copy-client.mjs 原样拷贝。
 *
 * 所有 @deepseek-ai/* 保持运行时 require：profile 宿主只有一个 cordis 实例，
 * 打包一份副本会分裂服务身份（症状是每条消息都失败）。
 */
const config: UserConfig = {
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: true,
  sourcemap: false,
  clean: true,
  outputOptions: {
    banner: [
      '/*!',
      ' * wechat-persona - MIT License, Copyright (c) 2026 wechat-persona contributors',
      ' *',
      ' * iLink protocol implemented from the public specification of',
      ' * @tencent-weixin/openclaw-weixin (MIT, Copyright (C) 2026 Tencent).',
      ' * Implementation notes from dsh-channel-wechat (MIT, Copyright (c) wang.x).',
      ' * See NOTICE.md for the full notices.',
      ' */',
    ].join('\n'),
  },
  deps: {
    neverBundle: (specifier: string) => specifier.startsWith('@deepseek-ai/'),
  },
}

export default [config]
