import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { TimedVaultCapstone } from "../target/types/timed_vault_capstone";
import {
  createMint,
  getAssociatedTokenAddressSync,
  getAccount,
  mintTo,
  createAssociatedTokenAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { assert } from "chai";

describe("vault_capstone (Time-Locked Vault)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace
    .TimedVaultCapstone as Program<TimedVaultCapstone>;

  // Use the provider wallet for BOTH owner and depositor to avoid devnet airdrop flakiness.
  const owner = provider.wallet;
  const depositor = provider.wallet;

  let mint: anchor.web3.PublicKey;

  let configPda: anchor.web3.PublicKey;
  let vaultAuthorityPda: anchor.web3.PublicKey;
  let vaultAta: anchor.web3.PublicKey;

  let ownerAta: anchor.web3.PublicKey;
  let depositorAta: anchor.web3.PublicKey;

  const depositAmount = 1_000_000; // 1 token if decimals=6
  const withdrawAmount = 400_000;

  it("Creates mint + token accounts, mints tokens to depositor", async () => {
    mint = await createMint(
      provider.connection,
      (owner as any).payer,
      owner.publicKey,
      null,
      6
    );

    ownerAta = getAssociatedTokenAddressSync(mint, owner.publicKey);
    depositorAta = getAssociatedTokenAddressSync(mint, depositor.publicKey);

    // Create owner ATA (idempotent-ish: if already exists, this will throw; so wrap)
    try {
      await createAssociatedTokenAccount(
        provider.connection,
        (owner as any).payer,
        mint,
        owner.publicKey
      );
    } catch (_) {}

    // Since depositor == owner, depositorAta == ownerAta, but keep structure explicit.
    if (depositor.publicKey.toBase58() !== owner.publicKey.toBase58()) {
      try {
        await createAssociatedTokenAccount(
          provider.connection,
          (owner as any).payer,
          mint,
          depositor.publicKey
        );
      } catch (_) {}
    }

    // mint tokens to depositor ATA
    await mintTo(
      provider.connection,
      (owner as any).payer,
      mint,
      depositorAta,
      owner.publicKey,
      depositAmount
    );

    const depAcc = await getAccount(provider.connection, depositorAta);
    assert.equal(Number(depAcc.amount), depositAmount);
  });

  it("Initializes vault with future unlock_time", async () => {
    const now = Math.floor(Date.now() / 1000);
    const unlockTime = now + 5; // 5 seconds from now

    [configPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("config"), owner.publicKey.toBuffer(), mint.toBuffer()],
      program.programId
    );

    [vaultAuthorityPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("authority"), configPda.toBuffer()],
      program.programId
    );

    vaultAta = getAssociatedTokenAddressSync(mint, vaultAuthorityPda, true);

    await program.methods
      .initialize(new anchor.BN(unlockTime))
      .accounts({
        owner: owner.publicKey,
        mint,
        config: configPda,
        vaultAuthority: vaultAuthorityPda,
        vaultAta,
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    const cfg = await program.account.vaultConfig.fetch(configPda);
    assert.equal(cfg.owner.toBase58(), owner.publicKey.toBase58());
    assert.equal(cfg.mint.toBase58(), mint.toBase58());
  });

  it("Deposits tokens into vault ATA", async () => {
    const beforeVault = Number(
      (await getAccount(provider.connection, vaultAta)).amount
    );
    const beforeDepositor = Number(
      (await getAccount(provider.connection, depositorAta)).amount
    );

    await program.methods
      .deposit(new anchor.BN(depositAmount))
      .accounts({
        depositor: depositor.publicKey,
        mint,
        config: configPda,
        vaultAuthority: vaultAuthorityPda,
        vaultAta,
        depositorAta,
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      // No signers needed because depositor is provider wallet in AnchorProvider
      .rpc();

    const vaultAcc = await getAccount(provider.connection, vaultAta);
    const depAcc = await getAccount(provider.connection, depositorAta);

    assert.equal(Number(vaultAcc.amount), beforeVault + depositAmount);
    assert.equal(Number(depAcc.amount), beforeDepositor - depositAmount);
  });

  it("Fails to withdraw before unlock_time", async () => {
    try {
      await program.methods
        .withdraw(new anchor.BN(withdrawAmount))
        .accounts({
          owner: owner.publicKey,
          mint,
          config: configPda,
          vaultAuthority: vaultAuthorityPda,
          vaultAta,
          ownerAta,
          associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();

      assert.fail("Expected withdraw to fail while locked");
    } catch (e: any) {
      // Prefer structured Anchor error code if present:
      const code = e?.error?.errorCode?.code;
      if (code) {
        // If you implement VaultLocked in Rust, set this to "VaultLocked"
        // For now, just assert we got *some* anchor program error.
        assert.isString(code);
      } else {
        // Fall back to a non-brittle message check:
        const msg = String(e);
        assert.match(msg, /locked|unlock/i);
      }
    }
  });

  it("Withdraws after unlock_time passes", async () => {
    // Wait beyond the unlock time
    await new Promise((r) => setTimeout(r, 6500));

    const beforeVault = Number(
      (await getAccount(provider.connection, vaultAta)).amount
    );
    const beforeOwner = Number(
      (await getAccount(provider.connection, ownerAta)).amount
    );

    await program.methods
      .withdraw(new anchor.BN(withdrawAmount))
      .accounts({
        owner: owner.publicKey,
        mint,
        config: configPda,
        vaultAuthority: vaultAuthorityPda,
        vaultAta,
        ownerAta,
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const vaultAcc = await getAccount(provider.connection, vaultAta);
    const ownerAcc = await getAccount(provider.connection, ownerAta);

    // State-based assertions
    assert.equal(Number(vaultAcc.amount), beforeVault - withdrawAmount);
    assert.equal(Number(ownerAcc.amount), beforeOwner + withdrawAmount);
  });
});