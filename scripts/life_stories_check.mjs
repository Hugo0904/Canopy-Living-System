import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile(new URL("../src/lifeStories.ts", import.meta.url), "utf8");
const transpiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { buildLifeStories } = await import(`data:text/javascript;base64,${Buffer.from(transpiled).toString("base64")}`);

function event(overrides = {}) {
  return {
    id: `activity:${Math.random()}`,
    occurred_at: "2026-08-13T00:00:00+00:00",
    local_date: "2026-08-13",
    module_id: "hooks",
    kind: "turn",
    status: "completed",
    summary: "",
    source: "hook_activity",
    importance: 1,
    facts: {},
    phase: "completed",
    actor: "canopy",
    correlation_id: "turn:truth-case",
    action: "turn_completed",
    growth_stage: "",
    learning: "",
    next_benefit: "",
    assistance: "",
    request_effect: "",
    verification: "",
    ...overrides,
  };
}

const stories = buildLifeStories([
  event({
    id: "activity:turn:opened",
    action: "turn_opened",
    status: "in_progress",
    phase: "preparing",
    summary: "Canopy 啟動有邊界的工程協助。",
    facts: {
      matched_cards: "1",
      role: "ui-ux-designer",
      role_status: "selected",
      prior_context_used: "true",
      evolution: "required",
    },
  }),
  event({
    id: "activity:seed:not-applied",
    kind: "seed_action",
    action: "memory_applied",
    status: "not_applied",
    phase: "growth",
    growth_stage: "observed",
    summary: "既有理解不適合本次情境，因此沒有套用。",
    verification: "Seed action receipt: not_applied",
  }),
  event({
    id: "activity:turn:completed",
    action: "turn_completed",
    growth_stage: "applied",
    summary: "Stop hook 已核對閉環。",
    verification: "Stop hook closure passed.",
  }),
  event({
    id: "activity:assistant:result",
    kind: "assistant_result",
    action: "result",
    summary: "AI 已修正生命歷程的真實性判定。",
    verification: "Stop hook closure passed.",
  }),
]);

assert.equal(stories.length, 1, "correlated events must render as one story");
assert.equal(stories[0].summary, "AI 已修正生命歷程的真實性判定。", "assistant outcome must lead generic Stop text");
assert.equal(stories[0].status, "completed", "a completed correlation must not remain in progress");
assert.equal(stories[0].learning.mode, "reviewed", "explicit not_applied must override turn growth_stage=applied");
assert.equal(stories[0].learning.stage, "reviewed");
assert.equal(stories[0].evolution_requested, true, "required means review requested");
assert.equal(stories[0].interventions.some((item) => item.kind === "role_selected"), true);
assert.equal(stories[0].interventions.some((item) => item.kind === "memory_applied"), false);

const applied = buildLifeStories([
  event({ id: "activity:seed:applied", kind: "seed_action", status: "applied", summary: "已套用偏好。" }),
]);
assert.equal(applied[0].learning.mode, "applied", "only an explicit applied Seed action may claim use");

const candidate = buildLifeStories([
  event({ id: "activity:intake:candidate", kind: "seed_intake", status: "candidate_card_created", growth_stage: "candidate", summary: "建立候選理解。" }),
]);
assert.equal(candidate[0].learning.mode, "candidate", "candidate intake must not claim internalization");

console.log("life story truth checks passed");
