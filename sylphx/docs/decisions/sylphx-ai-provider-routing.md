# Sylphx AI Provider Routing

Date: 2026-05-07

## Context

Managed OpenClaw instances are deployed as customer apps on Sylphx Platform, but their model provider is Sylphx AI. OpenClaw should not know about old internal proxy projects or cluster implementation details.

Epiow VMPS appeared silent in Telegram while the pod was healthy. The VMPS session had already completed previous turns and had no lock files. FD counts were low (`node` around 31 FDs, `dockerd` around 18 FDs), so this was not an FD leak.

The failing path was model routing:

- OpenClaw runtime model: `sylphx/executor` (Auto product retired; ADR-1226 on sylphx-ai).
- Runtime auth profile: `sylphx:default`, provider `sylphx`, token shape `ik-*`.
- Provider URL in locked config: `https://api.sylphx.ai/v1`.
- `api.sylphx.ai` was missing from the `sylphx-ai-prod/web` HTTPRoute, so requests returned Cloudflare `404` with an empty body.
- The same key and request succeeded against `sylphx-ai-prod/web:3000/v1`, proving the key and Sylphx AI app were healthy.

## Decision

The canonical OpenClaw provider URL remains:

```text
https://api.sylphx.ai/v1
```

The platform must make that public host route to the Sylphx AI customer app:

```text
namespace: sylphx-ai-prod
service: web
port: 3000
host: api.sylphx.ai
```

Do not configure OpenClaw to use:

- `sylphx-oat-proxy-prod`
- `oat-proxy.openclaw.svc.cluster.local`
- port `8787`
- `ANTHROPIC_BASE_URL` as the runtime source of truth

`ANTHROPIC_BASE_URL` may exist for bootstrap compatibility, but runtime provider routing is owned by `models.providers.sylphx.baseUrl` in `agents.yaml` and `scripts/config-lock.json`.

Managed OpenClaw instances also pin `models.providers.sylphx.timeoutSeconds: 600` and `models.providers.anthropic.timeoutSeconds: 600`. This timeout is provider-scoped, not an agent runtime timeout. OpenClaw uses it for provider HTTP requests and the model stream idle watchdog; without it, long-running `sylphx/executor` calls can surface a model idle timeout after the default roughly 120-second window even though Telegram and the Sylphx AI `/v1/models` endpoint are healthy.

Managed Sylphx AI provider entries use OpenAI Responses transport
(`api: openai-responses`) against `https://api.sylphx.ai/v1/responses`.
This keeps OpenClaw on the Gateway-native streaming path and avoids the legacy
chat-completions compatibility translator for Sylphx-managed models. Direct ZAI
entries remain `openai-completions` because ZAI's public compatibility endpoint
is chat-completions based.

## Consequences

When `api.sylphx.ai` is present on the HTTPRoute and Gateway listener, OpenClaw can keep a zero-knowledge customer-app deployment shape while still using Sylphx AI as the managed provider proxy.

If model calls fail with `404 status code (no body)`, first check the public route:

```bash
kubectl -n sylphx-ai-prod get httproute web -o jsonpath='{.spec.hostnames}'
curl -sS https://api.sylphx.ai/v1/models -H "Authorization: Bearer <redacted>"
```

Only inspect or change secrets after routing is known good. A valid `ik-*` key can look invalid if the request is accidentally landing on the wrong host or an unbound Cloudflare route.
