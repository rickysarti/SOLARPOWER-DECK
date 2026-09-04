import { askClaude, classifyContact, type AgentMessage } from "../supabase/functions/_shared/anthropic.ts";
import {
  parseAgentDecision,
  replyViolations,
  type AgentCategory,
} from "../supabase/functions/_shared/decision.ts";
import { agentSystemPrompt } from "../supabase/functions/_shared/prompts.ts";
import { deterministicDecision } from "../supabase/functions/_shared/processor.ts";

type EvalCase = {
  id: string;
  period: string;
  incoming: string;
  expectedCategory: AgentCategory;
  expectedHandoff: boolean;
  mustContain: string[];
  mustNotContain: string[];
};

const cases = JSON.parse(
  await Deno.readTextFile(new URL("../supabase/evals/conversations-anonymized.json", import.meta.url)),
) as EvalCase[];
const results: Array<Record<string, unknown>> = [];

for (const testCase of cases) {
  const classification = await classifyContact(testCase.incoming);
  const history: AgentMessage[] = [{ role: "user", content: testCase.incoming }];
  const deterministic = deterministicDecision(testCase.incoming, classification, true);
  const decision = deterministic ?? parseAgentDecision(
    await askClaude(
      agentSystemPrompt({ phone: "5491100000000" }, classification, []),
      history,
      1000,
    ),
    classification,
  );
  const reply = decision.reply.toLocaleLowerCase("es-AR");
  const failures = [
    ...(classification === testCase.expectedCategory ? [] : [`clasificación ${classification}`]),
    ...(decision.handoff === testCase.expectedHandoff ? [] : [`handoff ${decision.handoff}`]),
    ...replyViolations(decision.reply, testCase.incoming),
    ...testCase.mustContain.filter((value) => !reply.includes(value.toLocaleLowerCase("es-AR")))
      .map((value) => `falta ${value}`),
    ...testCase.mustNotContain.filter((value) => reply.includes(value.toLocaleLowerCase("es-AR")))
      .map((value) => `incluye ${value}`),
  ];
  results.push({ id: testCase.id, period: testCase.period, passed: failures.length === 0, failures });
}

const failed = results.filter((result) => !result.passed);
console.log(JSON.stringify({
  total: results.length,
  passed: results.length - failed.length,
  failed: failed.length,
  results,
}, null, 2));
if (failed.length) Deno.exit(1);
