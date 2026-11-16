// Identity port: resolves the caller of a request into a viewer (operator, or provider with its id).
import type { Request } from 'express';
import type { Viewer } from '../wagering/application/get-transaction.types';

export interface ProviderIdentityPort {
  resolve(req: Request): Promise<Viewer>;
}

export const PROVIDER_IDENTITY = Symbol('PROVIDER_IDENTITY');
