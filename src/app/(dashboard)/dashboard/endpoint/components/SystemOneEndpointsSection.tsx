"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";

/**
 * System One (decision models) block of the Endpoint page's "Available
 * Endpoints" card. These models are not chat models: POST /v1/systemone takes
 * `model`, `state` and typed `questions` and returns typed answers with
 * probabilities, proxied to OpenRouter with the dashboard's OpenRouter
 * connection. GET /v1/systemone/models is the live OpenRouter list.
 */

type SystemOneModel = {
  id: string;
  name?: string;
  pricing?: Record<string, string>;
};

type ConnectionSummary = { isActive?: boolean };

export const SYSTEMONE_DECIDE_PATH = "/v1/systemone";
export const SYSTEMONE_MODELS_PATH = "/v1/systemone/models";
const OPENROUTER_PROVIDER_PAGE = "/dashboard/providers/openrouter";

const METHOD_BADGE: Record<"GET" | "POST", string> = {
  GET: "bg-emerald-500/15 text-emerald-500 border-emerald-500/30",
  POST: "bg-blue-500/15 text-blue-500 border-blue-500/30",
};

const EXAMPLE_BODY = JSON.stringify({
  model: "jev-latest",
  state: "Customer: I want my money back for order 1234.",
  questions: {
    refund: { type: "noul", instructions: "Is the customer asking for money back?" },
  },
});
const EXAMPLE_RESPONSE = '{ "answers": { "refund": { "type": "noul", "noul": 0.98 } }, ... }';

/** Upstream prices are USD per token strings; show USD per 1M input tokens. */
export function formatPerMillion(perToken: string | undefined): string | null {
  const value = Number(perToken);
  if (perToken === undefined || !Number.isFinite(value) || value < 0) return null;
  if (value === 0) return "0";
  return `$${(value * 1_000_000).toFixed(3).replace(/\.?0+$/, "")}`;
}

function CopyButton({
  text,
  id,
  label,
  copied,
  copy,
}: Readonly<{
  text: string;
  id: string;
  label: string;
  copied: string | null;
  copy: (text: string, id?: string) => Promise<boolean>;
}>) {
  return (
    <button
      type="button"
      onClick={() => void copy(text, id)}
      className="shrink-0 flex items-center justify-center size-6 rounded hover:bg-sidebar transition-colors text-text-muted hover:text-primary"
      title={label}
      aria-label={label}
    >
      <span className="material-symbols-outlined text-[12px]" aria-hidden="true">
        {copied === id ? "check" : "content_copy"}
      </span>
    </button>
  );
}

function EndpointRow({
  method,
  path,
  baseUrl,
  copied,
  copy,
  copyLabel,
}: Readonly<{
  method: "GET" | "POST";
  path: string;
  baseUrl: string;
  copied: string | null;
  copy: (text: string, id?: string) => Promise<boolean>;
  copyLabel: string;
}>) {
  const fullUrl = `${baseUrl.replace(/\/v1$/, "")}${path}`;
  return (
    <div className="flex items-center gap-1.5">
      <span
        className={`shrink-0 text-[9px] font-bold px-1.5 py-0.5 rounded border font-mono ${METHOD_BADGE[method]}`}
      >
        {method}
      </span>
      <code className="flex-1 text-[10px] font-mono text-text-muted bg-surface/80 px-2 py-1 rounded truncate">
        {path}
      </code>
      <CopyButton
        text={fullUrl}
        id={`systemone_${method}_${path}`}
        label={copyLabel}
        copied={copied}
        copy={copy}
      />
    </div>
  );
}

export default function SystemOneEndpointsSection({ baseUrl }: Readonly<{ baseUrl: string }>) {
  const t = useTranslations("endpoint");
  const tc = useTranslations("common");
  const { copied, copy } = useCopyToClipboard();
  const [models, setModels] = useState<SystemOneModel[] | null>(null);
  const [modelsFailed, setModelsFailed] = useState(false);
  const [openRouterConnected, setOpenRouterConnected] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;

    const loadModels = async () => {
      try {
        const res = await fetch(SYSTEMONE_MODELS_PATH);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!cancelled) setModels(Array.isArray(data?.data) ? data.data : []);
      } catch {
        if (!cancelled) setModelsFailed(true);
      }
    };

    const loadConnection = async () => {
      try {
        const res = await fetch("/api/providers?provider=openrouter");
        if (!res.ok) return;
        const data = await res.json();
        const connections: ConnectionSummary[] = Array.isArray(data?.connections)
          ? data.connections
          : [];
        if (!cancelled) setOpenRouterConnected(connections.some((c) => c.isActive !== false));
      } catch {
        // Status hint only; the static requirement text stays visible.
      }
    };

    void loadModels();
    void loadConnection();
    return () => {
      cancelled = true;
    };
  }, []);

  const copyLabel = t("copyUrl");
  const exampleCurl = [
    `curl -X POST ${baseUrl.replace(/\/v1$/, "")}${SYSTEMONE_DECIDE_PATH} \\`,
    `  -H "Authorization: Bearer $OMNIROUTE_API_KEY" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '${EXAMPLE_BODY}'`,
  ].join("\n");

  return (
    <section className="mb-5" aria-labelledby="systemone-endpoints-heading">
      <div className="flex items-center gap-2 mb-3">
        <span className="material-symbols-outlined text-sm text-pink-400" aria-hidden="true">
          fact_check
        </span>
        <h3
          id="systemone-endpoints-heading"
          className="text-xs font-semibold text-text-muted uppercase tracking-wider"
        >
          {t("categorySystemOne")}
        </h3>
        <div className="flex-1 h-px bg-border/50" />
      </div>
      <p className="text-xs text-text-muted mb-3 max-w-3xl">{t("systemOneIntro")}</p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        {/* POST /v1/systemone */}
        <div className="border border-border rounded-lg p-3 hover:bg-surface/30 transition-colors flex flex-col gap-2">
          <div className="flex items-start gap-2.5">
            <div className="flex items-center justify-center size-8 rounded-lg bg-pink-500/10 shrink-0">
              <span
                className="material-symbols-outlined text-base text-pink-500"
                aria-hidden="true"
              >
                fact_check
              </span>
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="font-semibold text-xs leading-tight">{t("systemOneDecide")}</span>
                <span className="text-[9px] px-1.5 py-0.5 rounded-full border border-border/60 text-text-muted font-medium uppercase tracking-wider leading-none">
                  OpenRouter
                </span>
              </div>
              <span className="text-xs text-text-muted mt-0.5 block">
                {t("systemOneDecideDesc")}
              </span>
            </div>
          </div>
          <EndpointRow
            method="POST"
            path={SYSTEMONE_DECIDE_PATH}
            baseUrl={baseUrl}
            copied={copied}
            copy={copy}
            copyLabel={copyLabel}
          />
          <div className="flex items-center gap-1.5 text-[11px]" role="status">
            {openRouterConnected ? (
              <>
                <span
                  className="material-symbols-outlined text-[14px] text-green-500"
                  aria-hidden="true"
                >
                  check_circle
                </span>
                <span className="text-green-500">{t("systemOneConnected")}</span>
              </>
            ) : (
              <>
                <span
                  className={`material-symbols-outlined text-[14px] ${openRouterConnected === false ? "text-amber-500" : "text-text-muted"}`}
                  aria-hidden="true"
                >
                  info
                </span>
                <span
                  className={openRouterConnected === false ? "text-amber-500" : "text-text-muted"}
                >
                  {t("systemOneNeedsConnection")}
                </span>
                {openRouterConnected === false && (
                  <Link
                    href={OPENROUTER_PROVIDER_PAGE}
                    className="ml-auto text-action font-medium hover:underline"
                  >
                    {t("systemOneConnect")}
                  </Link>
                )}
              </>
            )}
          </div>
          <details className="group text-[11px]">
            <summary className="cursor-pointer select-none text-text-muted hover:text-text-main flex items-center gap-1">
              <span
                className="material-symbols-outlined text-[14px] transition-transform group-open:rotate-90"
                aria-hidden="true"
              >
                chevron_right
              </span>
              {t("systemOneExample")}
            </summary>
            <div className="mt-2 flex flex-col gap-1.5">
              <div className="relative">
                <pre className="text-[10px] font-mono bg-surface/80 rounded p-2 pr-8 overflow-x-auto whitespace-pre">
                  {exampleCurl}
                </pre>
                <div className="absolute top-1 right-1">
                  <CopyButton
                    text={exampleCurl}
                    id="systemone_example"
                    label={tc("copy")}
                    copied={copied}
                    copy={copy}
                  />
                </div>
              </div>
              <pre className="text-[10px] font-mono text-text-muted bg-surface/50 rounded p-2 overflow-x-auto whitespace-pre">
                {EXAMPLE_RESPONSE}
              </pre>
            </div>
          </details>
        </div>

        {/* GET /v1/systemone/models */}
        <div className="border border-border rounded-lg p-3 hover:bg-surface/30 transition-colors flex flex-col gap-2">
          <div className="flex items-start gap-2.5">
            <div className="flex items-center justify-center size-8 rounded-lg bg-teal-500/10 shrink-0">
              <span
                className="material-symbols-outlined text-base text-teal-500"
                aria-hidden="true"
              >
                list
              </span>
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="font-semibold text-xs leading-tight">{t("systemOneModels")}</span>
                <span className="text-xs text-text-muted">
                  {models ? t("modelsCount", { count: models.length }) : modelsFailed ? "—" : "..."}
                </span>
              </div>
              <span className="text-xs text-text-muted mt-0.5 block">
                {t("systemOneModelsDesc")}
              </span>
            </div>
          </div>
          <EndpointRow
            method="GET"
            path={SYSTEMONE_MODELS_PATH}
            baseUrl={baseUrl}
            copied={copied}
            copy={copy}
            copyLabel={copyLabel}
          />
          {modelsFailed ? (
            <p className="text-[11px] text-text-muted" role="status">
              {t("systemOneModelsUnavailable")}
            </p>
          ) : models && models.length > 0 ? (
            <details className="group text-[11px]">
              <summary className="cursor-pointer select-none text-text-muted hover:text-text-main flex items-center gap-1">
                <span
                  className="material-symbols-outlined text-[14px] transition-transform group-open:rotate-90"
                  aria-hidden="true"
                >
                  chevron_right
                </span>
                {t("systemOneModelsAndPricing")}
              </summary>
              <ul className="mt-2 flex flex-col gap-0.5 max-h-64 overflow-y-auto">
                {models.map((m) => {
                  const price = formatPerMillion(m.pricing?.prompt);
                  return (
                    <li
                      key={m.id}
                      className="flex items-center gap-2 px-2 py-1 rounded hover:bg-surface/60"
                    >
                      <div className="flex-1 min-w-0">
                        <code className="block text-[11px] font-mono truncate">{m.id}</code>
                        {m.name && (
                          <span className="block text-[10px] text-text-muted truncate">
                            {m.name}
                          </span>
                        )}
                      </div>
                      {price !== null && (
                        <span className="shrink-0 text-[10px] text-text-muted tabular-nums">
                          {price === "0" ? tc("free") : t("systemOnePricePerMillion", { price })}
                        </span>
                      )}
                      <CopyButton
                        text={m.id}
                        id={`systemone_model_${m.id}`}
                        label={tc("copy")}
                        copied={copied}
                        copy={copy}
                      />
                    </li>
                  );
                })}
              </ul>
            </details>
          ) : null}
        </div>
      </div>
    </section>
  );
}
