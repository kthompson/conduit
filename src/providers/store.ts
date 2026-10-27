import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { expandHome, stateDir, userConfigPath } from "../config.ts";

export const DEFAULT_PROVIDER_ID = "default";

const base = {
  id: z.string().min(1),
  name: z.string().trim().min(1, "Name is required").max(64, "Keep the name under 64 characters"),
  enabled: z.boolean().default(true),
};

/** A Claude Code login. `configDir` unset means "whatever Claude Code uses by default". */
const claudeEntry = z.object({
  ...base,
  type: z.literal("claude"),
  configDir: z.string().min(1).optional(),
});

/** Add further provider types (codex, copilot, ...) to this union. */
export const providerEntrySchema = z.discriminatedUnion("type", [claudeEntry]);
export type ProviderEntry = z.infer<typeof providerEntrySchema>;
export type ProviderType = ProviderEntry["type"];
export const providerTypes: ProviderType[] = ["claude"];

const fileSchema = z.object({
  version: z.literal(1),
  /** Priority order: earlier entries are tried first. */
  providers: z.array(providerEntrySchema),
});

/** A new or renamed provider clashes with an existing one. */
export class ProviderConflictError extends Error {
  readonly field: "name" | "configDir";

  constructor(field: "name" | "configDir", message: string) {
    super(message);
    this.field = field;
  }
}

export interface NewProvider {
  type: ProviderType;
  name: string;
  /** Claude: directory holding this login. Defaults to <config>/conduit/accounts/<slug>. */
  configDir?: string | undefined;
}

export const defaultStorePath = path.join(stateDir, "providers.json");
export const accountsDir = path.join(path.dirname(userConfigPath), "accounts");

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "provider";
}

export function defaultConfigDir(name: string): string {
  return path.join(accountsDir, slugify(name));
}

/**
 * The providers the user has configured, in priority order, persisted as JSON.
 * The implicit "default" Claude login is always present and cannot be removed.
 */
export class ProviderStore {
  private readonly file: string;
  private entries: ProviderEntry[];

  constructor(file: string = defaultStorePath) {
    this.file = file;
    this.entries = this.load();
  }

  list(): ProviderEntry[] {
    return [...this.entries];
  }

  get(id: string): ProviderEntry | undefined {
    return this.entries.find((e) => e.id === id);
  }

  /** Enabled providers in priority order. */
  enabled(): ProviderEntry[] {
    return this.entries.filter((e) => e.enabled);
  }

  add(input: NewProvider): ProviderEntry {
    const name = input.name.trim();
    if (this.entries.some((e) => e.name.toLowerCase() === name.toLowerCase())) {
      throw new ProviderConflictError("name", `A provider named "${name}" already exists`);
    }
    const id = this.uniqueId(name);
    const given = input.configDir?.trim();
    const configDir = path.resolve(
      expandHome(given !== undefined && given.length > 0 ? given : defaultConfigDir(name)),
    );
    if (this.entries.some((e) => e.type === "claude" && e.configDir === configDir)) {
      throw new ProviderConflictError("configDir", `Another provider already uses ${configDir}`);
    }
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    const entry = providerEntrySchema.parse({
      id,
      type: input.type,
      name,
      enabled: true,
      configDir,
    });
    this.entries.push(entry);
    this.save();
    return entry;
  }

  update(id: string, patch: { name?: string; enabled?: boolean }): ProviderEntry {
    const index = this.indexOf(id);
    const current = this.entries[index] as ProviderEntry;
    const name = patch.name?.trim() ?? current.name;
    if (this.entries.some((e) => e.id !== id && e.name.toLowerCase() === name.toLowerCase())) {
      throw new ProviderConflictError("name", `A provider named "${name}" already exists`);
    }
    const next = providerEntrySchema.parse({
      ...current,
      name,
      enabled: patch.enabled ?? current.enabled,
    });
    this.entries[index] = next;
    this.save();
    return next;
  }

  /** Moves a provider one step toward the front (up, higher priority) or the back (down). */
  move(id: string, direction: "up" | "down"): void {
    const index = this.indexOf(id);
    const target = direction === "up" ? index - 1 : index + 1;
    if (target < 0 || target >= this.entries.length) return;
    const moved = this.entries[index] as ProviderEntry;
    this.entries[index] = this.entries[target] as ProviderEntry;
    this.entries[target] = moved;
    this.save();
  }

  /** Removes the entry only; the login directory on disk is left alone. */
  remove(id: string): ProviderEntry {
    if (id === DEFAULT_PROVIDER_ID) throw new Error("The default provider cannot be removed");
    const index = this.indexOf(id);
    const [removed] = this.entries.splice(index, 1);
    this.save();
    return removed as ProviderEntry;
  }

  private indexOf(id: string): number {
    const index = this.entries.findIndex((e) => e.id === id);
    if (index === -1) throw new Error(`No provider with id "${id}"`);
    return index;
  }

  private uniqueId(name: string): string {
    const slug = slugify(name);
    let id = slug;
    for (let n = 2; this.entries.some((e) => e.id === id) || id === DEFAULT_PROVIDER_ID; n++) {
      id = `${slug}-${n}`;
    }
    return id;
  }

  private load(): ProviderEntry[] {
    let entries: ProviderEntry[] = [];
    if (existsSync(this.file)) {
      const parsed = fileSchema.safeParse(JSON.parse(readFileSync(this.file, "utf8")));
      if (!parsed.success) {
        throw new Error(`${this.file}: ${z.prettifyError(parsed.error)}`);
      }
      entries = parsed.data.providers;
    }
    if (!entries.some((e) => e.id === DEFAULT_PROVIDER_ID)) {
      entries.unshift({
        id: DEFAULT_PROVIDER_ID,
        type: "claude",
        name: "Default login",
        enabled: true,
      });
    }
    return entries;
  }

  private save(): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, providers: this.entries }, null, 2) + "\n", {
      mode: 0o600,
    });
    renameSync(tmp, this.file);
  }
}
