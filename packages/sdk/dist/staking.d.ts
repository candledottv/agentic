/** Agent staking is Solana-only. Builds for linked wallets return bytes for external signing. */
export type StakingPayer = {
    payer?: "main";
    linkedWalletId?: never;
} | {
    payer: "linked";
    linkedWalletId: string;
};
export type StakeRequest = StakingPayer & {
    amountRaw: string;
    clientStakeId: string;
    dryRun?: boolean;
};
export type FinishUnstakeRequest = StakingPayer & {
    withdrawal: string;
    clientStakeId: string;
    dryRun?: boolean;
};
export interface StakingWithdrawal {
    withdrawal: string;
    amountRaw: string;
    startTime: string;
    endTime: string;
    claimTime?: string;
    claimable: boolean;
}
export interface StakingWalletPosition {
    payer: "main" | "linked";
    address: string;
    linkedWalletId?: string;
    tee?: boolean;
    label?: string | null;
    delegated?: boolean;
    cndl: {
        mint: string;
        decimals: number;
        amountRaw: string;
    };
    staked: {
        mint: string;
        decimals: number;
        amountRaw: string;
        cndlValueRaw: string;
    };
    pendingWithdrawalRaw: string;
    withdrawals: {
        active: StakingWithdrawal[];
        finished: StakingWithdrawal[];
    };
    unclaimedRewards: Array<{
        rewardId: string;
        mint: string;
        symbol: string | null;
        name: string | null;
        amountRaw: string;
        distributedAt: number | null;
        claiming: boolean;
    }>;
}
export interface StakingPositions {
    success: true;
    pool: {
        withdrawalTimelockSeconds: number;
        paused: boolean;
        maxActiveWithdrawals: number;
    } | null;
    wallets: StakingWalletPosition[];
    notes: string[];
}
export interface StakingFigures {
    networkFeeLamports: string;
    priorityFeeLamports: string;
    rentLamports: string;
    reserveLamports: string;
    requiredLamports: string;
    balanceLamports: string;
    creates: string[];
}
interface StakingOperation {
    success: true;
    action: "stake" | "unstake" | "finish";
    payer: "main" | "linked";
    linkedWalletId?: string;
    wallet: string;
    clientStakeId: string;
    amountRaw?: string;
    withdrawal?: string;
    figures?: StakingFigures;
}
export type StakingResult = StakingOperation & ({
    dryRun: true;
} | {
    dryRun: false;
    replay: boolean;
    status: "built";
    transaction: string;
    recentBlockhash: string;
    builtAt: number;
    lastValidBlockHeight: number;
    warnings: string[];
} | {
    dryRun: false;
    replay: boolean;
    status: "confirmed";
    signature: string;
    builtAt: number;
    lastValidBlockHeight: number;
    warnings: string[];
});
export interface StakingRewardClaim {
    success: true;
    rewardId: string;
    owner: string;
    mint: string;
    amountRaw: string;
    signature: string;
}
export interface CandleStaking {
    positions(): Promise<StakingPositions>;
    /** MOVES REAL FUNDS for the embedded payer; linked/TEE payers return a build to sign. Reuse the id on retry. */
    stake(request: StakeRequest): Promise<StakingResult>;
    /** Start the pool's wait. No instant unstake. Input is raw sCNDL, not CNDL value. */
    unstake(request: StakeRequest): Promise<StakingResult>;
    finish(request: FinishUnstakeRequest): Promise<StakingResult>;
    claimReward(rewardId: string): Promise<StakingRewardClaim>;
    submit(request: {
        clientStakeId: string;
        signedTransaction: string;
    }): Promise<StakingResult>;
    confirm(request: {
        clientStakeId: string;
        signature: string;
    }): Promise<StakingResult>;
}
export {};
//# sourceMappingURL=staking.d.ts.map