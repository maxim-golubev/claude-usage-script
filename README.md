# Claude Usage HUD

A userscript that shows your claude.ai usage limits in the page's top bar:
the 5-hour session, the weekly limit, and any per-model weekly limits, each
with the time until it resets.

```text
Session ▮▯▯▯▯▯ 2% ↻ 3h 4m  │  Weekly ▮▮▯▯▯▯ 33% ↻ 5d 19h  │  Fable ▯▯▯▯▯▯ 1% ↻ 5d 19h
```

- **Pace:** weekly bars carry a tick where even use would have you by now.
  Hover for how far over or under you are and how much is left per day.
- **Fits the space:** bars that do not fit fold into a `+N` badge with the
  rest in its tooltip. In a very narrow bar only the percentages remain.
- **Current:** it refreshes about a second after each reply finishes, when you
  come back to the tab, and every minute.
- **Private:** it reads one endpoint on `claude.ai` with the session you are
  already logged into. Nothing is sent anywhere else.

## Install

1. Install a userscript manager: [Userscripts](https://github.com/quoid/userscripts)
   for Safari, or [Tampermonkey](https://www.tampermonkey.net/) for Chrome,
   Firefox, and Edge.
2. Open [`claude-usage-hud.user.js`](https://raw.githubusercontent.com/maxim-golubev/claude-usage-script/main/claude-usage-hud.user.js)
   and let the manager install it, or paste its contents into a new script.
3. Reload [claude.ai](https://claude.ai).

## Built to survive redesigns

claude.ai changes its page structure often, and versions 1 and 2 of this
script broke each time: they looked for specific elements in the header, and a
redesign removed every one of them. Version 3 depends on as little of the page
as it can.

- **Placement is measured, not assumed.** The script finds the top bar, then
  measures where its buttons and text are and puts the HUD in the widest empty
  stretch. It needs no knowledge of what is in the bar. The same pass handles
  the home page, a chat, a collapsed sidebar, and a narrow window.
- **Finding the top bar has fallbacks.** A list of selectors, newest first,
  and every match must also be wide, short, and at the top of the page. If
  nothing matches, the HUD floats at the top of the page.
- **The data is read in three shapes.** The endpoint's current form (a
  `limits` list), its older form (`five_hour`, `seven_day`, …), and keys
  neither form knows about. Credit balances counted in money are left out.
- **Nothing on the page is patched.** Earlier versions wrapped `window.fetch`
  to notice a finished reply, which does nothing when the userscript manager
  runs the script in its own JavaScript world, as Safari's does. A
  `PerformanceObserver` sees the same request finish from either world.
- **One layout pass, run often.** It runs when the page changes and once a
  second, and it only touches the page when something is different. There is
  no per-case handling for navigation, re-renders, or resizes.
- **Failures degrade.** If a refresh fails, the last good numbers stay,
  dimmed. If the organisation cookie is missing or stale, the organisation is
  looked up from the account.

Tested on Safari with Userscripts against the claude.ai layout of October
2026.

## The endpoint

```
GET /api/organizations/{orgId}/usage
```

Undocumented, and it may change. The part the script uses today:

```json
{
  "limits": [
    { "kind": "session",       "group": "session", "percent": 2,  "resets_at": "2026-10-03T23:40:00Z", "scope": null },
    { "kind": "weekly_all",    "group": "weekly",  "percent": 33, "resets_at": "2026-10-09T16:00:00Z", "scope": null },
    { "kind": "weekly_scoped", "group": "weekly",  "percent": 1,  "resets_at": "2026-10-09T16:00:00Z",
      "scope": { "model": { "display_name": "Fable" }, "surface": null } }
  ],
  "five_hour": { "utilization": 2,  "resets_at": "2026-10-03T23:40:00Z" },
  "seven_day": { "utilization": 33, "resets_at": "2026-10-09T16:00:00Z" }
}
```

`{orgId}` comes from the `lastActiveOrg` cookie, or from
`GET /api/organizations` when the cookie is absent.

> Unofficial and not affiliated with Anthropic.

MIT License.
