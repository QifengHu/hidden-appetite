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
2. Choose an offer style and start a round. Each round lasts 60 seconds.
3. Players are paired randomly. One sells, one buys; each player swaps role in the next round.
4. Buyers privately see one of three appetite cards. Sellers choose one quantity or set a minimum; buyers accept, veto, or pick a quantity from the menu.
5. After the round, the table sees the appetite card, each player’s points, and potential points left on the table.

Preset table talk can be switched off. With an odd number of players, the host can sit one player out or pair one player with Miso, the simple house bot. Rejoining with the same browser session restores the player identity.

## Notes

This is a lightweight prototype: rooms are in-memory and disappear when the server restarts. For a public production game, use persistent room storage and an HTTPS deployment. The QR image is rendered by a third-party QR image endpoint and requires internet access on the host screen.
