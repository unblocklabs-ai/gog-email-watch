#!/usr/bin/env node

import { appendFileSync, mkdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
appendFileSync(process.env.GOG_TEST_CALLS, `${JSON.stringify(args)}\n`);

const command = args.slice(args.indexOf('gmail'));
// Serialize fixture writes, like Gmail's atomic label updates. Reads see an
// atomic rename, never another child process's partially-written JSON.
const mutates = command[2] === 'create' || command[2] === 'modify';
const lock = `${process.env.GOG_TEST_FIXTURE}.lock`;
if (mutates) {
  while (true) {
    try { mkdirSync(lock); break; }
    catch (error) { if (error.code !== 'EEXIST') throw error; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); }
  }
  process.on('exit', () => rmdirSync(lock));
}
const fixture = JSON.parse(readFileSync(process.env.GOG_TEST_FIXTURE, 'utf8'));
function save() {
  const temporary = `${process.env.GOG_TEST_FIXTURE}.${process.pid}`;
  writeFileSync(temporary, JSON.stringify(fixture));
  renameSync(temporary, process.env.GOG_TEST_FIXTURE);
}
if (fixture.probeWritableDb) {
  const db = new DatabaseSync(process.env.GOG_TEST_DB);
  try {
    db.exec('PRAGMA busy_timeout=5000');
    db.exec('BEGIN IMMEDIATE; COMMIT');
  } finally {
    db.close();
  }
}
let result;
if (command[1] === 'messages' && command[2] === 'search') {
  result = command.includes('--page') ? fixture.pages?.[command[command.indexOf('--page') + 1]] : fixture.search;
  const after = /(?:^|\s)after:(\d+)(?:\s|$)/.exec(command[3]);
  const before = /(?:^|\s)before:(\d+)(?:\s|$)/.exec(command[3]);
  if (result && (after || before)) {
    result = { ...result, messages: result.messages.filter(({ id, threadId }) => {
      const target = fixture.threads?.[threadId]?.thread.messages.find(message => message.id === id);
      // Missing threads still exercise read failures after discovery.
      if (!target) return true;
      const received = Number(target.internalDate) / 1000;
      return (!after || received > Number(after[1])) && (!before || received < Number(before[1]));
    }) };
  }
  if (result && command[3].split(/\s+/).includes('in:inbox')) {
    result = { ...result, messages: result.messages.filter(({ id, threadId }) =>
      fixture.threads?.[threadId]?.thread.messages.some(message => message.id === id && message.labelIds.includes('INBOX'))) };
  }
} else if (command[1] === 'thread' && command[2] === 'get') {
  if (fixture.threadFailOnce?.includes(command[3])) {
    let first = false;
    try { writeFileSync(`${process.env.GOG_TEST_CALLS}.failed-${command[3]}`, '', { flag: 'wx' }); first = true; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (first) { process.stderr.write('controlled transient thread read failure\n'); process.exit(1); }
  }
  if (fixture.threadDelayMs) await new Promise(resolve => setTimeout(resolve, fixture.threadDelayMs));
  result = fixture.threads?.[command[3]];
} else if (command[1] === 'send') {
  writeFileSync(`${process.env.GOG_TEST_CALLS}.body.html`, readFileSync(command[command.indexOf('--body-html-file') + 1]));
  if (fixture.sendFailure) {
    process.stderr.write('controlled fake gog send failure\n');
    process.exit(1);
  }
  const target = command[command.indexOf('--reply-to-message-id') + 1];
  const threadId = Object.values(fixture.threads).find(value => value.thread.messages.some(message => message.id === target))?.thread.id;
  result = fixture.send ?? { messageId: 'cc01', threadId };
} else if (command[1] === 'labels' && command[2] === 'list') {
  if (fixture.labelListFailure) process.exit(1);
  result = { labels: fixture.labels ?? [] };
} else if (command[1] === 'labels' && command[2] === 'create') {
  const label = { name: command[3], id: `Label_${(fixture.labels?.length ?? 0) + 1}` };
  fixture.labels = [...(fixture.labels ?? []), label];
  result = { label };
  save();
} else if (command[1] === 'batch' && command[2] === 'modify') {
  const ids = command.slice(3).filter(value => /^[a-f0-9]+$/.test(value));
  const add = command.includes('--add') ? command[command.indexOf('--add') + 1].split(',') : [];
  const remove = command.includes('--remove') ? command[command.indexOf('--remove') + 1].split(',') : [];
  for (const value of Object.values(fixture.threads)) for (const message of value.thread.messages) {
    if (ids.includes(message.id)) message.labelIds = [...new Set([...message.labelIds.filter(id => !remove.includes(id)), ...add])];
  }
  save();
  result = fixture.modifyUncertain ? {} : { modified: ids, count: ids.length, addedLabels: add, removedLabels: remove };
}

if (result === undefined) {
  process.stderr.write(`unsupported fake gog command: ${command.join(' ')}\n`);
  process.exit(2);
}

process.stdout.write(`${JSON.stringify(result)}\n`);
