export declare const LAUNCH_DEFINITION: {
    readonly version: 1;
    readonly wallet: {
        readonly embeddedNames: readonly ["embedded", "main"];
        readonly help: "The paying wallet: a TEE wallet name, or embedded (main) for the account's embedded wallet.";
    };
    readonly quoteDecimals: {
        readonly sol: 9;
        readonly usdc: 6;
        readonly cndl: 6;
        readonly eth: 18;
        readonly usdg: 6;
    };
    readonly quoteChains: {
        readonly sol: "solana";
        readonly usdc: "solana";
        readonly cndl: "solana";
        readonly eth: "hood";
        readonly usdg: "hood";
    };
    readonly defaultQuote: {
        readonly solana: "sol";
        readonly hood: "eth";
    };
    readonly buyLimits: {
        readonly defaults: {
            readonly sol: {
                readonly env: "DEV_BUY_MAX_LAMPORTS";
                readonly raw: "500000000";
                readonly unit: "lamports";
            };
            readonly usdc: {
                readonly env: "DEV_BUY_MAX_USDC_RAW";
                readonly raw: "500000000";
                readonly unit: "USDC raw units";
            };
            readonly cndl: {
                readonly env: "DEV_BUY_MAX_CNDL_RAW";
                readonly raw: "2000000000000";
                readonly unit: "CNDL raw units";
            };
            readonly eth: {
                readonly env: "DEV_BUY_MAX_WEI";
                readonly raw: "20000000000000000";
                readonly unit: "wei";
            };
        };
        readonly thresholdBps: 1000;
        readonly presetThresholds: {
            readonly "exp-a": {
                readonly sol: "5000000000";
                readonly cndl: "330000000000";
            };
            readonly "exp-b": {
                readonly sol: "5000000000";
                readonly cndl: "330000000000";
            };
            readonly "exp-c": {
                readonly sol: "5000000000";
                readonly cndl: "330000000000";
            };
        };
    };
    readonly surfacesIntro: readonly ["CLI: scripts and terminals. Agents always pass --json.", "MCP: chat agents (Claude, the connector). The same launch fields and results as the CLI's --json.", "SDK: code that embeds Candle."];
    readonly fields: readonly [{
        readonly key: "wallet";
        readonly type: "string";
        readonly help: "The paying wallet: a TEE wallet name, or embedded (main) for the account's embedded wallet.";
        readonly required: true;
        readonly surfaces: {
            readonly cli: {
                readonly flag: "--wallet";
                readonly value: "<tee>|embedded";
            };
            readonly mcp: {
                readonly key: "wallet";
            };
            readonly sdk: {
                readonly key: "wallet";
            };
        };
    }, {
        readonly key: "clientLaunchId";
        readonly type: "string";
        readonly help: "An idempotency key of at most 128 characters; reuse it to recover the same launch.";
        readonly range: {
            readonly min: "1";
            readonly max: "128";
            readonly unit: "characters";
        };
        readonly surfaces: {
            readonly cli: {
                readonly flag: "--client-trade-id";
                readonly value: "<id>";
            };
            readonly mcp: {
                readonly key: "clientLaunchId";
            };
            readonly sdk: {
                readonly key: "clientLaunchId";
            };
        };
    }, {
        readonly key: "name";
        readonly type: "string";
        readonly help: "The token's name, at most 32 UTF-8 bytes.";
        readonly required: true;
        readonly range: {
            readonly min: "1";
            readonly max: "32";
            readonly unit: "UTF-8 bytes";
        };
        readonly surfaces: {
            readonly cli: {
                readonly flag: "--name";
                readonly value: "<name>";
            };
            readonly mcp: {
                readonly key: "name";
            };
            readonly sdk: {
                readonly key: "name";
            };
        };
    }, {
        readonly key: "symbol";
        readonly type: "string";
        readonly help: "The token's ticker, at most 10 UTF-8 bytes.";
        readonly required: true;
        readonly range: {
            readonly min: "1";
            readonly max: "10";
            readonly unit: "UTF-8 bytes";
        };
        readonly surfaces: {
            readonly cli: {
                readonly flag: "--symbol";
                readonly value: "<symbol>";
            };
            readonly mcp: {
                readonly key: "symbol";
            };
            readonly sdk: {
                readonly key: "symbol";
            };
        };
    }, {
        readonly key: "imageUrl";
        readonly type: "url";
        readonly help: "The roughly square token image at an https URL; --image <path> uploads a local file instead.";
        readonly required: true;
        readonly surfaces: {
            readonly cli: {
                readonly flag: "--image-url";
                readonly value: "<https-url>";
            };
            readonly mcp: {
                readonly key: "imageUrl";
            };
            readonly sdk: {
                readonly key: "imageUrl";
            };
        };
    }, {
        readonly key: "bannerUrl";
        readonly type: "url";
        readonly help: "A wide banner at an https URL or a local file; uploads are public and permanent.";
        readonly surfaces: {
            readonly cli: {
                readonly flag: "--banner";
                readonly value: "<file|URL>";
            };
            readonly mcp: {
                readonly key: "bannerUrl";
            };
            readonly sdk: {
                readonly key: "bannerUrl";
            };
        };
    }, {
        readonly key: "description";
        readonly type: "string";
        readonly help: "The token's description, safe for on-chain JSON.";
        readonly surfaces: {
            readonly cli: {
                readonly flag: "--description";
                readonly value: "<text>";
            };
            readonly mcp: {
                readonly key: "description";
            };
            readonly sdk: {
                readonly key: "description";
            };
        };
    }, {
        readonly key: "socials.website";
        readonly type: "url";
        readonly help: "The token's website link as an absolute http(s) URL.";
        readonly surfaces: {
            readonly cli: {
                readonly flag: "--website";
                readonly value: "<url>";
            };
            readonly mcp: {
                readonly key: "socials.website";
            };
            readonly sdk: {
                readonly key: "socials.website";
            };
        };
    }, {
        readonly key: "socials.twitter";
        readonly type: "url";
        readonly help: "The token's X link as an absolute http(s) URL.";
        readonly surfaces: {
            readonly cli: {
                readonly flag: "--x";
                readonly value: "<url>";
            };
            readonly mcp: {
                readonly key: "socials.twitter";
            };
            readonly sdk: {
                readonly key: "socials.twitter";
            };
        };
    }, {
        readonly key: "socials.telegram";
        readonly type: "url";
        readonly help: "The token's telegram link as an absolute http(s) URL.";
        readonly surfaces: {
            readonly cli: {
                readonly flag: "--telegram";
                readonly value: "<url>";
            };
            readonly mcp: {
                readonly key: "socials.telegram";
            };
            readonly sdk: {
                readonly key: "socials.telegram";
            };
        };
    }, {
        readonly key: "socials.discord";
        readonly type: "url";
        readonly help: "The token's discord link as an absolute http(s) URL.";
        readonly surfaces: {
            readonly cli: {
                readonly flag: "--discord";
                readonly value: "<url>";
            };
            readonly mcp: {
                readonly key: "socials.discord";
            };
            readonly sdk: {
                readonly key: "socials.discord";
            };
        };
    }, {
        readonly key: "chain";
        readonly type: "enum";
        readonly values: readonly ["solana", "hood"];
        readonly default: "solana";
        readonly help: "The launch chain, inferred from the wallet, quote asset and dex version on the CLI.";
        readonly surfaces: {
            readonly cli: {
                readonly derived: "wallet, --quote-asset and --dex-version";
            };
            readonly mcp: {
                readonly key: "chain";
            };
            readonly sdk: {
                readonly key: "chain";
            };
        };
    }, {
        readonly key: "quoteAsset";
        readonly type: "enum";
        readonly help: "The quote asset: sol, usdc or cndl on Solana; eth or usdg on Hood (defaults sol and eth).";
        readonly values: readonly ["sol", "usdc", "cndl", "eth", "usdg"];
        readonly surfaces: {
            readonly cli: {
                readonly flag: "--quote-asset";
                readonly value: "sol|usdc|cndl|eth|usdg";
            };
            readonly mcp: {
                readonly key: "quoteAsset";
            };
            readonly sdk: {
                readonly key: "quoteAsset";
            };
        };
    }, {
        readonly key: "mode";
        readonly type: "enum";
        readonly help: "The curve mode: open or exclusive; test-open or test-exclusive need ENABLE_TEST_CURVES; exp-a, exp-b, exp-c and exp-custom are Solana sol/cndl only.";
        readonly values: readonly ["open", "exclusive", "test-open", "test-exclusive", "exp-a", "exp-b", "exp-c", "exp-custom"];
        readonly default: "open";
        readonly surfaces: {
            readonly cli: {
                readonly flag: "--mode";
                readonly value: "<mode>";
            };
            readonly mcp: {
                readonly key: "mode";
            };
            readonly sdk: {
                readonly key: "mode";
            };
        };
    }, {
        readonly key: "curve.virtualQuote";
        readonly type: "decimal";
        readonly help: "exp-custom's virtual quote, in whole quote units: 1 to 100 SOL or 66000 to 6600000 CNDL; requires --curve-g and EXP_CUSTOM_CURVES.";
        readonly modes: readonly ["exp-custom"];
        readonly chains: readonly ["solana"];
        readonly requires: readonly ["curve.threshold"];
        readonly range: {
            readonly unit: "whole quote units";
            readonly byQuote: {
                readonly sol: {
                    readonly min: "1";
                    readonly max: "100";
                };
                readonly cndl: {
                    readonly min: "66000";
                    readonly max: "6600000";
                };
            };
        };
        readonly surfaces: {
            readonly cli: {
                readonly flag: "--curve-v";
                readonly value: "<V>";
            };
            readonly mcp: {
                readonly key: "curve.virtualQuote";
            };
            readonly sdk: {
                readonly key: "curve.virtualQuote";
            };
        };
    }, {
        readonly key: "curve.threshold";
        readonly type: "decimal";
        readonly help: "exp-custom's graduation threshold, in whole quote units: 1 to 250 SOL or 66000 to 16500000 CNDL; requires --curve-v and EXP_CUSTOM_CURVES.";
        readonly modes: readonly ["exp-custom"];
        readonly chains: readonly ["solana"];
        readonly requires: readonly ["curve.virtualQuote"];
        readonly range: {
            readonly unit: "whole quote units";
            readonly byQuote: {
                readonly sol: {
                    readonly min: "1";
                    readonly max: "250";
                };
                readonly cndl: {
                    readonly min: "66000";
                    readonly max: "16500000";
                };
            };
        };
        readonly surfaces: {
            readonly cli: {
                readonly flag: "--curve-g";
                readonly value: "<G>";
            };
            readonly mcp: {
                readonly key: "curve.threshold";
            };
            readonly sdk: {
                readonly key: "curve.threshold";
            };
        };
    }, {
        readonly key: "creatorFeeBps";
        readonly type: "enum";
        readonly help: "An exp- mode's extra creator fee: 0, 100 or 200 bps on the curve and pool, paid to the creator in full.";
        readonly values: readonly [0, 100, 200];
        readonly default: 0;
        readonly surfaces: {
            readonly cli: {
                readonly flag: "--creator-fee-bps";
                readonly value: "0|100|200";
            };
            readonly mcp: {
                readonly key: "creatorFeeBps";
            };
            readonly sdk: {
                readonly key: "creatorFeeBps";
            };
        };
    }, {
        readonly key: "stakerAllocationBps";
        readonly type: "integer";
        readonly help: "The staker allocation, 50 to 1000 bps; defaults to 50, or 500 on exp- curves.";
        readonly range: {
            readonly min: "50";
            readonly max: "1000";
            readonly unit: "bps";
        };
        readonly default: 50;
        readonly surfaces: {
            readonly cli: {
                readonly flag: "--staker-allocation-bps";
                readonly value: "<bps>";
            };
            readonly mcp: {
                readonly key: "stakerAllocationBps";
            };
            readonly sdk: {
                readonly key: "stakerAllocationBps";
            };
        };
    }, {
        readonly key: "poolFee.tier";
        readonly type: "enum";
        readonly help: "Solana's graduated pool fee: 25, 50 or 100 bps (default 50), or the ending rate with --pool-fee-from.";
        readonly values: readonly [25, 50, 100];
        readonly default: 50;
        readonly chains: readonly ["solana"];
        readonly surfaces: {
            readonly cli: {
                readonly flag: "--pool-fee";
                readonly value: "25|50|100";
            };
            readonly mcp: {
                readonly key: "poolFee.tier";
            };
            readonly sdk: {
                readonly key: "poolFee.tier";
            };
        };
    }, {
        readonly key: "poolFee.startBps";
        readonly type: "integer";
        readonly help: "The falling pool fee's starting rate, at most 2500 bps; requires --pool-fee and --pool-fee-minutes.";
        readonly range: {
            readonly min: "25";
            readonly max: "2500";
            readonly unit: "bps";
        };
        readonly chains: readonly ["solana"];
        readonly requires: readonly ["poolFee.tier", "poolFee.minutes"];
        readonly surfaces: {
            readonly cli: {
                readonly flag: "--pool-fee-from";
                readonly value: "<bps>";
            };
            readonly mcp: {
                readonly key: "poolFee.startBps";
            };
            readonly sdk: {
                readonly key: "poolFee.startBps";
            };
        };
    }, {
        readonly key: "poolFee.minutes";
        readonly type: "decimal";
        readonly help: "The pool fee's fall time, at most 30 minutes; requires --pool-fee and --pool-fee-from.";
        readonly wireType: "number";
        readonly range: {
            readonly min: "0.006666666666666667";
            readonly max: "30";
            readonly unit: "minutes";
        };
        readonly chains: readonly ["solana"];
        readonly requires: readonly ["poolFee.tier", "poolFee.startBps"];
        readonly surfaces: {
            readonly cli: {
                readonly flag: "--pool-fee-minutes";
                readonly value: "<min>";
            };
            readonly mcp: {
                readonly key: "poolFee.minutes";
            };
            readonly sdk: {
                readonly key: "poolFee.minutes";
            };
        };
    }, {
        readonly key: "poolFee.endBps";
        readonly type: "enum";
        readonly values: readonly [25, 50, 100];
        readonly chains: readonly ["solana"];
        readonly help: "The falling fee's ending rate, taken from --pool-fee.";
        readonly surfaces: {
            readonly cli: {
                readonly derived: "--pool-fee with --pool-fee-from";
            };
            readonly mcp: {
                readonly key: "poolFee.endBps";
            };
            readonly sdk: {
                readonly key: "poolFee.endBps";
            };
        };
    }, {
        readonly key: "poolOpen";
        readonly type: "enum";
        readonly help: "Solana preset pools: curve_price opens at the curve's last price and burns the rest; omitted uses curve_price when allocations fit graduation.maxStakerCarveBps, otherwise legacy; explicit curve_price above that limit is refused.";
        readonly values: readonly ["legacy", "curve_price"];
        readonly chains: readonly ["solana"];
        readonly surfaces: {
            readonly cli: {
                readonly flag: "--pool-open";
                readonly value: "legacy|curve_price";
            };
            readonly mcp: {
                readonly key: "poolOpen";
            };
            readonly sdk: {
                readonly key: "poolOpen";
            };
        };
    }, {
        readonly key: "expPoolShape";
        readonly type: "enum";
        readonly help: "Solana exp- pools: floor by default, or full_range to open across the whole price range.";
        readonly values: readonly ["floor", "full_range"];
        readonly default: "floor";
        readonly chains: readonly ["solana"];
        readonly surfaces: {
            readonly cli: {
                readonly flag: "--exp-pool-shape";
                readonly value: "floor|full_range";
            };
            readonly mcp: {
                readonly key: "expPoolShape";
            };
            readonly sdk: {
                readonly key: "expPoolShape";
            };
        };
    }, {
        readonly key: "dexVersion";
        readonly type: "enum";
        readonly help: "Hood only, required there: the Uniswap version the curve graduates to.";
        readonly values: readonly ["v3", "v4"];
        readonly chains: readonly ["hood"];
        readonly surfaces: {
            readonly cli: {
                readonly flag: "--dex-version";
                readonly value: "v3|v4";
            };
            readonly mcp: {
                readonly key: "dexVersion";
            };
            readonly sdk: {
                readonly key: "dexVersion";
            };
        };
    }, {
        readonly key: "visibility";
        readonly type: "enum";
        readonly help: "The token's visibility: production, test, local or hidden; test keys require test or hidden.";
        readonly values: readonly ["production", "test", "local", "hidden"];
        readonly default: "production";
        readonly surfaces: {
            readonly cli: {
                readonly flag: "--visibility";
                readonly value: "production|test|local|hidden";
            };
            readonly mcp: {
                readonly key: "visibility";
            };
            readonly sdk: {
                readonly key: "visibility";
            };
        };
    }, {
        readonly key: "buy";
        readonly type: "decimal";
        readonly help: "An optional first buy in whole quote units; zero or empty means no buy, and the server applies dev-buy ceilings and TEE_LAUNCH_BUYS_ENABLED for TEE buys.";
        readonly default: "0";
        readonly range: {
            readonly min: "0";
            readonly unit: "whole quote units";
        };
        readonly more: "Default raw caps (apps/api/src/lib/headless-validation.ts): DEV_BUY_MAX_LAMPORTS=500000000, DEV_BUY_MAX_USDC_RAW=500000000, DEV_BUY_MAX_CNDL_RAW=2000000000000, DEV_BUY_MAX_WEI=20000000000000000. On exp- curves the lower of the quote cap and 10% of G applies.";
        readonly surfaces: {
            readonly cli: {
                readonly flag: "--buy";
                readonly value: "<amount>";
            };
            readonly mcp: {
                readonly key: "buy";
            };
            readonly sdk: {
                readonly key: "buy";
            };
        };
    }, {
        readonly key: "dryRun";
        readonly type: "boolean";
        readonly help: "Print the launch preview without building, signing or recording a launch; local image uploads still become public and permanent.";
        readonly default: false;
        readonly surfaces: {
            readonly cli: {
                readonly flag: "--dry-run";
            };
            readonly mcp: {
                readonly key: "dryRun";
            };
            readonly sdk: {
                readonly key: "dryRun";
            };
        };
    }];
};
export interface GeneratedLaunchFields {
    wallet?: string;
    clientLaunchId?: string;
    name: string;
    symbol: string;
    imageUrl: string;
    bannerUrl?: string;
    description?: string;
    socials?: {
        website?: string;
        twitter?: string;
        telegram?: string;
        discord?: string;
    };
    chain?: "solana" | "hood";
    quoteAsset?: "sol" | "usdc" | "cndl" | "eth" | "usdg";
    mode?: "open" | "exclusive" | "test-open" | "test-exclusive" | "exp-a" | "exp-b" | "exp-c" | "exp-custom";
    curve?: {
        virtualQuote?: string;
        threshold?: string;
    };
    creatorFeeBps?: 0 | 100 | 200;
    stakerAllocationBps?: number;
    poolFee?: {
        tier?: 25 | 50 | 100;
        startBps?: number;
        minutes?: number;
        endBps?: 25 | 50 | 100;
    };
    poolOpen?: "legacy" | "curve_price";
    expPoolShape?: "floor" | "full_range";
    dexVersion?: "v3" | "v4";
    visibility?: "production" | "test" | "local" | "hidden";
    buy?: string;
    dryRun?: boolean;
}
//# sourceMappingURL=launch-definition.d.ts.map