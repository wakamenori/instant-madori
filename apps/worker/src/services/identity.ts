/** A caller identity that has already been verified (for example, from an Access JWT). */
declare const verifiedIdentity: unique symbol;

export interface VerifiedIdentity {
  readonly [verifiedIdentity]: true;
  issuer: string;
  subject: string;
  email: string;
}
