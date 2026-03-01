import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { VaultCapstone } from "../target/types/vault_capstone";
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

  const program = anchor.workspace.VaultCapstone as Program<VaultCapstone>;

  const owner = provider.wallet;
  const depositor = anchor.web3.Keypair.generate();

  let mint: anchor.web3.PublicKey;

  let configPda: anchor.web3.PublicKey;
  let vaultAuthorityPda: anchor.web3.PublicKey;
  let vaultAta: anchor.web3.PublicKey;

  let ownerAta: anchor.web3.PublicKey;
  let depositorAta: anchor.web3.PublicKey;

  const depositAmount = 1_000_000; // 1 token if decimals=6
  const withdrawAmount = 400_000;

  const airdrop = async (pubkey: anchor.web3.PublicKey, sol = 2) => {
    const sig = await provider.connection.requestAirdrop(
      pubkey,
      sol * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(sig, "confirmed");
  };

  it("Airdrops SOL to depositor", async () => {
    await airdrop(depositor.publicKey, 2);
  });

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

    // create ATAs
    await createAssociatedTokenAccount(
      provider.connection,
      (owner as any).payer,
      mint,
      owner.publicKey
    );

    await createAssociatedTokenAccount(
      provider.connection,
      (owner as any).payer,
      mint,
      depositor.publicKey
    );

    // mint tokens to depositor
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
      .signers([depositor])
      .rpc();

    const vaultAcc = await getAccount(provider.connection, vaultAta);
    assert.equal(Number(vaultAcc.amount), depositAmount);
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
      const msg = e.toString();
      assert.include(msg, "Vault is still locked");
    }
  });

  it("Withdraws after unlock_time passes", async () => {
    // wait a bit to pass unlock time
    await new Promise((r) => setTimeout(r, 6000));

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

    assert.equal(Number(vaultAcc.amount), depositAmount - withdrawAmount);
    // owner should receive withdrawAmount (owner may already have 0 initially)
    assert.isAtLeast(Number(ownerAcc.amount), withdrawAmount);
  });
});