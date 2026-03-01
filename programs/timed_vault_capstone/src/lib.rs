use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint, Token, TokenAccount, Transfer},
};

declare_id!("BgQgZXVvf8anwJR1F1XrHZe2RDyWfM8nt2TAjBnyQSqc");

#[program]
pub mod timed_vault_capstone {
    use super::*;

    /// Initializes a time-locked vault for a specific owner + mint.
    ///
    /// Creates:
    /// - config PDA: stores owner, mint, unlock_time, bumps
    /// - vault_authority PDA: signs withdrawals
    /// - vault_ata: ATA(mint, vault_authority) holding tokens
    pub fn initialize(ctx: Context<Initialize>, unlock_time: i64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(unlock_time > now, VaultError::InvalidUnlockTime);

        let cfg = &mut ctx.accounts.config;
        cfg.owner = ctx.accounts.owner.key();
        cfg.mint = ctx.accounts.mint.key();
        cfg.unlock_time = unlock_time;
        cfg.bump_config = ctx.bumps.config;
        cfg.bump_authority = ctx.bumps.vault_authority;

        Ok(())
    }

    /// Deposit SPL tokens into the vault's ATA.
    /// Anyone can deposit (owner doesn't have to be depositor).
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(amount > 0, VaultError::InvalidAmount);

        let cpi_accounts = Transfer {
            from: ctx.accounts.depositor_ata.to_account_info(),
            to: ctx.accounts.vault_ata.to_account_info(),
            authority: ctx.accounts.depositor.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);

        token::transfer(cpi_ctx, amount)?;
        Ok(())
    }

    /// Withdraw SPL tokens from the vault to the owner's ATA.
    ///
    /// Constraints:
    /// - only allowed when `Clock::unix_timestamp >= unlock_time`
    /// - only owner can withdraw (config PDA seeds include owner + has_one owner)
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        require!(amount > 0, VaultError::InvalidAmount);

        let now = Clock::get()?.unix_timestamp;
        require!(now >= ctx.accounts.config.unlock_time, VaultError::Locked);

        // PDA signer: vault_authority = PDA(["authority", config])
        // Bind config pubkey so the reference outlives this statement.
        let config_key = ctx.accounts.config.key();

        let seeds: &[&[u8]] = &[
            b"authority",
            config_key.as_ref(),
            &[ctx.accounts.config.bump_authority],
        ];
        let signer_seeds: &[&[&[u8]]] = &[seeds];

        let cpi_accounts = Transfer {
            from: ctx.accounts.vault_ata.to_account_info(),
            to: ctx.accounts.owner_ata.to_account_info(),
            authority: ctx.accounts.vault_authority.to_account_info(),
        };

        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer_seeds,
        );

        token::transfer(cpi_ctx, amount)?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    pub mint: Account<'info, Mint>,

    /// PDA storing vault config
    #[account(
        init,
        payer = owner,
        space = 8 + VaultConfig::INIT_SPACE,
        seeds = [b"config", owner.key().as_ref(), mint.key().as_ref()],
        bump
    )]
    pub config: Account<'info, VaultConfig>,

    /// PDA that becomes the authority for the vault ATA (required by rubric)
    /// CHECK: This is a program-derived address used only as the vault ATA authority.
    /// No data is read from this account. Signer validity is enforced by PDA seeds in `withdraw`.
    #[account(
        seeds = [b"authority", config.key().as_ref()],
        bump
    )]
    pub vault_authority: UncheckedAccount<'info>,

    /// Vault's token account: ATA owned by vault_authority PDA
    #[account(
        init,
        payer = owner,
        associated_token::mint = mint,
        associated_token::authority = vault_authority
    )]
    pub vault_ata: Account<'info, TokenAccount>,

    pub associated_token_program: Program<'info, AssociatedToken>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,

    pub mint: Account<'info, Mint>,

    #[account(
        seeds = [b"config", config.owner.as_ref(), mint.key().as_ref()],
        bump = config.bump_config,
        has_one = mint
    )]
    pub config: Account<'info, VaultConfig>,

    /// CHECK: PDA used only as ATA authority; validated by seeds/bump.
    #[account(
        seeds = [b"authority", config.key().as_ref()],
        bump = config.bump_authority
    )]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = vault_authority
    )]
    pub vault_ata: Account<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = depositor
    )]
    pub depositor_ata: Account<'info, TokenAccount>,

    pub associated_token_program: Program<'info, AssociatedToken>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    pub mint: Account<'info, Mint>,

    #[account(
        seeds = [b"config", owner.key().as_ref(), mint.key().as_ref()],
        bump = config.bump_config,
        has_one = owner,
        has_one = mint
    )]
    pub config: Account<'info, VaultConfig>,

    /// CHECK: PDA used only as ATA authority and signer via invoke_signed; validated by seeds/bump.
    #[account(
        seeds = [b"authority", config.key().as_ref()],
        bump = config.bump_authority
    )]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = vault_authority
    )]
    pub vault_ata: Account<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = owner
    )]
    pub owner_ata: Account<'info, TokenAccount>,

    pub associated_token_program: Program<'info, AssociatedToken>,
    pub token_program: Program<'info, Token>,
}

#[account]
pub struct VaultConfig {
    pub owner: Pubkey,
    pub mint: Pubkey,
    pub unlock_time: i64,
    pub bump_config: u8,
    pub bump_authority: u8,
}

impl VaultConfig {
    pub const INIT_SPACE: usize =
        32 + // owner
        32 + // mint
        8 +  // unlock_time
        1 +  // bump_config
        1; // bump_authority
}

#[error_code]
pub enum VaultError {
    #[msg("Vault is still locked.")]
    Locked,
    #[msg("Unlock time must be in the future.")]
    InvalidUnlockTime,
    #[msg("Amount must be greater than zero.")]
    InvalidAmount,
}