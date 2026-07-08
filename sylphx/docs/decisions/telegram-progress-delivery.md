# Telegram Progress Delivery

Date: 2026-05-07

## Context

OpenClaw instances run as customer apps on Sylphx Platform. Users interact with them primarily through Telegram groups and forum topics, so perceived responsiveness matters as much as process health.

In Epiow, the pod was healthy, file descriptor usage was low, and model calls were returning successfully, but users still saw intermittent silence. Runtime logs showed turns queued on Telegram per-chat/per-topic lanes, long model calls, and occasional misuse of the generic `message.action` tool:

- `action="poll"` was called without `pollQuestion`, which is invalid because it creates a Telegram poll.
- forum topics were sometimes targeted as `<chatId>_<threadId>` instead of Telegram's supported `<chatId>:topic:<threadId>` format.
- global block streaming was enabled, which lets block delivery own Telegram output and suppresses Telegram preview/progress streaming.
- internal startup hooks were enabled while the workspace only had OpenClaw's placeholder `BOOT.md`; every gateway restart ran a no-op agent boot check and could starve Telegram startup timers.

## Decision

Sylphx-managed OpenClaw deploys use Telegram progress streaming by default:

- `agents.defaults.blockStreamingDefault` is locked to `off`.
- `channels.telegram.streaming.mode` is locked to `progress`.
- `channels.telegram.network.dnsResultOrder` is locked to `ipv4first` so Telegram API calls do not stall on unusable IPv6 paths before falling back.
- Telegram preview/progress tool detail uses `commandText: "status"` to show useful progress without leaking noisy command text.
- `messages.visibleReplies` and `messages.groupChat.visibleReplies` are locked to `automatic`. OpenClaw upstream defaults group/channel rooms to message-tool-only visible replies; Sylphx-managed customer agents should post normal final answers back to Telegram instead of silently keeping them in the transcript when the model fails to call `message(action=send)`.
- Telegram block streaming is explicitly disabled at channel level.
- `hooks.internal.enabled` is locked to `false` unless a customer intentionally installs a real hook. Placeholder `BOOT.md` files must not trigger model calls during channel startup.
- Managed workspace instructions document the correct Telegram topic target format and the difference between poll creation and message reading.

## Consequences

Users should see a live progress draft or concise tool status while a model/tool run is active, instead of waiting silently for the final response. Long model calls can still take time, but Telegram delivery should avoid the 10s IPv6-first timeout path observed during startup and should no longer compete with placeholder boot-check model calls.

Group and forum-topic turns should also produce visible Telegram final replies by default. Tool-only visible replies remain an upstream option for locked-down group deployments, but they are the wrong default for Sylphx's current customer-app posture where usability is more important than channel-side suppression.

If a customer explicitly wants block-style final delivery on Telegram, treat that as an app-level override and document the tradeoff: block streaming reduces live progress visibility.
