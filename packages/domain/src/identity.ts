export interface VioletIdentity {
  readonly constitutionVersion: string;
  readonly createdAt: Date;
  readonly id: string;
  readonly name: "Violet";
}

export function createVioletIdentity(input: {
  readonly constitutionVersion: string;
  readonly createdAt: Date;
  readonly id: string;
}): VioletIdentity {
  if (input.constitutionVersion.trim().length === 0) {
    throw new Error("constitutionVersion must not be empty");
  }
  if (input.id.trim().length === 0) {
    throw new Error("identity id must not be empty");
  }

  return Object.freeze({
    constitutionVersion: input.constitutionVersion,
    createdAt: new Date(input.createdAt),
    id: input.id,
    name: "Violet",
  });
}
