// WP-126: the skills page says, per CLI, what will load and what will not travel.

import type { ReactNode } from "react";
import {
  CLI_LABEL,
  PARITY_CLIS,
  hiddenFromSentence,
  type FoundMcp,
  type FoundRule,
  type FoundSkill,
  type ParityCli,
  type ParityReport,
} from "../model/cliParity";

export function CliParityPanel({
  report,
  notice,
  onRetry,
}: {
  report: ParityReport | null;
  notice: string | null;
  onRetry?: () => void;
}): ReactNode {
  return (
    <section
      data-cli-parity
      aria-label="What each CLI loads"
      className="mb-8 rounded-md border border-content/10 px-3 py-3"
    >
      <h2 className="text-[13px] font-medium text-content">What each CLI loads</h2>
      {report == null ? (
        <div className="mt-2">
          <p className="text-[12px] text-content/55" data-cli-parity-notice>
            {notice ?? "Reading this project."}
          </p>
          {notice && onRetry ? (
            <button
              type="button"
              onClick={onRetry}
              className="mt-2 text-[12px] text-content/70 underline"
            >
              Try again
            </button>
          ) : null}
        </div>
      ) : (
        <div className="mt-3 grid gap-4">
          {PARITY_CLIS.map((cli) => (
            <CliBlock key={cli} cli={cli} report={report} />
          ))}
        </div>
      )}
    </section>
  );
}

function CliBlock({ cli, report }: { cli: ParityCli; report: ParityReport }): ReactNode {
  const skills = report.skills.filter((skill) => skill.readers.includes(cli));
  const servers = report.mcp.filter((server) => server.cli === cli);
  const rules = report.rules.filter((rule) => rule.readers.includes(cli));
  return (
    <div data-cli={cli}>
      <h3 className="text-[12px] font-medium text-content">{CLI_LABEL[cli]}</h3>
      <Group label="Skills">
        {skills.length === 0 ? <None /> : skills.map((skill) => <SkillLine key={`${skill.name}:${skill.path}`} skill={skill} report={report} />)}
      </Group>
      <Group label="MCP servers">
        {servers.length === 0 ? <None /> : servers.map((server) => <ServerLine key={`${server.name}:${server.scope}:${server.path}`} server={server} />)}
      </Group>
      <Group label="Rule files">
        {rules.length === 0 ? <None /> : rules.map((rule) => <RuleLine key={`${rule.path}:${rule.pointer}`} rule={rule} />)}
      </Group>
    </div>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <div className="mt-2">
      <h4 className="text-[11px] text-content/45">{label}</h4>
      <div className="mt-1 grid gap-1">{children}</div>
    </div>
  );
}

function None(): ReactNode {
  return <p className="text-[12px] text-content/45">None.</p>;
}

function SkillLine({ skill, report }: { skill: FoundSkill; report: ParityReport }): ReactNode {
  const warning = hiddenFromSentence(report, skill.name);
  return (
    <p className="text-[12px] text-content">
      {skill.name}, {skill.scope === "project" ? "in this project" : "in your home folder"}
      <span className="block text-content/45">{skill.path}</span>
      {warning ? <span className="block text-content/70">{warning}</span> : null}
    </p>
  );
}

function ServerLine({ server }: { server: FoundMcp }): ReactNode {
  const where = server.scope === "user" ? "in your home folder" : server.scope === "local" ? "for this project only" : "in this project";
  return (
    <p className="text-[12px] text-content">
      {server.name}, {where}
      <span className="block text-content/45">{server.path}</span>
    </p>
  );
}

function RuleLine({ rule }: { rule: FoundRule }): ReactNode {
  return (
    <p className="text-[12px] text-content">
      {rule.pointer ? `${rule.path} points at AGENTS.md.` : rule.path}
    </p>
  );
}
