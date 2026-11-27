import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { DecisionAnswer, DecisionRuntimeV1 } from "openclaw/plugin-sdk/decisions";
import { parseConfig, type GmailMessage } from "../src/mail.js";
import { defaultPolicy } from "../src/policy.js";
import { createMailWorkflow, type MailClient, type MailSubagent } from "../src/workflow.js";

const account = "agent@example.com";
const model = "typesafe/jev-1.13.0";
type Workflow = ReturnType<typeof createMailWorkflow>;

function message(index: number, options: { sender?: string; labels?: string[]; received?: number; to?: string; cc?: string } = {}): GmailMessage {
  const sender = options.sender ?? "bek@example.com";
  return { id: `aa0${index}`, threadId: `bb0${index}`, internalDate: String(options.received ?? Date.now()),
    labelIds: options.labels ?? ["INBOX"], payload: { mimeType: "text/plain", body: { data: Buffer.from("Please review this conversation").toString("base64url") },
      headers: [{ name: "From", value: sender }, { name: "To", value: options.to ?? account }, { name: "Cc", value: options.cc ?? "" },
        { name: "Authentication-Results", value: `mx.google.com; dmarc=pass header.from=${sender.split("@")[1]}` }],
    } };
}

function mailbox(messages: GmailMessage[]) {
  const failReads = new Set<string>();
  const failCompletions = new Set<string>();
  const completionAttempts: string[] = [];
  const sent: Parameters<MailClient["send"]>[0][] = [];
  const mail: MailClient = {
    async searchPage(after, _page, scope, before, query) {
      const candidates = messages.filter(message => Number(message.internalDate) >= after * 1000 &&
        (before === undefined || Number(message.internalDate) < before * 1000) &&
        !message.labelIds.some(label => ["SPAM", "TRASH", "SENT", "DRAFT"].includes(label)));
      const selected = candidates.filter(message => {
        if ((query?.includes("in:inbox") || query === undefined && scope === "inbox") && !message.labelIds.includes("INBOX")) return false;
        if (query?.includes("label:Priority") && !message.labelIds.includes("Label_Priority")) return false;
        if (query?.includes("label:Triage") && !message.labelIds.includes("Label_Triage")) return false;
        if (query?.includes("from:vip@example.com") && !message.payload.headers?.some(header => header.name === "From" && header.value === "vip@example.com")) return false;
        return true;
      });
      return { messages: selected.map(({ id, threadId }) => ({ id, threadId })) };
    },
    async getThread(id) {
      if (failReads.delete(id)) throw new Error("controlled transient conversation fetch failure");
      return structuredClone({ id, messages: messages.filter(message => message.threadId === id) });
    },
    async labelId(name) { return `Label_${name}`; },
    async modify(ids, add, remove) {
      if (add.includes("Label_Handled")) {
        completionAttempts.push(...ids);
        if (ids.some(id => failCompletions.delete(id))) throw new Error("controlled completion-label write failure");
      }
      for (const message of messages) if (ids.includes(message.id))
        message.labelIds = [...new Set([...message.labelIds.filter(label => !remove.includes(label)), ...add])];
      return { modified: ids, addedLabels: add, removedLabels: remove };
    },
    async send(input) {
      sent.push(structuredClone(input));
      const target = messages.find(message => message.id === input.targetMessageId);
      assert.ok(target);
      return { messageId: `cc0${sent.length}`, threadId: target.threadId };
    },
  };
  return { mail, failReads, failCompletions, completionAttempts, sent };
}

function classifier(labelFor: (threadId: string) => string) {
  let calls = 0;
  const decisions: DecisionRuntimeV1 = { async evaluate(batch) {
    calls++;
    const label = labelFor((batch.state as { threadId: string }).threadId);
    const answers: Record<string, DecisionAnswer> = {};
    for (const [key, question] of Object.entries(batch.questions)) answers[key] = {
      type: "choice", choice: typeof question.instructions === "string" && question.instructions.includes(`Label: ${label}\n`) ? "apply" : "skip", probabilities: {},
    };
    return { status: "ok", provenance: { providerId: "typesafe", rubricVersion: "selection-test", runtimeGeneration: "test" }, result: { model: "jev-1.13.0", answers } };
  } };
  return { decisions, decisionModel: () => model, calls: () => calls };
}

function jobId(idempotencyKey: string | undefined) {
  assert.ok(idempotencyKey);
  assert.ok(idempotencyKey.startsWith(`${account}:`));
  return idempotencyKey.slice(account.length + 1);
}

async function waitFor(predicate: () => boolean) {
  const deadline = performance.now() + 5000;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error("timed out waiting for selected mail workflow");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test("native label wakes preserve baselines, recovery and newer rules decisions against stale Jev effects", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const dir = mkdtempSync(join(tmpdir(), "gog-email-selection-test-"));
  const old = Date.now() - 86_400_000;
  const messages = [message(1, { received: old, labels: ["Label_Priority", "Label_Triage"] }), message(2, { received: old, labels: [] })];
  const source = mailbox(messages);
  const provider = classifier(() => "No action needed");
  let classificationStarted = false;
  let releaseClassification = () => {};
  const classificationGate = new Promise<void>(resolve => { releaseClassification = resolve; });
  const decisions: DecisionRuntimeV1 = { async evaluate(batch, context) {
    const outcome = await provider.decisions.evaluate(batch, context);
    if ((batch.state as { threadId: string }).threadId !== "bb05" || outcome.status !== "ok") return outcome;
    classificationStarted = true;
    await classificationGate;
    return { ...outcome, result: { ...outcome.result, answers: { ...outcome.result.answers,
      deletion_match: { type: "choice", choice: "apply", probabilities: {} },
    } } };
  } };
  const config = parseConfig({ account, domains: ["example.com"], triage: { decisionModel: model,
    policy: { ...defaultPolicy, deletePrompt: "Delete discarded promotions" } },
    settings: { wakeScope: "", wakeQuery: "label:Priority", triageQuery: "label:Triage", retryDelaySeconds: 0 } });
  let workflow: Workflow;
  const covered: string[][] = [];
  let blockerStarted = false;
  let releaseBlocker = () => {};
  const blocker = new Promise<void>(resolve => { releaseBlocker = resolve; });
  const subagent: MailSubagent = { async run({ idempotencyKey, sessionKey }) {
    const id = jobId(idempotencyKey);
    const ids = workflow.context(id, sessionKey).messages.flatMap(message => message.messageIds);
    covered.push(ids);
    if (ids.includes("aa02")) await workflow.reply({ jobId: id, sessionKey, body: "Reviewed the newly prioritized conversation." });
    if (ids.includes("aa03")) { blockerStarted = true; await blocker; }
    workflow.complete({ jobId: id, sessionKey, reason: "Processed the newly selected conversation" });
    return { runId: id, sessionKey };
  }, async waitForRun() { return { status: "ok" }; } };
  const options = { config, stateDir: dir, mail: source.mail, subagent, ...provider, decisions };
  workflow = createMailWorkflow(options);
  let oldInference: Promise<void> | undefined;
  try {
    await workflow.cycle();
    assert.deepEqual([...covered], [], "enabling a query must not replay existing matching mail");
    assert.equal(workflow.inspect("aa01")[0].message.status, "skipped", "baselining a direct match cannot bypass ordinary triage");
    messages[1].labelIds.push("Label_Priority");
    source.failReads.add("bb02");
    await workflow.cycle();
    assert.deepEqual([...covered], []);
    assert.equal(workflow.inspect("aa02")[0].message.status, "pending");
    assert.match(workflow.inspect("aa02")[0].message.reason, /transient/);
    await workflow.stop();
    workflow = createMailWorkflow(options);
    await workflow.cycle();
    await workflow.cycle();
    assert.deepEqual([...covered], [["aa02"]]);
    assert.equal(workflow.inspect("aa02")[0].message.status, "done");
    assert.deepEqual(source.sent.map(send => send.targetMessageId), ["aa02"], "explicitly selected archived mail can reply to an authenticated approved sender");
    assert.equal(provider.calls(), 1, "only the initial ordinary triage runs Jev; new direct matches bypass it, including after recovery");
    assert.equal(workflow.status().jobs.completed, 1);
    messages.push(message(3, { received: old, labels: ["Label_Priority"] }));
    await workflow.poll();
    await waitFor(() => blockerStarted);
    messages.push(message(4, { received: old, labels: ["Label_Priority"] }));
    await workflow.poll();
    assert.ok(!covered.flat().includes("aa04"), "newly selected mail remains unexecuted behind the active agent");
    t.mock.timers.tick(1000);
    workflow.policyUpdate(undefined, workflow.policyGet().version, "operator", { wakeFrom: ["contact@else.test"] });
    await workflow.poll();
    const waiting = workflow.inspect("aa04")[0];
    assert.equal(waiting.message.status, "processing");
    assert.equal(waiting.job?.status, "queued", "adding an unrelated sender cannot reset the native query's active cutoff or strand already-selected mail");
    messages[3].labelIds = [];
    releaseBlocker();
    await waitFor(() => !workflow.status().working);
    await workflow.cycle();
    assert.deepEqual([...covered], [["aa02"], ["aa03"]], "losing the trigger while queued must cancel a query-only wake");
    assert.equal(provider.calls(), 1);
    const changed = message(5, { labels: ["Label_Triage"] });
    messages.push(changed);
    oldInference = workflow.poll();
    await waitFor(() => classificationStarted);
    changed.labelIds.push("Label_Priority");
    await workflow.poll();
    await waitFor(() => covered.some(ids => ids.includes(changed.id)) && !workflow.status().working && !workflow.status().triage!.labeling);
    const currentPlan = structuredClone(workflow.inspect(changed.id)[0].plan);
    assert.ok(currentPlan && typeof currentPlan === "object" && "source" in currentPlan && currentPlan.source === "rules");
    releaseClassification(); await oldInference; await workflow.cycle();
    assert.deepEqual(workflow.inspect(changed.id)[0].plan, currentPlan, "old inference cannot overwrite a newer persisted rule classification");
    assert.equal(workflow.inspect(changed.id)[0].message.status, "done");
    assert.ok(!changed.labelIds.includes("TRASH"), "a stale Jev deletion cannot run after a newer code wake");
    assert.ok(!changed.labelIds.includes("Label_No action needed"), "stale classification labels cannot leak into the shared effect worker");
    assert.equal(covered.flat().filter(id => id === changed.id).length, 1);
    assert.equal(provider.calls(), 2);
  } finally { releaseBlocker(); releaseClassification(); await oldInference; await workflow.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test("mixed selectors verify exact senders and retain independent native-query entry", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const dir = mkdtempSync(join(tmpdir(), "gog-email-selection-test-"));
  const messages = [message(1, { sender: "not-vip@example.com", received: Date.now() - 86_400_000, labels: [] })];
  const source = mailbox(messages);
  const search = source.mail.searchPage;
  source.mail.searchPage = async (after, page, scope, before, query) => {
    if (query === undefined) return { messages: [] };
    // Gmail search supplies candidates; exact parsed addresses remain the
    // engine's contract even when its sender search returns extra candidates.
    if (query.includes("from:vip@example.com")) return { messages: messages.map(({ id, threadId }) => ({ id, threadId })) };
    return search(after, page, scope, before, query);
  };
  const config = parseConfig({ account, settings: { wakeFrom: ["vip@example.com"], wakeQuery: "label:Priority", wakeScope: "" } });
  const covered: string[][] = [];
  let workflow: Workflow;
  workflow = createMailWorkflow({ config, stateDir: dir, mail: source.mail, subagent: {
    async run({ idempotencyKey, sessionKey }) {
      const id = jobId(idempotencyKey);
      covered.push(workflow.context(id, sessionKey).messages.flatMap(message => message.messageIds));
      workflow.complete({ jobId: id, sessionKey, reason: "Handled selected mail" });
      return { runId: id, sessionKey };
    }, async waitForRun() { return { status: "ok" }; },
  } });
  try {
    await workflow.cycle();
    t.mock.timers.tick(1000);
    messages.push(message(2, { sender: "not-vip@example.com", labels: [] }));
    await workflow.cycle();
    assert.deepEqual([...covered], [], "a sender-query candidate does not automatically satisfy the native query");
    messages[0].labelIds.push("Label_Priority");
    messages.push(message(3, { sender: "vip@example.com", labels: [] }));
    await workflow.cycle();
    assert.deepEqual(covered.flat().sort(), ["aa01", "aa03"], "entering a native query remains visible even when the sender candidate set already contained that ID");
    await workflow.cycle();
    assert.deepEqual(covered.flat().sort(), ["aa01", "aa03"], "shared batching may combine wakes, but each selected message is covered exactly once");
  } finally { await workflow.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test("adding an individual to a new-only domain label preserves the continuously active domain cutoff", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const activated = Date.now();
  const dir = mkdtempSync(join(tmpdir(), "gog-email-selection-test-"));
  const messages: GmailMessage[] = [];
  const source = mailbox(messages);
  const provider = classifier(() => "Informational");
  const policy = { ...defaultPolicy, labels: [
    { name: "Known notification", description: "Configured team and individual notifications", action: "wake" as const,
      match: { domains: ["team.test"], newOnly: true } },
    { name: "Informational", description: "No owned action", action: "skip" as const },
  ] };
  const config = parseConfig({ account, triage: { decisionModel: model, policy } });
  const covered: string[][] = [];
  let workflow: Workflow;
  const subagent: MailSubagent = { async run({ idempotencyKey, sessionKey }) {
    const id = jobId(idempotencyKey);
    covered.push(workflow.context(id, sessionKey).messages.flatMap(message => message.messageIds));
    workflow.complete({ jobId: id, sessionKey, reason: "Handled the new configured notification" });
    return { runId: id, sessionKey };
  }, async waitForRun() { return { status: "ok" }; } };
  const options = { config, stateDir: dir, mail: source.mail, subagent, ...provider };
  workflow = createMailWorkflow(options);
  try {
    await workflow.cycle();
    t.mock.timers.tick(60_000);
    messages.push(message(1, { sender: "person@team.test", received: activated + 30_000 }),
      message(2, { sender: "contact@else.test", received: activated + 30_000 }));
    const current = workflow.policyGet();
    workflow.policyUpdate({ ...current.document, labels: current.document.labels.map(label => label.name === "Known notification"
      ? { ...label, match: { domains: ["team.test"], senders: ["contact@else.test"], newOnly: true } } : label) }, current.version, "operator");
    await workflow.cycle();
    assert.deepEqual([...covered], [["aa01"]], "adding an individual cannot reset the earlier domain's permission window");
    assert.equal(workflow.inspect("aa02")[0].message.status, "skipped", "adding the individual baselines their older mail without suppressing ordinary triage");
    assert.equal(provider.calls(), 1);
    await workflow.stop();
    workflow = createMailWorkflow(options);
    await workflow.cycle();
    assert.deepEqual([...covered], [["aa01"]]);
    t.mock.timers.tick(60_000);
    messages.push(message(3, { sender: "contact@else.test" }));
    await workflow.cycle();
    assert.deepEqual([...covered], [["aa01"], ["aa03"]]);
    assert.equal(provider.calls(), 1, "the newly active individual is deterministic after restart too");
  } finally { await workflow.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test("completion labels retry durably without repeating classification or agent work, including deliberate skips", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const dir = mkdtempSync(join(tmpdir(), "gog-email-selection-test-"));
  const messages = [message(1), message(2)];
  const source = mailbox(messages);
  source.failCompletions.add("aa02");
  const provider = classifier(thread => thread === "bb01" ? "Action" : "Informational");
  const config = parseConfig({ account, triage: { decisionModel: model, policy: { ...defaultPolicy, labels: [
    { name: "Action", description: "Owned action", action: "wake" }, { name: "Informational", description: "No action needed", action: "skip" },
  ] } }, settings: { completionLabels: ["Handled"], retryDelaySeconds: 3600 } });
  let workflow: Workflow;
  let runs = 0;
  const subagent: MailSubagent = { async run({ idempotencyKey, sessionKey }) {
    runs++;
    const id = jobId(idempotencyKey);
    workflow.skip({ jobId: id, sessionKey, reason: "Investigated; no further action needed" });
    return { runId: id, sessionKey };
  }, async waitForRun() { return { status: "ok" }; } };
  const options = { config, stateDir: dir, mail: source.mail, subagent, ...provider };
  workflow = createMailWorkflow(options);
  try {
    await workflow.cycle();
    assert.equal(runs, 1);
    assert.equal(provider.calls(), 2);
    assert.ok(!messages[1].labelIds.includes("Label_Handled"));
    assert.ok(workflow.inspect("aa02")[0].effects.some(effect => effect.status === "uncertain"));
    await workflow.stop();
    t.mock.timers.tick(3_600_000);
    workflow = createMailWorkflow(options);
    await workflow.cycle();
    assert.ok(messages.every(message => message.labelIds.includes("Label_Handled")));
    assert.equal(source.completionAttempts.filter(id => id === "aa02").length, 2);
    assert.equal(provider.calls(), 2, "retrying an effect cannot buy classification again");
    assert.equal(runs, 1, "retrying an effect cannot repeat completed agent work");
    assert.equal(workflow.inspect("aa01")[0].message.status, "done");
    assert.equal(workflow.inspect("aa02")[0].message.status, "skipped");
    assert.ok(workflow.inspect("aa02")[0].effects.every(effect => effect.status === "confirmed"));
  } finally { await workflow.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test("reply overrides apply to rule and Jev wakes, while recipient allowlists never approve requesters", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gog-email-selection-test-"));
  const messages: GmailMessage[] = [];
  const source = mailbox(messages);
  const provider = classifier(() => "Action");
  const config = parseConfig({ account, domains: ["example.com"], triage: { decisionModel: model, policy: { ...defaultPolicy,
    labels: [{ name: "Action", description: "Needs action", action: "wake" }] } },
    settings: { wakeFrom: ["vip@example.com"], triageReplyAllowed: false, replyRecipients: ["outside.test"] } });
  let workflow: Workflow;
  const checked: string[] = [];
  const subagent: MailSubagent = { async run({ idempotencyKey, sessionKey }) {
    const id = jobId(idempotencyKey);
    const reply = { jobId: id, sessionKey, body: "Received and reviewed." };
    const context = workflow.context(id, sessionKey);
    assert.equal(context.job.thread_id, "triage", "rules and Jev share one execution lifecycle");
    workflow.policyUpdate(undefined, workflow.policyGet().version, "operator", { triageReplyAllowed: false });
    assert.equal(workflow.context(id, sessionKey).replyAllowed, false);
    await assert.rejects(workflow.reply({ ...reply, threadId: context.messages[0].threadId }), /disabled/);
    workflow.policyUpdate(undefined, workflow.policyGet().version, "operator", { triageReplyAllowed: true });
    assert.equal(workflow.context(id, sessionKey).replyAllowed, true);
    for (const conversation of workflow.context(id, sessionKey).messages) {
      checked.push(...conversation.messageIds);
      if (conversation.threadId === "bb03") {
        assert.equal(conversation.replyAllowed, false);
        await assert.rejects(workflow.reply({ ...reply, threadId: conversation.threadId }), /external-or-invalid-sender/);
      } else await workflow.reply({ ...reply, threadId: conversation.threadId });
    }
    workflow.complete({ jobId: id, sessionKey, reason: "Authorized replies sent; external requests declined" });
    return { runId: id, sessionKey };
  }, async waitForRun() { return { status: "ok" }; } };
  workflow = createMailWorkflow({ config, stateDir: dir, mail: source.mail, subagent, ...provider });
  try {
    await workflow.cycle();
    messages.push(...["vip@example.com", "bek@example.com", "requester@outside.test"].map((sender, index) =>
      message(index + 1, { sender, received: Date.now() + 100, to: `${account}, guest@outside.test`, cc: "not-approved@elsewhere.test" })));
    await workflow.cycle();
    assert.deepEqual(checked.sort(), ["aa01", "aa02", "aa03"], JSON.stringify(workflow.status().unresolvedJobs));
    assert.deepEqual(source.sent.map(send => send.targetMessageId).sort(), ["aa01", "aa02"]);
    assert.ok(source.sent.every(send => send.to.length === 1 && send.to[0] === "guest@outside.test" && send.cc.length === 0),
      "an explicit recipient allowlist changes destinations, not who may request a reply");
    assert.equal(provider.calls(), 2, "direct wake replies do not require classification");
  } finally { await workflow.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test("gog_email_reply recipients narrows approved audience and fails closed on unapproved or empty lists", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gog-email-selection-test-"));
  const messages: GmailMessage[] = [];
  const source = mailbox(messages);
  const config = parseConfig({ account, domains: ["example.com"], senders: ["bek@partner.test"] });
  let workflow: Workflow;
  const subagent: MailSubagent = { async run({ idempotencyKey, sessionKey }) {
    const id = jobId(idempotencyKey);
    const context = workflow.context(id, sessionKey);
    const target = context.messages[0];
    const base = { jobId: id, sessionKey, body: "Private reply." };
    if (target.threadId === "bb01") {
      await assert.rejects(workflow.reply({ ...base, recipients: [] }), /cannot be empty/);
      await assert.rejects(workflow.reply({ ...base, recipients: ["intruder@outside.test"] }), /not in the approved reply audience/);
      await assert.rejects(workflow.reply({ ...base, recipients: ["not-an-email"] }), /invalid reply recipient/);
      await assert.rejects(workflow.reply({ ...base, recipients: ["amanda@example.com"], externalTo: ["team@example.com"] }), /cannot re-add/);
      // Narrow to sender only (drops team@example.com and cc bek@partner.test)
      await workflow.reply({ ...base, recipients: ["Amanda <amanda@example.com>"] });
    } else if (target.threadId === "bb02") {
      // Narrow exclusively to a CC participant -> promoted to To
      await workflow.reply({ ...base, recipients: ["bek@partner.test"] });
    }
    return { runId: id, sessionKey };
  }, async waitForRun() { return { status: "ok" }; } };
  workflow = createMailWorkflow({ config, stateDir: dir, mail: source.mail, subagent });
  try {
    await workflow.cycle();
    messages.push(
      message(1, { sender: "amanda@example.com", received: Date.now() + 100, to: `${account}, team@example.com`, cc: "bek@partner.test" }),
      message(2, { sender: "amanda@example.com", received: Date.now() + 200, to: `${account}, team@example.com`, cc: "bek@partner.test" }),
    );
    await workflow.cycle();
    assert.equal(source.sent.length, 2);
    assert.deepEqual(source.sent[0], { targetMessageId: "aa01", to: ["amanda@example.com"], cc: [], body: "Private reply." });
    assert.deepEqual(source.sent[1], { targetMessageId: "aa02", to: ["bek@partner.test"], cc: [], body: "Private reply." });
  } finally { await workflow.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test("applyLabels false prevents Gmail label creation and modification while preserving local classification and wakes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gog-email-selection-test-"));
  const messages: GmailMessage[] = [];
  const source = mailbox(messages);
  let labelIdCalls = 0;
  let modifyCalls = 0;
  const origLabelId = source.mail.labelId;
  const origModify = source.mail.modify;
  source.mail.labelId = async name => { labelIdCalls++; return origLabelId(name); };
  source.mail.modify = async (ids, add, remove) => { modifyCalls++; return origModify(ids, add, remove); };
  const provider = classifier(() => "Action");
  const config = parseConfig({ account, triage: { decisionModel: model, policy: { ...defaultPolicy,
    labels: [{ name: "Action", description: "Needs action", action: "wake" }] } },
    settings: { wakeFrom: ["vip@example.com"], applyLabels: false, replyAllowed: false } });
  let workflow: Workflow;
  const covered: string[][] = [];
  const subagent: MailSubagent = { async run({ idempotencyKey, sessionKey }) {
    const id = jobId(idempotencyKey);
    covered.push(workflow.context(id, sessionKey).messages.flatMap(m => m.messageIds));
    workflow.complete({ jobId: id, sessionKey, reason: "Reviewed read-only" });
    return { runId: id, sessionKey };
  }, async waitForRun() { return { status: "ok" }; } };
  workflow = createMailWorkflow({ config, stateDir: dir, mail: source.mail, subagent, ...provider });
  try {
    await workflow.cycle();
    messages.push(
      message(1, { sender: "vip@example.com", received: Date.now() + 100 }),
      message(2, { sender: "other@outside.test", received: Date.now() + 200 }),
    );
    await workflow.cycle();
    assert.deepEqual(covered.flat().sort(), ["aa01", "aa02"]);
    assert.equal(labelIdCalls, 0, "applyLabels=false must not create or look up category labels in Gmail");
    assert.equal(modifyCalls, 0, "applyLabels=false must not modify Gmail labels");
    const plan1 = workflow.inspect("aa01")[0].plan as { labels?: string[] } | undefined;
    assert.deepEqual(plan1?.labels, ["Wake from vip@example.com"], "matched labels remain persisted locally");
    assert.equal(workflow.inspect("aa01")[0].labels, undefined);
  } finally { await workflow.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test("deterministic rule wakes reuse per-cycle rule memberships instead of repeating full Gmail searches", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gog-email-selection-test-"));
  const messages: GmailMessage[] = [];
  const source = mailbox(messages);
  let ruleSearchCalls = 0;
  const origSearch = source.mail.searchPage;
  source.mail.searchPage = async (after, page, scope, before, query) => {
    if (query?.includes("from:vip@example.com") || query?.includes("from:ops@example.com")) ruleSearchCalls++;
    return origSearch(after, page, scope, before, query);
  };
  const config = parseConfig({ account, settings: { wakeFrom: ["vip@example.com", "ops@example.com"], wakeScope: "in:inbox", replyAllowed: false } });
  let workflow: Workflow;
  const subagent: MailSubagent = { async run({ idempotencyKey, sessionKey }) {
    const id = jobId(idempotencyKey);
    workflow.complete({ jobId: id, sessionKey, reason: "Handled" });
    return { runId: id, sessionKey };
  }, async waitForRun() { return { status: "ok" }; } };
  workflow = createMailWorkflow({ config, stateDir: dir, mail: source.mail, subagent });
  try {
    await workflow.cycle();
    ruleSearchCalls = 0;
    messages.push(message(1, { sender: "vip@example.com", received: Date.now() + 100 }));
    await workflow.cycle();
    assert.equal(workflow.inspect("aa01")[0].message.status, "done");
    // 2 rules x (discoverRules + dispatchWake refresh) = 4 max (previously 12-14!)
    assert.ok(ruleSearchCalls <= 4, `expected <= 4 rule searchPage calls across full wake+label cycle, got ${ruleSearchCalls}`);
  } finally { await workflow.stop(); rmSync(dir, { recursive: true, force: true }); }
});
