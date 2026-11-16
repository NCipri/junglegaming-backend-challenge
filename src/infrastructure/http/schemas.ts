// Request schemas shared by the HTTP controllers and the OpenAPI document.
import { z } from 'zod';

export const PRINTABLE_ID = z.string().regex(/^[!-~]{1,120}$/);

export const UUID = z.uuid();

export const MoneySchema = z.strictObject({
  amount: z.string(),
  currency: z.string(),
});

export const CreateWalletSchema = z.strictObject({
  playerId: UUID,
  initialBalance: MoneySchema,
});

export const SubmitTransactionSchema = z.strictObject({
  providerId: PRINTABLE_ID.refine((value) => value !== 'internal', 'reserved provider id'),
  externalTransactionId: PRINTABLE_ID,
  playerId: UUID,
  walletId: UUID,
  roundId: PRINTABLE_ID,
  gameId: PRINTABLE_ID,
  kind: z.enum(['OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK']),
  money: MoneySchema,
  referenceExternalTransactionId: PRINTABLE_ID.optional(),
});

export const LedgerQuerySchema = z.strictObject({
  cursor: z.string().max(200).optional(),
  limit: z
    .string()
    .regex(/^[1-9]\d{0,2}$/)
    .transform((value) => Number.parseInt(value, 10))
    .refine((value) => value <= 200)
    .optional(),
});
