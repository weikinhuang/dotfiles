#!/usr/bin/env bats
# Tests for dotenv/bin/genpasswd

setup() {
  load '../../helpers/common'
  setup_test_bin
  SCRIPT="${REPO_ROOT}/dotenv/bin/genpasswd"

  stub_command openssl <<'EOF'
#!/usr/bin/env bash
printf '%s' 'abcXYZ123_-!abcXYZ123_-!'
EOF
}

@test "genpasswd: help prints usage" {
  run bash "${SCRIPT}" --help
  assert_success
  assert_output --partial "usage genpasswd"
}

@test "genpasswd: alpha mode filters output to alphanumeric characters and respects length" {
  run bash "${SCRIPT}" --alpha --length 8
  assert_success
  assert_output --regexp '^[A-Za-z0-9]{8}$'
}

@test "genpasswd: custom charlist filters output to requested characters" {
  run bash "${SCRIPT}" --chars=XY_ --length 5
  assert_success
  assert_output --regexp '^[XY_]{5}$'
}

@test "genpasswd: missing value for --length exits 1" {
  run bash "${SCRIPT}" --length
  assert_failure
  assert_output --partial "missing value for --length"
}
