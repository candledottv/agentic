/**
 * How an RPC endpoint is named in an error message.
 *
 * Every JSON-RPC failure the SDK throws used to interpolate the endpoint URL verbatim, and most
 * Solana and EVM providers authenticate by API key: Helius carries it in the query string
 * (`?api-key=...`), Alchemy in the path (`/v2/<key>`). So a thrown message could contain a live
 * credential, and error messages are the most widely copied strings a program produces -- they
 * reach logs, alerting, exception trackers, support tickets and chat.
 *
 * That is not hypothetical. A caller forwarded one of these messages to a Discord alert channel
 * on 2026-08-27 and had to rotate a production Helius key. They fixed the forwarding; this makes
 * the SDK stop handing out the credential in the first place, so the next caller cannot make the
 * same mistake as cheaply.
 *
 * The origin is what survives. `https://mainnet.helius-rpc.com/?api-key=SECRET` and
 * `https://x.g.alchemy.com/v2/SECRET` both reduce to their host, which is the part with
 * diagnostic value -- WHICH provider refused, paired with the method name the caller already
 * has. Neither the path nor the query is ever needed to read one of these errors.
 */
/**
 * The endpoint as it may appear in an error message: scheme and host, never the path or query.
 *
 * Never throws. It is called only while BUILDING an error, so a throw here would replace a real
 * failure with a URL-parsing one and lose the original entirely. A value that will not parse is
 * therefore reported as unknown rather than passed through -- passing it through is exactly the
 * leak this exists to prevent, and a caller who configured a malformed URL has a bigger problem
 * this message would not help with.
 */
export declare function describeRpcEndpoint(url: string): string;
//# sourceMappingURL=rpc-endpoint.d.ts.map