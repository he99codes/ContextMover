# Devin Execution Configuration — Universal
# Applies to ALL projects, ALL languages, ALL tasks

---

## CORE PHILOSOPHY

> Direct. Fast. Verify. Fail-fast. No overthinking. No retries on wrong tool.

---

## RULE 1: File Editing — Tool Selection

```
wc -l <file>

< 200 lines   → Edit tool OK
200–500 lines → Edit tool preferred
> 500 lines   → CLI (Python/Bash) MANDATORY — no exceptions
Unknown size  → CLI (safe default)
```

On ANY Edit tool timeout or failure → switch to CLI immediately. No retries.

---

## RULE 2: Python CLI — Mandatory Execution Pattern

Always use heredoc (not python3 -c) to safely handle JS template literals,
backticks, ${} interpolation, and special characters in patterns.

```bash
python3 << 'PYEOF'
with open('path/to/file', 'r') as f:
    content = f.read()

old = """EXACT_OLD_PATTERN"""
new = """EXACT_NEW_PATTERN"""

# Verify before (fail fast)
assert old in content, 'Pattern not found — check file path and pattern'
old_count_before = content.count(old)  # capture BEFORE replace

# Replace (single occurrence)
content = content.replace(old, new, 1)

# Verify after (count comparison — handles new containing old as substring)
assert new in content, 'Replacement failed'
assert content.count(old) == old_count_before - 1, \
    f'Replace failed — expected {old_count_before - 1} occurrences, got {content.count(old)}'

with open('path/to/file', 'w') as f:
    f.write(content)

print('Applied')
PYEOF

# Confirm in file
grep -n "CONFIRM_PHRASE" path/to/file
```

Notes:
- Heredoc 'PYEOF' (quoted) prevents shell interpolation of ${} inside pattern
- Triple-quoted strings handle multiline, backticks, special chars
- For patterns that appear multiple times, pass old_count into the assert:
  assert content.count(old) == old_count - 1, 'Expected exactly N-1 occurrences after replace'

---

## RULE 3: Build & Type Verification — Auto-Detect Toolchain

Run after EVERY edit. No exceptions.
Exit code is captured BEFORE piping to tail — never trust $? after a pipe.

```bash
# ── Step 1: Type check (only if build won't run it internally) ──────────────

NEEDS_STANDALONE_TSC=false

if [ -f tsconfig.json ]; then
  # Skip standalone tsc if the build script already runs it
  if grep -q '"build":.*tsc' package.json 2>/dev/null; then
    echo "tsc runs inside build — skipping standalone check"
  else
    NEEDS_STANDALONE_TSC=true
  fi
fi

if [ "$NEEDS_STANDALONE_TSC" = true ]; then
  npx tsc --noEmit > /tmp/_diag_tsc.log 2>&1; TSC_EXIT=$?
  tail -20 /tmp/_diag_tsc.log
  [ $TSC_EXIT -ne 0 ] && echo "TYPE ERROR (exit $TSC_EXIT) — stop and fix" && exit 1
  echo "tsc: OK"
fi

# ── Step 2: Detect build tool ────────────────────────────────────────────────

if   [ -f pnpm-lock.yaml ];  then BUILD="pnpm build"
elif [ -f bun.lock ] || [ -f bun.lockb ]; then BUILD="bun run build"
elif [ -f yarn.lock ];       then BUILD="yarn build"
elif [ -f package.json ];    then BUILD="npm run build"
elif [ -f Cargo.toml ];      then BUILD="cargo build"
elif [ -f go.mod ];          then BUILD="go build ./..."
elif [ -f pyproject.toml ] || [ -f setup.py ]; then
  BUILD="find . -name '*.py' -not -path './.venv/*' -exec python -m py_compile {} +"
elif [ -f Makefile ];        then BUILD="make"
else BUILD=""; echo "No build tool detected — skipping build"
fi

# ── Step 3: Run build — capture exit code BEFORE tail ───────────────────────

if [ -n "$BUILD" ]; then
  $BUILD > /tmp/_diag_build.log 2>&1; BUILD_EXIT=$?
  tail -30 /tmp/_diag_build.log
  [ $BUILD_EXIT -ne 0 ] && echo "BUILD FAILED (exit $BUILD_EXIT) — stop and fix" && exit 1
  echo "Build: OK (exit 0)"
fi
```

---

## RULE 4: Pre-Edit Verification

Before touching any file:

```bash
# 1. Check file size
wc -l path/to/file

# 2. Verify pattern exists
grep -n "SEARCH_TERM" path/to/file

# 3. Count occurrences (avoid accidental multi-replace)
grep -c "SEARCH_TERM" path/to/file
```

If pattern not found: re-read file, check correct path, search with broader term.
Never proceed if pattern is missing.

---

## RULE 5: Execution Behavior

### Speed
- No prolonged analysis before acting
- Code first — brief explanation after if needed
- Don't explain why you chose CLI (just use it)
- Don't ask permission (rules define the decision)

### Fail-Fast
- Edit tool timeout → CLI immediately
- Pattern not found → stop, verify, retry once with broader search
- Build fails → stop, show full error, fix before next step
- Type error → stop, fix all errors before continuing
- Never move to next step with a broken state

### Accuracy
- Always grep before edit (pattern exists?)
- Always grep after edit (change applied?)
- Always build after edit (compiles?)
- assert before + after in every Python edit script
- Never trust $? after a pipe — always capture exit code first

### Output Format
```
✓ Pattern verified (grep: line N)
✓ Change applied
✓ Verify: [grep result]
✓ Build: exit 0
→ Done
```

---

## RULE 6: Language-Specific Notes

### JavaScript / TypeScript
- Heredoc 'PYEOF' for patterns with backticks and ${}
- If pnpm/yarn/npm build runs tsc internally — skip standalone tsc
- Watch for JSX, .tsx, .jsx when grepping

### Python
- Indentation matters — preserve exact indentation in patterns
- Use raw strings r"""...""" if pattern has backslashes
- py_compile via find (not **/*.py glob — needs globstar)

### Rust
- cargo check (fast) for type-only verification
- cargo build for full compilation
- Capture exit: cargo build > /tmp/build.log 2>&1; E=$?

### Go
- go build ./... for full build
- go vet ./... for static analysis

### Any Language
- File > 500 lines → CLI
- Capture exit code BEFORE piping to tail
- Verify pattern → apply → verify result → build
- This workflow is universal

---

## RULE 7: Error Recovery

| Situation | Action |
|-----------|--------|
| Edit tool timeout | Switch to Python CLI immediately |
| Pattern not found | grep broadly, check file path, re-read |
| assert fails (pre) | File changed — re-read and update pattern |
| assert fails (post) | replace() failed — check count(), retry |
| Build error | Show full error output, fix root cause |
| Type error | Show error, fix type, rebuild |
| Multiple occurrences | Use line number context to narrow pattern |
| Wrong file edited | git diff to check, revert if needed |

---

## RULE 8: Multi-File Tasks

```bash
python3 << 'PYEOF'
changes = [
    ('file1.ts', 'OLD_1', 'NEW_1'),
    ('file2.ts', 'OLD_2', 'NEW_2'),
    ('file3.ts', 'OLD_3', 'NEW_3'),
]

for filepath, old, new in changes:
    with open(filepath, 'r') as f:
        content = f.read()
    old_count = content.count(old)
    assert old_count >= 1, f'Pattern not found in {filepath}'
    content = content.replace(old, new, 1)
    assert new in content, f'Replace failed in {filepath}'
    assert content.count(old) == old_count - 1, \
        f'Replace failed in {filepath} — expected {old_count - 1} occurrences, got {content.count(old)}'
    with open(filepath, 'w') as f:
        f.write(content)
    print(f'Applied: {filepath}')

print('All changes applied')
PYEOF
```

---

## RULE 9: Task Checklist

Every code modification task:

- [ ] `wc -l file` — decide Edit tool vs CLI
- [ ] `grep -n "PATTERN" file` — verify pattern exists
- [ ] `grep -c "PATTERN" file` — count occurrences
- [ ] Apply change (CLI if > 500 lines)
- [ ] `grep -n "NEW_PATTERN" file` — verify result
- [ ] Run build verification (Rule 3 — auto-detect toolchain)
- [ ] Confirm exit 0
- [ ] Report: ✓ Done

---

## SUMMARY

```
> 500 lines          → CLI (Python heredoc) only
< 500 lines          → Edit tool OK
Every edit           → verify pattern before + after
Every edit           → build check (auto-detect toolchain)
Exit code            → capture BEFORE piping to tail (never trust $? after pipe)
tsc                  → skip if build already runs it internally
Timeout/failure      → switch method immediately
Execution style      → direct, fast, fail-fast, no overthinking
```
