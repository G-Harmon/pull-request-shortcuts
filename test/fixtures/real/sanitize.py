#!/usr/bin/env python3
"""Sanitize a browser-saved GitHub page into a committable fixture.

    python3 test/fixtures/real/sanitize.py "<saved page>.html" test/fixtures/real/<name>.html

Edit SUBS for the page at hand (people, org, hostname, file paths), most specific first.
The script also redacts CSRF tokens, nonces and hydro HMACs, removes GitHub's <script> tags
(they must not run against the fixture), drops `autofocus` (hidden-by-CSS forms would steal
focus in an unstyled fixture) and the web-app manifest link, and prepends a banner.
Afterwards grep the output for every real identifier and expect 0 hits before committing.
"""
import os
import re
import sys

# (real, replacement) — ordered, most specific first. Replace this table per capture.
SUBS = [
    # Hostname -> a placeholder. Use git.example.com for an Enterprise capture so it can't be
    # mistaken for github.com; the extension matches tab links by pathname only, and the
    # browser tests route both hosts.
    ("https://ghe.company.internal", "https://git.example.com"),
    ("2Fghe.company.internal", "2Fgit.example.com"),
    ("ghe.company.internal", "git.example.com"),
    # People and company domains.
    ("some.person@company.com", "someone@example.com"),
    ("company.com", "example.com"),
    # The author.
    ("first.last/path-in-repo.sh", "scripts/path-in-repo.sh"),
    ("first.last", "octocat"),
    ("first-last", "octocat"),
    ("First Last", "Octo Cat"),
    ("First", "Octo"),
    ("Last", "Cat"),
    # Org / repo and the browser's saved-assets folder.
    ("Org_repo_files/", "assets/"),
    ("Org/repo", "acme/sandbox"),
    ("Org", "Acme"),
    ("org", "acme"),
]

BANNER = """<!--
  REAL-PAGE FIXTURE: a GitHub page saved from a browser and sanitized (names, org, hostname,
  email, CSRF tokens and nonces replaced; GitHub's <script> tags and autofocus attributes
  removed; assets not included). Selectors here are what the extension saw in the wild on
  the day it was captured.
-->
"""


def sanitize(html: str) -> str:
    for real, fake in SUBS:
        html = html.replace(real, fake)

    # Session / CSRF material.
    html = re.sub(r'(name="authenticity_token"[^>]*?value=")[^"]*(")', r"\1REDACTED\2", html)
    html = re.sub(r'(value=")[^"]*("[^>]*name="authenticity_token")', r"\1REDACTED\2", html)
    html = re.sub(r'(data-csrf=")[^"]*(")', r"\1REDACTED\2", html)
    html = re.sub(r'(data-hydro-(?:click|view)-hmac=")[^"]*(")', r"\1REDACTED\2", html)
    for name in ["html-safe-nonce", "fetch-nonce", "request-id", "current-catalog-service-hash",
                 "visitor-payload", "visitor-hmac"]:
        html = re.sub(r'(<meta name="%s" content=")[^"]*(")' % name, r"\1REDACTED\2", html)
    html = re.sub(r'(<meta name="user-login" content=")[^"]*(")', r"\1octocat\2", html)

    # GitHub's JS must not run inside jsdom/Playwright; the extension is the thing under test.
    html = re.sub(r"<script\b[^>]*>.*?</script>", "", html, flags=re.S)
    html = re.sub(r'\sautofocus(?:="[^"]*")?', "", html)
    html = re.sub(r'<link[^>]*rel="manifest"[^>]*>', "", html)

    if "<!DOCTYPE html>" in html:
        return html.replace("<!DOCTYPE html>", "<!DOCTYPE html>\n" + BANNER, 1)
    return BANNER + html


def main() -> None:
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    src, dst = sys.argv[1], sys.argv[2]
    out = sanitize(open(src, encoding="utf-8").read())
    os.makedirs(os.path.dirname(dst) or ".", exist_ok=True)
    open(dst, "w", encoding="utf-8").write(out)
    print(f"wrote {dst} ({len(out)} bytes). Now grep it for every real identifier.")


if __name__ == "__main__":
    main()
