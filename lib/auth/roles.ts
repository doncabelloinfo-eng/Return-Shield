/**
 * Two kinds of account, and nothing in between.
 *
 * `operator` is the office: the panel, the uploads, the settings, every server
 * action. `scanner` is a warehouse phone: `/scan` and the few APIs behind it,
 * and nothing else in the app. A phone in a warehouse is left on a shelf, is
 * shared between shifts and is the account most likely to be lost — so it can
 * see a code, an order number and a shop name, and no customer's name, phone
 * or address anywhere.
 *
 * `operator` IS THE DEFAULT, in the column and here. Every account that existed
 * before the Scanner was built is an operator, and a role that arrives
 * unreadable is treated as one rather than as a scanner — the failure that
 * locks the office out of its own panel is visible in a second, the failure
 * that hands a warehouse phone the panel is not.
 */

export type UserRole = 'operator' | 'scanner';

export const USER_ROLES: readonly UserRole[] = ['operator', 'scanner'] as const;

export const DEFAULT_ROLE: UserRole = 'operator';

export function isUserRole(value: unknown): value is UserRole {
  return value === 'operator' || value === 'scanner';
}

/** Whatever the database handed back, as a role. Anything odd is an operator. */
export function asUserRole(value: unknown): UserRole {
  return isUserRole(value) ? value : DEFAULT_ROLE;
}

/**
 * The sentence each sign-in form shows the other kind of account.
 *
 * It names the button to press rather than saying "wrong form". The warehouse
 * reads English only, and the two buttons are right there on /login.
 */
export const WRONG_FORM_FOR: Record<UserRole, string> = {
  // A scanner account reached the Return Shield form.
  scanner: 'This is a Scanner account. Use Login as Scanner.',
  // An operator account reached the Scanner form.
  operator: 'This is a Return Shield account. Use Login as Return Shield.',
};

/** Where an account of this kind belongs once it is signed in. */
export const HOME_FOR: Record<UserRole, string> = {
  operator: '/today',
  scanner: '/scan',
};

/** Where an account of this kind signs in. */
export const LOGIN_FOR: Record<UserRole, string> = {
  operator: '/login',
  scanner: '/scan/login',
};
