#!/usr/bin/env python3
"""Fix markdownlint substantive warnings across the repo (Task 2).

Targets the six rules:
  MD009  trailing spaces
  MD026  heading trailing punctuation
  MD029  ordered-list item prefix
  MD034  bare URLs
  MD037  spaces inside emphasis
  MD040  fenced code blocks missing a language

Strategy
--------
The four rules that have a well-defined, context-sensitive fix
(MD009 / MD026 / MD029 / MD037) are delegated to **markdownlint's own
`--fix`** engine -- it is the reference implementation and handles nested
ordered lists, loose lists and emphasis correctly (no false edits).

The two rules that `--fix` cannot safely auto-resolve are handled here in
Python:
  * MD040 - a language tag must be *guessed* for each fenced block.
  * MD034 - bare http(s) URLs are wrapped in <...> (autolink).

Usage
-----
  python3 scripts/fix_md_warnings.py [path ...]

With no paths it processes docs/**/*.md and the root *.md files.
Requires the `markdownlint` CLI (auto-resolved via `npx` if needed).
"""

import os
import re
import sys
import glob
import shutil
import subprocess

# --------------------------------------------------------------------------
# Python fixes for MD040 / MD034 (markdownlint --fix cannot do these).
# --------------------------------------------------------------------------
FENCE_RE = re.compile(r"^(\s*)(`{3,}|~{3,})\s*([^\s`]*)\s*$")


def guess_language(block: str) -> str:
    s = block.strip()
    if not s:
        return "text"
    if s[0] in "{[" and s.rstrip()[-1] in "}]":
        try:
            import json

            json.loads(s)
            return "json"
        except Exception:
            pass
    shell_markers = (
        "$ ", "> ", "sudo ", "curl ", "wget ", "npm ", "npx ", "yarn ",
        "pnpm ", "git ", "cd ", "pip", "python", "node ", "export ",
        "source ", "bash", "sh ", "chmod ", "mkdir ", "rm ", "cp ",
        "mv ", "docker ", "blender ", "make ", "cargo ", "go ", "apt",
        "brew ", "ssh ", "scp ", "./",
    )
    if any(ln.lstrip().startswith(shell_markers) for ln in block.splitlines()):
        return "bash"
    if re.search(r"<[a-zA-Z][^>]*>", block) and s[0] not in "{}[]":
        return "html"
    if re.search(r"\b(function|const|let|var|=>|import\s|export\s|"
                 r"console\.|document\.|window\.|class\s|interface\s|"
                 r"type\s|namespace\s)", block):
        return "js"
    return "text"


def fix_md040(text: str) -> str:
    """Add a language tag to fenced code blocks that have none.

    State-aware: tracks open/close fences so that (a) closing fences are kept
    bare (a language on a closing fence is invalid markdown and breaks the
    block) and (b) a ``` shown *inside* a code example is not mistaken for a
    real fence.
    """
    lines = text.split("\n")
    out = []
    in_code = False
    n = len(lines)
    i = 0
    while i < n:
        line = lines[i]
        m = FENCE_RE.match(line)
        if m:
            indent, fence, lang = m.group(1), m.group(2), m.group(3)
            if not in_code:
                # Opening fence.
                if lang == "":
                    j = i + 1
                    block = []
                    while j < n and not FENCE_RE.match(lines[j]):
                        block.append(lines[j])
                        j += 1
                    out.append(f"{indent}{fence}{guess_language(chr(10).join(block))}")
                else:
                    out.append(line)  # already has a language
                in_code = True
            else:
                # Closing fence: must stay bare (strip any spurious language).
                out.append(f"{indent}{fence}")
                in_code = False
            i += 1
            continue
        out.append(line)
        i += 1
    return "\n".join(out)


def fix_md034(text: str) -> str:
    """Wrap bare http(s) URLs in <...>.

    Inline code spans (`` `...` ``) are masked first so URLs shown as literal
    code are left untouched (matching markdownlint, which ignores code spans).
    Existing <>, () spans are also left alone. Trailing punctuation that is not
    part of the URL (e.g. a period ending a sentence) is stripped before
    wrapping.
    """
    spans = []

    def mask(m: re.Match) -> str:
        spans.append(m.group(0))
        return f"\x00{len(spans) - 1}\x00"

    def repl(m: re.Match) -> str:
        url = m.group(1).rstrip(".,;:!?")
        return "<" + url + ">"

    # Mask inline code spans so their contents (incl. URLs) are not wrapped.
    text = re.sub(r"`[^`]*`", mask, text)
    text = re.sub(r'(?<![<(`\]])(https?://[^\s)]+)', repl, text)

    def restore(m: re.Match) -> str:
        # Repair any URL that a previous (buggy) run wrongly wrapped inside a
        # code span: unwrap <url> (or a dangling <url with no closing >) back
        # to the bare url.
        return re.sub(r"<(https?://[^`>\s]*?)>?", r"\1", spans[int(m.group(1))])

    text = re.sub(r"\x00(\d+)\x00", restore, text)
    return text


# --------------------------------------------------------------------------
# markdownlint --fix driver for MD009 / MD026 / MD029 / MD037.
# --------------------------------------------------------------------------
def resolve_markdownlint() -> list:
    """Return a command list to invoke markdownlint, using a local binary or npx."""
    if shutil.which("markdownlint"):
        return ["markdownlint"]
    if shutil.which("npx"):
        return ["npx", "-y", "markdownlint-cli"]
    return []


def run_markdownlint_fix(paths: list) -> int:
    cmd = resolve_markdownlint()
    if not cmd:
        sys.stderr.write(
            "ERROR: markdownlint CLI not found. Install it "
            "(npm i -g markdownlint-cli) or ensure npx is available.\n"
        )
        return 2
    # Enable ONLY the four rules we delegate; everything else stays disabled so
    # --fix cannot touch unrelated content.
    cfg = (
        '{\n'
        '  "default": false,\n'
        '  "MD009": true,\n'
        '  "MD026": true,\n'
        '  "MD029": true,\n'
        '  "MD037": true\n'
        '}\n'
    )
    cfg_path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                            ".fix_md_lintrc.json")
    with open(cfg_path, "w", encoding="utf-8") as f:
        f.write(cfg)
    try:
        proc = subprocess.run(cmd + ["--fix", "-c", cfg_path] + paths,
                              capture_output=True, text=True)
        # markdownlint exits non-zero when it auto-fixes; that is expected.
        if proc.returncode not in (0, 1):
            sys.stderr.write(proc.stderr)
            return proc.returncode
        return 0
    finally:
        try:
            os.remove(cfg_path)
        except OSError:
            pass


# --------------------------------------------------------------------------
# File handling.
# --------------------------------------------------------------------------
def collect_paths(args: list) -> list:
    if args:
        paths = []
        for a in args:
            if os.path.isdir(a):
                paths.extend(glob.glob(os.path.join(a, "**", "*.md"), recursive=True))
            else:
                paths.append(a)
        return sorted(set(paths))
    paths = glob.glob("docs/**/*.md", recursive=True)
    paths += glob.glob("*.md")
    return sorted(set(paths))


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    paths = collect_paths(args)
    paths = [p for p in paths if os.path.isfile(p)]
    if not paths:
        print("No markdown files found.")
        return 0

    print(f"Step 1/2: markdownlint --fix (MD009/MD026/MD029/MD037) on "
          f"{len(paths)} file(s)...")
    rc = run_markdownlint_fix(paths)
    if rc not in (0, 1):
        return rc

    print("Step 2/2: Python fix (MD040 fence languages, MD034 bare URLs)...")
    changed = 0
    for p in paths:
        with open(p, "r", encoding="utf-8") as f:
            original = f.read()
        fixed = fix_md040(fix_md034(original))
        if fixed != original:
            with open(p, "w", encoding="utf-8") as f:
                f.write(fixed)
            changed += 1
            print(f"  python-fixed: {p}")

    print(f"\nDone. {changed} file(s) edited by the Python pass; "
          f"markdownlint --fix edited others as needed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
