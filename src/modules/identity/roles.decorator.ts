// Route access metadata: public routes and the roles allowed on protected ones.
import { SetMetadata } from '@nestjs/common';

export type Role = 'operator' | 'provider';

export const ROLES_KEY = 'roles';
export const PUBLIC_KEY = 'public';

export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

export const Public = () => SetMetadata(PUBLIC_KEY, true);
