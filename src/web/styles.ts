export const CSS = `
:root {
  --ground: #0d0b08;
  --surface: #1a1610;
  --surface-raised: #231e16;
  --ink: #f1ead9;
  --ink-muted: #9a9488;
  --fire: #e8763a;
  --fire-glow: #ffb066;
  --open-red: #e85050;
  --covered-green: #4a9a5a;
  --border: #2e2820;
  --event-new: #587448;

  --font-body: system-ui, -apple-system, 'Segoe UI', sans-serif;
  --font-mono: 'SF Mono', 'Cascadia Code', 'Fira Code', ui-monospace, monospace;
}

* { margin: 0; padding: 0; box-sizing: border-box; }

body {
  background: var(--ground);
  color: var(--ink);
  font-family: var(--font-body);
  font-size: 16px;
  line-height: 1.5;
  min-height: 100dvh;
  -webkit-font-smoothing: antialiased;
}

.page {
  max-width: 480px;
  margin: 0 auto;
  padding: 0 16px 100px;
}

/* ── Header ── */

.header {
  padding: 20px 0 12px;
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.header h1 {
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--fire);
}

.header .day-label {
  font-size: 13px;
  color: var(--ink-muted);
  font-family: var(--font-mono);
}

/* ── Hero card (next shift) ── */

.hero-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-left: 3px solid var(--fire);
  border-radius: 0 6px 6px 0;
  padding: 10px 12px;
  margin: 8px 0 16px;
}

.hero-card .label {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ink-muted);
  margin-bottom: 4px;
}

.hero-card .hero-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.hero-card .name {
  font-size: 15px;
  font-weight: 600;
  color: var(--ink);
}

.hero-card .time {
  font-family: var(--font-mono);
  font-size: 13px;
  color: var(--fire-glow);
}

.hero-card .hero-detail {
  font-size: 12px;
  color: var(--ink-muted);
  margin-top: 3px;
}

.hero-card .hero-detail .countdown {
  color: var(--fire);
  font-family: var(--font-mono);
}

.hero-card .done-message {
  font-size: 15px;
  font-weight: 600;
  color: var(--covered-green);
}

.hero-card .done-sub {
  font-size: 12px;
  color: var(--ink-muted);
  margin-top: 2px;
}

.btn {
  display: inline-block;
  padding: 4px 10px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 600;
  text-decoration: none;
  margin-top: 6px;
  transition: opacity 0.15s;
}

.btn:hover { opacity: 0.85; }

.btn-fire {
  background: var(--fire);
  color: var(--ground);
}

.btn-outline {
  border: 1px solid var(--border);
  color: var(--ink);
  background: transparent;
}

/* ── Connect card ── */

.connect-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 20px;
  margin: 12px 0 24px;
  text-align: center;
}

.connect-card p {
  font-size: 14px;
  color: var(--ink-muted);
  margin-bottom: 12px;
}

.btn-telegram {
  background: #2aabee;
  color: #fff;
}

/* ── Section dividers ── */

.section-divider {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 24px 0 16px;
}

.section-divider span {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ink-muted);
  white-space: nowrap;
}

.section-divider::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--border);
}

/* ── Schedule list ── */

.schedule-list {
  list-style: none;
}

.schedule-item {
  display: flex;
  gap: 12px;
  padding: 6px 0;
}

.schedule-item .time {
  font-family: var(--font-mono);
  font-size: 14px;
  color: var(--fire-glow);
  min-width: 50px;
  flex-shrink: 0;
}

.schedule-item .event {
  font-size: 15px;
  color: var(--ink);
}

.schedule-item .event .note {
  font-size: 13px;
  color: var(--ink-muted);
  font-style: italic;
}

.schedule-empty {
  color: var(--ink-muted);
  font-size: 14px;
  padding: 8px 0;
}

/* ── Updates from chat ── */

.update-list {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.update-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-left: 3px solid var(--fire);
  border-radius: 0 6px 6px 0;
  padding: 10px 12px;
  position: relative;
}

.update-text {
  font-size: 14px;
  color: var(--ink);
  line-height: 1.5;
  word-wrap: break-word;
  overflow-wrap: break-word;
}

.update-meta {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-top: 6px;
}

.update-source {
  font-size: 11px;
  font-weight: 600;
  color: var(--fire-glow);
  background: rgba(232, 118, 58, 0.12);
  padding: 1px 6px;
  border-radius: 3px;
  letter-spacing: 0.02em;
}

.update-ago {
  font-size: 11px;
  color: var(--ink-muted);
  font-family: var(--font-mono);
}

.update-expand {
  position: absolute;
  top: 10px;
  right: 10px;
  background: none;
  border: 1px solid var(--border);
  color: var(--ink-muted);
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 3px;
  cursor: pointer;
  font-family: var(--font-mono);
}

.update-expand:hover {
  color: var(--ink);
  border-color: var(--ink-muted);
}

/* ── Day highlights ── */

.day-highlights {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}

.highlight-tag {
  font-size: 12px;
  font-weight: 600;
  color: var(--fire);
  background: rgba(232, 118, 58, 0.1);
  padding: 2px 8px;
  border-radius: 4px;
  letter-spacing: 0.03em;
}

/* ── Time-aware schedule ── */

.schedule-item {
  position: relative;
}

.schedule-item.past .time,
.schedule-item.past .event {
  opacity: 0.4;
}

.schedule-item.now {
  background: rgba(232, 118, 58, 0.06);
  margin: 0 -8px;
  padding: 6px 8px;
  border-radius: 6px;
}

.schedule-item.now .time {
  color: var(--fire);
  font-weight: 700;
}

.schedule-item.now .event {
  font-weight: 600;
}

.now-dot {
  position: absolute;
  left: -12px;
  top: 50%;
  transform: translateY(-50%);
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--fire);
  box-shadow: 0 0 6px var(--fire);
}

/* ── Shift lists (My Shifts, Help Needed) ── */

.day-group {
  margin-bottom: 16px;
}

.day-group .day-header {
  font-size: 12px;
  font-weight: 600;
  color: var(--ink-muted);
  padding-bottom: 6px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 6px;
}

.shift-total {
  font-size: 12px;
  color: var(--ink-muted);
  margin-top: 12px;
  padding-top: 8px;
  border-top: 1px solid var(--border);
}

.refresh-note {
  text-align: center;
  font-size: 12px;
  color: var(--ink-muted);
  margin-top: 16px;
}
.cache-age {
  font-size: 11px;
  color: var(--ink-muted);
  margin-top: 8px;
  padding-left: 4px;
}

/* ── Bottom nav ── */

.bottom-nav {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  background: var(--surface);
  border-top: 1px solid var(--border);
  display: flex;
  justify-content: center;
  z-index: 100;
}

.bottom-nav a {
  flex: 1;
  max-width: 120px;
  text-align: center;
  padding: 10px 4px calc(12px + env(safe-area-inset-bottom, 0px));
  font-size: 13px;
  font-weight: 500;
  color: var(--ink-muted);
  text-decoration: none;
  position: relative;
  transition: color 0.15s;
}

.bottom-nav a.active {
  color: var(--fire);
}

.bottom-nav a:hover {
  color: var(--ink);
}

.badge {
  position: absolute;
  top: 4px;
  right: 12px;
  background: var(--open-red);
  color: #fff;
  font-size: 10px;
  font-weight: 700;
  min-width: 16px;
  height: 16px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 4px;
}

/* ── Kitchen display ── */

.kitchen-page {
  background: var(--ground);
  min-height: 100dvh;
  padding: 24px;
}

.kitchen-header {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: 24px;
}

.kitchen-header h1 {
  font-size: 20px;
  font-weight: 700;
  color: var(--fire);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.kitchen-header .meta {
  font-family: var(--font-mono);
  font-size: 13px;
  color: var(--ink-muted);
}

.kitchen-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 16px;
}

.kitchen-block {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 16px;
  min-height: 160px;
}

.kitchen-block.now {
  border-color: var(--fire);
  box-shadow: 0 0 12px rgba(232, 118, 58, 0.2);
}

.kitchen-block .block-time {
  font-family: var(--font-mono);
  font-size: 16px;
  font-weight: 700;
  color: var(--fire-glow);
}

.kitchen-block .block-label {
  font-size: 18px;
  font-weight: 700;
  text-transform: uppercase;
  margin-top: 4px;
  letter-spacing: 0.04em;
}

.kitchen-block .block-people {
  margin-top: 12px;
  list-style: none;
}

.kitchen-block .block-people li {
  font-size: 16px;
  padding: 3px 0;
}

.kitchen-block .block-people .open {
  color: var(--open-red);
  font-weight: 700;
}

.kitchen-block .block-people .covered {
  color: var(--covered-green);
}

.kitchen-block .now-badge {
  display: inline-block;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--fire);
  margin-top: 8px;
}

.kitchen-summary {
  margin-top: 24px;
  font-size: 15px;
  color: var(--ink-muted);
  text-align: center;
}

/* ── Auth polling ── */

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

.polling { animation: pulse 2s ease-in-out infinite; }

/* ── Synthesized timeline ── */

.synth-list {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.synth-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-left: 3px solid var(--border);
  border-radius: 0 6px 6px 0;
  padding: 7px 10px;
  list-style: none;
}

.synth-card.card-changed { border-left-color: var(--fire); }
.synth-card.card-new { border-left-color: var(--event-new); }
.synth-card.card-cancelled { border-left-color: var(--ink-muted); opacity: 0.55; }
.synth-card.card-open { border-left-color: var(--open-red); }
.synth-card.past { opacity: 0.5; }

.synth-card .card-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.synth-card .time {
  font-family: var(--font-mono);
  font-size: 13px;
  color: var(--fire-glow);
  flex-shrink: 0;
  min-width: 42px;
}

.synth-card .name {
  font-size: 14px;
  color: var(--ink);
  flex: 1;
  min-width: 0;
}

.synth-card.card-cancelled .name {
  text-decoration: line-through;
  opacity: 0.7;
}

.synth-badge {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  padding: 1px 5px;
  border-radius: 3px;
  flex-shrink: 0;
}

.synth-badge.badge-changed {
  color: var(--fire);
  background: rgba(232, 118, 58, 0.12);
}

.synth-badge.badge-new {
  color: var(--event-new);
  background: rgba(88, 116, 72, 0.2);
}

.synth-badge.badge-cancelled {
  color: var(--open-red);
  background: rgba(232, 80, 80, 0.1);
}

.synth-badge.badge-done {
  color: var(--covered-green);
  background: rgba(74, 154, 90, 0.15);
}

.synth-badge.badge-upcoming {
  color: var(--fire);
  background: rgba(232, 118, 58, 0.12);
}

.synth-badge.badge-open {
  color: var(--open-red);
  background: rgba(232, 80, 80, 0.15);
}

.synth-badge.badge-covered {
  color: var(--covered-green);
  background: rgba(74, 154, 90, 0.15);
}

.synth-card .card-detail {
  font-size: 12px;
  color: var(--ink-muted);
  margin-top: 2px;
  line-height: 1.4;
}

.synth-card .card-detail .change-text {
  color: var(--fire-glow);
}

.synth-card .card-detail .source-tag {
  font-weight: 600;
  color: var(--fire-glow);
  background: rgba(232, 118, 58, 0.12);
  padding: 0 4px;
  border-radius: 2px;
}

.synth-card .btn {
  font-size: 12px;
  padding: 4px 10px;
  margin-top: 4px;
  display: inline-block;
}

.synth-card.past { opacity: 0.4; }

.synth-card.now {
  border-color: var(--fire);
  border-left-color: var(--fire);
  box-shadow: 0 0 8px rgba(232, 118, 58, 0.15);
}

.synth-card.now .time { color: var(--fire); font-weight: 700; }
.synth-card.now .name { font-weight: 600; }

/* ── Ticket-stub cards (My Stuff + Help) ── */

.ticket-card {
  background: var(--surface);
  border: 2px dashed var(--border);
  border-radius: 6px;
  padding: 7px 10px;
}
.ticket-card.card-open { border-color: var(--open-red); }
.ticket-card.past { opacity: 0.4; }
.ticket-card .card-row { display: flex; align-items: baseline; gap: 8px; }
.ticket-card .time { font-family: var(--font-mono); font-size: 13px; color: var(--fire-glow); flex-shrink: 0; min-width: 42px; }
.ticket-card .name { font-size: 14px; font-weight: 500; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ticket-card .card-detail { font-size: 12px; color: var(--ink-muted); margin-top: 2px; }
.ticket-card .btn { margin-top: 6px; font-size: 13px; }
.ticket-card .synth-badge { font-size: 11px; padding: 1px 6px; border-radius: 3px; white-space: nowrap; }

/* ── Thank you ── */

.thank-you {
  text-align: center;
  padding: 60px 20px;
  font-size: 22px;
  color: var(--fire-glow);
}

/* ── Help intro ── */

.help-intro {
  font-size: 14px;
  color: var(--ink-muted);
  margin-bottom: 12px;
}

/* ── Pre-event ── */

.pre-event-tagline {
  font-size: 20px;
  font-style: italic;
  color: var(--fire-glow);
  text-align: center;
  padding: 16px 0 8px;
  letter-spacing: 0.02em;
}

.pre-event-shift {
  background: var(--surface);
  border: 1px solid var(--border);
  border-left: 3px solid var(--covered-green);
  border-radius: 0 6px 6px 0;
  padding: 10px 12px;
  margin: 12px 0;
}

.pre-event-shift-label {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ink-muted);
  margin-bottom: 4px;
}

.pre-event-shift-detail {
  font-size: 14px;
  color: var(--ink);
}

/* ── Day navigation ── */

.day-nav {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  margin-bottom: 12px;
}

.day-nav-arrow {
  font-size: 18px;
  color: var(--fire);
  text-decoration: none;
  padding: 4px 8px;
  min-width: 44px;
  min-height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.day-nav-arrow.disabled {
  visibility: hidden;
}

.day-nav-arrow:hover {
  color: var(--fire-glow);
}

.day-nav-label {
  font-size: 14px;
  font-weight: 600;
  color: var(--ink);
  white-space: nowrap;
}

.day-nav-today {
  font-size: 11px;
  color: var(--ink-muted);
  text-decoration: none;
  border: 1px solid var(--border);
  padding: 2px 8px;
  border-radius: 3px;
}

.day-nav-today:hover {
  color: var(--ink);
  border-color: var(--ink-muted);
}

/* ── Meal details ── */

.meal-details {
  display: none;
  font-size: 12px;
  color: var(--ink-muted);
  margin-top: 6px;
  padding-left: 0;
  line-height: 1.8;
}

.meal-details.meal-expanded,
.synth-card.meal-open .meal-details {
  display: block;
}

@media (hover: hover) {
  .synth-card:hover .meal-details {
    display: block;
  }
}

.dish {
  white-space: nowrap;
}

.allergen-tag {
  font-size: 11px;
  font-weight: 700;
  padding: 0 3px;
  border-radius: 2px;
  margin-left: 2px;
  vertical-align: middle;
}

.allergen-tag.vg {
  color: var(--covered-green);
  background: rgba(74, 154, 90, 0.15);
}

.allergen-tag.gf {
  color: var(--fire-glow);
  background: rgba(255, 176, 102, 0.12);
}

/* ── Tab amount ── */

.tab-amount {
  font-family: var(--font-mono);
  font-size: 16px;
  font-weight: 700;
  color: var(--fire);
}

/* ── Responsive ── */

@media (min-width: 768px) {
  .page { max-width: 600px; }
}
`;
