export class VerifiedIdentity {
  readonly #issuer: string;
  readonly #subject: string;
  readonly #email: string;

  private constructor(issuer: string, subject: string, email: string) {
    this.#issuer = issuer;
    this.#subject = subject;
    this.#email = email;
    Object.freeze(this);
  }

  get issuer(): string {
    return this.#issuer;
  }

  get subject(): string {
    return this.#subject;
  }

  get email(): string {
    return this.#email;
  }

  static freeze(this: void, { issuer, subject, email }: VerifiedIdentity): VerifiedIdentity {
    return new VerifiedIdentity(issuer, subject, email);
  }
}
Object.freeze(VerifiedIdentity);
Object.freeze(VerifiedIdentity.prototype);

export const freezeIdentity = VerifiedIdentity.freeze;
