const tty = process.stdout.isTTY;
const c = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = c(1), dim = c(2), green = c(32), red = c(31), yellow = c(33), blue = c(34);
const COLOR = { paid: green, failed: red, missed: red, cancelled: dim, pending: yellow, due: yellow, scheduled: blue, settled: green };
const short = (h) => (h ? `${h.slice(0, 10)}…${h.slice(-6)}` : "");

export function inWords(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d} d ${h} h` : h ? `${h} h ${m} min` : `${m} min`;
}

export function renderStatus(r) {
  const s = r.schedule;
  const out = ["", bold(`${s.label ?? "Recurring payment"} · ${fmtAmount(s.amount)} USDC ${s.every} → ${s.recipient}`), dim(`payer ${s.payer} · schedule ${s.id.slice(0, 18)}… · chain time ${r.block.iso} (block ${r.block.number})`), ""];
  for (const p of r.periods) {
    const st = (COLOR[p.status] ?? ((x) => x))(p.status.toUpperCase().padEnd(9));
    const detail = p.status === "paid" ? `tx ${short(p.hash)}${p.failures?.length ? dim(`  after ${p.failures.length} failed attempt${p.failures.length > 1 ? "s" : ""}`) : ""}` : p.status === "failed" ? red(`${p.reason} — retrying until ${p.windowEndsIso}`) : p.status === "missed" ? red(p.reason) : p.status === "pending" ? `tx ${short(p.hash)} in flight` : p.status === "cancelled" ? dim(`by the payer, tx ${short(p.hash)}`) : dim(`window until ${p.windowEndsIso}`);
    out.push(`  #${String(p.number).padEnd(3)} ${p.dueIso}  ${st} ${detail}`);
  }
  if (r.next) out.push("", bold("  Next: ") + `#${r.next.number} ${r.next.status === "scheduled" ? `due ${r.next.dueIso} (in ${inWords(r.next.due - r.block.timestamp)})` : `${r.next.status} now — window until ${r.next.windowEndsIso}`}`);
  else out.push("", bold("  Next: ") + "nothing left — every period is settled, missed or cancelled");
  if (r.action) out.push(bold("  This tick: ") + actionText(r.action));
  return out.join("\n");
}

function actionText(a) {
  if (a.kind === "prepared") return `period ${a.period} prepared — unsigned transaction below (${a.note})`;
  if (a.kind === "confirmed") return green(`period ${a.period} paid, tx ${a.hash}`);
  if (a.kind === "failed") return red(`period ${a.period} not paid: ${a.reason}${a.sent ? "" : " — nothing was sent"}`);
  if (a.kind === "pending") return yellow(`period ${a.period}: transaction ${a.hash} still in flight — not sending another`);
  return a.note ?? a.kind;
}

export function renderHistory(events) {
  if (!events.length) return dim("  (no history yet)");
  return events.map((e) => `  ${dim(e.at.slice(0, 19))}  #${e.period}  ${e.type.padEnd(9)} ${e.kind ?? ""}${e.hash ? ` ${short(e.hash)}` : ""}${e.reason ? red(` ${e.reason}`) : ""}${e.source ? dim(` (${e.source})`) : ""}`).join("\n");
}

export function renderForecast(f) {
  const s = f.schedule;
  const out = ["", bold(`${s.label ?? "Recurring payment"} · ${fmtAmount(s.amount)} USDC ${s.every}, ${s.count} payments (${f.total.amount} USDC in all)`), dim(`payer ${s.payer} → ${s.recipient} · schedule ${s.id.slice(0, 18)}… · Pacific block ${f.block.number}`), ""];
  for (const p of f.periods) out.push(`  #${String(p.number).padEnd(3)} ${p.dueIso}  ${(COLOR[p.status] ?? ((x) => x))(p.status.padEnd(9))} ${dim(`window until ${p.windowEndsIso} · nonce ${p.nonce.slice(0, 10)}… ${p.onChain}`)}${p.status === "scheduled" || p.status === "due" ? (p.coveredToday ? green("  covered today") : yellow("  not covered today")) : ""}`);
  out.push("", `  payer balance ${f.payer.balanceText} USDC — covers ${f.payer.covers} payment${f.payer.covers === 1 ? "" : "s"}`);
  out.push(`  gas per payment ${Number(f.gas.perPayment.gas).toLocaleString("en-US")} (${f.gas.perPayment.pros.toFixed(6)} PROS, $${f.gas.perPayment.usd.toFixed(5)}) — paid by ${f.gas.paidBy}`);
  if (f.next) out.push(`  next payment #${f.next.number} on ${f.next.dueIso} (in ${inWords(f.next.inSeconds)})`);
  for (const w of f.warnings) out.push(yellow(`  ! ${w}`));
  out.push("", bold("  To sign once: ") + f.sign.what);
  return out.join("\n");
}

function fmtAmount(v) {
  const x = BigInt(v);
  const f = (x % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return (x / 1_000_000n).toLocaleString("en-US") + (f ? `.${f}` : "");
}
