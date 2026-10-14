// A team's shared context, moved out of server/index.ts's inline routes
// into the route table (server/routes/README.md): the brief a person owns
// (/api/section-context) and the team memory bots propose and people
// curate (/api/team-memory). Both take the section as a query parameter,
// required even for General (""). The table runs after the auth gate;
// scope rules stay keyed by path in server/request-auth.ts.
import { z } from "zod";

import { SECTION_CONTEXT_MAX_BYTES, readSectionContext, sectionContextKey, sectionContextLabel, writeSectionContext } from "../section-context.ts";
import { sectionKey, type Store } from "../store.ts";
import { TEAM_MEMORY_KINDS, TeamMemory, TeamMemoryConflict, type TeamMemoryKind } from "../team-memory.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface TeamContextRouteDeps {
  store: Pick<Store, "sections" | "bots" | "groups">;
  teamMemory: Pick<TeamMemory, "list" | "propose" | "resolve" | "update" | "remove" | "promptSelection">;
}

export function createTeamContextRoutes(deps: TeamContextRouteDeps): RouteHandler {
  const { store, teamMemory } = deps;
  return async ({ req, res, url, path, method, json, readBody }) => {
    /** scratch for route matches, shared by every `path.match` below */
    let m: RegExpMatchArray | null = null;
    // ── section context: a user-owned team brief ────────────────────────
    // Bots receive this in their system context, but no agent tool can write
    // it. That keeps one bot from silently changing every teammate's future
    // turns. The section query parameter is required even for General (""),
    // so a malformed client cannot accidentally read or replace that brief.
    // ── team memory: the section's shared people, places, decisions, terms ──
    // The person's view and their edits. Same section rule as the brief:
    // the query parameter is required even for General.
    if (path === "/api/team-memory" && (method === "GET" || method === "POST")) {
      if (!url.searchParams.has("section")) return json(res, 400, { error: "section is required" });
      const section = sectionContextKey(url.searchParams.get("section") ?? "");
      if (section && !store.sections.includes(section)) return json(res, 404, { error: "No such team" });
      if (section.length > 60) return json(res, 400, { error: "section must be at most 60 characters" });
      if (method === "GET") {
        return json(res, 200, { section, label: sectionContextLabel(section), entries: teamMemory.list(section), loadedIds: teamMemory.promptSelection(section).loadedIds });
      }
      const body = await readBody(req);
      if (!body || typeof body !== "object" || !(TEAM_MEMORY_KINDS as readonly string[]).includes(String(body.kind))) {
        return json(res, 400, { error: `kind must be one of ${TEAM_MEMORY_KINDS.join(", ")}` });
      }
      try {
        const input = TeamMemory.normalize({ kind: body.kind as TeamMemoryKind, name: String(body.name ?? ""), detail: String(body.detail ?? ""), aliases: Array.isArray(body.aliases) ? body.aliases.map(String) : undefined, key: typeof body.key === "string" ? body.key : undefined });
        if (teamMemory.list(section).some(entry => entry.status === "accepted" && entry.key === input.key)) return json(res, 409, { error: "This fact already exists. Edit its current revision instead of adding a replacement." });
        const proposed = teamMemory.propose(
          section,
          input,
          { botId: "", botName: "you", threadId: "", at: Date.now() },
        );
        // the person's own entry never waits on the person
        if (proposed.status === "proposed") teamMemory.resolve(section, proposed.entry.id, "accept");
        return json(res, 201, { entries: teamMemory.list(section) });
      } catch (error) {
        return json(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    m = path.match(/^\/api\/team-memory\/([\w-]+)$/);
    if (m && (method === "PATCH" || method === "DELETE")) {
      if (!url.searchParams.has("section")) return json(res, 400, { error: "section is required" });
      const section = sectionContextKey(url.searchParams.get("section") ?? "");
      const body = method === "DELETE" ? { expectedRevision: url.searchParams.get("revision") } : await readBody(req);
      if (!body || typeof body.expectedRevision !== "string" || !body.expectedRevision) return json(res, 428, { error: "Reload this memory and send its expectedRevision." });
      try {
        if (method === "DELETE") {
          if (!teamMemory.remove(section, m[1], body.expectedRevision)) return json(res, 404, { error: "no such entry" });
        } else if (body.accept === true) {
          if (!teamMemory.resolve(section, m[1], "accept", body.expectedRevision).claimed) return json(res, 404, { error: "no such entry" });
        } else {
          const parsed = z.object({ name: z.string().optional(), detail: z.string().optional(), aliases: z.array(z.string()).optional(),
            kind: z.enum(TEAM_MEMORY_KINDS).optional(), pinned: z.boolean().optional(), key: z.string().optional() }).safeParse(body);
          if (!parsed.success) return json(res, 400, { error: "Invalid memory edit" });
          if (!teamMemory.update(section, m[1], parsed.data, body.expectedRevision)) return json(res, 404, { error: "no such entry" });
        }
        return json(res, 200, { entries: teamMemory.list(section), loadedIds: teamMemory.promptSelection(section).loadedIds });
      } catch (error) {
        return json(res, error instanceof TeamMemoryConflict ? 409 : 400, { error: error instanceof Error ? error.message : String(error) });
      }
    }

    if (path === "/api/section-context" && (method === "GET" || method === "PUT")) {
      if (!url.searchParams.has("section")) return json(res, 400, { error: "section is required" });
      const requested = url.searchParams.get("section") ?? "";
      const section = sectionContextKey(requested);
      if (section.length > 60) return json(res, 400, { error: "section must be at most 60 characters" });
      const exists =
        section === "" ||
        store.sections.includes(section) ||
        store.bots.some((bot) => !bot.hidden && sectionKey(bot.section) === section) ||
        store.groups.some((group) => sectionKey(group.section) === section);
      if (!exists) return json(res, 404, { error: "no such team" });

      if (method === "GET") {
        const context = readSectionContext(section);
        return json(res, 200, {
          section,
          label: sectionContextLabel(section),
          text: context?.text ?? "",
          updatedAt: context?.updatedAt ?? null,
          maxBytes: SECTION_CONTEXT_MAX_BYTES,
        });
      }

      const parsed = z.object({ text: z.string() }).safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "text must be a string" });
      if (Buffer.byteLength(parsed.data.text, "utf8") > SECTION_CONTEXT_MAX_BYTES) {
        return json(res, 400, { error: `section context is capped at ${SECTION_CONTEXT_MAX_BYTES / 1000}KB` });
      }
      const context = writeSectionContext(section, parsed.data.text);
      return json(res, 200, {
        ok: true,
        section,
        label: sectionContextLabel(section),
        text: context?.text ?? "",
        updatedAt: context?.updatedAt ?? null,
        maxBytes: SECTION_CONTEXT_MAX_BYTES,
      });
    }
    return PASS;
  };
}
