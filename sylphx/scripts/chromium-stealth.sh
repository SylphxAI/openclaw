#!/usr/bin/env bash
# =============================================================================
# Stealth Chromium Wrapper v3 — Anti-Detection Optimized
# =============================================================================
# Launches /usr/bin/chromium with comprehensive anti-detection flags.
# Passes all major bot detection tests (WebGL renderer spoofed via extension).
#
# Key defences:
#   - Removes navigator.webdriver flag
#   - Disables automation-revealing infobars
#   - Kills Google telemetry (sync, component updates, background networking)
#   - Suppresses first-run prompts and default browser checks
#   - Enables WebGL via SwiftShader software rendering (no --disable-gpu!)
#   - Sets realistic window size
#   - Container-friendly (no-sandbox, shared memory workaround)
# =============================================================================

STEALTH_FLAGS=(
  # --- Core anti-detection ---
  --disable-blink-features=AutomationControlled   # removes navigator.webdriver=true
  --disable-infobars                               # no "Chrome is being controlled" bar
  --disable-automation                             # no automation infobar (legacy)
  --disable-features=AutomationControlled          # belt-and-suspenders for webdriver

  # --- Suppress Google telemetry ---
  --disable-background-networking
  --disable-sync
  --disable-component-update
  --disable-domain-reliability
  --disable-client-side-phishing-detection
  --disable-default-apps
  --disable-extensions-except=/usr/local/lib/chromium-stealth-ext
  --load-extension=/usr/local/lib/chromium-stealth-ext   # inject stealth overrides
  --disable-hang-monitor
  --disable-popup-blocking
  --disable-prompt-on-repost
  --disable-translate

  # --- First-run & noise suppression ---
  --no-first-run
  --no-default-browser-check
  --no-service-autorun
  --password-store=basic
  --metrics-recording-only
  --disable-breakpad

  # --- Container-friendly ---
  --disable-dev-shm-usage
  --no-sandbox

  # --- GPU / WebGL via SwiftShader software rendering ---
  # IMPORTANT: Do NOT use --disable-gpu — it kills all WebGL contexts,
  # which is a major bot detection signal (real browsers always have WebGL).
  # SwiftShader provides software-based WebGL that passes detection tests.
  --use-gl=angle
  --use-angle=swiftshader-webgl
  --enable-unsafe-swiftshader

  # --- Realistic window ---
  --window-size=1920,1080
  --start-maximized
)

exec /usr/bin/chromium "${STEALTH_FLAGS[@]}" "$@"
