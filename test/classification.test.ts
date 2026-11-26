import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { Ajv } from "ajv";
import type { DecisionBatch, DecisionRuntimeV1 } from "openclaw/plugin-sdk/decisions";
import { parseConfig, type GmailMessage, type GmailThread } from "../src/mail.js";
import { createPolicyStore, defaultPolicy, hash, parsePolicy, triageModelId, type Policy } from "../src/policy.js";
import { MailState } from "../src/state.js";
import { createTriage } from "../src/triage.js";
import { createMailWorkflow } from "../src/workflow.js";

function message(id = "aa01", sender = "bek@example.com", authenticated = true): GmailMessage {
  return { id, threadId: "bb01", internalDate: String(Date.now()), labelIds: ["INBOX"], payload: {
    mimeType: "text/plain", headers: [
      { name: "From", value: sender }, { name: "To", value: "agent@example.com" },
      { name: "Authentication-Results", value: `mx.google.com; dmarc=${authenticated ? "pass" : "fail"} header.from=${sender.split("@")[1]}` },
    ], body: { data: Buffer.from("Please check the account configuration.").toString("base64url") },
  } };
}

function stateFor(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "gog-classification-"));
  const state = new MailState(directory);
  t.after(() => { state.close(); rmSync(directory, { recursive: true, force: true }); });
  return state;
}

const mappedPolicy: Policy = { prompt: "Classify the current work.", deletePrompt: "Delete advertisements.", queueMinutes: 60,
  labels: [ { name: "Urgent", description: "Urgent owned work", action: "wake" },
    { name: "Action", description: "Nonurgent owned work", action: "queue" },
    { name: "News", description: "Informational", action: "skip" } ] };

function harness(t: TestContext, policy = mappedPolicy, initial = message()) {
  const state = stateFor(t);
  const config = parseConfig({ account: "agent@example.com", domains: ["example.com"],
    triage: { decisionModel: "typesafe/jev-1.13.0", policy } });
  const policies = createPolicyStore(config, state);
  const thread: GmailThread = { id: "bb01", messages: [initial] };
  const batches: DecisionBatch[] = [];
  let applies = new Set<string>();
  let failLabel = "";
  let writes = 0;
  const decisions: DecisionRuntimeV1 = { async evaluate(batch) {
    batches.push(batch);
    return { status: "ok", provenance: { providerId: "typesafe", rubricVersion: "mail-label-first-v1", runtimeGeneration: "test" },
      result: { model: "jev-1.13.0", answers: Object.fromEntries(Object.keys(batch.questions).map(id => [id,
        { type: "choice" as const, choice: applies.has(id) ? "apply" : "skip", probabilities: { apply: applies.has(id) ? 1 : 0, skip: applies.has(id) ? 0 : 1 } }])) } };
  } };
  const triage = createTriage({ config, state, policies, signal: new AbortController().signal,
    decisions, decisionModel: () => "typesafe/jev-1.13.0", mutate: work => work(), mail: {
      async getThread() { return thread; }, async labelId(name) { return `label:${name}`; },
      async modify(ids, add, remove) {
        writes++;
        if (add.includes(failLabel)) { failLabel = ""; throw new Error("Gmail temporarily unavailable"); }
        for (const item of thread.messages.filter(item => ids.includes(item.id)))
          item.labelIds = [...new Set([...item.labelIds.filter(label => !remove.includes(label)), ...add])];
        return { updated: ids };
      },
    } });
  return { state, policies, thread, triage, batches, applies: (...ids: string[]) => { applies = new Set(ids); },
    fail: (name: string) => { failLabel = `label:${name}`; }, writes: () => writes };
}

test("Jev classifies labels once; code owns routing precedence and the no-match default", async t => {
  for (const [applied, action] of [
    [[], "skip"], [["deletion_match"], "delete"], [["label_1", "deletion_match"], "queue"],
    [["label_0", "label_1", "deletion_match"], "wake"],
  ] as const) await t.test(action, async t => {
    const h = harness(t); h.applies(...applied);
    const result = await h.triage.assess(h.thread, h.thread.messages);
    assert.equal(result.action, action);
    assert.equal(h.batches.length, 1);
    assert.equal("action" in h.batches[0].questions, false);
    for (const question of Object.values(h.batches[0].questions)) {
      assert.equal(question.type, "choice");
      if (question.type === "choice") assert.deepEqual(Object.keys(question.criteria), ["apply", "skip"]);
    }
    assert.deepEqual(JSON.parse(result.rows[0].plan), { action, labels: result.labels, source: "jev" });
    assert.equal(h.writes(), 0, "classification and routing do not write Gmail");
  });
});

test("sender rules match authenticated exact facts and bypass Jev only when they settle routing", async t => {
  const policy: Policy = { ...mappedPolicy, labels: [
    { name: "Team", description: "Team domain and individual contacts", match: { domains: ["EXAMPLE.COM"], senders: ["PERSON@OUTSIDE.TEST"] }, action: "wake" },
    { name: "Topic", description: "Configuration request", action: "queue" },
  ] };
  for (const [sender, authenticated, action, calls] of [
    ["bek@example.com", true, "wake", 0], ["bek@sub.example.com", true, "queue", 1],
    ["bek@example.com.attacker.test", true, "queue", 1], ["bek@example.com", false, "queue", 1],
    ["person@outside.test", true, "wake", 0], ["other@outside.test", true, "queue", 1],
    ["person@sub.outside.test", true, "queue", 1], ["person@outside.test", false, "queue", 1],
  ] as const) await t.test(`${sender}/${authenticated}`, async t => {
    const h = harness(t, policy, message("aa01", sender, authenticated)); h.applies("label_1");
    const result = await h.triage.assess(h.thread, h.thread.messages);
    assert.equal(result.action, action); assert.equal(h.batches.length, calls);
    if (!calls) assert.deepEqual(result.labels, ["Team"]);
  });
  await t.test("live individual and domain additions stay independent", async t => {
    const h = harness(t, policy, message("aa01", "new@partner.test")); h.applies("label_1");
    const teammate = message("aa02");
    const matches: Array<[NonNullable<Policy["labels"][number]["match"]>, string]> = [
      [{ domains: ["example.com"], senders: ["person@outside.test"] }, "queue"],
      [{ domains: ["example.com"], senders: ["person@outside.test", "new@partner.test"] }, "wake"],
      [{ domains: ["example.com"], senders: ["person@outside.test"] }, "queue"],
      [{ domains: ["example.com", "partner.test"], senders: ["person@outside.test"] }, "wake"],
    ];
    for (const [match, action] of matches) {
      const current = h.policies.get();
      h.policies.update({ ...current.document, labels: [{ ...current.document.labels[0], match }, ...current.document.labels.slice(1)] }, current.version, "operator");
      assert.equal((await h.triage.assess(h.thread, h.thread.messages)).action, action);
      assert.equal((await h.triage.assess({ ...h.thread, messages: [teammate] }, [teammate])).action, "wake",
        "adding or removing an individual must not replace the existing team-domain rule");
      const individual = message("aa03", "person@outside.test");
      assert.equal((await h.triage.assess({ ...h.thread, messages: [individual] }, [individual])).action, "wake",
        "adding a domain must not replace an existing individual rule");
    }
  });
  await t.test("topic-only code labels still need semantic classification", async t => {
    const h = harness(t, { ...policy, labels: [{ ...policy.labels[0], action: undefined }, policy.labels[1]] });
    h.applies("label_1");
    const result = await h.triage.assess(h.thread, h.thread.messages);
    assert.deepEqual(result.labels, ["Team", "Topic"]); assert.equal(result.action, "queue");
    assert.equal(h.batches.length, 1);
  });
  await t.test("explicit code skip settles routing without Jev", async t => {
    const h = harness(t, { ...policy, labels: [{ ...policy.labels[0], action: "skip" }, policy.labels[1]] });
    h.applies("label_1");
    const result = await h.triage.assess(h.thread, h.thread.messages);
    assert.equal(result.action, "skip");
    assert.deepEqual(result.labels, ["Team"]);
    assert.equal(h.batches.length, 0);
  });
});

test("Gmail label failures retry persisted classification; metadata does not invalidate it, new replies do", async t => {
  const h = harness(t); h.applies("label_0", "label_1");
  const result = await h.triage.assess(h.thread, h.thread.messages);
  h.triage.scheduleLabels(result.rows[0].id, h.thread.id);
  h.fail("Action");
  await assert.rejects(h.triage.label(["aa01"], h.thread.id), /temporarily unavailable/);
  assert.equal(result.action, "wake", "failed label delivery does not change admission");
  await h.triage.label(["aa01"], h.thread.id);
  assert.equal(h.batches.length, 1);
  assert.deepEqual(h.thread.messages[0].labelIds, ["INBOX", "label:Urgent", "label:Action"]);
  assert.equal(h.writes(), 3, "confirmed partial write is reconciled rather than repeated");
  h.thread.messages[0].labelIds.push("UNREAD");
  await h.triage.assess(h.thread, h.thread.messages);
  assert.equal(h.batches.length, 1);
  h.thread.messages.push(message("aa02"));
  await h.triage.assess(h.thread, h.thread.messages);
  assert.equal(h.batches.length, 2);
});

test("new replies retire obsolete label retries without blocking fresh labels or later reclassification", async t => {
  const h = harness(t); h.applies("label_0");
  await h.triage.assess(h.thread, h.thread.messages);
  h.triage.scheduleLabels("aa01", h.thread.id); h.fail("Urgent");
  await assert.rejects(h.triage.label(["aa01"], h.thread.id), /temporarily unavailable/);
  const next = message("aa02"); h.thread.messages.push(next); h.applies("label_1");
  await h.triage.assess(h.thread, [next]); h.triage.scheduleLabels(next.id, h.thread.id);
  await h.triage.label(["aa01", "aa02"], h.thread.id);
  assert.equal(h.state.db.prepare("SELECT status FROM label_work WHERE id='aa01'").get()?.status, "cancelled");
  assert.deepEqual(next.labelIds, ["INBOX", "label:Action"]);
  assert.equal(h.batches.length, 2, "retiring stale effects does not classify again");
  // The workflow marks successfully delivered category work done, while this
  // nonurgent message remains eligible for reclassification before dispatch.
  h.state.db.prepare("UPDATE label_work SET status='done' WHERE id=?").run(next.id);
  h.thread.messages.push(message("aa03")); h.applies("label_0");
  await h.triage.assess(h.thread, [next]); h.triage.scheduleLabels(next.id, h.thread.id);
  await h.triage.label([next.id], h.thread.id);
  assert.ok(next.labelIds.includes("label:Urgent"), "fresh classification rearms previously completed category work");
  assert.equal(h.batches.length, 3);
});

test("legacy policy upgrade keeps custom prompt, labels, history and completed or uncertain work", t => {
  const state = stateFor(t);
  const legacy = { ...defaultPolicy, prompt: "Only owned operations work matters.", labels: [{ name: "Ops", description: "Operations mail" }] };
  state.db.prepare("INSERT INTO policies(version,document,created,editor,settings) VALUES (1,?,0,'helper',?)")
    .run(JSON.stringify(legacy), JSON.stringify({ wakePrompt: "Keep my custom instructions", labelConcurrency: 7 }));
  // Historical file fingerprint, intentionally independent of today's defaults.
  state.setMeta("runtime_config_settings", hash({ wakePrompt: "", responderPrompt: "", pollIntervalSeconds: 120,
    concurrency: 50, labelConcurrency: null, retryDelaySeconds: null, decisionTimeoutSeconds: 30,
    gogTimeoutSeconds: 90, agentWaitTimeoutSeconds: 660, gogMaxOutputBytes: 10485760,
    discoveryOverlapSeconds: 600, reconcileIntervalSeconds: 3600, reconcileLookbackSeconds: 604800,
    maxAgeDays: 30, maxInputTokens: 32000, maxRequestTokens: 64000 }));
  for (const status of ["done", "needs_review", "skipped"]) state.db.prepare("INSERT INTO messages(id,thread_id,received,sender,status,discovered) VALUES (?,'bb01',0,'bek@example.com',?,0)").run(status, status);
  const config = parseConfig({ account: "agent@example.com", triage: { decisionModel: "typesafe/jev-1.13.0" } });
  const policies = createPolicyStore(config, state);
  const current = policies.get();
  assert.equal(current.document.prompt, legacy.prompt);
  assert.deepEqual(current.document.labels[0], legacy.labels[0]);
  assert.equal(current.settings.wakePrompt, "Keep my custom instructions");
  assert.equal(current.settings.labelConcurrency, 7);
  assert.ok(current.document.labels.some(label => label.action === "wake"));
  assert.deepEqual(JSON.parse(String(state.db.prepare("SELECT document FROM policies WHERE version=1").get()?.document)), legacy);
  assert.equal(state.message("done")?.status, "done");
  assert.equal(state.message("needs_review")?.status, "needs_review");
  assert.equal(state.message("skipped")?.status, "pending");
  assert.throws(() => parsePolicy({ ...mappedPolicy, deletePrompt: "", labels: [{ name: "Delete", description: "Ads", action: "delete" }] }), /explicit deletion/);
});

test("direct @unblocklabs/decisions config validates, calls /v1/decisions, caches results, and hides credentials from status", async t => {
  const canonical = parseConfig({ account: "agent@example.com", triage: { decisionModel: {} } });
  assert.equal(triageModelId(canonical.triage), "liquid/d1.2-ultra");
  assert.deepEqual(canonical.triage?.decisionModel, {
    endpoint: "https://codex.unblocklabs.ai/v1/decisions",
    model: "liquid/d1.2-ultra",
  });
  assert.throws(() => parseConfig({ account: "agent@example.com", triage: { decisionModel: { endpoint: "http://example.com/v1/decisions" } } }), /invalid triage/);
  assert.throws(() => parseConfig({ account: "agent@example.com", triage: { decisionModel: { apiKey: "k1", apiKeyFile: "/tmp/key.env" } } }), /not both/);
  assert.throws(() => parseConfig({ account: "agent@example.com", triage: { decisionModel: { apiKeyFile: "relative.env" } } }), /invalid triage/);
  // OpenClaw Gateway validates openclaw.plugin.json with Ajv; ensure invalid direct-model configs fail there too.
  const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8")) as { configSchema: object };
  const validateManifest = new Ajv({ strict: false }).compile(manifest.configSchema);
  assert.equal(validateManifest({ account: "agent@example.com", triage: { decisionModel: {} } }), true);
  assert.equal(validateManifest({ account: "agent@example.com", triage: { decisionModel: { apiKey: "k1", apiKeyFile: "/tmp/key.env" } } }), false);
  assert.equal(validateManifest({ account: "agent@example.com", triage: { decisionModel: { endpoint: "http://example.com/v1/decisions" } } }), false);
  assert.equal(validateManifest({ account: "agent@example.com", triage: { decisionModel: { apiKeyFile: "relative.env" } } }), false);

  const dir = mkdtempSync(join(tmpdir(), "gog-decisions-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const keyFile = join(dir, "decisions.env");
  writeFileSync(keyFile, "CODEX_LB_API_KEY=test-secret-token\n", { mode: 0o600 });

  const requests: Array<{ auth?: string; body: { model: string; state: unknown; questions: Record<string, { type: string }> } }> = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model: string; state: unknown; questions: Record<string, { type: string }> };
      requests.push({ auth: req.headers.authorization, body });
      const answers = Object.fromEntries(Object.keys(body.questions).map(id => {
        const apply = id === "label_0";
        return [id, { type: "choice", choice: apply ? "apply" : "skip", confidence: 0.99, probabilities: { apply: apply ? 0.99 : 0.01, skip: apply ? 0.01 : 0.99 } }];
      }));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ model: "liquid/d1.2-ultra-20261116", answers, usage: { input_tokens: 100, output_tokens: 10 } }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/decisions`;

  const config = parseConfig({
    account: "agent@example.com",
    triage: { decisionModel: { endpoint, model: "liquid/d1.2-ultra", apiKeyFile: keyFile }, policy: mappedPolicy },
  });
  const state = stateFor(t);
  const policies = createPolicyStore(config, state);
  const thread: GmailThread = { id: "bb01", messages: [message()] };
  const triage = createTriage({
    config, state, policies, signal: new AbortController().signal, mutate: work => work(),
    mail: { async getThread() { return thread; }, async labelId(name) { return `label:${name}`; }, async modify(ids) { return { updated: ids }; } },
  });

  const first = await triage.assess(thread, thread.messages);
  assert.equal(first.action, "wake");
  assert.deepEqual(first.labels, ["Urgent"]);
  assert.equal(first.source, "decision_model");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].auth, "Bearer test-secret-token");
  assert.equal(requests[0].body.model, "liquid/d1.2-ultra");
  assert.ok(Array.isArray(requests[0].body.state), "decisions dialect wraps object state in a single-element array");

  // Repeat assessment reuses SQLite cache without a second HTTP request
  const second = await triage.assess(thread, thread.messages);
  assert.equal(second.action, "wake");
  assert.equal(requests.length, 1);

  // workflow.status().triage.model reports scope string and never exposes apiKey/apiKeyFile
  const wfDir = mkdtempSync(join(tmpdir(), "gog-decisions-wf-"));
  t.after(() => rmSync(wfDir, { recursive: true, force: true }));
  const wf = createMailWorkflow({
    config, stateDir: wfDir,
    subagent: { async run() { return { runId: "r1", sessionKey: "s1" }; }, async waitForRun() { return { status: "ok" }; } },
  });
  t.after(() => wf.stop());
  const statusJson = JSON.stringify(wf.status());
  assert.equal(wf.status().triage.model, `liquid/d1.2-ultra@${endpoint}`);
  assert.ok(!statusJson.includes("test-secret-token") && !statusJson.includes(keyFile));
});
