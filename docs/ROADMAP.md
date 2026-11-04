# Roadmap

What comes next for Followthrough. Items are independent, so they can land in any order.

## Switch on more of what's built

These features exist in the code and work once the keys are set (when you run your own).

| Feature | What it needs | Status |
|---|---|---|
| Transcribing audio recordings (upload or the Recorder extension) | A Deepgram API key (`DEEPGRAM_API_KEY`) | Built. Without it, paste the transcript instead. |
| Matching GitHub releases to client asks, and raising GitHub issues | A GitHub read token plus release repo (`GITHUB_READ_TOKEN`, `RELEASE_REPO`), and a write token for issues (`GITHUB_WRITE_TOKEN`, `WRITABLE_REPOS`) | Built. Without it, paste the changelog on Confirm shipped. |

## Accounts and email

- **Connect an email sender** for the hosted app. Emails aren't verified yet and there is no password reset, because no sender is connected. Once one is (for example Resend), confirmation emails, password reset and teammate invites follow. [#24](https://github.com/avinashgaurav/followthrough/issues/24), [#12](https://github.com/avinashgaurav/followthrough/issues/12)
- **Sign-up protection:** CAPTCHA and a minimum password length of 8, set in Supabase > Authentication > Attack Protection.
- **Hosted mode hardening:** a guard against running hosted mode on a shared database, and protection against sign-in lockouts. [#22](https://github.com/avinashgaurav/followthrough/issues/22)

## Product

- UI for actions the API already supports: reopen a closed insight, add a contact, delete a meeting, add an insight by hand, re-run extraction, scope Ask to one client. [#17](https://github.com/avinashgaurav/followthrough/issues/17)
- Show today's AI spend against the daily budget in Settings. [#18](https://github.com/avinashgaurav/followthrough/issues/18)
