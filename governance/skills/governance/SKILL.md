# /governance

Show active governance activity for this community.

## What to do

When the user runs `/governance`:

1. Fetch active proposals from the emergentvibe API:
   `GET /api/governance/proposals?constitution=[slug]&state=active`
2. Display a summary of each active proposal:
   - Title
   - Type (amendment, policy, etc.)
   - Voting deadline
   - Current vote counts if available
3. Show link to the full governance page:
   `https://emergentvibe.com/c/[slug]/governance`

## Example output

```
Active proposals:

1. "Add quiet hours rule" — Policy Proposal
   Voting ends: 2026-03-25
   Votes: 12 for, 3 against

2. "Revise transparency principle" — Constitutional Amendment
   Voting ends: 2026-04-01
   Votes: 8 for, 2 against

Full governance: https://emergentvibe.com/c/[slug]/governance
```

## No active proposals

If there are no active proposals, say so and link to the proposal creation page.
