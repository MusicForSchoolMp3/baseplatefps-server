/* Owner messages and jumpscares.
   Every page on the site (the arcade menu and every game) keeps one small connection here at /notify, signed in with the
   player's own account. Only the owner panel can push anything down it (POST /admin/notify, owner-checked by the server),
   so nobody else can put things on other people's screens. Players can't send anything through it except saying who
   they are once. */
const WebSocket = require('ws');

module.exports = function createNotify({ verifyToken, EMAIL_DOMAIN, isOwnerWho }) {
  const wss = new WebSocket.Server({ noServer: true, maxPayload: 8 * 1024, perMessageDeflate: false });
  const byUid = new Map();                       // uid -> Set(ws)   (one per open tab)
  const MAX_TABS = 8;

  wss.on('connection', ws => {
    ws.alive = true; ws.on('pong', () => { ws.alive = true; });
    let authed = false, msgs = 0;
    const kick = setTimeout(() => { if (!authed) ws.terminate(); }, 20000);   // say who you are, or go
    ws.on('message', async raw => {
      if (++msgs > 4) { ws.terminate(); return; }                                // there's nothing else to say
      if (authed) return;
      let m; try { m = JSON.parse(String(raw)); } catch (_) { ws.terminate(); return; }
      if (!m || m.t !== 'hi' || typeof m.token !== 'string' || m.token.length > 6000) { ws.terminate(); return; }
      let who; try { who = await verifyToken(m.token); } catch (_) { ws.terminate(); return; }
      const name = String(who.email || '').split('@')[0].toLowerCase();
      if (!name || String(who.email).toLowerCase() !== name + '@' + EMAIL_DOMAIN) { ws.terminate(); return; }
      if (ws.readyState !== WebSocket.OPEN) return;
      authed = true; clearTimeout(kick);
      ws.uid = who.uid; ws.name = name; ws.owner = isOwnerWho(who);
      ws.page = String(m.page || '').replace(/[^a-z0-9\/-]/gi, '').slice(0, 40);
      let set = byUid.get(who.uid); if (!set) byUid.set(who.uid, set = new Set());
      if (set.size >= MAX_TABS) { const old = set.values().next().value; set.delete(old); try { old.terminate(); } catch (_) {} }
      set.add(ws);
    });
    ws.on('close', () => {
      clearTimeout(kick);
      const set = ws.uid && byUid.get(ws.uid);
      if (set) { set.delete(ws); if (!set.size) byUid.delete(ws.uid); }
    });
    ws.on('error', () => {});
  });
  // keep the connections alive through Render's idle timeout, and drop dead ones
  setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.alive) { try { ws.terminate(); } catch (_) {} continue; }
      ws.alive = false; try { ws.ping(); } catch (_) {}
    }
  }, 25000).unref();

  const PAGE_NAMES = { '': 'Arcade menu', 'baseplate-fps': 'Baseplate FPS', rockleague: 'RockLeague', othercolourbike: 'othercolourbike', swellsurf: 'SwellSurf', highwaybike: 'Highway Bike' };
  const pageName = p => { const k = String(p || '').split('/').filter(Boolean)[0] || ''; return PAGE_NAMES[k] || 'Arcade'; };
  // everyone with the site open right now (any page), for the owner panel's "send to" list
  function online() {
    const out = [];
    for (const set of byUid.values()) {
      const first = set.values().next().value; if (!first) continue;
      out.push({ name: first.name, owner: !!first.owner, where: [...new Set([...set].map(w => pageName(w.page)))].join(', ') });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }
  // send to everyone (not the owner's own tabs) or to one username; returns how many players it reached
  function push(to, payload) {
    const data = JSON.stringify(payload);
    let players = 0;
    for (const set of byUid.values()) {
      const first = set.values().next().value; if (!first) continue;
      if (to === '*' ? first.owner : first.name !== to) continue;
      let hit = false;
      for (const ws of set) if (ws.readyState === WebSocket.OPEN) { try { ws.send(data); hit = true; } catch (_) {} }
      if (hit) players++;
    }
    return players;
  }
  const handleUpgrade = (req, socket, head) => wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  return { handleUpgrade, online, push };
};
