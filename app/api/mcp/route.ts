import { createMcpHandler } from "mcp-handler";
import { z } from "zod";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error("Missing Supabase environment variables");
}

const DEFAULTS = {
  recentScenes: 5,
  semanticMatches: 8,
  threshold: 0.2,
  perType: 2,
};

const BASE_HEADERS = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
};

// Helper to call Supabase Edge Functions with timeout
async function callEdgeFunction(functionName: string, payload: unknown) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000); // 30s timeout

  try {
    console.log("[MCP] Calling:", functionName);
    const url = `${SUPABASE_URL}/functions/v1/${functionName}`;

    const response = await fetch(url, {
      method: "POST",
      headers: BASE_HEADERS,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Edge function ${functionName} failed (${response.status}): ${text.slice(0, 500)}`
      ); // limit error text
    }

    const json = await response.json();
    return json;
  } finally {
    clearTimeout(timeout);
  }
}

const handler = createMcpHandler(
  (server) => {
    server.tool(
      "get_scene_context",
      "Retrieve full continuity context before writing a scene. Returns world state, active threads, recent scenes, relationships, knowledge, knowledge boundaries, and semantic matches. Call this when the player provides a Start Block.",
      {
        scene_id: z.string().describe("Scene ID in format S3E4-ACT01-SC01"),
        characters_present: z.array(z.string())
          .min(1, "characters_present cannot be empty")
          .describe("Characters in the scene"),
        location: z.string().optional().describe("Scene location"),
        query: z.string().optional().describe("Optional focus query for semantic search"),
        recent_scene_limit: z.number().optional().describe("How many recent scenes to retrieve"),
        semantic_match_count: z.number().optional().describe("How many semantic matches"),
        semantic_match_threshold: z.number().optional().describe("Similarity threshold 0-1"),
        semantic_per_type_limit: z.number().optional().describe("Max matches per type"),
      },
      async (params) => {
        const result = await callEdgeFunction("get-scene-context-v2", {
          scene_id: params.scene_id,
          characters_present: params.characters_present,
          location: params.location ?? "",
          query: params.query ?? null,
          recent_scene_limit: params.recent_scene_limit ?? DEFAULTS.recentScenes,
          semantic_match_count: params.semantic_match_count ?? DEFAULTS.semanticMatches,
          semantic_match_threshold: params.semantic_match_threshold ?? DEFAULTS.threshold,
          semantic_per_type_limit: params.semantic_per_type_limit ?? DEFAULTS.perType,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2).slice(0, 5000), // truncate long payloads for MCP
            },
          ],
        };
      }
    );

    server.tool(
      "save_scene_bundle",
      "Save all durable consequences after a completed act. Call this when the player says end of act. Sends scene data and all memory layers in one coordinated write. The function enforces correct order internally. If scene save fails, all remaining writes are skipped.",
      {
        scene: z.object({
          scene_id: z.string().describe("Scene ID in format S3E4-ACT01-SC01"),
          summary: z.string().describe("Brief summary of what happened"),
          location: z.string().optional(),
          characters_present: z.array(z.string()).optional(),
          major_events: z.string().optional(),
          knowledge_changes: z.string().optional(),
          relationship_changes: z.string().optional(),
          world_changes: z.string().optional(),
          divergence_notes: z.string().optional(),
          full_text: z.string().optional().describe("Full scene prose text"),
        }).describe("Scene data — always required"),

        turns: z.array(z.object({
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
        })).optional().describe("Meaningful beat-level turns only"),

        knowledge: z.array(z.object({
          fact: z.string(),
          fact_id: z.string().optional(),
          known_by: z.array(z.string()).optional(),
          visibility: z.string().optional(),
          introduced_in_scene: z.string().optional(),
          relevant_characters: z.array(z.string()).optional(),
          topic_tags: z.array(z.string()).optional(),
          importance: z.string().optional(),
          notes: z.string().optional(),
        })).optional().describe("New durable facts only"),

        boundaries: z.array(z.object({
          fact_id: z.string(),
          character: z.string(),
          knowledge_level: z.string(),
          source: z.string().optional(),
          introduced_in_scene: z.string().optional(),
          can_act_on_it: z.boolean().optional(),
          notes: z.string().optional(),
        })).optional().describe("Who learned what — after knowledge"),

        relationships: z.array(z.object({
          character_a: z.string(),
          character_b: z.string(),
          relationship_type: z.string().optional(),
          current_status: z.string().optional(),
          relationship_phase: z.string().optional(),
          relationship_axis: z.array(z.string()).optional(),
          notes: z.string().optional(),
        })).optional().describe("Only if durable baseline shifted"),

        threads: z.array(z.object({
          thread: z.string(),
          status: z.string().optional(),
          priority: z.string().optional(),
          involved_characters: z.array(z.string()).optional(),
          topic_tags: z.array(z.string()).optional(),
          notes: z.string().optional(),
          thread_scope: z.string().optional(),
          resolution_condition: z.string().optional(),
        })).optional().describe("Only if narrative pressure changed"),

        world_state: z.object({
          location: z.string().optional(),
          tension_level: z.string().optional(),
          active_factions: z.array(z.string()).optional(),
          artifacts: z.array(z.string()).optional(),
          notes: z.string().optional(),
        }).optional().describe("Only if ambient reality changed — rare"),

        divergence: z.object({
          canon_baseline: z.string(),
          new_divergence: z.string(),
          immediate_consequence: z.string().optional(),
          long_term_risk: z.string().optional(),
          status: z.string().optional(),
          affected_characters: z.array(z.string()).optional(),
          affected_threads: z.array(z.string()).optional(),
          severity: z.string().optional(),
          notes: z.string().optional(),
        }).optional().describe("Only if canon branched — rare"),
      },
      async (params) => {
        const result = await callEdgeFunction("sync-scene-bundle", params);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2).slice(0, 5000), // truncate large response
            },
          ],
        };
      }
    );
  }
);

export { handler as GET, handler as POST, handler as DELETE };
