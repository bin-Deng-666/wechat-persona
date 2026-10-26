import type { UserConfig } from 'tsdown'

/**
 * 构建插件的公开入口；面板 HTML 由 panel/page.ts 在服务端直接渲染。
 *
 * 所有 @deepseek-ai/* 保持为宿主提供的外部依赖：profile 只有一个 cordis 实例，
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
      ' * Personal-memory domain/search/evidence adapted from agent-personal-memory',
      ' * (MIT, Copyright (c) 2026 Agent Personal Memory contributors).',
      ' * See NOTICE.md for the full notices.',
      ' */',
    ].join('\n'),
  },
  deps: {
    neverBundle: (specifier: string) => specifier.startsWith('@deepseek-ai/'),
  },
}

export default [config]
