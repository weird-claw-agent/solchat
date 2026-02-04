import {
  Connection,
  PublicKey,
  Keypair,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { Program, AnchorProvider, BN, Wallet } from "@coral-xyz/anchor";

// Program ID - will be updated after deployment
export const SOLCHAT_PROGRAM_ID = new PublicKey(
  "SoLChATxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
);

export interface Channel {
  name: string;
  creator: PublicKey;
  subscriberCount: BN;
  messageCount: BN;
  createdAt: BN;
  bump: number;
}

export interface Subscription {
  subscriber: PublicKey;
  channel: PublicKey;
  subscribedAt: BN;
  bump: number;
}

export interface Message {
  channel: PublicKey;
  sender: PublicKey;
  content: string;
  timestamp: BN;
  index: BN;
  bump: number;
}

export interface MessageEvent {
  channel: PublicKey;
  channelName: string;
  sender: PublicKey;
  content: string;
  timestamp: number;
  index: number;
}

export class SolChat {
  private connection: Connection;
  private wallet: Wallet;
  private provider: AnchorProvider;
  private programId: PublicKey;

  constructor(
    connection: Connection,
    wallet: Wallet,
    programId: PublicKey = SOLCHAT_PROGRAM_ID
  ) {
    this.connection = connection;
    this.wallet = wallet;
    this.programId = programId;
    this.provider = new AnchorProvider(connection, wallet, {
      commitment: "confirmed",
    });
  }

  // ========== PDA Derivations ==========

  getChannelPDA(name: string): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("channel"), Buffer.from(name)],
      this.programId
    );
  }

  getSubscriptionPDA(
    channelPubkey: PublicKey,
    subscriber: PublicKey
  ): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from("subscription"),
        channelPubkey.toBuffer(),
        subscriber.toBuffer(),
      ],
      this.programId
    );
  }

  getMessagePDA(
    channelPubkey: PublicKey,
    messageIndex: BN
  ): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from("message"),
        channelPubkey.toBuffer(),
        messageIndex.toArrayLike(Buffer, "le", 8),
      ],
      this.programId
    );
  }

  // ========== Channel Operations ==========

  async createChannel(name: string): Promise<string> {
    const [channelPDA] = this.getChannelPDA(name);

    // Build instruction manually since we don't have IDL loaded
    const discriminator = Buffer.from([
      0x19, 0x5e, 0x29, 0x20, 0xf1, 0x44, 0x58, 0x08,
    ]); // create_channel discriminator

    const nameBuffer = Buffer.from(name);
    const nameLenBuffer = Buffer.alloc(4);
    nameLenBuffer.writeUInt32LE(nameBuffer.length);

    const data = Buffer.concat([discriminator, nameLenBuffer, nameBuffer]);

    const instruction = new TransactionInstruction({
      keys: [
        { pubkey: channelPDA, isSigner: false, isWritable: true },
        { pubkey: this.wallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      programId: this.programId,
      data,
    });

    const tx = new Transaction().add(instruction);
    const signature = await this.provider.sendAndConfirm(tx);

    console.log(`Channel '${name}' created: ${signature}`);
    return signature;
  }

  async subscribe(channelName: string): Promise<string> {
    const [channelPDA] = this.getChannelPDA(channelName);
    const [subscriptionPDA] = this.getSubscriptionPDA(
      channelPDA,
      this.wallet.publicKey
    );

    const discriminator = Buffer.from([
      0xe9, 0x0b, 0x36, 0x96, 0xa0, 0xc5, 0xd5, 0xb5,
    ]); // subscribe discriminator

    const instruction = new TransactionInstruction({
      keys: [
        { pubkey: channelPDA, isSigner: false, isWritable: true },
        { pubkey: subscriptionPDA, isSigner: false, isWritable: true },
        { pubkey: this.wallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      programId: this.programId,
      data: discriminator,
    });

    const tx = new Transaction().add(instruction);
    const signature = await this.provider.sendAndConfirm(tx);

    console.log(`Subscribed to '${channelName}': ${signature}`);
    return signature;
  }

  async unsubscribe(channelName: string): Promise<string> {
    const [channelPDA] = this.getChannelPDA(channelName);
    const [subscriptionPDA] = this.getSubscriptionPDA(
      channelPDA,
      this.wallet.publicKey
    );

    const discriminator = Buffer.from([
      0x7a, 0x01, 0x7d, 0x81, 0x89, 0x8d, 0x3d, 0x3d,
    ]); // unsubscribe discriminator

    const instruction = new TransactionInstruction({
      keys: [
        { pubkey: channelPDA, isSigner: false, isWritable: true },
        { pubkey: subscriptionPDA, isSigner: false, isWritable: true },
        { pubkey: this.wallet.publicKey, isSigner: true, isWritable: true },
      ],
      programId: this.programId,
      data: discriminator,
    });

    const tx = new Transaction().add(instruction);
    const signature = await this.provider.sendAndConfirm(tx);

    console.log(`Unsubscribed from '${channelName}': ${signature}`);
    return signature;
  }

  async postMessage(channelName: string, content: string): Promise<string> {
    const [channelPDA] = this.getChannelPDA(channelName);
    const [subscriptionPDA] = this.getSubscriptionPDA(
      channelPDA,
      this.wallet.publicKey
    );

    // Get current message count
    const channelInfo = await this.connection.getAccountInfo(channelPDA);
    if (!channelInfo) throw new Error("Channel not found");

    // Parse message count (offset: 8 + 4 + 32 + 32 + 8 = 84 for subscriber_count, then 8 more for message_count)
    // Actually need to decode properly - for now use 0
    const messageCount = new BN(0); // TODO: decode from account

    const [messagePDA] = this.getMessagePDA(channelPDA, messageCount);

    const discriminator = Buffer.from([
      0xaa, 0x6a, 0x39, 0xda, 0xc8, 0x4e, 0x32, 0x39,
    ]); // post_message discriminator

    const contentBuffer = Buffer.from(content);
    const contentLenBuffer = Buffer.alloc(4);
    contentLenBuffer.writeUInt32LE(contentBuffer.length);

    const data = Buffer.concat([discriminator, contentLenBuffer, contentBuffer]);

    const instruction = new TransactionInstruction({
      keys: [
        { pubkey: channelPDA, isSigner: false, isWritable: true },
        { pubkey: subscriptionPDA, isSigner: false, isWritable: false },
        { pubkey: messagePDA, isSigner: false, isWritable: true },
        { pubkey: this.wallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      programId: this.programId,
      data,
    });

    const tx = new Transaction().add(instruction);
    const signature = await this.provider.sendAndConfirm(tx);

    console.log(`Message posted to '${channelName}': ${signature}`);
    return signature;
  }

  // ========== Read Operations ==========

  async getChannel(name: string): Promise<Channel | null> {
    const [channelPDA] = this.getChannelPDA(name);
    const accountInfo = await this.connection.getAccountInfo(channelPDA);

    if (!accountInfo) return null;

    // TODO: Proper deserialization with IDL
    return null;
  }

  async isSubscribed(channelName: string): Promise<boolean> {
    const [channelPDA] = this.getChannelPDA(channelName);
    const [subscriptionPDA] = this.getSubscriptionPDA(
      channelPDA,
      this.wallet.publicKey
    );

    const accountInfo = await this.connection.getAccountInfo(subscriptionPDA);
    return accountInfo !== null;
  }

  // ========== Event Listeners ==========

  onMessage(
    channelName: string,
    callback: (message: MessageEvent) => void
  ): number {
    const [channelPDA] = this.getChannelPDA(channelName);

    // Subscribe to program logs
    return this.connection.onLogs(
      this.programId,
      (logs) => {
        // Parse MessagePosted events from logs
        for (const log of logs.logs) {
          if (log.includes("MessagePosted")) {
            // TODO: Parse event data from logs
            console.log("Message event detected:", log);
          }
        }
      },
      "confirmed"
    );
  }

  removeListener(subscriptionId: number): void {
    this.connection.removeOnLogsListener(subscriptionId);
  }
}

// ========== Utilities ==========

export function createWallet(keypair: Keypair): Wallet {
  return {
    publicKey: keypair.publicKey,
    signTransaction: async (tx) => {
      tx.partialSign(keypair);
      return tx;
    },
    signAllTransactions: async (txs) => {
      txs.forEach((tx) => tx.partialSign(keypair));
      return txs;
    },
  } as Wallet;
}

export default SolChat;
