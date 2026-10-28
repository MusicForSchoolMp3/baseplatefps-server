/* The owner panel. This file lives on the game server and is only ever sent to a signed-in owner (the server checks the
   Google-verified sign-in first), so it isn't on the website at all. Every button here calls the server again, and the
   server checks the sign-in again each time, so even a copy of this code can't do anything for anybody else.
   ctx: { server: 'https://…', token: () => Promise<string> } */
(function (ctx) {
  'use strict';
  if (document.getElementById('ownerPanel')) return;
  const GAMES = { 'baseplate-fps': ['Baseplate FPS', 'baseplate-fps/'], rockleague: ['RockLeague', 'rockleague/'], othercolourbike: ['othercolourbike', 'othercolourbike/'], swellsurf: ['SwellSurf', 'swellsurf/'], highwaybike: ['Highway Bike', 'highwaybike/'] };
  const USER_RE = /^[A-Za-z0-9]{3,20}$/;
  const css = document.createElement('style');
  css.textContent = `
#ownerBtn{position:fixed;right:18px;bottom:18px;z-index:60;padding:11px 16px;border-radius:999px;border:1px solid rgba(255,255,255,.25);background:#14171c;color:#fff;font:700 14px system-ui,sans-serif;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.4)}
#ownerPanel{position:fixed;right:18px;bottom:70px;z-index:60;width:min(460px,calc(100vw - 36px));max-height:min(72vh,640px);display:flex;flex-direction:column;gap:10px;padding:16px;border-radius:10px;border:1px solid rgba(255,255,255,.16);background:#101318;color:#eef2f4;font:14px/1.4 system-ui,sans-serif;box-shadow:0 18px 50px rgba(0,0,0,.55)}
#ownerPanel h2{margin:0;font:800 18px system-ui,sans-serif;letter-spacing:.02em}
#ownerPanel .op-row{display:flex;gap:6px}
#ownerPanel input{flex:1;min-width:0;padding:9px 10px;border-radius:6px;border:1px solid rgba(255,255,255,.18);background:#0a0c10;color:#fff;font:600 14px ui-monospace,monospace;text-transform:none}
#ownerPanel button{padding:8px 12px;border-radius:6px;border:1px solid rgba(255,255,255,.18);background:#1d222a;color:#fff;font:700 13px system-ui,sans-serif;cursor:pointer}
#ownerPanel button.ban{background:#5a1a17;border-color:#a33}
#ownerPanel button.armed{background:#c0392b}
#ownerPanel .op-status{min-height:18px;font-size:13px;color:#aab3bb}
#ownerPanel .op-status.bad{color:#f0675d}#ownerPanel .op-status.good{color:#8fd16f}
#ownerPanel .op-list{overflow:auto;display:grid;gap:6px}
#ownerPanel .op-p{display:grid;grid-template-columns:1fr auto auto;gap:6px;align-items:center;padding:8px 10px;border:1px solid rgba(255,255,255,.1);border-radius:6px}
#ownerPanel .op-p small{display:block;color:#93a0aa;font-size:12px}
#ownerPanel .op-head{display:flex;justify-content:space-between;align-items:center}`;
  document.head.appendChild(css);
  const btn = document.createElement('button'); btn.id = 'ownerBtn'; btn.type = 'button'; btn.textContent = 'Owner panel';
  const box = document.createElement('div'); box.id = 'ownerPanel'; box.hidden = true;
  box.innerHTML = `<div class="op-head"><h2>Owner panel</h2><button type="button" data-x>Close</button></div>
<div class="op-row"><input id="opName" maxlength="20" placeholder="Username" autocomplete="off" spellcheck="false"><button type="button" class="ban" id="opBan">Ban</button><button type="button" id="opUnban">Unban</button></div>
<div class="op-status" id="opStatus" role="status"></div>
<div class="op-head"><strong>Playing right now <span id="opN"></span></strong><button type="button" id="opRefresh">Refresh</button></div>
<div class="op-list" id="opList"></div>
<p style="margin:0;font-size:12px;color:#7d8891">Watch opens their game in a new tab. Nobody can see you watching: you aren't in their match, lists or player counts. Bans kick them out of every game at once.</p>`;
  document.body.append(btn, box);
  const $ = id => document.getElementById(id);
  const status = (t, k) => { const el = $('opStatus'); el.textContent = t || ''; el.className = 'op-status' + (k ? ' ' + k : ''); };
  async function call(path, body) {
    const token = await ctx.token();
    const r = await fetch(ctx.server + path, { method: body ? 'POST' : 'GET', headers: Object.assign({ authorization: 'Bearer ' + token }, body ? { 'content-type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
    let data = {}; try { data = await r.json(); } catch (_) {}
    if (!r.ok) throw new Error(data.error || 'The server said no.');
    return data;
  }
  function arm(b, label, fn) {                                   // tap once to arm, again within 3 s to do it
    if (b.dataset.armed) { delete b.dataset.armed; b.classList.remove('armed'); b.textContent = label; fn(); return; }
    b.dataset.armed = '1'; b.classList.add('armed'); b.textContent = 'Sure?';
    setTimeout(() => { if (b.dataset.armed) { delete b.dataset.armed; b.classList.remove('armed'); b.textContent = label; } }, 3000);
  }
  async function act(kind, name) {
    name = String(name || '').trim();
    if (!USER_RE.test(name)) { status('Type a username (3 to 20 letters and numbers).', 'bad'); return; }
    status((kind === 'ban' ? 'Banning ' : 'Unbanning ') + name + '…');
    try { const r = await call('/admin/' + kind, { name }); status(r.msg, 'good'); refresh(); } catch (e) { status(e.message, 'bad'); }
  }
  function watch(pl) {
    const g = GAMES[pl.game]; if (!g) { status("Can't watch that game.", 'bad'); return; }
    window.open(new URL(g[1] + '?watch=' + encodeURIComponent(pl.name), location.href).href, '_blank', 'noopener');
  }
  async function refresh() {
    const list = $('opList');
    try {
      const { players } = await call('/admin/players');
      $('opN').textContent = '(' + players.length + ')';
      if (!players.length) { list.innerHTML = '<p style="margin:0;color:#93a0aa">Nobody is playing right now.</p>'; return; }
      list.replaceChildren(...players.map(pl => {
        const row = document.createElement('div'); row.className = 'op-p';
        const who = document.createElement('div'); const n = document.createElement('strong'); n.textContent = pl.name;
        const d = document.createElement('small'); d.textContent = (pl.room || (GAMES[pl.game] || [''])[0]) + (pl.kills ? ' · ' + pl.kills + ' kills' : '');
        who.append(n, d); row.append(who);
        const w = document.createElement('button'); w.type = 'button'; w.textContent = 'Watch'; w.onclick = () => watch(pl); row.append(w);
        if (!pl.owner) { const b = document.createElement('button'); b.type = 'button'; b.className = 'ban'; b.textContent = 'Ban'; b.onclick = () => arm(b, 'Ban', () => act('ban', pl.name)); row.append(b); } else row.append(document.createElement('span'));
        return row;
      }));
    } catch (e) { list.innerHTML = ''; status(e.message, 'bad'); }
  }
  let timer = 0;
  btn.onclick = () => { box.hidden = !box.hidden; clearInterval(timer); if (!box.hidden) { refresh(); timer = setInterval(refresh, 6000); } };
  box.querySelector('[data-x]').onclick = () => { box.hidden = true; clearInterval(timer); };
  $('opBan').onclick = e => arm(e.currentTarget, 'Ban', () => act('ban', $('opName').value));
  $('opUnban').onclick = () => act('unban', $('opName').value);
  $('opRefresh').onclick = () => refresh();
  $('opName').addEventListener('input', e => { e.target.value = e.target.value.replace(/[^A-Za-z0-9]/g, '').slice(0, 20); });

  /* ---------- the anti-cheat box: flags from Baseplate FPS, kept until you approve (ban) or reject them ---------- */
  const acCss = document.createElement('style');
  acCss.textContent = `
#acBox{position:fixed;left:50%;top:10px;transform:translateX(-50%);z-index:61;width:min(560px,calc(100vw - 24px));max-height:46vh;overflow:auto;border-radius:10px;border:1px solid rgba(255,90,80,.55);background:rgba(16,19,24,.96);color:#eef2f4;font:14px/1.4 system-ui,sans-serif;box-shadow:0 14px 40px rgba(0,0,0,.5)}
#acBox[hidden]{display:none}
#acBox .ac-h{position:sticky;top:0;display:flex;justify-content:space-between;align-items:center;gap:8px;padding:9px 12px;background:#1a1e25;border-bottom:1px solid rgba(255,255,255,.08);font-weight:800}
#acBox .ac-h small{font-weight:500;color:#93a0aa}
#acBox .ac-f{padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.07);display:grid;gap:6px}
#acBox .ac-t{display:flex;justify-content:space-between;gap:8px;align-items:baseline}
#acBox .ac-t b{color:#ff7a6e}
#acBox .ac-t span{color:#93a0aa;font-size:12px;white-space:nowrap}
#acBox .ac-d{color:#c9d1d7;font-size:13px}
#acBox .ac-b{display:flex;gap:6px;flex-wrap:wrap}
#acBox button,#acReplay button{padding:7px 11px;border-radius:6px;border:1px solid rgba(255,255,255,.18);background:#1d222a;color:#fff;font:700 13px system-ui,sans-serif;cursor:pointer}
#acBox button.ap{background:#5a1a17;border-color:#c0392b}#acBox button.armed{background:#c0392b}
#acBox button.rj{background:#17331f;border-color:#2f7d46}
#acBox .ac-min{background:none;border:0;color:#93a0aa;padding:2px 6px}
#acReplay{position:fixed;inset:0;z-index:62;display:grid;place-items:center;background:rgba(4,6,8,.72);padding:14px}
#acReplay .rp{width:min(980px,100%);max-height:100%;overflow:auto;display:grid;gap:10px;padding:14px;border-radius:10px;background:#101318;color:#eef2f4;font:14px/1.45 system-ui,sans-serif;border:1px solid rgba(255,255,255,.12)}
#acReplay canvas{width:100%;border-radius:8px;background:#22301f;display:block}
#acReplay .rp-c{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
#acReplay input[type=range]{flex:1;min-width:160px}
#acReplay .rp-leg{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;color:#aab4bc}
#acReplay .rp-leg i{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:5px;vertical-align:-1px}`;
  document.head.appendChild(acCss);
  const acBox = document.createElement('div'); acBox.id = 'acBox'; acBox.hidden = true; document.body.appendChild(acBox);
  let acMin = false, acSeen = '';
  const when = t => { const d = new Date(t); return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + ' ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' }); };
  const esc = x => String(x).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  async function acRefresh() {
    let list; try { list = (await call('/admin/flags')).flags || []; } catch (_) { return; }
    const sig = JSON.stringify(list.map(f => [f.id, f.count, acMin]));
    if (sig === acSeen) return; acSeen = sig;
    acBox.hidden = !list.length;
    if (!list.length) { acBox.innerHTML = ''; return; }
    acBox.innerHTML = `<div class="ac-h"><span>⚠ Anti-cheat · ${list.length} to check <small>(only you can see this)</small></span><button class="ac-min" data-min>${acMin ? 'Show' : 'Hide'}</button></div>` + (acMin ? '' : list.map(f => `
<div class="ac-f" data-id="${esc(f.id)}">
  <div class="ac-t"><div><b>${esc(f.name)}</b> · ${esc(f.title)}${f.count > 1 ? ` <span>×${f.count}</span>` : ''}</div><span>${esc(when(f.at))}${f.count > 1 ? ' · last ' + esc(when(f.lastAt)) : ''}</span></div>
  <div class="ac-d">${esc(f.desc)}${f.room ? ` <span style="color:#7d8891">(${esc(f.room)}${f.map ? ', ' + esc(f.map) : ''})</span>` : ''}</div>
  <div class="ac-b">${f.hasReplay ? '<button data-act="replay">▶ Replay last 10 s</button>' : ''}<button class="ap" data-act="approve">Approve (ban)</button><button class="rj" data-act="reject">Reject</button></div>
</div>`).join(''));
  }
  acBox.addEventListener('click', async e => {
    if (e.target.closest('[data-min]')) { acMin = !acMin; acSeen = ''; acRefresh(); return; }
    const b = e.target.closest('[data-act]'); if (!b) return;
    const id = b.closest('[data-id]').dataset.id, act = b.dataset.act;
    if (act === 'replay') { openReplay(id); return; }
    const go = async () => { b.disabled = true; try { const r = await call('/admin/flag', { id, action: act }); status(r.msg || 'Done.', 'good'); } catch (err) { status(err.message, 'bad'); } acSeen = ''; acRefresh(); };
    if (act === 'approve') arm(b, 'Approve (ban)', go); else go();
  });
  acRefresh(); setInterval(acRefresh, 8000);

  /* ---------- the replay: a top-down view of the last 10 seconds ---------- */
  let mapsP = null;
  const loadMaps = () => mapsP || (mapsP = new Promise(res => { if (window.BPMaps) return res(); const sc = document.createElement('script'); sc.src = new URL('baseplate-fps/maps.js', location.href).href; sc.onload = res; sc.onerror = res; document.head.appendChild(sc); }));
  async function openReplay(id) {
    let f; try { f = (await call('/admin/flag?id=' + encodeURIComponent(id))).flag; } catch (err) { status(err.message, 'bad'); return; }
    const R = f.replay; if (!R || !R.frames || !R.frames.length) { status('No replay was saved for this one.', 'bad'); return; }
    await loadMaps();
    const map = window.BPMaps && BPMaps.MAPS[f.map];
    const wrap = document.createElement('div'); wrap.id = 'acReplay';
    wrap.innerHTML = `<div class="rp">
  <div style="display:flex;justify-content:space-between;gap:10px;align-items:start"><div><b style="font-size:18px">${esc(f.name)}</b> · <b style="color:#ff7a6e">${esc(f.title)}</b><div style="color:#93a0aa;font-size:13px">${esc(when(f.at))} · ${esc(f.room || '')} · the 10 seconds before it was flagged</div></div><button data-x>Close</button></div>
  <div style="color:#c9d1d7">${esc(f.desc)}</div>
  <canvas width="960" height="560"></canvas>
  <canvas width="960" height="120" data-g></canvas>
  <div class="rp-c"><button data-play>Pause</button><input type="range" min="0" max="10000" value="0" step="10"><span data-tm style="min-width:64px;text-align:right">0.0 s</span><button data-sp>1×</button></div>
  <div class="rp-leg"><span><i style="background:#ff5a4e"></i>${esc(f.name)} (the long line is where they're looking)</span><span><i style="background:#9fd2ff"></i>other players</span><span><i style="background:#ffd34d"></i>their shots (green = hit counted, orange = refused by the server)</span><span>The graph: how far their aim was from the nearest player (0° = right on them). Red ticks = the moments that caused the flag.</span></div>
</div>`;
    document.body.appendChild(wrap);
    const cv = wrap.querySelector('canvas'), g = cv.getContext('2d'), gv = wrap.querySelector('[data-g]'), gg = gv.getContext('2d');
    const range = wrap.querySelector('input'), tmEl = wrap.querySelector('[data-tm]'), playB = wrap.querySelector('[data-play]'), spB = wrap.querySelector('[data-sp]');
    const dur = Math.max(1000, R.frames[R.frames.length - 1][0]); range.max = String(dur);
    let t = 0, playing = true, speed = 1, last = performance.now(), raf = 0;
    const close = () => { cancelAnimationFrame(raf); wrap.remove(); };
    wrap.querySelector('[data-x]').onclick = close; wrap.addEventListener('click', e => { if (e.target === wrap) close(); });
    playB.onclick = () => { playing = !playing; if (playing && t >= dur) t = 0; playB.textContent = playing ? 'Pause' : 'Play'; };
    spB.onclick = () => { speed = speed === 1 ? 0.5 : speed === 0.5 ? 0.25 : 1; spB.textContent = speed + '×'; };
    range.oninput = () => { t = +range.value; };
    // where everyone was at time t (between two saved moments)
    function at(tt) {
      const F = R.frames; let i = 0; while (i < F.length - 1 && F[i + 1][0] <= tt) i++;
      const A = F[i], B = F[Math.min(F.length - 1, i + 1)], k = B[0] > A[0] ? Math.min(1, Math.max(0, (tt - A[0]) / (B[0] - A[0]))) : 0, out = [];
      for (const e of A[1]) { const o = B[1].find(x => x[0] === e[0]) || e; out.push({ id: e[0], x: e[1] + (o[1] - e[1]) * k, z: e[2] + (o[2] - e[2]) * k, y: e[3] + (o[3] - e[3]) * k, yaw: e[4], al: o[6], team: e[7] }); }
      return out;
    }
    function viewAt(tt) {
      const V = R.views; if (!V.length) return null; let i = 0; while (i < V.length - 1 && V[i + 1][0] <= tt) i++;
      const A = V[i], B = V[Math.min(V.length - 1, i + 1)], k = B[0] > A[0] ? Math.min(1, Math.max(0, (tt - A[0]) / (B[0] - A[0]))) : 0;
      let dy = B[1] - A[1]; while (dy > Math.PI) dy -= 2 * Math.PI; while (dy < -Math.PI) dy += 2 * Math.PI;
      return [A[1] + dy * k, A[2] + (B[2] - A[2]) * k];
    }
    // frame the suspect's whole path
    let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
    for (const fr of R.frames) for (const e of fr[1]) if (e[0] === R.me) { x0 = Math.min(x0, e[1]); x1 = Math.max(x1, e[1]); z0 = Math.min(z0, e[2]); z1 = Math.max(z1, e[2]); }
    if (x0 > x1) { x0 = -30; x1 = 30; z0 = -20; z1 = 20; }
    const pad = 28, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, sc = Math.min(cv.width / (x1 - x0 + pad * 2), cv.height / (z1 - z0 + pad * 2));
    const X = x => cv.width / 2 + (x - cx) * sc, Z = z => cv.height / 2 + (z - cz) * sc;
    // the aim graph: degrees from the nearest other player, over the whole replay
    const graph = R.views.map(v => {
      const ps = at(v[0]), me = ps.find(p => p.id === R.me); if (!me) return [v[0], null];
      const d = [-Math.sin(v[1]) * Math.cos(v[2]), Math.sin(v[2]), -Math.cos(v[1]) * Math.cos(v[2])]; let best = null;
      for (const p of ps) { if (p.id === R.me || !p.al || (R.mode === 'tdm' && p.team === R.team)) continue; const to = [p.x - me.x, p.y + 1.2 - (me.y + 1.65), p.z - me.z], l = Math.hypot(...to); if (l < 2) continue; const a = Math.acos(Math.max(-1, Math.min(1, (d[0] * to[0] + d[1] * to[1] + d[2] * to[2]) / l))) * 180 / Math.PI; if (best == null || a < best) best = a; }
      return [v[0], best];
    });
    function draw() {
      g.fillStyle = '#26351f'; g.fillRect(0, 0, cv.width, cv.height);
      g.strokeStyle = 'rgba(255,255,255,.05)'; g.lineWidth = 1;
      for (let gx = Math.floor((cx - cv.width / sc / 2) / 10) * 10; gx < cx + cv.width / sc / 2; gx += 10) { g.beginPath(); g.moveTo(X(gx), 0); g.lineTo(X(gx), cv.height); g.stroke(); }
      for (let gz = Math.floor((cz - cv.height / sc / 2) / 10) * 10; gz < cz + cv.height / sc / 2; gz += 10) { g.beginPath(); g.moveTo(0, Z(gz)); g.lineTo(cv.width, Z(gz)); g.stroke(); }
      if (map) for (const b of map.boxes) { const h = b.y1 - b.y0; if (b.y1 < 0.4) continue; g.fillStyle = h > 2.5 ? '#5b616a' : h > 1.2 ? '#767c84' : '#8f9399'; g.fillRect(X(b.x0), Z(b.z0), Math.max(1, (b.x1 - b.x0) * sc), Math.max(1, (b.z1 - b.z0) * sc)); }
      const ps = at(t), me = ps.find(p => p.id === R.me), v = viewAt(t);
      // their shots, fading out
      for (const s of R.shots) { const age = t - s[0]; if (age < 0 || age > 450) continue; const k = 1 - age / 450; g.strokeStyle = s[6] === 1 ? `rgba(80,230,120,${k})` : s[6] === -1 ? `rgba(255,150,40,${k})` : `rgba(255,211,77,${k * 0.8})`; g.lineWidth = 2; const L = Math.hypot(s[3], s[4]) || 1; g.beginPath(); g.moveTo(X(s[1]), Z(s[2])); g.lineTo(X(s[1] + s[3] / L * 120), Z(s[2] + s[4] / L * 120)); g.stroke(); }
      g.font = '600 12px system-ui,sans-serif'; g.textAlign = 'center';
      for (const p of ps) {
        const isMe = p.id === R.me, px = X(p.x), pz = Z(p.z);
        g.globalAlpha = p.al ? 1 : 0.35;
        if (isMe && v) { const dx = -Math.sin(v[0]), dz = -Math.cos(v[0]); g.strokeStyle = 'rgba(255,90,78,.9)'; g.lineWidth = 2; g.beginPath(); g.moveTo(px, pz); g.lineTo(X(p.x + dx * 140), Z(p.z + dz * 140)); g.stroke(); }
        else { g.strokeStyle = 'rgba(159,210,255,.7)'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(px, pz); g.lineTo(px - Math.sin(p.yaw) * 14, pz - Math.cos(p.yaw) * 14); g.stroke(); }
        g.fillStyle = isMe ? '#ff5a4e' : '#9fd2ff'; g.beginPath(); g.arc(px, pz, isMe ? 7 : 5.5, 0, Math.PI * 2); g.fill();
        g.fillStyle = '#fff'; g.fillText((R.names && R.names[p.id]) || '', px, pz - 10);
        g.globalAlpha = 1;
      }
      // what happened right now
      const m = (R.marks || []).filter(x => Math.abs(x[0] - t) < 400).map(x => x[1]);
      if (m.length) { g.textAlign = 'left'; g.font = '700 15px system-ui,sans-serif'; g.fillStyle = '#ff7a6e'; g.fillText('⚠ ' + m[0], 14, 24); }
      // the aim graph
      gg.fillStyle = '#151a20'; gg.fillRect(0, 0, gv.width, gv.height);
      const GX = tt => tt / dur * gv.width, GY = a => gv.height - 14 - Math.min(45, a) / 45 * (gv.height - 24);
      gg.strokeStyle = 'rgba(255,255,255,.08)'; for (const a of [0, 15, 30, 45]) { gg.beginPath(); gg.moveTo(0, GY(a)); gg.lineTo(gv.width, GY(a)); gg.stroke(); }
      gg.fillStyle = '#7d8891'; gg.font = '11px system-ui,sans-serif'; gg.textAlign = 'left'; for (const a of [0, 15, 30, 45]) gg.fillText(a + '°', 4, GY(a) - 2);
      for (const mk of R.marks || []) { gg.fillStyle = 'rgba(255,80,70,.85)'; gg.fillRect(GX(mk[0]) - 1, 0, 2, 10); }
      for (const s of R.shots) { gg.fillStyle = s[6] === 1 ? '#50e678' : s[6] === -1 ? '#ff9628' : 'rgba(255,211,77,.6)'; gg.fillRect(GX(s[0]) - 1, gv.height - 10, 2, 10); }
      gg.strokeStyle = '#ff5a4e'; gg.lineWidth = 1.6; gg.beginPath(); let on = false;
      for (const [tt, a] of graph) { if (a == null) { on = false; continue; } if (!on) { gg.moveTo(GX(tt), GY(a)); on = true; } else gg.lineTo(GX(tt), GY(a)); }
      gg.stroke();
      gg.fillStyle = '#fff'; gg.fillRect(GX(t) - 1, 0, 2, gv.height);
    }
    function loop(now) {
      raf = requestAnimationFrame(loop);
      const dt = now - last; last = now;
      if (playing) { t += dt * speed; if (t >= dur) { t = dur; playing = false; playB.textContent = 'Play'; } range.value = String(Math.round(t)); }
      tmEl.textContent = (t / 1000).toFixed(1) + ' s';
      draw();
    }
    raf = requestAnimationFrame(loop);
  }
})(ctx);
