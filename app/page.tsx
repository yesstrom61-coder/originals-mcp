export default function Home() {
  return <div>Originals Story Engine MCP Server</div>
}
```

**Your final repo structure should be:**
```
originals-mcp/
├── app/
│   ├── api/
│   │   └── [transport]/
│   │       └── route.ts       ← the MCP server
│   ├── layout.tsx
│   └── page.tsx
├── package.json
├── tsconfig.json
├── next.config.mjs
└── README.md
