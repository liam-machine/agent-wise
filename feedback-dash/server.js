// =============================================================================
// wiseway-feedback-dash — read-only admin feedback dashboard
// =============================================================================
// Staff can thumbs-up / thumbs-down an assistant answer in LibreChat. That
// writes a `feedback: { rating, tag }` object onto the *message* document in
// Mongo. LibreChat ships NO admin view for it — this little service is that
// view: it aggregates the feedback and serves a one-page dashboard.
//
// It reads the SAME Mongo that LibreChat writes (MONGO_URI). It only ever
// READS — it never writes feedback. There is no sample data baked in here; an
// empty database renders an empty dashboard. (The local demo seed lives in the
// gitignored deploy/seed-feedback.local.js and stays on the dev machine.)
//
// SECURITY (PoC): there is NO auth on this service. Anyone who can reach the
// port sees all feedback. Before real data, gate it behind admin-only SSO (or
// drop it on an internal-only network). INTEGRATE: see docs/INTEGRATION.md.
// =============================================================================

import express from 'express';
import { MongoClient } from 'mongodb';

const PORT = process.env.PORT || 8050;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://mongodb:27017/LibreChat';

// The real LibreChat feedback taxonomy (packages/data-provider FEEDBACK_*).
// key -> human label + which rating it belongs to. Kept here so the dashboard
// shows friendly names and colours tags by sentiment. Unknown keys fall back
// to a humanised version of the key and are treated as their stored rating.
const TAGS = {
  // thumbsUp
  accurate_reliable:   { label: 'Accurate & Reliable',   direction: 'thumbsUp' },
  creative_solution:   { label: 'Creative Solution',     direction: 'thumbsUp' },
  clear_well_written:  { label: 'Clear & Well-written',  direction: 'thumbsUp' },
  attention_to_detail: { label: 'Attention to Detail',   direction: 'thumbsUp' },
  // thumbsDown
  not_matched:         { label: "Didn't Match Needs",    direction: 'thumbsDown' },
  inaccurate:          { label: 'Inaccurate',            direction: 'thumbsDown' },
  bad_style:           { label: 'Bad Style',             direction: 'thumbsDown' },
  missing_image:       { label: 'Missing Image',         direction: 'thumbsDown' },
  unjustified_refusal: { label: 'Unjustified Refusal',   direction: 'thumbsDown' },
  not_helpful:         { label: 'Not Helpful',           direction: 'thumbsDown' },
  other:               { label: 'Other',                 direction: 'thumbsDown' },
};

const labelFor = (key) =>
  TAGS[key]?.label || (key ? key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : '(no tag)');

const client = new MongoClient(MONGO_URI);
let db;
async function getDb() {
  if (!db) {
    await client.connect();
    db = client.db(); // db name comes from the URI path (…/LibreChat)
  }
  return db;
}

// Pull every rated message, joined to its author (for role/email). `user` is
// stored as a STRING on messages but ObjectId on users — convert defensively.
async function loadFeedback() {
  const database = await getDb();
  return database
    .collection('messages')
    .aggregate([
      { $match: { 'feedback.rating': { $exists: true, $ne: null } } },
      { $addFields: { _uoid: { $convert: { input: '$user', to: 'objectId', onError: null, onNull: null } } } },
      { $lookup: { from: 'users', localField: '_uoid', foreignField: '_id', as: 'u' } },
      { $addFields: { u: { $first: '$u' } } },
      {
        $project: {
          _id: 0,
          when: '$createdAt',
          rating: '$feedback.rating',
          tag: '$feedback.tag',
          role: { $ifNull: ['$u.role', 'unknown'] },
          by: { $ifNull: ['$u.email', '(unknown user)'] },
          excerpt: { $ifNull: [{ $first: '$content.text' }, '$text'] },
        },
      },
      { $sort: { when: -1 } },
    ])
    .toArray();
}

// Turn the raw rows into the shapes the charts want. Done in JS (the dataset is
// small) so the aggregation above stays simple and easy to audit.
function summarise(rows) {
  const up = rows.filter((r) => r.rating === 'thumbsUp').length;
  const down = rows.filter((r) => r.rating === 'thumbsDown').length;
  const total = rows.length;

  const byTagMap = new Map();
  for (const r of rows) {
    const k = r.tag || 'other';
    const e = byTagMap.get(k) || { key: k, label: labelFor(k), direction: TAGS[k]?.direction || r.rating, count: 0 };
    e.count++;
    byTagMap.set(k, e);
  }
  const byTag = [...byTagMap.values()].sort((a, b) => b.count - a.count);

  const byRoleMap = new Map();
  for (const r of rows) {
    const e = byRoleMap.get(r.role) || { role: r.role, thumbsUp: 0, thumbsDown: 0 };
    e[r.rating]++;
    byRoleMap.set(r.role, e);
  }
  const byRole = [...byRoleMap.values()].sort((a, b) => b.thumbsUp + b.thumbsDown - (a.thumbsUp + a.thumbsDown));

  const byDayMap = new Map();
  for (const r of rows) {
    const day = (r.when instanceof Date ? r.when : new Date(r.when)).toISOString().slice(0, 10);
    const e = byDayMap.get(day) || { day, thumbsUp: 0, thumbsDown: 0 };
    e[r.rating]++;
    byDayMap.set(day, e);
  }
  const overTime = [...byDayMap.values()].sort((a, b) => a.day.localeCompare(b.day));

  // Tag breakdown split by role: one bar per tag, stacked by role. Tags reuse
  // the byTag ordering (most-common first); roles reuse the byRole ordering.
  const tagKeys = byTag.map((t) => t.key);
  const roleNames = byRole.map((r) => r.role);
  const tagByRole = {
    tags: byTag.map((t) => t.label),
    directions: byTag.map((t) => t.direction),
    datasets: roleNames.map((role) => ({
      role,
      data: tagKeys.map((k) => rows.filter((r) => (r.tag || 'other') === k && r.role === role).length),
    })),
  };

  const recent = rows.slice(0, 40).map((r) => ({
    when: r.when,
    rating: r.rating,
    tag: r.tag,
    tagLabel: labelFor(r.tag),
    role: r.role,
    by: r.by,
    excerpt: (r.excerpt || '').slice(0, 140),
  }));

  return { total, up, down, pctPositive: total ? Math.round((up / total) * 100) : 0, byTag, byRole, tagByRole, overTime, recent };
}

const app = express();

app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.get('/api/stats', async (_req, res) => {
  try {
    const rows = await loadFeedback();
    res.json(summarise(rows));
  } catch (err) {
    console.error('[feedback-dash] stats error:', err);
    res.status(500).json({ error: 'failed to load feedback', detail: String(err.message || err) });
  }
});

app.get('/', (_req, res) => res.type('html').send(PAGE));

app.listen(PORT, () => console.log(`[feedback-dash] listening on :${PORT} — Mongo ${MONGO_URI}`));

// --- the single-page dashboard (Chart.js from CDN, loaded by the browser) ----
const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Wiseway · Feedback Dashboard</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js"></script>
<style>
  :root { --up:#1f9d55; --down:#d64545; --ink:#1a2230; --muted:#6b7685; --line:#e4e8ee; --bg:#f4f6f9; }
  * { box-sizing: border-box; }
  body { margin:0; font:15px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif; color:var(--ink); background:var(--bg); }
  header { background:var(--ink); color:#fff; padding:18px 28px; display:flex; align-items:baseline; gap:14px; }
  header h1 { font-size:18px; margin:0; font-weight:650; letter-spacing:.2px; }
  header .sub { color:#9fb0c4; font-size:13px; }
  header .note { margin-left:auto; font-size:12px; color:#f0c674; }
  main { max-width:1180px; margin:0 auto; padding:24px 28px 60px; }
  .kpis { display:grid; grid-template-columns:repeat(4,1fr); gap:16px; margin-bottom:24px; }
  .kpi { background:#fff; border:1px solid var(--line); border-radius:12px; padding:16px 18px; }
  .kpi .n { font-size:30px; font-weight:700; }
  .kpi .l { color:var(--muted); font-size:13px; }
  .kpi.up .n { color:var(--up); } .kpi.down .n { color:var(--down); }
  .grid { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
  .card { background:#fff; border:1px solid var(--line); border-radius:12px; padding:16px 18px; }
  .card h2 { font-size:14px; margin:0 0 12px; color:var(--muted); font-weight:600; text-transform:uppercase; letter-spacing:.4px; }
  .card.wide { grid-column:1 / -1; }
  .cardhead { display:flex; align-items:center; justify-content:space-between; }
  .cardhead h2 { margin:0 0 12px; }
  .toggle { display:inline-flex; border:1px solid var(--line); border-radius:8px; overflow:hidden; }
  .toggle button { border:0; background:#fff; color:var(--muted); padding:5px 12px; font-size:12.5px; font-weight:600; cursor:pointer; }
  .toggle button + button { border-left:1px solid var(--line); }
  .toggle button.on { background:var(--ink); color:#fff; }
  table { width:100%; border-collapse:collapse; font-size:13.5px; }
  th,td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--muted); font-weight:600; }
  .pill { display:inline-block; padding:1px 8px; border-radius:999px; font-size:12px; font-weight:600; }
  .pill.up { background:#e6f4ec; color:var(--up); } .pill.down { background:#fbeaea; color:var(--down); }
  .empty { text-align:center; color:var(--muted); padding:60px 0; }
  canvas { max-height:280px; }
  #cTagRole { max-height:440px; }
  .muted { color:var(--muted); }
</style>
</head>
<body>
<header>
  <h1>Wiseway Feedback</h1>
  <span class="sub">staff ratings on assistant answers</span>
  <span class="note">PoC · read-only · no auth — gate behind admin SSO before prod</span>
</header>
<main id="app"><div class="empty">Loading…</div></main>
<script>
const palette = { up:'#1f9d55', down:'#d64545' };
// Distinct, colour-blind-friendlier hues for the per-role split.
const rolePalette = ['#2c7fb8','#7b3294','#d95f0e','#1b9e77','#e7298a','#66a61e','#8c6d31'];
const colorForRole = (role, i) => rolePalette[i % rolePalette.length];
const fmtDate = (d) => new Date(d).toLocaleString('en-AU', { dateStyle:'medium', timeStyle:'short' });

async function load() {
  const r = await fetch('api/stats');
  const s = await r.json();
  const app = document.getElementById('app');
  if (!s.total) {
    app.innerHTML = '<div class="empty"><h2>No feedback yet</h2><p class="muted">When staff thumbs-up or thumbs-down an answer in LibreChat, it shows up here.</p></div>';
    return;
  }
  app.innerHTML = \`
    <section class="kpis">
      <div class="kpi"><div class="n">\${s.total}</div><div class="l">Total ratings</div></div>
      <div class="kpi up"><div class="n">\${s.up}</div><div class="l">👍 Thumbs up</div></div>
      <div class="kpi down"><div class="n">\${s.down}</div><div class="l">👎 Thumbs down</div></div>
      <div class="kpi"><div class="n">\${s.pctPositive}%</div><div class="l">Positive</div></div>
    </section>
    <section class="grid">
      <div class="card"><h2>Sentiment split</h2><canvas id="cSplit"></canvas></div>
      <div class="card"><h2>By reason tag</h2><canvas id="cTags"></canvas></div>
      <div class="card"><h2>By staff role</h2><canvas id="cRoles"></canvas></div>
      <div class="card"><h2>Over time</h2><canvas id="cTime"></canvas></div>
      <div class="card wide">
        <div class="cardhead">
          <h2>Reason tag · split by role</h2>
          <div class="toggle" id="tagRoleToggle">
            <button data-mode="counts" class="on">Counts</button><button data-mode="pct">100%</button>
          </div>
        </div>
        <canvas id="cTagRole"></canvas>
      </div>
      <div class="card wide"><h2>Recent feedback</h2>
        <table><thead><tr><th>When</th><th>Rating</th><th>Reason</th><th>Role</th><th>Answer excerpt</th></tr></thead>
        <tbody>\${s.recent.map(rw => \`<tr>
          <td class="muted">\${fmtDate(rw.when)}</td>
          <td><span class="pill \${rw.rating==='thumbsUp'?'up':'down'}">\${rw.rating==='thumbsUp'?'👍 up':'👎 down'}</span></td>
          <td>\${rw.tagLabel}</td>
          <td class="muted">\${rw.role}</td>
          <td class="muted">\${(rw.excerpt||'').replace(/</g,'&lt;') || '—'}</td>
        </tr>\`).join('')}</tbody></table>
      </div>
    </section>\`;

  new Chart(cSplit, { type:'doughnut',
    data:{ labels:['Thumbs up','Thumbs down'], datasets:[{ data:[s.up,s.down], backgroundColor:[palette.up,palette.down] }] },
    options:{ plugins:{ legend:{ position:'bottom' } } } });

  new Chart(cTags, { type:'bar',
    data:{ labels:s.byTag.map(t=>t.label),
      datasets:[{ data:s.byTag.map(t=>t.count), backgroundColor:s.byTag.map(t=>t.direction==='thumbsUp'?palette.up:palette.down) }] },
    options:{ indexAxis:'y', plugins:{ legend:{ display:false } }, scales:{ x:{ beginAtZero:true, ticks:{ precision:0 } } } } });

  new Chart(cRoles, { type:'bar',
    data:{ labels:s.byRole.map(r=>r.role),
      datasets:[
        { label:'👍 up', data:s.byRole.map(r=>r.thumbsUp), backgroundColor:palette.up },
        { label:'👎 down', data:s.byRole.map(r=>r.thumbsDown), backgroundColor:palette.down } ] },
    options:{ plugins:{ legend:{ position:'bottom' } }, scales:{ x:{ stacked:true }, y:{ stacked:true, beginAtZero:true, ticks:{ precision:0 } } } } });

  // Counts vs 100%: in 'pct' mode each tag's bar is normalised to its own total,
  // so you compare the role *mix* per tag regardless of how many ratings it got.
  let tagRoleChart = null, tagRoleMode = 'counts';
  function renderTagRole() {
    const pct = tagRoleMode === 'pct';
    const tagTotals = s.tagByRole.tags.map((_, ti) => s.tagByRole.datasets.reduce((a, d) => a + d.data[ti], 0));
    const datasets = s.tagByRole.datasets.map((d, i) => ({
      label: d.role,
      data: d.data.map((v, ti) => (pct ? (tagTotals[ti] ? +((v / tagTotals[ti]) * 100).toFixed(1) : 0) : v)),
      backgroundColor: colorForRole(d.role, i),
      stack: 'roles',
    }));
    if (tagRoleChart) tagRoleChart.destroy();
    tagRoleChart = new Chart(cTagRole, { type:'bar',
      data:{ labels:s.tagByRole.tags, datasets },
      options:{ indexAxis:'y',
        plugins:{ legend:{ position:'bottom' },
          tooltip:{ callbacks:{
            label:(it) => it.dataset.label + ': ' + (pct ? it.parsed.x + '%' : it.parsed.x),
            footer:(items) => pct ? '' : 'total: ' + items.reduce((a,b)=>a+b.parsed.x,0) } } },
        scales:{ x:{ stacked:true, beginAtZero:true, max:(pct?100:undefined),
                     ticks:{ precision:0, callback:(v)=> pct ? v+'%' : v } },
                 y:{ stacked:true } } } });
  }
  renderTagRole();
  document.querySelectorAll('#tagRoleToggle button').forEach((b) => b.addEventListener('click', () => {
    tagRoleMode = b.dataset.mode;
    document.querySelectorAll('#tagRoleToggle button').forEach((x) => x.classList.toggle('on', x === b));
    renderTagRole();
  }));

  new Chart(cTime, { type:'line',
    data:{ labels:s.overTime.map(d=>d.day),
      datasets:[
        { label:'👍 up', data:s.overTime.map(d=>d.thumbsUp), borderColor:palette.up, tension:.3 },
        { label:'👎 down', data:s.overTime.map(d=>d.thumbsDown), borderColor:palette.down, tension:.3 } ] },
    options:{ plugins:{ legend:{ position:'bottom' } }, scales:{ y:{ beginAtZero:true, ticks:{ precision:0 } } } } });
}
load().catch(e => { document.getElementById('app').innerHTML = '<div class="empty">Failed to load: '+e+'</div>'; });
</script>
</body>
</html>`;
