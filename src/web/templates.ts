import {
  getToday,
  TELEGRAM_BOT_USERNAME,
  getShiftsTopicLink,
} from '../config.js';
import type { RotaAssignment } from '../rota-db.js';
import {
  rotaGetByDate,
  rotaGetByTelegramId,
  rotaGetCoveredByPerson,
  rotaGetOpenSlots,
} from '../rota-db.js';
import { getUserTotal } from '../db.js';
import { CSS } from './styles.js';
import {
  getTodaySchedule,
  formatDate,
  getEventPhase,
  getEventStartStr,
  getEventEndStr,
  daysBetween,
  getScheduleForDate,
  addDays,
} from './schedule.js';
import { getCachedUpdates, getCacheAge } from './schedule-refresh.js';
import {
  getSynthesizedScheduleForDate,
  type SynthesizedSchedule,
} from './schedule-synthesis.js';
import { getMealsForDate } from './food.js';

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
  hideNav?: boolean,
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
  <svg class="grain" aria-hidden="true" style="position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:10000;opacity:0.035"><filter id="grain"><feTurbulence type="fractalNoise" baseFrequency="0.7" numOctaves="3" stitchTiles="stitch"/></filter><rect width="100%" height="100%" filter="url(#grain)"/></svg>
  <div class="page">
    ${body}
  </div>
  ${hideNav ? '' : nav(activeTab, openCount)}
  <script>document.querySelectorAll('.synth-card').forEach(function(c){if(c.querySelector('.meal-details')){c.style.cursor='pointer';c.addEventListener('click',function(){c.classList.toggle('meal-open');var h=c.querySelector('.expand-hint');if(h)h.textContent=c.classList.contains('meal-open')?'▾':'▸'})}})</script>
</body>
</html>`;
}

function nav(active: string, openCount: number): string {
  const tabs = [
    { href: '/', label: 'Today', key: 'today' },
    { href: '/my-shifts', label: 'My Stuff', key: 'my-shifts' },
    { href: '/help', label: 'Lend a Hand', key: 'help' },
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
  const phase = getEventPhase(today);
  const startStr = getEventStartStr();
  let dayLabel: string;
  if (phase === 'pre') {
    const days = daysBetween(today, startStr);
    dayLabel = days === 1 ? 'starts tomorrow' : `starts in ${days} days`;
  } else if (phase === 'during') {
    const schedule = getTodaySchedule(today);
    dayLabel = schedule
      ? `Day ${schedule.dayNumber} of 8 · ${schedule.dayName}`
      : formatDate(today);
  } else {
    const endStr = getEventEndStr();
    const days = daysBetween(endStr, today);
    dayLabel =
      days <= 0
        ? 'just ended'
        : days === 1
          ? 'ended yesterday'
          : `ended ${days} days ago`;
  }
  return `<div class="header">
    <h1>TREEWEEK III</h1>
    <span class="day-label">${esc(dayLabel)}</span>
  </div>`;
}

function heroCard(telegramId: string | null, webToken?: string | null): string {
  if (!telegramId) {
    return connectCard(webToken);
  }

  const today = getToday();
  const now = new Date();
  const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  const ownShifts = rotaGetByTelegramId(telegramId).filter(
    (s) => s.state === 'assigned',
  );
  const pickedUp = rotaGetCoveredByPerson(telegramId);
  const allShifts = [...ownShifts, ...pickedUp].sort((a, b) =>
    a.date === b.date
      ? a.start.localeCompare(b.start)
      : a.date.localeCompare(b.date),
  );

  const upcoming = allShifts.filter((s) => {
    if (s.date > today) return true;
    if (s.date === today && s.end > currentTime) return true;
    return false;
  });

  if (upcoming.length === 0) {
    return `<div class="hero-card">
      <div class="done-message">No more shifts</div>
      <div class="done-sub">Lend a hand?</div>
      <a href="/help" class="btn btn-outline">See open shifts</a>
    </div>`;
  }

  const next = upcoming[0];
  if (next.date !== today) return '';

  const isCovering = next.state === 'covered';
  const coworkers = getCoworkers(next);

  const [h, m] = next.start.split(':').map(Number);
  const shiftStart = new Date(now);
  shiftStart.setHours(h, m, 0, 0);
  const diff = shiftStart.getTime() - now.getTime();
  let countdown = '';
  if (diff > 0) {
    const hrs = Math.floor(diff / 3600000);
    const mins = Math.floor((diff % 3600000) / 60000);
    countdown = hrs > 0 ? `starts in ${hrs}h ${mins}m` : `starts in ${mins}m`;
  } else {
    countdown = 'happening now';
  }

  const label = isCovering
    ? `Covering for ${esc(next.original_name || '?')}`
    : 'Your next shift';

  const detailParts: string[] = [];
  if (countdown)
    detailParts.push(`<span class="countdown">${esc(countdown)}</span>`);
  if (coworkers.length > 0)
    detailParts.push(`with: ${esc(coworkers.join(', '))}`);
  const detailHtml =
    detailParts.length > 0
      ? `<div class="hero-detail">${detailParts.join(' · ')}</div>`
      : '';

  return `<div class="hero-card">
    <div class="label">${label}</div>
    <div class="hero-row">
      <span class="name">${esc(next.block_label)}</span>
      <span class="time">${esc(next.start)}–${esc(next.end)}</span>
    </div>
    ${detailHtml}
    ${!isCovering ? `<a href="https://t.me/${esc(TELEGRAM_BOT_USERNAME)}?start=cover" class="btn btn-fire">Can't make it</a>` : ''}
  </div>`;
}

function connectCard(webToken?: string | null): string {
  const linkHref = webToken
    ? `https://t.me/${esc(TELEGRAM_BOT_USERNAME)}?start=link_${esc(webToken)}`
    : `https://t.me/${esc(TELEGRAM_BOT_USERNAME)}`;
  const pollScript = webToken
    ? `<script>
      (function() {
        var poll = setInterval(function() {
          fetch('/api/me').then(function(r) { return r.json(); }).then(function(d) {
            if (d.authenticated) { clearInterval(poll); location.reload(); }
          }).catch(function() {});
        }, 2000);
      })();
    </script>`
    : '';
  return `<div class="connect-card">
    <p>Connect with Telegram to see your shifts</p>
    <a href="${linkHref}" class="btn btn-telegram">Connect with Telegram</a>
    ${pollScript}
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
      const sourceTag = '';
      const agoTag = ago ? `<span class="update-ago">${esc(ago)}</span>` : '';
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

  return `<div class="section-divider"><span>From the Grapevine</span></div>
  <ul class="update-list">${items}</ul>`;
}

function scheduleSection(dateStr: string): string {
  const synthesis = getSynthesizedScheduleForDate(dateStr);
  if (synthesis) {
    return renderSynthesizedTimeline(synthesis);
  }
  return renderStaticSchedule(dateStr);
}

function buildDetailLine(e: {
  status: string;
  change?: string;
  note?: string;
  location?: string;
  source?: string;
}): string {
  const parts: string[] = [];
  if (e.change) parts.push(`<span class="change-text">${esc(e.change)}</span>`);
  if (e.note && e.status !== 'on') parts.push(esc(e.note));
  if (e.location) parts.push(esc(e.location));
  // e.source contains internal Mem0 refs like "Chat update #5" — not user-facing
  if (parts.length === 0) return '';
  return `<div class="card-detail">${parts.join(' · ')}</div>`;
}

function renderSynthesizedTimeline(synthesis: SynthesizedSchedule): string {
  const now = new Date();
  const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  const highlightHtml =
    synthesis.highlights.length > 0
      ? `<div class="day-highlights">${synthesis.highlights.map((h) => `<span class="highlight-tag">${esc(h)}</span>`).join('')}</div>`
      : '';

  const hasChanges = synthesis.events.some((e) => e.status !== 'on');

  const badgeMap: Record<string, [string, string]> = {
    changed: ['badge-changed', 'changed'],
    new: ['badge-new', 'new'],
    cancelled: ['badge-cancelled', 'cancelled'],
  };

  const items = synthesis.events
    .map((e, i) => {
      const nextTime =
        i + 1 < synthesis.events.length
          ? synthesis.events[i + 1].time
          : '23:59';
      const isPast = e.time < currentTime && nextTime <= currentTime;
      const isNow = e.time <= currentTime && nextTime > currentTime;
      const timeCls = isPast ? ' past' : isNow ? ' now' : '';
      const statusCls = e.status === 'on' ? ' card-on' : ` card-${e.status}`;

      const nameTag =
        e.status === 'cancelled'
          ? `<span class="name"><del>${esc(e.name)}</del></span>`
          : `<span class="name">${esc(e.name)}</span>`;

      const badge = badgeMap[e.status];
      const badgeHtml = badge
        ? `<span class="synth-badge ${badge[0]}">${badge[1]}</span>`
        : '';

      const noteInline =
        e.note && e.status === 'on'
          ? ` <span style="font-size:12px;color:var(--ink-muted);font-style:italic">(${esc(e.note)})</span>`
          : '';

      const mealHtml = renderMealDetails(
        e.name,
        synthesis.date,
        true,
        currentTime,
      );

      return `<li class="synth-card${statusCls}${timeCls}">
        <div class="card-row">
          <span class="time">${esc(e.time)}</span>
          ${nameTag}${noteInline}
          ${badgeHtml}
        </div>
        ${buildDetailLine(e)}
        ${mealHtml}
      </li>`;
    })
    .join('');

  const cacheAge = getCacheAge();
  const ageMinutes = Math.floor(cacheAge / 60000);
  const ageLabel =
    ageMinutes < 1
      ? 'just now'
      : ageMinutes < 60
        ? `${ageMinutes}m ago`
        : `${Math.floor(ageMinutes / 60)}h ago`;
  const ageHtml = hasChanges
    ? `<div class="cache-age">last sync: ${esc(ageLabel)}</div>`
    : '';

  return `${highlightHtml}
  <ul class="synth-list">${items}</ul>
  ${ageHtml}`;
}

function renderStaticSchedule(today: string): string {
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

  return `${highlightHtml}
  <ul class="schedule-list">${items}</ul>
  ${updatesSection()}`;
}

// ── Page renderers ──

function dayNav(selectedDate: string, today: string): string {
  const prevDate = addDays(selectedDate, -1);
  const nextDate = addDays(selectedDate, 1);
  const isToday = selectedDate === today;

  const prev = `<a href="/?date=${prevDate}" class="day-nav-arrow">&larr;</a>`;
  const next = `<a href="/?date=${nextDate}" class="day-nav-arrow">&rarr;</a>`;

  const eventDay = getScheduleForDate(selectedDate);
  const label = eventDay
    ? `Day ${eventDay.dayNumber} · ${eventDay.dayName}`
    : formatDate(selectedDate);

  const todayLink = !isToday
    ? `<a href="/" class="day-nav-today">today</a>`
    : '';

  return `<div class="day-nav">
    ${prev}
    <span class="day-nav-label">${esc(label)}</span>
    ${next}
    ${todayLink}
  </div>`;
}

function renderMealDetails(
  mealName: string,
  date: string,
  isToday: boolean,
  currentTime: string,
): string {
  const meals = getMealsForDate(date);
  const mealInfo = meals.find(
    (m) => m.meal.toLowerCase() === mealName.toLowerCase(),
  );
  if (!mealInfo || mealInfo.dishes.length === 0) return '';

  const isCurrentMeal =
    isToday && isMealTimeNow(mealName.toLowerCase(), currentTime);
  const expandCls = isCurrentMeal ? ' meal-expanded' : '';
  const dishes = mealInfo.dishes
    .map((d) => {
      const tags: string[] = [];
      if (d.isVegan) tags.push('<span class="allergen-tag vg">VG</span>');
      if (!d.allergens.includes('gluten'))
        tags.push('<span class="allergen-tag gf">GF</span>');
      return `<span class="dish">${esc(d.name)}${tags.join('')}</span>`;
    })
    .join(' · ');
  return `<span class="expand-hint">▸</span><div class="meal-details${expandCls}">${dishes}</div>`;
}

function renderDateSchedule(dateStr: string, today: string): string {
  const day = getScheduleForDate(dateStr);
  if (!day) return '';

  const now = new Date();
  const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const isToday = day.date === today;

  const highlightHtml =
    day.highlights.length > 0
      ? `<div class="day-highlights">${day.highlights.map((h) => `<span class="highlight-tag">${esc(h)}</span>`).join('')}</div>`
      : '';

  const items = day.events
    .map((e, i) => {
      const noteInline = e.note
        ? ` <span style="font-size:12px;color:var(--ink-muted);font-style:italic">(${esc(e.note)})</span>`
        : '';
      const nextTime =
        i + 1 < day.events.length ? day.events[i + 1].time : '23:59';
      const isPast = isToday && e.time < currentTime && nextTime <= currentTime;
      const isNow = isToday && e.time <= currentTime && nextTime > currentTime;
      const timeCls = isPast ? ' past' : isNow ? ' now' : '';

      const mealHtml = renderMealDetails(
        e.name,
        day.date,
        isToday,
        currentTime,
      );

      return `<li class="synth-card card-on${timeCls}">
        <div class="card-row">
          <span class="time">${esc(e.time)}</span>
          <span class="name">${esc(e.name)}${noteInline}</span>
        </div>
        ${mealHtml}
      </li>`;
    })
    .join('');

  return `${highlightHtml}
  <ul class="synth-list">${items}</ul>`;
}

function isMealTimeNow(meal: string, currentTime: string): boolean {
  switch (meal) {
    case 'breakfast':
      return currentTime >= '09:00' && currentTime < '13:00';
    case 'lunch':
      return currentTime >= '13:00' && currentTime < '18:00';
    case 'dinner':
      return currentTime >= '18:00';
    default:
      return false;
  }
}

export function renderToday(
  telegramId: string | null,
  webToken?: string | null,
  dateParam?: string | null,
): string {
  const today = getToday();
  const phase = getEventPhase(today);
  const openCount = rotaGetOpenSlots().length;

  if (phase === 'pre') {
    const days = daysBetween(today, getEventStartStr());
    const countdown = days === 1 ? 'starts tomorrow' : `starts in ${days} days`;
    const body = `
      <div class="pre-event-landing">
        <h1 class="pre-event-title">TREEWEEK III</h1>
        <div class="pre-event-countdown">${esc(countdown)}</div>
        <div class="pre-event-tagline">LARP your higher self</div>
      </div>
    `;
    return shell('Treeweek III', body, 'today', openCount, true);
  }

  if (phase === 'post') {
    const body = `
      ${header(today)}
      <div class="thank-you">Thank you for coming to TREEWEEK!</div>
    `;
    return shell('Treeweek III', body, 'today', openCount);
  }

  const selectedDate =
    dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam) ? dateParam : today;
  const isToday = selectedDate === today;

  const phaseHero = heroCard(telegramId, webToken);

  const isEventDay = !!getScheduleForDate(selectedDate);
  let scheduleHtml: string;

  if (isEventDay) {
    scheduleHtml = scheduleSection(selectedDate);
  } else {
    scheduleHtml = '';
  }

  const dividerLabel = isToday ? "Today's Rhythm" : formatDate(selectedDate);

  const body = `
    ${header(today)}
    ${phaseHero}
    <div class="section-divider"><span>${esc(dividerLabel)}</span></div>
    ${dayNav(selectedDate, today)}
    ${scheduleHtml}
  `;
  return shell('Treeweek III', body, 'today', openCount);
}

export function renderMyShifts(
  telegramId: string | null,
  webToken?: string | null,
): string {
  const openCount = rotaGetOpenSlots().length;
  const today = getToday();

  if (!telegramId) {
    const body = `
      ${header(today)}
      ${connectCard(webToken)}
    `;
    return shell('My Shifts', body, 'my-shifts', openCount);
  }

  const ownShifts = rotaGetByTelegramId(telegramId);
  const pickedUp = rotaGetCoveredByPerson(telegramId);

  if (ownShifts.length === 0 && pickedUp.length === 0) {
    const body = `
      ${header(today)}
      <div class="section-divider"><span>Your Corner</span></div>
      <div class="schedule-empty">No shifts assigned to you.</div>
    `;
    return shell('My Shifts', body, 'my-shifts', openCount);
  }

  const byDate = new Map<string, RotaAssignment[]>();
  for (const s of ownShifts) {
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

        let badgeCls: string;
        let badgeText: string;
        let borderCls: string;
        if (s.state === 'open') {
          badgeCls = 'badge-open';
          badgeText = 'released';
          borderCls = ' card-open';
        } else if (s.state === 'covered') {
          badgeCls = 'badge-covered';
          badgeText = 'covered';
          borderCls = '';
        } else {
          badgeCls = isPast ? 'badge-done' : 'badge-upcoming';
          badgeText = isPast ? 'done' : 'upcoming';
          borderCls = '';
        }

        const detailParts: string[] = [];
        if (s.state === 'covered' && s.current_name)
          detailParts.push(`now: ${esc(s.current_name)}`);
        const coworkers = getCoworkers(s);
        if (coworkers.length > 0)
          detailParts.push(`with: ${esc(coworkers.join(', '))}`);
        const showCover = s.state === 'assigned' && !isPast;
        const detailHtml =
          detailParts.length > 0
            ? `<div class="card-detail">${detailParts.join(' · ')}</div>`
            : '';
        const pastCls = isPast ? ' past' : '';

        return `<div class="ticket-card${borderCls}${pastCls}">
          <div class="card-row">
            <span class="time">${esc(s.start)}–${esc(s.end)}</span>
            <span class="name">${esc(s.block_label)}</span>
            <span class="synth-badge ${badgeCls}">${badgeText}</span>
          </div>
          ${detailHtml}
          ${showCover ? `<a href="https://t.me/${esc(TELEGRAM_BOT_USERNAME)}?start=cover" class="btn btn-outline">Can't make it</a>` : ''}
        </div>`;
      })
      .join('');

    html += `<div class="day-group">
      <div class="day-header">${esc(formatDate(date))}</div>
      ${cards}
    </div>`;
  }

  html += `<div class="shift-total">${totalShifts} shifts · ${totalHours}h total</div>`;

  if (pickedUp.length > 0) {
    const pickedUpCards = pickedUp
      .map(
        (s) => `<div class="ticket-card">
          <div class="card-row">
            <span class="time">${esc(s.start)}–${esc(s.end)}</span>
            <span class="name">${esc(s.block_label)}</span>
            <span class="synth-badge badge-covered">covering</span>
          </div>
          <div class="card-detail">${esc(formatDate(s.date))} · for: ${esc(s.original_name || '?')}</div>
        </div>`,
      )
      .join('');
    html += `<div class="section-divider"><span>Shifts you picked up</span></div>${pickedUpCards}`;
  }

  const tabTotal = getUserTotal(telegramId);
  const totalRow =
    tabTotal > 0
      ? `<div class="card-row"><span class="name">Total</span><span class="tab-amount">&euro;${tabTotal.toFixed(2)}</span></div>`
      : '';
  const tabHtml = `<div class="section-divider"><span>Your Tab</span></div>
    <div class="ticket-card">
      ${totalRow}
      <div class="tab-actions">
        <a href="https://t.me/${esc(TELEGRAM_BOT_USERNAME)}?start=bar" class="btn btn-outline">Log a drink</a>
        <a href="https://t.me/${esc(TELEGRAM_BOT_USERNAME)}?start=bbq" class="btn btn-outline">Log a meal</a>
      </div>
    </div>`;

  const body = `
    ${header(today)}
    <div class="section-divider"><span>Your Corner</span></div>
    ${html}
    ${tabHtml}
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
      '<div class="schedule-empty">All shifts covered. Nice work, everyone.</div>';
  } else {
    const cards = openSlots
      .map((s) => {
        const detailParts: string[] = [esc(formatDate(s.date))];
        if (s.original_name) detailParts.push(`was: ${esc(s.original_name)}`);
        const sameBlock = rotaGetByDate(s.date).filter(
          (a) => a.block === s.block && a.state !== 'open',
        );
        if (sameBlock.length > 0) {
          const names = sameBlock.map(
            (a) => a.current_name || a.original_name || '?',
          );
          detailParts.push(`${names.join(', ')} already in`);
        }
        return `<div class="ticket-card card-open">
          <div class="card-row">
            <span class="time">${esc(s.start)}–${esc(s.end)}</span>
            <span class="name">${esc(s.block_label)}</span>
            <span class="synth-badge badge-open">open</span>
          </div>
          <div class="card-detail">${detailParts.join(' · ')}</div>
          <a href="${esc(getShiftsTopicLink() || `https://t.me/${TELEGRAM_BOT_USERNAME}`)}" class="btn btn-fire">I'll do it →</a>
        </div>`;
      })
      .join('');
    html = `<p class="help-intro">The kitchen could use a hand.</p>${cards}`;
  }

  const body = `
    ${header(today)}
    <div class="section-divider"><span>Lend a Hand${openCount > 0 ? ` (${openCount})` : ''}</span></div>
    ${html}
    <div class="refresh-note">↻ refreshes every 60s</div>
    <script>setTimeout(function(){ location.reload(); }, 60000);</script>
  `;
  return shell('Help Needed', body, 'help', openCount);
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
