import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Ajv } from 'ajv';
import { GogMailClient, parseConfig, type GmailMessage } from '../src/mail.js';
import { createMailWorkflow, type MailSubagent, type WorkflowOptions } from '../src/workflow.js';
import type { DecisionRuntimeV1, DecisionAnswer, DecisionBatch } from 'openclaw/plugin-sdk/decisions';
import type { AnyAgentTool, OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';
import plugin from '../src/index.js';
import { defaultPolicy } from '../src/policy.js';

const fakeGog = fileURLToPath(new URL('./fixtures/fake-gog.mjs', import.meta.url));
const account = 'agent@example.com';
const approved = 'bek@example.com';

test('manifest admits wakeFrom-only installs and rejects an empty selection', () => {
  const manifest = JSON.parse(readFileSync(new URL('../openclaw.plugin.json', import.meta.url), 'utf8'));
  const validate = new Ajv({ strict: false }).compile(manifest.configSchema);
  for (const selection of [{ settings: { wakeFrom: ['example.com'] } }, { settings: { wakeQuery: 'label:Priority' } }, { domains: ['example.com'] },
    { senders: [approved] }, { triage: { decisionModel: 'typesafe/jev-1.13.0' } }]) {
    const config = { account, ...selection };
    assert.doesNotThrow(() => parseConfig(config));
    assert.equal(validate(config), true, JSON.stringify(validate.errors));
  }
  for (const selection of [{}, { settings: {} }, { settings: { wakeFrom: [] } },
    { domains: [], senders: [], settings: { wakeFrom: [] } }]) {
    const config = { account, ...selection };
    assert.throws(() => parseConfig(config), /configure at least one/);
    assert.equal(validate(config), false);
  }
});

function message(id: string, body: string, options: {
  sender?: string;
  received?: number;
  headers?: Record<string, string>;
} = {}): GmailMessage {
  const sender = options.sender ?? approved;
  const domain = sender.split('@')[1];
  const headers = {
    From: sender,
    To: account,
    Subject: 'Thread test',
    Date: 'Fri, 25 Sep 2026 10:00:00 -0400',
    'Authentication-Results': `mx.google.com; dmarc=pass header.from=${domain}`,
    ...options.headers,
  };
  return {
    id,
    threadId: 'bb01',
    internalDate: String(options.received ?? Date.now()),
    labelIds: ['INBOX'],
    payload: {
      mimeType: 'text/plain',
      headers: Object.entries(headers).map(([name, value]) => ({ name, value })),
      body: { data: Buffer.from(body).toString('base64url') },
    },
  };
}

type Fixture = {
  search: { messages: Array<{ id: string; threadId: string }>; nextPageToken?: string };
  pages?: Record<string, { messages: Array<{ id: string; threadId: string }>; nextPageToken?: string }>;
  threads: Record<string, { thread: { id: string; messages: unknown[] } }>;
  send?: Record<string, unknown>;
  sendFailure?: boolean;
  probeWritableDb?: boolean;
  modifyUncertain?: boolean;
  threadDelayMs?: number;
  threadFailOnce?: string[];
  labelListFailure?: boolean;
  labels?: Array<{ id: string; name: string; type: 'user' | 'system' }>;
};

function fixture(messages: GmailMessage[], search = messages): Fixture {
  return {
    search: { messages: search.map(({ id, threadId }) => ({ id, threadId })) },
    threads: { bb01: { thread: { id: 'bb01', messages } } },
    send: { messageId: 'cc01', threadId: 'bb01' },
    probeWritableDb: true,
  };
}

// Lifecycle scenarios prescribe semantic provider classifications; routing
// itself is independently covered by classification.test.ts.
function labelAnswers(batch: DecisionBatch, attention = 'queue', extra: Record<string, DecisionAnswer> = {}) {
  const routing = attention === 'wake' ? 'Needs attention now' : attention === 'queue' ? 'Needs attention' : attention === 'skip' ? 'No action needed' : undefined;
  return Object.fromEntries(Object.entries(batch.questions).map(([key, question]) => {
    const instructions = typeof question.instructions === 'string' ? question.instructions : '';
    const apply = key === 'deletion_match' ? attention === 'delete' : routing !== undefined && instructions.includes(`Label: ${routing}\n`);
    return [key, extra[key] ?? { type: 'choice' as const, choice: apply ? 'apply' : 'skip', probabilities: {} }];
  }));
}

function assessments(answerFor: (id: string) => Record<string, DecisionAnswer> = () => ({})) {
  let calls = 0;
  const decisions: DecisionRuntimeV1 = { evaluate: async (batch) => {
    calls++;
    const id = (batch.state as { threadId: string }).threadId;
    const prescribed = answerFor(id);
    const attention = prescribed.action?.type === 'choice' ? prescribed.action.choice : 'queue';
    return { status: 'ok', provenance: { providerId: 'typesafe', rubricVersion: 'mail-v1', runtimeGeneration: 'test' }, result: {
      model: 'jev-1.13.0', answers: labelAnswers(batch, attention, prescribed),
    } };
  } };
  return { decisions, decisionModel: () => 'typesafe/jev-1.13.0', calls: () => calls };
}

function triageConfig(config: ReturnType<typeof parseConfig>, triage: Record<string, unknown> = {}) {
  return parseConfig({ ...config, triage: { decisionModel: 'typesafe/jev-1.13.0', ...triage } });
}

function separateThreads(messages: GmailMessage[]): Fixture {
  return { search: { messages: messages.map(({ id, threadId }) => ({ id, threadId })) },
    threads: Object.fromEntries(messages.map(m => [m.threadId, { thread: { id: m.threadId, messages: [m] } }])), probeWritableDb: true };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error('timed out waiting for workflow');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function jobIdFromPrompt(prompt: string): string {
  const id = /^Job ID: ([a-f0-9]{24})$/m.exec(prompt)?.[1];
  assert.ok(id, 'prompt names the active job');
  return id;
}

function transcriptFromPrompt(prompt: string): string {
  const path = /^Full chronological conversation file: (.+)$/m.exec(prompt)?.[1];
  assert.ok(path, 'prompt provides a full conversation file');
  return readFileSync(path, 'utf8');
}

function withHarness(fn: (h: {
  stateDir: string;
  setFixture: (value: Fixture) => void;
  calls: () => string[][];
  sentBody: () => string;
  db: () => DatabaseSync;
  config: ReturnType<typeof parseConfig>;
}) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'gog-email-watch-test-'));
  const stateDir = join(dir, 'state');
  const fixturePath = join(dir, 'fixture.json');
  const callsPath = join(dir, 'calls.jsonl');
  const previous = {
    fixture: process.env.GOG_TEST_FIXTURE,
    calls: process.env.GOG_TEST_CALLS,
    db: process.env.GOG_TEST_DB,
  };
  process.env.GOG_TEST_FIXTURE = fixturePath;
  process.env.GOG_TEST_CALLS = callsPath;
  process.env.GOG_TEST_DB = join(stateDir, 'mail.sqlite');
  writeFileSync(callsPath, '');
  const config = parseConfig({ account, domains: ['example.com'], senders: [], gogPath: fakeGog });
  return fn({
    stateDir,
    setFixture: (value) => writeFileSync(fixturePath, JSON.stringify(value)),
    calls: () => readFileSync(callsPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as string[]),
    sentBody: () => readFileSync(`${callsPath}.body.html`, 'utf8'),
    db: () => new DatabaseSync(join(stateDir, 'mail.sqlite')),
    config,
  }).finally(() => {
    for (const [name, value] of Object.entries({
      GOG_TEST_FIXTURE: previous.fixture,
      GOG_TEST_CALLS: previous.calls,
      GOG_TEST_DB: previous.db,
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });
}

test('wakeFrom bypasses unavailable Jev, coalesces threads and retains dedup across live edits and restart', async t => withHarness(async h => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  h.setFixture(fixture([]));
  let workflow: ReturnType<typeof createMailWorkflow>;
  const covered: string[][] = [];
  const provider = assessments();
  const subagent: MailSubagent = {
    async run({ message: prompt, sessionKey }) {
      const jobId = jobIdFromPrompt(prompt);
      const context = workflow.context(jobId, sessionKey);
      covered.push(context.messages.flatMap(item => item.messageIds));
      assert.equal(context.messages[0].replyAllowed, false, 'wake permission does not grant reply authority');
      await assert.rejects(workflow.reply({ jobId, sessionKey, body: 'Not authorized' }), /rejected/);
      workflow.complete({ jobId, sessionKey, reason: 'Handled' });
      return { runId: jobId };
    },
    async waitForRun() { return { status: 'ok' }; },
  };
  const config = triageConfig(h.config, { policy: { ...defaultPolicy, labels: [{ name: 'Work', description: 'Work mail' }] } });
  workflow = createMailWorkflow({ config, stateDir: h.stateDir, ...provider, subagent });
  async function pollSettled() {
    await waitFor(() => !workflow.status().polling);
    await workflow.poll();
    await waitFor(() => !workflow.status().polling && !workflow.status().working && !workflow.status().triage!.labeling);
  }
  try {
    await workflow.start();
    workflow.policyUpdate(undefined, workflow.policyGet().version, 'helper', { wakeFrom: ['NO-REPLY@other.test', 'OUTSIDE.TEST', 'outside.test'] });
    assert.deepEqual(workflow.policyGet().settings.wakeFrom, ['no-reply@other.test', 'outside.test']);
    const activated = Date.now();
    const first = message('aa01', 'First', { sender: 'no-reply@other.test' });
    const second = message('aa02', 'Second', { sender: 'no-reply@other.test' });
    h.setFixture(fixture([first, second]));
    await pollSettled();
    assert.deepEqual(covered, [['aa01', 'aa02']]);
    assert.equal(provider.calls(), 0, 'the deprecated sender shorthand uses deterministic label classification');
    assert.ok([first, second].every(item => workflow.inspect(item.id)[0].labels?.status === 'done'));
    assert.ok(h.calls().some(args => args.includes('modify')), 'shorthand rules apply their labels through the shared worker');
    await workflow.stop();
    workflow = createMailWorkflow({ config, stateDir: h.stateDir, ...provider, subagent });
    await workflow.start(); await pollSettled();
    assert.equal(covered.length, 1);
    t.mock.timers.setTime(activated + 60000);
    workflow.policyUpdate(undefined, workflow.policyGet().version, 'helper', {
      wakeFrom: [...workflow.policyGet().settings.wakeFrom, 'another@outside.test'],
    });
    const later = message('aa03', 'Earlier domain rule still covers this mail', { sender: 'another@outside.test', received: activated + 30000 });
    h.setFixture(fixture([first, second, later]));
    await pollSettled();
    assert.deepEqual(covered, [['aa01', 'aa02'], ['aa03']]);
    assert.equal(provider.calls(), 0);
    workflow.policyUpdate(undefined, workflow.policyGet().version, 'helper', { wakeFrom: ['no-reply@other.test'] });
    t.mock.timers.setTime(activated + 120000);
    workflow.policyUpdate(undefined, workflow.policyGet().version, 'helper', { wakeFrom: ['no-reply@other.test', 'outside.test'] });
    const disabledPeriod = { ...message('aa04', 'While domain was disabled', { sender: 'fresh@outside.test', received: activated + 90000 }), threadId: 'bb04' };
    const fresh = { ...message('aa05', 'After domain reactivation', { sender: 'fresh@outside.test' }), threadId: 'bb05' };
    h.setFixture(separateThreads([disabledPeriod, fresh]));
    await pollSettled();
    assert.equal(workflow.inspect(disabledPeriod.id)[0].message.status, 'queue', 'preactivation mail still receives ordinary classification');
    assert.deepEqual(covered, [['aa01', 'aa02'], ['aa03'], ['aa05']]);
    assert.equal(provider.calls(), 1, 'only the preactivation message needs semantic classification');
    const nonmatches = ['person@sub.outside.test', 'person@outside.test.attacker.test', 'another@other.test']
      .map((sender, i) => ({ ...message(`aa1${i}`, 'Not allowlisted', { sender }), threadId: `bb1${i}` }));
    h.setFixture(separateThreads(nonmatches));
    await pollSettled();
    assert.equal(covered.length, 3, 'domains are exact; individual addresses do not approve their whole domain');
    for (const item of nonmatches) assert.equal(workflow.inspect(item.id)[0].message.status, 'queue');
    assert.ok(provider.calls() >= nonmatches.length, 'nonmatches still reach Jev');
    assert.throws(() => workflow.policyUpdate(undefined, workflow.policyGet().version, 'helper', { wakeFrom: ['not-an-address'] }), /email|domain/);
  } finally { await workflow.stop(); }
}));

test('ordinary domain and sender label rules wake before unrelated Jev, share label effects and serialize without replay', async t => {
  for (const match of [{ domains: ['outside.test'] }, { senders: ['notify@outside.test'] }]) {
  await t.test('domains' in match ? 'exact domain' : 'exact sender', async () => withHarness(async h => {
  h.setFixture(fixture([]));
  let releaseDecision!: () => void, releaseAgent!: () => void, releaseBusy!: () => void;
  const decisionHeld = new Promise<void>(resolve => { releaseDecision = resolve; });
  const agentHeld = new Promise<void>(resolve => { releaseAgent = resolve; });
  const busyHeld = new Promise<void>(resolve => { releaseBusy = resolve; });
  let decisionsStarted = 0;
  const provider = assessments(() => ({ action: { type: 'choice', choice: 'wake', probabilities: {} } }));
  const decisions: DecisionRuntimeV1 = { evaluate: async (batch, context) => {
    decisionsStarted++;
    if ((batch.state as { threadId: string }).threadId === 'bb01') await decisionHeld;
    return provider.decisions.evaluate(batch, context);
  } };
  let workflow: ReturnType<typeof createMailWorkflow>;
  const runs: Array<{ jobId: string; sessionKey: string; ids: string[] }> = [];
  const config = parseConfig({ ...h.config, settings: { concurrency: 1, agentConcurrency: 1, retryDelaySeconds: 0 },
    triage: { decisionModel: 'typesafe/jev-1.13.0', policy: { ...defaultPolicy, labels: [
      { name: 'Known notification', description: 'Configured sender notification', action: 'wake', match }, ...defaultPolicy.labels,
    ] } } });
  const mail = new GogMailClient(config), modify = mail.modify.bind(mail);
  let categoryFailed = false;
  mail.modify = async (...args) => {
    if (args[0].includes('aa02') && !categoryFailed) {
      categoryFailed = true;
      throw new Error('controlled category write failure before notification dispatch');
    }
    return modify(...args);
  };
  const subagent: MailSubagent = {
    async run({ message: prompt, sessionKey }) {
      const jobId = jobIdFromPrompt(prompt);
      const context = workflow.context(jobId, sessionKey);
      runs.push({ jobId, sessionKey, ids: context.messages.flatMap(item => item.messageIds) });
      if (runs.at(-1)!.ids.includes('aa02')) assert.equal(categoryFailed, true, 'failed Gmail effects cannot suppress a ready rule wake');
      const notification = context.messages.find(item => item.threadId === 'bb02');
      if (notification) {
        assert.equal(notification.replyAllowed, false, 'a deterministic label cannot approve an outside sender');
        await assert.rejects(workflow.reply({ jobId, sessionKey, threadId: 'bb02', body: 'Not authorized' }), /external-or-invalid-sender|rejected/);
      }
      return { runId: jobId };
    },
    async waitForRun({ runId }) {
      const run = runs.find(item => item.jobId === runId)!;
      if (run.ids.includes('a900')) await busyHeld;
      if (run.ids.includes('aa02')) await agentHeld;
      workflow.complete({ jobId: run.jobId, sessionKey: run.sessionKey, reason: 'Handled' });
      return { status: 'ok' };
    },
  };
  workflow = createMailWorkflow({ config, mail, stateDir: h.stateDir, ...provider, decisions, subagent });
  let poll: Promise<void> | undefined;
  try {
    await workflow.start();
    const busy = { ...message('a900', 'Existing active agent work', { sender: 'notify@outside.test' }), threadId: 'b900' };
    h.setFixture(separateThreads([busy])); await workflow.poll();
    await waitFor(() => runs.some(run => run.ids.includes('a900')) && !workflow.status().triage!.labeling);
    const normal = message('aa01', 'Normal work');
    const otherNormal = { ...message('aa05', 'Other normal work'), threadId: 'bb03' };
    const matching = { ...message('aa02', 'Configured notification', { sender: 'notify@outside.test', received: Date.now() - 60000 }), threadId: 'bb02' };
    const mixed = { ...message('aa03', 'Same conversation, nonmatching sender', { sender: 'unapproved@other.test' }), threadId: 'bb02' };
    const inbox = () => { const f = separateThreads([busy, normal, matching, otherNormal]); f.search.messages.push({ id: mixed.id, threadId: mixed.threadId });
      f.threads.bb02.thread.messages.push(mixed); return f; };
    const snapshot = inbox();
    const current = JSON.parse(readFileSync(process.env.GOG_TEST_FIXTURE!, 'utf8')) as Fixture;
    snapshot.labels = current.labels; snapshot.threads.b900 = current.threads.b900;
    h.setFixture(snapshot);
    poll = workflow.poll();
    await waitFor(() => decisionsStarted === 1 && categoryFailed && !workflow.status().triage!.labeling);
    assert.match(String(workflow.inspect(matching.id)[0].labels?.reason), /controlled category write failure/);
    releaseBusy();
    await waitFor(() => runs.some(run => run.ids.includes('aa02')));
    const early = runs.find(run => run.ids.includes('aa02'))!;
    assert.ok(early.ids.includes('aa03'), 'the matching message classifies its current conversation as one item');
    assert.ok(!runs.some(run => run.ids.includes('aa01') || run.ids.includes('aa05')), 'the first semantic conversation holds the single Jev worker');
    assert.equal(decisionsStarted, 1, 'all rules in the same pending snapshot are visited before the first Jev await');
    await workflow.poll();
    await waitFor(() => [matching.id, mixed.id].every(id => workflow.inspect(id)[0].labels?.status === 'done') && !workflow.status().triage!.labeling);
    releaseDecision(); await poll;
    assert.equal(decisionsStarted, 2);
    await waitFor(() => !workflow.status().triage!.labeling);
    const later = { ...message('aa04', 'Follow-up notification', { sender: 'notify@outside.test' }), threadId: 'bb02' };
    const f = JSON.parse(readFileSync(process.env.GOG_TEST_FIXTURE!, 'utf8')) as Fixture;
    f.search.messages.push({ id: later.id, threadId: later.threadId }); f.threads.bb02.thread.messages.push(later);
    h.setFixture(f); await workflow.poll();
    assert.ok(!runs.some(run => run.ids.includes('aa04')), 'same-thread work waits for its active agent');
    releaseAgent(); await waitFor(() => runs.some(run => run.ids.includes('aa04')) && !workflow.status().working && !workflow.status().triage!.labeling);
    // Label workers snapshot a batch; a later arrival is drained by the next
    // poll if its scheduling overlapped the preceding label batch.
    await workflow.poll(); await waitFor(() => !workflow.status().working && !workflow.status().triage!.labeling);
    const expected = ['a900', 'aa01', 'aa02', 'aa03', 'aa04', 'aa05'].sort();
    assert.deepEqual(runs.flatMap(run => run.ids).sort(), expected);
    assert.equal(decisionsStarted, 2, 'Jev never separately reviews the admitted mixed-thread work');
    const labeled = await new GogMailClient(h.config).getThread('bb02');
    const labelId = Object.entries(labeled.labelNames ?? {}).find(([, name]) => name === 'Known notification')?.[0];
    assert.ok(labelId, 'ordinary rule labels use the shared Gmail label worker');
    assert.ok(labeled.messages.every(item => item.labelIds.includes(labelId)), JSON.stringify(labeled.messages.map(item => ({ id: item.id, labels: item.labelIds, work: workflow.inspect(item.id)[0].labels }))));
    const db = h.db();
    try {
      const counts = db.prepare("SELECT value AS id,count(*) AS n FROM jobs,json_each(jobs.message_ids) WHERE jobs.status='completed' GROUP BY value ORDER BY value").all();
      assert.deepEqual(counts.map(row => [row.id, row.n]), expected.map(id => [id, 1]));
    } finally { db.close(); }
    const total = runs.length;
    await workflow.stop();
    workflow = createMailWorkflow({ config, mail, stateDir: h.stateDir, ...provider, decisions, subagent });
    await workflow.start(); await workflow.poll();
    await waitFor(() => !workflow.status().working);
    assert.equal(runs.length, total);
    assert.equal(decisionsStarted, 2);
  } finally { releaseBusy(); releaseDecision(); releaseAgent(); await poll; await workflow.stop(); }
}));
  }
});

test('new conversation members join undispatched work without replaying earlier members', async () => withHarness(async h => {
  h.setFixture(fixture([]));
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let workflow: ReturnType<typeof createMailWorkflow>;
  const runs: Array<{ jobId: string; sessionKey: string; ids: string[] }> = [];
  const provider = assessments(() => ({ action: { type: 'choice', choice: 'wake', probabilities: {} } }));
  workflow = createMailWorkflow({ config: parseConfig({ ...triageConfig(h.config), settings: { wakeFrom: ['notify@outside.test'] } }),
    stateDir: h.stateDir, ...provider, subagent: {
      async run({ message: prompt, sessionKey }) { const jobId = jobIdFromPrompt(prompt);
        runs.push({ jobId, sessionKey, ids: workflow.context(jobId, sessionKey).messages.flatMap(item => item.messageIds) });
        return { runId: jobId }; },
      async waitForRun({ runId }) { const run = runs.find(item => item.jobId === runId)!;
        if (run === runs[0]) await held;
        workflow.complete({ jobId: run.jobId, sessionKey: run.sessionKey, reason: 'Handled' });
        return { status: 'ok' }; },
    } });
  try {
    await workflow.start();
    const busy = { ...message('aa01', 'Busy agent', { sender: 'notify@outside.test' }), threadId: 'bb00' };
    h.setFixture(separateThreads([busy])); await workflow.poll(); await waitFor(() => runs.length === 1);
    const queued = message('aa02', 'Dedicated notification', { sender: 'notify@outside.test' });
    h.setFixture(separateThreads([busy, queued])); await workflow.poll();
    const normal = message('aa03', 'Normal follow-up');
    const f = separateThreads([busy, queued]); f.threads.bb01.thread.messages.push(normal);
    f.search.messages.push({ id: normal.id, threadId: normal.threadId });
    h.setFixture(f); await workflow.poll();
    release(); await waitFor(() => !workflow.status().working);
    assert.deepEqual(runs.map(run => run.ids), [['aa01'], ['aa02', 'aa03']]);
  } finally { release(); await workflow.stop(); }
}));

test('live wakeFrom edits preserve ordinary triage of baseline mail without retro-waking it', async t => {
  for (const boundary of ['classification', 'effect fetch']) await t.test(boundary, async () => withHarness(async h => {
  const old = message('aa01', 'Before activation', { sender: 'notify@outside.test', received: Date.now() - 60000 });
  h.setFixture(fixture([old]));
  let release!: () => void, releaseEffect!: () => void, started = false, assessed = false, effectRead = false;
  const held = new Promise<void>(resolve => { release = resolve; });
  const effectHeld = new Promise<void>(resolve => { releaseEffect = resolve; });
  const provider = assessments(() => ({ action: { type: 'choice', choice: 'delete', probabilities: {} } }));
  let workflow: ReturnType<typeof createMailWorkflow>;
  const wakes: string[][] = [];
  const config = triageConfig({ ...h.config, settings: { retryDelaySeconds: 0 } }, { policy: { ...defaultPolicy, deletePrompt: 'Delete notifications' } });
  const mail = new GogMailClient(config), getThread = mail.getThread.bind(mail);
  mail.getThread = async id => {
    const thread = await getThread(id);
    if (boundary === 'effect fetch' && assessed && !effectRead) { effectRead = true; await effectHeld; }
    return thread;
  };
  workflow = createMailWorkflow({ config, mail,
    stateDir: h.stateDir, ...provider, decisions: { evaluate: async (batch, context) => {
      started = true; await held;
      const outcome = await provider.decisions.evaluate(batch, context);
      assessed = true;
      return outcome;
    } }, subagent: {
      async run({ message: prompt, sessionKey }) { const jobId = jobIdFromPrompt(prompt);
        wakes.push(workflow.context(jobId, sessionKey).messages.flatMap(item => item.messageIds));
        workflow.complete({ jobId, sessionKey, reason: 'Handled' }); return { runId: jobId }; },
      async waitForRun() { return { status: 'ok' }; },
    } });
  let initial: Promise<void> | undefined;
  try {
    initial = workflow.start(); await waitFor(() => started);
    if (boundary === 'effect fetch') {
      release();
      await waitFor(() => effectRead);
    }
    workflow.policyUpdate(undefined, workflow.policyGet().version, 'helper', { wakeFrom: ['outside.test'] });
    release(); releaseEffect(); await initial; await workflow.poll();
    assert.equal(h.calls().some(args => args.includes('modify')), true, 'baselining notification rules does not remove existing mail from ordinary triage');
    assert.equal(workflow.inspect(old.id)[0].message.status, 'done');
    assert.equal(wakes.length, 0);
    const fresh = message('aa02', 'After activation', { sender: 'notify@outside.test' });
    h.setFixture(fixture([old, fresh])); await workflow.poll(); await waitFor(() => !workflow.status().working);
    assert.deepEqual(wakes, [['aa02']]);
    assert.equal(provider.calls(), 1);
  } finally { release(); releaseEffect(); await initial; await workflow.stop(); }
  }));
});

test('wakeFrom-only installs discover outside senders but retain authentication, self and Gmail scope exclusions', async () => withHarness(async h => {
  h.setFixture(fixture([]));
  let workflow: ReturnType<typeof createMailWorkflow>;
  const wakes: string[][] = [];
  workflow = createMailWorkflow({ config: parseConfig({ account, gogPath: fakeGog,
    settings: { wakeFrom: ['outside.test', account], retryDelaySeconds: 0 } }), stateDir: h.stateDir, subagent: {
      async run({ message: prompt, sessionKey }) { const jobId = jobIdFromPrompt(prompt);
        wakes.push(workflow.context(jobId, sessionKey).messages.flatMap(item => item.messageIds));
        workflow.complete({ jobId, sessionKey, reason: 'Handled' }); return { runId: jobId }; },
      async waitForRun() { return { status: 'ok' }; },
    } });
  try {
    await workflow.start();
    const good = message('aa01', 'Good', { sender: 'notify@outside.test' });
    const bad = message('aa02', 'Forged', { sender: 'notify@outside.test', headers: { 'Authentication-Results': 'mx.google.com; dmarc=fail header.from=outside.test' } });
    const self = message('aa03', 'Self', { sender: account });
    const excluded = ['SPAM', 'TRASH', 'SENT', 'DRAFT'].map((label, i) => ({
      ...message(`aa0${i + 4}`, label, { sender: 'notify@outside.test' }), labelIds: ['INBOX', label],
    }));
    h.setFixture({ ...fixture([good, bad, self, ...excluded]), threadFailOnce: ['bb01'] });
    await workflow.poll();
    assert.equal(workflow.inspect(good.id)[0].message.status, 'pending', 'failed admission remains retryable instead of falling through to reply eligibility');
    await workflow.poll(); await waitFor(() => !workflow.status().working);
    assert.deepEqual(wakes, [['aa01']]);
    assert.ok(h.calls().some(args => args.some(value => value.includes('in:inbox'))), 'outside senders are actually searched');
  } finally { await workflow.stop(); }
}));

test('registered service starts without waiting for inference and honors the canonical per-agent model', async () => withHarness(async (h) => {
  const provider = assessments();
  let release!: () => void;
  const inference = new Promise<void>(resolve => { release = resolve; });
  const decisions: DecisionRuntimeV1 = { evaluate: async (...args) => {
    const result = provider.decisions.evaluate(...args);
    await inference;
    return result;
  } };
  const config = { agents: { defaults: { decisionModel: 'other/wrong' }, entries: { main: { decisionModel: 'typesafe/jev-1.13.0' } } } };
  let service: Parameters<OpenClawPluginApi['registerService']>[0] | undefined;
  const api = {
    pluginConfig: triageConfig(h.config),
    runtime: { config: { current: () => config }, decisions, subagent: {} },
    registerService(value: Parameters<OpenClawPluginApi['registerService']>[0]) { service = value; },
    registerTool() {}, registerCommand() {}, registerGatewayMethod() {}, registerCli() {},
  } as unknown as OpenClawPluginApi;
  plugin.register(api);
  assert.ok(service);
  h.setFixture({ ...fixture([message('aa01', 'Please review the estimate', { received: Date.now() - 60000 })]), probeWritableDb: false });
  const context = { config: {}, stateDir: h.stateDir, logger: { info() {}, warn() {}, error() {}, debug() {} } };
  let ready = false;
  const started = Promise.resolve(service.start(context)).then(() => { ready = true; });
  try {
    await waitFor(() => provider.calls() === 1);
    assert.equal(ready, true, 'Gateway activation must not wait for mailbox work');
    assert.equal(provider.calls(), 1, 'per-agent model must override the different default');
  } finally { release(); await started; await service.stop?.(context); }
}));

test('policy tools support ordinary and delegated agents without owner context while retaining version checks', async () => withHarness(async (h) => {
  let service: Parameters<OpenClawPluginApi['registerService']>[0] | undefined;
  let factory: Parameters<OpenClawPluginApi['registerTool']>[0] | undefined;
  const api = {
    pluginConfig: h.config,
    runtime: { config: { current: () => ({}) }, subagent: {} },
    registerService(value: Parameters<OpenClawPluginApi['registerService']>[0]) { service = value; },
    registerTool(value: Parameters<OpenClawPluginApi['registerTool']>[0]) { factory = value; },
    registerCommand() {}, registerGatewayMethod() {}, registerCli() {},
  } as unknown as OpenClawPluginApi;
  plugin.register(api);
  assert.ok(service); assert.equal(typeof factory, 'function');
  if (typeof factory !== 'function') throw new Error('tool factory missing');
  const context = { config: {}, stateDir: h.stateDir, logger: { info() {}, warn() {}, error() {}, debug() {} } };
  h.setFixture({ ...fixture([]), probeWritableDb: false });
  try {
    await service.start(context);
    let version = 1;
    for (const sessionKey of ['agent:main:main', 'agent:helper:subagent:child', 'agent:main:gog-email-watch:agent@example.com:bb01']) {
      const agentTools = factory({ agentId: 'helper', sessionKey, senderIsOwner: false });
      assert.ok(Array.isArray(agentTools));
      const health = await agentTools.find(tool => tool.name === 'gog_email_status')!.execute('status', {});
      assert.ok(health.details && typeof health.details === 'object' && 'running' in health.details);
      assert.equal(health.details.running, true);
      assert.ok('triageEnabled' in health.details);
      assert.equal(health.details.triageEnabled, false);
      const inspectTool: AnyAgentTool = agentTools.find(tool => tool.name === 'gog_email_inspect')!;
      assert.deepEqual((await inspectTool.execute('messages', {})).details, []);
      assert.deepEqual((await inspectTool.execute('scan', { scan: true })).details, null);
      await assert.rejects(inspectTool.execute('job', { jobId: 'missing' }), /job not found/);
      await assert.rejects(inspectTool.execute('ambiguous', { id: 'aa01', jobId: 'missing' }), /choose only one/);
      const update = agentTools.find(tool => tool.name === 'gog_email_policy_update')!;
      const policy = { ...structuredClone(defaultPolicy), queueMinutes: 0.5, prompt: `Updated by ${sessionKey}` };
      await update.execute('edit', { policy, expectedVersion: version });
      // Reusing the prior version would conceal a failed/no-op update.
      await assert.rejects(update.execute('stale', { policy, expectedVersion: version }), /version/);
      version++;
      const saved = await agentTools.find(tool => tool.name === 'gog_email_policy_get')!.execute('read', {});
      assert.ok(saved.details && typeof saved.details === 'object' && 'document' in saved.details);
      assert.deepEqual(saved.details.document, policy);
      assert.equal(saved.details.document.queueMinutes, 0.5, 'sub-minute intervals are supported');
      await update.execute('settings', { expectedVersion: version, settings: { wakePrompt: `Instructions from ${sessionKey}`, concurrency: 7, labelConcurrency: 2, replyAllowed: false } });
      version++;
      const runtime = await agentTools.find(tool => tool.name === 'gog_email_policy_get')!.execute('read-settings', {});
      assert.ok(runtime.details && typeof runtime.details === 'object' && 'settings' in runtime.details);
      assert.equal((runtime.details.settings as { labelConcurrency: number }).labelConcurrency, 2);
      assert.equal((runtime.details.settings as { replyAllowed: boolean }).replyAllowed, false);
      await assert.rejects(update.execute('empty', { expectedVersion: version }), /invalid|provide/);
    }
  } finally { await service.stop?.(context); }
}));

test('live settings reschedule polling, tune discovery and survive restarts without triage', async t => withHarness(async h => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.now() });
  h.setFixture(fixture([]));
  const subagent: MailSubagent = { run: async () => { throw new Error('empty inbox'); }, waitForRun: async () => ({ status: 'ok' }) };
  let workflow = createMailWorkflow({ config: h.config, stateDir: h.stateDir, subagent });
  const searches = () => h.calls().filter(args => args.includes('search'));
  try {
    await workflow.start();
    assert.ok(searches().at(-1)!.some(arg => arg.includes(`after:${workflow.status().activeSince - 1} `)), 'responder discovery never precedes activation');
    workflow.policyUpdate(undefined, 1, 'main', { pollIntervalSeconds: 1, concurrency: 7,
      discoveryOverlapSeconds: 20, reconcileIntervalSeconds: 100, reconcileLookbackSeconds: 200 });
    assert.equal(workflow.policyGet().settings.labelConcurrency, 7);
    assert.equal(workflow.policyGet().settings.retryDelaySeconds, 1);
    assert.equal(workflow.policyGet().configuredSettings.labelConcurrency, null);
    assert.equal(workflow.policyGet().configuredSettings.retryDelaySeconds, null);
    // A long gap catches up first. Subsequent timer-driven polls use the new overlap.
    t.mock.timers.setTime(Date.now() + 3600000);
    await workflow.poll();
    let before = searches().length;
    const lastPoll = workflow.status().lastPoll;
    t.mock.timers.tick(1000);
    await waitFor(() => searches().length > before && !workflow.status().polling);
    assert.ok(searches().at(-1)!.some(arg => arg.includes(`after:${lastPoll - 20} `)));
    workflow.policyUpdate(undefined, 2, 'main', { reconcileIntervalSeconds: 2, reconcileLookbackSeconds: 600, labelConcurrency: 2 });
    before = searches().length;
    t.mock.timers.tick(1000);
    await waitFor(() => searches().length > before && !workflow.status().polling);
    assert.ok(searches().at(-1)!.some(arg => arg.includes(`after:${Math.floor(Date.now() / 1000) - 600} `)));
    const saved = workflow.policyGet();
    assert.equal(saved.configuredSettings.labelConcurrency, 2);
    await workflow.stop();
    workflow = createMailWorkflow({ config: h.config, stateDir: h.stateDir, subagent });
    await workflow.start();
    assert.deepEqual(workflow.policyGet(), saved);
    workflow.policyUpdate(undefined, saved.version, 'main', { concurrency: 9, labelConcurrency: null, retryDelaySeconds: null });
    assert.equal(workflow.policyGet().settings.labelConcurrency, 9);
    assert.equal(workflow.policyGet().configuredSettings.labelConcurrency, null);
    assert.equal(workflow.policyGet().settings.retryDelaySeconds, 1);
    await workflow.stop();
    const edited = parseConfig({ ...h.config, settings: { pollIntervalSeconds: 3, responderPrompt: 'File override' } });
    workflow = createMailWorkflow({ config: edited, stateDir: h.stateDir, subagent });
    await workflow.start();
    assert.equal(workflow.policyGet().settings.pollIntervalSeconds, 3);
    assert.equal(workflow.policyGet().settings.responderPrompt, 'File override');
  } finally { await workflow.stop(); }
}));

test('reconciliation finds mail moved into Inbox across the rolling window and preserves explicit lookbacks', async t => {
  const cases: Array<{ maxAgeDays: number | null; fileLookback?: number; liveLookbacks?: number[] }> = [
    { maxAgeDays: 30 }, { maxAgeDays: 60 }, { maxAgeDays: null },
    { maxAgeDays: 30, fileLookback: 0 }, { maxAgeDays: 30, fileLookback: 604800 },
    { maxAgeDays: 30, liveLookbacks: [600] }, { maxAgeDays: 30, liveLookbacks: [600, 604800] },
  ];
  for (const testCase of cases) await t.test(JSON.stringify(testCase), async sub => withHarness(async h => {
    const { maxAgeDays, fileLookback, liveLookbacks } = testCase;
    sub.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const received = Date.now() - (maxAgeDays === 30 ? 20 : 40) * 86400000;
    const target = message('aa01', 'Moved back to Inbox', { received });
    target.labelIds = [];
    h.setFixture(fixture([target]));
    const config = triageConfig({ ...h.config, settings: { maxAgeDays,
      ...(fileLookback === undefined ? {} : { reconcileLookbackSeconds: fileLookback }) } });
    const provider = assessments();
    const mail = new GogMailClient(config), search = mail.searchPage.bind(mail);
    // The fake CLI checks Inbox membership; this adds Gmail's timestamp filter.
    mail.searchPage = async (after, ...rest) => {
      const result = await search(after, ...rest);
      return { ...result, messages: received / 1000 > after ? result.messages : [] };
    };
    let workflow = createMailWorkflow({ config, stateDir: h.stateDir, mail, ...provider,
      subagent: { run: async () => { throw new Error('queue is not due'); }, waitForRun: async () => ({ status: 'ok' }) } });
    try {
      await workflow.start();
      assert.equal(workflow.inspect().length, 0);
      for (const lookback of liveLookbacks ?? [])
        workflow.policyUpdate(undefined, workflow.policyGet().version, 'main', { reconcileLookbackSeconds: lookback });
      await workflow.stop();
      // The previous version stored all defaults, including its seven-day
      // lookback. An unchanged file must not keep that accidental limitation.
      const legacy = h.db();
      legacy.prepare("UPDATE policies SET settings=json_set(settings,'$.reconcileLookbackSeconds',604800) WHERE json_extract(settings,'$.reconcileLookbackSeconds') IS NULL").run();
      legacy.close();
      target.labelIds = ['INBOX']; h.setFixture(fixture([target]));
      sub.mock.timers.setTime(Date.now() + 3600000);
      workflow = createMailWorkflow({ config, stateDir: h.stateDir, mail, ...provider,
        subagent: { run: async () => { throw new Error('queue is not due'); }, waitForRun: async () => ({ status: 'ok' }) } });
      await workflow.start(); await waitFor(() => !workflow.status().triage!.labeling);
      const explicitLookback = fileLookback ?? liveLookbacks?.at(-1);
      assert.equal(workflow.policyGet().configuredSettings.reconcileLookbackSeconds, explicitLookback ?? null);
      assert.equal(workflow.inspect('aa01')[0]?.message.status, explicitLookback === undefined ? 'queue' : undefined);
      assert.equal(provider.calls(), explicitLookback === undefined ? 1 : 0, 'only mail inside the selected discovery window is classified');
    } finally { await workflow.stop(); }
  }));
});

test('retry deadlines and timeout overrides survive restart without replaying queued chains', async t => withHarness(async h => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 9, 19, 12).getTime() });
  const target = message('aa02', 'TARGET ' + '😀'.repeat(300) + ' TAIL', { received: Date.now() - 60000 });
  const sibling = message('aa01', 'SIBLING_CONTEXT', { received: Date.parse('2026-09-24T10:00:00Z'), headers: { Date: '' } });
  h.setFixture(fixture([sibling, target], [target]));
  const requests: Array<{ evidence: string; instructions: string; timeout: number }> = [];
  const provider = assessments();
  const decisions: DecisionRuntimeV1 = { evaluate: async (batch, opts) => {
    requests.push({ evidence: JSON.stringify((batch.state as { evidence: unknown }).evidence), instructions: JSON.stringify(batch.questions), timeout: opts.timeoutMs });
    if (requests.length === 1) return { status: 'unavailable', reason: 'transport' };
    return provider.decisions.evaluate(batch, opts);
  } };
  const config = parseConfig({ ...triageConfig(h.config), settings: {
    evidence: { maxBytes: 1024, context: 'message' }, decisionTimeoutSeconds: 12.5, retryDelaySeconds: 5,
  } });
  const subagent: MailSubagent = { run: async () => { throw new Error('queue is not due'); }, waitForRun: async () => ({ status: 'ok' }) };
  let workflow = createMailWorkflow({ config, stateDir: h.stateDir, ...provider, decisions, subagent });
  try {
    await workflow.start();
    assert.equal(workflow.status().messages.pending, 1);
    t.mock.timers.setTime(Date.now() + 2000); await workflow.poll(); assert.equal(requests.length, 1);
    t.mock.timers.setTime(Date.now() + 3000); await workflow.poll();
    assert.equal(workflow.status().messages.queue, 1); assert.equal(requests.length, 2);
    assert.equal(requests[1].timeout, 12500);
    assert.ok(requests[1].evidence.includes('TARGET') && requests[1].evidence.includes('TAIL'));
    assert.ok(requests[1].evidence.includes('Sent date: Fri, 25 Sep 2026 10:00:00 -0400'));
    assert.match(requests[1].instructions, /Today's date: 2026-10-19 \([^)]+\)/);
    assert.ok(requests[1].evidence.includes('SIBLING_CONTEXT'));
    workflow.policyUpdate(undefined, 1, 'main', { wakePrompt: 'Handle succinctly', decisionTimeoutSeconds: 45, concurrency: 3 });
    await workflow.poll(); assert.equal(requests.length, 2, 'operational settings do not reclassify queue');
    workflow.policyUpdate(undefined, 2, 'main', { evidence: { maxBytes: 4096, context: 'thread' } });
    await workflow.poll();
    assert.equal(requests.length, 2, 'deprecated evidence knobs do not truncate or invalidate a chain');
    workflow.policyUpdate({ ...defaultPolicy, prompt: 'Queue project work; skip resolved requests.' }, 3, 'main');
    await workflow.poll();
    assert.equal(requests.length, 3); assert.equal(requests[2].timeout, 45000);
    assert.ok(requests[2].evidence.includes('TAIL') && requests[2].evidence.includes('SIBLING_CONTEXT'));
    assert.ok(requests[2].evidence.includes('2026-09-24T10:00:00.000Z (Gmail timestamp; sent Date header missing)'));
    assert.match(readFileSync(join(h.stateDir, 'triage', 'aa02.md'), 'utf8'), /Sent date: 2026-09-24T10:00:00.000Z \(Gmail timestamp; sent Date header missing\)/);
    const saved = workflow.policyGet();
    await workflow.stop();
    // v0.3.3 persisted this file fingerprint, including the now-ignored evidence knobs.
    const legacy = h.db();
    legacy.prepare("UPDATE meta SET value=? WHERE key='runtime_config_settings'").run('f43c4abbc9516d550f1e7a1c36f55ff3bf19ebaccce407c7ecbe08a1cf168dc0');
    legacy.prepare('UPDATE policies SET settings=? WHERE version=?').run(JSON.stringify({ ...saved.configuredSettings, evidence: { maxBytes: 1024, context: 'message' } }), saved.version);
    legacy.prepare("DELETE FROM meta WHERE key='triage_unit'").run();
    legacy.close();
    workflow = createMailWorkflow({ config, stateDir: h.stateDir, ...provider, decisions, subagent });
    await workflow.start();
    assert.deepEqual(workflow.policyGet(), { ...saved, version: saved.version + 1 }); assert.equal(requests.length, 3);
  } finally { await workflow.stop(); }
}));

test('a whole chain is classified once with full plaintext, then wakes once with independent chain labels', async t => withHarness(async h => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const body = 'TARGET_REQUEST ' + 'plain mail content '.repeat(2000) + ' END_OF_LONG_MESSAGE';
  const target = message('aa01', body, { received: Date.now() - 60000,
    headers: { 'Reply-To': 'reply@example.com', Bcc: 'archive@example.com', Cc: 'copy@example.com' } });
  target.labelIds.push('UNREAD', 'STARRED', 'IMPORTANT', 'Label_existing');
  target.payload = { mimeType: 'multipart/mixed', headers: target.payload.headers, parts: [
    { mimeType: 'text/plain', body: target.payload.body },
    { mimeType: 'multipart/mixed', parts: [{ mimeType: 'text/plain', filename: 'project-notes.txt',
      body: { attachmentId: 'not-downloaded', data: Buffer.from('ATTACHMENT_CONTENT_NOT_SENT').toString('base64url') } }] },
  ] };
  const followup = message('aa04', 'FOLLOWUP_REQUEST', { received: Date.now() - 45000 });
  const reply = message('aa02', 'ALREADY_COMPLETED: I sent the requested files.', { sender: account, received: Date.now() - 30000,
    headers: { Date: 'Mon, 19 Oct 2026 10:00:00 -0400' } });
  reply.labelIds = ['SENT'];
  const draft = message('aa03', 'UNSENT_DRAFT', { sender: account }); draft.labelIds = ['DRAFT'];
  h.setFixture({ ...fixture([target, followup, reply, draft], [target, followup]),
    labels: [{ id: 'Label_existing', name: 'Customer projects', type: 'user' }] });
  const provider = assessments();
  let classifications = 0, wakes = 0;
  const decisions: DecisionRuntimeV1 = { evaluate: async (batch, options) => {
    const input = batch.state as { evidence: { text: string } };
    assert.ok(input.evidence.text.includes(body), 'no byte truncation, including with legacy maxBytes configured');
    assert.ok(input.evidence.text.includes('FOLLOWUP_REQUEST'));
    assert.ok(input.evidence.text.includes('ALREADY_COMPLETED'), 'a long target must not crowd out the latest sent reply');
    assert.ok(!input.evidence.text.includes('UNSENT_DRAFT'));
    for (const metadata of ['Reply-To: reply@example.com', 'Bcc: archive@example.com', 'Cc: copy@example.com',
      'project-notes.txt', 'Customer projects', 'Read status: unread', 'Read status: read', 'Starred: true', 'Starred: false'])
      assert.ok(input.evidence.text.includes(metadata), `classification includes ${metadata}`);
    assert.ok(!input.evidence.text.includes('ATTACHMENT_CONTENT_NOT_SENT'));
    assert.ok(!input.evidence.text.includes('IMPORTANT'), 'importance is not sent');
    classifications++;
    return { status: 'ok', provenance: { providerId: 'typesafe', rubricVersion: options.rubricVersion, runtimeGeneration: 'test' },
      result: { model: 'jev-1.13.0', answers: labelAnswers(batch, 'queue', { label_0: { type: 'choice', choice: 'apply', probabilities: {} } }) } };
  } };
  let workflow: ReturnType<typeof createMailWorkflow>;
  const config = triageConfig(parseConfig({ ...h.config, settings: { evidence: { maxBytes: 1024, context: 'message' } } }),
    { policy: { ...defaultPolicy, queueMinutes: 2, labels: [{ name: 'Project', description: 'Project conversations' }] } });
  const subagent: MailSubagent = { run: async ({ sessionKey, message: prompt }) => {
    wakes++;
    const jobId = jobIdFromPrompt(prompt), context = workflow.context(jobId, sessionKey);
    assert.equal(context.messages.length, 1, 'the agent sees one conversation, not duplicate entries');
    assert.match(readFileSync(context.messages[0].transcript!, 'utf8'), /END_OF_LONG_MESSAGE/);
    workflow.complete({ jobId, sessionKey, reason: 'Chain handled' }); return { runId: jobId };
  }, waitForRun: async () => ({ status: 'ok' }) };
  workflow = createMailWorkflow({ config, stateDir: h.stateDir, ...provider, decisions, subagent });
  try {
    await workflow.start();
    assert.deepEqual(workflow.status().messages, { queue: 2 }, 'both members share one decision');
    await waitFor(() => !workflow.status().triage!.labeling);
    assert.equal(classifications, 1); assert.equal(wakes, 0);
    const current = await new GogMailClient(h.config).getThread('bb01');
    assert.ok(current.messages.filter(m => ['aa01', 'aa04'].includes(m.id)).every(m => m.labelIds.includes('Label_2')));
    assert.deepEqual(current.messages.find(m => m.id === reply.id)!.labelIds, ['SENT']);
    await workflow.stop();
    h.setFixture({ ...fixture(current.messages, current.messages.filter(m => ['aa01', 'aa04'].includes(m.id))),
      labelListFailure: true });
    workflow = createMailWorkflow({ config, stateDir: h.stateDir, ...provider, decisions, subagent });
    await workflow.start();
    t.mock.timers.setTime(Date.now() + 120000); await workflow.poll();
    await waitFor(() => !workflow.status().working);
    assert.equal(classifications, 1); assert.equal(wakes, 1);
    assert.deepEqual(workflow.status().messages, { done: 2 });
  } finally { await workflow.stop(); }
}));

test('due wakes refresh changed threads, retain unresolved follow-ups, and retry unreadable mail without replaying unchanged decisions', async t => withHarness(async h => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const targets = Array.from({ length: 5 }, (_, i) => {
    const target = message(`aa0${i + 1}`, 'Original request', { received: Date.now() - 60000 });
    target.threadId = `bb0${i + 1}`; return target;
  });
  const sibling = { ...message('aa06', 'Another request in this chain', { received: Date.now() - 45000 }), threadId: 'bb03' };
  const mailbox = () => {
    const value = { ...separateThreads(targets), probeWritableDb: false };
    value.threads.bb03.thread.messages.push(sibling);
    value.search.messages.push({ id: sibling.id, threadId: sibling.threadId });
    return value;
  };
  h.setFixture(mailbox());
  const counts = new Map<string, number>();
  const provider = assessments(id => {
    const count = (counts.get(id) ?? 0) + 1; counts.set(id, count);
    const choice = count === 1 || id === 'bb04' ? 'queue' : id === 'bb03' ? 'wake' : 'skip';
    return { action: { type: 'choice', choice, probabilities: {} } };
  });
  const config = triageConfig({ ...h.config, settings: { retryDelaySeconds: 0 } }, { policy: { ...defaultPolicy, queueMinutes: 1 } });
  const wakes: string[][] = [];
  let workflow: ReturnType<typeof createMailWorkflow>;
  const subagent: MailSubagent = { run: async ({ sessionKey, message: prompt }) => {
    const jobId = jobIdFromPrompt(prompt), context = workflow.context(jobId, sessionKey);
    wakes.push(context.messages.map(row => row.id));
    const followup = context.messages.find(row => row.id === 'aa03');
    if (followup) assert.match(readFileSync(followup.transcript!, 'utf8'), /STILL_UNRESOLVED/);
    workflow.complete({ jobId, sessionKey, reason: 'Current work handled' });
    return { runId: jobId };
  }, waitForRun: async () => ({ status: 'ok' }) };
  workflow = createMailWorkflow({ config, stateDir: h.stateDir, ...provider, subagent });
  try {
    await workflow.start(); assert.equal(provider.calls(), 5); await workflow.stop();
    const updated = mailbox();
    for (const id of ['2', '3', '4']) {
      const reply = message(`cc0${id}`, id === '3' ? 'STILL_UNRESOLVED: please approve the revised budget.' : 'Completed this request.',
        { sender: id === '3' ? 'customer@elsewhere.test' : account });
      reply.threadId = `bb0${id}`; if (id !== '3') reply.labelIds = ['SENT'];
      updated.threads[`bb0${id}`].thread.messages.push(reply);
    }
    targets[4].labelIds = [];
    const unreadable = updated.threads.bb04; delete updated.threads.bb04;
    h.setFixture(updated);
    workflow = createMailWorkflow({ config, stateDir: h.stateDir, ...provider, subagent });
    await workflow.start(); assert.equal(provider.calls(), 5, 'no refresh before a wake is due');
    t.mock.timers.setTime(Date.now() + 60000);
    await workflow.poll(); await waitFor(() => !workflow.status().working);
    assert.deepEqual(wakes, [['aa01', 'aa03']], 'resolved and archived mail must not reach the agent');
    assert.equal(provider.calls(), 7, 'only the two readable changed threads need Jev again');
    assert.deepEqual(workflow.status().messages, { done: 3, ignored: 1, pending: 1, skipped: 1 });
    updated.threads.bb04 = unreadable; h.setFixture(updated);
    await workflow.poll(); await waitFor(() => !workflow.status().working);
    assert.equal(provider.calls(), 8);
    assert.deepEqual(wakes, [['aa01', 'aa03'], ['aa04']], 'a transient read failure must not postpone due work for another queue interval');
    assert.deepEqual(workflow.status().messages, { done: 4, ignored: 1, skipped: 1 });
    assert.ok(!h.calls().some(args => args.includes('send') || args.includes('TRASH') || args.includes('--remove')));
  } finally { await workflow.stop(); }
}));

test('skipped backlog stays quiet across days and restarts, labels independently, and can be reconsidered by policy', async t => withHarness(async h => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 9, 19, 12).getTime() });
  h.setFixture({ ...fixture([message('aa01', 'Publication receipt', { received: Date.now() - 60000 })]), probeWritableDb: false });
  let classifications = 0, wakes = 0;
  const requests: string[] = [];
  const provider = assessments();
  const decisions: DecisionRuntimeV1 = { evaluate: async (batch, opts) => {
    requests.push(JSON.stringify(batch.questions));
    classifications++;
    const choice = classifications === 1 ? 'skip' : 'wake';
    return { status: 'ok', provenance: { providerId: 'typesafe', rubricVersion: opts.rubricVersion, runtimeGeneration: 'test' },
      result: { model: 'jev-1.13.0', answers: labelAnswers(batch, choice, { label_0: { type: 'choice', choice: 'apply', probabilities: {} } }) } };
  } };
  const config = triageConfig(h.config, { policy: { ...defaultPolicy, labels: [{ name: 'Receipts', description: 'Publication receipts' }] } });
  let workflow: ReturnType<typeof createMailWorkflow>;
  const subagent: MailSubagent = {
    run: async ({ sessionKey, message: prompt }) => {
      wakes++;
      const jobId = jobIdFromPrompt(prompt);
      workflow.complete({ jobId, sessionKey, reason: 'Handled after policy change' });
      return { runId: jobId, sessionKey };
    }, waitForRun: async () => ({ status: 'ok' }),
  };
  workflow = createMailWorkflow({ config, stateDir: h.stateDir, ...provider, decisions, subagent });
  try {
    await workflow.start(); await waitFor(() => !workflow.status().triage!.labeling);
    assert.deepEqual(workflow.status().messages, { skipped: 1 });
    assert.deepEqual(workflow.inspect('aa01')[0].plan, { action: 'skip', labels: ['Receipts', 'No action needed'], source: 'jev' });
    assert.equal(classifications, 1); assert.equal(wakes, 0);
    assert.ok(requests.every(request => /Today's date: 2026-10-19 \([^)]+\)/.test(request)), 'the classification includes the current date');
    const mail = (await new GogMailClient(h.config).getThread('bb01')).messages[0];
    assert.deepEqual(mail.labelIds.sort(), ['INBOX', 'Label_1', 'Label_2']);
    assert.equal(workflow.status().nextQueueWakeAt, null);
    t.mock.timers.setTime(Date.now() + 2 * 86400000);
    await workflow.poll(); await workflow.stop();
    workflow = createMailWorkflow({ config, stateDir: h.stateDir, ...provider, decisions, subagent });
    await workflow.start();
    assert.equal(classifications, 1); assert.equal(wakes, 0);
    assert.deepEqual(workflow.status().jobs, {});
    const current = workflow.policyGet();
    workflow.policyUpdate({ ...current.document, prompt: 'Wake for publication receipts needing verification.' }, current.version, 'main');
    await workflow.poll(); await waitFor(() => !workflow.status().working);
    assert.equal(classifications, 2); assert.equal(wakes, 1);
    assert.match(requests.at(-1)!, /Today's date: 2026-10-21 \([^)]+\)/);
    assert.deepEqual(workflow.status().messages, { done: 1 });
    assert.ok(!h.calls().some(args => args.includes('send') || args.includes('TRASH') || args.includes('--remove')));
  } finally { await workflow.stop(); }
}));

test('live gog output and timeout overrides recover actual failed subprocess reads', async t => withHarness(async h => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const target = message('aa01', 'Large message '.repeat(300), { received: Date.now() - 60000 });
  h.setFixture(fixture([target]));
  const provider = assessments();
  const config = parseConfig({ ...triageConfig(h.config), settings: { gogMaxOutputBytes: 256, retryDelaySeconds: 0 } });
  const workflow = createMailWorkflow({ config, stateDir: h.stateDir, ...provider,
    subagent: { run: async () => { throw new Error('queue is not due'); }, waitForRun: async () => ({ status: 'ok' }) } });
  try {
    await workflow.start();
    assert.equal(workflow.status().messages.pending, 1); assert.equal(provider.calls(), 0);
    const db = h.db();
    assert.match(String(db.prepare("SELECT reason FROM messages WHERE id='aa01'").get()?.reason), /MAXBUFFER/);
    db.close();
    h.setFixture({ ...fixture([target]), threadDelayMs: 1500 });
    workflow.policyUpdate(undefined, 1, 'main', { gogMaxOutputBytes: 65536, gogTimeoutSeconds: 0.5 });
    await workflow.poll();
    assert.equal(workflow.status().messages.pending, 1); assert.equal(provider.calls(), 0);
    workflow.policyUpdate(undefined, 2, 'main', { gogTimeoutSeconds: 3 });
    await workflow.poll();
    assert.equal(workflow.status().messages.queue, 1); assert.equal(provider.calls(), 1);
  } finally { await workflow.stop(); }
}));

test('in-flight settings edits preserve decisions, independent worker capacities and custom wake instructions', async () => withHarness(async h => {
  const messages = Array.from({ length: 4 }, (_, i) => {
    const mail = message(`aa0${i}`, 'Actionable', { received: Date.now() - 60000 }); mail.threadId = `bb0${i}`; return mail;
  });
  h.setFixture({ ...separateThreads(messages), probeWritableDb: false });
  let releaseClassification!: () => void, releaseLabels!: () => void;
  const classificationGate = new Promise<void>(resolve => { releaseClassification = resolve; });
  const labelGate = new Promise<void>(resolve => { releaseLabels = resolve; });
  let classifications = 0, labels = 0, activeLabels = 0, peakLabels = 0, wakes = 0;
  const waitTimeouts: Array<number | undefined> = [];
  const provider = assessments();
  const decisions: DecisionRuntimeV1 = { evaluate: async batch => {
    classifications++; await classificationGate;
    return { status: 'ok', provenance: { providerId: 'typesafe', rubricVersion: 'mail-v3', runtimeGeneration: 'test' },
      result: { model: 'jev-1.13.0', answers: labelAnswers(batch, 'wake', { label_0: { type: 'choice', choice: 'apply', probabilities: {} } }) } };
  } };
  const config = parseConfig({ ...triageConfig(h.config, { policy: { ...defaultPolicy, labels: [{ name: 'Project', description: 'Project mail' }] } }),
    settings: { concurrency: 4, labelConcurrency: 2, agentWaitTimeoutSeconds: 0.25 } });
  const mail = new GogMailClient(config), labelId = mail.labelId.bind(mail);
  mail.labelId = async name => {
    if (name !== 'Project') return labelId(name);
    labels++; activeLabels++; peakLabels = Math.max(peakLabels, activeLabels);
    try { await labelGate; return await labelId(name); }
    finally { activeLabels--; }
  };
  let workflow: ReturnType<typeof createMailWorkflow>;
  workflow = createMailWorkflow({ config, mail, stateDir: h.stateDir, ...provider, decisions, subagent: {
    run: async ({ sessionKey, message: prompt }) => {
      wakes++; assert.match(prompt, /Start with commitments/);
      const jobId = jobIdFromPrompt(prompt);
      assert.equal(workflow.context(jobId, sessionKey).messages.length, 4);
      workflow.complete({ jobId, sessionKey, reason: 'Done' }); return { runId: jobId };
    }, waitForRun: async ({ timeoutMs }) => { waitTimeouts.push(timeoutMs); return { status: 'ok' }; },
  } });
  const start = workflow.start();
  try {
    await waitFor(() => classifications === 4);
    workflow.policyUpdate(undefined, 1, 'main', { wakePrompt: 'Start with commitments', decisionTimeoutSeconds: 60 });
    releaseClassification(); await start;
    await waitFor(() => labels === 2 && !workflow.status().working);
    assert.equal(wakes, 1); assert.equal(workflow.status().messages.done, 4);
    assert.ok(waitTimeouts.length > 0 && waitTimeouts.every(timeout => timeout !== undefined && timeout > 0 && timeout <= 250));
    workflow.policyUpdate(undefined, 2, 'main', { responderPrompt: 'Be concise' });
    releaseLabels(); await waitFor(() => !workflow.status().triage!.labeling);
    assert.equal(classifications, 4); assert.equal(labels, 4); assert.equal(peakLabels, 2);
    assert.equal(workflow.inspect().filter(row => row.labels?.status === 'done').length, 4);
  } finally { releaseClassification(); releaseLabels(); await start; await workflow.stop(); }
}));

test('host-pending runs survive observation failures until an actual terminal outcome', async t => {
  for (const triage of [false, true]) for (const terminalTimeout of [false, true])
    await t.test(`${triage ? 'triage' : 'responder'}: ${terminalTimeout ? 'host timeout' : 'completed'}`, async t => withHarness(async h => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    h.setFixture(fixture([]));
    let workflow: ReturnType<typeof createMailWorkflow>, jobId = '', sessionKey = '', runs = 0, waits = 0;
    const provider = assessments(() => ({ action: { type: 'choice', choice: 'wake', probabilities: {} } }));
    if (triage) h.setFixture(fixture([message('aa01', 'Existing mail', { received: Date.now() - 60000 })]));
    workflow = createMailWorkflow({ config: triage ? triageConfig(h.config) : h.config, stateDir: h.stateDir, ...provider,
      subagent: {
        run: async input => { runs++; jobId = jobIdFromPrompt(input.message); sessionKey = input.sessionKey; return { runId: jobId, sessionKey }; },
        waitForRun: async () => {
          if (++waits <= 2) {
            t.mock.timers.setTime(Date.now() + 700000);
            return { status: waits === 1 ? 'pending' : 'timeout' };
          }
          if (waits === 3) return { status: 'error', error: 'connection closed', retryableTransportError: true };
          workflow.context(jobId, sessionKey);
          if (terminalTimeout) return triage ? { status: 'timeout', timeoutPhase: 'provider' } : { status: 'timeout', providerStarted: true };
          workflow.complete({ jobId, sessionKey, reason: 'Host queue drained; work completed' });
          return { status: 'ok' };
        },
      } });
    try {
      await workflow.start();
      if (!triage) { h.setFixture(fixture([message('aa01', 'New mail')])); await workflow.poll(); }
      await waitFor(() => !workflow.status().working);
      if (terminalTimeout) {
        assert.equal(workflow.status().unresolvedJobs.length, 1, 'a confirmed host timeout ends observation');
        assert.throws(() => workflow.context(jobId, sessionKey), /not active/);
      } else {
        assert.equal(workflow.status().jobs.completed, 1, 'pending is not a failed or unresolved run');
        assert.equal(workflow.status().messages.done, 1);
      }
      assert.equal(runs, 1, 'waiting must not redispatch'); assert.equal(waits, 4);
    } finally { await workflow.stop(); }
  }));
});

test('uncertain normal and alternate-target sends cannot be skipped or replayed', async t => {
  for (const alternate of [false, true]) await t.test(alternate ? 'alternate transport failure' : 'missing acknowledgment', async () => withHarness(async h => {
    h.setFixture(fixture([]));
    const earlier = message('aa00', 'Scheduling guest', { received: Date.now() - 3000, headers: { To: `${account}, guest@outside.test` } });
    const replyOptions = alternate ? { externalScheduling: true, replyTargetMessageId: earlier.id } : {};
    let checksCompleted = false;
    let workflow: ReturnType<typeof createMailWorkflow>;
    workflow = createMailWorkflow({ config: h.config, stateDir: h.stateDir, subagent: {
      run: async ({ sessionKey, message: prompt }) => {
        const jobId = jobIdFromPrompt(prompt);
        await assert.rejects(workflow.reply({ jobId, sessionKey, body: 'Answer', ...replyOptions }), alternate ? /gog command failed/ : /acknowledgment/);
        assert.throws(() => workflow.skip({ jobId, sessionKey, reason: 'No reply' }), /uncertain/);
        await assert.rejects(workflow.reply({ jobId, sessionKey, body: 'Retry', ...replyOptions }), /duplicate/);
        checksCompleted = true;
        return { runId: jobId };
      }, waitForRun: async () => ({ status: 'ok' }),
    } });
    try {
      await workflow.start();
      const incoming = message('aa01', 'Please answer');
      h.setFixture({ ...fixture([earlier, incoming], [incoming]), ...(alternate ? { sendFailure: true } : { send: {} }) });
      await workflow.poll();
      await waitFor(() => !workflow.status().working);
      assert.ok(checksCompleted, 'worker error handling must not hide a failed assertion');
      assert.equal(workflow.status().jobs.needs_review, 1);
      const jobId = String(workflow.status().unresolvedJobs[0].id);
      const snapshot = workflow.inspectJob(jobId);
      assert.equal(snapshot.job.run_id, jobId);
      assert.ok(snapshot.job.session_key);
      assert.ok(snapshot.job.started > 0);
      assert.ok(snapshot.transcript);
      assert.match(readFileSync(snapshot.transcript, 'utf8'), /Please answer/);
      assert.equal(snapshot.replies[0].status, 'uncertain');
      assert.throws(() => workflow.resolve(jobId, 'Investigating a possible delivery', 'retry'), /uncertain/);
      assert.equal(snapshot.messages[0].message.id, 'aa01');
      assert.equal(workflow.inspect('aa01')[0].message.status, 'needs_review');
      assert.throws(() => workflow.context(jobId, snapshot.job.session_key), /not active/);
      assert.throws(() => workflow.complete({ jobId, sessionKey: snapshot.job.session_key, reason: 'Inspection is not authority' }), /not active/);
      const sends = h.calls().filter(args => args.includes('send'));
      assert.equal(sends.length, 1);
      assert.equal(sends[0][sends[0].indexOf('--reply-to-message-id') + 1], alternate ? earlier.id : incoming.id);
      assert.equal(sends[0][sends[0].indexOf('--to') + 1], alternate ? `${approved},guest@outside.test` : approved);
    } finally { await workflow.stop(); }
  }));
});

test('triage replies honor the live toggle, send per conversation and defer only unfinished mail across restart', async t => withHarness(async h => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const messages = [1, 2, 3].map(i => ({ ...message(`aa0${i}`, 'Reply back when you get this.', { received: Date.now() - 60000 }), threadId: `bb0${i}` }));
  const mailbox = separateThreads(messages);
  mailbox.threads.bb01.thread.messages.unshift(message('aa00', 'Scheduling guest', {
    sender: 'guest@outside.test', received: Date.now() - 120000,
  }));
  h.setFixture(mailbox);
  const provider = assessments(() => ({ action: { type: 'choice', choice: 'wake', probabilities: {} } }));
  const config = triageConfig({ ...h.config, settings: { replyAllowed: false } });
  let workflow: ReturnType<typeof createMailWorkflow>, runs = 0, checks = 0;
  let acknowledged: Record<string, number> | undefined;
  const mail = new GogMailClient(config), getThread = mail.getThread.bind(mail);
  let disableDuringRead = false;
  mail.getThread = async id => {
    const thread = await getThread(id);
    if (disableDuringRead) {
      disableDuringRead = false;
      workflow.policyUpdate(undefined, workflow.policyGet().version, 'helper', { replyAllowed: false });
    }
    return thread;
  };
  const subagent: MailSubagent = {
    run: async ({ sessionKey, message: prompt, toolsAlsoAllow }) => {
      runs++;
      const jobId = jobIdFromPrompt(prompt);
      const reply = { jobId, sessionKey, body: 'Received, thank you.' };
      assert.ok(toolsAlsoAllow?.includes('gog_email_reply'), 'triage exposes its reply tool');
      if (runs === 1) {
        assert.equal(workflow.context(jobId, sessionKey).replyAllowed, false);
        await assert.rejects(workflow.reply({ ...reply, threadId: 'bb01' }), /disabled/);
        workflow.policyUpdate(undefined, workflow.policyGet().version, 'helper', { replyAllowed: true });
        const context = workflow.context(jobId, sessionKey);
        assert.equal(context.replyAllowed, true);
        assert.ok(context.messages.every(row => row.replyAllowed));
        await assert.rejects(workflow.reply(reply), /threadId/);
        await assert.rejects(workflow.reply({ ...reply, threadId: 'bb99' }), /not.*job/);
        disableDuringRead = true;
        await assert.rejects(workflow.reply({ ...reply, threadId: 'bb02' }), /disabled/);
        workflow.policyUpdate(undefined, workflow.policyGet().version, 'helper', { replyAllowed: true });
        const sends = await Promise.allSettled([
          workflow.reply({ ...reply, threadId: 'bb01', externalScheduling: true, replyTargetMessageId: 'aa00' }),
          workflow.reply({ ...reply, threadId: 'bb01', externalScheduling: true, replyTargetMessageId: 'aa00' }),
          workflow.reply({ ...reply, threadId: 'bb02' }),
        ]);
        assert.equal(sends.slice(0, 2).filter(result => result.status === 'fulfilled').length, 1, 'same-target races send once');
        const duplicate = sends.slice(0, 2).find(result => result.status === 'rejected');
        assert.ok(duplicate?.status === 'rejected');
        assert.match(String(duplicate.reason), /duplicate/);
        assert.equal(sends[2].status, 'fulfilled', 'independent conversations can send concurrently');
        await assert.rejects(workflow.reply({ ...reply, threadId: 'bb01' }), /duplicate/);
        assert.equal(workflow.context(jobId, sessionKey).messages.find(row => row.threadId === 'bb01')?.replyStatus, 'sent');
        workflow.complete({ jobId, sessionKey, reason: 'Two replies sent; third needs follow-up' }, Math.floor(Date.now() / 1000) + 60);
        acknowledged = workflow.status().messages;
      } else {
        assert.deepEqual(workflow.context(jobId, sessionKey).messages.flatMap(row => row.messageIds), ['aa03']);
        await workflow.reply(reply); // One conversation needs no selector.
        workflow.complete({ jobId, sessionKey, reason: 'All conversations handled' });
      }
      checks++;
      return { runId: jobId };
    }, waitForRun: async () => ({ status: 'ok' }),
  };
  workflow = createMailWorkflow({ config, stateDir: h.stateDir, mail, ...provider, subagent });
  try {
    await workflow.start(); await waitFor(() => !workflow.status().working);
    assert.equal(checks, 1, JSON.stringify(workflow.status().unresolvedJobs));
    assert.deepEqual(acknowledged, { deferred: 1, done: 2 }, 'acknowledgment persists unfinished mail before the run ends');
    assert.deepEqual(workflow.status().messages, { deferred: 1, done: 2 });
    assert.equal(provider.calls(), 3, 'reply toggle does not reclassify mail');
    await workflow.stop();
    // State left by older versions crashing after defer acknowledgment but
    // before their run finalizer. Already-replied conversations stay done.
    const legacy = h.db();
    legacy.prepare("UPDATE messages SET status='processing' WHERE status='deferred'").run();
    legacy.close();
    workflow = createMailWorkflow({ config, stateDir: h.stateDir, ...provider, subagent });
    await workflow.start();
    assert.deepEqual(workflow.status().messages, { deferred: 1, done: 2 });
    assert.equal(checks, 1, 'restart must not resume before the explicit time');
    await workflow.stop();
    t.mock.timers.setTime(Date.now() + 60000);
    workflow = createMailWorkflow({ config, stateDir: h.stateDir, ...provider, subagent });
    await workflow.start(); await waitFor(() => !workflow.status().working);
    assert.equal(checks, 2);
    assert.deepEqual(workflow.status().messages, { done: 3 });
    assert.equal(workflow.policyGet().settings.replyAllowed, true, 'live override survives restart');
    const sends = h.calls().filter(args => args.includes('send'));
    assert.deepEqual(sends.map(args => args[args.indexOf('--reply-to-message-id') + 1]).sort(), ['aa00', 'aa02', 'aa03']);
    const scheduling = sends.find(args => args[args.indexOf('--reply-to-message-id') + 1] === 'aa00')!;
    assert.equal(scheduling[scheduling.indexOf('--to') + 1], 'guest@outside.test');
  } finally { await workflow.stop(); }
}));

test('uncertain triage replies block replay and completion without blocking other conversations', async () => withHarness(async h => {
  const messages = [1, 2, 3].map(i => ({ ...message(`aa0${i}`, 'Please acknowledge', {
    received: Date.now() - 60000, sender: i === 3 ? 'outside@elsewhere.test' : approved,
  }), threadId: `bb0${i}` }));
  const mailbox = separateThreads(messages);
  h.setFixture({ ...mailbox, send: {} });
  const provider = assessments(() => ({ action: { type: 'choice', choice: 'wake', probabilities: {} } }));
  let workflow: ReturnType<typeof createMailWorkflow>, checked = false;
  const subsequentWakes: string[][] = [];
  workflow = createMailWorkflow({ config: triageConfig(h.config), stateDir: h.stateDir, ...provider, subagent: {
    run: async ({ sessionKey, message: prompt }) => {
      const jobId = jobIdFromPrompt(prompt), reply = { jobId, sessionKey, body: 'Received' };
      if (checked) {
        subsequentWakes.push(workflow.context(jobId, sessionKey).messages.flatMap(row => row.messageIds));
        workflow.complete({ jobId, sessionKey, reason: 'Handled after safe admission' });
        return { runId: jobId };
      }
      assert.equal(workflow.context(jobId, sessionKey).messages.find(row => row.threadId === 'bb03')?.replyAllowed, false);
      await assert.rejects(workflow.reply({ ...reply, threadId: 'bb03' }), /external-or-invalid-sender/);
      await assert.rejects(workflow.reply({ ...reply, threadId: 'bb01' }), /acknowledgment/);
      await assert.rejects(workflow.reply({ ...reply, threadId: 'bb01' }), /duplicate/);
      h.setFixture(mailbox);
      await workflow.reply({ ...reply, threadId: 'bb02' });
      assert.throws(() => workflow.complete({ jobId, sessionKey, reason: 'All sent' }), /uncertain/);
      assert.throws(() => workflow.complete({ jobId, sessionKey, reason: 'Retry later' }, Math.floor(Date.now() / 1000) + 60), /uncertain/);
      assert.throws(() => workflow.skip({ jobId, sessionKey, reason: 'Skip' }), /uncertain/);
      checked = true; return { runId: jobId };
    }, waitForRun: async () => ({ status: 'ok' }),
  } });
  try {
    await workflow.start(); await waitFor(() => !workflow.status().working && !workflow.status().triage!.labeling);
    assert.ok(checked, JSON.stringify(workflow.status().unresolvedJobs));
    assert.equal(workflow.status().jobs.failed, 1);
    assert.equal(workflow.inspect('aa01')[0].message.status, 'failed');
    assert.equal(workflow.inspect('aa02')[0].message.status, 'done');
    assert.equal(h.calls().filter(args => args.includes('send')).length, 2);
    const snapshot = workflow.inspectJob(String(workflow.status().unresolvedJobs[0].id));
    assert.deepEqual(snapshot.replies.map(row => row.status).sort(), ['sent', 'uncertain']);
    const followup = message('aa04', 'Following up on the uncertain conversation'); followup.threadId = 'bb01';
    const healthy = message('aa05', 'Independent new work'); healthy.threadId = 'bb04';
    mailbox.search.messages.push(...[followup, healthy].map(({ id, threadId }) => ({ id, threadId })));
    mailbox.threads.bb01.thread.messages.push(followup);
    mailbox.threads.bb04 = { thread: { id: 'bb04', messages: [healthy] } };
    h.setFixture(mailbox);
    await workflow.poll(); await waitFor(() => !workflow.status().working);
    assert.deepEqual(subsequentWakes, [['aa05']], `an uncertain predecessor holds only its conversation, not unrelated work: ${JSON.stringify(workflow.inspect().map(row => ({ id: row.id, status: row.message.status, reason: row.message.reason })))}`);
    assert.equal(workflow.inspect('aa04')[0].message.status, 'needs_review');
    workflow.resolve(snapshot.job.id, 'Confirmed prior external outcome; do not resend');
    await workflow.poll(); await waitFor(() => !workflow.status().working);
    assert.deepEqual(subsequentWakes, [['aa05'], ['aa04']], 'manual reconciliation releases the held follow-up');
    assert.equal(h.calls().filter(args => args.includes('send')).length, 2, 'recovery retains old send receipts');
  } finally { await workflow.stop(); }
}));

test('mail queued during a thread fetch is handled by the next job, not ignored', async () => withHarness(async (h) => {
  h.setFixture(fixture([]));
  const mail = new GogMailClient(h.config);
  const getThread = mail.getThread.bind(mail);
  let reads = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  mail.getThread = async (id) => {
    const snapshot = await getThread(id);
    if (++reads === 2) await held;
    return snapshot;
  };
  let workflow: ReturnType<typeof createMailWorkflow>;
  const jobs: string[] = [];
  workflow = createMailWorkflow({ config: h.config, stateDir: h.stateDir, mail, subagent: {
    run: async ({ sessionKey, message: prompt }) => {
      const jobId = jobIdFromPrompt(prompt);
      jobs.push(jobId);
      workflow.skip({ jobId, sessionKey, reason: 'Handled' });
      return { runId: jobId };
    },
    waitForRun: async () => ({ status: 'ok' }),
  } });
  try {
    await workflow.start();
    const first = message('aa01', 'First message');
    h.setFixture(fixture([first]));
    await workflow.poll();
    await waitFor(() => reads === 2);
    h.setFixture(fixture([first, message('aa02', 'Arrived during fetch')]));
    await workflow.poll();
    release();
    await waitFor(() => !workflow.status().working);
    assert.equal(jobs.length, 2);
    assert.deepEqual(workflow.status().messages, { done: 2 });
  } finally {
    release();
    await workflow.stop();
  }
}));

test('agent concurrency is live-configurable while same-thread runs and whole-cycle wakes stay ordered', async t => {
  for (const triage of [false, true]) await t.test(triage ? 'triage' : 'responder', async () => withHarness(async h => {
    h.setFixture(fixture([]));
    let release!: () => void;
    const firstRun = new Promise<void>(resolve => { release = resolve; });
    let workflow: ReturnType<typeof createMailWorkflow>;
    const runs: Array<{ jobId: string; sessionKey: string; ids: string[] }> = [];
    const provider = assessments(() => ({ action: { type: 'choice', choice: 'wake', probabilities: {} } }));
    workflow = createMailWorkflow({ config: triage ? triageConfig(h.config) : h.config, stateDir: h.stateDir, ...provider, subagent: {
      run: async ({ sessionKey, message: prompt }) => {
        const jobId = jobIdFromPrompt(prompt);
        runs.push({ jobId, sessionKey, ids: workflow.context(jobId, sessionKey).messages.flatMap(row => row.messageIds) });
        return { runId: jobId };
      },
      waitForRun: async ({ runId }) => {
        const run = runs.find(run => run.jobId === runId)!;
        if (run === runs[0]) await firstRun;
        workflow.complete({ jobId: run.jobId, sessionKey: run.sessionKey, reason: 'Handled this conversation' });
        return { status: 'ok' };
      },
    } });
    try {
      await workflow.start();
      const first = message('aa01', 'Long task'), other = { ...message('aa02', 'Independent urgent task'), threadId: 'bb02' };
      const mailbox = separateThreads([first]);
      h.setFixture(mailbox); await workflow.poll(); await waitFor(() => runs.length === 1);
      Object.assign(mailbox.threads, separateThreads([other]).threads);
      mailbox.search.messages.push({ id: other.id, threadId: other.threadId });
      h.setFixture(mailbox); await workflow.poll();
      assert.equal(runs.length, 1, 'default capacity preserves current deployment behavior');
      workflow.policyUpdate(undefined, workflow.policyGet().version, 'helper', { agentConcurrency: 2 });
      await waitFor(() => runs.length === 2);
      assert.deepEqual(runs[1].ids, ['aa02'], 'independent mail runs before the held run finishes');
      const followup = message('aa03', 'Follow-up in the busy conversation');
      mailbox.threads.bb01.thread.messages.push(followup);
      mailbox.search.messages.push({ id: followup.id, threadId: followup.threadId });
      h.setFixture(mailbox); await workflow.poll();
      assert.equal(runs.length, 2, 'one thread cannot have overlapping agent jobs');
      release(); await waitFor(() => !workflow.status().working && runs.length === 3);
      assert.deepEqual(runs[2].ids, ['aa03']);
      assert.equal(workflow.status().messages.done, 3);
    } finally { release(); await workflow.stop(); }
  }));
});

test('live settings keep timer polls and newly admitted workers in the service context', async () => withHarness(async h => {
  const invocation = new AsyncLocalStorage<AbortSignal>();
  h.setFixture(fixture([]));
  let release!: () => void;
  const firstRun = new Promise<void>(resolve => { release = resolve; });
  const runs: Array<{ jobId: string; sessionKey: string }> = [];
  let workflow: ReturnType<typeof createMailWorkflow>;
  workflow = createMailWorkflow({ config: h.config, stateDir: h.stateDir, subagent: {
    async run({ sessionKey, message: prompt }) {
      invocation.getStore()?.throwIfAborted();
      const jobId = jobIdFromPrompt(prompt);
      runs.push({ jobId, sessionKey });
      return { runId: jobId };
    },
    async waitForRun({ runId }) {
      invocation.getStore()?.throwIfAborted();
      const run = runs.find(run => run.jobId === runId)!;
      if (run === runs[0]) await firstRun;
      workflow.complete({ ...run, reason: 'Handled' });
      return { status: 'ok' };
    },
  } });
  try {
    await workflow.start();
    const first = message('aa01', 'First task');
    const second = { ...message('aa02', 'Second task'), threadId: 'bb02' };
    const third = { ...message('aa03', 'Later arrival'), threadId: 'bb03' };
    h.setFixture(separateThreads([first]));
    await workflow.poll();
    await waitFor(() => runs.length === 1);
    h.setFixture(separateThreads([first, second]));
    await workflow.poll();
    const authority = new AbortController();
    invocation.run(authority.signal, () => workflow.policyUpdate(undefined, workflow.policyGet().version, 'operator', {
      pollIntervalSeconds: 1, agentConcurrency: 2,
    }));
    authority.abort(new Error('operator tool invocation authority expired'));
    await waitFor(() => runs.length === 2 || workflow.status().unresolvedJobs.length > 0);
    assert.equal(runs.length, 2, 'the newly admitted worker must outlive the settings invocation');
    release();
    await waitFor(() => workflow.status().messages.done === 2);
    h.setFixture(separateThreads([first, second, third]));
    await waitFor(() => workflow.status().messages.done === 3 || workflow.status().unresolvedJobs.length > 0);
    assert.equal(workflow.status().messages.done, 3, 'the rescheduled timer must outlive the settings invocation');
    assert.equal(runs.length, 3);
  } finally { release(); await workflow.stop(); }
}));

test('historical inference does not pause new-mail discovery and wakes', async () => withHarness(async h => {
  h.setFixture(fixture([]));
  let release!: () => void, entered = false, woke = false;
  const historical = new Promise<void>(resolve => { release = resolve; });
  const provider = assessments(() => ({ action: { type: 'choice', choice: 'wake', probabilities: {} } }));
  const decisions: DecisionRuntimeV1 = { evaluate: async (batch, opts) => {
    if (!opts.purpose.endsWith('delete-scan')) return provider.decisions.evaluate(batch, opts);
    entered = true; await historical;
    return { status: 'ok', provenance: { providerId: 'typesafe', rubricVersion: 'mail-v3', runtimeGeneration: 'test' },
      result: { model: 'jev-1.13.0', answers: labelAnswers(batch, 'delete') } };
  } };
  let workflow: ReturnType<typeof createMailWorkflow>;
  workflow = createMailWorkflow({ config: triageConfig(h.config, { policy: { ...defaultPolicy, deletePrompt: 'Delete old promotions' } }),
    stateDir: h.stateDir, ...provider, decisions, subagent: {
      run: async ({ sessionKey, message: prompt }) => {
        const jobId = jobIdFromPrompt(prompt);
        assert.deepEqual(workflow.context(jobId, sessionKey).messages.flatMap(row => row.messageIds), ['aa02']);
        workflow.complete({ jobId, sessionKey, reason: 'Handled new mail during cleanup' }); woke = true;
        return { runId: jobId };
      }, waitForRun: async () => ({ status: 'ok' }),
    } });
  let scan: ReturnType<typeof workflow.scan> | undefined;
  try {
    await workflow.start();
    const old = message('aa01', 'Old promotion', { received: Date.parse('2025-04-01') });
    h.setFixture(separateThreads([old]));
    scan = workflow.scan({ from: '2025-01-01', to: '2026-01-01' }); await waitFor(() => entered);
    const recent = { ...message('aa02', 'Please respond now'), threadId: 'bb02' };
    h.setFixture(separateThreads([old, recent]));
    await workflow.poll();
    assert.ok(workflow.inspect(recent.id).length, 'routine discovery must proceed while historical inference is pending');
    await waitFor(() => woke);
    assert.equal(workflow.status().scan?.status, 'processing');
    release(); assert.equal((await scan).deleted, 1);
    assert.equal(workflow.inspect(recent.id)[0].message.status, 'done');
  } finally { release(); await scan?.catch(() => {}); await workflow.stop(); }
}));

test('historical deletion cannot remove later pages from concurrent inbox discovery', async () => withHarness(async h => {
  h.setFixture(fixture([]));
  let releasePage!: () => void, pageWaiting = false, pageRead = false, scanDecisions = 0;
  const pageGate = new Promise<void>(resolve => { releasePage = resolve; });
  const mail = new GogMailClient(h.config), searchPage = mail.searchPage.bind(mail), modify = mail.modify.bind(mail);
  mail.searchPage = async (after, page, scope, before) => {
    if (scope === 'inbox' && page) { pageWaiting = true; await pageGate; }
    const result = await searchPage(after, page, scope, before);
    if (scope === 'inbox' && page) pageRead = true;
    return result;
  };
  mail.modify = async (...args) => {
    assert.ok(pageRead, 'plugin mutations must wait until every inbox page is read');
    return modify(...args);
  };
  const provider = assessments();
  const decisions: DecisionRuntimeV1 = { evaluate: async (batch, opts) => {
    if (!opts.purpose.endsWith('delete-scan')) return provider.decisions.evaluate(batch, opts);
    scanDecisions++;
    const threadId = (batch.state as { threadId: string }).threadId;
    return { status: 'ok', provenance: { providerId: 'typesafe', rubricVersion: 'mail-v3', runtimeGeneration: 'test' },
      result: { model: 'jev-1.13.0', answers: labelAnswers(batch, threadId === 'bb02' ? 'delete' : 'keep') } };
  } };
  const workflow = createMailWorkflow({ config: triageConfig(h.config, { policy: { ...defaultPolicy, deletePrompt: 'Delete promotions' } }),
    stateDir: h.stateDir, mail, ...provider, decisions,
    subagent: { run: async () => { throw new Error('queue is not due'); }, waitForRun: async () => ({ status: 'ok' }) } });
  let poll: Promise<void> | undefined, scan: ReturnType<typeof workflow.scan> | undefined;
  try {
    await workflow.start();
    const received = Date.now() - 60000;
    const mailbox = separateThreads([message('aa01', 'Keep', { received }), { ...message('aa02', 'Promotion', { received }), threadId: 'bb02' }]);
    mailbox.pages = { p2: { messages: mailbox.search.messages.slice(1) } };
    mailbox.search = { messages: mailbox.search.messages.slice(0, 1), nextPageToken: 'p2' };
    h.setFixture(mailbox);
    poll = workflow.poll(); await waitFor(() => pageWaiting);
    scan = workflow.scan({ from: new Date(received - 1000).toISOString(), to: new Date(received + 1000).toISOString() });
    await waitFor(() => scanDecisions === 2);
    // Give the independent scan time to attempt its write while page two is held.
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(h.calls().filter(args => args.includes('modify')).length, 0);
    releasePage(); await poll;
    const report = await scan;
    assert.equal(report.deleted, 1); assert.equal(report.failed, 0);
    assert.equal(workflow.inspect().length, 2, 'deletion must not hide the later-page candidate');
    assert.equal(workflow.inspect('aa01')[0].message.status, 'queue');
    assert.equal(workflow.inspect('aa02')[0].message.status, 'done', 'a stale poll must not resurrect deleted work');
  } finally { releasePage(); await Promise.allSettled([poll, scan]); await workflow.stop(); }
}));

test('explicit recovery retries unfinished work without replaying completed replies', async t => {
  for (const triage of [false, true]) await t.test(triage ? 'partial triage reply' : 'unacted responder', async () => withHarness(async h => {
    h.setFixture(fixture([]));
    const provider = assessments(() => ({ action: { type: 'choice', choice: 'wake', probabilities: {} } }));
    let workflow: ReturnType<typeof createMailWorkflow>, runs = 0;
    const jobs: string[] = [];
    workflow = createMailWorkflow({ config: triage ? triageConfig(h.config) : h.config, stateDir: h.stateDir, ...provider, subagent: {
      run: async ({ sessionKey, message: prompt }) => {
        runs++;
        const jobId = jobIdFromPrompt(prompt); jobs.push(jobId);
        if (runs === 1) {
          if (triage) await workflow.reply({ jobId, sessionKey, threadId: 'bb01', body: 'First answered' });
          throw new Error('Known failure before remaining work');
        }
        const ids = workflow.context(jobId, sessionKey).messages.flatMap(row => row.messageIds);
        assert.deepEqual(ids, triage ? ['aa02'] : ['aa01']);
        await workflow.reply({ jobId, sessionKey, body: 'Recovered work answered' });
        if (triage) workflow.complete({ jobId, sessionKey, reason: 'Recovered remainder complete' });
        return { runId: jobId };
      }, waitForRun: async () => ({ status: 'ok' }),
    } });
    try {
      await workflow.start();
      const messages = [message('aa01', 'First request')];
      if (triage) messages.push({ ...message('aa02', 'Second request'), threadId: 'bb02' });
      h.setFixture(separateThreads(messages));
      await workflow.poll(); await waitFor(() => !workflow.status().working);
      assert.equal(workflow.status().unresolvedJobs.length, 1);
      workflow.resolve(jobs[0], 'Confirmed the host run ended; remaining work has not been performed', 'retry');
      await workflow.poll(); await waitFor(() => !workflow.status().working);
      assert.equal(runs, 2, 'retry actually resumes rather than marking work done');
      assert.notEqual(jobs[0], jobs[1], 'recovery dispatch has a new idempotency identity');
      assert.equal(workflow.status().messages.done, messages.length);
      assert.equal(h.calls().filter(args => args.includes('send')).length, messages.length);
      assert.equal(workflow.status().unresolvedJobs.length, 0);
    } finally { await workflow.stop(); }
  }));
});

test('re-added rules exclude disabled-period mail while continuously matching rules still authorize it', async t => withHarness(async h => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  h.setFixture(fixture([]));
  const config = { ...h.config, domains: ['example.com', 'outside.test'], senders: ['bek@other.test', 'dual@outside.test'] };
  let workflow: ReturnType<typeof createMailWorkflow>;
  const subagent: MailSubagent = {
    run: async ({ sessionKey, message: prompt }: { sessionKey: string; message: string }) => {
      const jobId = jobIdFromPrompt(prompt);
      workflow.skip({ jobId, sessionKey, reason: 'Handled' });
      return { runId: jobId };
    },
    waitForRun: async () => ({ status: 'ok' }),
  };
  workflow = createMailWorkflow({ config, stateDir: h.stateDir, subagent });
  try {
    await workflow.start();
    await workflow.stop();
    t.mock.timers.setTime(Date.now() + 3600000);
    workflow = createMailWorkflow({ config: { ...h.config, senders: ['dual@outside.test'] }, stateDir: h.stateDir, subagent });
    await workflow.start();
    await workflow.stop();
    const old = Date.now();
    t.mock.timers.setTime(Date.now() + 60000);
    h.setFixture(fixture([
      message('aa01', 'While domain disabled', { sender: 'bek@outside.test', received: old }),
      message('aa02', 'While sender disabled', { sender: 'bek@other.test', received: old }),
      message('aa03', 'Still-approved sender', { received: old }),
      message('aa06', 'Sender route stayed enabled while domain was disabled', { sender: 'dual@outside.test', received: old }),
    ]));
    workflow = createMailWorkflow({ config, stateDir: h.stateDir, subagent });
    await workflow.start();
    await waitFor(() => !workflow.status().working);
    assert.deepEqual(workflow.status().messages, { done: 2, ignored: 2 });
    h.setFixture(fixture([
      message('aa04', 'After domain re-added', { sender: 'bek@outside.test' }),
      message('aa05', 'After sender re-added', { sender: 'bek@other.test' }),
    ]));
    await workflow.poll();
    await waitFor(() => !workflow.status().working);
    assert.deepEqual(workflow.status().messages, { done: 4, ignored: 2 });
  } finally {
    await workflow.stop();
  }
}));

test('new mail uses full chronological thread and a stable session, then sends only through gog', async () => withHarness(async (h) => {
  const old = message('aa00', 'Original request', { received: Date.now() - 86_400_000 });
  const sent = message('aa02', 'Prior agent reply', { sender: account, received: Date.now() - 3000 });
  const external = message('aa03', 'External context', { sender: 'guest@outside.test', received: Date.now() - 2000 });
  const incoming = message('aa04', 'Please follow up.', { headers: {
    To: `${account}, "Sarah, Team" <SARAH@example.com>, guest@external.test`,
    Cc: 'sarah@example.com, alias@example.com, Charlie <charlie@example.com>, bek@unblocklabs.ai',
    'Reply-To': 'attacker@example.com', Bcc: 'hidden@example.com',
  } });
  const config = parseConfig({ account, senders: [approved, 'sarah@example.com', 'charlie@example.com', 'bek@unblocklabs.ai'],
    selfAddresses: ['alias@example.com'], gogPath: fakeGog });
  h.setFixture(fixture([]));

  let workflow: ReturnType<typeof createMailWorkflow>;
  const runs: Array<Parameters<MailSubagent['run']>[0]> = [];
  const subagent: MailSubagent = {
    run: async (params) => {
      runs.push(params);
      const transcript = transcriptFromPrompt(params.message);
      const positions = ['Original request', 'Prior agent reply', 'External context', 'Please follow up.'].map(text => transcript.indexOf(text));
      assert.ok(positions.every((position, i) => position >= 0 && (i === 0 || position > positions[i - 1])), 'every message is present in chronological order');
      const reply = { jobId: jobIdFromPrompt(params.message), sessionKey: params.sessionKey, body: 'Intro <unsafe>\n\n- First\n- Second & final' };
      workflow.policyUpdate(undefined, workflow.policyGet().version, 'helper', { replyAllowed: false });
      await assert.rejects(workflow.reply(reply), /disabled/);
      workflow.policyUpdate(undefined, workflow.policyGet().version, 'helper', { replyAllowed: true });
      await assert.rejects(workflow.reply({ ...reply, externalTo: ['a@external.test,b@external.test'] }), /invalid explicit external recipient/);
      await workflow.reply({ ...reply, externalTo: ['Customer <CUSTOMER@external.test>', 'customer@external.test'] });
      return { runId: 'run-1', sessionKey: params.sessionKey };
    },
    waitForRun: async () => ({ status: 'ok' }),
  };
  workflow = createMailWorkflow({ config, stateDir: h.stateDir, subagent });
  try {
    await workflow.start();
    workflow.policyUpdate(undefined, workflow.policyGet().version, 'main', { responderPrompt: 'Summarize any commitments before responding.' });
    const pollFixture = fixture([incoming, external, old, sent], [incoming]);
    // Gmail can omit the value of an empty header in an otherwise valid thread.
    pollFixture.threads.bb01!.thread.messages[0] = {
      ...incoming,
      payload: {
        ...incoming.payload,
        headers: [...(incoming.payload.headers ?? []), { name: 'X-MS-TNEF-Correlator' }],
      },
    };
    h.setFixture(pollFixture);
    await workflow.poll();
    await waitFor(() => !workflow.status().working);
    assert.equal(workflow.status().jobs.replied, 1);
    assert.equal(runs.length, 1);
    assert.match(runs[0].message, /Summarize any commitments before responding/);
    assert.equal(runs[0]?.sessionKey, `agent:main:gog-email-watch:${account}:bb01`);
    const send = h.calls().find((args) => args.includes('send'));
    assert.ok(send);
    assert.equal(send[send.indexOf('--to') + 1], `${approved},sarah@example.com,customer@external.test`);
    assert.equal(send[send.indexOf('--cc') + 1], 'charlie@example.com,bek@unblocklabs.ai');
    assert.equal(send[send.indexOf('--reply-to-message-id') + 1], incoming.id);
    assert.ok(!send.includes('--reply-all'));
    assert.match(h.sentBody(), /Intro &lt;unsafe&gt;/);
    assert.match(h.sentBody(), /<ul><li>First<\/li><li>Second &amp; final<\/li><\/ul>/);
    assert.deepEqual(workflow.status().messages, { done: 1 });
  } finally { await workflow.stop(); }
}));

test('duplicate mail and restart do not dispatch again; an explicit skip completes a job', async () => withHarness(async (h) => {
  h.setFixture(fixture([]));
  let runs = 0;
  let workflow: ReturnType<typeof createMailWorkflow>;
  const subagent: MailSubagent = {
    run: async (params) => {
      runs++;
      workflow.skip({ jobId: jobIdFromPrompt(params.message), sessionKey: params.sessionKey, reason: 'Already handled' });
      return { runId: 'run-2', sessionKey: params.sessionKey };
    },
    waitForRun: async () => ({ status: 'ok' }),
  };
  workflow = createMailWorkflow({ config: h.config, stateDir: h.stateDir, subagent });
  try {
    await workflow.start();
    const incoming = message('aa01', 'No reply is needed.');
    h.setFixture(fixture([incoming]));
    await workflow.poll();
    await waitFor(() => workflow.status().jobs.skipped === 1);
    await workflow.stop();
    workflow = createMailWorkflow({ config: h.config, stateDir: h.stateDir, subagent });
    await workflow.start();
    await workflow.poll();
    assert.equal(runs, 1);
    assert.equal(h.calls().filter((args) => args.includes('send')).length, 0);
    const db = h.db();
    assert.equal((db.prepare("SELECT status FROM jobs").get() as { status: string }).status, 'skipped');
    db.close();
  } finally { await workflow.stop(); }
}));

test('only authorized human mail dispatches; unreadable threads retry after restart without blocking healthy mail', async () => withHarness(async h => {
  h.setFixture(fixture([]));
  const rejected = [
    message('aa01', 'Unapproved domain', { sender: 'bad@example.com.evil.com' }),
    message('aa02', 'Subdomain is not approved', { sender: 'bad@sub.example.com' }),
    message('aa03', 'Self', { sender: account }),
    message('aa04', 'Multiple From addresses', { sender: 'one@example.com,two@example.com', headers: { 'Authentication-Results': 'mx.google.com; dmarc=pass header.from=example.com' } }),
    message('aa05', 'Missing authentication', { headers: { 'Authentication-Results': '' } }),
    message('aa06', 'Non-Google authentication', { headers: { 'Authentication-Results': 'evil.example; dmarc=pass header.from=example.com' } }),
    message('aa07', 'Failed authentication', { headers: { 'Authentication-Results': 'mx.google.com; dmarc=fail header.from=example.com' } }),
    message('aa08', 'Mismatched authentication domain', { headers: { 'Authentication-Results': 'mx.google.com; dmarc=pass header.from=example.com.evil.com' } }),
    message('aa09', 'Forged second header', { headers: { 'Authentication-Results': 'mx.google.com; dmarc=fail header.from=example.com' } }),
    message('aa0a', 'Before activation', { received: Date.now() - 60000 }),
    message('aa0b', 'Automatic reply', { headers: { 'Auto-Submitted': 'auto-replied' } }),
    message('aa0c', 'Mailing list', { headers: { 'List-ID': 'list' } }),
    message('aa0d', 'Sent mail'),
  ];
  rejected[8].payload.headers!.push({ name: 'Authentication-Results', value: 'mx.google.com; dmarc=pass header.from=example.com' });
  rejected[12].labelIds = ['SENT'];
  const healthy = message('ab01', 'Healthy mail'), unreadable = message('ab02', 'Temporarily unreadable');
  for (const m of [...rejected, healthy, unreadable]) m.threadId = `bb${m.id}`;
  const deliveries: string[] = [];
  const config = { ...h.config, settings: { retryDelaySeconds: 0 } };
  let workflow: ReturnType<typeof createMailWorkflow>;
  const subagent: MailSubagent = {
    run: async ({ sessionKey, message: prompt }) => {
      const jobId = jobIdFromPrompt(prompt);
      deliveries.push(workflow.context(jobId, sessionKey).job.target_id);
      workflow.skip({ jobId, sessionKey, reason: 'Handled' });
      return { runId: jobId };
    }, waitForRun: async () => ({ status: 'ok' }),
  };
  workflow = createMailWorkflow({ config, stateDir: h.stateDir, subagent });
  try {
    await workflow.start();
    const f = separateThreads([...rejected, healthy, unreadable]);
    const missing = f.threads[unreadable.threadId];
    delete f.threads[unreadable.threadId];
    h.setFixture(f);
    await workflow.poll(); await waitFor(() => !workflow.status().working);
    assert.deepEqual(deliveries, [healthy.id]);
    assert.deepEqual(workflow.status().messages, { done: 1, ignored: rejected.length, pending: 1 });
    assert.equal(workflow.inspect(unreadable.id)[0].message.status, 'pending');
    await workflow.stop();
    f.threads[unreadable.threadId] = missing;
    h.setFixture(f);
    workflow = createMailWorkflow({ config, stateDir: h.stateDir, subagent });
    await workflow.start(); await waitFor(() => !workflow.status().working);
    assert.deepEqual(deliveries, [healthy.id, unreadable.id]);
    assert.deepEqual(workflow.status().messages, { done: 2, ignored: rejected.length });
    assert.deepEqual(workflow.status().jobs, { skipped: 2 });
  } finally { await workflow.stop(); }
}));

test('deferred responder waits for its active run, resumes once when due and repairs old acknowledgments', async t => withHarness(async h => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  h.setFixture(fixture([]));
  const config = h.config;
  let workflow: ReturnType<typeof createMailWorkflow>, runs = 0;
  let acknowledgedStatus: string | undefined;
  let release!: () => void, waits = 0;
  const firstRun = new Promise<void>(resolve => { release = resolve; });
  const subagent: MailSubagent = {
    run: async ({ sessionKey, message: prompt }: { sessionKey: string; message: string }) => {
      runs++;
      const jobId = /Job ID: ([a-f0-9]{24})/.exec(prompt)![1];
      if (runs < 3) {
        workflow.complete({ jobId, sessionKey, reason: 'Waiting for scheduled check' }, Math.floor(Date.now() / 1000) + 3600);
        if (runs === 1) acknowledgedStatus = workflow.inspect('aa01')[0].message.status;
      }
      else workflow.complete({ jobId, sessionKey, reason: 'Completed' });
      return { runId: jobId, sessionKey };
    }, waitForRun: async () => { if (++waits === 1) await firstRun; return { status: 'ok' }; },
  };
  workflow = createMailWorkflow({ config, stateDir: h.stateDir, subagent });
  try {
    await workflow.start(); h.setFixture(fixture([message('aa01', 'Please help')]));
    await workflow.poll(); await waitFor(() => acknowledgedStatus !== undefined);
    assert.equal(acknowledgedStatus, 'deferred', 'defer is durable before the run ends');
    assert.equal(workflow.status().messages.deferred, 1);
    t.mock.timers.setTime(Date.now() + 3599000);
    await workflow.poll();
    assert.equal(runs, 1, 'must not resume early');
    t.mock.timers.setTime(Date.now() + 1000);
    await workflow.poll();
    assert.equal(runs, 1, 'a due retry cannot overlap its still-active predecessor');
    release(); await waitFor(() => !workflow.status().working);
    assert.equal(runs, 2, 'the predecessor finalizer must not overwrite the due retry');
    await workflow.stop();
    const legacy = h.db();
    legacy.prepare("UPDATE messages SET status='processing' WHERE status='deferred'").run();
    legacy.close();
    workflow = createMailWorkflow({ config, stateDir: h.stateDir, subagent });
    await workflow.start();
    assert.equal(workflow.status().messages.deferred, 1, 'restart repairs legacy acknowledged deferrals');
    t.mock.timers.setTime(Date.now() + 3599000);
    await workflow.poll(); await waitFor(() => !workflow.status().working);
    assert.equal(runs, 2, 'restart must retain the second deferral deadline');
    t.mock.timers.setTime(Date.now() + 1000);
    await workflow.poll(); await waitFor(() => !workflow.status().working);
    assert.equal(runs, 3); assert.equal(workflow.status().jobs.completed, 1);
  } finally { release(); await workflow.stop(); }
}));

test('deferred daily queue resumes together at the explicit time after restart', async t => withHarness(async h => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const messages = ['aa01', 'aa02'].map(id => message(id, 'Queued work', { received: Date.now() - 60000 }));
  h.setFixture(fixture(messages));
  const provider = assessments();
  const config = triageConfig(h.config);
  let workflow: ReturnType<typeof createMailWorkflow>;
  const wakes: string[][] = [];
  const subagent: MailSubagent = {
    run: async ({ sessionKey, message: prompt }: { sessionKey: string; message: string }) => {
      const jobId = jobIdFromPrompt(prompt);
      assert.equal(workflow.status().activeJob?.id, jobId);
      assert.equal(workflow.status().activeJob?.elapsedSeconds, 0);
      wakes.push(workflow.context(jobId, sessionKey).messages.map(row => row.id));
      workflow.complete({ jobId, sessionKey, reason: 'Work outcome' }, wakes.length === 1 ? Math.floor(Date.now() / 1000) + 3600 : undefined);
      return { runId: jobId, sessionKey };
    }, waitForRun: async () => ({ status: 'ok' }),
  };
  workflow = createMailWorkflow({ config, stateDir: h.stateDir, ...provider, subagent });
  try {
    await workflow.start();
    assert.equal(workflow.status().nextQueueWakeAt, Math.floor(Date.now() / 1000) + 86400);
    t.mock.timers.setTime(Date.now() + 86400000);
    await workflow.poll(); await waitFor(() => !workflow.status().working);
    assert.deepEqual(wakes, [['aa01']]);
    assert.equal(workflow.status().messages.deferred, 2);
    assert.equal(workflow.status().nextDeferredWakeAt, Math.floor(Date.now() / 1000) + 3600);
    await workflow.stop();
    workflow = createMailWorkflow({ config, stateDir: h.stateDir, ...provider, subagent });
    await workflow.start();
    t.mock.timers.setTime(Date.now() + 3599000);
    await workflow.poll(); assert.equal(wakes.length, 1);
    t.mock.timers.setTime(Date.now() + 1000);
    await workflow.poll(); await waitFor(() => !workflow.status().working);
    assert.deepEqual(wakes, [['aa01'], ['aa01']], 'explicit defer must not wait for another daily queue interval');
    assert.equal(provider.calls(), 2, 'explicit deferral reassesses the chain once with the new day');
    assert.equal(workflow.status().messages.done, 2);
    assert.equal(workflow.status().activeJob, null);
    assert.equal(workflow.status().nextDeferredWakeAt, null);
  } finally { await workflow.stop(); }
}));

test('a large old-mail cycle drains all pages with configured concurrency, one wake and no daily budget', async () => withHarness(async h => {
  const messages = Array.from({ length: 251 }, (_, i) => {
    const m = message((0xaa00 + i).toString(16), 'Actionable backlog', { received: Date.now() - 86400000 });
    m.threadId = (0xbb00 + i).toString(16); return m;
  });
  // Dedicated responder regressions probe SQLite locking. Parallel fake Gmail
  // processes must not manufacture competing SQLite writers in this load test.
  const f = { ...separateThreads(messages), probeWritableDb: false }, refs = f.search.messages;
  f.search = { messages: refs.slice(0, 80), nextPageToken: 'p2' };
  f.pages = { p2: { messages: refs.slice(80, 160), nextPageToken: 'p3' }, p3: { messages: refs.slice(160, 240), nextPageToken: 'p4' }, p4: { messages: refs.slice(240) } };
  h.setFixture(f);
  let active = 0, peak = 0, calls = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const provider = assessments(() => ({ action: { type: 'choice', choice: 'wake', probabilities: { wake: 1 } } }));
  const decisions: DecisionRuntimeV1 = { evaluate: async (batch, options) => {
    active++; calls++; peak = Math.max(peak, active);
    await gate;
    try { return await provider.decisions.evaluate(batch, options); } finally { active--; }
  } };
  let workflow: ReturnType<typeof createMailWorkflow>;
  const wakes: string[][] = [];
  workflow = createMailWorkflow({ config: triageConfig(h.config), stateDir: h.stateDir, ...provider, decisions, subagent: {
    run: async ({ sessionKey, message: prompt }) => {
      const jobId = jobIdFromPrompt(prompt);
      const context = workflow.context(jobId, sessionKey);
      wakes.push(context.messages.map(row => row.id));
      assert.match(readFileSync(context.messages[0].transcript!, 'utf8'), /Actionable backlog/);
      workflow.complete({ jobId, sessionKey, reason: 'All handled' });
      return { runId: jobId, sessionKey };
    }, waitForRun: async () => ({ status: 'ok' }),
  } });
  const started = workflow.start();
  try {
    await waitFor(() => calls >= 50); release();
    // This fixture spawns hundreds of real CLI processes; completion is the
    // contract, not a five-second wall-clock deadline on a shared CI runner.
    await started; await waitFor(() => !workflow.status().working, 30000);
    // Real Gmail treats after:0 as an empty result, not an unbounded search.
    assert.ok(h.calls().filter(args => args.includes('search')).every(args =>
      !args[args.indexOf('search') + 1].split(/\s+/).includes('after:0')));
    assert.equal(peak, 50); assert.equal(calls, 251);
    assert.equal(wakes.length, 1); assert.equal(wakes[0].length, 251);
    assert.deepEqual(workflow.status().messages, { done: 251 });
    assert.deepEqual(workflow.status().jobs, { completed: 1 });
    await workflow.poll(); assert.equal(calls, 251); assert.equal(wakes.length, 1);
    const cutoff = workflow.status().triage!.backlogBefore;
    await workflow.stop();
    workflow = createMailWorkflow({ config: triageConfig(h.config), stateDir: h.stateDir, ...provider, decisions, subagent: {
      run: async () => { throw new Error('completed cycle must not repeat'); }, waitForRun: async () => ({ status: 'ok' }),
    } });
    await workflow.start(); assert.equal(workflow.status().triage!.backlogBefore, cutoff);
    assert.equal(calls, 251);
  } finally { release(); await started; await workflow.stop(); }
}));

test('queue cadence persists and policy updates accept unbounded instructions without reclassifying scheduling changes', async t => withHarness(async h => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const old = message('aa01', 'Old queued item', { received: Date.now() - 60000 });
  h.setFixture(fixture([old]));
  const provider = assessments();
  const policy = { ...defaultPolicy, prompt: 'Instruction '.repeat(1000), deletePrompt: 'Deletion criteria '.repeat(1000), queueMinutes: 60 };
  const config = triageConfig(h.config, { policy });
  let workflow: ReturnType<typeof createMailWorkflow>;
  const wakes: string[][] = [];
  const subagent: MailSubagent = {
    run: async ({ sessionKey, message: prompt }: { sessionKey: string; message: string }) => {
      const jobId = jobIdFromPrompt(prompt);
      wakes.push(workflow.context(jobId, sessionKey).messages.map(row => row.id));
      workflow.complete({ jobId, sessionKey, reason: 'Queued mail handled' });
      return { runId: jobId, sessionKey };
    }, waitForRun: async () => ({ status: 'ok' }),
  };
  workflow = createMailWorkflow({ config, stateDir: h.stateDir, ...provider, subagent });
  try {
    await workflow.start(); assert.equal(wakes.length, 0);
    for (let poll = 0; poll < 15; poll++) {
      t.mock.timers.setTime(Date.now() + 2 * 60000);
      await workflow.poll();
      assert.equal(provider.calls(), 1, 'two-minute polls do not reclassify queued mail');
      assert.equal(wakes.length, 0);
    }
    const fresh = message('aa02', 'New mail also enters triage', { sender: 'other@outside.test' });
    fresh.threadId = 'bb02';
    h.setFixture(separateThreads([old, fresh]));
    await workflow.poll(); assert.equal(provider.calls(), 2); assert.equal(wakes.length, 0);
    await workflow.stop();
    workflow = createMailWorkflow({ config, stateDir: h.stateDir, ...provider, subagent });
    await workflow.start();
    workflow.policyUpdate({ ...policy, queueMinutes: 30 }, 1, 'delegated-agent');
    await workflow.poll(); await waitFor(() => !workflow.status().working);
    assert.deepEqual(wakes, [['aa01', 'aa02']]); assert.equal(provider.calls(), 2);
    await workflow.stop();
    workflow = createMailWorkflow({ config, stateDir: h.stateDir, ...provider, subagent });
    await workflow.start(); assert.equal(workflow.policyGet().document.queueMinutes, 30);
    assert.equal(wakes.length, 1); assert.equal(provider.calls(), 2);
  } finally { await workflow.stop(); }
}));

test('slow Gmail labeling and failed effects do not block classified wakes; arbitrary labels retry without inference', async () => withHarness(async h => {
  const first = message('aa01', 'Urgent', { received: Date.now() - 60000 });
  const second = message('aa02', 'Retry classification next cycle', { received: Date.now() - 60000 }); second.threadId = 'bb02';
  h.setFixture(separateThreads([first, second]));
  const labels = Array.from({ length: 13 }, (_, i) => ({ name: `Projects / 客户 ${i} & follow-up`, description: 'Apply to this project. '.repeat(300) }));
  let classifications = 0, labelLookups = 0, writeAttempts = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let workflow: ReturnType<typeof createMailWorkflow>, wakes = 0;
  let retryPoll: Promise<void> | undefined;
  const provider = assessments();
  const decisions: DecisionRuntimeV1 = { evaluate: async batch => {
    classifications++;
    assert.ok(!('action' in batch.questions), 'Jev classifies labels rather than choosing an action');
    if (classifications === 2) return { status: 'unavailable', reason: 'transport' };
    const topics = Object.fromEntries(labels.map((_, index) => [`label_${index}`, { type: 'choice' as const, choice: 'apply', probabilities: {} }]));
    return { status: 'ok', provenance: { providerId: 'typesafe', rubricVersion: 'mail-v3', runtimeGeneration: 'test' },
      result: { model: 'jev-1.13.0', answers: labelAnswers(batch, 'wake', topics) } };
  } };
  const config = triageConfig({ ...h.config, settings: { retryDelaySeconds: 0 } }, { concurrency: 1, policy: { ...defaultPolicy, labels } });
  const mail = new GogMailClient(config), labelId = mail.labelId.bind(mail), modify = mail.modify.bind(mail);
  mail.labelId = async name => { if (++labelLookups === 1) await gate; return labelId(name); };
  mail.modify = async (...args) => { if (++writeAttempts === 1) throw new Error('controlled Gmail label write failure'); return modify(...args); };
  workflow = createMailWorkflow({ config, mail, stateDir: h.stateDir, ...provider, decisions, subagent: {
    run: async ({ sessionKey, message: prompt }) => {
      wakes++;
      const jobId = jobIdFromPrompt(prompt); workflow.complete({ jobId, sessionKey, reason: 'Handled after classification, before Gmail labeling' });
      return { runId: jobId };
    }, waitForRun: async () => ({ status: 'ok' }),
  } });
  try {
    await workflow.start(); await waitFor(() => labelLookups === 1 && !workflow.status().working);
    assert.equal(wakes, 1); assert.equal(workflow.status().triage!.labeling, true);
    assert.equal(classifications, 2, 'unclassified mail is held while successfully classified mail wakes');
    assert.equal(workflow.inspect('aa02')[0].message.status, 'pending');
    retryPoll = workflow.poll();
    await waitFor(() => wakes === 2);
    await retryPoll;
    assert.equal(workflow.status().triage!.labeling, true, 'a classified wake does not wait for the earlier Gmail label lookup');
    release(); await waitFor(() => !workflow.status().triage!.labeling, 15000);
    assert.match(String(workflow.inspect('aa01')[0].labels?.reason), /controlled Gmail label write failure/);
    // Thirteen categories each perform real subprocess reads/writes; this is
    // completion coverage, not a five-second performance requirement.
    await workflow.poll(); await waitFor(() => !workflow.status().triage!.labeling, 15000);
    assert.equal(classifications, 3, 'Gmail effect retries reuse both successful classifications'); assert.equal(wakes, 2);
    assert.equal(workflow.inspect('aa01')[0].labels?.status, 'done');
    assert.equal(workflow.inspect('aa02')[0].labels?.status, 'done');
    const creates = h.calls().filter(args => args.includes('create'));
    assert.deepEqual(creates.map(args => args.at(-1)).sort(), [...labels.map(label => label.name), 'Needs attention now'].sort());
  } finally { release(); await retryPoll; await workflow.stop(); }
}));

test('label policy edits during a Gmail write remain pending until the new labels apply', async () => withHarness(async h => {
  h.setFixture(fixture([message('aa01', 'Receipt', { received: Date.now() - 60000 })]));
  const config = parseConfig({ ...triageConfig(h.config, { policy: { ...defaultPolicy, labels: [{ name: 'Old', description: 'All mail' }] } }),
    settings: { retryDelaySeconds: 0 } });
  const mail = new GogMailClient(config), modify = mail.modify.bind(mail);
  let writing = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  mail.modify = async (...args) => { writing = true; await gate; return modify(...args); };
  const provider = assessments(() => ({ label_0: { type: 'choice', choice: 'apply', probabilities: {} } }));
  const workflow = createMailWorkflow({ config, stateDir: h.stateDir, mail, ...provider,
    subagent: { run: async () => { throw new Error('queue is not due'); }, waitForRun: async () => ({ status: 'ok' }) } });
  try {
    await workflow.start(); await waitFor(() => writing);
    workflow.policyUpdate({ ...defaultPolicy, labels: [{ name: 'New', description: 'All mail' }] }, 1, 'main');
    release(); await waitFor(() => !workflow.status().triage!.labeling);
    await workflow.poll(); await waitFor(() => !workflow.status().triage!.labeling);
    const labels = (await mail.getThread('bb01')).messages[0].labelIds;
    assert.deepEqual(labels, ['INBOX', 'Label_1', 'Label_2', 'Label_3'], 'new topic and routing labels apply without undoing the old completed write');
    assert.equal(workflow.inspect('aa01')[0].labels?.status, 'done');
    assert.equal(provider.calls(), 2, 'one classification per label policy, with routing derived from its labels');
  } finally { release(); await workflow.stop(); }
}));

test('label retries use recreated Gmail labels without another classification', async () => withHarness(async h => {
  const target = message('aa01', 'Receipt', { received: Date.now() - 60000 });
  h.setFixture({ ...fixture([target]), labels: [{ id: 'Label_1', name: 'Receipts', type: 'user' }], modifyUncertain: true });
  const provider = assessments(() => ({ label_0: { type: 'choice', choice: 'apply', probabilities: {} } }));
  const workflow = createMailWorkflow({ config: triageConfig({ ...h.config, settings: { retryDelaySeconds: 0 } }, { policy: { ...defaultPolicy, labels: [{ name: 'Receipts', description: 'Purchase receipts', action: 'queue' }] } }),
    stateDir: h.stateDir, ...provider, subagent: { run: async () => { throw new Error('queue is not due'); }, waitForRun: async () => ({ status: 'ok' }) } });
  try {
    await workflow.start(); await waitFor(() => !workflow.status().triage!.labeling);
    assert.equal(workflow.inspect('aa01')[0].labels?.status, 'pending');
    // Gmail assigns a new ID when a user deletes and recreates a label.
    h.setFixture({ ...fixture([target]), labels: [{ id: 'Label_2', name: 'Receipts', type: 'user' }] });
    await workflow.poll(); await waitFor(() => !workflow.status().triage!.labeling);
    const thread = await new GogMailClient(h.config).getThread('bb01');
    assert.deepEqual(thread.messages[0].labelIds, ['INBOX', 'Label_2']);
    assert.equal(workflow.inspect('aa01')[0].labels?.status, 'done');
    assert.equal(provider.calls(), 1, 'recreated Gmail labels do not require a new classification');
  } finally { await workflow.stop(); }
}));

test('a rejected category does not block valid labels, and retry reuses inference', async () => withHarness(async h => {
  const target = message('aa01', 'Keep this queued', { received: Date.now() - 60000 });
  h.setFixture({ ...fixture([target]), labels: [
    { id: 'TRASH', name: 'TRASH', type: 'system' }, { id: 'STARRED', name: 'STARRED', type: 'system' },
  ] });
  const provider = assessments(() => ({ label_0: { type: 'choice', choice: 'apply', probabilities: {} }, label_1: { type: 'choice', choice: 'apply', probabilities: {} } }));
  const policy = { ...defaultPolicy, labels: [{ name: 'TRASH', description: 'Expired promotions' }, { name: 'STARRED', description: 'Worth keeping handy', action: 'queue' as const }] };
  const workflow = createMailWorkflow({ config: triageConfig({ ...h.config, settings: { retryDelaySeconds: 0 } }, { policy }), stateDir: h.stateDir, ...provider,
    subagent: { run: async () => { throw new Error('queue is not due'); }, waitForRun: async () => ({ status: 'ok' }) } });
  try {
    await workflow.start(); await waitFor(() => !workflow.status().triage!.labeling);
    const mail = new GogMailClient(h.config);
    assert.deepEqual((await mail.getThread('bb01')).messages[0].labelIds, ['INBOX', 'STARRED']);
    assert.equal(workflow.status().messages.queue, 1);
    assert.match(String(workflow.inspect('aa01')[0].labels?.reason), /mailbox-state label/);
    await workflow.poll(); await waitFor(() => !workflow.status().triage!.labeling);
    assert.equal(provider.calls(), 1, 'an unrelated category error must not cost another assessment');
    assert.equal(h.calls().filter(args => args.includes('modify')).length, 1, 'already applied healthy labels are reconciled');
    workflow.policyUpdate({ ...policy, labels: [{ name: 'STARRED', description: 'Worth keeping handy', action: 'queue' }] }, 1, 'main');
    await workflow.poll(); await waitFor(() => !workflow.status().triage!.labeling);
    assert.deepEqual((await mail.getThread('bb01')).messages[0].labelIds, ['INBOX', 'STARRED']);
    assert.equal(workflow.inspect('aa01')[0].labels?.status, 'done');
    assert.equal(provider.calls(), 2, 'editing the classification policy needs one new assessment');
  } finally { await workflow.stop(); }
}));

test('deep MIME conversations reach triage and the agent with plaintext and filenames intact', async () => withHarness(async h => {
  const target = message('aa01', 'DEEPEST_PLAINTEXT', { received: Date.now() - 60000 });
  let body: GmailMessage['payload'] = { mimeType: 'multipart/alternative', parts: [
    { mimeType: 'text/html', body: { data: Buffer.from('<p>HTML_DUPLICATE</p>').toString('base64url') } },
    { ...target.payload, headers: undefined },
  ] };
  for (let depth = 0; depth < 128; depth++) body = { mimeType: 'multipart/mixed', parts: [body] };
  target.payload = { mimeType: 'multipart/mixed', headers: target.payload.headers, parts: [
    body, { mimeType: 'application/pdf', filename: 'deep-contract.pdf', body: { attachmentId: 'not-downloaded' } },
  ] };
  h.setFixture(fixture([target]));
  const provider = assessments(() => ({ action: { type: 'choice', choice: 'wake', probabilities: {} } }));
  let classified = false, handled = false, workflow: ReturnType<typeof createMailWorkflow>;
  const decisions: DecisionRuntimeV1 = { evaluate: async (batch, opts) => {
    const text = JSON.stringify(batch.state);
    assert.match(text, /DEEPEST_PLAINTEXT/); assert.match(text, /deep-contract.pdf/);
    assert.doesNotMatch(text, /HTML_DUPLICATE/);
    classified = true; return provider.decisions.evaluate(batch, opts);
  } };
  workflow = createMailWorkflow({ config: triageConfig(h.config), stateDir: h.stateDir, ...provider, decisions, subagent: {
    run: async ({ sessionKey, message: prompt }) => {
      const jobId = jobIdFromPrompt(prompt), context = workflow.context(jobId, sessionKey);
      assert.match(readFileSync(context.messages[0].transcript!, 'utf8'), /DEEPEST_PLAINTEXT/);
      workflow.complete({ jobId, sessionKey, reason: 'Read nested mail' }); handled = true;
      return { runId: jobId };
    }, waitForRun: async () => ({ status: 'ok' }),
  } });
  try {
    await workflow.start(); await waitFor(() => !workflow.status().working);
    assert.ok(classified && handled, JSON.stringify(workflow.inspect('aa01')));
    assert.equal(workflow.status().messages.done, 1);
  } finally { await workflow.stop(); }
}));

test('date-range scans traverse all pages, delete matches only, and never queue, wake or label', async t => withHarness(async h => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 9, 19, 12).getTime() });
  h.setFixture(fixture([]));
  const deletePrompt = 'Delete expired promotions only.';
  const provider = assessments(id => ({ action: { type: 'choice', choice: id === 'bb00' ? 'keep' : 'delete', probabilities: {} } }));
  const decisions: DecisionRuntimeV1 = { evaluate: async (batch, opts) => {
    assert.equal(opts.purpose, 'gog-email-watch.delete-scan');
    assert.ok(JSON.stringify(batch.questions).includes(deletePrompt));
    assert.match(JSON.stringify(batch.questions), /Today's date: 2026-10-19 \([^)]+\)/);
    const question = batch.questions.deletion_match;
    assert.ok(question.type === 'choice');
    assert.deepEqual(Object.keys(question.criteria).sort(), ['apply', 'skip']);
    return provider.decisions.evaluate(batch, opts);
  } };
  const workflow = createMailWorkflow({ config: triageConfig(h.config, { policy: { ...defaultPolicy, deletePrompt, labels: [{ name: 'Never here', description: 'anything' }] } }),
    stateDir: h.stateDir, ...provider, decisions, subagent: { run: async () => { throw new Error('historical scan woke'); }, waitForRun: async () => ({ status: 'ok' }) } });
  try {
    await workflow.start();
    const messages = Array.from({ length: 61 }, (_, i) => message((0xaa00 + i).toString(16), 'Promotion', { received: Date.parse('2025-04-01') }));
    messages[0].threadId = 'bb00';
    const outside = message('ff01', 'Outside exact range', { received: Date.parse('2026-01-01') });
    const sent = message('ff02', 'Sent reply is context only', { sender: account, received: Date.parse('2025-04-02') }); sent.labelIds = ['SENT'];
    const f = fixture([...messages.slice(1), outside, sent]);
    f.threads.bb00 = { thread: { id: 'bb00', messages: [messages[0]] } };
    f.search.messages.unshift({ id: messages[0].id, threadId: 'bb00' });
    f.probeWritableDb = false; const refs = f.search.messages;
    f.search = { messages: refs.slice(0, 20), nextPageToken: 'p2' };
    f.pages = { p2: { messages: refs.slice(20, 40), nextPageToken: 'p3' }, p3: { messages: refs.slice(40, 60), nextPageToken: 'p4' }, p4: { messages: refs.slice(60) } };
    h.setFixture(f);
    const report = await workflow.scan({ from: '2025-01-01', to: '2026-01-01' });
    assert.equal(report.deleted, 60); assert.equal(report.results.length, 61); assert.equal(report.failed, 0);
    assert.equal(provider.calls(), 2, 'one request per chain, even when it spans discovery pages'); assert.deepEqual(workflow.status().messages, {}); assert.deepEqual(workflow.status().jobs, {});
    const calls = h.calls(), firstModify = calls.findIndex(args => args.includes('modify'));
    assert.ok(calls.findLastIndex(args => args.includes('search')) < firstModify, 'enumerate before mutations');
    assert.ok(calls.some(args => args.some(value => value.includes('before:1767225600'))));
    assert.ok(!calls.some(args => args.includes('create') || args.includes('send')));
    const thread = await new GogMailClient(h.config).getThread('bb01');
    assert.ok((await new GogMailClient(h.config).getThread('bb00')).messages[0].labelIds.includes('INBOX'));
    assert.deepEqual(thread.messages.find(m => m.id === outside.id)!.labelIds, ['INBOX']);
    assert.deepEqual(thread.messages.find(m => m.id === sent.id)!.labelIds, ['SENT']);
    assert.equal(thread.messages.filter(m => m.labelIds.includes('TRASH')).length, 60);
    // Restoring mail changes Gmail state, not the classification of its content.
    thread.messages.find(m => m.id === 'aa01')!.labelIds = ['INBOX'];
    h.setFixture({ ...fixture(thread.messages), probeWritableDb: false });
    const repeated = await workflow.scan({ from: '2025-01-01', to: '2026-01-01' });
    assert.equal(repeated.deleted, 1); assert.equal(repeated.failed, 0);
    assert.ok((await new GogMailClient(h.config).getThread('bb01')).messages.find(m => m.id === 'aa01')!.labelIds.includes('TRASH'));
    assert.equal(provider.calls(), 2, 'explicit rescans reuse unchanged conversation content while reconciling Gmail state');
    assert.equal(h.calls().filter(args => args.includes('modify')).length, 61);
  } finally { await workflow.stop(); }
}));

test('deletion rechecks mailbox scope after classification without restricting historical archived mail', async t => {
  for (const scenario of [
    { historical: false, labels: [], deleted: false },
    { historical: true, labels: ['SPAM'], deleted: false },
    { historical: true, labels: ['SENT'], deleted: false },
    { historical: true, labels: ['DRAFT'], deleted: false },
    { historical: true, labels: [], deleted: true },
  ]) await t.test(`${scenario.historical ? 'historical' : 'backlog'}: ${scenario.labels.join(',') || 'archived'}`, async () => withHarness(async h => {
    const target = message('aa01', 'Expired promotion', { received: scenario.historical ? Date.parse('2025-04-01') : Date.now() - 60000 });
    h.setFixture(fixture(scenario.historical ? [] : [target]));
    const provider = assessments(() => ({ action: { type: 'choice', choice: 'delete', probabilities: {} } }));
    const decisions: DecisionRuntimeV1 = { evaluate: async (batch, opts) => {
      // Gmail state changes while Jev is deciding; content stays identical.
      h.setFixture(fixture([{ ...target, labelIds: scenario.labels }]));
      return provider.decisions.evaluate(batch, opts);
    } };
    const workflow = createMailWorkflow({ config: triageConfig(h.config, { policy: { ...defaultPolicy, deletePrompt: 'Delete expired promotions' } }),
      stateDir: h.stateDir, ...provider, decisions,
      subagent: { run: async () => { throw new Error('deletion must not wake'); }, waitForRun: async () => ({ status: 'ok' }) } });
    try {
      await workflow.start();
      if (scenario.historical) {
        h.setFixture(fixture([target]));
        const report = await workflow.scan({ from: '2025-01-01', to: '2026-01-01' });
        assert.equal(report.deleted, Number(scenario.deleted));
      }
      const actual = (await new GogMailClient(h.config).getThread('bb01')).messages[0];
      assert.deepEqual(actual.labelIds, scenario.deleted ? ['TRASH'] : scenario.labels);
      assert.equal(h.calls().filter(args => args.includes('modify')).length, Number(scenario.deleted));
    } finally { await workflow.stop(); }
  }));
});

test('scan progress and per-message outcomes remain inspectable after the response and restart', async () => withHarness(async h => {
  h.setFixture(fixture([]));
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let entered = false;
  const provider = assessments(id => ({ action: { type: 'choice', choice: id === 'bb01' ? 'delete' : 'keep', probabilities: {} } }));
  const decisions: DecisionRuntimeV1 = { evaluate: async (batch, opts) => {
    entered = true;
    await blocked;
    if ((batch.state as { threadId: string }).threadId === 'bb03') return { status: 'unavailable', reason: 'transport' };
    return provider.decisions.evaluate(batch, opts);
  } };
  const config = triageConfig(h.config, { concurrency: 1, policy: { ...defaultPolicy, deletePrompt: 'Delete promotions.' } });
  const options: WorkflowOptions = { config, stateDir: h.stateDir, ...provider, decisions,
    subagent: { run: async () => { throw new Error('scan must not wake'); }, waitForRun: async () => ({ status: 'ok' }) } };
  let workflow = createMailWorkflow(options);
  let scan: ReturnType<typeof workflow.scan> | undefined;
  try {
    await workflow.start();
    const messages = ['aa01', 'aa02', 'aa03'].map(id => ({ ...message(id, 'Historical mail', { received: Date.parse('2025-04-01') }), threadId: id.replace('aa', 'bb') }));
    h.setFixture(separateThreads(messages));
    scan = workflow.scan({ from: '2025-01-01', to: '2026-01-01' });
    await waitFor(() => entered);
    assert.equal(workflow.status().scan?.status, 'processing');
    assert.equal(workflow.status().scan?.from, '2025-01-01');
    assert.equal(workflow.status().scan?.discovered, 3);
    assert.equal(workflow.status().scan?.processed, 0);
    assert.deepEqual(workflow.inspectScan()?.results, []);
    release();
    // The client need not retain its original response to retrieve the outcome.
    await scan;
    const saved = workflow.inspectScan()!;
    assert.equal(saved.status, 'completed');
    assert.equal(saved.processed, 3);
    assert.equal(saved.deleted, 1); assert.equal(saved.failed, 1);
    assert.equal(saved.results.find(row => row.id === 'aa02')?.action, 'keep');
    assert.match(saved.results.find(row => row.id === 'aa03')!.error!, /transport/);
    assert.ok(saved.finishedAt);
    await workflow.stop();
    h.setFixture(fixture([]));
    workflow = createMailWorkflow(options);
    await workflow.start();
    assert.deepEqual(workflow.inspectScan(), saved);
    assert.equal(workflow.status().scan?.deleted, 1);
    // Only a newly accepted scan replaces the latest result.
    await assert.rejects(workflow.scan({ from: 'invalid', to: '2026-01-01' }), /date/);
    assert.deepEqual(workflow.inspectScan(), saved);
    await workflow.scan({ from: '2025-01-01', to: '2026-01-01' });
    assert.deepEqual(workflow.inspectScan()?.results, []);
    assert.equal(workflow.status().scan?.deleted, 0);
  } finally { release(); await scan?.catch(() => {}); await workflow.stop(); }
}));

test('full plaintext and attachments are classified without review vetoes; uncertain deletion reconciles on retry', async () => withHarness(async h => {
  const target = message('aa02', '', { received: Date.now() - 60000 });
  target.payload = { mimeType: 'multipart/alternative', headers: [...target.payload.headers!, { name: 'DKIM-Signature', value: 'DKIM_BLOAT'.repeat(2000) }], parts: [
    { mimeType: 'text/plain', body: { data: Buffer.from('CURRENT_PROMOTION\n' + '😀'.repeat(1000) + 'UNSENT_TAIL').toString('base64url') } },
    { mimeType: 'text/html', body: { data: Buffer.from('<p>HTML_ONLY</p>'.repeat(20000)).toString('base64url') } },
    { mimeType: 'application/pdf', filename: 'offer.pdf', body: { attachmentId: 'not-downloaded' } },
  ] };
  const sibling = message('aa01', 'Leave this sibling alone', { received: Date.now() - 86400000 });
  h.setFixture({ ...fixture([sibling, target], [target]), modifyUncertain: true });
  const provider = assessments(() => ({ action: { type: 'choice', choice: 'delete', probabilities: { delete: 0.51 } } }));
  const decisions: DecisionRuntimeV1 = { evaluate: async (batch, opts) => {
    const encoded = JSON.stringify(batch.state);
    assert.ok(encoded.includes('CURRENT_PROMOTION'));
    assert.ok(!encoded.includes('DKIM_BLOAT') && !encoded.includes('HTML_ONLY') && encoded.includes('UNSENT_TAIL'));
    return provider.decisions.evaluate(batch, opts);
  } };
  const config = triageConfig({ ...h.config, settings: { retryDelaySeconds: 0 } }, { policy: { ...defaultPolicy, deletePrompt: 'Delete promotions' } });
  const subagent: MailSubagent = { run: async () => { throw new Error('deletion woke'); }, waitForRun: async () => ({ status: 'ok' }) };
  let workflow = createMailWorkflow({ config, stateDir: h.stateDir, ...provider, decisions, subagent });
  try {
    await workflow.start(); assert.equal(workflow.status().messages.pending, 1);
    const inspected = workflow.inspect('aa02')[0];
    assert.deepEqual(inspected.plan, { action: 'delete', labels: [], source: 'jev' });
    assert.deepEqual(inspected.coverage, { complete: false, missing: ['unscanned attachment'] });
    await workflow.stop();
    workflow = createMailWorkflow({ config, stateDir: h.stateDir, ...provider, decisions, subagent });
    await workflow.start(); assert.equal(workflow.status().messages.done, 1);
    assert.equal(provider.calls(), 1, 'changed Trash metadata does not require inference; the effect reconciles without another write');
    assert.equal(h.calls().filter(args => args.includes('modify')).length, 1);
    assert.equal(workflow.inspect('aa02')[0].effects[0].status, 'confirmed');
    const thread = await new GogMailClient(h.config).getThread('bb01');
    assert.ok(thread.messages.find(m => m.id === 'aa01')!.labelIds.includes('INBOX'));
  } finally { await workflow.stop(); }
}));

test('provider failures stay pending beyond three attempts and are not cached as classifications', async () => withHarness(async h => {
  h.setFixture(fixture(['aa01', 'aa02'].map(id => message(id, 'Retry this chain', { received: Date.now() - 60000 }))));
  let calls = 0;
  const provider = assessments();
  const decisions: DecisionRuntimeV1 = { evaluate: async (batch, opts) => {
    calls++;
    if (calls < 5) return { status: 'unavailable', reason: 'transport' };
    return provider.decisions.evaluate(batch, opts);
  } };
  const workflow = createMailWorkflow({ config: triageConfig({ ...h.config, settings: { retryDelaySeconds: 0 } }), stateDir: h.stateDir, ...provider, decisions, subagent: {
    run: async () => { throw new Error('queued mail wakes later'); }, waitForRun: async () => ({ status: 'ok' }),
  } });
  try {
    await workflow.start();
    for (let attempt = 1; attempt < 5; attempt++) {
      assert.equal(workflow.status().messages.pending, 2);
      assert.equal(calls, attempt, 'one failed request per chain per cycle, not one per member');
      const pending = workflow.inspect('aa01')[0];
      assert.ok(pending, 'first-attempt failures must be inspectable');
      assert.equal(pending.message?.status, 'pending');
      assert.match(pending.message.reason, /transport/);
      assert.equal(pending.message.attempts, attempt);
      assert.ok(pending.message.due > 0);
      assert.equal(pending.plan, undefined);
      await workflow.poll();
    }
    assert.equal(calls, 5); assert.equal(workflow.status().messages.queue, 2);
    assert.equal(workflow.status().messages.needs_review, undefined);
  } finally { await workflow.stop(); }
}));

test('file policy edits refresh queued classifications without reopening completed work, while the original cutoff survives disablement', async () => withHarness(async h => {
  const old = message('aa01', 'Existing before enable', { received: Date.now() - 60000 });
  h.setFixture({ ...fixture([old]), probeWritableDb: false });
  let classifications = 0, wakes = 0;
  const provider = assessments();
  const decisions: DecisionRuntimeV1 = { evaluate: async (batch, opts) => {
    classifications++;
    const choice = JSON.stringify(batch.questions).includes('Wake after config edit') ? 'wake' : 'queue';
    return { status: 'ok', provenance: { providerId: 'typesafe', rubricVersion: 'mail-v3', runtimeGeneration: 'test' },
      result: { model: 'jev-1.13.0', answers: labelAnswers(batch, choice) } };
  } };
  let workflow: ReturnType<typeof createMailWorkflow>;
  const subagent: MailSubagent = {
    run: async ({ sessionKey, message: prompt }: { sessionKey: string; message: string }) => {
      wakes++;
      const jobId = jobIdFromPrompt(prompt); workflow.complete({ jobId, sessionKey, reason: 'Handled after reconfiguration' });
      return { runId: jobId };
    }, waitForRun: async () => ({ status: 'ok' }),
  };
  const config = triageConfig(h.config);
  workflow = createMailWorkflow({ config, stateDir: h.stateDir, ...provider, decisions, subagent });
  try {
    await workflow.start(); await waitFor(() => !workflow.status().triage!.labeling);
    assert.equal(classifications, 1); assert.equal(wakes, 0);
    const cutoff = workflow.status().triage!.backlogBefore;
    await workflow.stop();
    workflow = createMailWorkflow({ config: h.config, stateDir: h.stateDir, ...provider, decisions, subagent });
    await workflow.start(); await workflow.stop();
    const fresh = message('aa02', 'Arrived after original enable', { sender: 'someone@outside.test', received: cutoff + 1000 });
    h.setFixture({ ...fixture([old, fresh]), probeWritableDb: false });
    const edited = { ...defaultPolicy, prompt: 'Wake after config edit', labels: [{ name: 'New label', description: 'This conversation' }] };
    workflow = createMailWorkflow({ config: triageConfig(h.config, { policy: edited }), stateDir: h.stateDir, ...provider, decisions, subagent });
    await workflow.start(); await waitFor(() => !workflow.status().working && !workflow.status().triage!.labeling);
    assert.equal(workflow.status().triage!.backlogBefore, cutoff);
    assert.equal(classifications, 2); assert.equal(wakes, 1);
    await workflow.stop();
    workflow = createMailWorkflow({ config: triageConfig(h.config, { policy: { ...edited, labels: [{ name: 'Second label', description: 'This conversation' }] } }),
      stateDir: h.stateDir, ...provider, decisions, subagent });
    await workflow.start(); await waitFor(() => !workflow.status().triage!.labeling);
    assert.equal(classifications, 2); assert.equal(wakes, 1);
    assert.ok(!h.calls().some(args => args.includes('create') && args.at(-1) === 'Second label'), 'completed conversations are not reopened just to apply a changed classification');
  } finally { await workflow.stop(); }
}));

test('historical deletion removes waiting queue mail and invalid dates cannot mutate it', async t => withHarness(async h => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const target = message('aa01', 'Expired item', { received: Date.parse('2025-04-01') });
  h.setFixture(fixture([target]));
  const provider = assessments();
  const decisions: DecisionRuntimeV1 = { evaluate: async (batch, opts) => {
    if (opts.purpose.endsWith('.delete-scan')) return { status: 'ok', provenance: { providerId: 'typesafe', rubricVersion: 'mail-v3', runtimeGeneration: 'test' },
      result: { model: 'jev-1.13.0', answers: labelAnswers(batch, 'delete') } };
    return provider.decisions.evaluate(batch, opts);
  } };
  const workflow = createMailWorkflow({ config: triageConfig({ ...h.config, settings: { maxAgeDays: null } }, { policy: { ...defaultPolicy, deletePrompt: 'Delete expired items', queueMinutes: 1 } }),
    stateDir: h.stateDir, ...provider, decisions, subagent: { run: async () => { throw new Error('deleted queue item woke'); }, waitForRun: async () => ({ status: 'ok' }) } });
  try {
    await workflow.start(); await waitFor(() => !workflow.status().triage!.labeling);
    assert.equal(workflow.status().messages.queue, 1);
    for (const from of ['2025-02-30', '2025-01-01T00:00:00', 'Jan 1, 2025']) {
      await assert.rejects(workflow.scan({ from, to: '2026-01-01' }), /date|timezone/);
    }
    const result = await workflow.scan({ from: '2025-01-01', to: '2026-01-01' });
    assert.equal(result.deleted, 1);
    t.mock.timers.setTime(Date.now() + 120000);
    await workflow.poll(); await waitFor(() => !workflow.status().working);
    assert.deepEqual(workflow.status().jobs, {}); assert.equal(workflow.status().messages.done, 1);
    assert.equal(workflow.inspect('aa01')[0].labels?.status, 'cancelled');
  } finally { await workflow.stop(); }
}));

test('legacy unexecuted triage states migrate without replaying completed or uncertain jobs', async () => withHarness(async h => {
  h.setFixture(fixture([]));
  const provider = assessments();
  const subagent: MailSubagent = { run: async () => { throw new Error('no immediate wake'); }, waitForRun: async () => ({ status: 'ok' }) };
  let workflow = createMailWorkflow({ config: h.config, stateDir: h.stateDir, ...provider, subagent });
  await workflow.start(); await workflow.stop();
  const db = h.db();
  db.prepare('UPDATE policies SET document=?,created=?,editor=? WHERE version=1').run(JSON.stringify({ schemaVersion: 1, rules: [] }), 0, 'legacy');
  const messages = ['digest', 'shadow', 'queued', 'needs_review', 'done', 'needs_review'].map((status, i) => {
    const m = message((0xaa00 + i).toString(16), 'Legacy mail', { received: Date.now() - 86400000 });
    if (i === 5) m.threadId = 'bb02';
    db.prepare("INSERT INTO messages(id,thread_id,received,sender,status,discovered,job_id) VALUES (?,?,?,?,?,?,?)")
      .run(m.id, m.threadId, Number(m.internalDate), approved, status, Math.floor(Date.now() / 1000), i === 5 ? 'old-uncertain' : null);
    db.prepare('INSERT INTO triage VALUES (?,?,?,?,?,?,?,?,?,?)').run(m.id, m.threadId, '', '', 1, '{}', '{"attention":"review"}', '{}', 0, 1);
    return m;
  });
  db.prepare("INSERT INTO jobs(id,thread_id,target_id,message_ids,status,created) VALUES ('old-uncertain','bb02','aa05','[\"aa05\"]','needs_review',1)").run();
  db.prepare("INSERT INTO jobs(id,thread_id,target_id,message_ids,status,created) VALUES ('old-completed','triage','','[\"aa04\"]','completed',1)").run();
  db.prepare("UPDATE messages SET job_id='old-completed' WHERE id='aa04'").run();
  mkdirSync(join(h.stateDir, 'triage'));
  writeFileSync(join(h.stateDir, 'triage', 'aa04.md'), 'Original completed conversation');
  db.prepare("INSERT INTO replies VALUES ('aa05','old-uncertain','uncertain',1,'')").run();
  db.close();
  const mailbox = fixture(messages.slice(0, 5), messages);
  mailbox.threads.bb02 = { thread: { id: 'bb02', messages: [messages[5]] } };
  h.setFixture({ ...mailbox, probeWritableDb: false });
  workflow = createMailWorkflow({ config: triageConfig(h.config), stateDir: h.stateDir, ...provider, subagent });
  try {
    await workflow.start(); await waitFor(() => !workflow.status().triage!.labeling);
    assert.equal(provider.calls(), 1);
    assert.equal(workflow.status().messages.queue, 4); assert.equal(workflow.status().messages.done, 1);
    assert.equal(workflow.status().messages.needs_review, 1);
    assert.equal(readFileSync(workflow.inspectJob('old-completed').messages[0].transcript!, 'utf8'), 'Original completed conversation');
    workflow.resolve('old-uncertain', 'Confirmed prior external outcome; do not resend');
    const check = h.db(); assert.equal(check.prepare("SELECT status FROM replies WHERE target_id='aa05'").get()?.status, 'uncertain'); check.close();
    await workflow.poll(); assert.equal(provider.calls(), 1);
  } finally { await workflow.stop(); }
}));

test('a waiting wake survives policy replacement and a later downgrade to the daily queue', async t => withHarness(async h => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const first = message('aa01', 'First old item', { received: Date.now() - 60000 });
  const second = message('aa02', 'Second old item', { received: Date.now() - 60000 }); second.threadId = 'bb02';
  h.setFixture({ ...separateThreads([first, second]), probeWritableDb: false });
  let secondAttempts = 0, downgrade = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const provider = assessments(id => ({ action: { type: 'choice', choice: id === 'bb02' && downgrade ? 'queue' : 'wake', probabilities: {} } }));
  const decisions: DecisionRuntimeV1 = { evaluate: async (batch, opts) => {
    if ((batch.state as { threadId: string }).threadId === 'bb02' && secondAttempts++ === 0) return { status: 'unavailable', reason: 'transport' };
    return provider.decisions.evaluate(batch, opts);
  } };
  let workflow: ReturnType<typeof createMailWorkflow>;
  const wakes: string[][] = [];
  workflow = createMailWorkflow({ config: triageConfig({ ...h.config, settings: { retryDelaySeconds: 0 } }), stateDir: h.stateDir, ...provider, decisions, subagent: {
    run: async ({ sessionKey, message: prompt }) => {
      const jobId = jobIdFromPrompt(prompt);
      wakes.push(workflow.context(jobId, sessionKey).messages.map(row => row.id));
      if (wakes.length === 1) await gate;
      workflow.complete({ jobId, sessionKey, reason: 'Done' });
      return { runId: jobId };
    }, waitForRun: async () => ({ status: 'ok' }),
  } });
  try {
    await workflow.start(); await waitFor(() => wakes.length === 1); assert.deepEqual(wakes, [['aa01']]);
    await workflow.poll(); assert.equal(workflow.status().jobs.queued, 1);
    workflow.policyUpdate({ ...defaultPolicy, prompt: 'Revised wake instructions' }, 1, 'main');
    await workflow.poll();
    const updated = { ...separateThreads([first, second]), probeWritableDb: false };
    const reply = message('cc02', 'No urgency; keep this for the next daily check.', { sender: account });
    reply.threadId = 'bb02'; reply.labelIds = ['SENT'];
    updated.threads.bb02.thread.messages.push(reply); h.setFixture(updated); downgrade = true;
    release(); await waitFor(() => !workflow.status().working && workflow.status().jobs.completed === 2);
    assert.deepEqual(wakes, [['aa01']], 'the later reply downgrades the waiting urgent item');
    assert.equal(workflow.status().messages.queue, 1);
    t.mock.timers.setTime(Date.now() + 86400000);
    await workflow.poll(); await waitFor(() => !workflow.status().working);
    assert.deepEqual(wakes, [['aa01'], ['aa02']]);
  } finally { release(); await workflow.stop(); }
}));

test('rolling triage skips old messages before inference, handles new replies once, and expires a waiting queue', async (t) => withHarness(async (h) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const day = 86400000;
  const old = message('aa01', 'Old mail must not call Jev', { received: Date.now() - 40 * day });
  const queued = message('aa02', 'Expires before queue delivery', { received: Date.now() - 29 * day });
  queued.threadId = 'bb02';
  const provider = assessments(id => ({ action: { type: 'choice', choice: id === 'bb02' ? 'queue' : 'wake', probabilities: {} } }));
  const config = triageConfig(h.config, { policy: { ...defaultPolicy, queueMinutes: 3 * 1440 } });
  let workflow: ReturnType<typeof createMailWorkflow>;
  const wakes: string[][] = [];
  const subagent: MailSubagent = {
    run: async ({ sessionKey, message: prompt }) => {
      const jobId = jobIdFromPrompt(prompt);
      const context = workflow.context(jobId, sessionKey);
      wakes.push(context.messages.flatMap(row => row.messageIds));
      assert.equal(context.replyAllowed, true, 'reply setting applies to triage as well as responders');
      assert.ok(context.messages.filter(row => row.sender === 'outside@elsewhere.test').every(row => !row.replyAllowed),
        'classification does not expand the configured sender rules');
      workflow.complete({ jobId, sessionKey, reason: 'Handled without sending' });
      return { runId: jobId, sessionKey };
    }, waitForRun: async () => ({ status: 'ok' }),
  };
  h.setFixture(separateThreads([old, queued]));
  workflow = createMailWorkflow({ config, stateDir: h.stateDir, ...provider, subagent });
  try {
    await workflow.start();
    assert.equal(provider.calls(), 1, 'old mail never reaches the decision provider');
    assert.equal(workflow.inspect(old.id)[0].message?.reason, 'older than maxAgeDays');
    assert.equal(workflow.status().messages.skipped, 1);
    t.mock.timers.setTime(Date.now() + 60000);
    const reply = message('aa03', 'New external reply in the old thread', { sender: 'outside@elsewhere.test' });
    const other = message('aa04', 'Another new conversation', { sender: 'outside@elsewhere.test' });
    other.threadId = 'bb04';
    const current = separateThreads([old, queued, other]);
    current.threads.bb01.thread.messages.push(reply);
    current.search.messages.push({ id: reply.id, threadId: reply.threadId });
    h.setFixture(current);
    await workflow.poll(); await waitFor(() => !workflow.status().working);
    assert.deepEqual(wakes, [['aa03', 'aa04']], 'new messages across threads share one wake; old sibling stays excluded');
    assert.equal(provider.calls(), 3);
    await workflow.poll(); assert.equal(provider.calls(), 3);
    await workflow.stop();
    workflow = createMailWorkflow({ config, stateDir: h.stateDir, ...provider, subagent });
    await workflow.start();
    assert.equal(provider.calls(), 3, 'restart does not replay successful mail');
    t.mock.timers.setTime(Date.now() + 4 * day);
    await workflow.poll(); await waitFor(() => !workflow.status().working);
    assert.equal(wakes.length, 1, 'expired queue cannot wake');
    assert.equal(provider.calls(), 3, 'expiry does not cost an inference');
    assert.equal(workflow.inspect(queued.id)[0].message?.reason, 'older than maxAgeDays');
    const snapshot = workflow.policyGet();
    workflow.policyUpdate(undefined, snapshot.version, 'agent', { maxAgeDays: null });
    await workflow.poll(); await waitFor(() => !workflow.status().working);
    assert.deepEqual(wakes, [['aa03', 'aa04'], ['aa01', 'aa02']], 'agent can opt old mail and its already-due queue back in without reopening completed messages');
    assert.equal(h.calls().filter(args => args.includes('send') || args.includes('TRASH') || args.includes('--remove')).length, 0);
  } finally { await workflow.stop(); }
}));

test('new replies reconcile waiting conversation members without a second wake', async t => {
  for (const scenario of [
    { initial: 'queue', reply: 'wake', due: false },
    { initial: 'wake', reply: 'wake', due: false },
    { initial: 'queue', reply: 'queue', due: true },
    { initial: 'wake', reply: 'queue', due: false },
  ] as const) await t.test(`${scenario.initial} to ${scenario.reply}${scenario.due ? ' (due)' : ''}`, async t => withHarness(async h => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const blocker = message('ff01', 'Unrelated active work'); blocker.threadId = 'ff02';
    h.setFixture(separateThreads([blocker]));
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const wakes: string[][] = [];
    let workflow: ReturnType<typeof createMailWorkflow>;
    const provider = assessments();
    const decisions: DecisionRuntimeV1 = { evaluate: async (batch, opts) => {
      const latest = (batch.state as { facts: { latestMessageId: string } }).facts.latestMessageId;
      const result = await provider.decisions.evaluate(batch, opts);
      return result.status !== 'ok' ? result : { ...result, result: { ...result.result,
        answers: labelAnswers(batch, latest === 'aa01' ? scenario.initial : latest === 'aa02' ? scenario.reply : 'wake') } };
    } };
    const config = triageConfig(h.config);
    const subagent: MailSubagent = { run: async ({ sessionKey, message: prompt }) => {
      const jobId = jobIdFromPrompt(prompt);
      const ids = workflow.context(jobId, sessionKey).messages.flatMap(row => row.messageIds);
      wakes.push(ids);
      if (ids.includes(blocker.id)) await gate;
      workflow.complete({ jobId, sessionKey, reason: 'Whole conversation handled' });
      return { runId: jobId };
    }, waitForRun: async () => ({ status: 'ok' }) };
    workflow = createMailWorkflow({ config, stateDir: h.stateDir, ...provider, decisions, subagent });
    try {
      await workflow.start(); await waitFor(() => wakes.length === 1);
      t.mock.timers.setTime(Date.now() + 60000);
      const first = message('aa01', 'Initial request');
      const inbox = separateThreads([blocker, first]);
      h.setFixture(inbox); await workflow.poll();
      if (scenario.due) {
        t.mock.timers.setTime(Date.now() + 86400000);
        await workflow.poll();
      }
      t.mock.timers.setTime(Date.now() + 60000);
      const reply = message('aa02', 'The same request is now urgent');
      inbox.threads.bb01.thread.messages.push(reply);
      inbox.search.messages.push({ id: reply.id, threadId: reply.threadId });
      h.setFixture(inbox); await workflow.poll();
      release(); await waitFor(() => !workflow.status().working && !workflow.status().jobs.queued);
      const delayed = scenario.initial === 'wake' && scenario.reply === 'queue';
      assert.deepEqual(wakes, delayed ? [['ff01']] : [['ff01'], ['aa01', 'aa02']],
        'waiting members share one wake; an urgent-to-queue downgrade waits for its cadence');
      assert.equal(provider.calls(), 3, 'one assessment for each new conversation state');
      await workflow.stop();
      workflow = createMailWorkflow({ config, stateDir: h.stateDir, ...provider, decisions, subagent });
      t.mock.timers.setTime(Date.now() + 86400000);
      await workflow.start(); await waitFor(() => !workflow.status().working);
      assert.deepEqual(wakes, [['ff01'], ['aa01', 'aa02']], 'completed work does not reappear at the next queue interval');
      assert.equal(workflow.status().messages.done, 3);
    } finally { release(); await workflow.stop(); }
  }));
});

test('upgrading defaults preserves saved agent policy until an explicit file edit', async () => withHarness(async h => {
  h.setFixture(fixture([]));
  const config = triageConfig(h.config), provider = assessments();
  const subagent: MailSubagent = { run: async () => { throw new Error('empty mailbox'); }, waitForRun: async () => ({ status: 'ok' }) };
  let workflow = createMailWorkflow({ config, stateDir: h.stateDir, ...provider, subagent });
  const custom = { prompt: 'Only wake for customer outages', deletePrompt: 'Expired offers only', queueMinutes: 60,
    labels: [{ name: 'Customers', description: 'Customer conversations' }] };
  try {
    await workflow.start();
    const saved = workflow.policyUpdate(custom, workflow.policyGet().version, 'agent', { concurrency: 9, retryDelaySeconds: 77 });
    await workflow.stop();
    const db = h.db();
    // A prior release fingerprint differs from the new built-in default.
    db.prepare("UPDATE meta SET value='previous-release-default' WHERE key='triage_config_policy'").run();
    db.prepare("UPDATE meta SET value='thread' WHERE key='triage_unit'").run();
    // v0.3.6's unchanged file fingerprint must not reset saved live settings
    // merely because a new built-in replyAllowed default was added.
    db.prepare("UPDATE meta SET value='f318ecbf3aa1e27aa4e8d6c25e169bf205e824ec3c61fe227977acc2f32f0c77' WHERE key='runtime_config_settings'").run();
    const { replyAllowed: _reply, ...priorSettings } = saved.configuredSettings;
    db.prepare("UPDATE policies SET settings=? WHERE version=?").run(JSON.stringify(priorSettings), saved.version);
    db.close();
    workflow = createMailWorkflow({ config, stateDir: h.stateDir, ...provider, subagent });
    await workflow.start();
    assert.deepEqual(workflow.policyGet().document, saved.document, 'the saved custom prompt and topic/routing labels survive default upgrades');
    assert.equal(workflow.policyGet().settings.replyAllowed, true);
    assert.equal(workflow.policyGet().settings.concurrency, 9);
    assert.equal(workflow.policyGet().settings.retryDelaySeconds, 77);
    await workflow.stop();
    workflow = createMailWorkflow({ config, stateDir: h.stateDir, ...provider, subagent });
    await workflow.start();
    assert.deepEqual(workflow.policyGet().document, saved.document, 'an unchanged restart retains customizations');
    assert.equal(workflow.policyGet().settings.concurrency, 9);
    await workflow.stop();
    workflow = createMailWorkflow({ config: triageConfig(h.config, { policy: defaultPolicy }), stateDir: h.stateDir, ...provider, subagent });
    await workflow.start();
    assert.deepEqual(workflow.policyGet().document, defaultPolicy, 'explicitly selecting the default in the file is still an edit');
  } finally { await workflow.stop(); }
}));

test('mail that expires during label inference is not modified', async t => withHarness(async h => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  h.setFixture(fixture([message('aa01', 'Pending categorization', { received: Date.now() - 29 * 86400000 })]));
  const provider = assessments(() => ({ label_0: { type: 'choice', choice: 'apply', probabilities: {} } }));
  let labeling = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const decisions: DecisionRuntimeV1 = { evaluate: async (batch, opts) => {
    if (opts.purpose.endsWith('.labels')) { labeling = true; await gate; }
    return provider.decisions.evaluate(batch, opts);
  } };
  const config = triageConfig(h.config, { policy: { ...defaultPolicy, labels: [{ name: 'Work', description: 'Pending work' }] } });
  const workflow = createMailWorkflow({ config, stateDir: h.stateDir, ...provider, decisions,
    subagent: { run: async () => { throw new Error('queue is not due'); }, waitForRun: async () => ({ status: 'ok' }) } });
  const start = workflow.start();
  try {
    await waitFor(() => labeling);
    t.mock.timers.setTime(Date.now() + 2 * 86400000);
    release(); await start; await waitFor(() => !workflow.status().triage!.labeling);
    assert.equal(workflow.inspect('aa01')[0].labels?.status, 'done');
    assert.equal(h.calls().filter(args => args.includes('modify')).length, 0, 'expiry prevents the delayed label write');
  } finally { release(); await start; await workflow.stop(); }
}));

test('oversized conversations retain recent plaintext and expose truncation without changing full agent transcripts', async () => withHarness(async h => {
  const old = message('aa01', 'EARLIEST_HISTORY ' + 'old body '.repeat(1000), { received: Date.now() - 86400000 });
  const latest = message('aa02', 'NEW_REQUEST 😀 ' + 'current details '.repeat(1000), { received: Date.now() - 60000 });
  h.setFixture(fixture([old, latest], [latest]));
  const provider = assessments(() => ({ action: { type: 'choice', choice: 'wake', probabilities: {} } }));
  const decisions: DecisionRuntimeV1 = { evaluate: async (batch, opts) => {
    const text = JSON.stringify(batch.state);
    assert.ok(text.includes('NEW_REQUEST 😀'));
    assert.ok(!text.includes('EARLIEST_HISTORY') && !text.includes('�'));
    assert.ok(text.length < 12000, 'oversized payload is shortened before reaching the provider');
    return provider.decisions.evaluate(batch, opts);
  } };
  let workflow: ReturnType<typeof createMailWorkflow>;
  let woke = false;
  workflow = createMailWorkflow({ config: triageConfig({ ...h.config, settings: { maxInputTokens: 1000 } }), stateDir: h.stateDir,
    ...provider, decisions, subagent: {
      run: async ({ sessionKey, message: prompt }) => {
        const jobId = jobIdFromPrompt(prompt), context = workflow.context(jobId, sessionKey);
        const transcript = readFileSync(context.messages[0].transcript!, 'utf8');
        assert.ok(transcript.includes('EARLIEST_HISTORY') && transcript.includes('NEW_REQUEST'));
        assert.deepEqual(context.messages[0].triage?.coverage, { complete: false, missing: ['conversation trimmed to token budget'] });
        workflow.complete({ jobId, sessionKey, reason: 'Read full transcript' }); woke = true;
        return { runId: jobId };
      }, waitForRun: async () => ({ status: 'ok' }),
    } });
  try {
    await workflow.start(); await waitFor(() => !workflow.status().working);
    assert.equal(woke, true); assert.equal(provider.calls(), 1);
  } finally { await workflow.stop(); }
}));
