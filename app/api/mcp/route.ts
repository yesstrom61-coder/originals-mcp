import { createMcpHandler } from "mcp-handler";
import { z } from "zod";

const handler = createMcpHandler(
  (server) => {
    server.tool(
      "ping",
      "Test tool",
      { message: z.string() },
      async (params) => ({
        content: [{ type: "text" as const, text: `Pong: ${params.message}` }],
      })
    );
  }
);

export { handler as GET, handler as POST, handler as DELETE };
