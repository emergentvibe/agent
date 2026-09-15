import {
  getToday,
  TELEGRAM_BOT_USERNAME,
  getShiftsTopicLink,
} from '../config.js';
import type { RotaAssignment } from '../rota-db.js';
import {
  rotaGetByDate,
  rotaGetByTelegramId,
  rotaGetOpenSlots,
} from '../rota-db.js';
import { CSS } from './styles.js';
import {
  getTodaySchedule,
  getFullWeekSchedule,
  formatDate,
  type DaySchedule,
  type ScheduleEvent,
} from './schedule.js';
import { getCachedUpdates, getCacheAge } from './schedule-refresh.js';

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function shell(
  title: string,
  body: string,
  activeTab: string,
  openCount: number,
): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)} — TREEWEEK III</title>
  <style>${CSS}</style>
</head>
<body>
  <div class="page">
    ${body}
  </div>
  ${nav(activeTab, openCount)}
</body>
</html>`;
}

function nav(active: string, openCount: number): string {
  const tabs = [
    { href: '/', label: 'Today', key: 'today' },
    { href: '/my-shifts', label: 'My Shifts', key: 'my-shifts' },
    { href: '/help', label: 'Help Needed', key: 'help' },
    { href: '/week', label: 'The Week', key: 'week' },
  ];
  const links = tabs
    .map((t) => {
      const cls = t.key === active ? ' class="active"' : '';
      const badge =
        t.key === 'help' && openCount > 0
          ? `<span class="badge">${openCount}</span>`
          : '';
      return `<a href="${t.href}"${cls}>${esc(t.label)}${badge}</a>`;
    })
    .join('');
  return `<nav class="bottom-nav">${links}</nav>`;
}

function header(today: string): string {
  const schedule = getTodaySchedule(today);
  const dayLabel = schedule
    ? `Day ${schedule.dayNumber} · ${schedule.dayName}`
    : formatDate(today);
  return `<div class="header">
    <h1>TREEWEEK III</h1>
    <span class="day-label">${esc(dayLabel)}</span>
  </div>`;
}

function heroCard(telegramId: string | null): string {
  if (!telegramId) {
    return connectCard();
  }

  const today = getToday();
  const now = new Date();
  const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const shifts = rotaGetByTelegramId(telegramId);

  const upcoming = shifts.filter((s) => {
    if (s.date > today) return true;
    if (s.date === today && s.end > currentTime) return true;
    return false;
  });

  if (upcoming.length === 0) {
    return `<div class="hero-card">
      <div class="done-message">No more shifts</div>
      <div class="done-sub">You're done! Want to help?</div>
      <a href="/help" class="btn btn-outline">Help out</a>
    </div>`;
  }

  const next = upcoming[0];
  const isToday = next.date === today;
  const coworkers = getCoworkers(next);

  let countdown = '';
  if (isToday) {
    const [h, m] = next.start.split(':').map(Number);
    const shiftStart = new Date(now);
    shiftStart.setHours(h, m, 0, 0);
    const diff = shiftStart.getTime() - now.getTime();
    if (diff > 0) {
      const hrs = Math.floor(diff / 3600000);
      const mins = Math.floor((diff % 3600000) / 60000);
      countdown = hrs > 0 ? `starts in ${hrs}h ${mins}m` : `starts in ${mins}m`;
    } else {
      countdown = 'happening now';
    }
  }

  const dateDisplay = isToday
    ? ''
    : `<div class="shift-date">${esc(formatDate(next.date))}</div>`;
  const countdownHtml = countdown
    ? `<div class="countdown">${esc(countdown)}</div>`
    : '';
  const coworkerHtml =
    coworkers.length > 0
      ? `<div class="coworkers">with: ${esc(coworkers.join(', '))}</div>`
      : '';

  return `<div class="hero-card">
    <div class="label">Your next shift</div>
    <div class="shift-name">${esc(next.block_label)}</div>
    <div class="shift-time">${esc(next.start)}–${esc(next.end)}</div>
    ${dateDisplay}
    ${countdownHtml}
    ${coworkerHtml}
    <a href="https://t.me/${esc(TELEGRAM_BOT_USERNAME)}?start=cover" class="btn btn-fire">Can't make it</a>
  </div>`;
}

function connectCard(): string {
  return `<div class="connect-card">
    <p>Connect with Telegram to see your shifts</p>
    <a href="https://t.me/${esc(TELEGRAM_BOT_USERNAME)}?start=link" class="btn btn-telegram" id="connect-btn">Connect with Telegram</a>
    <script>
      (function() {
        var token = document.cookie.match(/tw_token=([a-f0-9]+)/);
        if (token) {
          var btn = document.getElementById('connect-btn');
          btn.href = 'https://t.me/${esc(TELEGRAM_BOT_USERNAME)}?start=link_' + token[1];
          var poll = setInterval(function() {
            fetch('/api/me').then(function(r) { return r.json(); }).then(function(d) {
              if (d.authenticated) { clearInterval(poll); location.reload(); }
            }).catch(function() {});
          }, 2000);
        }
      })();
    </script>
  </div>`;
}

function getCoworkers(shift: RotaAssignment): string[] {
  const all = rotaGetByDate(shift.date);
  return all
    .filter(
      (a) => a.block === shift.block && a.id !== shift.id && a.state !== 'open',
    )
    .map((a) => {
      if (a.state === 'covered' && a.current_name) return a.current_name;
      return a.original_name || '?';
    })
    .filter(Boolean);
}

function relativeTime(isoStr?: string): string {
  if (!isoStr) return '';
  const diff = Date.now() - new Date(isoStr).getTime();
  if (diff < 0) return '';
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

const TRUNCATE_LENGTH = 120;

function updatesSection(): string {
  const updates = getCachedUpdates();
  if (updates.length === 0) return '';

  const items = updates
    .map((u, i) => {
      const ago = relativeTime(u.created_at);
      const sourceTag = u.source
        ? `<span class="update-source">${esc(u.source)}</span>`
        : '';
      const agoTag = ago
        ? `<span class="update-ago">${esc(ago)}</span>`
        : '';
      const meta =
        sourceTag || agoTag
          ? `<div class="update-meta">${sourceTag}${agoTag}</div>`
          : '';

      const text = u.memory;
      if (text.length > TRUNCATE_LENGTH) {
        const preview = text.slice(0, TRUNCATE_LENGTH);
        return `<li class="update-card" id="upd-${i}">
          <div class="update-text">
            <span class="update-preview">${esc(preview)}…</span>
            <span class="update-full" hidden>${esc(text)}</span>
          </div>
          ${meta}
          <button class="update-expand" onclick="var c=this.closest('.update-card');var p=c.querySelector('.update-preview');var f=c.querySelector('.update-full');if(f.hidden){f.hidden=false;p.hidden=true;this.textContent='less'}else{f.hidden=true;p.hidden=false;this.textContent='more'}">more</button>
        </li>`;
      }

      return `<li class="update-card">
        <div class="update-text">${esc(text)}</div>
        ${meta}
      </li>`;
    })
    .join('');

  return `<div class="section-divider"><span>Updates from chat</span></div>
  <ul class="update-list">${items}</ul>`;
}

function scheduleSection(today: string): string {
  const schedule = getTodaySchedule(today);
  if (!schedule) {
    return `<div class="section-divider"><span>Today</span></div>
    <div class="schedule-empty">No schedule data for today.</div>`;
  }

  const now = new Date();
  const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  const highlightHtml =
    schedule.highlights.length > 0
      ? `<div class="day-highlights">${schedule.highlights.map((h) => `<span class="highlight-tag">${esc(h)}</span>`).join('')}</div>`
      : '';

  const items = schedule.events
    .map((e, i) => {
      const note = e.note ? ` <span class="note">(${esc(e.note)})</span>` : '';
      const nextTime =
        i + 1 < schedule.events.length ? schedule.events[i + 1].time : '23:59';
      const isPast = e.time < currentTime && nextTime <= currentTime;
      const isNow = e.time <= currentTime && nextTime > currentTime;
      const cls = isPast ? ' past' : isNow ? ' now' : '';
      const nowDot = isNow ? '<span class="now-dot"></span>' : '';
      return `<li class="schedule-item${cls}">
        ${nowDot}
        <span class="time">${esc(e.time)}</span>
        <span class="event">${esc(e.name)}${note}</span>
      </li>`;
    })
    .join('');

  return `<div class="section-divider"><span>Today</span></div>
  ${highlightHtml}
  <ul class="schedule-list">${items}</ul>
  ${updatesSection()}`;
}

// ── Page renderers ──

export function renderToday(telegramId: string | null): string {
  const today = getToday();
  const openCount = rotaGetOpenSlots().length;
  const body = `
    ${header(today)}
    ${heroCard(telegramId)}
    ${scheduleSection(today)}
  `;
  return shell('Today', body, 'today', openCount);
}

export function renderMyShifts(telegramId: string | null): string {
  const openCount = rotaGetOpenSlots().length;
  const today = getToday();

  if (!telegramId) {
    const body = `
      ${header(today)}
      ${connectCard()}
    `;
    return shell('My Shifts', body, 'my-shifts', openCount);
  }

  const shifts = rotaGetByTelegramId(telegramId);
  if (shifts.length === 0) {
    const body = `
      ${header(today)}
      <div class="section-divider"><span>My Shifts</span></div>
      <div class="schedule-empty">No shifts assigned to you.</div>
    `;
    return shell('My Shifts', body, 'my-shifts', openCount);
  }

  const byDate = new Map<string, RotaAssignment[]>();
  for (const s of shifts) {
    const existing = byDate.get(s.date) || [];
    existing.push(s);
    byDate.set(s.date, existing);
  }

  let totalShifts = 0;
  let totalHours = 0;
  let html = '';

  for (const [date, dayShifts] of byDate) {
    const cards = dayShifts
      .map((s) => {
        totalShifts++;
        totalHours += s.hours;
        const isPast = date < today;
        const statusClass = isPast ? 'status-done' : 'status-upcoming';
        const statusText = isPast ? 'done' : 'upcoming';
        return `<div class="shift-card">
          <div class="shift-header">
            <span class="shift-name">${esc(s.block_label)}</span>
            <span class="status-badge ${statusClass}">${statusText}</span>
          </div>
          <div class="shift-time">${esc(s.start)}–${esc(s.end)}</div>
          ${!isPast ? `<a href="https://t.me/${esc(TELEGRAM_BOT_USERNAME)}?start=cover" class="btn btn-outline" style="font-size:12px;padding:4px 10px;margin-top:8px">Can't make it</a>` : ''}
        </div>`;
      })
      .join('');

    html += `<div class="day-group">
      <div class="day-header">${esc(formatDate(date))}</div>
      ${cards}
    </div>`;
  }

  html += `<div class="shift-total">${totalShifts} shifts · ${totalHours}h total</div>`;

  const body = `
    ${header(today)}
    <div class="section-divider"><span>My Shifts</span></div>
    ${html}
  `;
  return shell('My Shifts', body, 'my-shifts', openCount);
}

export function renderHelp(): string {
  const openSlots = rotaGetOpenSlots();
  const openCount = openSlots.length;
  const today = getToday();

  let html = '';
  if (openSlots.length === 0) {
    html =
      '<div class="schedule-empty">All shifts are covered right now.</div>';
  } else {
    html = openSlots
      .map((s) => {
        const wasLabel = s.original_name
          ? `<div class="was-label">was: ${esc(s.original_name)}</div>`
          : '';
        return `<div class="open-shift-card">
          <div class="shift-header">
            <span class="shift-name">${esc(s.block_label)}</span>
            <span class="status-badge status-open">open</span>
          </div>
          <div class="shift-time">${esc(s.start)}–${esc(s.end)}</div>
          <div class="shift-date">${esc(formatDate(s.date))}</div>
          ${wasLabel}
          <a href="${esc(getShiftsTopicLink() || `https://t.me/${TELEGRAM_BOT_USERNAME}`)}" class="btn btn-fire" style="font-size:13px">I'll do it →</a>
        </div>`;
      })
      .join('');
  }

  const body = `
    ${header(today)}
    <div class="section-divider"><span>Help Needed${openCount > 0 ? ` (${openCount})` : ''}</span></div>
    ${html}
    <div class="refresh-note">↻ refreshes every 60s</div>
    <script>setTimeout(function(){ location.reload(); }, 60000);</script>
  `;
  return shell('Help Needed', body, 'help', openCount);
}

export function renderWeek(): string {
  const week = getFullWeekSchedule();
  const today = getToday();
  const openCount = rotaGetOpenSlots().length;

  const html = week
    .map((day) => {
      const isToday = day.date === today;
      const marker = isToday
        ? ' <span class="today-marker">← today</span>'
        : '';
      const items = day.events
        .map((e) => {
          const note = e.note
            ? ` <span class="note">(${esc(e.note)})</span>`
            : '';
          return `<li class="schedule-item">
            <span class="time">${esc(e.time)}</span>
            <span class="event">${esc(e.name)}${note}</span>
          </li>`;
        })
        .join('');
      return `<div class="week-day">
        <div class="day-title">${esc(day.dayName)} · Day ${day.dayNumber}${marker}</div>
        <ul class="schedule-list">${items}</ul>
      </div>`;
    })
    .join('');

  const body = `
    ${header(today)}
    ${updatesSection()}
    <div class="section-divider"><span>The Week</span></div>
    ${html}
  `;
  return shell('The Week', body, 'week', openCount);
}

export function renderKitchen(): string {
  const today = getToday();
  const shifts = rotaGetByDate(today);
  const schedule = getTodaySchedule(today);
  const dayLabel = schedule
    ? `Day ${schedule.dayNumber}, ${schedule.dayName}`
    : formatDate(today);

  const now = new Date();
  const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  const blocks = new Map<string, RotaAssignment[]>();
  const blockOrder: string[] = [];
  for (const s of shifts) {
    if (!blocks.has(s.block)) {
      blocks.set(s.block, []);
      blockOrder.push(s.block);
    }
    blocks.get(s.block)!.push(s);
  }

  let openCount = 0;
  const blockCards = blockOrder
    .map((blockKey) => {
      const assignments = blocks.get(blockKey)!;
      const first = assignments[0];
      const isNow = first.start <= currentTime && first.end > currentTime;

      const people = assignments
        .map((a) => {
          if (a.state === 'open') {
            openCount++;
            return `<li class="open">⚠ OPEN</li>`;
          }
          if (a.state === 'covered') {
            const orig = a.original_name || '?';
            const curr = a.current_name || '?';
            return `<li class="covered">${esc(orig)}→${esc(curr)} ✓</li>`;
          }
          return `<li>${esc(a.current_name || a.original_name || '?')}</li>`;
        })
        .join('');

      const nowBadge = isNow ? `<div class="now-badge">● NOW</div>` : '';
      const nowClass = isNow ? ' now' : '';

      return `<div class="kitchen-block${nowClass}">
        <div class="block-time">${esc(first.start)}–${esc(first.end)}</div>
        <div class="block-label">${esc(first.block_label)}</div>
        <ul class="block-people">${people}</ul>
        ${nowBadge}
      </div>`;
    })
    .join('');

  const summaryParts: string[] = [];
  if (openCount > 0)
    summaryParts.push(
      `${openCount} shift${openCount === 1 ? '' : 's'} need${openCount === 1 ? 's' : ''} help`,
    );
  if (shifts.length - openCount > 0)
    summaryParts.push(`${shifts.length - openCount} covered`);
  const summary = summaryParts.join(' · ') || 'No shifts today';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Kitchen — TREEWEEK III</title>
  <style>${CSS}</style>
</head>
<body>
  <div class="kitchen-page">
    <div class="kitchen-header">
      <h1>TREEWEEK III</h1>
      <span class="meta">${esc(dayLabel)} · ↻ auto 60s</span>
    </div>
    <div class="kitchen-grid">
      ${blockCards || '<div class="schedule-empty">No shifts today.</div>'}
    </div>
    <div class="kitchen-summary">${summary}</div>
  </div>
  <script>setTimeout(function(){ location.reload(); }, 60000);</script>
</body>
</html>`;
}
