import { mock } from 'node:test';
import { parseConfig } from '../../src/mail.js';
import { createMailWorkflow } from '../../src/workflow.js';

const [stateDir, encodedConfig, now] = process.argv.slice(2);
mock.timers.enable({ apis: ['Date'], now: Number(now) });
const config = parseConfig(JSON.parse(encodedConfig));
const workflow = createMailWorkflow({ config, stateDir,
  decisionModel: () => 'typesafe/jev-1.13.0',
  decisions: { evaluate: async batch => ({ status: 'ok',
    provenance: { providerId: 'typesafe', rubricVersion: 'mail-v1', runtimeGeneration: 'test' },
    result: { model: 'jev-1.13.0', answers: Object.fromEntries(Object.entries(batch.questions).map(([key, question]) =>
      [key, { type: 'choice', choice: String(question.instructions).includes('Label: Needs attention now\n') ? 'apply' : 'skip', probabilities: {} }])) },
  }) },
  subagent: {
    async run({ sessionKey, message }) {
      const jobId = /^Job ID: ([a-f0-9]{24})$/m.exec(message)![1];
      if (config.triage) await workflow.reply({ jobId, sessionKey, threadId: 'bb01', body: 'Handled before deferral' });
      const result = workflow.complete({ jobId, sessionKey, reason: 'Retry unfinished work' }, Math.floor(Date.now() / 1000) + 60);
      // Never return to the worker finalizer or call stop: kill the process
      // immediately after the real tool owner acknowledges the durable write.
      process.send!({ event: 'acknowledged', ...result }, () => process.kill(process.pid, 'SIGKILL'));
      return await new Promise<never>(() => {});
    },
    async waitForRun() { throw new Error('crash must precede run finalization'); },
  },
});
await workflow.start();
process.send!({ event: 'ready' });
process.on('message', async () => {
  mock.timers.setTime(Number(now) + 2000);
  await workflow.poll();
});
