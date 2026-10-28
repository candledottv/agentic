import type { Chain, LaunchRequest } from "./client";
import { CandleApiError } from "./errors";
export declare function embeddedLaunchWallet(wallet: LaunchRequest["wallet"]): boolean;
export declare function launchInputError(field: string, message: string, code?: string): CandleApiError;
/** Local shape refusals happen before discovery, build or signing. Server limits stay server-owned. */
export declare function validateLaunchInput(req: LaunchRequest): void;
/** Strip SDK controls and translate the whole-unit first buy without floating point rounding. */
export declare function launchBody(req: LaunchRequest, chain?: Chain): Omit<LaunchRequest, "wallet" | "buy">;
//# sourceMappingURL=launch-input.d.ts.map