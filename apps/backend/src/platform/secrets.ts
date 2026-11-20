import { createHash, timingSafeEqual } from 'node:crypto';

/** Compares secrets in constant time; hashing first makes the lengths equal, which `timingSafeEqual` requires. */
export const sameSecret = (given: string, expected: string): boolean => timingSafeEqual(createHash('sha256').update(given).digest(), createHash('sha256').update(expected).digest());
