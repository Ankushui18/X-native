#!/usr/bin/env bash
# The repository's own gate — CI (.github/workflows/ci.yml) runs exactly this
# script, so "it passes locally" and "it passes on CI" are the same claim.
#
#   scripts/check.sh            full gate (fmt, clippy, tests, docs, CLI smoke)
#   scripts/check.sh --quick    fmt + clippy only (pre-commit sized)
#   scripts/check.sh --fix      run the mechanical fixes, then re-gate
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

QUICK=0
FIX=0
for arg in "$@"; do
    case "$arg" in
        --quick) QUICK=1 ;;
        --fix) FIX=1 ;;
        *) echo "usage: scripts/check.sh [--quick|--fix]" >&2; exit 2 ;;
    esac
done

CARGO=${CARGO:-cargo}
FAILED=0
step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
ok()   { printf '    \033[32mok\033[0m %s\n' "$1"; }
bad()  { printf '    \033[31mFAIL\033[0m %s\n' "$1"; FAILED=$((FAILED + 1)); }

# Dead code is tracked, not gated: see docs/KNOWN_DEBT.md. This number is a
# ratchet — fixing a warning means lowering it, adding one means CI complains.
DEAD_CODE_CEILING=${DEAD_CODE_CEILING:-76}

if [[ $FIX == 1 ]]; then
    step "formatting (cargo fmt)"
    $CARGO fmt --all
    step "clippy autofix"
    $CARGO clippy --fix --workspace --all-targets --allow-dirty --allow-staged
fi

step "formatting (cargo fmt --check)"
if out=$($CARGO fmt --all -- --check 2>&1); then
    ok "tree is formatted"
else
    bad "unformatted code — run: cargo fmt --all"
    printf '%s\n' "$out" | head -20 | sed 's/^/      /'
fi

step "lints (cargo clippy --workspace --all-targets)"
LINT_LOG=$(mktemp)
$CARGO clippy --workspace --all-targets --message-format short >"$LINT_LOG" 2>&1
CLIPPY_EXIT=$?
WARN_LINES=$(grep -E '\.rs:[0-9]+:[0-9]+: (warning|error)' "$LINT_LOG" || true)
DEAD=$(printf '%s\n' "$WARN_LINES" | grep -cE 'never (used|read|constructed)' || true)
LIVE=$(printf '%s\n' "$WARN_LINES" | grep -vcE 'never (used|read|constructed)' || true)
LIVE=${LIVE:-0}
DEAD=${DEAD:-0}
rm -f "$LINT_LOG"
if [[ $CLIPPY_EXIT -ne 0 ]]; then
    bad "clippy exited $CLIPPY_EXIT (a denied lint — see [workspace.lints] in Cargo.toml)"
    $CARGO clippy --workspace --all-targets 2>&1 | grep -E '^error' -A 8 | head -30 | sed 's/^/      /'
elif [[ $LIVE -ne 0 ]]; then
    bad "$LIVE clippy warning(s) that are not tracked dead code"
else
    ok "no lints outside the dead-code budget"
fi
if [[ $DEAD -gt $DEAD_CODE_CEILING ]]; then
    bad "dead code grew: $DEAD warning(s), ceiling $DEAD_CODE_CEILING (docs/KNOWN_DEBT.md)"
else
    ok "dead code $DEAD / ceiling $DEAD_CODE_CEILING"
fi

if [[ $QUICK == 0 ]]; then
    step "tests (cargo test --workspace --locked)"
    TEST_LOG=$(mktemp)
    if $CARGO test --workspace --locked --no-fail-fast >"$TEST_LOG" 2>&1; then
        PASSED=$(grep -oE '[0-9]+ passed' "$TEST_LOG" | awk -F' ' '{s += $1} END {print s + 0}')
        IGNORED=$(grep -oE '[0-9]+ ignored' "$TEST_LOG" | awk -F' ' '{s += $1} END {print s + 0}')
        ok "$PASSED passed, $IGNORED ignored (opt-in GPU/screenshot tests)"
    else
        bad "test failures"
        grep -E '^(test .* FAILED|error(\[|:))' "$TEST_LOG" | head -20 | sed 's/^/      /'
    fi
    rm -f "$TEST_LOG"

    step "docs references"
    # A comment that points at a file nobody ships is worse than no comment:
    # check every docs/*.md referenced from Rust sources actually exists.
    MISSING=0
    for ref in $(grep -rhoE 'docs/[A-Z_0-9]+\.md' --include='*.rs' crates apps | sort -u); do
        [[ -f "$ref" ]] || { echo "      missing: $ref"; MISSING=$((MISSING + 1)); }
    done
    if [[ $MISSING -eq 0 ]]; then
        ok "every docs/*.md referenced from the sources exists"
    else
        bad "$MISSING dangling doc reference(s)"
    fi

    step "CLI smoke (x_native)"
    if $CARGO build -q -p x-designer --bin x_native 2>/dev/null; then
        TARGET_DIR=${CARGO_TARGET_DIR:-$PWD/target}
        BIN="$TARGET_DIR/debug/x_native"
        "$BIN" --version >/dev/null 2>&1 && ok "--version" || bad "--version"
        "$BIN" --help    >/dev/null 2>&1 && ok "--help"    || bad "--help"
        # the theme audit is the accessibility gate for the shipped palettes
        if "$BIN" theme audit >/dev/null 2>&1; then
            ok "theme audit: all palettes pass WCAG AA"
        else
            bad "theme audit: a shipped palette fails WCAG AA (x_native theme audit --json)"
        fi
        "$BIN" lint --list-rules >/dev/null 2>&1 && ok "lint --list-rules" || bad "lint --list-rules"
        "$BIN" theme audit --theme nonsense >/dev/null 2>&1
        [[ $? -eq 2 ]] && ok "unknown input exits 2 (usage)" || bad "unknown input should exit 2"
    else
        bad "could not build the CLI"
    fi
fi

printf '\n'
if [[ $FAILED -eq 0 ]]; then
    printf '\033[32mgate green\033[0m\n'
    exit 0
fi
printf '\033[31m%s step(s) failed\033[0m\n' "$FAILED"
exit 1
