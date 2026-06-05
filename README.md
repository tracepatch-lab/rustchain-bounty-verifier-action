# RustChain Bounty Claim Verifier

GitHub Action that reads a bounty claim comment and posts a structured verification report for maintainers.

It is designed for RustChain-style GitHub bounty issues where contributors paste links, RTC wallets, GitHub proof, and article URLs.

## Checks

- Detects RTC wallet strings in the claim comment.
- Queries a RustChain node wallet endpoint: `/wallet/balance?miner_id=...`.
- Checks whether the claimant follows a target GitHub account, default `Scottcjn`.
- Counts how many repositories owned by that target account the claimant has starred.
- Checks live URLs from the claim comment and counts words for text/HTML pages.
- Searches for possible previous paid mentions for duplicate-claim review.
- Posts a markdown table back to the issue, or prints it in `dry-run` mode.

The bot does not execute payments. It only packages evidence so a human can approve or reject a payout faster.

## Example Workflow

```yaml
name: Verify bounty claims

on:
  issue_comment:
    types: [created]

permissions:
  issues: write
  contents: read

jobs:
  verify:
    if: contains(github.event.comment.body, 'Wallet:') || contains(github.event.comment.body, '/claim')
    runs-on: ubuntu-latest
    steps:
      - uses: tracepatch-lab/rustchain-bounty-verifier-action@main
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          rustchain-node-url: https://rustchain.org
          target-owner: Scottcjn
          dry-run: "false"
```

## Local Dry Run

Save an `issue_comment` webhook payload to `event.json`, then run:

```bash
GITHUB_EVENT_PATH=event.json \
GITHUB_REPOSITORY=Scottcjn/rustchain-bounties \
INPUT_GITHUB_TOKEN="$GITHUB_TOKEN" \
INPUT_DRY_RUN=true \
node src/index.js
```

## Example Output

```markdown
## Automated Verification for @contributor

| Check | Result |
|---|---|
| Follows @Scottcjn | Yes |
| Scottcjn repos starred | 12 found across 2 scanned page(s) |
| RTC wallets found | `RTC...` |
| Wallet RTC... | reachable, balance 2 RTC |
| Claim URLs found | 3 |
| URL https://example.com/article | live (200, 721 words) |
| Previous paid mentions | None found in quick search |
```

## Configuration

| Input | Default | Description |
|---|---|---|
| `github-token` | required | Token for GitHub API calls and optional issue comments. |
| `rustchain-node-url` | `https://rustchain.org` | RustChain node used for wallet checks. |
| `target-owner` | `Scottcjn` | Account used for follow/star verification. |
| `dry-run` | `true` | If true, prints report without posting. |
| `max-star-pages` | `10` | Max pages of starred repos to scan. |

## Milestones Covered for Bounty #747

- Star/follow verification.
- Wallet existence/balance check.
- Article/URL verification with word count.
- Duplicate claim hinting through previous paid-mention search.

Wallet for claim: `RTCa14a8b8553834f4593db826222424420bf6f8417`.
