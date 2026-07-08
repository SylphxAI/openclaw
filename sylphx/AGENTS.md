# Repository Instructions

Start with `PROJECT.md` and `.doctrine/project.json` before changing this
repository. They define the project goal, lifecycle, boundaries, public
surfaces, delivery model, and adoption gaps.

Use `SylphxAI/doctrine` for enterprise standards. This repository owns the
OpenClaw customer app and runtime intent; the Sylphx platform must remain
zero-knowledge and consume only documented generic service/deploy surfaces.

Never commit live secrets, tenant credentials, or secret-derived values. Treat
deployed instance, durable data, provider, and secret side effects as
forward-fix recovery work, not source-revert-only work.

For control-plane-only changes, validate with:

```bash
python3 /Users/kyle/.doctrine/scripts/project-control-plane-audit.py --local . --fail-on-drift --json
git diff --check
```

For runtime changes, also prove the affected Sylphx deployment path, service
health, and instance smoke behavior described in the repo docs.
