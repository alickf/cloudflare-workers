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
  LOOKUP_CACHE?: KVNamespace; // optional KV cache binding (test/prod)
  DEBUG_LOGS?: string;
  DEBUG_MODE?: string;
}

/*───────────────────────────────────────────────────────────────────────────
 * 1) Allow-list (embedded) + fast matchers
 *    - Wildcards use a trailing '*' (e.g. "CI*")
 *    - Exact codes are literals (e.g. "CI03")
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
 *     - Can be extended from the spreadsheet if you add more rows
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
  LSB_PROPERTY_TYPE?: LSBType;   // preferred spelling
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
  LSB_PROPERTY_TYPE?: LSBType;   // preferred spelling
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
    LSB_PROPERTY_TYPE: _type
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
    LSB_PROPERTY_TYPE: _type,
    LSB_PROPRTY_TYPE: _type
  };
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

      const raw = url.searchParams.get('raw') === '1';
      const skipcache = url.searchParams.get('skipcache') === '1';

      // 4c) Upstream call (with optional KV cache)
      // Do not forward client headers to OS; perform a clean GET request
      const upstreamUrl = buildOsPlacesUrl(env.OS_PLACES_KEY, postcode, dataset, max);

      // KV cache key (normalised PC, dataset, max)
      const _osKey = `os:v1:${dataset}:${postcode}:mr=${max}`;
      let cacheState: 'HIT' | 'MISS' | 'BYPASS' = skipcache ? 'BYPASS' : 'MISS';
      let res: Response | undefined;
      let upstreamText: string | undefined;
      let upstreamJson: any | undefined;

      // Try KV if bound and not bypassed
      if (env.LOOKUP_CACHE && !skipcache) {
        const cached = await env.LOOKUP_CACHE.get(_osKey);
        if (cached) {
          try {
            upstreamJson = JSON.parse(cached);
            cacheState = 'HIT';
            if (env.DEBUG_LOGS === 'true') console.log(`KV HIT ${_osKey}`);
          } catch {
            // fall through to fetch
          }
        }
      }

      if (!upstreamJson) {
        res = await fetch(upstreamUrl, { method: 'GET' });

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

        // Put into KV unless bypassed
        if (env.LOOKUP_CACHE && !skipcache && upstreamText) {
          await env.LOOKUP_CACHE.put(_osKey, upstreamText, { expirationTtl: 86400 });
          if (env.DEBUG_LOGS === 'true') console.log(`KV PUT ${_osKey}`);
        }
      }

      // raw=1 passthrough (use cached JSON if present, otherwise the fresh text)
      if (raw) {
        const txt = upstreamText ?? JSON.stringify(upstreamJson);
        return new Response(txt, {
          status: 200,
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'x-cache': cacheState
          }
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

      // 4h) Return compact payload; preserve header but correct count
      return new Response(JSON.stringify({
        header: { ...(body?.header || {}), totalresults: projected.length },
        results: projected
      }), {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'public, max-age=120',
          'x-cache': cacheState,
          'x-allowlist-hash': (() => {
            try {
              const s = ALLOW_LIST.join('|').toUpperCase();
              let h = 0;
              for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
              return ('00000000' + (h >>> 0).toString(16)).slice(-8);
            } catch { return 'na'; }
          })()
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