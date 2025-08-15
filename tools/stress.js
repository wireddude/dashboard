#!/usr/bin/env node
// Simple local stress tool to spike CPU, memory, and disk I/O.
// Usage examples:
//   node tools/stress.js --cpu 4 --mem 512 --duration 60
//   node tools/stress.js --io 200 --duration 30
//   node tools/stress.js --cpu 2 --memPct 25 --duration 45

const fs = require('fs');
const os = require('os');
const path = require('path');

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { cpu: 0, mem: 0, memPct: 0, io: 0, duration: 30 };
  for (let i = 0; i < args.length; i++) {
    const k = args[i];
    const v = args[i + 1];
    if (k === '--cpu') out.cpu = Number(v), i++;
    else if (k === '--mem') out.mem = Number(v), i++;
    else if (k === '--memPct') out.memPct = Number(v), i++;
    else if (k === '--io') out.io = Number(v), i++;
    else if (k === '--duration') out.duration = Number(v), i++;
  }
  return out;
}

function busyLoop(stopAt) {
  function spin() {
    while (Date.now() < stopAt) {
      // Burn some CPU cycles
      for (let i = 0; i < 1e6; i++) Math.sqrt(i ^ 3);
      if (Date.now() >= stopAt) break;
    }
  }
  spin();
}

async function consumeMemoryGradual(megabytes) {
  const buffers = [];
  const bytes = megabytes * 1024 * 1024;
  const chunk = 1 * 1024 * 1024;
  let allocated = 0;
  try {
    while (allocated < bytes) {
      const size = Math.min(chunk, bytes - allocated);
      buffers.push(Buffer.alloc(size, 0));
      allocated += size;
      // yield so the OOM killer is less likely to trigger
      await new Promise((r) => setTimeout(r, 5));
    }
  } catch (e) {
    // stop allocating on error
  }
  return buffers;
}

function diskIO(megabytes, stopAt) {
  const tmp = path.join(os.tmpdir(), 'stress-io-' + Date.now());
  fs.mkdirSync(tmp, { recursive: true });
  const chunk = Buffer.alloc(1024 * 1024, 0xaa);
  let written = 0;
  while (Date.now() < stopAt && written < megabytes) {
    const file = path.join(tmp, 'f-' + Math.random().toString(36).slice(2));
    fs.writeFileSync(file, chunk);
    fs.readFileSync(file);
    fs.unlinkSync(file);
    written++;
  }
  try { fs.rmdirSync(tmp, { recursive: true }); } catch {}
}

function clampMemoryTargetMB(totalMemBytes, requestedMB, requestedPct) {
  const totalMB = Math.max(1, Math.floor(totalMemBytes / (1024 * 1024)));
  let targetMB = 0;
  if (requestedPct && requestedPct > 0) targetMB = Math.floor((requestedPct / 100) * totalMB);
  if (requestedMB && requestedMB > 0) targetMB = Math.max(targetMB, requestedMB);
  if (targetMB === 0) return 0;
  const safetyReserveMB = 512; // leave at least 512MB free
  const hardCapMB = Math.max(64, Math.floor(totalMB * 0.5) - safetyReserveMB);
  return Math.max(1, Math.min(targetMB, hardCapMB));
}

async function main() {
  const { cpu, mem, memPct, io, duration } = parseArgs();
  const stopAt = Date.now() + duration * 1000;

  console.log('Starting stress:', { cpu, mem, io, duration });
  let memBlocks = [];
  const targetMemMB = clampMemoryTargetMB(os.totalmem(), mem, memPct);
  if ((mem > 0 || memPct > 0) && targetMemMB > 0) {
    if (mem && targetMemMB < mem) {
      console.log(`Requested --mem ${mem}MB but clamping to safe ${targetMemMB}MB`);
    }
    if (memPct && targetMemMB < Math.floor((memPct / 100) * (os.totalmem() / (1024 * 1024)))) {
      console.log(`Requested --memPct ${memPct}% but clamping to safe ${targetMemMB}MB`);
    }
    memBlocks = await consumeMemoryGradual(targetMemMB);
  }

  const cpuWorkers = [];
  for (let i = 0; i < Math.max(0, cpu); i++) {
    cpuWorkers.push(new Promise((resolve) => {
      setImmediate(() => { busyLoop(stopAt); resolve(); });
    }));
  }

  const ioWorker = io > 0 ? new Promise((resolve) => setImmediate(() => { try { diskIO(io, stopAt); } catch {} resolve(); })) : Promise.resolve();

  await Promise.all([...cpuWorkers, ioWorker]);
  memBlocks = []; // free memory
  console.log('Stress finished.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
