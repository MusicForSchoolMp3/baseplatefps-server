# Baseplate Arcade game server (Baseplate FPS + RockLeague + othercolourbike + SwellSurf + Highway Bike)

Runs every match: the big public match and private matches with codes. Each round is free for all,
team deathmatch or last man standing; players vote on the next map and mode between rounds. It checks
each player's sign-in, decides every hit, kill, win and stat, enforces ammo/reloads, blocks shots
through walls and players who walk through walls or fly, and bans accounts that repeatedly open DevTools.
`maps.js` holds the maps and `cosmetics.js` holds every wearable item and its unlock. Both MUST match the copies on the website.
The accounts listed in `OWNERS` in cosmetics.js (just `ben`) have every item unlocked.

On Render:
- Build command: npm install
- Start command: npm start
- Environment variable FIREBASE_SERVICE_ACCOUNT = the full contents of the Firebase service account key file.

Never commit the service account key to GitHub.

Exclusive weapon skins (Nebula Flow, Banana Blaster, Crimson Laser) are never sold. The owners in cosmetics.js have them.
To give one to a friend: in the Firebase console, open Realtime Database, go to users/<their uid> and add
grants -> <skin id> = true (skin ids: nebula, banana, crimson). Players can't write grants themselves.

Moderation: signed in as an owner (Ben), the menu has a Moderation screen to ban or unban any account by username.
The server checks the owner's Firebase sign-in on every request, so nobody else can use it. Bans kick at once.
Accounts listed in SKIN_GRANTS in cosmetics.js (soggybiscuit) have those exclusive skins.

RockLeague (1v1 car football) runs on this same server, on the `/rl` path, in `rockleague.js`. It has its own
connections, rooms and game loop, so it can't affect Baseplate FPS; if it ever failed to load, the FPS game would
carry on as normal. `rl-physics.js` is the car and ball physics and MUST match the copy in the website's rockleague folder.
The server runs every match at 120 steps a second and decides every touch, goal and demolition. Stats are saved
to users/<uid>/rockleague/stats, which players can't write. Bans from the Moderation screen kick people out of
RockLeague too. The arcade page reads /status to show how many people are playing each game.

Super powers (RockLeague): an owner (Ben) presses 9 in a match to switch on super speed, flying and endless jumps.
The server checks the owner's verified sign-in and runs the powers itself, so nobody else can switch them on.
In a match the owner can also press 3 to freeze the other player (3 again unfreezes) and 5 to flip them about.

othercolourbike (the mountain bike game) also runs on this server, on the `/ocb` path, in `othercolourbike.js`, with its own
connections, so it can't affect the other games. `ocb-physics.js` holds the bike physics and the trails and MUST match the copy
in the website's othercolourbike folder. The bike park (public, or private with a code) is relayed here. Leaderboard runs are
sent as the controls pressed on every physics step; the server rides the run again itself and only saves the time and score
it gets, so times can't be faked. Progress is saved to users/<uid>/ocb/progress and leaderboards to ocb/boards (players can't
write either). Bans kick people out of othercolourbike too.

SwellSurf (the surfing game) also runs on this server, on the `/surf` path, in `swellsurf.js`, with its own connections,
so it can't affect the other games. `surf-physics.js` holds the waves and the surfing physics and MUST match the copy in the
website's swellsurf folder. Beaches (up to 6 surfers on the same waves, open or private with a code) and surf contests are run
here. Every scored wave is sent as where the surfer was just before it plus the controls pressed on every physics step; the
server surfs the wave again itself and only saves or counts the score it gets, so scores can't be faked. Best waves are saved
to users/<uid>/surf/best and leaderboards to surf/boards (players can't write either). Bans kick people out of SwellSurf too.

Highway Bike (the motorbike game) also runs on this server, on the `/hb` path, in `highwaybike.js`, with its own connections,
so it can't affect the other games. `hb-sim.js` holds the road (lanes, ramps) and the traffic drivers and MUST match the copy in
the website's highwaybike folder. Public highways take up to 20 riders each; the traffic runs here so everyone on a highway
sees the same cars and the same crashes, and the riders list teleports you near anyone. Bans kick people out of it too.

The owner panel (ban, unban, see who's playing, and watch anyone in any game without being seen) is in `admin-panel.js`. It is
only ever sent to the owner's signed-in arcade page after the server checks the Google-verified sign-in, and every action it
takes is checked again on the server, so nobody else can see it or use it.
