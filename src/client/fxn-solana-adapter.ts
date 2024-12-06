// src/adapters/solana-adapter.ts

import { Program, AnchorProvider, IdlAccounts, BN } from '@coral-xyz/anchor';
import {
    PublicKey,
    SystemProgram,
    TransactionSignature, Signer
} from '@solana/web3.js';
import {
    createMint,
    getAssociatedTokenAddress,
    createAssociatedTokenAccount,
    mintTo
} from '@solana/spl-token';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import type { SubscriptionManager } from '@/types/subscription_manager';
import IDL from '@/types/idl/subscription_manager.json';

// Enhanced type definitions
export interface RenewParams {
    dataProvider: PublicKey;
    newRecipient: string;
    newEndTime: number;
    qualityScore: number;
    nftTokenAccount: PublicKey;
}

export interface CancelParams {
    dataProvider: PublicKey;
    qualityScore: number;
    nftTokenAccount?: PublicKey;
}

export interface SubscriptionState {
    endTime: BN;
    recipient: string;
}

// Properly typed account interfaces
type QualityInfoAccount = IdlAccounts<SubscriptionManager>['qualityInfo'];
type StateAccount = IdlAccounts<SubscriptionManager>['state'];
type SubscriptionAccount = IdlAccounts<SubscriptionManager>['subscription'];

// Enhanced error types
export enum SubscriptionErrorCode {
    PeriodTooShort = 6000,
    AlreadySubscribed = 6001,
    InsufficientPayment = 6002,
    InvalidNFTHolder = 6003,
    SubscriptionNotFound = 6004,
    QualityOutOfRange = 6005,
    SubscriptionAlreadyEnded = 6006,
    ActiveSubscription = 6007,
    NotOwner = 6008,
}

export interface CreateSubscriptionParams {
    dataProvider: PublicKey;
    recipient: string;
    durationInDays: number;
    nftTokenAccount: PublicKey;
}

export interface SubscriptionStatus {
    status: 'active' | 'expired' | 'expiring_soon';
    subscription: SubscriptionAccount;
}

export class FxnSolanaAdapter {
    program: Program<SubscriptionManager>;
    provider: AnchorProvider;

    constructor(provider: AnchorProvider) {
        if (!process.env.DEVNET_SUBSCRIPTION_MANAGER_ADDRESS) {
            throw new Error('Program ID not found in environment variables');
        }

        this.provider = provider;
        this.program = new Program<SubscriptionManager>(
            IDL as SubscriptionManager,
            provider
        );
    }

    // adapters/solana-adapter.ts
    async createSubscription(params: CreateSubscriptionParams): Promise<TransactionSignature> {
        if (!this.provider.wallet.publicKey) {
            throw new Error("Wallet not connected");
        }

        try {
            const subscriber = this.provider.wallet.publicKey;
            const pdas = this.getProgramAddresses(params.dataProvider, subscriber);

            // First, get the state account to get the correct owner
            const state = await this.program.account.state.fetch(pdas.statePDA);

            console.log('Debug info:', {
                stateOwner: state.owner.toString(),
                subscriber: subscriber.toString(),
                dataProvider: params.dataProvider.toString(),
                nftTokenAccount: params.nftTokenAccount.toString()
            });

            const txHash = await this.program.methods
                .subscribe(
                    params.recipient,
                    new BN(Math.floor(Date.now() / 1000) + (params.durationInDays * 24 * 60 * 60))
                )
                .accounts({
                    state: pdas.statePDA,
                    subscriber: subscriber,
                    dataProvider: params.dataProvider,
                    subscription: pdas.subscriptionPDA,
                    subscribersList: pdas.subscribersListPDA,
                    owner: state.owner, // Use the owner from the state account
                    systemProgram: SystemProgram.programId,
                    tokenProgram: TOKEN_PROGRAM_ID,
                    nftTokenAccount: params.nftTokenAccount,
                } as any)
                .rpc();

            return txHash;
        } catch (error) {
            console.error('Error creating subscription:', error);
            throw this.handleError(error);
        }
    }

    getSubscriptionStatus(endTime: BN): 'active' | 'expired' | 'expiring_soon' {
        const now = Math.floor(Date.now() / 1000);
        const endTimeSeconds = endTime.toNumber();
        const daysUntilExpiration = (endTimeSeconds - now) / (24 * 60 * 60);

        if (endTimeSeconds <= now) {
            return 'expired';
        } else if (daysUntilExpiration <= 7) {
            return 'expiring_soon';
        }
        return 'active';
    }

    async getProviderTokenAccount(providerAddress: PublicKey): Promise<PublicKey> {
        const nftMint = new PublicKey(process.env.DEVNET_NFT_TOKEN_ADDRESS!);

        try {
            const tokenAccount = await getAssociatedTokenAddress(
                nftMint,
                providerAddress,
                false
            );

            const tokenAccountInfo = await this.provider.connection.getAccountInfo(tokenAccount);
            if (!tokenAccountInfo) {
                throw new Error('Provider does not have the required NFT');
            }

            return tokenAccount;
        } catch (error) {
            console.error('Error getting provider token account:', error);
            throw this.handleError(error);
        }
    }

    // adapters/solana-adapter.ts
    async getAgentSubscribers(agentAddress: PublicKey): Promise<PublicKey[]> {
        try {
            const [subscribersListPDA] = PublicKey.findProgramAddressSync(
                [Buffer.from("subscribers"), agentAddress.toBuffer()],
                this.program.programId
            );

            console.log('Fetching subscribers for agent:', {
                agent: agentAddress.toString(),
                subscribersListPDA: subscribersListPDA.toString()
            });

            try {
                // Try to fetch the subscribers list account
                const subscribersList = await this.program.account.subscribersList.fetch(
                    subscribersListPDA
                );

                console.log('Found subscribers:', subscribersList.subscribers.map(s => s.toString()));

                return subscribersList.subscribers;
            } catch (error) {
                console.log('No subscribers list found, returning empty array');
                return [];
            }
        } catch (error) {
            console.error('Error getting agent subscribers:', error);
            throw this.handleError(error);
        }
    }

// Also add this method to get active subscriptions
    async getActiveSubscriptionsForAgent(agentAddress: PublicKey): Promise<number> {
        try {
            // Get all subscribers first
            const subscribers = await this.getAgentSubscribers(agentAddress);

            // For each subscriber, check if they have an active subscription
            let activeCount = 0;

            for (const subscriber of subscribers) {
                const [subscriptionPDA] = PublicKey.findProgramAddressSync(
                    [
                        Buffer.from("subscription"),
                        subscriber.toBuffer(),
                        agentAddress.toBuffer(),
                    ],
                    this.program.programId
                );

                try {
                    const subscription = await this.program.account.subscription.fetch(
                        subscriptionPDA
                    );

                    // Check if subscription is active
                    if (subscription.endTime.gt(new BN(Math.floor(Date.now() / 1000)))) {
                        activeCount++;
                    }
                } catch (error) {
                    // Subscription not found or error, continue to next subscriber
                    continue;
                }
            }

            return activeCount;
        } catch (error) {
            console.error('Error getting active subscriptions:', error);
            throw this.handleError(error);
        }
    }

    // adapters/solana-adapter.ts
    async getAllSubscriptionsForUser(userPublicKey: PublicKey): Promise<SubscriptionStatus[]> {
        try {
            const subscriptionAccounts = await this.program.account.subscription.all();

            console.log('Found subscription accounts:', subscriptionAccounts.length);

            const userSubscriptions = subscriptionAccounts
                .filter(account => {
                    console.log('Subscription account:', {
                        pubkey: account.publicKey.toString(),
                        endTime: account.account.endTime.toString(),
                        recipient: account.account.recipient
                    });

                    return account.account.endTime.gt(new BN(Math.floor(Date.now() / 1000)));
                })
                .map(account => ({
                    subscription: account.account,
                    subscriptionPDA: account.publicKey, // Include the PDA
                    status: this.getSubscriptionStatus(account.account.endTime),
                }));

            console.log('Filtered user subscriptions:', userSubscriptions.length);

            return userSubscriptions;
        } catch (error) {
            console.error('Error fetching subscriptions:', error);
            throw this.handleError(error);
        }
    }

    async renewSubscription(params: RenewParams): Promise<TransactionSignature> {
        if (!this.provider.wallet.publicKey) {
            throw new Error("Wallet not connected");
        }

        try {
            const subscriber = this.provider.wallet.publicKey;
            const pdas = this.getProgramAddresses(params.dataProvider, subscriber);

            // Initialize quality info if it doesn't exist
            try {
                await this.program.account.qualityInfo.fetch(pdas.qualityPDA);
            } catch (e) {
                await this.program.methods
                    .initializeQualityInfo()
                    .accounts({
                        qualityInfo: pdas.qualityPDA,
                        dataProvider: params.dataProvider,
                        payer: subscriber,
                        systemProgram: SystemProgram.programId,
                    } as any)
                    .rpc();
            }

            // Get the state account to verify the owner
            const state = await this.program.account.state.fetch(pdas.statePDA) as StateAccount;

            // Send renewal transaction
            const txHash = await this.program.methods
                .renewSubscription(
                    params.newRecipient,
                    new BN(params.newEndTime),
                    params.qualityScore
                )
                .accounts({
                    state: pdas.statePDA,
                    subscriber: subscriber,
                    dataProvider: params.dataProvider,
                    subscription: pdas.subscriptionPDA,
                    qualityInfo: pdas.qualityPDA,
                    owner: state.owner,
                    systemProgram: SystemProgram.programId,
                    tokenProgram: TOKEN_PROGRAM_ID,
                    nftTokenAccount: params.nftTokenAccount,
                } as any)
                .rpc();

            return txHash;
        } catch (error) {
            console.error('Error in renewSubscription:', error);
            throw this.handleError(error);
        }
    }

    async mintRegistrationNFT(): Promise<{
        mint: PublicKey;
        tokenAccount: PublicKey;
    }> {
        if (!this.provider.wallet.publicKey) {
            throw new Error("Wallet not connected");
        }

        try {
            // Create the mint account
            const mint = await createMint(
                this.provider.connection,
                this.provider.wallet as unknown as Signer,
                this.provider.wallet.publicKey,
                null,
                0,
                undefined,
                { commitment: 'confirmed' },
                TOKEN_PROGRAM_ID
            );

            // Create associated token account
            const tokenAccount = await createAssociatedTokenAccount(
                this.provider.connection,
                this.provider.wallet as unknown as Signer,
                mint,
                this.provider.wallet.publicKey
            );

            // Mint one token
            await mintTo(
                this.provider.connection,
                this.provider.wallet as unknown as Signer,
                mint,
                tokenAccount,
                this.provider.wallet.publicKey,
                1
            );

            return { mint, tokenAccount };
        } catch (error) {
            console.error('Error minting registration NFT:', error);
            throw this.handleError(error);
        }
    }

    async cancelSubscription(params: CancelParams): Promise<TransactionSignature> {
        if (!this.provider.wallet.publicKey) {
            throw new Error("Wallet not connected");
        }

        try {
            const subscriber = this.provider.wallet.publicKey;
            const pdas = this.getProgramAddresses(params.dataProvider, subscriber);

            const txHash = await this.program.methods
                .cancelSubscription(params.qualityScore)
                .accounts({
                    subscriber: subscriber,
                    dataProvider: params.dataProvider,
                    subscription: pdas.subscriptionPDA,
                    qualityInfo: pdas.qualityPDA,
                    tokenProgram: TOKEN_PROGRAM_ID,
                    nftTokenAccount: params.nftTokenAccount,
                } as any)
                .rpc();

            return txHash;
        } catch (error) {
            console.error('Error in cancelSubscription:', error);
            throw this.handleError(error);
        }
    }

    async getSubscriptionState(subscriptionPDA: PublicKey): Promise<SubscriptionAccount> {
        try {
            return await this.program.account.subscription.fetch(subscriptionPDA) as SubscriptionAccount;
        } catch (error) {
            console.error('Error fetching subscription state:', error);
            throw this.handleError(error);
        }
    }

    async getQualityInfo(dataProvider: PublicKey): Promise<QualityInfoAccount> {
        try {
            const [qualityPDA] = PublicKey.findProgramAddressSync(
                [Buffer.from("quality"), dataProvider.toBuffer()],
                this.program.programId
            );
            return await this.program.account.qualityInfo.fetch(qualityPDA) as QualityInfoAccount;
        } catch (error) {
            console.error('Error fetching quality info:', error);
            throw this.handleError(error);
        }
    }

    getProgramAddresses(dataProvider: PublicKey, subscriber: PublicKey): {
        statePDA: PublicKey;
        qualityPDA: PublicKey;
        subscriptionPDA: PublicKey;
        subscribersListPDA: PublicKey;
    } {
        const [statePDA] = PublicKey.findProgramAddressSync(
            [Buffer.from("storage")],
            this.program.programId
        );

        const [qualityPDA] = PublicKey.findProgramAddressSync(
            [Buffer.from("quality"), dataProvider.toBuffer()],
            this.program.programId
        );

        const [subscriptionPDA] = PublicKey.findProgramAddressSync(
            [
                Buffer.from("subscription"),
                subscriber.toBuffer(),
                dataProvider.toBuffer(),
            ],
            this.program.programId
        );

        const [subscribersListPDA] = PublicKey.findProgramAddressSync(
            [Buffer.from("subscribers"), dataProvider.toBuffer()],
            this.program.programId
        );

        return {
            statePDA,
            qualityPDA,
            subscriptionPDA,
            subscribersListPDA,
        };
    }

    private handleError(error: any): Error {
        // Check if it's a program error with a code
        if (error.code !== undefined) {
            switch (error.code) {
                case SubscriptionErrorCode.PeriodTooShort:
                    return new Error('Subscription period is too short');
                case SubscriptionErrorCode.AlreadySubscribed:
                    return new Error('Already subscribed');
                case SubscriptionErrorCode.InsufficientPayment:
                    return new Error('Insufficient payment');
                case SubscriptionErrorCode.InvalidNFTHolder:
                    return new Error('Invalid NFT holder');
                case SubscriptionErrorCode.SubscriptionNotFound:
                    return new Error('Subscription not found');
                case SubscriptionErrorCode.QualityOutOfRange:
                    return new Error('Quality score must be between 0 and 100');
                case SubscriptionErrorCode.SubscriptionAlreadyEnded:
                    return new Error('Subscription has already ended');
                case SubscriptionErrorCode.ActiveSubscription:
                    return new Error('Subscription is still active');
                case SubscriptionErrorCode.NotOwner:
                    return new Error('Not the contract owner');
                default:
                    return new Error(`Unknown error: ${error.message}`);
            }
        }

        // If it's not a program error, return the original error
        return error instanceof Error ? error : new Error(String(error));
    }
}
