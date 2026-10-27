# Security policy

## Reporting a vulnerability

Report vulnerabilities privately through
[GitHub Security Advisories](https://github.com/bin-Deng-666/wechat-persona/security/advisories/new).

Do not open a public issue for a security problem, and do not include real
credentials, tokens, QR payloads or private chat content in any report. If you
must share a log, redact those values first.

Please include:

- what an attacker can do, and the conditions required;
- the affected version and the permission preset in use;
- a minimal reproduction or the relevant log lines with secrets removed;
- any mitigation you already know of.

Expect an initial acknowledgement within a few days. This is a volunteer
project, so please allow reasonable time before requesting an update.

## Supported versions

The `main` branch is the only supported line. Fixes are not backported to older
development tags.

## Threat model

This plugin deliberately gives a chat account the ability to drive a local
agent. That is the feature. Understand what it implies before deploying it.

### What the plugin trusts

- **The allow list.** Only peers admitted by the `allow` config, or the account
  that scanned the login QR when `allow` is empty, can create sessions, run
  commands or trigger tools. Anyone admitted is trusted completely.
- **The WeChat account.** Possession of the logged-in phone is treated as proof
  of identity. There is no second factor and no per-command confirmation unless
  the session permission preset asks for approval.
- **The local host.** The agent runs with the permissions DSH grants it. The
  plugin does not sandbox tool execution.

### What is sensitive

| Item | Location | Notes |
|---|---|---|
| Bot token and account id | `~/.dsh/wechat-persona/account.json` | Written with mode `0600`. Deleting it logs the bot out. |
| Archived device sessions | `~/.dsh/wechat-persona/settings/sessions.json` on previously configured hosts | The current plugin does not create or use web device sessions. Preserve old files privately; archived services must remain stopped unless deliberately restored. |
| Chat transcripts | DSH session storage and `~/.dsh/wechat-persona/conversations/` | Contains original input, tool output, reply tokens, task snapshots and delivery status. Local conversation files use mode `0600`. |
| Personal memories | `~/.dsh/wechat-persona/memory/` | Per-contact facts, original quotations, versions and deletion suppression keys. Legacy `memories.json` is retained as unverified data. |
| Sticker assets | `~/.dsh/wechat-persona/stickers/` | Contains media received in chat. |
| Diagnostic logs | `~/.dsh/wechat-persona/logs/` | May contain peer ids, tool names and error text. |

### WeChat controls and archived clients

Settings and help are handled in the admitted contact's WeChat conversation.
The current plugin starts no settings HTTP listener, local control socket or
background settings service. Menu state is scoped to the contact and expires
after five minutes. Clearing memories requires a second menu confirmation.
Pending approval replies take priority over menu choices.

The web service, device authentication and mini program are preserved in
[archive/settings-clients](archive/settings-clients/README.md), with their
[historical security notes](archive/settings-clients/SECURITY.md). They are not
part of the active build or package. Archiving source does not automatically
uninstall an older background service; stop that service separately and keep
its stored sessions private. Any future restoration needs a fresh review of
authentication, contact isolation and network exposure.

### The default permission preset

`cordis.patch.yml` installs with `permission: danger-full-access`. In that
preset the host does not ask for approval, so an admitted peer can run tools
without any confirmation step. This is intentional: WeChat cannot render the
approval card, and `workspace-write` would leave the agent unable to act.

If you want a confirmation step, set `permission: workspace-write` and reply to
the approval prompt with `1`, `2` or `3` in chat. If you do not need the agent to
act at all, use `read-only`.

Consequences to keep in mind:

- Anyone who can send messages as an allow-listed account can act with the same
  local privileges DSH has.
- The allow list is the only boundary. Keep it narrow, and remove ids that no
  longer need access.
- Running with `danger-full-access` on a shared or untrusted machine is not
  recommended.

### Out of scope

The following are known and accepted, not vulnerabilities:

- The bot replies to whoever the allow list admits.
- Chat content and tool results are stored unencrypted on the local disk.
- The vendor may change or terminate the iLink channel at any time.
- Using this project may conflict with the WeChat terms of service. That risk is
  borne by the operator.

## Handling a suspected compromise

1. Quit DSH so the plugin stops polling.
2. Delete `~/.dsh/wechat-persona/account.json` to invalidate the local session
   and log the bot out.
3. Run `npm run login` to scan a fresh QR code, which issues a new token.
4. Rotate anything the agent could have reached: API keys in the environment,
   SSH keys, and stop any separately installed legacy settings service.
5. Review `~/.dsh/wechat-persona/logs/` and the DSH session log for the actions
   that were taken.

Removing the plugin or deleting a file does not invalidate a leaked token. Only
logging out or re-scanning does.
