import test from "node:test";
import assert from "node:assert/strict";

import { handleSystemOneProxy } from "../../open-sse/handlers/systemOne.ts";
import { v1SystemOneSchema } from "../../src/shared/validation/schemas.ts";

const BODY = {
  model: "jev-latest",
  state: "I was charged twice for my subscription.",
  questions: { refund: { type: "noul", instructions: "Is the customer asking for money back?" } },
};

async function withFetch(
  impl: (url: string, init: RequestInit) => Promise<Response>,
  fn: () => Promise<void>
) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = impl as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("systemone schema requires model, state and questions", () => {
  assert.equal(v1SystemOneSchema.safeParse(BODY).success, true);
  assert.equal(v1SystemOneSchema.safeParse({ ...BODY, state: { ticket: "x" } }).success, true);
  assert.equal(v1SystemOneSchema.safeParse({ model: "jev-latest", state: "x" }).success, false);
  assert.equal(v1SystemOneSchema.safeParse({ state: "x", questions: {} }).success, false);
});

test("systemone proxy forwards the body to OpenRouter's System One endpoint", async () => {
  let seenUrl = "";
  let seenInit: RequestInit = {};
  const upstream = {
    id: "gen-dec-1",
    model: "typesafe/jev-1.13-20260917",
    provider: "TypeSafe",
    answers: { refund: { type: "noul", noul: 0.98 } },
    usage: { input_tokens: 275, output_tokens: 20, cost: 0.00003 },
  };
  await withFetch(
    async (url, init) => {
      seenUrl = url;
      seenInit = init;
      return new Response(JSON.stringify(upstream), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
    async () => {
      const response = await handleSystemOneProxy({
        body: BODY,
        credentials: { apiKey: "sk-or-test", connectionId: "conn-or-1" },
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), upstream);
      assert.equal(response.headers.get("X-OmniRoute-Provider"), "openrouter");
      assert.equal(response.headers.get("X-OmniRoute-Model"), "typesafe/jev-1.13-20260917");
      // OpenRouter bills the call and reports the exact USD cost in usage.cost.
      assert.equal(Number(response.headers.get("X-OmniRoute-Response-Cost")), 0.00003);
      assert.equal(response.headers.get("X-OmniRoute-Tokens-In"), "275");
    }
  );
  assert.equal(seenUrl, "https://openrouter.ai/api/v1/systemone");
  assert.equal((seenInit.headers as Record<string, string>).Authorization, "Bearer sk-or-test");
  assert.deepEqual(JSON.parse(String(seenInit.body)), BODY);
});

test("systemone proxy keeps the upstream status and retry-after on 429", async () => {
  await withFetch(
    async () =>
      new Response(JSON.stringify({ error: { message: "Rate limit exceeded", code: 429 } }), {
        status: 429,
        headers: { "Content-Type": "application/json", "retry-after": "7" },
      }),
    async () => {
      const response = await handleSystemOneProxy({
        body: BODY,
        credentials: { apiKey: "sk-or-test" },
      });
      assert.equal(response.status, 429);
      assert.equal(response.headers.get("retry-after"), "7");
      const json = (await response.json()) as { error: { message: string } };
      assert.match(json.error.message, /Rate limit exceeded/);
    }
  );
});

test("systemone proxy 401s without an OpenRouter key", async () => {
  const response = await handleSystemOneProxy({ body: BODY, credentials: {} });
  assert.equal(response.status, 401);
});
