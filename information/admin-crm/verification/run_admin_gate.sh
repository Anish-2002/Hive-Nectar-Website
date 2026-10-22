#!/usr/bin/env bash
# Admin CRM verification gate - the documented order, runnable from the repo.
#
# ORDER MATTERS. Read this before reordering anything.
#
# Some migration verifiers REPLAY their migration file against the live database
# to prove the file still applies (apply_verify_migration09.py and
# apply_verify_migration11.py do this in their stage 0). Migration 11's file
# defines four functions that the mail work later replaced, so a replay resets
# the mail paths and the integration-health block to their pre-fix bodies.
#
# Therefore the mail steps run LAST, and they start by re-applying migrations 14,
# 15 and 16 in order. If you add a verifier that replays an older migration, put
# it ABOVE the convergence block, never below it.
#
#   python3 information/admin-crm/verification/run_admin_gate.sh   (or bash)
#
cd "$(dirname "$0")" || exit 1
PY=/usr/bin/python3
# The management query endpoint rate-limits bursts of SQL ("ThrottlerException:
# Too Many Requests"), and this gate runs a dozen SQL-heavy scripts back to
# back. GAP spaces the scripts out; a script that still comes back throttled is
# retried once after a longer pause, so a rate limit is never reported as a
# failing verifier.
GAP=${GAP:-12}
RETRY_GAP=${RETRY_GAP:-45}
total_p=0; total_f=0; failed=0; retried=0; zero=0
run() {
  local label="$1"; shift
  out=$("$PY" "$@" 2>&1)
  code=$?
  if printf '%s' "$out" | grep -qE 'Too Many Requests|ThrottlerException|HTTP 429|429:'; then
    retried=$((retried + 1))
    echo "  (throttled - retrying $label after ${RETRY_GAP}s)"
    sleep "$RETRY_GAP"
    out=$("$PY" "$@" 2>&1)
    code=$?
  fi
  # Take the count from the last "N PASS" / "N FAIL" in the whole output rather than
  # from a line-start anchor: scripts summarise as "RESULT  137 PASS / 0 FAIL", which a
  # start-of-line number match scores as zero (it silently under-reported the total).
  summary=$(printf '%s\n' "$out" | grep -E 'PASS' | grep -E 'FAIL' | tail -1)
  [ -z "$summary" ] && summary=$(printf '%s\n' "$out" | grep -E 'PASS' | tail -1)
  [ -z "$summary" ] && summary=$(printf '%s\n' "$out" | tail -1)
  # Scripts summarise in two shapes -- "137 PASS / 0 FAIL" and "PASS 16 / FAIL 0" --
  # so both orders are tried before giving up and scoring the script as zero.
  p=$(printf '%s' "$out" | grep -oE '[0-9]+ PASS' | tail -1 | grep -oE '^[0-9]+')
  [ -z "$p" ] && p=$(printf '%s' "$out" | grep -oE 'PASS[[:space:]]+[0-9]+' | tail -1 | grep -oE '[0-9]+$')
  f=$(printf '%s' "$out" | grep -oE '[0-9]+ FAIL' | tail -1 | grep -oE '^[0-9]+')
  [ -z "$f" ] && f=$(printf '%s' "$out" | grep -oE 'FAIL[[:space:]]+[0-9]+' | tail -1 | grep -oE '[0-9]+$')
  [ -z "$p" ] && p=0
  [ -z "$f" ] && f=0
  total_p=$((total_p + p)); total_f=$((total_f + f))
  [ "$p" -eq 0 ] && zero=$((zero + 1))
  [ "$code" -ne 0 ] && failed=$((failed + 1))
  printf '%-34s exit=%s  %s\n' "$label" "$code" "$summary"
  sleep "$GAP"
}

echo "== static / read-layer verifiers =="
run verify_admin_module_graph.py        verify_admin_module_graph.py
run verify_admin_ui_wiring.py           verify_admin_ui_wiring.py
run verify_guide_admin_section.py       verify_guide_admin_section.py
run verify_crm_payload_shapes.py        verify_crm_payload_shapes.py
run verify_admin_rpc_path.py            verify_admin_rpc_path.py
run verify_mail_wiring.py               verify_mail_wiring.py

echo "== migration verifiers (these REPLAY their migration: see the header) =="
run apply_verify_migration13.py         apply_verify_migration13.py
run apply_verify_migration12.py         apply_verify_migration12.py
run apply_verify_migration11.py         apply_verify_migration11.py
run apply_verify_migration10.py         apply_verify_migration10.py
run apply_verify_migration09.py         apply_verify_migration09.py
run apply_verify_migration06.py         apply_verify_migration06.py
run reverify_migration01.py             reverify_migration01.py
run apply_verify_migration02.py         apply_verify_migration02.py
run apply_verify_migration03.py         apply_verify_migration03.py
run verify_reflections_flow.py          verify_reflections_flow.py

echo "== mail convergence + live mail proof (must stay last) =="
run reapply_mail_migrations.py          reapply_mail_migrations.py
run probe_mail_paths.py                 probe_mail_paths.py --live
run verify_mail_live_state.py           verify_mail_live_state.py
echo "=================================================="
echo "GATE TOTAL: $total_p PASS / $total_f FAIL   (scripts with non-zero exit: $failed; scripts reporting no count: $zero; throttle retries: $retried)"
[ "$failed" -eq 0 ] || exit 1
