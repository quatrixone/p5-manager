# Marketplace submissions: GitHub login, author-hosted files, automatic updates

Date: 2026-10-14

## What this is for

Today someone who wants to share a payload, homebrew app, input script or
Autoload template has to leave P5 Manager, sign in on GitHub in a browser
and submit a prefilled issue; the GitHub username typed in the app is a
local convenience, not an identity. Every submission — a brand new item and
a new version of an existing one alike — then waits for a maintainer to add
`store-accepted` by hand.

The user wants submissions to work from inside the app under the submitter's
own GitHub identity, wants to host nothing himself, and wants the routine
traffic to stop needing his attention. He also will not list games in his
catalog, for DMCA reasons.

Success: an author signs in once in the app, picks a local script, sequence
or binary, and publishes. A new version of something they already own appears
in the catalog without anyone approving it. A brand new item still waits for
the maintainer. No binary and no credential of the maintainer's is involved
at any point.

## Decisions taken with the user

- Login is the **GitHub device flow**: a public `client_id` shipped in the
  app, no client secret, no server to host. A **GitHub App** is preferred so
  the token is limited to repositories the app is installed on; an **OAuth
  App** with `public_repo` is the documented fallback if the device-flow
  token exchange for GitHub Apps turns out to need the secret.
- Binaries **stay with their author**: the app creates a release in the
  author's own GitHub repository and uploads the asset there. The catalog
  stores a URL, a SHA-256 and a size, exactly as it does now.
- The catalog repository is **`quatrixone/p5-marketplace`**. The app still
  reads `quatrixone/p5-manager` (`backend/src/lib/storeItem.js:22`), so
  switching it over is a prerequisite, not part of this feature.
- **Updates to an existing item by its verified owner are accepted
  automatically.** A new item still requires the maintainer's
  `store-accepted` label. This is where "no maintaining" lands: the routine
  traffic is new versions, and the judgement call is a new author.
- **No games.** The restriction is enforced by machine checks, not by a line
  in the README, and the app's FPKGi Catalog Hub drops its retail
  categories.
- The browser-based prefilled-issue path **stays** for people who do not want
  to give the app a token. The new flow is an addition, not a replacement.

## Architecture

Three parties; the maintainer hosts nothing:

```
user's P5 Manager            GitHub (author's account)      p5-marketplace
─────────────────            ─────────────────────────      ──────────────
device flow login   ───────►  user token (8 h)
publish: create release ───►  release + asset (binary)
                                      │ URL
submit issue (API, as user) ──────────┴──────────────────►  submission issue
                                                             │
                                                             ├─ owner's update → auto-commit
                                                             └─ new item → waits for the label
```

### `backend/src/lib/githubAuth.js` (new)

The only place that knows about GitHub identity. Deliberately small:

- `startDeviceLogin()` → `{ user_code, verification_uri, expires_in, interval }`
- `pollDeviceLogin(deviceCode)` → a token, or one of the device-flow states
- `currentUser()` → `{ login, id, avatar }` from `GET /user`
- `logout()`

The token is stored in `DATA_DIR/github-auth.json` with mode 600. It never
enters the catalog, the logs, an issue body, or `p5enc` — p5enc is for
hiding links in committed JSON and `store/README.md` already says it must
never carry credentials.

`GET /api/github/me` returns `{ login, id, scopes, expires_at }` and never
the token itself. The reason is not protection from the machine's owner, who
can read the file anyway, but that P5 Manager is typically reachable on the
whole LAN: anyone who opens it can already publish as the signed-in user, and
must not be able to carry the token away for other uses.

Choosing between GitHub App and OAuth App touches one constant and one
endpoint in this module; everything downstream works from "the app holds a
user token".

### Publish flow in the app

`Marketplace → Publish` (`frontend/src/components/Marketplace.jsx`,
`backend/src/routes/store.js`) gains a second branch. When the author
attaches a local file instead of a URL, the backend, using the author's
token: picks or creates a release in the author's repository, uploads the
asset, computes the SHA-256 locally, puts the resulting URL into the draft,
and opens the submission issue through the API.

Signed out, the existing prefilled-issue path is unchanged.

The sign-in UI states plainly that the token lives in `DATA_DIR`, is
available to anyone with access to this instance or its backups, and — with
the GitHub App variant — is limited to the repository the app is installed
on. It shows "signed in as X" and a sign-out button.

## Automation in p5-marketplace

A new `triage` job on `issues: [opened]` and a new `scripts/store-triage.mjs`.
The decision is a pure function so it can be tested without GitHub:

```
decideSubmission(item, old, user, state) → { action: 'auto' | 'review' | 'reject', reason }
```

- `old` does not exist → `review`: label `store-review`, a comment saying it
  is queued, exit 0. The maintainer's current path is untouched.
- `old` exists and `ownsStoreItem(old, user)` → `auto`. `user` comes from
  `github.event.issue.user`, never from the submitted JSON, exactly as
  `store-accept.mjs` does today.
- `old` exists and the submitter is not the owner → `reject`: comment and
  close. `prepareStoreSubmission` already throws 403 here; this only says it
  politely.

Four further conditions apply to the `auto` path. Failing one falls back to
`review` — never to publication:

1. **URL provenance.** Every URL in the item must be a release asset under
   the submitter's own account
   (`https://github.com/<login>/…/releases/download/…`), or be unchanged
   from the previous version. This covers the places a foreign URL would
   otherwise slip in: `download` steps inside template `steps`, and URLs
   inside script text. The parser rejects lookalike hosts
   (`github.com.evil.tld`), userinfo (`user@github.com`), and
   case-variant hostnames.
2. **Immutable fields.** `id`, `kind`, `builtin_id` and `owner.github_id`
   must not change. `version` is computed from the repository, not taken
   from the submission.
3. **Rate limit.** At most 5 automatic acceptances per account per 24 hours;
   above that, `review`.
4. **Freeze.** An item carrying `auto: false` never goes through
   automatically. This is the escape hatch for a popular item or an author
   who starts misbehaving.

On success the bot commits straight to `main` with
`store: … (auto-accept #<issue>)`, comments the commit URL on the issue and
closes it. No pull request: the push triggers the existing `check` job,
which revalidates every item and `index.json`.

### What this risks, and what absorbs it

The maintainer loses the chance to notice a malicious update to a popular
item. Three things absorb that: the app pins the SHA-256 of the version a
user installed, so an automatic acceptance cannot push anything onto anyone —
it only affects someone who actively presses Update; `auto-accept` in the
commit message makes the remedy one `git revert`; and GitHub notifies the
maintainer of every commit, which is awareness without work.

## No games

A game is already not representable: `kind` is one of `homebrew`, `payload`,
`script`, `template`. The real risk is a repackaged retail game submitted as
homebrew, so three machine checks:

- **Title id.** Reject `CUSA#####` and `PPSA#####`, the retail prefixes. The
  existing catalog entries (`APOL00004`, `CHTM00777`) do not match that
  shape, so the filter breaks nothing legitimate.
- **Size.** An absolute cap of 2 GB on homebrew and payload files; above it,
  `review`. On an automatic update, also a relative cap: a binary that grows
  more than 4× against the previous version goes to `review`. That is what an
  attempt to overwrite a legitimate homebrew item with a game looks like.
- **Changed URL.** When `files[].url` changes, provenance and size checks
  apply in full; an unchanged URL skips them, having nothing to verify.

Together with "a new item always goes through the maintainer's label", the
automation has no path by which a game enters the catalog.

Because no binary is hosted by the maintainer, a takedown against
`p5-marketplace` concerns a link and metadata: the answer is one `git revert`
plus `auto: false` on that item. Every link points at a release in its own
author's account, so a notice has an addressee who is not the maintainer.

### FPKGi Catalog Hub

`FPKGI_CATEGORIES` (`backend/src/lib/fpkgiCatalog.js:10`) keeps **Homebrew,
Applications and Emulators**. Games, Game updates, DLC, Demos, Themes, PS1,
PS2 and PSP are removed. `catalogPath()` derives the remaining paths as it
does now, `fpkgiCatalog.test.js:10` asserts the new count, and
`store/README.md` and the app's catalog documentation are updated to say the
browser lists homebrew, applications and emulators only.

User-supplied catalog sources (`POST /api/store/sources`) are out of scope
for this change and keep reading whatever they are pointed at. The UI must
keep naming the source an item came from, so a source a user added is never
mistaken for the reviewed catalog.

## Data model

One new optional field on a store item: `auto: false` to freeze automatic
acceptance (absent means automation is allowed). Nothing else —
`owner.github_id` in `p5-marketplace` already carries the identity.

## Error states

Device flow states are distinct and each gets its own message, never a
generic "login failed": `authorization_pending` (keep polling),
`slow_down` (lengthen the interval, or GitHub cuts us off),
`expired_token` (start again), `access_denied` (the user declined — stop
polling).

Publishing has three places that hurt, and none of them may lose work:

- The token expires mid-upload → the draft stays local and the app offers a
  new sign-in.
- The release already has an asset with that name → offer a new tag, or
  replacement after confirmation.
- The upload succeeds but opening the issue fails → the next attempt does not
  re-upload; it only submits the issue for the existing release.

GitHub rate limiting (403 with `x-ratelimit-remaining: 0`) reports the reset
time rather than failing silently.

## Testing

- Table-driven tests for `decideSubmission`: new item → review; owner's
  update → auto; non-owner → reject; changed `kind`/`id` → reject; foreign
  URL → review; over the rate limit → review; `auto: false` → review.
- Separate tests for the URL parser, including lookalike hosts, userinfo and
  case-variant hostnames, and URLs nested in template steps and script text.
- Title-id and size checks: `CUSA`/`PPSA` rejected, `APOL00004` accepted,
  over-cap and 4×-growth cases.
- `githubAuth` with `fetch` stubbed: all four device-flow states, the
  `slow_down` backoff, and an assertion that `/api/github/me` never returns
  the token.
- Extend the existing `backend/src/lib/storeOwnership.test.js`.
- An end-to-end workflow test is not practical. Instead `store-triage.mjs`
  must run locally against a saved issue body, the way `store-accept.mjs`
  does today.

## Order of work

1. Point the app at `p5-marketplace` (`storeItem.js:22`). Without this we
   would build a submission flow into a repository the app does not read.
2. FPKGi category removal. Small, self-contained, and it settles the
   no-games policy in the app.
3. The `triage` automation in `p5-marketplace`. Deployable on its own and it
   immediately removes the routine maintainer work.
4. Device flow plus in-app upload. The largest piece, and it depends on
   nothing above except (1).

## Open question to settle during implementation

Whether the GitHub device-flow token exchange works for a **GitHub App**
without a client secret. GitHub's documentation marks `client_secret`
required only for the web application flow and does not state it for the
device flow. Verify this live before committing to the GitHub App variant;
if it needs a secret, fall back to the OAuth App with `public_repo` and say
so in the sign-in UI, because that scope grants write access to all of the
user's public repositories.
