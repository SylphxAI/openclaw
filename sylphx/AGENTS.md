# Repository Instructions

Start with `PROJECT.md` before changing this repository. It defines the
project goal, lifecycle, boundaries, public surfaces, and delivery model.

This repository owns the OpenClaw customer app and runtime intent; the Sylphx
platform must remain zero-knowledge and consume only documented generic
service/deploy surfaces.

Never commit live secrets, tenant credentials, or secret-derived values. Treat
deployed instance, durable data, provider, and secret side effects as
forward-fix recovery work, not source-revert-only work.

For runtime changes, prove the affected Sylphx deployment path, service
health, and instance smoke behavior described in the repo docs.
