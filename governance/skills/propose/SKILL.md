# /propose

Help a community member draft and submit a governance proposal.

## What to do

When the user runs `/propose [description]`:

1. Ask what they want to change (if not provided)
2. Help them articulate the change clearly — draft a title (10+ chars) and description (100+ chars)
3. Confirm the proposal with the user before submitting
4. Extract the sender's ID from the message context (the `sender_id` attribute)
5. Submit the proposal via the platform API:

```bash
curl -s -X POST "$EMERGENTVIBE_API_URL/api/governance/proposals" \
  -H "Content-Type: application/json" \
  -H "X-Bot-Secret: $BOT_API_SECRET" \
  -d '{
    "title": "<title>",
    "description": "<description>",
    "telegram_id": "<sender_id>",
    "constitution": "<slug>"
  }'
```

6. Share the result with the community — encourage discussion and voting

## Examples

- `/propose be more casual in responses` — help draft a behavioral rule change
- `/propose add a principle about data sovereignty` — help draft a principles amendment
- `/propose` (no args) — ask what they'd like to change

## Important

- You don't make changes to the constitution directly
- All changes go through the governance process (propose, deliberate, vote)
- Be encouraging — community participation is how this works
- The sender must be a registered member (auto-registration handles this)
