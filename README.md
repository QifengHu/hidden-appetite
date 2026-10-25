# Hidden Appetite

A small real-time multiplayer trading game for a shared table. Players use separate phones or laptops; the host keeps the room open on a projector.

## Run it

Requires Node.js 18 or newer. From this folder, run:

```sh
node server.js
```

Open `http://localhost:3000` to host. To let phones on the same Wi-Fi join, open `http://<host-computer-LAN-address>:3000` on those devices. For remote play, deploy this folder to a Node hosting service and use its public URL. Keep the host tab open during play; room state is held in server memory.

## How to play

1. Host one room and project its room code; players join from their phones. No logins are needed.
2. Two practice rounds introduce the game: you play once as the Customer and once as the Kitchen. If you are alone, start practice and Miso 🤖 will play with you.
3. Each round, the customer sends a signal that may be truthful or a bluff (30 seconds). Then the kitchen makes an offer: one serving count in Take it or leave it, or a minimum in The Menu (30 seconds). The customer accepts, chooses an amount from the menu, or vetoes (30 seconds).
4. The customer earns the coins shown on their card; the kitchen earns 10 coins per serving. No deal gives both players 0 coins.
5. Modes alternate in two-round blocks, and roles swap every round. A transition screen announces each mode switch.
6. Follow the live leaderboard during play; press Ready after each reveal to move on together. The end-of-game Lab Report compares the two modes.

Inspired by research on veto bargaining and delegation (Kartik, Kleiner & Van Weelden, 2021).
## Notes

This is a lightweight prototype: rooms are in-memory and disappear when the server restarts. For a public production game, use persistent room storage and an HTTPS deployment. The QR image is rendered by a third-party QR image endpoint and requires internet access on the host screen.
