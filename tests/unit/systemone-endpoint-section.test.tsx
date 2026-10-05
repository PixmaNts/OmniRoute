// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../../src/i18n/messages/en.json";

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={String(href)} {...props}>
      {children}
    </a>
  ),
}));

// Real English catalog so a missing key shows up as the raw key in the DOM.
vi.mock("next-intl", () => ({
  useTranslations: (namespace?: string) => (key: string, values?: Record<string, unknown>) => {
    const scope = (namespace ? (en as Record<string, Record<string, string>>)[namespace] : en) as
      Record<string, string> | undefined;
    let message = scope?.[key] ?? key;
    if (values) {
      for (const [name, value] of Object.entries(values)) {
        message = message
          .replace(`{${name}}`, String(value))
          .replace(/\{count, plural, one \{# model\} other \{# models\}\}/, `${value} models`);
      }
    }
    return message;
  },
}));

type SectionModule =
  typeof import("../../src/app/(dashboard)/dashboard/endpoint/components/SystemOneEndpointsSection");
let mod: SectionModule;
let EndpointPageClient: React.ComponentType<{ machineId: string }>;

const cleanups: Array<() => void> = [];

function jsonResponse(data: unknown, ok = true) {
  return { ok, status: ok ? 200 : 502, json: async () => data } as Response;
}

function pathOf(input: RequestInfo | URL) {
  return typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
}

function render(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  cleanups.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return container;
}

async function waitFor(check: () => boolean, label: string) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > 2000) throw new Error(`Timed out waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const MODELS = {
  object: "list",
  data: [
    {
      id: "~typesafe/jev-latest",
      name: "TypeSafe: Jev Latest",
      pricing: { prompt: "0.000000042" },
    },
    {
      id: "inception/mercury-decide:free",
      name: "Mercury Decide (free)",
      pricing: { prompt: "0" },
    },
  ],
};

describe("System One endpoints on /dashboard/endpoint", { timeout: 60_000 }, () => {
  const fetchMock = vi.fn();

  beforeAll(async () => {
    mod =
      await import("../../src/app/(dashboard)/dashboard/endpoint/components/SystemOneEndpointsSection");
    EndpointPageClient = (
      await import("../../src/app/(dashboard)/dashboard/endpoint/EndpointPageClient")
    ).default;
  });

  beforeEach(() => {
    fetchMock.mockReset();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    while (cleanups.length) cleanups.pop()?.();
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  it("formats upstream per-token prices as USD per 1M tokens", () => {
    expect(mod.formatPerMillion("0.000000042")).toBe("$0.042");
    expect(mod.formatPerMillion("0.00000024")).toBe("$0.24");
    expect(mod.formatPerMillion("0")).toBe("0");
    expect(mod.formatPerMillion(undefined)).toBeNull();
    expect(mod.formatPerMillion("n/a")).toBeNull();
  });

  it("shows both endpoints with methods, exact model ids, pricing and the OpenRouter requirement", async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const path = pathOf(input);
      if (path === "/v1/systemone/models") return Promise.resolve(jsonResponse(MODELS));
      if (path === "/api/providers?provider=openrouter") {
        return Promise.resolve(jsonResponse({ connections: [], total: 0 }));
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    const el = render(<mod.default baseUrl="http://localhost:20128/v1" />);
    await waitFor(() => !!el.textContent?.includes("2 models"), "model count");
    await waitFor(() => !!el.querySelector('a[href="/dashboard/providers/openrouter"]'), "link");

    const text = el.textContent ?? "";
    const codes = Array.from(el.querySelectorAll("code")).map((c) => c.textContent);
    expect(codes).toContain("/v1/systemone");
    expect(codes).toContain("/v1/systemone/models");
    expect(text).toContain("POST");
    expect(text).toContain("GET");
    expect(text).toContain(en.endpoint.categorySystemOne);
    expect(text).toContain(en.endpoint.systemOneNeedsConnection);
    expect(codes).toContain("~typesafe/jev-latest");
    expect(text).toContain("$0.042 / 1M input tokens");
    expect(text).toContain(en.common.free);
    expect(text).toContain('"questions"');
    // No raw i18n key leaks into the DOM.
    expect(text).not.toMatch(/systemOne[A-Z]\w+/);
    // Copy buttons are labelled for screen readers.
    expect(el.querySelectorAll('button[aria-label="Copy URL"]').length).toBe(2);
  });

  it("reports an active OpenRouter connection and a failed model list without breaking", async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const path = pathOf(input);
      if (path === "/v1/systemone/models") return Promise.resolve(jsonResponse({}, false));
      if (path === "/api/providers?provider=openrouter") {
        return Promise.resolve(jsonResponse({ connections: [{ isActive: true }], total: 1 }));
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    const el = render(<mod.default baseUrl="http://localhost:20128/v1" />);
    await waitFor(() => !!el.textContent?.includes(en.endpoint.systemOneConnected), "connected");
    await waitFor(
      () => !!el.textContent?.includes(en.endpoint.systemOneModelsUnavailable),
      "models failure"
    );
    expect(el.querySelector('a[href="/dashboard/providers/openrouter"]')).toBeNull();
  });

  it("is registered in the Available Endpoints card of the Endpoint page", async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const path = pathOf(input);
      if (path === "/api/settings") {
        return Promise.resolve(
          jsonResponse({
            cloudEnabled: false,
            hideEndpointCloudflaredTunnel: true,
            hideEndpointTailscaleFunnel: true,
            hideEndpointNgrokTunnel: true,
          })
        );
      }
      if (path === "/v1/systemone/models") return Promise.resolve(jsonResponse(MODELS));
      if (path === "/api/providers?provider=openrouter") {
        return Promise.resolve(jsonResponse({ connections: [] }));
      }
      if (path === "/v1/models") return Promise.resolve(jsonResponse({ data: [] }));
      if (path === "/api/search/providers") return Promise.resolve(jsonResponse({ providers: [] }));
      if (path === "/api/cli-tools/keys") return Promise.resolve(jsonResponse({ keys: [] }));
      return Promise.resolve(jsonResponse({}));
    });

    const el = render(<EndpointPageClient machineId="" />);
    await waitFor(() => !!el.textContent?.includes(en.endpoint.categorySystemOne), "section");

    const codes = Array.from(el.querySelectorAll("code")).map((c) => c.textContent);
    expect(codes).toContain("/v1/systemone");
    expect(codes).toContain("/v1/systemone/models");
    // Placed with the other API groups, before Utility & Management.
    const text = el.textContent ?? "";
    expect(text.indexOf(en.endpoint.categorySystemOne)).toBeLessThan(
      text.indexOf(en.endpoint.categoryUtility)
    );
  });
});
