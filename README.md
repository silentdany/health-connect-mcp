# health-connect-mcp

Unofficial MCP server. Bots read **aggregates you push**. It does not log into Samsung and cannot pull Health Connect: that store stays on the phone.

## Run

```bash
npm install
INGEST_TOKEN=change-me npm start
```

`GET /health`  
`POST /ingest` with `Authorization: Bearer change-me`

```json
{
  "days": [
    {
      "date": "2026-09-23",
      "steps": 8420,
      "sleepMin": 430,
      "rhr": 53,
      "workouts": [{ "name": "Boxe", "minutes": 75, "kcal": 640, "avgHr": 142 }]
    }
  ]
}
```

## Tools

- `health_status`
- `health_daily_summary` (`date` optional)
- `health_weekly_summary`

GPS and device ids are not in the schema. Not medical advice.

## Grok

Expose the process with a public HTTPS URL, then **grok.com/connectors → New Connector → Custom** and paste `https://<host>/mcp`.

The phone still has to POST `/ingest`. Health Connect has no cloud API. Without something on the device that can read it, the server stays empty.
