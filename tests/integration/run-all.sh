#!/bin/bash
# Run all integration sim scenarios and report aggregate results.
# Usage: ./tests/integration/run-all.sh [scenario1 scenario2 ...]
# No args = all scenarios.

set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AGENT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SIM_SCENARIOS="$AGENT_ROOT/../sim/scenarios"

cd "$AGENT_ROOT" || exit 1

# Build scenario list
if [ $# -gt 0 ]; then
  SCENARIOS=("$@")
else
  SCENARIOS=()
  for f in "$SIM_SCENARIOS"/*.json; do
    SCENARIOS+=("$(basename "$f" .json)")
  done
fi

echo "=== Integration Sim Batch Runner ==="
echo "Scenarios: ${#SCENARIOS[@]}"
echo ""

PASSED_TOTAL=0
FAILED_TOTAL=0
PASSED_SCENARIOS=()
FAILED_SCENARIOS=()
START_TIME=$(date +%s)

for scenario in "${SCENARIOS[@]}"; do
  echo "────────────────────────────────────────"
  echo "Running: $scenario"

  SCENARIO_START=$(date +%s)

  # Capture output and exit code
  OUTPUT=$(SIM_MODE=1 npx tsx tests/integration/sim-runner.ts "$scenario" 2>&1)
  EXIT_CODE=$?

  SCENARIO_END=$(date +%s)
  SCENARIO_DURATION=$((SCENARIO_END - SCENARIO_START))

  # Extract pass/fail counts from output
  RESULT_LINE=$(echo "$OUTPUT" | grep -E '=== Results: [0-9]+/[0-9]+ passed ===' | tail -1)

  if [ $EXIT_CODE -eq 0 ]; then
    PASSED_SCENARIOS+=("$scenario ($RESULT_LINE) [${SCENARIO_DURATION}s]")
    # Count individual assertions
    P=$(echo "$RESULT_LINE" | grep -oE '[0-9]+/[0-9]+' | cut -d/ -f1)
    T=$(echo "$RESULT_LINE" | grep -oE '[0-9]+/[0-9]+' | cut -d/ -f2)
    PASSED_TOTAL=$((PASSED_TOTAL + P))
  else
    FAILED_SCENARIOS+=("$scenario ($RESULT_LINE) [${SCENARIO_DURATION}s]")
    # Extract failure details
    FAILURES=$(echo "$OUTPUT" | grep -A1 '  ✗ ' | head -10)
    echo "$FAILURES"
    # Count assertions
    P=$(echo "$RESULT_LINE" | grep -oE '[0-9]+/[0-9]+' | cut -d/ -f1)
    T=$(echo "$RESULT_LINE" | grep -oE '[0-9]+/[0-9]+' | cut -d/ -f2)
    PASSED_TOTAL=$((PASSED_TOTAL + P))
    F=$((T - P))
    FAILED_TOTAL=$((FAILED_TOTAL + F))
  fi

  echo "  → $RESULT_LINE [${SCENARIO_DURATION}s]"
  echo ""
done

END_TIME=$(date +%s)
TOTAL_DURATION=$((END_TIME - START_TIME))

echo ""
echo "════════════════════════════════════════"
echo "BATCH RESULTS"
echo "════════════════════════════════════════"
echo ""
echo "Assertions: $PASSED_TOTAL passed, $FAILED_TOTAL failed, $((PASSED_TOTAL + FAILED_TOTAL)) total"
echo "Scenarios:  ${#PASSED_SCENARIOS[@]} passed, ${#FAILED_SCENARIOS[@]} failed, ${#SCENARIOS[@]} total"
echo "Duration:   ${TOTAL_DURATION}s ($(( TOTAL_DURATION / 60 ))m $(( TOTAL_DURATION % 60 ))s)"
echo ""

if [ ${#PASSED_SCENARIOS[@]} -gt 0 ]; then
  echo "PASSED:"
  for s in "${PASSED_SCENARIOS[@]}"; do
    echo "  ✓ $s"
  done
  echo ""
fi

if [ ${#FAILED_SCENARIOS[@]} -gt 0 ]; then
  echo "FAILED:"
  for s in "${FAILED_SCENARIOS[@]}"; do
    echo "  ✗ $s"
  done
  echo ""
  exit 1
fi

echo "All scenarios passed!"
