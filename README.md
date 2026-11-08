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

## Limits

- Speed: mixnet latency plus cover traffic. Fine for wallet use, slow for indexing.
- The API provider still sees *what* you ask about (addresses, txids). It just can't tie it to your IP. For full
  privacy, run your own node and point `STACKSMIX_API` at it over the mixnet.
- Deno shims (forced module Worker, in-worker `fake-indexeddb`) work around mix-fetch v3 targeting browsers.

## License

MIT · built by Tessel Works for Build with Nym (Fall 2026)
