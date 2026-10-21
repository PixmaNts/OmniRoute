/** Exercises the real route, SQLite combo/key policies and credential selector; only vendor HTTP is scripted. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "systemone-combo-"));
process.env.DATA_DIR = dir;
process.env.API_KEY_SECRET = "systemone-combo-test-secret";
const core = await import("../../src/lib/db/core.ts");
const providers = await import("../../src/lib/db/providers.ts");
const combos = await import("../../src/lib/db/combos.ts");
const keys = await import("../../src/lib/db/apiKeys.ts");
const { setRateLimiterTestMode } = await import("../../src/shared/utils/rateLimiter.ts");
const { clearAllModelLockouts, clearProviderFailure } =
  await import("../../open-sse/services/accountFallback.ts");
const { POST } = await import("../../src/app/api/v1/systemone/route.ts");
const { GET } = await import("../../src/app/api/v1/systemone/models/route.ts");
setRateLimiterTestMode(true);
const originalFetch = globalThis.fetch;
const FREE = "opencode-systemone/jev-1.13-free";
const PAID = "command-code/typesafe/jev";
const BODY = {
  model: "jev",
  state: "Customer charged twice",
  questions: {
    team: {
      type: "choice",
      instructions: "Choose department",
      criteria: { billing: "Refunds", support: "Bugs" },
    },
  },
};
const ANSWERS = {
  team: {
    type: "choice",
    choice: "billing",
    confidence: 1,
    probabilities: { billing: 1, support: 0 },
  },
};
type Call = { url: string; headers: Headers; body: Record<string, unknown> };
let calls: Call[] = [];
let paidId = "";
function script(reply: (call: Call) => Response) {
  calls = [];
  globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
    if (init.method !== "POST" || !String(input).endsWith("/systemone"))
      return Response.json({ error: "No quota probe fixture" }, { status: 503 });
    const call = {
      url: String(input),
      headers: new Headers(init.headers),
      body: JSON.parse(String(init.body)),
    };
    calls.push(call);
    return reply(call);
  }) as typeof fetch;
}
function success(call: Call) {
  return Response.json({
    model: call.body.model,
    answers: ANSWERS,
    usage: { input_tokens: 1000, output_tokens: 0 },
  });
}
function request(key?: string, signal?: AbortSignal, body = BODY) {
  return new Request("http://localhost/v1/systemone", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify(body),
    signal,
  });
}
test.before(async () => {
  await core.ensureDbInitialized();
  paidId = String(
    (
      await providers.createProviderConnection({
        provider: "command-code",
        name: "Paid Jev",
        apiKey: "cc-test-key",
        isActive: true,
      })
    ).id
  );
  await combos.createCombo({
    name: "jev",
    strategy: "fill-first",
    models: [{ model: FREE }, { model: PAID }],
    config: { maxRetries: 0, disableSessionStickiness: true },
  });
});
test.beforeEach(async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-21T18:00:00Z") });
  clearAllModelLockouts();
  clearProviderFailure("opencode-systemone");
  clearProviderFailure("command-code");
  await providers.updateProviderConnection(paidId, {
    isActive: true,
    testStatus: "active",
    rateLimitedUntil: null,
  });
});
test.afterEach(() => {
  globalThis.fetch = originalFetch;
});
test.after(() => {
  core.resetDbInstance();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("fill-first returns actual free Jev answers, no paid call or Authorization, zero cost", async () => {
  script(success);
  const response = await POST(request());
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual((await response.json()).answers, ANSWERS);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://opencode.ai/inference/systemone/v1/systemone");
  assert.equal(calls[0].headers.get("authorization"), null);
  assert.deepEqual(calls[0].body, { ...BODY, model: "jev-1.13-free" });
  assert.equal(Number(response.headers.get("X-OmniRoute-Response-Cost")), 0);
});
for (const failure of ["503", "429", "malformed"] as const) {
  test(`free ${failure} fails over to CommandCode with native envelope and persists known provider cost`, async () => {
    script((call) =>
      call.url.includes("opencode.ai")
        ? failure === "malformed"
          ? Response.json({ unexpected: true })
          : Response.json(
              { error: "Free unavailable" },
              { status: Number(failure), headers: { "retry-after": "30" } }
            )
        : success(call)
    );
    const response = await POST(request());
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual((await response.json()).answers, ANSWERS);
    assert.deepEqual(
      calls.map((call) => call.body.model),
      ["jev-1.13-free", "typesafe/jev"]
    );
    assert.equal(calls[1].url, "https://api.commandcode.ai/provider/v1/systemone");
    assert.equal(calls[1].headers.get("authorization"), "Bearer cc-test-key");
    assert.deepEqual(calls[1].body, { ...BODY, model: "typesafe/jev" });
    assert.equal(response.headers.get("X-OmniRoute-Provider"), "cmd");
    assert.ok(
      Math.abs(Number(response.headers.get("X-OmniRoute-Response-Cost")) - 0.00004) < 1e-12
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    const db = core.getDbInstance();
    const columns = db.prepare("PRAGMA table_info(usage_history)").all() as Array<{ name: string }>;
    const costColumn = columns.some((column) => column.name === "provider_cost_usd")
      ? ", provider_cost_usd"
      : "";
    const row = db
      .prepare(
        `SELECT tokens_input${costColumn} FROM usage_history WHERE provider = 'command-code' ORDER BY rowid DESC LIMIT 1`
      )
      .get() as { tokens_input: number; provider_cost_usd?: number };
    assert.equal(row.tokens_input, 1000);
    if (typeof row.provider_cost_usd === "number") {
      assert.ok(Math.abs(row.provider_cost_usd - 0.00004) < 1e-12);
    }
  });
}
test("connection allowlist skips anonymous free target and serves paid; denied combo makes no vendor call", async () => {
  const allowed = await keys.createApiKey("Paid only", "paid-only-machine");
  await keys.updateApiKeyPermissions(allowed.id, {
    allowedConnections: [paidId],
    allowedEndpoints: ["systemone"],
  });
  script(success);
  const response = await POST(request(allowed.key));
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(
    calls.map((call) => call.body.model),
    ["typesafe/jev"]
  );
  const denied = await keys.createApiKey("Denied combo", "denied-combo-machine");
  await keys.updateApiKeyPermissions(denied.id, {
    modelAccessMode: "restricted",
    allowedModels: ["openai/gpt-4o"],
    allowedCombos: ["some-other-combo"],
  });
  calls = [];
  assert.equal((await POST(request(denied.key))).status, 403);
  assert.equal(calls.length, 0);
});
test("both targets rate limited return 429 with Retry-After without repeating either target", async () => {
  script(() =>
    Response.json({ error: "Quota exhausted" }, { status: 429, headers: { "retry-after": "60" } })
  );
  const response = await POST(request());
  assert.equal(response.status, 429, await response.clone().text());
  assert.ok(Number(response.headers.get("Retry-After")) > 0);
  assert.equal(calls.length, 2);
});
test("already aborted request never calls either vendor", async () => {
  script(success);
  const controller = new AbortController();
  controller.abort();
  const response = await POST(request(undefined, controller.signal));
  assert.equal(response.status, 499);
  assert.equal(calls.length, 0);
});
test("System One catalog advertises free, paid and decision combo without vendor catalog requests", async () => {
  script(() => {
    throw new Error("Static catalogs must not call vendors");
  });
  const response = await GET(new Request("http://localhost/v1/systemone/models"));
  assert.equal(response.status, 200);
  const rows = (await response.json()).data;
  assert.ok(rows.some((row: { id: string }) => row.id === FREE));
  assert.ok(rows.some((row: { id: string }) => row.id === PAID));
  assert.ok(rows.some((row: { id: string }) => row.id === "jev"));
  assert.ok(
    rows.every((row: { supported_endpoints: string[] }) =>
      row.supported_endpoints.includes("systemone")
    )
  );
});
