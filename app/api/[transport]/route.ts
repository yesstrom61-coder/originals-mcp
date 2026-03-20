import { createMcpHandler } from "mcp-handler";
import { z } from "zod";

const DEFAULTS = {
  recentScenes: 5,
  semanticMatches: 8,
  threshold: 0.2,
  perType: 2,
};

async function callEdgeFunction(functionName: string, payload: unknown) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error("Missing Supabase environment variables");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    console.log("[MCP] Calling:", functionName);
    const response = await fetch(
      `${SUPABASE_URL}/functions/v1/${functionName}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      }
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Edge function ${functionName} failed (${response.status}): ${text.slice(0, 500)}`
      );
    }

    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

const handler = createMcpHandler(
  (server) => {
    server.registerTool(
      "get_scene_context",
      {
        title: "Get Scene Context",
        description:
          "Retrieve full continuity context before writing a scene. Returns world state, active threads, recent scenes, relationships, knowledge, knowledge boundaries, and semantic matches. Call this when the player provides a Start Block.",
        inputSchema: {
          scene_id: z.string().describe("Scene ID in format S3E4-ACT01-SC01"),
          characters_present: z
            .array(z.string())
            .min(1)
            .describe("Characters in the scene"),
          location: z.string().optional().describe("Scene location"),
          query: z
            .string()
            .optional()
            .describe("Optional focus query for semantic search"),
          recent_scene_limit: z.number().optional(),
          semantic_match_count: z.number().optional(),
          semantic_match_threshold: z.number().optional(),
          semantic_per_type_limit: z.number().optional(),
        },
      },
      async (params) => {
        const result = await callEdgeFunction("get-scene-context-v2", {
          scene_id: params.scene_id,
          characters_present: params.characters_present,
          location: params.location ?? "",
          query: params.query ?? null,
          recent_scene_limit:
            params.recent_scene_limit ?? DEFAULTS.recentScenes,
          semantic_match_count:
            params.semantic_match_count ?? DEFAULTS.semanticMatches,
          semantic_match_threshold:
            params.semantic_match_threshold ?? DEFAULTS.threshold,
          semantic_per_type_limit:
            params.semantic_per_type_limit ?? DEFAULTS.perType,
        });

        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
        };
      }
    );

    server.registerTool(
      "save_scene_bundle",
      {
        title: "Save Scene Bundle",
        description:
          "Save all durable consequences after a completed act. Call this when the player says end of act. Sends scene data and all memory layers in one coordinated write.",
        inputSchema: {
          scene: z.object({
            scene_id: z.string(),
            summary: z.string(),
            location: z.string().optional(),
            characters_present: z.array(z.string()).optional(),
            major_events: z.string().optional(),
            knowledge_changes: z.string().optional(),
            relationship_changes: z.string().optional(),
            world_changes: z.string().optional(),
            divergence_notes: z.string().optional(),
            full_text: z.string().optional(),
          }),
          turns: z
            .array(
              z.object({
                turn_number: z.number(),
                speaker: z.string(),
                addressee: z.string().optional(),
                turn_type: z.string(),
                content_summary: z.string(),
                emotional_tone: z.string().optional(),
                knowledge_effect: z.string().optional(),
                relationship_effect: z.string().optional(),
                thread_effect: z.string().optional(),
                notes: z.string().optional(),
              })
            )
            .optional(),
          knowledge: z
            .array(
              z.object({
                fact: z.string(),
                fact_id: z.string().optional(),
                known_by: z.array(z.string()).optional(),
                visibility: z.string().optional(),
                introduced_in_scene: z.string().optional(),
                relevant_characters: z.array(z.string()).optional(),
                topic_tags: z.array(z.string()).optional(),
                importance: z.string().optional(),
                notes: z.string().optional(),
              })
            )
            .optional(),
          boundaries: z
            .array(
              z.object({
                fact_id: z.string(),
                character: z.string(),
                knowledge_level: z.string(),
                source: z.string().optional(),
                introduced_in_scene: z.string().optional(),
                can_act_on_it: z.boolean().optional(),
                notes: z.string().optional(),
              })
            )
            .optional(),
          relationships: z
            .array(
              z.object({
                character_a: z.string(),
                character_b: z.string(),
                relationship_type: z.string().optional(),
                current_status: z.string().optional(),
                relationship_phase: z.string().optional(),
                relationship_axis: z.array(z.string()).optional(),
                notes: z.string().optional(),
              })
            )
            .optional(),
          threads: z
            .array(
              z.object({
                thread: z.string(),
                status: z.string().optional(),
                priority: z.string().optional(),
                involved_characters: z.array(z.string()).optional(),
                topic_tags: z.array(z.string()).optional(),
                notes: z.string().optional(),
                thread_scope: z.string().optional(),
                resolution_condition: z.string().optional(),
              })
            )
            .optional(),
          world_state: z
            .object({
              location: z.string().optional(),
              tension_level: z.string().optional(),
              active_factions: z.array(z.string()).optional(),
              artifacts: z.array(z.string()).optional(),
              notes: z.string().optional(),
            })
            .optional(),
          divergence: z
            .object({
              canon_baseline: z.string(),
              new_divergence: z.string(),
              immediate_consequence: z.string().optional(),
              long_term_risk: z.string().optional(),
              status: z.string().optional(),
              affected_characters: z.array(z.string()).optional(),
              affected_threads: z.array(z.string()).optional(),
              severity: z.string().optional(),
              notes: z.string().optional(),
            })
            .optional(),
        },
      },
      async (params) => {
        const payload = {
          ...params,
          turns: params.turns?.map((t: Record<string, unknown>) => ({
            ...t,
            scene_id: params.scene?.scene_id,
          })),
        };
        const result = await callEdgeFunction("sync-scene-bundle", payload);

        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
        };
      }
    );
  },
  {},
  {
    basePath: "/api",
    maxDuration: 60,
    verboseLogs: true,
  }
);

export { handler as GET, handler as POST };
