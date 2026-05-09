# Flip 7 — online

Mobile-first online version of the push-your-luck card game Flip 7. Built with Node + Express + Socket.IO and vanilla HTML/CSS/JS. Designed to be played on phones.

## Run locally

```bash
npm install
npm start
```

Open `http://localhost:3000` in your browser. To test multiplayer locally, open the URL in another tab/device — phones on the same Wi-Fi can use your computer's LAN IP (e.g. `http://192.168.1.42:3000`).

## Deploy to Render (free, forever)

1. Push this repo to GitHub.
2. Go to [render.com](https://render.com), sign up with GitHub.
3. Click **New → Web Service**, select this repo.
4. Render auto-detects `render.yaml` and creates a free web service.
5. After the first build, your game is live at `https://<name>.onrender.com`.

**Note on the free tier:** Render spins the server down after ~15 min of inactivity. The first request after idle takes ~30 seconds to wake it up. Once a friend opens the link and the server's awake, gameplay is snappy. Tip: open the link yourself first, wait until the lobby loads, then share with friends.

## How to play

- **Goal:** first player to 200 points wins.
- **On your turn:** tap **HIT** to flip a card or **STAY** to bank your round score.
- **Bust:** flip a number you already have → lose all round points (unless a Second Chance saves you).
- **Flip 7:** flip 7 unique numbers in a single round → +15 bonus and the round ends immediately.
- **Action cards:**
  - **Freeze ❄** — pick any active player; they bank their score and are out for the round.
  - **Flip 3 ↻** — pick any active player; they must flip 3 more cards.
  - **Second Chance ⛨** — held passively; saves you from your next bust.
- **Modifier cards:** +2/+4/+6/+8/+10 add to your score; ×2 doubles your number-card total.

## Files

- `server.js` — Socket.IO server + rooms
- `game.js` — game logic, deck, scoring
- `public/index.html` — UI shell
- `public/style.css` — mobile-first styling + animations
- `public/app.js` — client (rendering, sockets)
