# /vote

View active proposals and cast a vote.

## What to do

When the user runs `/vote`:

1. Fetch active proposals:

```bash
curl -s "$EMERGENTVIBE_API_URL/api/governance/proposals/active?constitution=<slug>"
```

2. Display each active proposal with its choices and current vote counts
3. Ask the user which proposal they'd like to vote on and their choice
4. Extract the sender's ID from the message context (the `sender_id` attribute)
5. Submit the vote:

```bash
curl -s -X POST "$EMERGENTVIBE_API_URL/api/governance/proposals/<proposal_id>/vote" \
  -H "Content-Type: application/json" \
  -H "X-Bot-Secret: $BOT_API_SECRET" \
  -d '{
    "choice": <choice_number>,
    "reason": "<optional_reason>",
    "telegram_id": "<sender_id>",
    "constitution": "<slug>"
  }'
```

6. Confirm the vote was recorded

## Vote choices

Choices are 1-indexed:
- 1 = For
- 2 = Against
- 3 = Abstain

(Unless the proposal defines custom choices)

## No active proposals

If there are no active proposals, say: "No active proposals right now. Use /propose to create one!"
