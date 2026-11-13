/** A caller identity that has already been verified (for example, from an Access JWT). */
export interface VerifiedIdentity {
  issuer: string;
  subject: string;
  email: string;
}
