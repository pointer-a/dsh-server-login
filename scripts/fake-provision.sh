#!/usr/bin/env bash
# Fake provision script for the smoke test: appends the args it received
# (userId, username) to the file named by FAKE_PROVISION_LOG, so the test can
# assert the orchestrator invoked it after registration.
set -euo pipefail
echo "$1 $2" >> "${FAKE_PROVISION_LOG:-/tmp/fake-provision.log}"
