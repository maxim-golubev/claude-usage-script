// ==UserScript==
// @name        Claude Usage HUD
// @namespace   https://github.com/maxim-golubev/claude-usage-script
// @version     3.0.2
// @description Usage bars for claude.ai (session, weekly, per-model) with pace tracking
// @author      Maxim Golubev
// @match       https://claude.ai/*
// @icon        https://claude.ai/favicon.ico
// @grant       none
// @run-at      document-idle
// @homepageURL https://github.com/maxim-golubev/claude-usage-script
// @updateURL   https://raw.githubusercontent.com/maxim-golubev/claude-usage-script/main/claude-usage-hud.user.js
// @downloadURL https://raw.githubusercontent.com/maxim-golubev/claude-usage-script/main/claude-usage-hud.user.js
// ==/UserScript==

// claude.ai is redesigned often, and each redesign used to break this script.
// So it now depends on as little of the page as it can:
//
//   Placement  The HUD goes in the widest empty stretch of the top bar, found
//              by measuring where the buttons and text are, not by knowing the
//              bar's structure. The bar itself is found by a list of selectors
//              with a geometry check; with no bar at all the HUD floats at the
//              top of the page.
//   Data       The usage endpoint is read in its current shape (`limits`), in
//              its older shape (`five_hour`, `seven_day`, …), and for keys
//              neither knows about.
//   Refresh    Nothing is patched. A PerformanceObserver notices when a reply
//              finishes streaming, which works whether the userscript manager
//              runs this in the page or in an isolated world.
//   Upkeep     One idempotent layout pass runs on any page change and once a
//              second, so navigation, re-renders, and resizes need no special
//              handling: whatever happened, the next pass puts the HUD right.

(function () {
    'use strict';

    const VERSION = '3.0.2';

    const CONFIG = {
        POLL_MS: 60000,           // usage refresh while the tab is visible
        LAYOUT_MS: 1000,          // heartbeat for the layout pass
        MIN_REFRESH_GAP_MS: 5000, // floor between two usage requests
        STREAM_MS: 3000,          // an API request this long was a streamed reply
        EDGE_MARGIN: 10,          // px kept clear on each side of the HUD
        ORG_COOKIE: 'lastActiveOrg',
    };

    // Where the top bar has been, newest first. Each match must also look like
    // a top bar (see findHeader), so a wrong selector costs nothing.
    const HEADER_SELECTORS = [
        '[data-testid="chat-header"]',
        '.dframe-header',
        '[class*="incognito-header"]',   // an incognito chat's black bar, before its first message
        'header[data-testid="page-header"]',
        'main header',
        'header',
        '[role="banner"]',
    ];

    const SIDEBAR_SELECTORS = ['[data-testid="sidebar"]', 'aside[aria-label="Sidebar"]', 'nav'];

    // Things a visitor can click or read. Their boxes are what the HUD avoids.
    const OCCUPANTS = 'button, a[href], input, select, textarea, [role="button"], [role="radio"], [role="tab"], [role="switch"], [role="combobox"]';

    // Older response shape: one key per limit.
    const LEGACY_KEYS = [
        { key: 'five_hour',            label: 'Session', windowDays: 0 },
        { key: 'seven_day',            label: 'Weekly',  windowDays: 7 },
        { key: 'seven_day_sonnet',     label: 'Sonnet',  windowDays: 7 },
        { key: 'seven_day_opus',       label: 'Opus',    windowDays: 7 },
        { key: 'seven_day_oauth_apps', label: 'OAuth',   windowDays: 7 },
        { key: 'seven_day_cowork',     label: 'Cowork',  windowDays: 7 },
    ];

    // Colours come from the page (currentColor) so both themes work unchanged.
    const STYLES = `
        .cuh {
            position: absolute; top: 0; left: 0; z-index: 2;
            display: flex; align-items: center; gap: 6px;
            width: max-content; box-sizing: border-box;
            font: 500 12px/1 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            color: inherit; white-space: nowrap; user-select: none;
            pointer-events: none;
        }
        .cuh[data-floating] { position: fixed; z-index: 10; }
        .cuh[data-hidden] { visibility: hidden; }
        .cuh[data-stale] > * { opacity: 0.5; }
        .cuh > * { pointer-events: auto; }

        .cuh-bar, .cuh-more { position: relative; padding: 6px 8px; border-radius: 6px; cursor: default; }
        .cuh-bar:hover, .cuh-more:hover { background: rgba(127, 127, 127, 0.14); }

        /* A bar's text shares one baseline whatever its size, and the track
           hangs off that baseline too (an empty flex item's baseline is its
           bottom edge), centred on the height of the digits. So nothing here
           depends on how a browser rounds a line box. */
        .cuh-bar { display: flex; align-items: baseline; gap: 8px; }
        /* Mostly lowercase, so it sits low against the track; half a pixel up
           puts its weight on the track's centre line. */
        .cuh-label { position: relative; top: -0.5px; opacity: 0.75; }
        .cuh-pct { opacity: 0.65; font-variant-numeric: tabular-nums; }
        .cuh-reset { opacity: 0.45; font-size: 11px; font-weight: 400; }
        .cuh-more-text { opacity: 0.65; font-size: 11px; }
        .cuh-sep { width: 1px; height: 14px; background: rgba(127, 127, 127, 0.3); pointer-events: none; }

        .cuh-track { position: relative; top: -1px; width: 60px; height: 6px; border-radius: 3px; background: rgba(127, 127, 127, 0.25); }
        .cuh-fill { position: absolute; inset: 0; border-radius: 3px; background: currentColor; opacity: 0.4; }
        .cuh-tick { position: absolute; top: -3px; bottom: -3px; width: 2px; margin-left: -1px; border-radius: 1px; background: currentColor; opacity: 0.4; }
        .cuh-tick[data-ahead] { background: #d4820a; opacity: 0.9; }

        .cuh-bar:hover .cuh-label, .cuh-bar:hover .cuh-pct, .cuh-bar:hover .cuh-reset, .cuh-bar:hover .cuh-fill { opacity: 1; }
        .cuh-bar[data-level="low"]:hover      { color: #22a34a; }
        .cuh-bar[data-level="medium"]:hover   { color: #7cb32e; }
        .cuh-bar[data-level="elevated"]:hover { color: #b8a018; }
        .cuh-bar[data-level="high"]:hover     { color: #d4820a; }
        .cuh-bar[data-level="critical"]:hover { color: #d43a0a; }

        .cuh-tip {
            display: none; position: absolute; top: calc(100% + 4px); left: 50%; transform: translateX(-50%);
            padding: 6px 10px; border-radius: 6px; z-index: 1000; pointer-events: none;
            background: #2d2a27; color: #e8e2d9; border: 1px solid rgba(255, 255, 255, 0.1);
            font-size: 11px; font-weight: 400; line-height: 1.5;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
        }
        .cuh-more .cuh-tip { left: auto; right: 0; transform: none; }
        .cuh-bar:hover .cuh-tip:not(:empty), .cuh-more:hover .cuh-tip:not(:empty) { display: block; }
        .cuh-error { opacity: 0.6; font-size: 11px; padding: 6px 8px; }
    `;

    const state = {
        bars: [],          // [{ key, label, usage, resetAt, windowDays }]
        loaded: false,
        failures: 0,
        lastFetch: 0,
        fetching: false,
        refreshTimer: null,
        orgId: null,
        hud: null,
        contentKey: '',    // what the HUD's children were built from
        widths: [],        // each bar's width, measured when built
        moreWidth: 0,
        layoutQueued: false,
    };

    // ---------------------------------------------------------------- helpers

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    }

    function getCookie(name) {
        const match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]+)'));
        return match ? decodeURIComponent(match[1]) : null;
    }

    function timeUntil(iso) {
        if (!iso) return '';
        const ms = new Date(iso) - Date.now();
        if (isNaN(ms)) return '';
        if (ms <= 0) return 'now';
        const hours = Math.floor(ms / 3600000);
        const minutes = Math.floor((ms % 3600000) / 60000);
        if (hours > 24) {
            const rem = hours % 24;
            return `${Math.floor(hours / 24)}d${rem ? ` ${rem}h` : ''}`;
        }
        return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
    }

    function usageLevel(pct) {
        if (pct >= 90) return 'critical';
        if (pct >= 70) return 'high';
        if (pct >= 50) return 'elevated';
        if (pct >= 30) return 'medium';
        return 'low';
    }

    function toPercent(value) {
        if (typeof value !== 'number' || isNaN(value)) return null;
        return Math.max(0, Math.min(100, Math.round(value)));
    }

    function titleCase(key) {
        const words = String(key).replace(/_/g, ' ').trim();
        return words ? words[0].toUpperCase() + words.slice(1) : 'Limit';
    }

    /** Where even use would have a weekly bar by now, and what is left per day. */
    function pace(bar) {
        if (!bar.windowDays || bar.usage <= 0 || !bar.resetAt) return null;
        const day = 86400000;
        const reset = new Date(bar.resetAt).getTime();
        if (isNaN(reset)) return null;
        const daysLeft = Math.max(0, (reset - Date.now()) / day);
        const ideal = Math.max(0, Math.min(100, ((bar.windowDays - daysLeft) / bar.windowDays) * 100));
        return {
            ideal: Math.round(ideal),
            dailyBudget: daysLeft > 0 ? Math.round(((100 - bar.usage) / daysLeft) * 10) / 10 : 0,
            ahead: bar.usage > ideal,
        };
    }

    // ------------------------------------------------------------------- data

    /** Turn any known shape of the usage response into bars. Never throws. */
    function parseUsage(data) {
        if (!data || typeof data !== 'object') return [];
        const bars = [];
        const seen = new Set();
        const add = (key, label, usage, resetAt, windowDays) => {
            if (usage == null || seen.has(key)) return;
            seen.add(key);
            bars.push({ key, label, usage, resetAt: resetAt || null, windowDays });
        };

        // Current shape: a list of limits, each with a kind and an optional scope.
        if (Array.isArray(data.limits)) {
            for (const limit of data.limits) {
                if (!limit || typeof limit !== 'object') continue;
                const scope = limit.scope && typeof limit.scope === 'object' ? limit.scope : {};
                const scopeName = [scope.model, scope.surface]
                    .map(s => (s && typeof s === 'object' ? s.display_name || s.name || s.id : s))
                    .find(s => typeof s === 'string' && s);
                const weekly = limit.group === 'weekly' || /week|seven_day/.test(limit.kind || '');
                let label;
                if (limit.kind === 'session') label = 'Session';
                else if (limit.kind === 'weekly_all') label = 'Weekly';
                else label = scopeName || titleCase(limit.kind || 'limit');
                add(`${limit.kind}:${scopeName || ''}`, label, toPercent(limit.percent), limit.resets_at, weekly ? 7 : 0);
            }
            if (bars.length) return bars;
        }

        // Older shape: one object per key. Entries counted in money are credit
        // balances, not rate limits, and are left out.
        const isLimit = v => v && typeof v === 'object' && typeof v.utilization === 'number' && v.limit_dollars == null;
        for (const def of LEGACY_KEYS) {
            const entry = data[def.key];
            if (isLimit(entry)) add(def.key, def.label, toPercent(entry.utilization), entry.resets_at, def.windowDays);
        }
        for (const [key, entry] of Object.entries(data)) {
            if (!isLimit(entry) || !entry.resets_at || key === 'extra_usage') continue;
            const weekly = key.startsWith('seven_day');
            add(key, titleCase(key.replace(/^seven_day_?/, '') || key), toPercent(entry.utilization), entry.resets_at, weekly ? 7 : 0);
        }
        return bars;
    }

    async function getJSON(url) {
        const response = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } });
        if (!response.ok) {
            const error = new Error(`HTTP ${response.status}`);
            error.status = response.status;
            throw error;
        }
        return response.json();
    }

    /** The active organisation: the site's cookie, or else the account's first. */
    async function resolveOrg(lookUp) {
        if (!lookUp) {
            const fromCookie = getCookie(CONFIG.ORG_COOKIE);
            if (fromCookie) return fromCookie;
            if (state.orgId) return state.orgId;
        }
        const orgs = await getJSON('/api/organizations');
        const org = Array.isArray(orgs) ? orgs.find(o => o && o.uuid) : null;
        if (!org) throw new Error('No organization found');
        state.orgId = org.uuid;
        return org.uuid;
    }

    async function fetchBars() {
        const usageOf = org => getJSON(`/api/organizations/${encodeURIComponent(org)}/usage`);
        const org = await resolveOrg(false);
        try {
            return parseUsage(await usageOf(org));
        } catch (error) {
            // A stale cookie points at an organisation this login cannot read.
            if (error.status !== 403 && error.status !== 404) throw error;
            const other = await resolveOrg(true);
            if (other === org) throw error;
            return parseUsage(await usageOf(other));
        }
    }

    async function refresh() {
        if (state.fetching) return;
        state.fetching = true;
        state.lastFetch = Date.now();
        try {
            state.bars = await fetchBars();
            state.loaded = true;
            state.failures = 0;
        } catch (error) {
            // Keep showing the last good numbers, dimmed, rather than nothing.
            state.failures += 1;
            console.warn('[Claude Usage HUD] usage request failed:', error.message);
        } finally {
            state.fetching = false;
        }
        layout();
    }

    /** Refresh soon, but never more often than MIN_REFRESH_GAP_MS. */
    function refreshSoon(delay) {
        if (state.refreshTimer) return;
        const wait = Math.max(delay, state.lastFetch + CONFIG.MIN_REFRESH_GAP_MS - Date.now());
        state.refreshTimer = setTimeout(() => {
            state.refreshTimer = null;
            refresh();
        }, wait);
    }

    // -------------------------------------------------------------- rendering

    function barTooltip(bar) {
        const p = pace(bar);
        if (!p) return [];
        const delta = Math.abs(bar.usage - p.ideal);
        const status = p.ahead ? `⚠ ${delta}% over pace` : (delta > 0 ? `✓ ${delta}% under pace` : '✓ On pace');
        return [status, `Budget: ~${p.dailyBudget}%/day remaining`, `On track up to: ${p.ideal}%`];
    }

    function buildBar(bar) {
        const node = el('div', 'cuh-bar');
        node.dataset.level = usageLevel(bar.usage);
        node.append(el('span', 'cuh-label', bar.label));

        const track = el('span', 'cuh-track');
        const fill = el('span', 'cuh-fill');
        // Clipped, not sized: the fill is the whole track with its right side
        // cut away, so a sliver of 1% still follows the track's rounded end.
        fill.style.clipPath = `inset(0 ${100 - bar.usage}% 0 0 round 3px)`;
        track.append(fill);
        const p = pace(bar);
        if (p) {
            const tick = el('span', 'cuh-tick');
            tick.style.left = `clamp(1px, ${p.ideal}%, calc(100% - 1px))`;   // never off either end
            if (p.ahead) tick.dataset.ahead = '';
            track.append(tick);
        }
        node.append(track, el('span', 'cuh-pct', `${bar.usage}%`));

        const left = timeUntil(bar.resetAt);
        if (left) node.append(el('span', 'cuh-reset', `↻ ${left}`));

        const tip = el('div', 'cuh-tip');
        for (const line of barTooltip(bar)) tip.append(el('div', '', line));
        node.append(tip);
        return node;
    }

    /** One line per bar, for the "+N" badge's tooltip. */
    function summaryLine(bar) {
        const left = timeUntil(bar.resetAt);
        const p = pace(bar);
        return `${bar.label}: ${bar.usage}%${left ? ` · ↻ ${left}` : ''}${p ? ` · on track ≤${p.ideal}%` : ''}`;
    }

    /**
     * Rebuild the HUD's children, but only when what they show has changed.
     * Leaves every bar in place and measured; fit() decides which are shown.
     */
    function build(hud) {
        const key = !state.loaded
            ? ''
            : JSON.stringify([state.bars.map(b => [b.key, b.label, b.usage, timeUntil(b.resetAt), pace(b)]), state.failures > 2]);
        if (key === state.contentKey && hud.childElementCount) return;
        state.contentKey = key;

        hud.replaceChildren();
        if (state.failures > 2) hud.dataset.stale = ''; else delete hud.dataset.stale;
        hud.title = state.failures > 2 ? 'Usage could not be refreshed; showing the last known values' : '';

        if (!state.bars.length) {
            hud.append(el('span', 'cuh-error', state.loaded ? 'No usage limits reported' : 'Usage unavailable'));
            state.widths = [];
            return;
        }
        state.bars.forEach((bar, i) => {
            if (i > 0) hud.append(el('span', 'cuh-sep'));
            hud.append(buildBar(bar));
        });
        const more = el('div', 'cuh-more');
        more.append(el('span', 'cuh-more-text', '+0'), el('div', 'cuh-tip'));
        hud.append(more);

        state.widths = [...hud.querySelectorAll('.cuh-bar')].map(b => b.offsetWidth);
        state.moreWidth = more.offsetWidth + 24;   // room for "33% · 100%"
    }

    /** Show as many bars as fit in `available` px; fold the rest into the badge. */
    function fit(hud, available) {
        const bars = [...hud.querySelectorAll('.cuh-bar')];
        if (!bars.length) return hud.offsetWidth <= available;
        const seps = [...hud.querySelectorAll('.cuh-sep')];
        const more = hud.querySelector('.cuh-more');
        const gap = 6, sep = 1 + 2 * gap;

        let used = 0, count = 0;
        for (let i = 0; i < bars.length; i++) {
            const need = state.widths[i] + (i > 0 ? sep : 0);
            const badge = i < bars.length - 1 ? state.moreWidth + gap : 0;
            if (used + need + badge > available) break;
            used += need;
            count++;
        }

        bars.forEach((b, i) => { b.style.display = i < count ? '' : 'none'; });
        seps.forEach((s, i) => { s.style.display = i + 1 < count ? '' : 'none'; });

        const hidden = state.bars.slice(count);
        more.style.display = hidden.length ? '' : 'none';
        if (hidden.length) {
            // With no room for a single bar, the badge carries the numbers itself.
            const text = count > 0 ? `+${hidden.length}` : state.bars.slice(0, 2).map(b => `${b.usage}%`).join(' · ');
            const label = more.querySelector('.cuh-more-text');
            if (label.textContent !== text) label.textContent = text;
            const tip = more.querySelector('.cuh-tip');
            const lines = hidden.map(summaryLine);
            if (tip.dataset.key !== lines.join('\n')) {
                tip.dataset.key = lines.join('\n');
                tip.replaceChildren(...lines.map(line => el('div', '', line)));
            }
        }
        return count > 0 || state.moreWidth <= available;
    }

    // -------------------------------------------------------------- placement

    function isVisible(rect) {
        return rect.width > 1 && rect.height > 1;
    }

    /** The page's top bar, or null. Must be wide, short, and at the top. */
    function findHeader() {
        for (const selector of HEADER_SELECTORS) {
            let nodes;
            try { nodes = document.querySelectorAll(selector); } catch (e) { continue; }
            for (const node of nodes) {
                const r = node.getBoundingClientRect();
                if (r.width >= 240 && r.height >= 28 && r.height <= 96 && r.top >= -4 && r.top < 80) return node;
            }
        }
        return null;
    }

    /**
     * The widest empty horizontal stretch of the bar: [left, right] in viewport
     * px. "Empty" means no text in the bar and no control over it, including a
     * sidebar's (its toggle sits on top of the bar when the sidebar is closed).
     */
    function widestGap(header, hud) {
        const hr = header.getBoundingClientRect();
        const style = getComputedStyle(header);
        const lo = hr.left + (parseFloat(style.paddingLeft) || 0);
        const hi = hr.right - (parseFloat(style.paddingRight) || 0);

        const taken = [];
        const note = r => {
            if (!isVisible(r) || r.bottom <= hr.top + 2 || r.top >= hr.bottom - 2) return;
            if (r.right <= lo || r.left >= hi) return;
            taken.push([r.left, r.right]);
        };
        const roots = [header, ...document.querySelectorAll(SIDEBAR_SELECTORS.join(','))];
        for (const root of roots) {
            for (const node of root.querySelectorAll(OCCUPANTS)) {
                if (!hud.contains(node)) note(node.getBoundingClientRect());
            }
        }
        const walker = document.createTreeWalker(header, NodeFilter.SHOW_TEXT);
        const range = document.createRange();
        for (let text = walker.nextNode(); text; text = walker.nextNode()) {
            if (!text.nodeValue.trim() || hud.contains(text)) continue;
            range.selectNodeContents(text);
            note(range.getBoundingClientRect());
        }

        taken.sort((a, b) => a[0] - b[0]);
        let best = [lo, lo], cursor = lo;
        for (const [left, right] of taken) {
            if (left - cursor > best[1] - best[0]) best = [cursor, left];
            cursor = Math.max(cursor, right);
        }
        if (hi - cursor > best[1] - best[0]) best = [cursor, hi];
        return { left: best[0], right: best[1], top: hr.top, height: hr.height };
    }

    /** With no top bar: the strip beside the sidebar, at the top of the page. */
    function fallbackGap() {
        let left = 0;
        for (const selector of SIDEBAR_SELECTORS) {
            const node = document.querySelector(selector);
            const r = node && node.getBoundingClientRect();
            if (r && r.left < 40 && r.height > 200) { left = r.right; break; }
        }
        return { left: left + 48, right: window.innerWidth - 120, top: 0, height: 48 };
    }

    /** The text colour of whatever is under the HUD's left end, or '' to inherit. */
    function colourBeneath(hud) {
        const r = hud.getBoundingClientRect();
        if (!isVisible(r)) return '';
        const x = Math.min(Math.max(r.left + 4, 0), window.innerWidth - 1);
        const y = Math.min(Math.max(r.top + r.height / 2, 0), window.innerHeight - 1);
        for (const node of document.elementsFromPoint(x, y)) {
            if (!hud.contains(node)) return getComputedStyle(node).color;
        }
        return '';
    }

    function setStyle(node, prop, value) {
        if (node.style[prop] !== value) node.style[prop] = value;
    }

    /**
     * Put the HUD where it belongs for the page as it is right now. Safe to
     * call at any time and any number of times.
     */
    function layout() {
        state.layoutQueued = false;
        if (!state.loaded && state.failures < 3) return;   // nothing to show yet
        if (!document.body) return;

        const hud = state.hud || (state.hud = el('div', 'cuh'));
        const header = findHeader();

        // Inside the bar when it can hold a positioned child (so the page's own
        // dialogs and menus stack above the HUD); otherwise floating over it.
        const inHeader = !!header && getComputedStyle(header).position !== 'static';
        const parent = inHeader ? header : document.body;
        if (hud.parentElement !== parent) parent.append(hud);
        if (inHeader) delete hud.dataset.floating; else hud.dataset.floating = '';

        build(hud);
        // In a bar the HUD takes the bar's text colour. Floating, it would take the
        // page's, which can be the wrong one for what is behind it (an incognito
        // chat's black bar has white text): take the colour of what it sits on.
        setStyle(hud, 'color', inHeader ? '' : colourBeneath(hud));

        const gap = header ? widestGap(header, hud) : fallbackGap();
        const available = gap.right - gap.left - 2 * CONFIG.EDGE_MARGIN;
        const fits = fit(hud, available);
        if (fits) delete hud.dataset.hidden; else hud.dataset.hidden = '';

        const origin = inHeader ? header.getBoundingClientRect() : { left: 0, top: 0 };
        const border = inHeader ? header.clientLeft : 0;
        setStyle(hud, 'left', `${Math.round(gap.left + CONFIG.EDGE_MARGIN - origin.left - border)}px`);
        setStyle(hud, 'top', `${Math.round(gap.top - origin.top - (inHeader ? header.clientTop : 0))}px`);
        setStyle(hud, 'height', `${Math.round(gap.height)}px`);
    }

    function queueLayout() {
        if (state.layoutQueued) return;
        state.layoutQueued = true;
        setTimeout(layout, 200);
    }

    // ------------------------------------------------------------------ setup

    function watchPage() {
        // Any change to the page that is not our own.
        new MutationObserver(records => {
            const hud = state.hud;
            if (records.some(r => !hud || !hud.contains(r.target))) queueLayout();
        }).observe(document.documentElement, { childList: true, subtree: true });

        window.addEventListener('resize', queueLayout);
        // A hidden tab skips the heartbeat; catch up the moment it is shown.
        document.addEventListener('visibilitychange', () => { if (!document.hidden) layout(); });
        setInterval(() => { if (!document.hidden) layout(); }, CONFIG.LAYOUT_MS);
    }

    function watchUsage() {
        setInterval(() => { if (!document.hidden) refresh(); }, CONFIG.POLL_MS);
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden && Date.now() - state.lastFetch > 15000) refresh();
        });

        // A reply that has just finished streaming has just used some quota.
        // Its request shows up here when the stream ends, by name or by length.
        try {
            new PerformanceObserver(list => {
                for (const entry of list.getEntries()) {
                    let url;
                    try { url = new URL(entry.name); } catch (e) { continue; }
                    if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) continue;
                    if (url.pathname.endsWith('/usage')) continue;
                    if (/completion/.test(url.pathname) || entry.duration >= CONFIG.STREAM_MS) refreshSoon(1000);
                }
            }).observe({ type: 'resource', buffered: false });
        } catch (e) { /* no resource timing: the poll still runs */ }
    }

    function init() {
        // The marker is on the document, so a second copy sees it even when the
        // two run in different JavaScript worlds.
        const root = document.documentElement;
        if (root.dataset.claudeUsageHud) return;
        root.dataset.claudeUsageHud = VERSION;

        const style = el('style');
        style.id = 'cuh-styles';
        style.textContent = STYLES;
        document.head.append(style);

        watchPage();
        watchUsage();
        refresh();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
