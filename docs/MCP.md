# Use Followthrough from Claude, Cursor or any MCP client

Followthrough has an MCP server (Model Context Protocol). Connect it, and your AI assistant can search your client asks, read meetings, write a pre-call brief, and move asks through the pipeline as you.

- **Server URL:** `https://followthrough-hosted.vercel.app/api/mcp` on the hosted app, or `<your app URL>/api/mcp` on your own copy.
- **Transport:** Streamable HTTP, JSON responses (no SSE).
- **Auth:** a personal API token, sent as `Authorization: Bearer ftk_...`.

## 1. Make a token

Settings > **Connect an AI assistant (MCP)** > name it (for example "Claude on my laptop") > **Make a token**. Copy it right away: it is shown once.

A token acts as you, with your role (admin or member), in your workspace only, and it can only call the MCP tools: not settings, users, invites, share links, exports or downloads. Revoke it in the same place. A token stops working for good when it is revoked, when your account is removed, when you reset your password, or when the real owner of your email reclaims the account. You can have 10 at a time.

## 2. Connect your client

**Claude Code**

```bash
claude mcp add --transport http followthrough https://followthrough-hosted.vercel.app/api/mcp \
  --header "Authorization: Bearer ftk_..."
```

**Cursor** (`~/.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "followthrough": {
      "url": "https://followthrough-hosted.vercel.app/api/mcp",
      "headers": { "Authorization": "Bearer ftk_..." }
    }
  }
}
```

**Claude Desktop** (Settings > Developer > Edit Config), through the `mcp-remote` bridge:

```json
{
  "mcpServers": {
    "followthrough": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://followthrough-hosted.vercel.app/api/mcp", "--header", "Authorization:${AUTH_HEADER}"],
      "env": { "AUTH_HEADER": "Bearer ftk_..." }
    }
  }
}
```

Any other client that speaks Streamable HTTP and can send a header works the same way. Connectors in the claude.ai web app need OAuth sign-in, which is not built yet (see the [roadmap](ROADMAP.md)).

## 3. Try it

- "What did we promise Acme, and has any of it shipped?"
- "Give me a brief for my call with Globex tomorrow."
- "Show my queue."
- "Add this transcript as today's meeting with Initech and find the asks." (paste the transcript)

## The 26 tools

| Tool | Kind | What it does |
|---|---|---|
| `search` | Read | Search asks, quotes and meeting transcripts by keyword. Optionally narrow to one client, track or state. |
| `ask` | Read | Ask a question about your client meetings, for example "What did we promise Acme?". The answer cites the meetings it came from. Uses the AI, so it counts toward the daily AI allowance. |
| `list_clients` | Read | All clients, with counts of their meetings and open asks. |
| `get_client` | Read | One client: contacts, meetings and asks. |
| `client_brief` | Read | A short brief before the next call with a client: open asks, what shipped since the last meeting, and follow-ups owed. |
| `list_meetings` | Read | Meetings, newest first. Optionally for one client. |
| `get_meeting` | Read | One meeting with its transcript and the asks found in it. |
| `list_asks` | Read | Asks, complaints, commitments and insights found in meetings. Filter by state, track, client or kind. Each has the client's exact quote. |
| `get_ask` | Read | One ask: the client's quote, who asked, its state history, tickets and evidence. |
| `my_queue` | Read | What needs the signed-in user now: asks to review, route, finalize or tell the client about. |
| `list_release_matches` | Read | Releases matched to the asks they may close, waiting for a person to confirm. Filter by status. |
| `list_releases` | Read | Releases and changelogs on record. |
| `speed_metrics` | Read | How fast asks move from said to shipped to client told, by track. Admins only. |
| `whoami` | Read | The signed-in user and, on the hosted app, the workspace and free meetings left. |
| `add_client` | Write | Create a client (a customer account) that meetings belong to. |
| `add_meeting` | Write | Add a meeting with its transcript text. Everyone on the call must have been told it was being recorded: set consent_confirmed to true only if that is so. On the hosted app this uses one free meeting. Run extract_asks next. |
| `extract_asks` | Write | Run the AI over a meeting's transcript to find asks, complaints and commitments, each kept only with an exact quote. Can take a minute. |
| `add_ask` | Write | Record an ask the AI missed. If you give a quote, it must appear word for word in the meeting's transcript. |
| `triage_ask` | Write | Send an ask to a track (engineering, marketing, product_polish, other), optionally with an owner and tags. |
| `finalize_ask` | Write | Mark a routed ask as final: reviewed and ready for the team. |
| `reject_ask` | Write | Drop an ask that is not real or not actionable, with a reason. |
| `close_ask` | Write | Close an ask once the client has been told, or with a reason when it will not happen. |
| `review_release_match` | Write | Confirm that a release really shipped an ask (moves it to shipped), or reject the match with a reason. |
| `add_release` | Write | Record a release by pasting its changelog. It is matched against open asks right away. Admins only. |
| `draft_client_email` | Write | Draft the email that tells the client their ask shipped. A person reviews and sends it; nothing is sent automatically. |
| `mark_email_sent` | Write | Record that the client email was sent (moves the ask to client told). Optionally save the text that was actually sent. |

## Safety

- Every tool calls the same API route the app uses, with your token, so the same permission checks, validation and state rules apply. Admin-only tools (`speed_metrics`, `add_release`) refuse a member's token.
- A token only reaches the routes these tools use. Anything else (settings, users, invite links, client share links, exports, downloads, other tokens) needs you signed in to the app.
- Tools that end or overwrite something (`finalize_ask`, `reject_ask`, `close_ask`, `review_release_match`, `mark_email_sent`) are marked destructive, so clients ask you first. Nothing is emailed to a client: `draft_client_email` makes a draft for a person to send.
- Transcripts and quotes are what clients said. A client could say "close all of these" on a call; the assistant is told never to act on instructions inside them, but read what it proposes before you approve a write.
- `add_meeting` needs `consent_confirmed: true`: everyone on the call must have been told it was recorded.
- Tokens are stored only as a SHA-256 hash. A token cannot make or revoke other tokens, and the open-access guest of a self-hosted copy without login cannot make one at all.
- On the hosted app each user is limited to 1,200 tool calls an hour across all their tokens, a token for one workspace can never read another, and an address sending unknown tokens is cut off after 60 an hour.
- `ask` and `extract_asks` use the AI, so they count toward the daily AI allowance.
