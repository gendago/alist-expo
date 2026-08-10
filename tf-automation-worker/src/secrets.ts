type SecretBinding = string | { get(): Promise<string> };

export async function readSecret(binding: SecretBinding): Promise<string> {
  const value = typeof binding === "string" ? binding : await binding.get();
  if (!value) throw new Error("required secret is missing");
  return value;
}
