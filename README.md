# Baseplate FPS game server

Runs every Baseplate FPS match: the big public battle royale and private matches with codes.
It checks each player's sign-in, decides hits, kills and the zone, and saves stats to Firebase.

On Render: Build command `npm install`, Start command `npm start`.
Environment variable `FIREBASE_SERVICE_ACCOUNT` = the full contents of the Firebase service account key file.
