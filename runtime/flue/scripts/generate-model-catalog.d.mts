export type GeneratedPiModel = { readonly id: string; readonly name: string; readonly provider: string };
export type GeneratedPiCatalog = {
  readonly piVersion: "0.84.1";
  readonly catalog: ReadonlyArray<{ readonly provider: string; readonly models: ReadonlyArray<GeneratedPiModel> }>;
  readonly digest: string;
};
export function generateModelCatalog(): GeneratedPiCatalog;
export function writeModelCatalog(output?: URL): Promise<GeneratedPiCatalog>;
