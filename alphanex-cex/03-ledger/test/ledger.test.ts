/**
 * EN: Ledger core tests on real Postgres SQL (PGlite): balancing, overdraft protection,
 *     idempotency, append-only, invariants and migrations.
 * ES: Tests del núcleo del ledger con SQL real de Postgres (PGlite): balanceo, protección de
 *     sobregiro, idempotencia, solo-agregar, invariantes y migraciones.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { InsufficientFundsError, LedgerError, parseAccount, runMigrations, loadMigrations, LEDGER_MIGRATIONS_DIR, userAccount, validateEntry } from '../src/index.js';
import { setup } from './helpers.js';

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
});

describe('accounts / cuentas', () => {
  it('EN: parses codes with correct normal side / ES: parsea códigos con el lado normal correcto', () => {
    expect(parseAccount('user:7:USDT:available')).toMatchObject({ asset: 'USDT', normalSide: 'credit', ownerId: '7' });
    expect(parseAccount('custody:hot:ETH')).toMatchObject({ normalSide: 'debit', ownerType: 'custody' });
    expect(parseAccount('equity:seed:ETH').allowNegative).toBe(true);
    expect(() => parseAccount('user:7:USDT:weird')).toThrow();
    expect(() => parseAccount('bogus')).toThrow();
  });

  it('EN: rejects injection of separators / ES: rechaza inyección de separadores', () => {
    expect(() => userAccount('1:x', 'USDT', 'available')).toThrow();
  });
});

describe('validateEntry', () => {
  it('EN: rejects unbalanced, zero or single-line entries / ES: rechaza asientos desbalanceados, en cero o de una línea', () => {
    const a = 'user:1:USDT:available';
    const b = 'custody:hot:USDT';
    expect(() => validateEntry({ kind: 'x', postings: [{ account: a, side: 'credit', amount: 5n }] })).toThrow(LedgerError);
    expect(() => validateEntry({ kind: 'x', postings: [{ account: a, side: 'credit', amount: 5n }, { account: b, side: 'debit', amount: 4n }] })).toThrow(/unbalanced/);
    expect(() => validateEntry({ kind: 'x', postings: [{ account: a, side: 'credit', amount: 0n }, { account: b, side: 'debit', amount: 0n }] })).toThrow(/positive/);
    expect(() => validateEntry({ kind: 'x', postings: [{ account: a, side: 'credit', amount: 1n }, { account: 'custody:hot:ETH', side: 'debit', amount: 1n }] })).toThrow(/unbalanced/);
  });
});

describe('Ledger on Postgres / Ledger sobre Postgres', () => {
  it('EN: migrations are idempotent / ES: las migraciones son idempotentes', async () => {
    const { db } = await setup();
    cleanup = () => db.close();
    expect(await runMigrations(db, loadMigrations(LEDGER_MIGRATIONS_DIR, 'ledger'))).toEqual([]);
  });

  it('EN: deposit credits user and custody / ES: el depósito acredita al usuario y a la custodia', async () => {
    const { db, ledger, acct } = await setup();
    cleanup = () => db.close();
    await db.transaction((tx) => acct.creditDeposit(tx, { userId: '1', asset: 'USDT', amount: 1_000n, eventId: '0xabc:0' }));
    expect(await ledger.balance('user:1:USDT:available')).toBe(1_000n);
    expect(await ledger.balance('custody:hot:USDT')).toBe(1_000n);
    expect((await ledger.checkInvariants()).ok).toBe(true);
  });

  it('EN: idempotency key prevents double credit / ES: la clave de idempotencia evita doble acreditación', async () => {
    const { db, ledger, acct } = await setup();
    cleanup = () => db.close();
    const r1 = await db.transaction((tx) => acct.creditDeposit(tx, { userId: '1', asset: 'USDT', amount: 1_000n, eventId: 'e1' }));
    const r2 = await db.transaction((tx) => acct.creditDeposit(tx, { userId: '1', asset: 'USDT', amount: 1_000n, eventId: 'e1' }));
    expect(r1.duplicate).toBe(false);
    expect(r2).toEqual({ entryId: r1.entryId, duplicate: true });
    expect(await ledger.balance('user:1:USDT:available')).toBe(1_000n);
  });

  it('EN: overdraft is impossible and rolls back the whole entry / ES: el sobregiro es imposible y revierte todo el asiento', async () => {
    const { db, ledger, acct } = await setup();
    cleanup = () => db.close();
    await db.transaction((tx) => acct.creditDeposit(tx, { userId: '1', asset: 'USDT', amount: 100n, eventId: 'e1' }));
    await expect(db.transaction((tx) => acct.hold(tx, { userId: '1', asset: 'USDT', amount: 101n, orderId: 'o1' }))).rejects.toBeInstanceOf(InsufficientFundsError);
    expect(await ledger.balance('user:1:USDT:available')).toBe(100n);
    expect(await ledger.balance('user:1:USDT:locked')).toBe(0n);
    // EN: The failed entry must not leave a journal row behind. / ES: El asiento fallido no debe dejar fila en el diario.
    const n = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM journal_entries WHERE kind='order_hold'`);
    expect(n.rows[0]!.n).toBe('0');
  });

  it('EN: journal and postings are append-only / ES: diario y movimientos son solo-agregar', async () => {
    const { db, acct } = await setup();
    cleanup = () => db.close();
    await db.transaction((tx) => acct.creditDeposit(tx, { userId: '1', asset: 'USDT', amount: 5n, eventId: 'e1' }));
    await expect(db.query(`UPDATE postings SET amount = 1`)).rejects.toThrow(/append-only/);
    await expect(db.query(`DELETE FROM journal_entries`)).rejects.toThrow(/append-only/);
  });

  it('EN: invariant checker detects tampering of materialised balances / ES: el verificador detecta manipulación de saldos', async () => {
    const { db, ledger, acct } = await setup();
    cleanup = () => db.close();
    await db.transaction((tx) => acct.creditDeposit(tx, { userId: '1', asset: 'USDT', amount: 5n, eventId: 'e1' }));
    await db.query(`UPDATE ledger_accounts SET balance = 999 WHERE code = 'user:1:USDT:available'`);
    const rep = await ledger.checkInvariants();
    expect(rep.ok).toBe(false);
    expect(rep.problems.join()).toMatch(/drift/);
    expect(rep.problems.join()).toMatch(/books do not balance/);
  });

  it('EN: userBalances groups buckets and history lists entries / ES: userBalances agrupa buckets e history lista asientos', async () => {
    const { db, ledger, acct } = await setup();
    cleanup = () => db.close();
    await db.transaction(async (tx) => {
      await acct.creditDeposit(tx, { userId: '9', asset: 'USDT', amount: 500n, eventId: 'e1' });
      await acct.hold(tx, { userId: '9', asset: 'USDT', amount: 200n, orderId: 'o1' });
    });
    expect(await ledger.userBalances('9')).toEqual({ USDT: { available: 300n, locked: 200n, withdrawing: 0n } });
    const h = await ledger.history('user:9:USDT:available');
    expect(h.map((x) => x.kind)).toEqual(['order_hold', 'deposit']);
  });

  it('EN: unknown asset is rejected by FK / ES: activo desconocido rechazado por FK', async () => {
    const { db, ledger } = await setup();
    cleanup = () => db.close();
    await expect(
      ledger.post({ kind: 'x', postings: [{ account: 'custody:hot:DOGE', side: 'debit', amount: 1n }, { account: 'user:1:DOGE:available', side: 'credit', amount: 1n }] }),
    ).rejects.toThrow();
  });
});
