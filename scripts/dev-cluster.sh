#!/usr/bin/env bash
#
# dev-cluster.sh — Spin up a local relay + two nodes for development/demo.
#
# Usage: bash scripts/dev-cluster.sh
#
# This script:
#   1. Starts a relay server on port 9090
#   2. Creates two temporary node identities (Alice and Bob)
#   3. Alice publishes an offer, Bob publishes a complementary need
#   4. Both nodes listen for matches via `resonance serve`
#   5. Cleans up on exit
#

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TSX="npx tsx"
CLI="$TSX $ROOT/packages/node/src/cli.ts"
RELAY="$TSX $ROOT/packages/relay/src/main.ts"

ALICE_DIR=$(mktemp -d /tmp/resonance-alice-XXXX)
BOB_DIR=$(mktemp -d /tmp/resonance-bob-XXXX)
RELAY_DIR=$(mktemp -d /tmp/resonance-relay-XXXX)
RELAY_PID=""
ALICE_PID=""
BOB_PID=""

PASSWORD="dev-demo"

cleanup() {
  echo ""
  echo "Cleaning up..."
  [ -n "$ALICE_PID" ] && kill "$ALICE_PID" 2>/dev/null || true
  [ -n "$BOB_PID" ] && kill "$BOB_PID" 2>/dev/null || true
  [ -n "$RELAY_PID" ] && kill "$RELAY_PID" 2>/dev/null || true
  rm -rf "$ALICE_DIR" "$BOB_DIR" "$RELAY_DIR"
  echo "Done."
}
trap cleanup EXIT

echo "╔══════════════════════════════════════════════╗"
echo "║   Resonance Dev Cluster                       ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

# 1. Start relay
echo "[1/6] Starting relay server..."
RELAY_DATA_DIR="$RELAY_DIR" RELAY_PORT=9090 $RELAY &
RELAY_PID=$!
sleep 2
echo "       Relay running (PID: $RELAY_PID)"
echo "       Health: $(curl -s http://localhost:9090/health)"
echo ""

# 2. Initialize Alice
echo "[2/6] Initializing Alice..."
HOME="$ALICE_DIR" $CLI init --password "$PASSWORD" 2>&1 | sed 's/^/       /'
echo ""

# 3. Initialize Bob
echo "[3/6] Initializing Bob..."
HOME="$BOB_DIR" $CLI init --password "$PASSWORD" 2>&1 | sed 's/^/       /'
echo ""

# 4. Alice publishes an offer
echo "[4/6] Alice publishes an offer..."
HOME="$ALICE_DIR" $CLI publish --type offer --privacy medium --password "$PASSWORD" --relay ws://localhost:9090 "Experienced Python developer available for freelance Django and Flask projects" 2>&1 | sed 's/^/       /'
echo ""

# 5. Start Alice's listener (background)
echo "[5/6] Starting Alice's listener..."
HOME="$ALICE_DIR" $CLI serve --password "$PASSWORD" --relay ws://localhost:9090 &
ALICE_PID=$!
sleep 1
echo "       Alice listening (PID: $ALICE_PID)"
echo ""

# 6. Bob publishes a need (should trigger match for both)
echo "[6/6] Bob publishes a complementary need..."
HOME="$BOB_DIR" $CLI publish --type need --privacy medium --password "$PASSWORD" --relay ws://localhost:9090 "Looking for a Python developer experienced with Django for our web startup backend" 2>&1 | sed 's/^/       /'
echo ""

# Wait a moment for match notification
sleep 2

echo "════════════════════════════════════════════════"
echo ""
echo "Relay stats:"
curl -s http://localhost:9090/stats | python3 -m json.tool 2>/dev/null || curl -s http://localhost:9090/stats
echo ""

echo "Alice's status:"
HOME="$ALICE_DIR" $CLI status --password "$PASSWORD" 2>&1 | sed 's/^/  /'
echo ""

echo "Bob's status:"
HOME="$BOB_DIR" $CLI status --password "$PASSWORD" 2>&1 | sed 's/^/  /'
echo ""

echo "════════════════════════════════════════════════"
echo "Dev cluster running. Press Ctrl+C to stop."
echo ""
echo "Try in another terminal:"
echo "  HOME=$BOB_DIR $CLI matches --password $PASSWORD"
echo "  HOME=$BOB_DIR $CLI connect <matchId> --password $PASSWORD"
echo ""

# Keep running until interrupted
wait
