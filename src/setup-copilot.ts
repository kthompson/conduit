import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface CopilotModel {
  id: string;
  displayName: string | undefined;
  contextWindow: number | undefined;
  maxOutputTokens: number | undefined;
  efforts: string[] | undefined;
}

export interface SetupOptions {
  dbPath?: string;
  baseUrl: string;
  providerName?: string;
  models: CopilotModel[];
  write: boolean;
  efforts: boolean;
}

/** The levels Copilot's SDK defines (`ReasoningEffort`). Anything else would be unknown to its model form. */
const COPILOT_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

export function copilotEfforts(efforts: readonly string[] | undefined): string[] {
  return COPILOT_EFFORTS.filter((e) => efforts?.includes(e));
}

export const defaultCopilotDb = path.join(homedir(), ".copilot", "data.db");

/** Max prompt tokens is what is left of the context window after reserving the output. */
export function promptBudget(
  m: Pick<CopilotModel, "contextWindow" | "maxOutputTokens">,
): number | null {
  if (!m.contextWindow) return null;
  return Math.max(1, m.contextWindow - (m.maxOutputTokens ?? 0));
}

export function setupCopilot(opts: SetupOptions): string[] {
  const dbPath = opts.dbPath ?? defaultCopilotDb;
  if (!existsSync(dbPath))
    throw new Error(`Copilot Desktop database not found at ${dbPath}. Launch the app once first.`);
  const name = opts.providerName ?? "Conduit";
  const lines: string[] = [];
  const db = new DatabaseSync(dbPath, { readOnly: !opts.write });
  try {
    const existing = db
      .prepare("SELECT id, settings_json FROM model_providers WHERE type = 'custom' AND name = ?")
      .get(name) as { id: string; settings_json: string } | undefined;
    const settings = JSON.stringify({
      baseUrl: opts.baseUrl,
      wireApi: "completions",
      authKind: "none",
      headersJson: "{}",
    });
    const providerId = existing?.id ?? randomUUID();
    lines.push(`${existing ? "update" : "create"} provider "${name}" -> ${opts.baseUrl}`);

    if (opts.write) {
      const backup = `${dbPath}.conduit-backup-${Date.now()}`;
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      copyFileSync(dbPath, backup);
      lines.push(`backup: ${backup}`);
      db.exec("BEGIN IMMEDIATE");
      if (existing) {
        db.prepare("UPDATE model_providers SET settings_json = ?, updated_at = ? WHERE id = ?").run(
          settings,
          now(),
          providerId,
        );
      } else {
        db.prepare(
          "INSERT INTO model_providers (id, name, type, settings_json) VALUES (?, ?, 'custom', ?)",
        ).run(providerId, name, settings);
      }
    }
    for (const m of opts.models) {
      const prompt = promptBudget(m);
      const supported = opts.efforts ? copilotEfforts(m.efforts) : [];
      const efforts = supported.length > 0 ? JSON.stringify(supported) : null;
      lines.push(
        `model ${m.id}: prompt=${prompt ?? "-"} output=${m.maxOutputTokens ?? "-"} efforts=${efforts ?? "(unchanged)"}`,
      );
      if (!opts.write) continue;
      db.prepare(
        `INSERT INTO provider_models (id, provider_id, model_id, display_name, max_prompt_tokens, max_output_tokens, supported_reasoning_efforts)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (provider_id, model_id) DO UPDATE SET
           max_prompt_tokens = excluded.max_prompt_tokens,
           max_output_tokens = excluded.max_output_tokens,
           supported_reasoning_efforts = COALESCE(excluded.supported_reasoning_efforts, supported_reasoning_efforts),
           updated_at = ?`,
      ).run(
        randomUUID(),
        providerId,
        m.id,
        m.displayName ?? m.id,
        prompt,
        m.maxOutputTokens ?? null,
        efforts,
        now(),
      );
    }
    if (opts.write) db.exec("COMMIT");
  } catch (error) {
    if (opts.write) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // no open transaction
      }
    }
    throw error;
  } finally {
    db.close();
  }
  lines.push(
    opts.write
      ? "written. Restart Copilot Desktop to pick up the changes."
      : "dry run; re-run with --write to apply.",
  );
  return lines;
}

function now(): string {
  return new Date().toISOString();
}
