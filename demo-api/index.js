const express = require('express');
const cors = require('cors');
const { Connection, PublicKey, Keypair, SystemProgram, Transaction, TransactionInstruction } = require('@solana/web3.js');
const { BN } = require('@coral-xyz/anchor');

const app = express();
app.use(cors());
app.use(express.json());

// Config
const PROGRAM_ID = new PublicKey('GSxVeR5oPMviphJ2WufyXfev717yiZSLPphG6uDTfpKX');
const RPC_URL = process.env.RPC_URL || 'https://api.devnet.solana.com';
const PORT = process.env.PORT || 3000;

// Load wallet from env or file
let wallet;
if (process.env.WALLET_PRIVATE_KEY) {
  const secretKey = Uint8Array.from(JSON.parse(process.env.WALLET_PRIVATE_KEY));
  wallet = Keypair.fromSecretKey(secretKey);
} else {
  console.warn('No WALLET_PRIVATE_KEY set - write operations disabled');
}

const connection = new Connection(RPC_URL, 'confirmed');

// ========== PDA Derivations ==========

function getChannelPDA(name) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('channel'), Buffer.from(name)],
    PROGRAM_ID
  );
}

function getSubscriptionPDA(channelPubkey, subscriber) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('subscription'), channelPubkey.toBuffer(), subscriber.toBuffer()],
    PROGRAM_ID
  );
}

function getMessagePDA(channelPubkey, messageIndex) {
  const indexBuffer = Buffer.alloc(8);
  indexBuffer.writeBigUInt64LE(BigInt(messageIndex));
  return PublicKey.findProgramAddressSync(
    [Buffer.from('message'), channelPubkey.toBuffer(), indexBuffer],
    PROGRAM_ID
  );
}

// ========== Account Parsing ==========

function parseChannel(data) {
  // Skip 8-byte discriminator
  let offset = 8;
  
  // Read name (4-byte length + string)
  const nameLen = data.readUInt32LE(offset);
  offset += 4;
  const name = data.slice(offset, offset + nameLen).toString('utf8');
  offset += nameLen;
  
  // Read creator (32 bytes)
  const creator = new PublicKey(data.slice(offset, offset + 32));
  offset += 32;
  
  // Read subscriber_count (u64)
  const subscriberCount = data.readBigUInt64LE(offset);
  offset += 8;
  
  // Read message_count (u64)
  const messageCount = data.readBigUInt64LE(offset);
  offset += 8;
  
  // Read created_at (i64)
  const createdAt = data.readBigInt64LE(offset);
  offset += 8;
  
  // Read bump (u8)
  const bump = data.readUInt8(offset);
  
  return {
    name,
    creator: creator.toBase58(),
    subscriberCount: Number(subscriberCount),
    messageCount: Number(messageCount),
    createdAt: new Date(Number(createdAt) * 1000).toISOString(),
    bump
  };
}

function parseMessage(data) {
  // Skip 8-byte discriminator
  let offset = 8;
  
  // Read channel (32 bytes)
  const channel = new PublicKey(data.slice(offset, offset + 32));
  offset += 32;
  
  // Read sender (32 bytes)
  const sender = new PublicKey(data.slice(offset, offset + 32));
  offset += 32;
  
  // Read content (4-byte length + string)
  const contentLen = data.readUInt32LE(offset);
  offset += 4;
  const content = data.slice(offset, offset + contentLen).toString('utf8');
  offset += contentLen;
  
  // Read timestamp (i64)
  const timestamp = data.readBigInt64LE(offset);
  offset += 8;
  
  // Read index (u64)
  const index = data.readBigUInt64LE(offset);
  offset += 8;
  
  return {
    channel: channel.toBase58(),
    sender: sender.toBase58(),
    content,
    timestamp: new Date(Number(timestamp) * 1000).toISOString(),
    index: Number(index)
  };
}

// ========== API Routes ==========

// Health check
app.get('/', (req, res) => {
  res.json({
    name: 'SolChat API',
    version: '1.0.0',
    program: PROGRAM_ID.toBase58(),
    network: 'devnet',
    docs: 'https://github.com/weird-claw-agent/solchat',
    endpoints: {
      'GET /channels': 'List all channels',
      'GET /channels/:name': 'Get channel details',
      'GET /channels/:name/messages': 'Get channel messages',
      'POST /channels': 'Create a channel (requires wallet)',
      'POST /channels/:name/subscribe': 'Subscribe to channel (requires wallet)',
      'POST /channels/:name/message': 'Post message (requires wallet)'
    }
  });
});

// List channels (scan program accounts)
app.get('/channels', async (req, res) => {
  try {
    // Get all accounts owned by program
    const accounts = await connection.getProgramAccounts(PROGRAM_ID, {
      filters: [
        { dataSize: 200 } // Approximate channel account size - adjust if needed
      ]
    });
    
    const channels = [];
    for (const { pubkey, account } of accounts) {
      try {
        const channel = parseChannel(account.data);
        channels.push({
          address: pubkey.toBase58(),
          ...channel
        });
      } catch (e) {
        // Not a channel account, skip
      }
    }
    
    res.json({ channels, count: channels.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get channel by name
app.get('/channels/:name', async (req, res) => {
  try {
    const { name } = req.params;
    const [channelPDA] = getChannelPDA(name);
    
    const accountInfo = await connection.getAccountInfo(channelPDA);
    if (!accountInfo) {
      return res.status(404).json({ error: 'Channel not found' });
    }
    
    const channel = parseChannel(accountInfo.data);
    res.json({
      address: channelPDA.toBase58(),
      ...channel
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get messages for a channel
app.get('/channels/:name/messages', async (req, res) => {
  try {
    const { name } = req.params;
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const offset = parseInt(req.query.offset) || 0;
    
    const [channelPDA] = getChannelPDA(name);
    
    // Get channel to find message count
    const channelInfo = await connection.getAccountInfo(channelPDA);
    if (!channelInfo) {
      return res.status(404).json({ error: 'Channel not found' });
    }
    
    const channel = parseChannel(channelInfo.data);
    const messages = [];
    
    // Fetch messages from offset to limit
    const start = Math.max(0, offset);
    const end = Math.min(channel.messageCount, offset + limit);
    
    for (let i = start; i < end; i++) {
      try {
        const [messagePDA] = getMessagePDA(channelPDA, i);
        const messageInfo = await connection.getAccountInfo(messagePDA);
        if (messageInfo) {
          const message = parseMessage(messageInfo.data);
          messages.push({
            address: messagePDA.toBase58(),
            ...message
          });
        }
      } catch (e) {
        // Skip failed message fetches
      }
    }
    
    res.json({
      channel: name,
      messages,
      total: channel.messageCount,
      offset,
      limit
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create channel
app.post('/channels', async (req, res) => {
  if (!wallet) {
    return res.status(503).json({ error: 'Write operations disabled - no wallet configured' });
  }
  
  try {
    const { name } = req.body;
    if (!name || name.length < 1 || name.length > 32) {
      return res.status(400).json({ error: 'Channel name must be 1-32 characters' });
    }
    
    const [channelPDA] = getChannelPDA(name);
    
    // Check if channel already exists
    const existing = await connection.getAccountInfo(channelPDA);
    if (existing) {
      return res.status(409).json({ error: 'Channel already exists', address: channelPDA.toBase58() });
    }
    
    // Build instruction
    const discriminator = Buffer.from([37, 105, 253, 99, 87, 46, 223, 20]); // create_channel
    const nameBuffer = Buffer.from(name);
    const nameLenBuffer = Buffer.alloc(4);
    nameLenBuffer.writeUInt32LE(nameBuffer.length);
    const data = Buffer.concat([discriminator, nameLenBuffer, nameBuffer]);
    
    const instruction = new TransactionInstruction({
      keys: [
        { pubkey: channelPDA, isSigner: false, isWritable: true },
        { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      programId: PROGRAM_ID,
      data,
    });
    
    const tx = new Transaction().add(instruction);
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    tx.feePayer = wallet.publicKey;
    tx.sign(wallet);
    
    const signature = await connection.sendRawTransaction(tx.serialize());
    await connection.confirmTransaction(signature, 'confirmed');
    
    res.json({
      success: true,
      channel: name,
      address: channelPDA.toBase58(),
      signature,
      explorer: `https://explorer.solana.com/tx/${signature}?cluster=devnet`
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Subscribe to channel
app.post('/channels/:name/subscribe', async (req, res) => {
  if (!wallet) {
    return res.status(503).json({ error: 'Write operations disabled - no wallet configured' });
  }
  
  try {
    const { name } = req.params;
    const [channelPDA] = getChannelPDA(name);
    const [subscriptionPDA] = getSubscriptionPDA(channelPDA, wallet.publicKey);
    
    // Check if channel exists
    const channelInfo = await connection.getAccountInfo(channelPDA);
    if (!channelInfo) {
      return res.status(404).json({ error: 'Channel not found' });
    }
    
    // Check if already subscribed
    const subInfo = await connection.getAccountInfo(subscriptionPDA);
    if (subInfo) {
      return res.status(409).json({ error: 'Already subscribed' });
    }
    
    const discriminator = Buffer.from([254, 28, 191, 138, 156, 179, 183, 53]); // subscribe
    
    const instruction = new TransactionInstruction({
      keys: [
        { pubkey: channelPDA, isSigner: false, isWritable: true },
        { pubkey: subscriptionPDA, isSigner: false, isWritable: true },
        { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      programId: PROGRAM_ID,
      data: discriminator,
    });
    
    const tx = new Transaction().add(instruction);
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    tx.feePayer = wallet.publicKey;
    tx.sign(wallet);
    
    const signature = await connection.sendRawTransaction(tx.serialize());
    await connection.confirmTransaction(signature, 'confirmed');
    
    res.json({
      success: true,
      channel: name,
      subscription: subscriptionPDA.toBase58(),
      signature,
      explorer: `https://explorer.solana.com/tx/${signature}?cluster=devnet`
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Post message to channel
app.post('/channels/:name/message', async (req, res) => {
  if (!wallet) {
    return res.status(503).json({ error: 'Write operations disabled - no wallet configured' });
  }
  
  try {
    const { name } = req.params;
    const { content } = req.body;
    
    if (!content || content.length < 1 || content.length > 500) {
      return res.status(400).json({ error: 'Message content must be 1-500 characters' });
    }
    
    const [channelPDA] = getChannelPDA(name);
    const [subscriptionPDA] = getSubscriptionPDA(channelPDA, wallet.publicKey);
    
    // Get channel to find message count
    const channelInfo = await connection.getAccountInfo(channelPDA);
    if (!channelInfo) {
      return res.status(404).json({ error: 'Channel not found' });
    }
    
    // Check subscription
    const subInfo = await connection.getAccountInfo(subscriptionPDA);
    if (!subInfo) {
      return res.status(403).json({ error: 'Must be subscribed to post messages' });
    }
    
    const channel = parseChannel(channelInfo.data);
    const [messagePDA] = getMessagePDA(channelPDA, channel.messageCount);
    
    const discriminator = Buffer.from([214, 50, 100, 209, 38, 34, 7, 76]); // post_message
    const contentBuffer = Buffer.from(content);
    const contentLenBuffer = Buffer.alloc(4);
    contentLenBuffer.writeUInt32LE(contentBuffer.length);
    const data = Buffer.concat([discriminator, contentLenBuffer, contentBuffer]);
    
    const instruction = new TransactionInstruction({
      keys: [
        { pubkey: channelPDA, isSigner: false, isWritable: true },
        { pubkey: subscriptionPDA, isSigner: false, isWritable: false },
        { pubkey: messagePDA, isSigner: false, isWritable: true },
        { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      programId: PROGRAM_ID,
      data,
    });
    
    const tx = new Transaction().add(instruction);
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    tx.feePayer = wallet.publicKey;
    tx.sign(wallet);
    
    const signature = await connection.sendRawTransaction(tx.serialize());
    await connection.confirmTransaction(signature, 'confirmed');
    
    res.json({
      success: true,
      channel: name,
      messageIndex: channel.messageCount,
      messageAddress: messagePDA.toBase58(),
      signature,
      explorer: `https://explorer.solana.com/tx/${signature}?cluster=devnet`
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get wallet balance (for monitoring)
app.get('/wallet', async (req, res) => {
  if (!wallet) {
    return res.json({ configured: false });
  }
  
  try {
    const balance = await connection.getBalance(wallet.publicKey);
    res.json({
      configured: true,
      address: wallet.publicKey.toBase58(),
      balance: balance / 1e9,
      balanceLamports: balance
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`SolChat API running on port ${PORT}`);
  console.log(`Program ID: ${PROGRAM_ID.toBase58()}`);
  console.log(`RPC: ${RPC_URL}`);
  if (wallet) {
    console.log(`Wallet: ${wallet.publicKey.toBase58()}`);
  } else {
    console.log('Wallet: NOT CONFIGURED (read-only mode)');
  }
});
