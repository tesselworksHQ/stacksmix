# stacksmix

Stacks blockchain API traffic over the [Nym mixnet](https://nym.com). Wallet lookups (balances, nonces, tx status)
and transaction broadcasts leak which addresses you own and when you act. Your IP gets tied to them at the API
provider. stacksmix routes every request through the mixnet (Nym `mix-fetch` v3 / smolmix, via an IP Packet Router
exit), so `api.hiro.so` sees a Nym exit node, not you.

- **CLI**: `info`, `balance <addr>`, `nonce <addr>`, `tx <txid>`, `broadcast <hex|@file>`
- **Local gateway**: `proxy [port]` serves `http://127.0.0.1:3999`. Point a stacks.js app or wallet's custom
  API URL at it instead of `https://api.hiro.so`.
- **No clearnet fallback**: if the tunnel fails, the request fails.

## Run

Needs [Deno](https://deno.com) 2.x. Nothing else to install; Deno fetches the npm packages.

```sh
deno run -A --node-modules-dir=none --deny-net=api.hiro.so stacksmix.ts info
deno run -A --node-modules-dir=none --deny-net=api.hiro.so stacksmix.ts balance SP000000000000000000002Q6VF78
deno run -A --node-modules-dir=none --deny-net=api.hiro.so stacksmix.ts proxy 3999
curl http://127.0.0.1:3999/extended/v1/address/SP000000000000000000002Q6VF78/nonces
```

The first call opens the tunnel (about 5-15 s). After that, requests take about 1-3 s each.

Set `STACKSMIX_API` to use another Stacks API host (e.g. your own node). Set `STACKSMIX_DEBUG=1` for tunnel logs.

## Proof it doesn't touch the clearnet

`--deny-net=api.hiro.so` tells Deno's sandbox to refuse **any** direct connection from this process to the API
host. The commands still succeed, so the bytes must have gone through the Nym gateway websocket. Remove the flag
and nothing changes in the output, because the code never calls `fetch` directly. Check it yourself:

```sh
deno run -A --deny-net=api.hiro.so deny_check.ts                                      # -> NotCapable error
deno run -A --node-modules-dir=none --deny-net=api.hiro.so stacksmix.ts info          # -> works, via mixnet
```

Tested 2026-11-08 on Windows 11, Deno 2, mainnet: `info`, `balance`, `nonce`, `tx`, plus the proxy for `/v2/info` and
`/extended/v1/address/*/nonces`.

## Gateway hardening

- binds to `127.0.0.1` only
- forwards only to the configured API host (the path is appended to it; you can't pick another host)
- strips `cookie`, `user-agent`, `origin`, `referer`, `x-forwarded-for` before the request leaves

## Use your own node

With the default host, Hiro no longer sees your IP, but it still logs *which* addresses and txids are asked about.
To remove that third party, run the API yourself. There are two setups.

**A. Node on a server (VPS or home server), queried over the mixnet.** Nobody else logs your lookups, and the
server only ever sees a Nym exit, so a compromised box or a nosy hosting provider still can't tie the lookups to
the IP you browse from.

1. Run a Stacks node plus the Stacks Blockchain API on the server. Hiro's
   [stacks-blockchain-docker](https://github.com/hirosystems/stacks-blockchain-docker) runs both with Docker
   Compose (mainnet needs a full sync and a few hundred GB of disk). The API listens on port 3999.
2. Put it behind HTTPS on port 443 (Caddy or nginx with a certificate for e.g. `stacks.example.org`). Nym exit
   gateways apply an exit policy, and standard HTTPS is the safe choice. Don't expose port 3999 itself.
3. Point stacksmix at it, and deny direct access to that host as well, so the sandbox check still proves that
   nothing leaves outside the mixnet:

```sh
STACKSMIX_API=https://stacks.example.org \
  deno run -A --node-modules-dir=none --deny-net=stacks.example.org,api.hiro.so stacksmix.ts proxy 3999
```

**B. Node on the same machine as the wallet.** Reads are local (`http://127.0.0.1:3999`), so you don't need the
mixnet for them. Broadcasts are a different story: a transaction your node relays first is gossiped from *your*
node's IP. To keep the "who sent it" link off the network, read from the local node and send the signed
transaction through stacksmix with the default host:

```sh
deno run -A --node-modules-dir=none --deny-net=api.hiro.so stacksmix.ts broadcast @signed-tx.hex
```

## Limits

- Speed: mixnet latency plus cover traffic. Fine for wallet use, slow for indexing.
- With the default host, the API provider still sees *what* you ask about (addresses, txids). It just can't tie
  that to your IP. See [Use your own node](#use-your-own-node) to remove the provider.
- Deno shims (forced module Worker, in-worker `fake-indexeddb`) work around mix-fetch v3 targeting browsers.

## License

MIT · built by Tessel Works for Build with Nym (Fall 2026)
