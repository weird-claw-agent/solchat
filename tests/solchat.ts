import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";

describe("solchat", () => {
  // Configure the client to use the local cluster.
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const programId = new PublicKey("SoLChATxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
  
  const channelName = "test-channel-" + Date.now();
  let channelPDA: PublicKey;
  let channelBump: number;

  // Derive channel PDA
  before(() => {
    [channelPDA, channelBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("channel"), Buffer.from(channelName)],
      programId
    );
  });

  it("Creates a channel", async () => {
    // Test will be implemented once program is deployed
    console.log("Channel PDA:", channelPDA.toBase58());
    console.log("Channel name:", channelName);
  });

  it("Subscribes to a channel", async () => {
    const [subscriptionPDA] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("subscription"),
        channelPDA.toBuffer(),
        provider.wallet.publicKey.toBuffer(),
      ],
      programId
    );
    console.log("Subscription PDA:", subscriptionPDA.toBase58());
  });

  it("Posts a message", async () => {
    const messageIndex = new anchor.BN(0);
    const [messagePDA] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("message"),
        channelPDA.toBuffer(),
        messageIndex.toArrayLike(Buffer, "le", 8),
      ],
      programId
    );
    console.log("Message PDA:", messagePDA.toBase58());
  });

  it("Unsubscribes from a channel", async () => {
    // Test unsubscribe
    console.log("Unsubscribe test placeholder");
  });
});
