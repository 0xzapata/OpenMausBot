// Teams as files: export (manifest, backup, package v1/v2, a library of
// presets), the team library and GitHub teams, the project scout, the
// organization library, and import. Moved from server/index.ts's inline
// routes into the route table (server/routes/README.md); the table runs
// after the auth gate, scope rules stay keyed by path in
// server/request-auth.ts.
import { z } from "zod";
import { MAX_TEAM_BACKUP_BYTES } from "../../shared/team-backup.ts";
import type { BotVisibility, WireBot, WireGroup } from "../../shared/wire.ts";
import { validateBotCwd } from "../bot-cwd.ts";
import { fetchBotDirectory, matchDirectoryBots, type MatchedDirectoryBot } from "../bot-directory.ts";
import { isBotPackage, packageSummary, parsePackageDocument, renderBotPackageMarkdown, type PackageDocument } from "../bot-package.ts";
import { parseVisibility } from "../bot-visibility.ts";
import type { AppConfig } from "../config.ts";
import type { ModelSelection } from "../contracts.ts";
import type { OrgLibrary } from "../org-library.ts";
import {
  TeamExportError,
  createBotPackageExport,
  createLibraryPackageExport,
  createTeamPackageExport,
  type ExportablePackageSkill,
  type TeamExportSkip,
} from "../package-export.ts";
import {
  PackageImportError,
  importPackageDocument,
  importTeamManifest,
  type PackageImportDeps,
  type PackageImportResult,
} from "../package-import.ts";
import { readPublishedLibrary, writePublishedLibrary, type DefaultsPreset } from "../presets.ts";
import { scoutProject, suggestTeam } from "../project-scout.ts";
import { readPublishedTeam, writePublishedTeam } from "../published-teams.ts";
import type { RoutineManager } from "../routines.ts";
import { readSectionContext } from "../section-context.ts";
import { sectionKey, type BotRecord, type GroupRecord, type Store } from "../store.ts";
import { createTeamBackup, importTeamBackup } from "../team-backup.ts";
import { fetchGithubTeam, fetchLibraryTeam, fetchTeamCatalog } from "../team-library.ts";
import { createTeamManifest, parseTeamManifest } from "../team-manifest.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface TeamRouteDeps {
  /** The whole store: a backup reads and writes every record kind. */
  store: Store;
  cfg: Pick<AppConfig, "profile" | "mcpServers">;
  /** Assigned at boot, after the routes are built, so it is read per request. */
  routines(): RoutineManager | null;
  /** The organization library, when this installation has one. */
  orgLibrary(): Pick<OrgLibrary, "list" | "preview" | "add" | "offeredSkills" | "addOfferedSkill"> | null;
  broadcast(payload: Record<string, unknown>): void;
  publicBot(bot: BotRecord): WireBot;
  publicGroupState(record: GroupRecord): WireGroup;
  /** A room with its transcript page, as a create reply carries it. */
  groupWithThread(group: GroupRecord): WireGroup;
  /** The model a new bot starts on. */
  defaultSelection(): Promise<ModelSelection>;
  /** My New bot defaults as a preset a package can carry. */
  defaultsPresetFor(body: Record<string, unknown>, includeNotes: boolean): { preset: DefaultsPreset | null; skipped: TeamExportSkip[] };
  packageImportDeps(selection: ModelSelection): PackageImportDeps;
  /** A bot's memory notes, for a package that includes memory. */
  starterNotes(botId: string): Array<{ path: string; text: string }>;
  checkedExportSkillNames(value: unknown, bots: readonly BotRecord[]): { ok: true; names: string[] } | { ok: false; error: string };
  collectExportSkills(bots: readonly BotRecord[], names: readonly string[]): ReadonlyMap<string, readonly ExportablePackageSkill[]>;
  collectTeamSkills(bots: readonly BotRecord[], selection: unknown):
    | { ok: true; all: boolean; skillsByBot: Map<string, ExportablePackageSkill[]>; skipped: TeamExportSkip[]; available: string[] }
    | { ok: false; error: string; available: string[] };
}

export function createTeamRoutes(deps: TeamRouteDeps): RouteHandler {
  const {
    store, cfg, broadcast, publicBot, publicGroupState, groupWithThread, defaultSelection, defaultsPresetFor,
    packageImportDeps, starterNotes, checkedExportSkillNames, collectExportSkills, collectTeamSkills,
  } = deps;
  return async ({ req, res, url, path, method, json, readBody }) => {
    /** scratch for route matches, shared by every `path.match` below */
    let m: RegExpMatchArray | null = null;
    const routines = deps.routines();
    const orgLibrary = deps.orgLibrary();
    if (method === "POST" && path === "/api/teams/export") {
      // Pictures the Share dialog prepared ride this body, so it is larger
      // than the default JSON limit (the document itself is capped at 4 MB).
      const body = await readBody(req, 8 * 1024 * 1024);
      const profileName = cfg.profile?.name?.trim();
      if (body.format === "package" && body.version === 2 && body.kind === "library") {
        // Preset bots and their skills, no team: my New bot defaults as a
        // preset someone else picks in New bot (presets.ts has the allowlist).
        const optional = (value: unknown) => (typeof value === "string" ? value : undefined);
        const built = defaultsPresetFor(body, body.includeMemory === true);
        try {
          const exported = createLibraryPackageExport({
            name: optional(body.name),
            tagline: optional(body.tagline),
            summary: optional(body.summary),
            release: optional(body.release),
            notes: optional(body.notes),
            authorName: profileName,
            published: readPublishedLibrary(),
            preset: built.preset,
            skipped: built.skipped,
          });
          if (body.dryRun !== true) writePublishedLibrary(exported.published);
          return json(res, 200, {
            document: exported.document,
            filename: exported.filename,
            redacted: exported.redacted,
            skipped: exported.skipped,
            summary: packageSummary(exported.document),
          });
        } catch (error) {
          if (error instanceof TeamExportError) return json(res, error.status, { error: error.message });
          throw error;
        }
      }
      if (body.format === "package" && body.version === 2) {
        // One team, whole, except its chat history (package format v2).
        if (typeof body.team !== "string") return json(res, 400, { error: "Choose a team to share." });
        const team = body.team.trim();
        if (team && !store.sections.includes(team) && !store.bots.some((bot) => sectionKey(bot.section) === team)) {
          return json(res, 404, { error: "That team no longer exists." });
        }
        const optional = (value: unknown) => (typeof value === "string" ? value : undefined);
        const teamBots = store.bots.filter((bot) => !bot.hidden && sectionKey(bot.section) === team);
        const skills = collectTeamSkills(teamBots, body.skills);
        if (!skills.ok) return json(res, 400, { error: skills.error, choices: { skills: skills.available } });
        const avatars = body.avatars && typeof body.avatars === "object" && !Array.isArray(body.avatars)
          ? body.avatars as Record<string, unknown>
          : undefined;
        // Off unless asked: New bot defaults are personal until shared.
        const defaults = body.includeDefaultsPreset === true ? defaultsPresetFor(body, body.includeMemory === true) : null;
        try {
          const exported = createTeamPackageExport({
            team,
            name: optional(body.name),
            tagline: optional(body.tagline),
            summary: optional(body.summary),
            release: optional(body.release),
            notes: optional(body.notes),
            authorName: profileName,
            bots: store.bots,
            groups: store.groups,
            routines: routines!.listRoutines(),
            brief: readSectionContext(team)?.text,
            published: readPublishedTeam(team),
            skillsByBot: skills.skillsByBot,
            skillSelection: skills.all ? "all" : "chosen",
            memoryByBot: body.includeMemory === true ? new Map(teamBots.map((bot) => [bot.id, starterNotes(bot.id)])) : undefined,
            avatars,
            mcpServers: cfg.mcpServers ?? {},
            skipped: [...skills.skipped, ...(defaults?.skipped ?? [])],
            preset: defaults?.preset ?? null,
          });
          // A preview (the dialog's live counts) never records keys; saving
          // the file does, so renaming anything later keeps its identity.
          if (body.dryRun !== true) writePublishedTeam(team, exported.published);
          return json(res, 200, {
            document: exported.document,
            filename: exported.filename,
            redacted: exported.redacted,
            skipped: exported.skipped,
            summary: packageSummary(exported.document),
            choices: { skills: skills.available },
          });
        } catch (error) {
          if (error instanceof TeamExportError) return json(res, error.status, { error: error.message, choices: { skills: skills.available } });
          throw error;
        }
      }
      const name =
        typeof body.name === "string" && body.name.trim()
          ? body.name.trim()
          : profileName
            ? `${profileName}'s Team`
            : "My OpenMaus Team";
      const memberIds = store.bots.filter((bot) => !bot.hidden).map((bot) => bot.id);
      if ((body.format === "backup" ? store.bots.length : memberIds.length) === 0) return json(res, 400, { error: "Create a bot before exporting your team" });
      try {
        if (body.format === "backup") {
          return json(res, 200, createTeamBackup(store, routines!.listRoutines(), name));
        }
        if (body.format === "package") {
          const selectedBots = store.bots.filter((bot) => !bot.hidden);
          const skillNames = checkedExportSkillNames(body.skillIds, selectedBots);
          if (!skillNames.ok) return json(res, 400, { error: skillNames.error });
          const document = createBotPackageExport({
            name,
            authorName: profileName,
            bots: selectedBots,
            groups: store.groups,
            routines: routines!.listRoutines(),
            skillsByBot: collectExportSkills(selectedBots, skillNames.names),
          });
          return json(res, 200, {
            name: document.package.name,
            members: document.package.agents.length,
            markdown: renderBotPackageMarkdown(document),
          });
        }
        return json(
          res,
          200,
          createTeamManifest(
            {
              name,
              memberIds,
            },
            store.bots,
          ),
        );
      } catch (error) {
        return json(res, 400, { error: error instanceof Error ? error.message : "Team could not be exported" });
      }
    }
    if (method === "GET" && path === "/api/team-library/catalog") {
      try {
        return json(res, 200, await fetchTeamCatalog());
      } catch (error) {
        return json(res, 502, { error: error instanceof Error ? error.message : "The team library is unavailable" });
      }
    }
    m = path.match(/^\/api\/team-library\/teams\/([a-z0-9][a-z0-9-]*)$/);
    if (m && method === "GET") {
      try {
        return json(res, 200, await fetchLibraryTeam(m[1]));
      } catch (error) {
        const status = (error as { status?: number }).status === 404 ? 404 : 502;
        return json(res, status, { error: error instanceof Error ? error.message : "The team could not be loaded" });
      }
    }
    if (method === "POST" && path === "/api/team-library/github") {
      const body = await readBody(req);
      if (typeof body.url !== "string" || !body.url.trim()) {
        return json(res, 400, { error: "A GitHub URL is required" });
      }
      try {
        return json(res, 200, await fetchGithubTeam(body.url));
      } catch (error) {
        const status = (error as { status?: number }).status === 404 ? 404 : 400;
        return json(res, status, { error: error instanceof Error ? error.message : "The GitHub team could not be loaded" });
      }
    }
    if (method === "GET" && path === "/api/teams/scout") {
      // The scout reads a folder and answers with a suggestion — it creates
      // nothing. Bots and the room come into being only when the human sends
      // the suggested manifest through /api/teams/import, so "the agent
      // proposes, the person imports" is enforced by the route split itself.
      // The folder is whatever validateBotCwd accepts: the same local-user
      // trust boundary as pointing any bot's working folder at a path.
      // Deliberately offline — the community directory lives on its own
      // route below, so a slow network can never delay the suggestion.
      const validated = validateBotCwd(url.searchParams.get("cwd"));
      if (!validated.ok) return json(res, 400, { error: validated.error });
      if (!validated.cwd) return json(res, 400, { error: "scout needs a folder to read" });
      const profile = scoutProject(validated.cwd);
      return json(res, 200, { profile, suggestion: suggestTeam(profile) });
    }
    if (method === "GET" && path === "/api/teams/scout/directory") {
      // Community bots that fit the scouted folder — a separate, lazy call
      // so an unreachable directory degrades to "no extra candidates", never
      // to a broken scout.
      const validated = validateBotCwd(url.searchParams.get("cwd"));
      if (!validated.ok) return json(res, 400, { error: validated.error });
      if (!validated.cwd) return json(res, 400, { error: "scout needs a folder to read" });
      let directory: MatchedDirectoryBot[] = [];
      try {
        directory = matchDirectoryBots(scoutProject(validated.cwd), await fetchBotDirectory());
      } catch (error) {
        // an unreachable directory is a fact of life, not an error — but an
        // empty section should still be diagnosable from the server log
        console.warn("bot directory lookup failed:", error instanceof Error ? error.message : String(error));
      }
      return json(res, 200, { directory });
    }
    // ── the organization library (server/org-library.ts) ─────────────────
    // Admin scope, as import is. With no organization every read answers
    // {organization: null} and nothing else changes.
    if (method === "GET" && path === "/api/org-library") {
      return json(res, 200, orgLibrary?.list() ?? { organization: null, packages: [] });
    }
    m = path.match(/^\/api\/org-library\/packages\/([a-f0-9-]{36})$/);
    if (m && method === "GET") {
      const outcome = orgLibrary?.preview(m[1]!);
      if (!outcome) return json(res, 404, { error: "This package is not in your organization's library.", code: "not_listed" });
      return outcome.ok ? json(res, 200, outcome.value) : json(res, outcome.status, { error: outcome.error, code: outcome.code });
    }
    if (method === "POST" && path === "/api/org-library/add") {
      // One click, no confirmation: the person's click is the decision.
      const body = await readBody(req);
      const packageId = typeof body?.packageId === "string" && /^[a-f0-9-]{36}$/.test(body.packageId) ? body.packageId : null;
      if (!packageId) return json(res, 400, { error: "Choose a package from your organization's library." });
      if (!orgLibrary) return json(res, 404, { error: "This package is not in your organization's library.", code: "not_listed" });
      const outcome = orgLibrary.add(packageId, packageImportDeps(await defaultSelection()));
      if (!outcome.ok) return json(res, outcome.status, { error: outcome.error, code: outcome.code });
      if (outcome.value.alreadyAdded) return json(res, 200, outcome.value);
      const imported = outcome.value.result;
      return json(res, 201, {
        alreadyAdded: false,
        installId: imported.installId,
        name: imported.name,
        section: imported.section,
        bots: imported.bots.map((bot) => publicBot(store.bot(bot.id) ?? bot)),
        groups: imported.groups.map((created) => ({ ...publicGroupState(store.group(created.id) ?? created), messages: [] })),
        routines: imported.routines,
        offeredSkills: imported.offeredSkills,
        connections: imported.connections,
        skipped: imported.skipped,
        brief: imported.brief,
        notes: imported.notes,
        presets: imported.presets ?? [],
      });
    }
    if (method === "GET" && path === "/api/org-library/skills") {
      const botId = url.searchParams.get("botId") ?? undefined;
      return json(res, 200, orgLibrary?.offeredSkills(botId) ?? { organization: null, skills: [] });
    }
    if (method === "POST" && path === "/api/org-library/skills") {
      const body = await readBody(req);
      const parsed = z.object({ botId: z.string().min(1).max(128), installId: z.string().regex(/^[a-f0-9]{32}$/), name: z.string().min(1).max(64) })
        .safeParse(body);
      if (!parsed.success) return json(res, 400, { error: "Choose a bot and a skill from your organization's library." });
      if (!orgLibrary) return json(res, 404, { error: "This package is not in your organization's library.", code: "not_listed" });
      const outcome = orgLibrary.addOfferedSkill(parsed.data.botId, parsed.data.installId, parsed.data.name);
      return outcome.ok ? json(res, 201, { skill: outcome.value }) : json(res, outcome.status, { error: outcome.error, code: outcome.code });
    }
    if (method === "POST" && path === "/api/teams/import") {
      // Import is additive-only. A manifest is untrusted input (catalog,
      // GitHub, a shared file), so it must be structurally unable to reach
      // records the user already has: every member becomes a NEW bot with a
      // fresh id — a manifest cannot name, update, or merge into an existing
      // bot or room. Repeated imports create freshly numbered copies.
      const importMode = url.searchParams.get("mode") ?? "add";
      if (importMode === "replace") {
        return json(res, 400, { error: "Replacing your team is no longer supported. Reopen Import in the updated app to add bots alongside your existing conversations." });
      }
      if (importMode !== "add" && importMode !== "project") {
        return json(res, 400, { error: "Team import mode must be add or project" });
      }
      // `project` adds the team AND opens a caller-owned room on a folder.
      // Legacy team manifests remain people-only. Full bot packages may add
      // their own new rooms, but neither format can point at an existing room
      // or choose a local folder; workspace access always comes from this
      // explicit caller parameter.
      let projectCwd: string | null = null;
      if (importMode === "project") {
        const requested = url.searchParams.get("cwd");
        if (requested !== null) {
          const validated = validateBotCwd(requested);
          if (!validated.ok) return json(res, 400, { error: validated.error });
          projectCwd = validated.cwd;
        }
      }
      // Who may see the imported bots, from their first moment: the admin's
      // choice (?visibility=admins, or a JSON value), never the file's.
      const rawVisibility = url.searchParams.get("visibility");
      let importVisibility: BotVisibility | undefined;
      if (rawVisibility !== null) {
        let value: unknown = rawVisibility;
        if (rawVisibility.trim().startsWith("{")) {
          try {
            value = JSON.parse(rawVisibility);
          } catch {
            /* parseVisibility refuses the raw text with a plain sentence */
          }
        }
        const parsed = parseVisibility(value);
        if (!parsed.ok) return json(res, 400, { error: parsed.error });
        importVisibility = parsed.visibility;
      }
      const body = await readBody(req, MAX_TEAM_BACKUP_BYTES);
      if (body?.format === "openmaus.backup") {
        if (importMode !== "add") return json(res, 400, { error: "Import backups alongside your existing bots; project mode is only for templates" });
        try {
          const imported = importTeamBackup(store, routines!, body, await defaultSelection(), { visibility: importVisibility });
          // A restore writes its transcripts without store events, after the
          // store's own frames announced each bot and room, so these frames
          // are what carries the restored pages to other clients.
          const bots = imported.bots.map((bot) => publicBot(bot));
          const groups = imported.groups.map((group) => groupWithThread(group));
          for (const bot of bots) broadcast({ kind: "bot", bot });
          for (const group of groups) broadcast({ kind: "group", group });
          return json(res, 201, { ...imported, bots, groups });
        } catch (error) {
          return json(res, 400, { error: error instanceof Error ? error.message : "Backup could not be imported" });
        }
      }
      // Every package (v1 JSON, BotMRR Markdown, v2) is read by the one shared
      // parser as a FILE: it cannot claim a publisher, and its skills and
      // routines arrive off. A body field such as `trust` is just an unknown
      // field of the document and is stripped; only the organization library
      // module ever imports with trust "org".
      let packageDocument: PackageDocument | null = null;
      let manifest: ReturnType<typeof parseTeamManifest> | null = null;
      try {
        if (isBotPackage(body)) packageDocument = parsePackageDocument(body, { trust: "file" });
        else manifest = parseTeamManifest(body);
      } catch (error) {
        return json(res, 400, { error: error instanceof Error ? error.message : "Invalid bot package" });
      }
      const deps = packageImportDeps(await defaultSelection());
      const options = {
        mode: importMode as "add" | "project",
        cwd: projectCwd,
        room: url.searchParams.get("room") ?? undefined,
        ...(importVisibility ? { visibility: importVisibility } : {}),
      };
      let imported: PackageImportResult;
      try {
        const result = packageDocument
          ? importPackageDocument(packageDocument, { ...options, trust: "file" }, deps)
          : importTeamManifest(manifest!, options, deps);
        // A file import always gets a fresh install id, so it never reports
        // "already added"; that answer belongs to the organization library.
        if (result.alreadyAdded) return json(res, 200, result);
        imported = result;
      } catch (error) {
        if (error instanceof PackageImportError) return json(res, error.status, { error: error.message, code: error.code });
        throw error;
      }
      return json(res, 201, {
        name: imported.name,
        section: imported.section,
        bots: imported.bots.map((bot) => publicBot(store.bot(bot.id) ?? bot)),
        group: imported.group,
        groups: imported.groups.map((created) => ({ ...created, messages: [] })),
        routines: imported.routines,
        offeredSkills: imported.offeredSkills,
        connections: imported.connections,
        skipped: imported.skipped,
        brief: imported.brief,
        notes: imported.notes,
        presets: imported.presets ?? [],
      });
    }
    return PASS;
  };
}
