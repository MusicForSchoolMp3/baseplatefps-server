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
})(ctx);
