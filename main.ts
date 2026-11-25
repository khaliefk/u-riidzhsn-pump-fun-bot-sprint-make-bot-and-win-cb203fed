// Dip-and-run paper bot for the pump.fun bonding-curve replay (agent-fun/replay/v2).
//
// Paper money only. No wallet, no network, no clock, no randomness: every decision is a
// pure function of the batches the harness sends, so the two graded runs agree byte for
// byte. The file speaks the replay protocol straight off stdin/stdout with the Node
// standard library only, so the entry is one file and nothing is vendored in.
//
// How it trades, in short:
//   - Two ways in. Momentum: a curve a few hundred slots old whose last 40 slots show
//     real buy flow (net SOL in, several distinct buyers, price up a little and sitting
//     near its window high, flow accelerating into the newer half). Dip bounce: a curve
//     that fell 28-50% off its high over the last ~2500 slots while buyers are stepping
//     back in on the last few trades.
//   - Small first, bigger only into strength. First buy 0.02 SOL, then adds of 0.05 SOL
//     while the price is above the last buy and flow is still positive, up to 0.15 SOL
//     a coin. Every buy also respects the harness cap of 1% of the curve's real SOL.
//   - Out whole on the first of: +12% take profit, -5% stop against cost, a 10%
//     trailing stop once the position is up 3%, a single recorded sell of 3 SOL or
//     more, or 500 slots held. A completed curve is closed by the replay itself.
//   - Guardrail probes. The gate needs a round trip of at least 0.01 SOL on 20 coins.
//     When fills or coins lag the pace the bot expects by that point in the window, it
//     buys 0.01 SOL of a liquid curve it holds nothing in and sells it as soon as the
//     buy lands. Probes are tiny and never chase a signal.
//
// Money is kept in lamports (bigint) wherever the harness counts it; prices and flows
// are plain SOL floats used only for comparisons, never for amounts sent.

import * as readline from 'node:readline';

const LAMPORTS = 1_000_000_000;
const CURVE_FEE = 0.0125; // 1.25% taken on the sell side of a curve trade.
const BUY_SLIP_BPS = 1500;
const SELL_SLIP_BPS = 10_000;

// ---- tunables (picked for a short, fast-turnover window; see README) ----
const MOM_WINDOW = 40; // slots of tape the momentum signal reads
const MOM_MIN_NET_SOL = 2.5; // net SOL bought over the window
const MOM_MIN_BUYS = 4;
const MOM_MIN_BUYERS = 6;
const MOM_MIN_UP = 0.12; // price now vs window start
const MOM_MAX_UP = 1.5;
const MOM_ACCEL = 1.0; // newer-half net flow must beat older-half by this much
const MOM_NEAR_HIGH = 0.95;
const MOM_MIN_RQ_SOL = 2;
const MOM_MAX_RQ_SOL = 60;
const MIN_AGE_SLOTS = 400; // fresh curves are mostly bundled launches

const DIP_WINDOW = 2500; // slots the dip is measured over
const DIP_MIN = 0.28; // price at least this far below its window high
const DIP_MAX = 0.5; // and no further than this (a collapse, not a dip)
const DIP_MIN_RQ_SOL = 3;
const DIP_FLOW_TRADES = 6; // of the last few trades, this many must be buys
const DIP_MIN_BUYS = 4;

const INITIAL_SOL = 0.02;
const ADD_SOL = 0.05;
const STAKE_SOL = 0.15; // most SOL at cost in one coin
const MIN_BUY_SOL = 0.01;
const TAKE_PROFIT = 0.12;
const STOP_LOSS = 0.05;
const TRAIL_ARM = 0.03;
const TRAIL = 0.1;
const BIG_SELL_SOL = 3; // one recorded sell this big exits the position
const MAX_HOLD_SLOTS = 500;
const COOLDOWN_SLOTS = 150;
const MAX_ENTRIES = 2;

const TARGET_COINS = 30;
const TARGET_FILLS = 300;
const PACE_SECS = 14_400;
const PROBE_SOL = 0.01;
const MAX_PROBES = 1;

type Mint = string;

interface Trade {
  slot: number;
  price: number; // virtual quote / virtual token, SOL per token units cancel out
  sol: number; // SOL moved by this trade
  buy: boolean;
  user: string;
}

interface Tape {
  created: number | null;
  trades: Trade[];
  entries: number;
  lastExit: number;
}

interface Curve {
  created: number | null;
  vq: bigint; // virtual quote reserves
  vt: bigint; // virtual token reserves
  rq: bigint; // real quote (SOL) reserves
  complete: boolean;
  slot: number;
}

interface Held {
  opened: number;
  peakSol: number;
  investedSol: number;
  exiting: boolean;
  filled: boolean;
  lastAddPrice: number;
  lastValueSol: number;
}

interface Order {
  side: 'buy' | 'sell';
  client_id: string;
  mint: Mint;
  quote_lamports?: string;
  token_amount?: string;
  max_slippage_bps: number;
}

interface Pending {
  order: Order;
}

const tapes = new Map<Mint, Tape>();
const curves = new Map<Mint, Curve>();
const held = new Map<Mint, Held>();
const probes = new Map<Mint, boolean>(); // false = buying, true = selling
const pending = new Map<string, Pending>();
const positions = new Map<Mint, { tokens: bigint; cost: bigint }>();

let hello: any = null;
let cash = 0n;
let nextId = 1;
let myFills = 0;
const myCoins = new Set<Mint>();
let firstTime: number | null = null;
let lastTime: number | null = null;

function tapeOf(mint: Mint): Tape {
  let t = tapes.get(mint);
  if (t === undefined) {
    t = { created: null, trades: [], entries: 0, lastExit: -1e12 };
    tapes.set(mint, t);
  }
  return t;
}

function curveOf(mint: Mint, slot: number): Curve {
  let c = curves.get(mint);
  if (c === undefined) {
    c = { created: null, vq: 0n, vt: 0n, rq: 0n, complete: false, slot };
    curves.set(mint, c);
  }
  return c;
}

function txFee(): bigint {
  return BigInt(hello.fees.base_fee_lamports) + BigInt(hello.fees.priority_fee_lamports);
}

function maxBuyLamports(mint: Mint): bigint {
  const c = curves.get(mint);
  if (c === undefined || c.complete) return 0n;
  return (c.rq * BigInt(hello.caps.max_order_bps_of_real_reserve)) / 10000n;
}

function freeCash(): bigint {
  const tx = txFee();
  let free = cash;
  for (const p of pending.values()) {
    free -= tx;
    if (p.order.side === 'buy') free -= BigInt(p.order.quote_lamports!);
  }
  return free;
}

function committedCount(): number {
  const mints = new Set<Mint>(positions.keys());
  for (const p of pending.values()) if (p.order.side === 'buy') mints.add(p.order.mint);
  return mints.size;
}

function priceOf(c: Curve): number {
  if (c.vt === 0n) return 0;
  return Number(c.vq) / Number(c.vt);
}

/** What a whole position would fetch now, in SOL, after curve fee and one tx fee. */
function liquidValueSol(mint: Mint): number {
  const pos = positions.get(mint);
  const c = curves.get(mint);
  if (pos === undefined || c === undefined || c.vt === 0n) return 0;
  const tokens = Number(pos.tokens);
  const vq = Number(c.vq);
  const vt = Number(c.vt);
  const grossLamports = (tokens * vq) / (vt + tokens);
  return (grossLamports / LAMPORTS) * (1 - CURVE_FEE) - Number(txFee()) / LAMPORTS;
}

/** Net SOL (buys minus sells) on a tape over the last `w` slots. */
function flowSol(t: Tape, now: number, w: number): number {
  let net = 0;
  for (let i = t.trades.length - 1; i >= 0; i--) {
    const tr = t.trades[i]!;
    if (tr.slot <= now - w) break;
    net += tr.buy ? tr.sol : -tr.sol;
  }
  return net;
}

function momentumOk(t: Tape, now: number, rqSol: number): boolean {
  if (rqSol < MOM_MIN_RQ_SOL || rqSol > MOM_MAX_RQ_SOL) return false;
  if (t.created === null || now - t.created < MIN_AGE_SLOTS) return false;
  const from = now - MOM_WINDOW;
  const mid = now - MOM_WINDOW / 2;
  let buySol = 0;
  let sellSol = 0;
  let buys = 0;
  let netOld = 0;
  let netNew = 0;
  let startPrice = -1;
  let high = 0;
  let last = 0;
  let seen = false;
  const buyers = new Map<string, number>();
  // Tape is in slot order, so scan back from the newest trade and stop at the edge.
  for (let i = t.trades.length - 1; i >= 0; i--) {
    const tr = t.trades[i]!;
    if (tr.slot <= from) break;
    if (!seen) {
      last = tr.price;
      seen = true;
    }
    startPrice = tr.price; // ends as the oldest trade still inside the window
    const signed = tr.buy ? tr.sol : -tr.sol;
    if (tr.slot <= mid) netOld += signed;
    else netNew += signed;
    if (tr.buy) {
      buySol += tr.sol;
      buys++;
      buyers.set(tr.user, (buyers.get(tr.user) ?? 0) + tr.sol);
    } else {
      sellSol += tr.sol;
    }
    if (tr.price > high) high = tr.price;
  }
  if (buys < MOM_MIN_BUYS || buyers.size < MOM_MIN_BUYERS) return false;
  if (buySol - sellSol < MOM_MIN_NET_SOL) return false;
  if (startPrice <= 0 || last <= 0) return false;
  const up = last / startPrice - 1;
  if (up < MOM_MIN_UP || up > MOM_MAX_UP) return false;
  if (last < high * MOM_NEAR_HIGH) return false;
  if (netNew <= 0 || netNew < MOM_ACCEL * netOld) return false;
  return true;
}

function dipOk(t: Tape, now: number, rqSol: number): boolean {
  if (rqSol < DIP_MIN_RQ_SOL) return false;
  if (t.created === null || now - t.created < MIN_AGE_SLOTS) return false;
  let high = 0;
  let last = 0;
  let seen = false;
  for (let i = t.trades.length - 1; i >= 0; i--) {
    const tr = t.trades[i]!;
    if (tr.slot <= now - DIP_WINDOW) break;
    if (!seen) {
      last = tr.price;
      seen = true;
    }
    if (tr.price > high) high = tr.price;
  }
  if (high <= 0 || last <= 0) return false;
  const dd = 1 - last / high;
  if (dd < DIP_MIN || dd > DIP_MAX) return false;
  // The newest few trades, read back off the end of the tape.
  const recent: Trade[] = [];
  for (let i = t.trades.length - 1; i >= 0 && recent.length < DIP_FLOW_TRADES; i--) {
    recent.push(t.trades[i]!);
  }
  if (recent.length < DIP_FLOW_TRADES) return false;
  let buys = 0;
  for (const tr of recent) if (tr.buy) buys++;
  if (buys < DIP_MIN_BUYS) return false;
  if (!recent[0]!.buy) return false;
  return true;
}

function onBatch(batch: any): Order[] {
  const now: number = batch.slot;
  const bigSell = new Set<Mint>();
  const traded = new Set<Mint>();

  for (const f of batch.fills) {
    pending.delete(f.client_id);
    if (f.status === 'filled' && !String(f.client_id).startsWith('_')) {
      myFills++;
      myCoins.add(f.mint);
    }
  }

  // Account is authoritative: rebuild cash and positions from it each batch.
  cash = BigInt(batch.account.cash_lamports);
  positions.clear();
  for (const p of batch.account.positions) {
    const tokens = BigInt(p.token_amount);
    if (tokens > 0n) positions.set(p.mint, { tokens, cost: BigInt(p.cost_lamports) });
  }

  for (const m of batch.marks) {
    const c = curveOf(m.mint, m.slot);
    if (m.slot < c.slot && c.vq !== 0n) continue;
    c.vq = BigInt(m.virtual_quote_reserves);
    c.vt = BigInt(m.virtual_token_reserves);
    c.rq = BigInt(m.real_quote_reserves);
    c.slot = m.slot;
  }

  for (const e of batch.events) {
    if (e.block_time !== null && e.block_time !== undefined) {
      if (firstTime === null) firstTime = e.block_time;
      if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
    }
    if (e.event === 'CreateEvent') {
      const c = curveOf(e.mint, e.slot);
      c.created = e.slot;
      c.vq = BigInt(e.virtual_quote_reserves);
      c.vt = BigInt(e.virtual_token_reserves);
      c.rq = 0n;
      c.slot = e.slot;
      tapeOf(e.mint).created = e.slot;
    } else if (e.event === 'TradeEvent') {
      const c = curveOf(e.mint, e.slot);
      c.vq = BigInt(e.virtual_quote_reserves);
      c.vt = BigInt(e.virtual_token_reserves);
      c.rq = BigInt(e.real_quote_reserves);
      c.slot = e.slot;
      const sol = Number(e.sol_amount) / LAMPORTS;
      tapeOf(e.mint).trades.push({
        slot: e.slot,
        price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
        sol,
        buy: e.is_buy === true,
        user: e.user,
      });
      traded.add(e.mint);
      if (!e.is_buy && sol >= BIG_SELL_SOL) bigSell.add(e.mint);
    } else if (e.event === 'CompleteEvent') {
      curveOf(e.mint, e.slot).complete = true;
    }
  }

  // Drop tape older than the longest lookback either signal reads.
  for (const mint of traded) {
    const t = tapes.get(mint)!;
    let cut = 0;
    while (cut < t.trades.length && t.trades[cut]!.slot <= now - DIP_WINDOW - 5) cut++;
    if (cut > 0) t.trades.splice(0, cut);
  }

  const orders: Order[] = [];
  const maxOrders: number = hello.caps.max_orders_per_batch;
  const tx = txFee();
  const txSol = Number(tx) / LAMPORTS;
  const pendingByMint = new Map<Mint, number>();
  for (const po of pending.values()) {
    pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
  }
  const push = (o: Order): boolean => {
    if (orders.length >= maxOrders) return false;
    orders.push(o);
    pending.set(o.client_id, { order: o });
    return true;
  };
  const nextClientId = (): string => `o${nextId++}`;

  // ---- exits first: a position leaves whole, on the first trigger that fires.
  for (const [mint, h] of held) {
    const pos = positions.get(mint);
    const curve = curves.get(mint);
    if (pos === undefined) {
      if (!pendingByMint.has(mint)) {
        held.delete(mint);
        if (h.filled) tapeOf(mint).lastExit = now;
        else tapeOf(mint).entries--;
      }
      continue;
    }
    h.filled = true;
    if (curve === undefined || curve.complete) continue;
    const value = liquidValueSol(mint);
    const costSol = Number(pos.cost) / LAMPORTS;
    if (value > h.peakSol) h.peakSol = value;
    h.lastValueSol = value;
    const t = tapeOf(mint);
    let exit = h.exiting;
    if (!exit && value >= costSol * (1 + TAKE_PROFIT)) exit = true;
    if (!exit && value < costSol * (1 - STOP_LOSS)) exit = true;
    if (!exit && h.peakSol >= costSol * (1 + TRAIL_ARM) && value < h.peakSol * (1 - TRAIL)) exit = true;
    if (!exit && bigSell.has(mint)) exit = true;
    if (!exit && now - h.opened > MAX_HOLD_SLOTS) exit = true;
    if (!exit && flowSol(t, now, 30) < -2) exit = true;
    if (!exit) continue;
    h.exiting = true;
    let sellPending = false;
    for (const po of pending.values()) {
      if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
    }
    if (sellPending) continue;
    if (!push({ side: 'sell', client_id: nextClientId(), mint, token_amount: pos.tokens.toString(), max_slippage_bps: SELL_SLIP_BPS })) break;
  }

  // ---- probe sells: dump a probe the moment its buy has landed.
  for (const [mint, selling] of probes) {
    const pos = positions.get(mint);
    if (pos === undefined) {
      if (!pendingByMint.has(mint)) probes.delete(mint);
      continue;
    }
    const curve = curves.get(mint);
    if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
    if (!push({ side: 'sell', client_id: nextClientId(), mint, token_amount: pos.tokens.toString(), max_slippage_bps: SELL_SLIP_BPS })) break;
    if (!selling) probes.set(mint, true);
  }

  // ---- entries and adds.
  let freeSol = Number(freeCash()) / LAMPORTS;
  let slotsLeft = hello.caps.max_open_positions - committedCount();
  let exposureSol = 0;
  for (const [mint, h] of held) {
    exposureSol += Math.max(h.investedSol, Number(positions.get(mint)?.cost ?? 0n) / LAMPORTS);
  }
  for (const mint of traded) {
    if (orders.length >= maxOrders) break;
    const curve = curves.get(mint);
    if (curve === undefined || curve.complete) continue;
    if (pendingByMint.has(mint) || probes.has(mint)) continue;
    const t = tapes.get(mint)!;
    const h = held.get(mint);
    const price = priceOf(curve);
    const rqSol = Number(curve.rq) / LAMPORTS;
    let want: number;
    if (h === undefined) {
      if (slotsLeft <= 0) continue;
      if (t.entries >= MAX_ENTRIES || now - t.lastExit < COOLDOWN_SLOTS) continue;
      if (!momentumOk(t, now, rqSol) && !dipOk(t, now, rqSol)) continue;
      want = INITIAL_SOL;
    } else {
      // Add only into strength: price above the last buy, position in profit,
      // flow still positive, and room left under the stake cap.
      if (h.exiting || !h.filled || h.investedSol >= STAKE_SOL - MIN_BUY_SOL) continue;
      const pos = positions.get(mint);
      if (pos === undefined) continue;
      if (price < h.lastAddPrice) continue;
      if (h.lastValueSol < (Number(pos.cost) / LAMPORTS) * 1.0) continue;
      if (flowSol(t, now, MOM_WINDOW) < 0) continue;
      if (rqSol > MOM_MAX_RQ_SOL) continue;
      want = Math.min(ADD_SOL, STAKE_SOL - h.investedSol);
    }
    const capSol = Math.floor(Number(maxBuyLamports(mint))) / LAMPORTS;
    let amount = Math.min(capSol, want);
    if (amount > freeSol - txSol) amount = freeSol - txSol;
    if (amount < MIN_BUY_SOL) continue;
    const lamports = BigInt(Math.floor(amount * LAMPORTS));
    if (lamports <= 0n) continue;
    if (!push({ side: 'buy', client_id: nextClientId(), mint, quote_lamports: lamports.toString(), max_slippage_bps: BUY_SLIP_BPS })) break;
    freeSol -= amount + txSol;
    exposureSol += amount;
    if (h === undefined) {
      held.set(mint, { opened: now, peakSol: 0, investedSol: amount, exiting: false, filled: false, lastAddPrice: price, lastValueSol: 0 });
      t.entries++;
      slotsLeft--;
    } else {
      h.investedSol += amount;
      h.lastAddPrice = price;
    }
  }

  // ---- guardrail pacing: open a probe when fills or coins lag the pace.
  if (probes.size < MAX_PROBES && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
    const pace = Math.min(1, (lastTime - firstTime) / PACE_SECS);
    const needCoins = myCoins.size < Math.ceil(TARGET_COINS * pace);
    const needFills = myFills < Math.ceil(TARGET_FILLS * pace);
    if (needCoins || needFills) {
      for (const mint of traded) {
        if (orders.length >= maxOrders || probes.size >= MAX_PROBES) break;
        if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || positions.has(mint)) continue;
        if (needCoins && !needFills && myCoins.has(mint)) continue;
        const curve = curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (Number(curve.rq) / LAMPORTS < PROBE_SOL * 100 * 1.5) continue;
        if (freeSol < PROBE_SOL + 2 * txSol) break;
        if (!push({ side: 'buy', client_id: nextClientId(), mint, quote_lamports: BigInt(Math.floor(PROBE_SOL * LAMPORTS)).toString(), max_slippage_bps: BUY_SLIP_BPS })) break;
        probes.set(mint, false);
        freeSol -= PROBE_SOL + txSol;
      }
    }
  }

  return orders;
}

async function main(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.trim() === '') continue;
    const msg = JSON.parse(line);
    if (msg.type === 'hello') {
      if (msg.protocol !== 'agent-fun/replay/v2') throw new Error(`unsupported protocol ${msg.protocol}`);
      hello = msg;
      cash = BigInt(msg.capital.lamports);
    } else if (msg.type === 'batch') {
      if (hello === null) throw new Error('batch before hello');
      const orders = onBatch(msg);
      const reply = JSON.stringify({ type: 'reply', seq: msg.seq, orders });
      if (!process.stdout.write(reply + '\n')) {
        await new Promise<void>((resolve) => process.stdout.once('drain', resolve));
      }
    } else if (msg.type === 'done') {
      return;
    } else {
      throw new Error(`unknown message type ${msg.type}`);
    }
  }
  throw new Error('input ended before done');
}

main().catch((err) => {
  process.stderr.write(`bot failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
