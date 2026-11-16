// Wallet aggregate root: balance changes only through debit/credit, each yielding its ledger entry.
import { CurrencyMismatchError } from '../../../shared/money/money.errors';
import { Money } from '../../../shared/money/money';
import { LedgerDirection } from './ledger-direction';
import { WalletLedgerEntry } from './wallet-ledger-entry';
import { InsufficientBalanceError, InvalidWalletOpeningError } from './wallet.errors';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface BalanceMovement {
  money: Money;
  transactionId: string;
  entryId: string;
  at: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  at: Date;
  opening?: { transactionId: string; entryId: string };
}

export class Wallet {
  private constructor(
    readonly id: string,
    readonly playerId: string,
    readonly currency: string,
    private _balance: Money,
    private _version: number,
    readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: OpenWalletProps): { wallet: Wallet; openingEntry: WalletLedgerEntry | null } {
    const { initialBalance, at } = props;
    if (initialBalance.isNegative()) {
      throw new InvalidWalletOpeningError('initial balance must not be negative');
    }
    const wallet = new Wallet(
      props.id,
      props.playerId,
      initialBalance.currency,
      initialBalance,
      1,
      new Date(at),
      new Date(at),
    );
    if (initialBalance.isZero()) return { wallet, openingEntry: null };
    if (!props.opening) {
      throw new InvalidWalletOpeningError(
        'a positive initial balance requires an opening transaction',
      );
    }
    const openingEntry = WalletLedgerEntry.create({
      id: props.opening.entryId,
      walletId: wallet.id,
      transactionId: props.opening.transactionId,
      direction: LedgerDirection.Credit,
      money: initialBalance,
      balanceBefore: Money.zero(initialBalance.currency),
      balanceAfter: initialBalance,
      walletVersion: 1,
      createdAt: at,
    });
    return { wallet, openingEntry };
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      new Date(state.createdAt),
      new Date(state.updatedAt),
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return new Date(this._updatedAt);
  }

  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.subtract(money).isNegative();
  }

  debit(movement: BalanceMovement): WalletLedgerEntry {
    this.assertSameCurrency(movement.money);
    const after = this._balance.subtract(movement.money);
    if (after.isNegative()) throw new InsufficientBalanceError(this.id);
    return this.apply(LedgerDirection.Debit, movement, after);
  }

  credit(movement: BalanceMovement): WalletLedgerEntry {
    this.assertSameCurrency(movement.money);
    return this.apply(LedgerDirection.Credit, movement, this._balance.add(movement.money));
  }

  toState(): WalletState {
    return {
      id: this.id,
      playerId: this.playerId,
      currency: this.currency,
      balance: this._balance,
      version: this._version,
      createdAt: new Date(this.createdAt),
      updatedAt: new Date(this._updatedAt),
    };
  }

  private apply(
    direction: LedgerDirection,
    movement: BalanceMovement,
    after: Money,
  ): WalletLedgerEntry {
    const entry = WalletLedgerEntry.create({
      id: movement.entryId,
      walletId: this.id,
      transactionId: movement.transactionId,
      direction,
      money: movement.money,
      balanceBefore: this._balance,
      balanceAfter: after,
      walletVersion: this._version + 1,
      createdAt: movement.at,
    });
    this._balance = after;
    this._version += 1;
    this._updatedAt = new Date(movement.at);
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency)
      throw new CurrencyMismatchError(this.currency, money.currency);
  }
}
