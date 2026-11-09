import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { toJson } from "./schedule.js";

// One folder per schedule: schedule.json (the schedule, the payer's signatures, the block it was signed at) and
// ledger.jsonl — an append-only log, each line flushed to disk before the next step. An intent ("about to send
// period 3") is on disk BEFORE the transaction leaves, and its hash right after.

export function openStore(dir) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "ledger.jsonl");
  const read = () => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return {
    dir,
    schedulePath: join(dir, "schedule.json"),
    saveSchedule(obj) {
      writeFileSync(join(dir, "schedule.json"), JSON.stringify(toJson(obj), null, 2));
    },
    loadSchedule() {
      const p = join(dir, "schedule.json");
      if (!existsSync(p)) throw new Error(`no schedule in ${dir} (create one with: npm run pay -- new <schedule.json>)`);
      return JSON.parse(readFileSync(p, "utf8"));
    },
    events: read,
    append(event) {
      const fd = openSync(file, "a");
      try {
        writeSync(fd, `${JSON.stringify(toJson({ at: new Date().toISOString(), ...event }))}\n`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    },
  };
}
