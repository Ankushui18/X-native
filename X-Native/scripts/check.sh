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

# Fail early and accurately when the host does not provide Rust. Without this
# preflight, every Cargo-backed step reports a different misleading failure
# (format, clippy, tests, and CLI) for the same missing executable.
step "Rust toolchain"
if command -v "$CARGO" >/dev/null 2>&1; then
    ok "Cargo available: $(command -v "$CARGO")"
else
    bad "Cargo is not installed; install Rust via rustup or the system package manager"
    printf '      expected command: %s\n' "$CARGO"
    exit 1
fi

# Dead code is tracked, not gated: see docs/KNOWN_DEBT.md. This number is a
# ratchet — fixing a warning means lowering it, adding one means CI complains.
# Re-measured 16 Sep 2026 after a period in which the tree did not compile and
# therefore reported nothing: see the "Why the ceiling moved" note in
# docs/KNOWN_DEBT.md, which itemises all 82.
DEAD_CODE_CEILING=${DEAD_CODE_CEILING:-82}

# NaN-safe ordering is a correctness invariant: partial_cmp returns None for
# unordered floats and must never be force-unwrapped in production Rust. Keep
# the recurring gradient panic from coming back.
step "NaN ordering guard"
# The scan below shells out to ripgrep. Without this preflight a host without
# rg would silently pass (empty output reads as "no matches"), which is exactly
# the failure mode the Rust-toolchain preflight above exists to prevent.
if ! command -v rg >/dev/null 2>&1; then
    bad "ripgrep (rg) is not installed; the NaN-ordering scan cannot run"
    printf '      expected command: rg (install via package manager or cargo install ripgrep)\n'
else
NAN_MATCHES=$(rg -n --glob '*.rs' 'partial_cmp\([^\n]*\)\.unwrap\(' crates apps || true)
if [[ -z "$NAN_MATCHES" ]]; then
    ok "no partial_cmp().unwrap() sites"
else
    bad "unsafe partial_cmp().unwrap() found"
    printf '%s\n' "$NAN_MATCHES" | sed 's/^/      /'
fi
fi

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
    # The requirement is zero, so this list is bounded by definition — print all
    # of it. A count that does not say WHICH warning cannot be acted on from a
    # PR comment, which for a checkout without a toolchain is the only channel.
    printf '%s\n' "$WARN_LINES" | grep -vE 'never (used|read|constructed)' |
        head -40 | sed 's/^/      /'
else
    ok "no lints outside the dead-code budget"
fi
if [[ $DEAD -gt $DEAD_CODE_CEILING ]]; then
    bad "dead code grew: $DEAD warning(s), ceiling $DEAD_CODE_CEILING (docs/KNOWN_DEBT.md)"
    # Where it lives, per file, so the ratchet can be reconciled against the
    # table in docs/KNOWN_DEBT.md instead of guessed at — and then the items
    # themselves, because a file count cannot tell you WHICH entry to write.
    printf '%s\n' "$WARN_LINES" | grep -E 'never (used|read|constructed)' |
        sed -E 's/:[0-9]+:[0-9]+:.*//' | sort | uniq -c | sort -rn | sed 's/^/      /'
    printf '%s\n' "$WARN_LINES" | grep -E 'never (used|read|constructed)' |
        sed -E 's|^([^:]+):[0-9]+:[0-9]+: warning: |\1  ::  |' | sort |
        sed 's/^/      /'
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
        # WHICH test failed is only half the report; the panic payload is the
        # half that says why. The raw step log lives in blob storage that some
        # tooling cannot reach, so for a failure diagnosed through the PR
        # comment these lines are the only evidence there is.
        grep -E "panicked at|^assertion|assertion .*failed|^ *(left|right):" "$TEST_LOG" |
            head -40 | sed 's/^/      /'
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

    step "design sheet (regenerate, then diff)"
    # tools/design-sheet is generated from the same sources this gate compiles,
    # and it lies silently when it goes stale: the type ladder used to ship five
    # of the seven steps because the generator carried its own key list. The
    # generators now read every step from the source, and this step re-runs them
    # and lets the working tree speak — a palette or scale edit that forgets to
    # regenerate fails here instead of shipping a sheet that documents the
    # previous scale. `SHEET_COMMIT` pins the provenance stamp to the committed
    # one, so a merge commit does not read as a change on every pull request.
    if command -v node >/dev/null 2>&1; then
        SHEET=tools/design-sheet
        STAMP=$(sed -n 's/.*"commit": *"\([0-9a-f]*\)".*/\1/p' "$SHEET/tokens.json" | head -1)
        if SHEET_COMMIT=${STAMP:-HEAD} node "$SHEET/build_tokens.mjs" >/dev/null 2>&1 &&
           node "$SHEET/build_audit.mjs" >/dev/null 2>&1 &&
           node "$SHEET/extract_icons.mjs" >/dev/null 2>&1; then
            DIRTY=$(git status --porcelain -- "$SHEET")
            if [[ -z "$DIRTY" ]]; then
                ok "generators reproduce the committed sheet byte for byte"
            else
                bad "the design sheet is out of date — regenerate it"
                echo "$DIRTY" | head -8 | sed 's/^/      /'
            fi
        else
            bad "a design-sheet generator failed (it is reading the sources — see the error above)"
        fi
    else
        echo "      skipped: no node on PATH (the generators need it)"
    fi

    step "design + Figma conformance (guard)"
    # The sheet steps above prove the sheet matches the sources. This proves the
    # *decisions* do: one owner per colour literal in the engine, a ratchet on the
    # literals that remain, every icon the chrome asks for, and every behaviour
    # docs/FIGMA_PARITY.md claims to copy from Figma still naming the test that
    # pins it. Dependency-free (node:fs only), so unlike the jsdom sheets it runs
    # on a bare runner.
    if command -v node >/dev/null 2>&1; then
        if GUARD_LOG=$(node tools/design-sheet/guard.mjs 2>&1); then
            ok "$(printf '%s\n' "$GUARD_LOG" | tail -1 | sed 's/^SUMMARY  //')"
        else
            bad "a design or Figma-parity rule is broken"
            printf '%s\n' "$GUARD_LOG" | grep -E '^FAIL' | head -12 | sed 's/^/      /'
        fi
    else
        echo "      skipped: no node on PATH (the guard needs it)"
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
