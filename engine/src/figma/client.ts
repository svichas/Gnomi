// Figma's REST API, read-only (docs/figma-prototype-spike.md §2). The only place the Figma token is used: it goes in the
// X-Figma-Token header of requests to api.figma.com and nowhere else, not into render downloads, errors or logs.

export const FIGMA_HOST = 'api.figma.com';
const API = `https://${FIGMA_HOST}`;
const REQUEST_MS = 20_000;
const DOWNLOAD_MS = 60_000;
const MAX_WAIT_S = 20; // a longer Retry-After is a quota to come back to (a View seat's lasts for days), not a blip to sleep through
const RETRIES = 2;
// Renders are served from Figma's image storage, an amazonaws.com address that is not documented; anything else is refused.
const RENDER_HOST = /(^|\.)(figma\.com|amazonaws\.com)$/;

export type FigmaErrorKind = 'no_token' | 'bad_token' | 'no_access' | 'not_found' | 'rate_limited' | 'bad_link' | 'network' | 'failed';

export class FigmaError extends Error {
  kind: FigmaErrorKind;
  status: number | null; // the HTTP status behind a 'failed' error
  constructor(kind: FigmaErrorKind, message: string, status: number | null = null) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

const BAD_TOKEN = 'Figma does not accept this token. It is wrong, revoked or expired (tokens last 90 days at most). Create a new one in Figma under Settings → Security and replace it in Gnomi’s Settings.';
const NO_ACCESS = 'Figma accepts the token, but its account cannot open this file. Ask the file’s owner to share it with that account, or use a token from an account that can.';
const NO_SCOPE = 'This token cannot read files: it lacks the file_content:read scope. Create a new token with that scope in Figma (Settings → Security) and replace it in Gnomi’s Settings.';

/** "30 seconds", "5 minutes", "2 days": how long Figma asks us to wait. */
function duration(seconds: number): string {
  const [n, unit] = seconds < 90 ? [seconds, 'second'] : seconds < 5400 ? [Math.round(seconds / 60), 'minute'] : seconds < 129_600 ? [Math.round(seconds / 3600), 'hour'] : [Math.round(seconds / 86_400), 'day'];
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

function rateLimited(res: Response, wait: number | null): FigmaError {
  const when = wait === null ? 'in a minute or so' : `in about ${duration(wait)}`;
  // low: View and Collab seats, whose allowance is a handful of requests a month (spike §2.5).
  const seat = res.headers.get('x-figma-rate-limit-type') === 'low' ? ' This token’s account has a View or Collab seat on the file’s plan, which allows only a few imports a month; a token from a Dev or Full seat avoids that.' : '';
  return new FigmaError('rate_limited', `Figma is limiting requests. Try again ${when}.${seat}`, 429);
}

export interface FigmaClient {
  /** Throws when Figma does not accept the token. Costs a Tier 3 request, not one of the scarce file requests. */
  check(): Promise<void>;
  /** A JSON GET of the REST API. */
  get<T>(path: string, query: Record<string, string>): Promise<T>;
  /** A rendered image, without the token; refuses addresses that are not Figma's, plain http and anything over `max` bytes. */
  download(url: string, max: number): Promise<Uint8Array>;
}

export function figmaClient(opts: { token: string | null; fetch?: typeof fetch; sleep?: (ms: number) => Promise<void> }): FigmaClient {
  const { token } = opts;
  const doFetch = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const hide = (text: string) => (token ? text.replaceAll(token, '[redacted]') : text);

  /** One GET. A 429 is waited out when Figma says it is short (Retry-After), otherwise it is an error with the wait in it. */
  async function send(url: string, headers: Record<string, string>, timeout: number): Promise<Response> {
    const host = new URL(url).host;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        // redirect: 'error' because a custom header like the token would follow a redirect to another host.
        res = await doFetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(timeout) });
      } catch (err) {
        if ((err as Error | undefined)?.name === 'TimeoutError') throw new FigmaError('network', `${host} did not answer within ${timeout / 1000} seconds. Check the internet connection, VPN or proxy.`);
        throw new FigmaError('network', hide(`Could not reach ${host} (${err instanceof Error ? err.message : String(err)}). Check the internet connection, VPN or proxy.`));
      }
      if (res.status !== 429) return res;
      const seconds = Number.parseInt(res.headers.get('retry-after') ?? '', 10);
      const wait = Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
      if (wait === null || wait > MAX_WAIT_S || attempt >= RETRIES) throw rateLimited(res, wait);
      await res.body?.cancel();
      await sleep(wait * 1000);
    }
  }

  const needToken = (): string => {
    if (!token) throw new FigmaError('no_token', 'Add a Figma access token in Settings first.');
    return token;
  };
  const errorText = (body: unknown): string => {
    const b = body as { err?: unknown; message?: unknown } | null;
    return String(b?.err ?? b?.message ?? '');
  };

  /** Whether Figma accepts the token, by asking for the token's own profile. A token without current_user:read still answers, with a scope error. */
  async function accepted(): Promise<boolean> {
    const res = await send(`${API}/v1/me`, { 'X-Figma-Token': needToken() }, REQUEST_MS);
    if (res.ok) return true;
    if (res.status === 401) return false;
    if (res.status === 403) return /scope/i.test(errorText(await res.json().catch(() => null)));
    throw new FigmaError('failed', `Figma answered ${res.status} when checking the token. Try again in a moment.`, res.status);
  }

  /** Figma answers 403 for a bad token and for a file the token's account cannot open; the profile call tells the two apart. */
  async function forbidden(text: string): Promise<FigmaError> {
    if (/scope/i.test(text)) return new FigmaError('bad_token', NO_SCOPE);
    return (await accepted()) ? new FigmaError('no_access', NO_ACCESS) : new FigmaError('bad_token', BAD_TOKEN);
  }

  return {
    async check() {
      if (!(await accepted())) throw new FigmaError('bad_token', BAD_TOKEN);
    },
    async get<T>(path: string, query: Record<string, string>) {
      const res = await send(`${API}${path}?${new URLSearchParams(query)}`, { 'X-Figma-Token': needToken() }, REQUEST_MS);
      const body: unknown = await res.json().catch(() => null);
      if (res.ok) {
        if (!body || typeof body !== 'object') throw new FigmaError('failed', 'Figma sent an answer Gnomi could not read.', res.status);
        return body as T;
      }
      const text = errorText(body);
      if (res.status === 401) throw new FigmaError('bad_token', BAD_TOKEN);
      if (res.status === 403) throw await forbidden(text);
      if (res.status === 404) throw new FigmaError('not_found', 'Figma has no file at this link, or this token’s account cannot see it. Copy the link again from Figma.');
      if (res.status === 400) throw new FigmaError('failed', `Figma rejected the request${text ? `: ${text}` : ''}.`, 400);
      throw new FigmaError('failed', `Figma had a problem (${res.status}). Try again in a moment.`, res.status);
    },
    async download(url, max) {
      const target = URL.canParse(url) ? new URL(url) : null;
      if (target?.protocol !== 'https:' || !RENDER_HOST.test(target.hostname)) throw new FigmaError('failed', 'Figma gave an image address Gnomi does not trust.');
      const res = await send(url, {}, DOWNLOAD_MS);
      if (!res.ok || !res.body) throw new FigmaError('failed', `Figma’s image storage answered ${res.status}.`, res.status);
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (let part = await reader.read(); !part.done; part = await reader.read()) {
        total += part.value.length;
        if (total > max) {
          await reader.cancel();
          throw new FigmaError('failed', `The image is larger than ${max / (1024 * 1024)} MB.`);
        }
        chunks.push(part.value);
      }
      return Buffer.concat(chunks);
    },
  };
}
