# openclaw-deploy

`openclaw-deploy` is the production customer application repository for
deploying and operating multiple OpenClaw assistant instances on Sylphx. It owns
customer-side runtime intent, the OpenClaw container image contract, instance
configuration, and app-level operational policy while the Sylphx platform stays
zero-knowledge about OpenClaw-specific semantics.

## Lifecycle And Layer

- Lifecycle: `production`
- Layer: `application`

## Goals

- Declare OpenClaw runtime intent, image build inputs, and instance
  configuration for customer-owned deployments.
- Keep platform interaction limited to documented service templates,
  environment configuration, secrets flow, and runtime contract surfaces.
- Preserve a production-grade path for adding, deploying, and verifying
  OpenClaw instances without committing secrets.

## Non-Goals

- Own the generic Sylphx platform scheduler, deployment engine, or service
  template implementation.
- Own upstream OpenClaw core behavior beyond the customer image and runtime
  integration declared here.
- Store live secrets or make the platform aware of OpenClaw-specific product
  semantics.

## Boundaries

This repository owns `sylphx.toml`, `agents.yaml`, image build inputs, entrypoint
scripts, and OpenClaw customer-app decisions. The platform owns generic deploy
orchestration and environment fan-out. Changes that affect deployed instances,
secrets, durable data, or runtime side effects require forward-only recovery
planning.

## Public Surfaces

- `README.md` documents the customer app contract.
- `sylphx.toml` declares the Sylphx service contract.
- `agents.yaml` declares customer-owned instance intent.
- `Dockerfile.base` and `scripts/` define image/runtime behavior.
- `docs/decisions/` records customer-app runtime decisions.
- `.github/workflows/build-base.yml` provides manual base-image build escape
  hatch.
- `.doctrine/project.json` is the machine-readable project manifest.

## Delivery

The normal deploy path is the Sylphx platform push deployment path. The
`build-base` workflow is manual-only for emergency or explicit base image
operations. Production proof must include platform deployment readback, health
evidence, and affected instance smoke evidence.

The authoritative control-plane record is `.doctrine/project.json`.
