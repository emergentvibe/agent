# /governance

Show active governance activity for this community.

## What to do

When the user runs `/governance`:

1. Fetch active proposals from the platform API:

```bash
curl -s "$EMERGENTVIBE_API_URL/api/governance/proposals/active?constitution=<slug>"
```

2. Display a summary of each active proposal:
   - Title
   - Type (amendment, policy, etc.)
   - Voting deadline (calculate from created_at + voting_period_seconds)
   - Current vote counts
3. Show link to the full governance page

## Example output

```
Active proposals for [Community Name]:

1. "Add quiet hours rule" — Policy Proposal
   Voting ends: Mar 25
   Votes: 12 for, 3 against

2. "Revise transparency principle" — Amendment
   Voting ends: Apr 1
   Votes: 8 for, 2 against

Vote with /vote | Propose with /propose
Full governance: https://emergentvibe.com/c/[slug]/governance
```

## No active proposals

If there are no active proposals, say so and encourage participation:
"No active proposals. Have an idea? Use /propose to start one!"
