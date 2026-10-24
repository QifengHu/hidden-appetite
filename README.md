# Hidden Appetite

A small real-time multiplayer trading game for a shared table. Players use separate phones or laptops; the host keeps the room open on a projector.

## Run it

Requires Node.js 18 or newer. From this folder, run:

```sh
node server.js
```

Open `http://localhost:3000` to host. To let phones on the same Wi-Fi join, open `http://<host-computer-LAN-address>:3000` on those devices. For remote play, deploy this folder to a Node hosting service and use its public URL. Keep the host tab open during play; room state is held in server memory.

## How to play

1. Host a room and share the six-character code or invite QR.
2. Choose an offer style and optionally run the practice round. A normal trade gives sellers up to 30 seconds to offer and buyers up to 20 seconds to respond; it ends as soon as every pair finishes.
3. Players are paired randomly. Roles swap between rounds. Players who disconnect are marked away and skipped until they reconnect.
4. Buyers privately see one of three appetite cards. In practice, the kitchen sees all three cards; during real rounds it sees appetite summaries, then chooses one quantity or sets a minimum; buyers accept, veto, or pick a quantity from the menu.
5. After each round, the table sees the appetite card, both coin payoffs, and value left on the table. Practice coins do not affect scores or the Lab Report.

Preset table talk can be switched off. Chat phrases are private to the paired players. With an odd number of players, the host can sit one player out or pair one player with Miso, the simple house bot. Rejoining with the same browser session restores the player identity. New players are blocked after the game starts unless the host enables late joining; those players join the next round.

## Notes

This is a lightweight prototype: rooms are in-memory and disappear when the server restarts. For a public production game, use persistent room storage and an HTTPS deployment. The QR image is rendered by a third-party QR image endpoint and requires internet access on the host screen.
