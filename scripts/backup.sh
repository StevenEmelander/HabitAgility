#!/usr/bin/env bash
# Backup the entire habit-tracker data via the per-item REST API.
#
# Layout (v0.5+):
#   /api/trend/sprint-summary       → list of all sprints
#   /api/sprint/:id                 → full sprint def
#   /api/entry/:dateKey             → one day's entry (or 404 if no row)
#
# The previous version of this script targeted /api/cycles and /api/entries,
# which were removed in the v0.5 refactor. This rewrite walks the summary list,
# fetches each full sprint, then iterates every date in each sprint's range.

set -euo pipefail

: "${UNLOCK_TOKEN:?Set UNLOCK_TOKEN}"
BASE_URL="${BASE_URL:-https://ght.vexom.io}"
OUT_DIR="$(cd "$(dirname "$0")/.." && pwd)/backups"
mkdir -p "$OUT_DIR"

command -v jq >/dev/null 2>&1 || { echo "jq is required" >&2; exit 1; }

htok=$(printf '%s' "$UNLOCK_TOKEN" | shasum -a 256 | awk '{print $1}')
stamp=$(date -u +%Y%m%d-%H%M%S)
file="$OUT_DIR/habit-tracker-$stamp.json"

fetch() {
  curl -fsS --cookie "htok=$htok" "$BASE_URL$1"
}

echo "Fetching /api/trend/sprint-summary ..."
summary=$(fetch /api/trend/sprint-summary)
sprint_ids=$(echo "$summary" | jq -r '.summaries[].sprintId')
count=$(echo "$summary" | jq '.summaries | length')
echo "  found $count sprint(s)"

echo "Fetching each /api/sprint/:id ..."
sprints_json='[]'
for id in $sprint_ids; do
  def=$(fetch "/api/sprint/$id")
  sprints_json=$(echo "$sprints_json" | jq --argjson d "$def" '. + [$d]')
done

echo "Fetching /api/entry/:dateKey for every covered date ..."
entries_json='{}'
entry_count=0
# Iterate each sprint's [startDate, endDate]; skip planning sprints (null dates).
ranges=$(echo "$sprints_json" | jq -r '.[] | select(.startDate != null and .endDate != null) | "\(.startDate) \(.endDate)"')
while IFS=' ' read -r start end; do
  [[ -z "${start:-}" ]] && continue
  cur="$start"
  while [[ "$cur" < "$end" || "$cur" == "$end" ]]; do
    if ! echo "$entries_json" | jq -e --arg dk "$cur" 'has($dk)' >/dev/null; then
      if e=$(fetch "/api/entry/$cur" 2>/dev/null); then
        has_values=$(echo "$e" | jq -r '.habitValuesById | length')
        if [[ "$has_values" -gt 0 ]]; then
          entries_json=$(echo "$entries_json" | jq --arg dk "$cur" --argjson v "$e" '. + {($dk): $v}')
          entry_count=$((entry_count + 1))
        fi
      fi
    fi
    # GNU date (Linux) vs BSD date (macOS).
    cur=$(date -u -d "$cur + 1 day" +%Y-%m-%d 2>/dev/null || date -u -j -f %Y-%m-%d "$cur" -v+1d +%Y-%m-%d)
  done
done <<< "$ranges"

jq -n \
  --arg stamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --argjson sprints "$sprints_json" \
  --argjson entries "$entries_json" \
  '{exportedAt: $stamp, schemaVersion: "0.6", sprints: $sprints, entries: $entries}' \
  > "$file"

echo ""
echo "Saved $file"
echo "  sprints: $count"
echo "  entries: $entry_count"
