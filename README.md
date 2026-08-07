# Ecommerce MCP

Remote MCP server used by Claude through Render.

## Production

- Render service: `ecommerce-mcp`
- MCP URL: `https://ecommerce-mcp-jlt3.onrender.com/mcp`
- Health: `https://ecommerce-mcp-jlt3.onrender.com/health`

## Instagram tools

- `instagram_get_account`: validates the configured professional account.
- `instagram_preview_post`: validates a post and returns a SHA-256 preview hash.
- `instagram_publish_post`: publishes only when the payload still matches the preview hash and the user supplied the exact approval phrase `SON ONAY: YAYINLA`.

Supported content types are a single image, an image carousel, a Reel and a Story. Media must be reachable through public HTTPS URLs.

## Required Render environment variables

Copy the names from `.env.example`. Never commit their values.

`MCP_CONNECTOR_SECRET` protects the Claude connector login and must contain at least 24 characters. Adding this security invalidates the old insecure connector token, so reconnect the custom connector in Claude after deployment.

`META_IG_USER_ID` and `META_ACCESS_TOKEN` belong to the Instagram Business/Creator account authorized for content publishing.

## Local verification

```bash
npm install
npm run build
npm start
```

The health endpoint does not require authentication. MCP requests require the OAuth bearer token issued after the connector password form.
