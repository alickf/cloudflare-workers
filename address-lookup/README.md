# Cloudflare Workers

This repository contains Cloudflare Workers used by LightSpeed Broadband.

## address-lookup Worker

The `address-lookup` Worker proxies requests to the Ordnance Survey Places API, filters results based on classification codes, and augments responses with an `LSB_PROPERTY_TYPE` field.

### Features
- Filters out unwanted classification codes using an allow-list.
- Adds an `LSB_PROPERTY_TYPE` field based on OS classification.
- Can return slimmed-down responses for faster client consumption.
- Designed for deployment via Cloudflare Workers with Wrangler.

### Local Development

1. Install dependencies:
   ```bash
   npm install
   ```

2. Run the Worker locally:
   ```bash
   wrangler dev --env dev
   ```

3. Test with curl:
   ```bash
   curl "http://localhost:8787/address-lookup?pc=CB9%207XU&dataset=LPI&maxresults=100"
   ```

### Deployment

Deploy to the `test` environment:
```bash
wrangler deploy --env test
```

Deploy to the `prod` environment:
```bash
wrangler deploy --env prod
```

### Environment Variables

The following secrets must be set for each environment:

- `OS_PLACES_KEY`: Ordnance Survey Places API key

To set a secret:
```bash
wrangler secret put OS_PLACES_KEY --env test
```

### Notes
- Bypass headers may be required for certain WAF rules.
- Keep `.env` and `.wrangler/` excluded via `.gitignore`.
