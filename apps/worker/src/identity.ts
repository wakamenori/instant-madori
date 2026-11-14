declare const verifiedIdentity: unique symbol;

export interface VerifiedIdentity {
  readonly [verifiedIdentity]: true;
  readonly issuer: string;
  readonly subject: string;
  readonly email: string;
}

export function freezeIdentity(identity: VerifiedIdentity): VerifiedIdentity {
  return Object.freeze({ ...identity });
}
