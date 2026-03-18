# /constitution

Show the current constitution status for this community.

## What to do

When the user runs `/constitution`:

1. Read the CLAUDE.md file in the current group directory
2. Extract the version, hash, and last updated date from the "Constitution (Principles)" section
3. Display a summary:
   - Constitution name and version
   - Last updated date
   - Content hash
   - Link to the full constitution on emergentvibe.com
4. Offer to show a summary of the key principles if asked

## Example output

```
Constitution: [Community Name]
Version: 0.1.5
Last updated: 2026-03-18
Hash: 18db508c...

Full text: https://emergentvibe.com/c/[slug]
```
