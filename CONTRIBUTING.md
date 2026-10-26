# Contributing

Thanks for taking the time to improve wechat-persona. This guide covers the
setup, the rules that keep the codebase navigable, and what a reviewable change
looks like.

## Development setup

Requirements:

- Node.js `^22.19.0 || >=24.0.0`
- npm 10 or newer
- For real message testing: the DSH desktop app and a WeChat account that can
  scan the login QR code

```bash
git clone https://github.com/bin-Deng-666/wechat-persona.git
cd wechat-persona
npm ci
npm run typecheck
npm test
npm run build
```

`npm ci` reads the committed lockfile. The project pins `legacy-peer-deps=true`
in `.npmrc` because the `@deepseek-ai/dsh-*` packages declare overlapping peer
ranges that are not all installed in every composition.

## Checks

Run these before opening a pull request:

```bash
npm run typecheck   # tsc --noEmit, covers src, scripts and test
npm test            # node --test, recursive over test/**/*.test.ts
npm run build       # tsdown, also regenerates lib/index.d.ts
npm pack --dry-run  # confirms the published file list
```

To run one area while iterating:

```bash
node --test --experimental-strip-types "test/wechat/*.test.ts"
node --test --experimental-strip-types "test/integration/*.test.ts"
```

Tests use `node --test` with TypeScript type stripping, so there is no test
build step and no extra runner to install.

## Where code goes

The directory layout is a contract, not a suggestion. Read
[`docs/structure.md`](docs/structure.md) before adding files.

| You are changing | Put it in |
|---|---|
| WeChat commands, menu, message loop | `src/wechat/` |
| iLink fields, AES, upload, download, errors | `src/ilink/` |
| DSH sessions, system prompt, events, approvals | `src/dsh/` |
| Per-chat settings, generations, memory, activity | `src/chat/` |
| Persona card parsing, loading, prompt rendering | `src/persona/` |
| Sticker storage, sticker text markers | `src/stickers/` |
| Generic image format and GIF handling | `src/media/` |
| Reply splitting, pacing, retries | `src/reply/` |
| Pure text transforms | `src/text/` |
| Panel page, routes, registration | `src/panel/` |
| Plugin install, lifecycle, service wiring | `src/app/` |

Rules that reviewers enforce:

- `src/index.ts` stays a thin public entry point. It exports; it does not
  implement.
- Lower layers never import upward. `src/text/` and `src/media/` must not know
  about DSH or iLink. `src/ilink/` must not know about personas or the panel.
- Do not add pass-through re-export files, and do not add a barrel `index.ts`
  per directory.
- `src/` never imports from `scripts/` or `test/`. Scripts may import `src/`.
- Pure logic (parsing, splitting, marker extraction) belongs in a module that
  does no filesystem or network IO, so it can be unit tested directly.

## The rules that keep messages from being lost

These invariants are load-bearing. Breaking one produces silent failures in the
WeChat client, not test failures.

1. Only the durable `assistant/message` is delivered. Narrator and tool-call
   messages are not sent.
2. Persona, memory and stickers go into the session system prompt. Never prepend
   them to user messages, and never rewrite the LLM request to inject them.
3. Every reply carries the `context_token` of the inbound message it answers.
4. A send counts as successful only when the business receipt says so. HTTP 200
   with a non-zero `ret` is a failure.
5. `ret: -2` is throttling and must back off, not be dropped.
6. Only allow-listed peers can drive the agent.

See [`docs/design.md`](docs/design.md) for the full list and reasoning.

## Tests

Add a test for every behaviour change. Prefer tests against the real module over
mocks, and construct the smallest fixture that exercises the branch.

- Pure functions: direct unit tests, no IO.
- Storage: use `mkdtemp` and clean up in `after`.
- Message path: `test/integration/conversation.test.ts` shows how to drive a
  channel with a fake API and fake sessions.
- System prompt: `test/integration/system-prompt.test.ts` uses the real
  `@deepseek-ai/dsh-system-prompt` assembler.

Do not assert on incidental formatting such as exact log text or whitespace
unless that formatting is the contract.

## Security and privacy

This plugin can drive a local agent from a chat app. Be careful with fixtures.

- Never commit `account.json`, bot tokens, QR payloads, real WeChat ids or
  private chat content. Redact them in issues and pull requests.
- Prefer synthetic ids such as `wxid-owner` in tests.
- Do not add dependencies casually. `src/` currently depends on
  `gifuct-js`, `pngjs` and `qrcode-generator`; the host `@deepseek-ai/*`
  packages are peers and must not be bundled.
- Report vulnerabilities through GitHub Security Advisories, not a public issue.
  See [`SECURITY.md`](SECURITY.md).

## Commits and pull requests

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/):
`type(scope): summary`. Common types here are `feat`, `fix`, `perf`, `refactor`,
`docs`, `test`, `build` and `chore`. Use Chinese for the summary as existing
history does, or English; do not mix both in one message.

Keep each pull request to one concern. If a change touches both a bug fix and a
refactor, split it. Update `CHANGELOG.md` under `Unreleased` when the change is
user-visible.

## Packaging

The plugin is consumed as a tarball, not from the npm registry. `private: true`
is intentional.

```bash
npm run pack   # writes release/dsh-wechat-persona-<version>.tgz
```

Install it into a DSH profile with the app's own CLI:

```bash
DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
"$DSH" plugin --profile desktop remove dsh-wechat-persona
"$DSH" plugin --profile desktop add ./release/dsh-wechat-persona-<version>.tgz
```

Fully quit and reopen DSH after installing. A running host keeps the plugin code
it already loaded; upgrading the tarball does not hot-swap it.

## License

By contributing you agree that your contribution is licensed under the
[MIT License](LICENSE) that covers this project.
