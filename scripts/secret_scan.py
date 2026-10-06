#!/usr/bin/env python3
"""Secret scanner (gitleaks-style rules, no download needed).

  python tool/secret_scan.py --history [repo_dir]   # every commit, all branches
  python tool/secret_scan.py --staged  [repo_dir]   # staged changes (pre-commit)

Prints file, commit, rule and only the LAST 4 characters of each match.
Exit code 1 when something is found (so hooks/CI fail).
"""
import re
import subprocess
import sys

RULES = [
    ("google-api-key", re.compile(r"AIza[0-9A-Za-z_\-]{35}")),
    ("private-key", re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----")),
    ("gcp-service-account-key", re.compile(r'"private_key_id"\s*:\s*"([0-9a-f]{40})"')),
    ("github-token", re.compile(r"\b(?:ghp|gho|ghu|ghs|ghr)_[0-9A-Za-z]{36}\b|github_pat_[0-9A-Za-z_]{80,}")),
    ("slack-token", re.compile(r"xox[baprs]-[0-9A-Za-z-]{10,}")),
    ("stripe-key", re.compile(r"\b(?:sk|rk)_live_[0-9A-Za-z]{20,}")),
    ("razorpay-key", re.compile(r"\brzp_(?:live|test)_[0-9A-Za-z]{10,}")),
    ("openai-key", re.compile(r"\bsk-(?:proj-)?[0-9A-Za-z_\-]{32,}")),
    ("google-oauth-client-secret", re.compile(r"\bGOCSPX-[0-9A-Za-z_\-]{20,}")),
    ("facebook-access-token", re.compile(r"\bEAA[0-9A-Za-z]{80,}")),
    ("instagram-access-token", re.compile(r"\bIG[A-Z]{2}[0-9A-Za-z_\-]{100,}")),
    ("jwt", re.compile(r"\beyJ[0-9A-Za-z_\-]{10,}\.eyJ[0-9A-Za-z_\-]{10,}\.[0-9A-Za-z_\-]{10,}")),
    ("assigned-secret", re.compile(
        r"(?i)\b([A-Z0-9_]*(?:SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_?TOKEN|PRIVATE_?KEY|CLIENT_?SECRET|AUTH_?TOKEN)[A-Z0-9_]*)"
        r"\s*[:=]\s*['\"]?([0-9A-Za-z_\-/+.]{16,})['\"]?")),
]

# Values that are clearly placeholders / not secrets.
PLACEHOLDER = re.compile(
    r"(?i)(your|example|placeholder|xxxx|changeme|dummy|test[-_]|fake|<|\$\{|process\.env|"
    r"env\(|getenv|os\.environ|sanitize|undefined|null|true|false|redacted|\*\*\*)")


# Firebase client config: the Android API key ships inside every APK by design.
# It is not a secret; protect it with API + Android-app restrictions instead.
ALLOWLIST_PATHS = re.compile(r"(^|/)(google-services\.json|GoogleService-Info\.plist|firebase_options\.dart|main\.dart)$")


def last4(s):
    return "…" + s[-4:] if len(s) >= 4 else "…"


def scan_lines(lines, where):
    """lines: iterable of (file, commit, text). Yields findings."""
    seen = set()
    for file, commit, text in lines:
        if file and ALLOWLIST_PATHS.search(file):
            continue
        for rule, rx in RULES:
            for m in rx.finditer(text):
                value = m.group(m.lastindex) if m.lastindex else m.group(0)
                if rule == "assigned-secret":
                    if PLACEHOLDER.search(value) or PLACEHOLDER.search(text[max(0, m.start() - 5):m.end() + 5]):
                        continue
                    if re.fullmatch(r"[a-z_.]+", value):  # identifiers like some_variable_name
                        continue
                key = (rule, value)
                if key in seen:
                    continue
                seen.add(key)
                yield {"rule": rule, "file": file, "commit": commit, "last4": last4(value), "where": where}


def history_lines(repo):
    out = subprocess.run(
        ["git", "-C", repo, "log", "--all", "-p", "--no-color", "--no-ext-diff", "--format=@@@COMMIT %h"],
        capture_output=True, text=True, encoding="utf-8", errors="replace").stdout
    commit, file = None, None
    for line in out.splitlines():
        if line.startswith("@@@COMMIT "):
            commit = line.split()[1]
        elif line.startswith("+++ b/"):
            file = line[6:]
        elif line.startswith("+") and not line.startswith("+++"):
            yield file, commit, line[1:]


def staged_lines(repo):
    out = subprocess.run(["git", "-C", repo, "diff", "--cached", "-U0", "--no-color"],
                         capture_output=True, text=True, encoding="utf-8", errors="replace").stdout
    file = None
    for line in out.splitlines():
        if line.startswith("+++ b/"):
            file = line[6:]
        elif line.startswith("+") and not line.startswith("+++"):
            yield file, "STAGED", line[1:]


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "--staged"
    repo = sys.argv[2] if len(sys.argv) > 2 else "."
    src = history_lines(repo) if mode == "--history" else staged_lines(repo)
    findings = list(scan_lines(src, repo))
    for f in findings:
        print(f"{f['rule']:28} {f['last4']:8} {f['commit']:9} {f['file']}")
    if findings:
        print(f"\n{len(findings)} possible secret(s). Use placeholders like <GEMINI_API_KEY>.", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
