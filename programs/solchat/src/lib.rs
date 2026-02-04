use anchor_lang::prelude::*;

declare_id!("GSxVeR5oPMviphJ2WufyXfev717yiZSLPphG6uDTfpKX");

pub const MAX_CHANNEL_NAME: usize = 32;
pub const MAX_MESSAGE_LEN: usize = 280;
pub const MAX_MESSAGES_PER_CHANNEL: usize = 100;

#[program]
pub mod solchat {
    use super::*;

    /// Create a new message channel
    pub fn create_channel(ctx: Context<CreateChannel>, name: String) -> Result<()> {
        require!(name.len() <= MAX_CHANNEL_NAME, SolChatError::ChannelNameTooLong);
        require!(!name.is_empty(), SolChatError::ChannelNameEmpty);

        let channel = &mut ctx.accounts.channel;
        channel.name = name;
        channel.creator = ctx.accounts.creator.key();
        channel.subscriber_count = 1; // Creator auto-subscribes
        channel.message_count = 0;
        channel.created_at = Clock::get()?.unix_timestamp;
        channel.bump = ctx.bumps.channel;

        msg!("Channel '{}' created by {}", channel.name, channel.creator);
        Ok(())
    }

    /// Subscribe to a channel
    pub fn subscribe(ctx: Context<Subscribe>) -> Result<()> {
        let subscription = &mut ctx.accounts.subscription;
        let channel = &mut ctx.accounts.channel;

        subscription.subscriber = ctx.accounts.subscriber.key();
        subscription.channel = channel.key();
        subscription.subscribed_at = Clock::get()?.unix_timestamp;
        subscription.bump = ctx.bumps.subscription;

        channel.subscriber_count = channel.subscriber_count.checked_add(1).unwrap();

        msg!("{} subscribed to {}", subscription.subscriber, channel.name);
        Ok(())
    }

    /// Unsubscribe from a channel
    pub fn unsubscribe(ctx: Context<Unsubscribe>) -> Result<()> {
        let channel = &mut ctx.accounts.channel;
        channel.subscriber_count = channel.subscriber_count.saturating_sub(1);

        msg!("{} unsubscribed from {}", ctx.accounts.subscriber.key(), channel.name);
        Ok(())
    }

    /// Post a message to a channel
    pub fn post_message(ctx: Context<PostMessage>, content: String) -> Result<()> {
        require!(content.len() <= MAX_MESSAGE_LEN, SolChatError::MessageTooLong);
        require!(!content.is_empty(), SolChatError::MessageEmpty);

        let message = &mut ctx.accounts.message;
        let channel = &mut ctx.accounts.channel;

        message.channel = channel.key();
        message.sender = ctx.accounts.sender.key();
        message.content = content;
        message.timestamp = Clock::get()?.unix_timestamp;
        message.index = channel.message_count;
        message.bump = ctx.bumps.message;

        channel.message_count = channel.message_count.checked_add(1).unwrap();

        msg!(
            "Message #{} posted to {} by {}",
            message.index,
            channel.name,
            message.sender
        );

        // Emit event for indexers
        emit!(MessagePosted {
            channel: channel.key(),
            channel_name: channel.name.clone(),
            sender: message.sender,
            content: message.content.clone(),
            timestamp: message.timestamp,
            index: message.index,
        });

        Ok(())
    }
}

// ============================================================================
// Accounts
// ============================================================================

#[derive(Accounts)]
#[instruction(name: String)]
pub struct CreateChannel<'info> {
    #[account(
        init,
        payer = creator,
        space = 8 + Channel::INIT_SPACE,
        seeds = [b"channel", name.as_bytes()],
        bump
    )]
    pub channel: Account<'info, Channel>,

    #[account(mut)]
    pub creator: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Subscribe<'info> {
    #[account(mut)]
    pub channel: Account<'info, Channel>,

    #[account(
        init,
        payer = subscriber,
        space = 8 + Subscription::INIT_SPACE,
        seeds = [b"subscription", channel.key().as_ref(), subscriber.key().as_ref()],
        bump
    )]
    pub subscription: Account<'info, Subscription>,

    #[account(mut)]
    pub subscriber: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Unsubscribe<'info> {
    #[account(mut)]
    pub channel: Account<'info, Channel>,

    #[account(
        mut,
        close = subscriber,
        seeds = [b"subscription", channel.key().as_ref(), subscriber.key().as_ref()],
        bump = subscription.bump
    )]
    pub subscription: Account<'info, Subscription>,

    #[account(mut)]
    pub subscriber: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(content: String)]
pub struct PostMessage<'info> {
    #[account(mut)]
    pub channel: Account<'info, Channel>,

    // Verify sender is subscribed
    #[account(
        seeds = [b"subscription", channel.key().as_ref(), sender.key().as_ref()],
        bump = subscription.bump
    )]
    pub subscription: Account<'info, Subscription>,

    #[account(
        init,
        payer = sender,
        space = 8 + Message::INIT_SPACE,
        seeds = [b"message", channel.key().as_ref(), &channel.message_count.to_le_bytes()],
        bump
    )]
    pub message: Account<'info, Message>,

    #[account(mut)]
    pub sender: Signer<'info>,

    pub system_program: Program<'info, System>,
}

// ============================================================================
// State
// ============================================================================

#[account]
#[derive(InitSpace)]
pub struct Channel {
    #[max_len(32)]
    pub name: String,
    pub creator: Pubkey,
    pub subscriber_count: u64,
    pub message_count: u64,
    pub created_at: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Subscription {
    pub subscriber: Pubkey,
    pub channel: Pubkey,
    pub subscribed_at: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Message {
    pub channel: Pubkey,
    pub sender: Pubkey,
    #[max_len(280)]
    pub content: String,
    pub timestamp: i64,
    pub index: u64,
    pub bump: u8,
}

// ============================================================================
// Events
// ============================================================================

#[event]
pub struct MessagePosted {
    pub channel: Pubkey,
    pub channel_name: String,
    pub sender: Pubkey,
    pub content: String,
    pub timestamp: i64,
    pub index: u64,
}

// ============================================================================
// Errors
// ============================================================================

#[error_code]
pub enum SolChatError {
    #[msg("Channel name too long (max 32 chars)")]
    ChannelNameTooLong,
    #[msg("Channel name cannot be empty")]
    ChannelNameEmpty,
    #[msg("Message too long (max 280 chars)")]
    MessageTooLong,
    #[msg("Message cannot be empty")]
    MessageEmpty,
}
