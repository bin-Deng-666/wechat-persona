# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Versions before `0.2.0` are development builds and were never published.

## [Unreleased]

## [0.2.0-dev.0] - 2026-10-26

### Changed

- **Persona now enters the session system prompt.** Personality, memory and the
  sticker catalog are contributed through the agent-scoped
  `system-prompt/assemble` hook, and are re-read on every request. User messages
  carry only the WeChat text and attachments.
- Replies default to a single message. Multiple messages are only produced when
  the model explicitly marks a boundary with `[分条]`.
- Chinese commands are the primary entry point: 菜单/设置, 帮助, 新对话, 状态,
  人格, 分条, 停止, 表情. The original `/` commands still work.
- Sticker assets are stored by content hash and de-duplicated. Recognition and
  access are scoped per contact; a file can be shared while its catalog entry
  stays private.
- GIF originals are preserved and previewed to the model as up to three PNG
  frames instead of a single still.
- Source tree reorganized by responsibility (`app`, `auth`, `wechat`, `ilink`,
  `dsh`, `chat`, `persona`, `stickers`, `media`, `reply`, `text`, `panel`).
  Tests mirror the same layout.

### Added

- Session-scoped system prompt integration with hot reload of persona, chat
  settings, memory and sticker catalog.
- Optional multi-message replies that keep text and stickers in one ordered
  send queue with shared throttling and retry.
- Automatic sticker capture with model-confirmed name, description and usage
  scenes; screenshots, photos and documents can be explicitly ignored.
- Memory persistence through the `[记住: …]` marker, readable and clearable from
  the settings card.
- Multi-frame GIF preview bounded by canvas, frame count and total decode size.
- Open source project files: CI workflow, issue and PR templates, Dependabot,
  contributing, security policy, code of conduct and this changelog.

### Removed

- Per-turn persona reminder prepended to user messages. Existing sessions keep
  the old text in their history; send 新对话 to start a clean context.
- Scheduled proactive messages, and the `proactive` persona field and per-chat
  toggle.
- Persona fields that never took effect: `sampling`, `greeting`, `aliases` and
  `media.understandImages`. Cards using them now get an explicit warning
  instead of being silently ignored.
- Historical development tarballs. Rebuild any old version from its commit.

### Fixed

- Long polling is cut short client-side so new messages no longer wait for the
  server hold to expire.
- The `context_token` of the inbound message is captured when a reply is queued,
  so later messages cannot overwrite it.
- Settings card actions answer with one confirmation line instead of sending a
  fresh card each time.

[Unreleased]: https://github.com/bin-Deng-666/wechat-persona/compare/v0.2.0-dev.0...HEAD
[0.2.0-dev.0]: https://github.com/bin-Deng-666/wechat-persona/releases/tag/v0.2.0-dev.0
