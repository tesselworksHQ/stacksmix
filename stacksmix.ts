// stacksmix: talk to the Stacks blockchain API over the Nym mixnet.
// CLI:   deno run -A --node-modules-dir=none --deny-net=api.hiro.so stacksmix.ts <cmd> [args]
// Cmds:  info | balance <addr> | nonce <addr> | tx <txid> | broadcast <hex|@file> | proxy [port]
// No clearnet fallback: every request goes through mixFetch; if the tunnel fails, the request fails.

// --- Deno shims for @nymproject/mix-fetch v3 (smolmix) -------------------------------------------
const _Worker = globalThis.Worker;
// deno-lint-ignore no-explicit-any
(globalThis as any).Worker = class extends _Worker {
  constructor(url: string | URL, opts?: WorkerOptions) { super(url, { ...(opts || {}), type: 'module' }); }
};
const _Blob = globalThis.Blob;
// deno-lint-ignore no-explicit-any
(globalThis as any).Blob = class extends _Blob {
  constructor(parts: BlobPart[] = [], opts?: BlobPropertyBag) {
    if (parts.every((p) => typeof p === 'string') && opts && /javascript/.test(opts.type || '')) {
      parts = ["import 'npm:fake-indexeddb@6/auto';\n", ...parts];
    }
    super(parts, opts);
  }
};

const { setupMixTunnel, mixFetch } = await import('npm:@nymproject/mix-fetch@3.0.1');

const API = Deno.env.get('STACKSMIX_API') || 'https://api.hiro.so';
const API_HOST = new URL(API).host;
const quiet = Deno.env.get('STACKSMIX_DEBUG') ? false : true;
const log = (...a: unknown[]) => console.error('[stacksmix]', ...a);

let ready: Promise<void> | null = null;
function tunnel(): Promise<void> {
  if (!ready) {
    const t0 = Date.now();
    log('opening mixnet tunnel…');
    ready = setupMixTunnel({ debug: !quiet, iprAttemptTimeoutMs: 20000, iprMaxAttempts: 4, connectTimeoutMs: 60000 })
      .then(() => log(`tunnel up in ${Date.now() - t0} ms`));
  }
  return ready;
}

async function mf(path: string, init?: RequestInit): Promise<Response> {
  await tunnel();
  return await mixFetch(API + path, init);
}

async function getJson(path: string): Promise<unknown> {
  const r = await mf(path);
  const text = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status} ${path}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

function hexToBytes(hex: string): Uint8Array {
  const h = hex.trim().replace(/^0x/, '');
  if (!/^([0-9a-fA-F]{2})+$/.test(h)) throw new Error('broadcast: not a hex string');
  return Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)));
}

const ADDR = /^S[PMTN][0-9A-HJKMNP-TV-Z]{26,41}(\.[a-zA-Z][\w-]{0,127})?$/;
const TXID = /^(0x)?[0-9a-fA-F]{64}$/;
function need(re: RegExp, v: string | undefined, what: string): string {
  if (!v || !re.test(v)) throw new Error(`expected a ${what}, got: ${v ?? '(nothing)'}`);
  return v;
}

const STX = (micro: string | number) => (Number(micro) / 1e6).toFixed(6) + ' STX';

async function cli(cmd: string, args: string[]) {
  switch (cmd) {
    case 'info': {
      const i = await getJson('/v2/info') as Record<string, unknown>;
      console.log(JSON.stringify({ network_id: i.network_id, stacks_tip_height: i.stacks_tip_height,
        burn_block_height: i.burn_block_height, server_version: i.server_version }, null, 2));
      break;
    }
    case 'balance': {
      const a = need(ADDR, args[0], 'Stacks address (SP…/SM…)');
      const b = await getJson(`/extended/v1/address/${a}/balances`) as { stx: Record<string, string>; fungible_tokens: Record<string, { balance: string }> };
      console.log(`STX       ${STX(b.stx.balance)}  (locked ${STX(b.stx.locked)})`);
      for (const [k, v] of Object.entries(b.fungible_tokens || {})) console.log(`FT        ${k}  ${v.balance}`);
      break;
    }
    case 'nonce': {
      const a = need(ADDR, args[0], 'Stacks address');
      const n = await getJson(`/extended/v1/address/${a}/nonces`) as Record<string, unknown>;
      console.log(JSON.stringify({ possible_next_nonce: n.possible_next_nonce, last_executed_tx_nonce: n.last_executed_tx_nonce,
        detected_missing_nonces: n.detected_missing_nonces }, null, 2));
      break;
    }
    case 'tx': {
      let id = need(TXID, args[0], 'txid (64 hex)');
      if (!id.startsWith('0x')) id = '0x' + id;
      const t = await getJson(`/extended/v1/tx/${id}`) as Record<string, unknown>;
      console.log(JSON.stringify({ tx_id: t.tx_id, tx_status: t.tx_status, tx_type: t.tx_type,
        block_height: t.block_height, fee_rate: t.fee_rate, sender_address: t.sender_address }, null, 2));
      break;
    }
    case 'broadcast': {
      const src = args[0] ?? '';
      const hex = src.startsWith('@') ? await Deno.readTextFile(src.slice(1)) : src;
      const r = await mf('/v2/transactions', { method: 'POST', headers: { 'content-type': 'application/octet-stream' },
        body: hexToBytes(hex) });
      const text = await r.text();
      console.log(text);
      if (!r.ok) Deno.exit(2);
      break;
    }
    case 'proxy': return proxy(Number(args[0] || 3999));
    default:
      console.log('usage: stacksmix.ts info | balance <addr> | nonce <addr> | tx <txid> | broadcast <hex|@file> | proxy [port]');
      Deno.exit(cmd ? 1 : 0);
  }
  Deno.exit(0);
}

// Local gateway: point a wallet / stacks.js app at http://127.0.0.1:3999 instead of https://api.hiro.so.
// Listens on loopback only; forwards only to the configured API host; strips identifying headers.
const DROP = new Set(['host', 'connection', 'cookie', 'origin', 'referer', 'user-agent', 'x-forwarded-for',
  'accept-encoding', 'content-length']);
async function proxy(port: number) {
  await tunnel();
  Deno.serve({ hostname: '127.0.0.1', port, onListen: () => log(`gateway http://127.0.0.1:${port} -> ${API_HOST} via mixnet`) },
    async (req) => {
      const u = new URL(req.url);
      const headers = new Headers();
      for (const [k, v] of req.headers) if (!DROP.has(k.toLowerCase())) headers.set(k, v);
      const body = ['GET', 'HEAD'].includes(req.method) ? undefined : new Uint8Array(await req.arrayBuffer());
      const t0 = Date.now();
      try {
        const r = await mf(u.pathname + u.search, { method: req.method, headers, body });
        const buf = new Uint8Array(await r.arrayBuffer());
        log(`${req.method} ${u.pathname} -> ${r.status} (${Date.now() - t0} ms)`);
        const h = new Headers({ 'content-type': r.headers.get('content-type') || 'application/json',
          'access-control-allow-origin': '*' });
        return new Response(buf, { status: r.status, headers: h });
      } catch (e) {
        log(`${req.method} ${u.pathname} -> mixnet error: ${e}`);
        return new Response(JSON.stringify({ error: 'mixnet request failed', detail: String(e) }), { status: 502 });
      }
    });
}

try {
  await cli(Deno.args[0] ?? '', Deno.args.slice(1));
} catch (e) {
  log('error:', e instanceof Error ? e.message : e);
  Deno.exit(1);
}
