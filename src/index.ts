interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * The class routing tokens, and the two safe ways to wrap a message carrying one.
 *
 * A pack signals an error's class with a leading token — `user_error:`,
 * `upstream_down:`, `upstream_throttled:`, `not_found:`, `blocked_host:`. The
 * gateway's classifier anchors on `^`, and `stripClassPrefix` (which hides the
 * token from the caller) anchors on `^` too. So the convention has one failure
 * mode, and it is silent: a catch block that wraps the message —
 * `` `${slug}/${tool}: ${message}` `` — pushes the token off position 0. The
 * error then books as `error` ("Pipeworx has a defect") instead of as the
 * caller mistake it is, AND the raw token leaks into what the caller reads.
 *
 * Nothing about that fails loudly. The call still returns, the message still
 * reads plausibly, and the misclassification only shows up as a pack sitting on
 * the Problem Tools list for a bug it does not have. Found live in
 * `medicaid-intelligence` on 2026-08-21; the same wrapper template is copied
 * across 18 DMV packs, none of which emit a token *yet*.
 *
 * `scripts/check-error-class-prefix.mjs` is the gate that keeps this honest —
 * it fails any pack that both emits a token and wraps a caught message without
 * using one of the helpers below.
 */

/**
 * The canonical token set. `workers/gateway/src/error-class.ts` carries its own
 * copy on the read side (it is deliberately importable without pulling a pack
 * in); the gate asserts the two agree, because this list has already drifted
 * twice — `not_found:` and `blocked_host:` were honoured by the classifier and
 * not stripped, so both went out to callers verbatim for months.
 */
const CLASS_TOKENS = [
  'upstream_down',
  'upstream_throttled',
  'user_error',
  'not_found',
  'blocked_host',
  // `blocked_url:` is emitted at position 0 from five sites in ssrf.ts
  // (`assertPublicHttpUrl`, and every redirect hop in `safeFetch`) and was in
  // NEITHER reader — so it went to callers verbatim for its whole life. Caught
  // 2026-08-21 by a live n8n call, which answered a private instance_url with
  // "…host). blocked_url: refusing to fetch non-public or non-https URL".
  // Exactly the drift the gate now blocks.
  'blocked_url',
  // `auth_required:` joins the list 2026-08-29 (fleet #638). It exists for the
  // same reason `user_error:` does: a bare 401/403 in an upstream body matches
  // the `upstream_throttled` heuristic below before anything auth-specific, so
  // a pack that needs to say "this is a credential problem, not a rate limit"
  // has no wording-based route — only the explicit-prefix escape hatch works.
  // tiingo and open-sanctions both reached for it on their own, on the
  // (reasonable, but wrong at the time) assumption that any snake_case class
  // already meant something to the gateway. Neither shipped a leak from
  // MIS-CLASSIFICATION — the `error` field was already correct — the leak was
  // the literal token riding along in `message`, unstripped, because this list
  // didn't know the token either reader was seeing.
  'auth_required',
] as const;

const CLASS_PREFIX_RE =
  /^(?:upstream_down|upstream_throttled|user_error|not_found|blocked_host|blocked_url|auth_required)\s*:\s*/;

/**
 * Split a caught message into its leading routing token (possibly empty) and
 * the human-readable body, so a wrapper can put the token back on the front.
 *
 *   const { token, body } = splitClassPrefix(message);
 *   return { error: `${token}my-pack/${name}: ${body}` };
 *
 * The `${token}` must be the FIRST thing in the template — that is the whole
 * point, and it is what the gate checks.
 */
function splitClassPrefix(message: string): { token: string; body: string } {
  const token = message.match(CLASS_PREFIX_RE)?.[0] ?? '';
  return { token, body: message.slice(token.length) };
}

/**
 * Drop a leading routing token from a message that is about to become a
 * FRAGMENT of a larger one — a per-mirror failure joined into "all providers
 * failed (...)", say. Hoisting is wrong there: the fragment never reaches
 * position 0, so the token cannot route anything and would only leak. The outer
 * message declares its own class.
 */
function dropClassPrefix(message: string): string {
  return message.replace(CLASS_PREFIX_RE, '');
}


/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * Crypto MCP — cryptocurrency prices and currency conversion.
 *
 * History: this pack used CoinGecko's free API but their edge geo/IP-blocks
 * Cloudflare Workers' egress (returns 403 from CF; works fine from any
 * residential IP). Switched to coinpaprika as the price/market backend. The
 * keyless coinpaprika endpoint shares a per-IP rate limit across ALL CF Workers
 * egressing from the same IPs, so it intermittently 402s even at our low volume.
 * To keep the flagship "bitcoin price" query reliable WITHOUT paying for a key,
 * get_crypto_price fails over to other keyless venues (Coinbase, CryptoCompare)
 * instead of throwing — a throw used to make ask_pipeworx reroute the question
 * to the forex tool and answer with an exchange rate. Pass _apiKey to use a
 * dedicated coinpaprika Pro quota (api-pro endpoint). ExchangeRate API for fiat
 * conversion is unaffected and kept.
 *
 * Tools:
 * - get_crypto_price: single cryptocurrency price (coinpaprika + keyless failover)
 * - get_crypto_market: top cryptocurrencies by market cap (coinpaprika)
 * - get_exchange_rate: fiat currency exchange rates (ExchangeRate API)
 */


// Bound every fetch() in this pack to a fixed timeout — an upstream that
// degrades without erroring would otherwise hold the Worker in `await fetch()`
// until its own execution budget kills the request (minutes, not seconds).
// Mirrors the epoFetch / usaspending retryFetch pattern (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'Crypto');
}

const COINPAPRIKA = 'https://api.coinpaprika.com/v1';

// CoinGecko-style coin IDs the router LLM tends to produce → coinpaprika
// IDs. Covers the names that show up in real questions; the search-fallback
// handles everything else.
const COIN_ID_MAP: Record<string, string> = {
  bitcoin: 'btc-bitcoin',
  btc: 'btc-bitcoin',
  ethereum: 'eth-ethereum',
  eth: 'eth-ethereum',
  tether: 'usdt-tether',
  usdt: 'usdt-tether',
  xrp: 'xrp-xrp',
  ripple: 'xrp-xrp',
  bnb: 'bnb-binance-coin',
  'binance-coin': 'bnb-binance-coin',
  solana: 'sol-solana',
  sol: 'sol-solana',
  'usd-coin': 'usdc-usd-coin',
  usdc: 'usdc-usd-coin',
  dogecoin: 'doge-dogecoin',
  doge: 'doge-dogecoin',
  cardano: 'ada-cardano',
  ada: 'ada-cardano',
  tron: 'trx-tron',
  trx: 'trx-tron',
  avalanche: 'avax-avalanche',
  'avalanche-2': 'avax-avalanche',
  avax: 'avax-avalanche',
  'shiba-inu': 'shib-shiba-inu',
  shib: 'shib-shiba-inu',
  chainlink: 'link-chainlink',
  link: 'link-chainlink',
  polkadot: 'dot-polkadot',
  dot: 'dot-polkadot',
  polygon: 'matic-polygon',
  'matic-network': 'matic-polygon',
  matic: 'matic-polygon',
  'bitcoin-cash': 'bch-bitcoin-cash',
  bch: 'bch-bitcoin-cash',
  litecoin: 'ltc-litecoin',
  ltc: 'ltc-litecoin',
  near: 'near-near-protocol',
  'near-protocol': 'near-near-protocol',
  'internet-computer': 'icp-internet-computer',
  icp: 'icp-internet-computer',
  aptos: 'apt-aptos',
  apt: 'apt-aptos',
  arbitrum: 'arb-arbitrum',
  arb: 'arb-arbitrum',
  'ethereum-classic': 'etc-ethereum-classic',
  etc: 'etc-ethereum-classic',
  stellar: 'xlm-stellar',
  xlm: 'xlm-stellar',
  monero: 'xmr-monero',
  xmr: 'xmr-monero',
  pepe: 'pepe-pepe',
  toncoin: 'ton-toncoin',
  ton: 'ton-toncoin',
  'the-open-network': 'ton-toncoin',
  uniswap: 'uni-uniswap',
  uni: 'uni-uniswap',
  cosmos: 'atom-cosmos',
  atom: 'atom-cosmos',
  hedera: 'hbar-hedera-hashgraph',
  hbar: 'hbar-hedera-hashgraph',
  filecoin: 'fil-filecoin',
  fil: 'fil-filecoin',
};

const API_KEY_PROP = {
  type: 'string' as const,
  description:
    'Optional — your own CoinPaprika Pro API key for a dedicated quota (uses the api-pro endpoint). Omit to use the keyless free endpoint; get_crypto_price additionally fails over to Coinbase/CryptoCompare if coinpaprika is throttled.',
};

const tools: McpToolExport['tools'] = [
  {
    name: 'get_crypto_price',
    description:
      'REAL-TIME spot price for any cryptocurrency. PREFER OVER WEB SEARCH for "what is BTC trading at", "price of ETH", "BNB price", current market cap, 24h move. Returns price USD, market cap, 24h % change — refreshed every few seconds upstream. Accepts common names ("bitcoin", "ethereum", "solana", "binance coin"), tickers ("BTC", "ETH", "SOL", "BNB", "XRP", "ADA", "DOGE"), or coinpaprika IDs ("btc-bitcoin"). Powered by coinpaprika with automatic failover to Coinbase/CryptoCompare if it is rate-limited, so it always returns a real price.',
    inputSchema: {
      type: 'object',
      properties: {
        coin_id: {
          type: 'string',
          description: 'Coin name, ticker, or coinpaprika ID (e.g., "bitcoin", "BTC", "btc-bitcoin")',
        },
        _apiKey: API_KEY_PROP,
      },
      required: ['coin_id'],
    },
  },
  {
    name: 'get_crypto_market',
    description: 'Get top cryptocurrencies ranked by market cap. Returns rank, name, symbol, USD price, market cap, 24h volume, and 24h % change for each.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Number of coins to return (1-100, default 10)',
        },
        _apiKey: API_KEY_PROP,
      },
    },
  },
  {
    name: 'get_crypto_history',
    description:
      'HISTORICAL price history for a cryptocurrency. PREFER OVER WEB SEARCH for "bitcoin price last 30 days", "ETH price history", "how has SOL done this year". Returns a daily time series of date, price USD, 24h volume, and market cap from a start date. Accepts common names ("bitcoin"), tickers ("BTC"), or coinpaprika IDs ("btc-bitcoin"). Powered by coinpaprika (keyless free tier covers roughly the last year of daily data).',
    inputSchema: {
      type: 'object',
      properties: {
        coin_id: { type: 'string', description: 'Coin name, ticker, or coinpaprika ID (e.g., "bitcoin", "BTC", "btc-bitcoin")' },
        start: { type: 'string', description: 'Start date YYYY-MM-DD (e.g., "2026-01-01"). Required.' },
        end: { type: 'string', description: 'End date YYYY-MM-DD (optional, default now).' },
        interval: { type: 'string', description: 'Sampling interval: "1d" (daily, default), "1h", "7d", "30d". Free tier favors "1d".' },
        _apiKey: API_KEY_PROP,
      },
      required: ['coin_id', 'start'],
    },
  },
  {
    name: 'get_crypto_global',
    description:
      'Global cryptocurrency market overview. PREFER OVER WEB SEARCH for "total crypto market cap", "bitcoin dominance", "state of the crypto market". Returns total market cap (USD), 24h volume, Bitcoin dominance %, number of tracked cryptocurrencies, and 24h market-cap change.',
    inputSchema: {
      type: 'object',
      properties: { _apiKey: API_KEY_PROP },
    },
  },
  {
    name: 'get_exchange_rate',
    description: 'Convert between fiat currencies (e.g., USD to EUR). Returns conversion rate and timestamp.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Source currency code (e.g., USD, EUR, GBP)' },
        to: { type: 'string', description: 'Target currency code (e.g., EUR, JPY, GBP)' },
        amount: { type: 'number', description: 'Amount to convert (default: 1)' },
      },
      required: ['from', 'to'],
    },
  },
];

function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || v.trim() === '') {
    throw new Error(`Missing required parameter: ${key} (string)`);
  }
  return v;
}

function getApiKey(args: Record<string, unknown>): string | undefined {
  const v = args._apiKey;
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

// Coinpaprika fetch. With an apiKey we hit the paid api-pro endpoint (BYO Pro
// quota); without, the keyless public endpoint. Coinpaprika occasionally 429s /
// 5xx / times out under shared-IP load — retry transient errors so a hiccup
// self-recovers. 402 = free-tier/shared-IP quota (retrying won't help) and other
// 4xx (e.g. 404 unknown coin) fail fast.
async function paprikaFetch(path: string, apiKey?: string): Promise<Response> {
  const base = apiKey ? 'https://api-pro.coinpaprika.com/v1' : COINPAPRIKA;
  const init = apiKey ? { headers: { Authorization: apiKey } } : undefined;
  for (let attempt = 1; attempt <= 3; attempt++) {
    let res: Response | null = null;
    try {
      res = await pwFetch(`${base}${path}`, init);
    } catch { /* network error — retry below */ }
    if (res) {
      if (res.ok) return res;
      if (res.status === 402) throw new Error('upstream_throttled: Coinpaprika quota exceeded (HTTP 402).');
      if (res.status !== 429 && res.status < 500) throw await httpError(res, 'coinpaprika error');
      // 429 / 5xx → fall through and retry
    }
    if (attempt < 3) await new Promise((r) => setTimeout(r, 300 * attempt));
  }
  throw new Error('upstream_down: Coinpaprika unreachable after 3 attempts.');
}

async function resolveCoinId(raw: string, apiKey?: string): Promise<string> {
  const lower = raw.trim().toLowerCase();
  if (/^[a-z0-9]+-/.test(lower)) return lower; // already coinpaprika-shaped
  const mapped = COIN_ID_MAP[lower];
  if (mapped) return mapped;
  // Fallback: coinpaprika search. Returns top match by relevance.
  const res = await paprikaFetch(`/search?q=${encodeURIComponent(raw)}&c=currencies&limit=1`, apiKey);
  const data = (await res.json()) as { currencies?: { id: string; name: string }[] };
  const hit = data.currencies?.[0];
  if (!hit) throw new Error(`Unknown coin: "${raw}". Try a common name (bitcoin), ticker (BTC), or coinpaprika ID (btc-bitcoin).`);
  return hit.id;
}

interface CoinpaprikaTicker {
  id: string;
  name: string;
  symbol: string;
  rank: number;
  quotes: {
    USD: {
      price: number;
      volume_24h: number;
      market_cap: number;
      percent_change_24h: number;
    };
  };
  last_updated?: string;
}

// ── Keyless price failover ───────────────────────────────────────────
// When coinpaprika is throttled/down, fetch a REAL spot price from another
// keyless, CF-friendly venue instead of throwing. A throw is dangerous: it makes
// ask_pipeworx reroute "bitcoin price" to the forex tool and answer with an
// exchange rate (a confident-wrong number). Symbol = coinpaprika id prefix
// (btc-bitcoin -> BTC), which is what these venues key on.
const UA = 'pipeworx-crypto/1.0 (+https://pipeworx.io)';

async function coinbaseSpot(symbol: string): Promise<{ price_usd: number; source: string }> {
  const r = await pwFetch(`https://api.exchange.coinbase.com/products/${symbol}-USD/ticker`, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw await httpError(r, 'coinbase');
  const t = (await r.json()) as { price?: string };
  const price = Number(t.price);
  if (!Number.isFinite(price) || price <= 0) throw new Error('coinbase: no price');
  return { price_usd: price, source: 'coinbase-exchange' };
}

// Keyless daily-candle history failover. Coinbase Exchange returns up to 300
// candles [time, low, high, open, close, volume], newest first; we map close →
// price_usd and return oldest-first. No market cap available from this venue.
async function coinbaseCandles(symbol: string, start: string, end: string | null) {
  const params = new URLSearchParams({ granularity: '86400' });
  if (start) params.set('start', `${start}T00:00:00Z`);
  // Coinbase ignores `start` and returns a default recent window unless `end` is
  // also set — default it to now so the [start, now] range is honored. Coinbase
  // caps at ~300 candles, so very old starts are clamped to the most recent ~300d.
  params.set('end', end ? `${end}T00:00:00Z` : new Date().toISOString());
  const r = await pwFetch(`https://api.exchange.coinbase.com/products/${symbol}-USD/candles?${params}`, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw await httpError(r, 'coinbase candles');
  const rows = (await r.json()) as Array<[number, number, number, number, number, number]>;
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('coinbase candles: empty');
  return rows
    .slice()
    .sort((a, b) => a[0] - b[0])
    .map((c) => ({
      date: new Date(c[0] * 1000).toISOString(),
      price_usd: c[4],
      volume_24h_usd: c[5],
      market_cap_usd: null,
    }));
}

async function bitstampSpot(symbol: string): Promise<{ price_usd: number; source: string }> {
  const r = await pwFetch(`https://www.bitstamp.net/api/v2/ticker/${symbol.toLowerCase()}usd/`, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw await httpError(r, 'bitstamp');
  const d = (await r.json()) as { last?: string };
  const price = Number(d.last);
  if (!Number.isFinite(price) || price <= 0) throw new Error('bitstamp: no price');
  return { price_usd: price, source: 'bitstamp' };
}

// ── Keyless market-list failover ─────────────────────────────────────
// coinpaprika's keyless /tickers shares a per-IP quota across ALL CF Workers,
// so get_crypto_market chronically 402s. CoinLore is a keyless, CF-friendly
// venue that returns the same market-cap-ranked list (rank/name/symbol/price/
// market_cap/24h%). Failing over here keeps get_crypto_market answering with
// real data instead of throwing (which makes ask_pipeworx reroute badly).
interface CoinloreTicker {
  rank: number; id: string; name: string; symbol: string;
  price_usd: string; market_cap_usd: string; volume24: number | string;
  percent_change_24h: string;
}
async function coinloreMarket(limit: number): Promise<Array<Record<string, unknown>>> {
  const r = await pwFetch(`https://api.coinlore.net/api/tickers/?start=0&limit=${limit}`, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw await httpError(r, 'coinlore');
  const body = (await r.json()) as { data?: CoinloreTicker[] };
  const rows = body.data ?? [];
  if (rows.length === 0) throw new Error('coinlore: empty');
  return rows.slice(0, limit).map((c) => ({
    rank: Number(c.rank),
    id: c.id,
    name: c.name,
    symbol: c.symbol.toUpperCase(),
    price: Number(c.price_usd),
    market_cap: Number(c.market_cap_usd),
    volume_24h: Number(c.volume24),
    change_24h_pct: Number(c.percent_change_24h),
  }));
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'get_crypto_price': {
      const apiKey = getApiKey(args);
      const coinId = await resolveCoinId(requireString(args, 'coin_id'), apiKey);
      try {
        const res = await paprikaFetch(`/tickers/${encodeURIComponent(coinId)}`, apiKey);
        const data = (await res.json()) as CoinpaprikaTicker;
        const usd = data.quotes.USD;
        return {
          id: data.id,
          name: data.name,
          symbol: data.symbol.toUpperCase(),
          rank: data.rank,
          price_usd: usd.price,
          market_cap_usd: usd.market_cap,
          volume_24h_usd: usd.volume_24h,
          change_24h_pct: usd.percent_change_24h,
          last_updated: data.last_updated,
        };
      } catch (primaryErr) {
        // Coinpaprika throttled/down → keyless failover for a real price rather
        // than throwing (which would make ask_pipeworx reroute to the forex tool).
        const symbol = coinId.split('-')[0].toUpperCase();
        for (const fb of [coinbaseSpot, bitstampSpot]) {
          try {
            const r = await fb(symbol);
            return {
              id: coinId,
              symbol,
              price_usd: r.price_usd,
              source: r.source,
              _fallback: true,
              _note: `coinpaprika unavailable (${dropClassPrefix(String((primaryErr as Error).message)).slice(0, 80)}); spot price via ${r.source}`,
            };
          } catch { /* try next failover venue */ }
        }
        throw primaryErr; // all venues failed — surface the original error
      }
    }

    case 'get_crypto_market': {
      const apiKey = getApiKey(args);
      const limit = Math.min(100, Math.max(1, (args.limit as number) ?? 10));
      // coinpaprika /tickers returns the full ranked list; slice top N.
      try {
        const res = await paprikaFetch(`/tickers?limit=${limit}`, apiKey);
        const data = (await res.json()) as CoinpaprikaTicker[];
        return {
          currency: 'usd',
          coins: data.slice(0, limit).map((c) => ({
            rank: c.rank,
            id: c.id,
            name: c.name,
            symbol: c.symbol.toUpperCase(),
            price: c.quotes.USD.price,
            market_cap: c.quotes.USD.market_cap,
            volume_24h: c.quotes.USD.volume_24h,
            change_24h_pct: c.quotes.USD.percent_change_24h,
          })),
        };
      } catch (primaryErr) {
        // Coinpaprika throttled/down (chronic keyless 402) → keyless failover
        // for a real ranked list rather than throwing.
        const coins = await coinloreMarket(limit);
        return {
          currency: 'usd',
          coins,
          _fallback: true,
          _note: `coinpaprika unavailable (${dropClassPrefix(String((primaryErr as Error).message)).slice(0, 80)}); market list via coinlore`,
        };
      }
    }

    case 'get_crypto_history': {
      const apiKey = getApiKey(args);
      const coinId = await resolveCoinId(requireString(args, 'coin_id'), apiKey);
      const start = requireString(args, 'start');
      const interval = typeof args.interval === 'string' && args.interval.trim() ? args.interval.trim() : '1d';
      const end = typeof args.end === 'string' && args.end.trim() ? args.end.trim() : null;
      const params = new URLSearchParams({ start, interval });
      if (end) params.set('end', end);
      try {
        const res = await paprikaFetch(`/tickers/${encodeURIComponent(coinId)}/historical?${params}`, apiKey);
        const data = (await res.json()) as Array<{ timestamp: string; price: number; volume_24h: number; market_cap: number }>;
        return {
          id: coinId,
          interval,
          start,
          end,
          points: data.length,
          source: 'coinpaprika',
          history: data.map((p) => ({
            date: p.timestamp,
            price_usd: p.price,
            volume_24h_usd: p.volume_24h,
            market_cap_usd: p.market_cap,
          })),
        };
      } catch (primaryErr) {
        // Coinpaprika historical is the same shared-IP free quota that 402s under
        // CF egress (see get_crypto_price). Fail over to keyless Coinbase daily
        // candles so "bitcoin price last 30 days" still returns real data instead
        // of throwing. Coinbase has no market cap, so that field is null here.
        try {
          const symbol = coinId.split('-')[0].toUpperCase();
          const candles = await coinbaseCandles(symbol, start, end);
          return {
            id: coinId,
            interval: '1d',
            start,
            end,
            points: candles.length,
            source: 'coinbase-exchange',
            _fallback: true,
            _note: `coinpaprika historical unavailable (${dropClassPrefix(String((primaryErr as Error).message)).slice(0, 80)}); daily closes via Coinbase.`,
            history: candles,
          };
        } catch {
          throw primaryErr;
        }
      }
    }

    case 'get_crypto_global': {
      const apiKey = getApiKey(args);
      const res = await paprikaFetch('/global', apiKey);
      const g = (await res.json()) as Record<string, unknown>;
      return {
        market_cap_usd: g.market_cap_usd ?? null,
        volume_24h_usd: g.volume_24h_usd ?? null,
        bitcoin_dominance_pct: g.bitcoin_dominance_percentage ?? null,
        cryptocurrencies_number: g.cryptocurrencies_number ?? null,
        market_cap_change_24h_pct: g.market_cap_change_24h ?? null,
        market_cap_ath_value: g.market_cap_ath_value ?? null,
        market_cap_ath_date: g.market_cap_ath_date ?? null,
        last_updated: g.last_updated ?? null,
      };
    }

    case 'get_exchange_rate': {
      const from = requireString(args, 'from').toUpperCase();
      const to = requireString(args, 'to').toUpperCase();
      const amount = (args.amount as number) ?? 1;
      const res = await pwFetch(
        `https://open.er-api.com/v6/latest/${encodeURIComponent(from)}`,
      );
      if (!res.ok) throw await httpError(res, 'ExchangeRate API error');
      const data = (await res.json()) as {
        result: string;
        rates: Record<string, number>;
        time_last_update_utc: string;
      };
      if (data.result !== 'success') throw new Error(`ExchangeRate: ${data.result}`);
      const rate = data.rates[to];
      if (rate === undefined) throw new Error(`Unknown currency: ${to}`);
      return {
        from,
        to,
        rate,
        amount,
        converted: Math.round(amount * rate * 100) / 100,
        last_updated: data.time_last_update_utc,
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 5 } } satisfies McpToolExport;
