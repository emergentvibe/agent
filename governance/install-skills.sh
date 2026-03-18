#!/bin/bash
# Install governance skills into each group's .claude/skills/ directory
# Run after setup and after adding new skills

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILLS_DIR="$SCRIPT_DIR/skills"

for group in groups/*/; do
  if [ -d "$group" ]; then
    target="$group/.claude/skills/"
    mkdir -p "$target"
    cp -r "$SKILLS_DIR"/* "$target"
    echo "Installed skills → $target"
  fi
done
