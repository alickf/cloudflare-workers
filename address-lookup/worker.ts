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
  OS_PLACES_KEY: string;
  DEBUG_LOGS?: string;
  DEBUG_MODE?: string;
  EDGE_TTL_SECONDS?: string;    // so env.EDGE_TTL_SECONDS types cleanly
}

/*───────────────────────────────────────────────────────────────────────────
 * 1) Allow-list (embedded) + fast matchers
 *    - Wildcards use a trailing '*' (e.g. "CI*")
 *    - Exact codes are literals (e.g. "CC02")
 *    - Compiled once per isolate and reused
 *───────────────────────────────────────────────────────────────────────────*/

const ALLOW_LIST: string[] = [
  "CA*",
  "CE*",
  "CH*",
  "CI*",
  "CM*",
  "CN*",
  "CO*",
  "MB*",
  "MG*",
  "RH*",
  "RI*",
  "C",
  "CC",
  "CC02",
  "CC03",
  "CC03HD",
  "CC03PR",
  "CC03SC",
  "CC04",
  "CC04YR",
  "CC07",
  "CC08",
  "CC09",
  "CC10",
  "CC12",
  "CL",
  "CL01",
  "CL01LP",
  "CL02",
  "CL02HA",
  "CL02HO",
  "CL02YC",
  "CL03",
  "CL03RR",
  "CL04",
  "CL04AC",
  "CL04AM",
  "CL04HG",
  "CL04IM",
  "CL04MM",
  "CL04NM",
  "CL04SM",
  "CL04TM",
  "CL06",
  "CL06LS",
  "CL07",
  "CL07CI",
  "CL07EN",
  "CL07EX",
  "CL07TH",
  "CL08",
  "CL08AK",
  "CL08AQ",
  "CL08MX",
  "CL08WZ",
  "CL10",
  "CL10RE",
  "CL11",
  "CL11SD",
  "CR",
  "CR01",
  "CR02",
  "CR02PO",
  "CR04",
  "CR04FK",
  "CR04FV",
  "CR04LV",
  "CR05",
  "CR06",
  "CR07",
  "CR08",
  "CR08GC",
  "CR09",
  "CR10",
  "CT01AP",
  "CT01AY",
  "CT01HS",
  "CT01HT",
  "CT04",
  "CT04AE",
  "CU04WM",
  "CU06",
  "CU06TE",
  "CU06TX",
  "CU10",
  "CU12",
  "CX",
  "CX01",
  "CX01PT",
  "CX02",
  "CX02FT",
  "CX03",
  "CX03AA",
  "CX04",
  "CX06",
  "M",
  "MA",
  "MA99AR",
  "MA99AS",
  "MA99AT",
  "MF",
  "MF99UR",
  "MF99US",
  "MF99UT",
  "MN",
  "MN99VR",
  "MN99VS",
  "MN99VT",
  "R",
  "RD",
  "RD02",
  "RD03",
  "RD04",
  "RD06",
  "RD08",
  "ZW",
  "ZW99AB",
  "ZW99CA",
  "ZW99CH",
  "ZW99CP",
  "ZW99GU",
  "ZW99KH",
  "ZW99MQ",
  "ZW99MT",
  "ZW99SU",
  "ZW99SY",
  "ZW99TP"
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
 * 1b) Abstract property type resolver (Business / Residential / Other)
 *     - Based on leading code family with a few explicit subfamilies
 *───────────────────────────────────────────────────────────────────────────*/
type LSBType = 'BUSINESS' | 'RESIDENTIAL' | 'OTHER';

const TYPE_BY_PREFIX: Array<[string, LSBType]> = [
  // Residential families / subfamilies
  ['RD', 'RESIDENTIAL'], // Residential Dwelling
  ['RH', 'RESIDENTIAL'], // Residential Hotel/Hostel etc.
  ['RI', 'RESIDENTIAL'], // Residential Institution
  ['R',  'RESIDENTIAL'], // Any other R* class treated as residential

  // Commercial / business families
  ['CA', 'BUSINESS'],
  ['CC', 'BUSINESS'],
  ['CE', 'BUSINESS'],
  ['CH', 'BUSINESS'],
  ['CI', 'BUSINESS'],
  ['CL', 'BUSINESS'],
  ['CM', 'BUSINESS'],
  ['CN', 'BUSINESS'],
  ['CO', 'BUSINESS'],
  ['CR', 'BUSINESS'],
  ['CT', 'BUSINESS'],
  ['CX', 'BUSINESS'],
  ['CU', 'BUSINESS'], // utilities (if they pass other gates)

  // Special/other families
  ['MB', 'OTHER'],
  ['MF', 'OTHER'],
  ['MG', 'OTHER'],
  ['MN', 'OTHER'],
  ['MA', 'OTHER'],
  ['M',  'OTHER'],
  ['ZW', 'OTHER']
];

function resolvePropertyType(code?: string): LSBType {
  if (!code) return 'OTHER';
  const c = code.toUpperCase();
  for (const [p, t] of TYPE_BY_PREFIX) {
    if (c.startsWith(p)) return t;
  }
  return 'OTHER';
}

/*───────────────────────────────────────────────────────────────────────────
 * 2b) Projectors (return only fields we need to minimise payload)
 *     - LPI: keep core address + PAO/SAO numerics/text as available
 *     - DPA: map to a similar slim shape
 *───────────────────────────────────────────────────────────────────────────*/
type SlimLPI = {
  UPRN?: string;
  ADDRESS?: string;
  //USRN?: string;
  //LPI_KEY?: string;
  PAO_TEXT?: string;
  SAO_TEXT?: string;
  PAO_START_NUMBER?: string;
  PAO_END_NUMBER?: string;
  STREET_DESCRIPTION?: string;
  TOWN_NAME?: string;
  ADMINISTRATIVE_AREA?: string;
  POSTCODE_LOCATOR?: string;
  CLASSIFICATION_CODE?: string;
  LSB_PROPERTY_TYPE?: LSBType; //Add property type from Hossein's lookup
};

type SlimDPA = {
  UPRN?: string;
  ADDRESS?: string;
  ORGANISATION_NAME?: string;
  BUILDING_NAME?: string;
  SUB_BUILDING_NAME?: string;
  BUILDING_NUMBER?: string;
  THOROUGHFARE_NAME?: string;
  POST_TOWN?: string;
  POSTCODE?: string;
  CLASSIFICATION_CODE?: string;
  LSB_PROPERTY_TYPE?: LSBType;   //Add property type from Hossein's lookup
};

function projectLPI(lpi: any): SlimLPI {
  const _type = resolvePropertyType(lpi.CLASSIFICATION_CODE);
  return {
    UPRN: lpi.UPRN,
    ADDRESS: lpi.ADDRESS,
  //  USRN: lpi.USRN,
  //  LPI_KEY: lpi.LPI_KEY,
    PAO_TEXT: lpi.PAO_TEXT,
    SAO_TEXT: lpi.SAO_TEXT,
    PAO_START_NUMBER: lpi.PAO_START_NUMBER,
    PAO_END_NUMBER: lpi.PAO_END_NUMBER,
    STREET_DESCRIPTION: lpi.STREET_DESCRIPTION,
    TOWN_NAME: lpi.TOWN_NAME,
    ADMINISTRATIVE_AREA: lpi.ADMINISTRATIVE_AREA,
    POSTCODE_LOCATOR: lpi.POSTCODE_LOCATOR,
    CLASSIFICATION_CODE: lpi.CLASSIFICATION_CODE,
    LSB_PROPERTY_TYPE: _type //Add property type from Hossein's lookup
  };
}

function projectDPA(dpa: any): SlimDPA {
  const _type = resolvePropertyType(dpa.CLASSIFICATION_CODE);
  return {
    UPRN: dpa.UPRN,
    ADDRESS: dpa.ADDRESS,
    ORGANISATION_NAME: dpa.ORGANISATION_NAME,
    BUILDING_NAME: dpa.BUILDING_NAME,
    SUB_BUILDING_NAME: dpa.SUB_BUILDING_NAME,
    BUILDING_NUMBER: dpa.BUILDING_NUMBER,
    THOROUGHFARE_NAME: dpa.THOROUGHFARE_NAME,
    POST_TOWN: dpa.POST_TOWN,
    POSTCODE: dpa.POSTCODE,
    CLASSIFICATION_CODE: dpa.CLASSIFICATION_CODE,
    LSB_PROPERTY_TYPE: _type //Add property type from Hossein's lookup
  };
}

/*───────────────────────────────────────────────────────────────────────────
 * 2) Helpers (normalise, JSON responses, safe text)
 *───────────────────────────────────────────────────────────────────────────*/

function normalisePostcode(pc: string): string {
  return pc.toUpperCase().replace(/\s+/g, '');
}

function corsHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    'access-control-allow-origin': '*',
    // Let browsers read these custom headers in fetch/XHR
    'access-control-expose-headers': 'x-edge-cache, x-allowlist-hash, cf-ray, server-timing',
    ...(extra || {})
  };
}

function json(obj: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...corsHeaders(extraHeaders)
    }
  });
}

async function safeText(r: Response): Promise<string | undefined> {
  try { return await r.clone().text(); } catch { return undefined; }
}

/*───────────────────────────────────────────────────────────────────────────
 * 2a) Validation + timing + robust fetch
 *───────────────────────────────────────────────────────────────────────────*/
// Normalised (no-space, upper) UK postcode pattern (incl. GIR0AA)
const PC_RE = /^(GIR0AA|[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2})$/;

// Simple phase timing helpers for Server-Timing
function newTiming() {
  const t0 = Date.now();
  const parts: string[] = [];
  return {
    t0,
    mark(name: string, start: number) { parts.push(`${name};dur=${Date.now() - start}`); },
    header() { return parts.join(', '); }
  };
}

// Upstream fetch with timeout (retry logic at callsite)
async function fetchWithTimeout(url: string, ms = 2500): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort('timeout'), ms);
  try {
    return await fetch(url, { method: 'GET', signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

/*───────────────────────────────────────────────────────────────────────────
 * 3) Build OS Places URL
 *    - Adds safe “quality” filters (live/approved records)
 *    - We filter classifications at the edge (no OR/wildcard pitfalls upstream)
 *───────────────────────────────────────────────────────────────────────────*/

function buildOsPlacesUrl(key: string, pc: string, dataset: string, max: string, postalOnly: boolean): string {
  const u = new URL('https://api.os.uk/search/places/v1/postcode');
  u.searchParams.set('key', key);
  u.searchParams.set('postcode', pc);
  u.searchParams.set('dataset', dataset); // 'LPI' (default) or 'DPA'
  u.searchParams.set('maxresults', max);

  // Quality filters (safe ANDs):
  u.searchParams.append('fq', 'LOGICAL_STATUS_CODE:1');
  if (dataset === 'LPI') u.searchParams.append('fq', 'LPI_LOGICAL_STATUS_CODE:1');

  // Optional: only postal-ish rows when requested (D and L are postal)
  if (dataset === 'LPI' && postalOnly) u.searchParams.append('fq', 'POSTAL_ADDRESS_CODE:(D L)');

  return u.toString();
}

/*───────────────────────────────────────────────────────────────────────────
 * 4) Worker entrypoint with graceful secret / auth handling
 *───────────────────────────────────────────────────────────────────────────*/

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      // CORS preflight
      if (req.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: corsHeaders({
            'access-control-allow-methods': 'GET,OPTIONS',
            'access-control-allow-headers': 'content-type,x-cloudflare-bypass'
          })
        });
      }

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

      // Start timing aggregation for Server-Timing
      const timing = newTiming();

      const postcode = normalisePostcode(pcParam);
      // Strict postcode validation (normalised form)
      if (!PC_RE.test(postcode)) {
        return json({ error: 'bad_postcode', message: 'Invalid UK postcode format.' }, 400);
      }
      const dataset = (url.searchParams.get('dataset') || 'LPI').toUpperCase();
      const max = url.searchParams.get('maxresults') || '100';

      const raw = url.searchParams.get('raw') === '1';
      const skipcache = url.searchParams.get('skipcache') === '1';
      const postalOnly = url.searchParams.get('postal') === '1'; // optional upstream narrowing

      // Edge cache key derived from normalised inputs + allow-list hash
      const _allowHash = (() => {
        try {
          const s = ALLOW_LIST.join('|').toUpperCase();
          let h = 0;
          for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
          return ('00000000' + (h >>> 0).toString(16)).slice(-8);
        } catch { return 'na'; }
      })();

      const cacheKeyUrl = new URL(req.url);
      // Canonicalise path so /api/address-lookup and /api/address-lookup/ hit the same key
      if (!cacheKeyUrl.pathname.endsWith('/')) {
        cacheKeyUrl.pathname += '/';
      }
      cacheKeyUrl.searchParams.set('pc', postcode);       // normalised
      cacheKeyUrl.searchParams.set('dataset', dataset);
      cacheKeyUrl.searchParams.set('maxresults', max);
      cacheKeyUrl.searchParams.set('v', _allowHash);      // auto-bust on allow-list change

      const shouldBypassEdgeCache = raw || skipcache;

      // If present at the edge, return immediately (before any upstream work)
      if (!shouldBypassEdgeCache) {
        const edgeHit = await caches.default.match(cacheKeyUrl.toString(), { ignoreMethod: true });
        if (edgeHit) {
          const hitHeaders = Object.fromEntries(edgeHit.headers);
          return new Response(edgeHit.body, {
            status: 200,
            headers: corsHeaders({
              ...hitHeaders,
              'x-edge-cache': 'HIT',
              'x-allowlist-hash': _allowHash,
              'server-timing': timing.header()
            })
          });
        }
      }

      // 4c) Upstream call (no client headers forwarded)
      // Do not forward client headers to OS; perform a clean GET request
      const upstreamUrl = buildOsPlacesUrl(env.OS_PLACES_KEY, postcode, dataset, max, postalOnly);

      let res: Response | undefined;
      let upstreamText: string | undefined;
      let upstreamJson: any | undefined;


      if (!upstreamJson) {
        // Upstream fetch with timeout and one retry for transient issues
        const tOs = Date.now();
        res = await fetchWithTimeout(upstreamUrl, 2500).catch(() => undefined);
        if (!res) res = await fetchWithTimeout(upstreamUrl, 2500).catch(() => undefined);
        timing.mark('os', tOs);

        if (!res) {
          // Try to serve a stale cached edge response if available
          const stale = await caches.default.match(cacheKeyUrl.toString(), { ignoreMethod: true });
          if (stale) {
            const sh = Object.fromEntries(stale.headers);
            return new Response(stale.body, {
              status: 200,
              headers: corsHeaders({ ...sh, 'x-edge-cache': 'STALE', 'x-allowlist-hash': _allowHash, 'server-timing': timing.header() })
            });
          }
          return json({ error: 'os_timeout', message: 'OS Places timed out.' }, 504);
        }

        // 4d) Friendly auth errors from OS (bad/absent key, revoked key, etc.)
        if (res.status === 401 || res.status === 403) {
          const detail = await safeText(res);
          const stale = await caches.default.match(cacheKeyUrl.toString(), { ignoreMethod: true });
          if (stale) {
            const sh = Object.fromEntries(stale.headers);
            return new Response(stale.body, {
              status: 200,
              headers: corsHeaders({ ...sh, 'x-edge-cache': 'STALE', 'x-allowlist-hash': _allowHash, 'server-timing': timing.header() })
            });
          }
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
          const stale = await caches.default.match(cacheKeyUrl.toString(), { ignoreMethod: true });
          if (stale) {
            const sh = Object.fromEntries(stale.headers);
            return new Response(stale.body, {
              status: 200,
              headers: corsHeaders({ ...sh, 'x-edge-cache': 'STALE', 'x-allowlist-hash': _allowHash, 'server-timing': timing.header() })
            });
          }
          return json({
            error: 'os_upstream_error',
            message: `OS Places responded with ${res.status}.`,
            status: res.status,
            detail
          }, 502);
        }

        upstreamText = await res.text();
        try {
          upstreamJson = JSON.parse(upstreamText);
        } catch (e) {
          return json({
            error: 'os_parse_error',
            message: 'Failed to parse OS Places response.',
            detail: String((e as Error).message || e)
          }, 502);
        }

      }

      // raw=1 passthrough (use cached JSON if present, otherwise the fresh text)
      if (raw) {
        const txt = upstreamText ?? JSON.stringify(upstreamJson);
        return new Response(txt, {
          status: 200,
          headers: corsHeaders({
            'content-type': 'application/json; charset=utf-8',
            'server-timing': timing.header()
          })
        });
      }

      // 4f) Parse + filter
      const body = upstreamJson;
      const results = Array.isArray(body?.results) ? body.results : [];
      const filtered = results.filter((row: any) => {
        const rec = row?.LPI ?? row?.DPA ?? row;
        return codeAllowed(rec?.CLASSIFICATION_CODE);
      });

      // 4g) Project to slim shape to minimise payload size
      let projected: Array<any>;
      if (dataset === 'LPI') {
        projected = filtered
          .map((row: any) => row?.LPI)
          .filter(Boolean)
          .map(projectLPI);
      } else {
        projected = filtered
          .map((row: any) => row?.DPA)
          .filter(Boolean)
          .map(projectDPA);
      }
      const tFilt = Date.now();
      timing.mark('filter', tFilt);

    // 4h) Return compact payload; also store at the edge with s-maxage TTL
    const edgeTTL = Number(env?.EDGE_TTL_SECONDS || (env?.DEBUG_MODE === 'true' ? '60' : '864000')); // 60s test, 10d prod
    const fresh = new Response(JSON.stringify({
      header: { ...(body?.header || {}), totalresults: projected.length },
      results: projected
    }), {
      headers: corsHeaders({
        'content-type': 'application/json; charset=utf-8',
        // NOTE: s-maxage controls Cloudflare cache; browsers still see no-store unless you add max-age
        'cache-control': `public, max-age=0, s-maxage=${isFinite(edgeTTL) && edgeTTL > 0 ? edgeTTL : 60}`,
        'x-edge-cache': 'MISS',             // explicit edge cache status for first response
        'x-allowlist-hash': _allowHash,     // helps verify deploy/allow-list version
        'server-timing': timing.header()
      })
    });

    // Only cache successful responses at the edge and only when not bypassing
    if (!shouldBypassEdgeCache && fresh.ok) {
      await caches.default.put(cacheKeyUrl.toString(), fresh.clone());
    }

    return fresh;

    } catch (err: any) {
      return json({
        error: 'edge_failure',
        message: 'Unexpected error in the Worker.',
        detail: String(err?.message || err)
      }, 500);
    }
  }
};