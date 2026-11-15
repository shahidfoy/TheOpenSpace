#!/usr/bin/env bash
# Applies the repository rulesets in .github/rulesets/ and the repo settings that go with them.
# Needs the GitHub CLI signed in as a repo admin:  gh auth login
# Safe to re-run: existing rulesets with the same name are updated in place.
set -euo pipefail

REPO="${1:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
cd "$(dirname "$0")/.."

echo "Repo settings for $REPO"
gh api -X PATCH "repos/$REPO" \
  -F allow_squash_merge=true -F allow_merge_commit=false -F allow_rebase_merge=false \
  -F delete_branch_on_merge=true -F allow_auto_merge=true \
  -f squash_merge_commit_title=PR_TITLE -f squash_merge_commit_message=PR_BODY \
  -F has_wiki=false >/dev/null

echo "Private vulnerability reporting"
gh api -X PUT "repos/$REPO/private-vulnerability-reporting" >/dev/null || echo "  (skipped: enable it under Settings > Code security)"

echo "Dependabot security updates"
gh api -X PUT "repos/$REPO/vulnerability-alerts" >/dev/null || true
gh api -X PUT "repos/$REPO/automated-security-fixes" >/dev/null || true

for f in .github/rulesets/*.json; do
  name="$(node -p "require('./$f').name")"
  id="$(gh api "repos/$REPO/rulesets" -q ".[] | select(.name == \"$name\") | .id")"
  if [ -n "$id" ]; then
    gh api -X PUT "repos/$REPO/rulesets/$id" --input "$f" >/dev/null && echo "Updated ruleset: $name"
  else
    gh api -X POST "repos/$REPO/rulesets" --input "$f" >/dev/null && echo "Created ruleset: $name"
  fi
done
echo "Done. Review them under Settings > Rules > Rulesets."
