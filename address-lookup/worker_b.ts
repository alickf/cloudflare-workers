/**
 * Cloudflare Worker: OS Places postcode proxy with classification filtering
 * -----------------------------------------------------------------------
 * - One upstream call to OS Places `search/places/v1/postcode`
 * - Filters results by CLASSIFICATION_CODE against an embedded allow-list
 * - Validates presence of OS_PLACES_KEY and handles upstream 401/403 cleanly
 *
 * Setup:
 *   wrangler secret put OS_PLACES_KEY
 */

export interface Env {
  OS_PLACES_KEY: string; // injected via Wrangler secrets
}

/*───────────────────────────────────────────────────────────────────────────
 * 1) Allow-list (embedded) + fast matchers
 *    - Wildcards use a trailing '*' (e.g. "CI*")
 *    - Exact codes are literals (e.g. "CI03")
 *    - Compiled once per isolate and reused
 *───────────────────────────────────────────────────────────────────────────*/

const ALLOW_LIST: string[] = [
  "C*", "CA*", "CC", "CC02", "CC03", "CC03HD", "CC03PR", "CC03SC",
  "CC04", "CC04YR", "CC07", "CC08", "CC09", "CC10", "CC12", "CE*",
  "CH*", "CI*", "CL", "CL01", "CL01LP", "CL02", "CL02HA", "CL02HO",
  "CL02YC", "CL03", "CL03RR", "CL04", "CL04AC", "CL04AM", "CL04HG", "CL04IM",
  "CL04MM", "CL04NM", "CL04SM", "CL04TM", "CL06", "CL06LS", "CL07", "CL07CI",
  "CL07EN", "CL07EX", "CL07TH", "CL08", "CL08AK", "CL08AQ", "CL08MX", "CL08WZ",
  "CL10", "CL10RE", "CL11", "CL11SD", "CM*", "CN*", "CO*", "CR",
  "CR01", "CR02", "CR02PO", "CR04", "CR04FK", "CR04FV", "CR04LV", "CR05",
  "CR06", "CR07", "CR08", "CR08GC", "CR09", "CR10", "CT01AP", "CT01AY",
  "CT01HS", "CT01HT", "CT04", "CT04AE", "CU04WM", "CU06", "CU06TE", "CU06TX",
  "CU10", "CU12", "CX", "CX01", "CX01PT", "CX02", "CX02FT", "CX03",
  "CX03AA", "CX04", "CX06", "M*", "MA", "MA99AR", "MA99AS", "MA99AT",
  "MB*", "MF", "MF99UR", "MF99US", "MF99UT", "MG*", "MN", "MN99VR",
  "MN99VS", "MN99VT", "R*", "RD", "RD02", "RD03", "RD04", "RD06",
  "RD08", "RH*", "RI*", "ZW", "ZW99AB", "ZW99CA", "ZW99CH", "ZW99CP",
  "ZW99GU", "ZW99KH", "ZW99MQ", "ZW99MT", "ZW99SU"
];

const EXACT = new Set(ALLOW_LIST.filter(t => !t.endsWith('*')).map(t => t.toUpperCase()));
const PREFIXES = ALLOW_LIST.filter(t => t.endsWith('*')).map(t => t.slice(0, -1).toUpperCase());

function codeAllowed(code?: string): boolean {
  if (!code) return false;
  const c = code.toUpperCase();
  if (EXACT.has(c)) return true;
  for (const p of PREFIXES) if (c.startsWith(p)) return true;
  return false;
}

/*───────────────────────────────────────────────────────────────────────────
 * 2) Helpers (normalise, JSON responses, safe text)
 *───────────────────────────────────────────────────────────────────────────*/

function normalisePostcode(pc: string): string {
  return pc.toUpperCase().replace(/\s+/g, '');
}

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}

async function safeText(r: Response): Promise<string | undefined> {
  try { return await r.clone().text(); } catch { return undefined; }
}

/*───────────────────────────────────────────────────────────────────────────
 * 3) Build OS Places URL
 *    - Adds safe “quality” filters (live/approved records)
 *    - We filter classifications at the edge (no OR/wildcard pitfalls upstream)
 *───────────────────────────────────────────────────────────────────────────*/

function buildOsPlacesUrl(key: string, pc: string, dataset: string, max: string): string {
  const u = new URL('https://api.os.uk/search/places/v1/postcode');
  u.searchParams.set('key', key);
  u.searchParams.set('postcode', pc);
  u.searchParams.set('dataset', dataset); // 'LPI' (default) or 'DPA'
  u.searchParams.set('maxresults', max);

  // Quality filters (safe ANDs):
  u.searchParams.append('fq', 'LOGICAL_STATUS_CODE:1');
  if (dataset === 'LPI') u.searchParams.append('fq', 'LPI_LOGICAL_STATUS_CODE:1');
  // Optional: only postal-ish rows
  // u.searchParams.append('fq', 'POSTAL_ADDRESS_CODE:(D L)');

  return u.toString();
}

/*───────────────────────────────────────────────────────────────────────────
 * 4) Worker entrypoint with graceful secret / auth handling
 *───────────────────────────────────────────────────────────────────────────*/

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      // 4a) Secret present? Fail early if missing/blank (easier for maintainers)
      if (!env?.OS_PLACES_KEY || !env.OS_PLACES_KEY.trim()) {
        return json({
          error: 'missing_os_key',
          message: 'OS_PLACES_KEY is not configured. Set it with `wrangler secret put OS_PLACES_KEY`.'
        }, 500);
      }

      // 4b) Parse query
      const url = new URL(req.url);
      const pcParam = url.searchParams.get('pc') || '';
      if (!pcParam) return json({ error: 'bad_request', message: 'pc (postcode) is required.' }, 400);

      const postcode = normalisePostcode(pcParam);
      const dataset = (url.searchParams.get('dataset') || 'LPI').toUpperCase();
      const max = url.searchParams.get('maxresults') || '100';

      // 4c) Upstream call
      const upstreamUrl = buildOsPlacesUrl(env.OS_PLACES_KEY, postcode, dataset, max);
      const res = await fetch(upstreamUrl, { headers: { 'Accept': 'application/json' }});

      // 4d) Friendly auth errors from OS (bad/absent key, revoked key, etc.)
      if (res.status === 401 || res.status === 403) {
        const detail = await safeText(res);
        return json({
          error: 'os_auth_failed',
          message: 'OS Places rejected the request (check OS_PLACES_KEY or API plan).',
          status: res.status,
          detail
        }, 502);
      }

      // 4e) Other upstream failures
      if (!res.ok) {
        const detail = await safeText(res);
        return json({
          error: 'os_upstream_error',
          message: `OS Places responded with ${res.status}.`,
          status: res.status,
          detail
        }, 502);
      }

      // 4f) Parse + filter
      const body = await res.json();
      const results = Array.isArray(body?.results) ? body.results : [];
      const filtered = results.filter((row: any) => {
        const rec = row?.LPI ?? row?.DPA ?? row;
        return codeAllowed(rec?.CLASSIFICATION_CODE);
      });

      // 4g) Return compact payload; preserve header but correct count
      return new Response(JSON.stringify({
        header: { ...(body?.header || {}), totalresults: filtered.length },
        results: filtered
      }), {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'public, max-age=120'
        }
      });

    } catch (err: any) {
      return json({
        error: 'edge_failure',
        message: 'Unexpected error in the Worker.',
        detail: String(err?.message || err)
      }, 500);
    }
  }
};