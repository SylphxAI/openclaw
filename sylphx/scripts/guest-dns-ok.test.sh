#!/usr/bin/env bash
# Unit checks for guest_dns_ok semantics (extracted pure checks).
set -euo pipefail

guest_dns_ok_from_file() {
  local path="$1"
  if [ ! -s "$path" ]; then
    return 1
  fi
  if ! grep -qE '^[[:space:]]*nameserver[[:space:]]+[^[:space:]]+' "$path" 2>/dev/null; then
    return 1
  fi
  return 0
}

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT

# empty file → fail
: >"$tmpdir/empty"
if guest_dns_ok_from_file "$tmpdir/empty"; then
  echo "FAIL: empty resolv should fail" >&2
  exit 1
fi

# missing nameserver → fail
printf 'search example.local\noptions ndots:5\n' >"$tmpdir/no-ns"
if guest_dns_ok_from_file "$tmpdir/no-ns"; then
  echo "FAIL: resolv without nameserver should fail" >&2
  exit 1
fi

# valid ClusterFirst-shaped resolv → pass
printf 'search env.svc.cluster.local svc.cluster.local cluster.local\nnameserver 10.96.0.10\noptions ndots:5\n' >"$tmpdir/ok"
if ! guest_dns_ok_from_file "$tmpdir/ok"; then
  echo "FAIL: valid resolv should pass" >&2
  exit 1
fi

# missing file → fail
if guest_dns_ok_from_file "$tmpdir/does-not-exist"; then
  echo "FAIL: missing file should fail" >&2
  exit 1
fi

echo "guest-dns-ok.test.sh: ok"
