# Ecommerce MCP

Remote MCP server used by Claude through Render.

## Production

- Render service: `ecommerce-mcp`
- MCP URL: `https://ecommerce-mcp-jlt3.onrender.com/mcp`
- Health: `https://ecommerce-mcp-jlt3.onrender.com/health`

## Instagram tools

- `instagram_get_account`: validates the configured professional account.
- `instagram_upload_media`: uploads a JPG, PNG, WebP, MP4 or MOV file (maximum 15 MB) to Vercel Blob and returns a public HTTPS URL. It does not publish.
- `instagram_preview_post`: validates a post and returns a SHA-256 preview hash.
- `instagram_publish_post`: publishes only when the payload still matches the preview hash and the user supplied the exact approval phrase `SON ONAY: YAYINLA`.

Supported content types are a single image, an image carousel, a Reel and a Story. Media must be reachable through public HTTPS URLs.

## Amazon UAE profitability tools

- `amazon_uae_profitability_status`: reports whether SP-API and Amazon Ads credentials are configured without returning secret values.
- `amazon_uae_profitability_start`: starts asynchronous Sales & Traffic, returns, storage-fee and listings reports; discovers completed Flat File V2 settlement reports; optionally starts an Amazon Ads v3 advertised-product report.
- `amazon_uae_profitability_get`: polls the job and, when ready, returns a paginated AED profitability table by SKU/ASIN.

The profitability response keeps sources separate: settlement rows are actual Amazon charges, Ads v3 is sponsored-product spend, and COGS/miscellaneous costs are caller-supplied AED amounts. Products without manual costs deliberately return `netProceeds: null`.

Required Render variables are documented in `.env.example`. SP-API report generation is asynchronous, so callers should pass the returned `job` object back to the get tool until its status becomes `DONE`.

## Required Render environment variables

Copy the names from `.env.example`. Never commit their values.

`MCP_CONNECTOR_SECRET` protects the Claude connector login and must contain at least 24 characters. Adding this security invalidates the old insecure connector token, so reconnect the custom connector in Claude after deployment.

`META_IG_USER_ID` and `META_ACCESS_TOKEN` belong to the Instagram Business/Creator account authorized for content publishing.

`BLOB_READ_WRITE_TOKEN` stores Claude-provided media at a public HTTPS URL before preview and publishing.

## Local verification

```bash
npm install
npm run build
npm start
```

The health endpoint does not require authentication. MCP requests require the OAuth bearer token issued after the connector password form.
# Product cost data safety

`add_cost` and `add_stock` do not silently overwrite a different value for an existing ASIN. They return `confirmation_required` with the existing and incoming values, warnings, and a one-use 15-minute `confirm_token`. Call the same tool again with that token to append the reviewed change. Zero cost always requires confirmation. Large cost/weight changes and dissimilar product names are highlighted. Bulk tools reject conflicting rows so they cannot bypass this gate.

`update_current_values` ignores source rows whose NOT/Notes field contains `SİLİNECEK`, and `audit_cost_entries` reports zero costs, ASIN/name conflicts, name/ASIN conflicts, and cost changes greater than 50% during the last seven days.

Google Form submissions bypass MCP. Copy `scripts/google-form-duplicate-alert.gs` into the spreadsheet's bound Apps Script project, set the `ALERT_EMAIL` script property, and create an installable **On form submit** trigger for `onFormSubmit`. It sends an email when the submitted ASIN already exists or cost is zero; it does not block the form submission.

