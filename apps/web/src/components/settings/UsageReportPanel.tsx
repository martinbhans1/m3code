import type {
  ServerUsageReportAccount,
  ServerUsageReportPeriod,
  ServerUsageReportResult,
} from "@t3tools/contracts";
import { DownloadIcon, GaugeIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { useUsageReport } from "../../lib/usageReportState";
import { downloadTextFile } from "../../lib/downloadTextFile";
import { Button } from "../ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "../ui/table";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

const PERCENT_FORMAT = new Intl.NumberFormat(undefined, {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

const formatPercent = (value: number): string => `${PERCENT_FORMAT.format(value)}%`;

const formatMoment = (iso: string | null): string => {
  if (!iso) return "unknown";
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? iso : DATE_FORMAT.format(parsed);
};

interface RolledRow {
  readonly key: string;
  readonly label: string;
  readonly percent: number;
}

const rollUp = (
  period: ServerUsageReportPeriod,
  by: "project" | "model",
): ReadonlyArray<RolledRow> => {
  const rows = new Map<string, RolledRow>();
  for (const allocation of period.allocations) {
    const key =
      by === "project"
        ? (allocation.projectId ?? "(no project)")
        : (allocation.model ?? "(unknown model)");
    const label =
      by === "project"
        ? (allocation.projectTitle ?? "Outside any project")
        : (allocation.model ?? "Unknown model");
    const existing = rows.get(key);
    rows.set(key, {
      key,
      label,
      percent: (existing?.percent ?? 0) + allocation.percent,
    });
  }
  return [...rows.values()].sort((left, right) => right.percent - left.percent);
};

/**
 * The report's grain, one row per project/model/period — what a spreadsheet
 * wants, rather than the rolled-up view the screen shows.
 */
const toCsv = (report: ServerUsageReportResult): string => {
  const escape = (value: string): string =>
    /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
  const lines = [
    [
      "account",
      "plan",
      "window",
      "period_resets_at",
      "project",
      "model",
      "percent_of_window",
      "billable_tokens",
    ].join(","),
  ];

  for (const account of report.accounts) {
    for (const period of account.periods) {
      for (const allocation of period.allocations) {
        lines.push(
          [
            account.instanceId,
            account.planLabel ?? "",
            account.windowLabel,
            period.resetsAt ?? "",
            allocation.projectTitle ?? "",
            allocation.model ?? "",
            allocation.percent.toFixed(4),
            String(Math.round(allocation.tokens)),
          ]
            .map(escape)
            .join(","),
        );
      }
      // The two lines that make the column add up to what the provider says.
      lines.push(
        [
          account.instanceId,
          account.planLabel ?? "",
          account.windowLabel,
          period.resetsAt ?? "",
          "(used outside this app)",
          "",
          period.elsewherePercent.toFixed(4),
          "0",
        ]
          .map(escape)
          .join(","),
      );
      lines.push(
        [
          account.instanceId,
          account.planLabel ?? "",
          account.windowLabel,
          period.resetsAt ?? "",
          "(already used when recording started)",
          "",
          period.openingPercent.toFixed(4),
          "0",
        ]
          .map(escape)
          .join(","),
      );
    }
  }

  return `${lines.join("\n")}\n`;
};

function PeriodTable({
  period,
  groupBy,
}: {
  period: ServerUsageReportPeriod;
  groupBy: "project" | "model";
}) {
  const rows = useMemo(() => rollUp(period, groupBy), [period, groupBy]);

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{groupBy === "project" ? "Project" : "Model"}</TableHead>
          <TableHead className="text-right">Share of the allowance</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.key}>
            <TableCell>{row.label}</TableCell>
            <TableCell className="text-right tabular-nums">{formatPercent(row.percent)}</TableCell>
          </TableRow>
        ))}
        {period.elsewherePercent > 0 ? (
          <TableRow>
            <TableCell className="text-muted-foreground">
              Used outside this app
              <span className="block text-xs">
                another editor, the provider&apos;s own app, or someone else on the same plan
              </span>
            </TableCell>
            <TableCell className="text-right tabular-nums text-muted-foreground">
              {formatPercent(period.elsewherePercent)}
            </TableCell>
          </TableRow>
        ) : null}
        {period.openingPercent > 0 ? (
          <TableRow>
            <TableCell className="text-muted-foreground">
              Already used when recording started
            </TableCell>
            <TableCell className="text-right tabular-nums text-muted-foreground">
              {formatPercent(period.openingPercent)}
            </TableCell>
          </TableRow>
        ) : null}
      </TableBody>
      <TableFooter>
        <TableRow>
          <TableCell>Allowance used so far</TableCell>
          <TableCell className="text-right tabular-nums">
            {formatPercent(period.closingPercent)}
          </TableCell>
        </TableRow>
      </TableFooter>
    </Table>
  );
}

function AccountReport({ account }: { account: ServerUsageReportAccount }) {
  const [periodIndex, setPeriodIndex] = useState(0);
  const [groupBy, setGroupBy] = useState<"project" | "model">("project");
  const period = account.periods[periodIndex];

  if (!period) {
    return (
      <p className="p-4 text-sm text-muted-foreground">
        Nothing recorded for this account yet. Readings arrive as work runs against it.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm">
          <span className="font-medium">{account.windowLabel} allowance</span>
          <span className="text-muted-foreground">
            {account.planLabel ? ` on ${account.planLabel}` : ""}
            {period.resetsAt ? ` — resets ${formatMoment(period.resetsAt)}` : ""}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant={groupBy === "project" ? "secondary" : "ghost"}
            onClick={() => setGroupBy("project")}
          >
            By project
          </Button>
          <Button
            size="sm"
            variant={groupBy === "model" ? "secondary" : "ghost"}
            onClick={() => setGroupBy("model")}
          >
            By model
          </Button>
        </div>
      </div>

      <PeriodTable period={period} groupBy={groupBy} />

      {account.periods.length > 1 ? (
        <div className="flex flex-wrap items-center gap-1">
          <span className="mr-1 text-xs text-muted-foreground">Earlier periods:</span>
          {account.periods.map((candidate, index) => (
            <Button
              key={candidate.resetsAt ?? String(index)}
              size="sm"
              variant={index === periodIndex ? "secondary" : "ghost"}
              onClick={() => setPeriodIndex(index)}
            >
              {index === 0 ? "Now" : formatMoment(candidate.resetsAt)}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function UsageReportPanel() {
  const { data, error, isPending, refresh } = useUsageReport("");

  const handleExport = useCallback(() => {
    if (!data) return;
    downloadTextFile("plan-usage.csv", toCsv(data), "text/csv;charset=utf-8");
  }, [data]);

  return (
    <SettingsPageContainer>
      <SettingsSection
        title="Plan usage"
        icon={<GaugeIcon className="size-3.5" />}
        headerAction={
          <div className="flex items-center gap-1">
            <Button size="sm" variant="ghost" onClick={refresh} disabled={isPending}>
              <RefreshCwIcon className="size-3.5" />
            </Button>
            <Button size="sm" variant="ghost" onClick={handleExport} disabled={!data}>
              <DownloadIcon className="size-3.5" />
            </Button>
          </div>
        }
      >
        {error ? (
          <p className="p-4 text-sm text-destructive">{error}</p>
        ) : !data || data.accounts.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">
            No plan readings recorded yet. They start arriving the next time work runs against an
            account whose provider reports rate limits.
          </p>
        ) : (
          <div className="divide-y">
            {data.accounts.map((account) => (
              <div key={account.instanceId}>
                <div className="px-4 pt-4 text-sm font-medium">{account.instanceId}</div>
                <AccountReport account={account} />
              </div>
            ))}
          </div>
        )}
      </SettingsSection>

      {data?.recordingSince ? (
        <p className="px-1 text-xs text-muted-foreground">
          Recording since {formatMoment(data.recordingSince)}. Anything spent before then, or while
          this app was closed, shows as used outside the app.
        </p>
      ) : null}
    </SettingsPageContainer>
  );
}
