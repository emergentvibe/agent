export interface ConstitutionData {
  slug: string;
  name: string;
  content: string;
  version: string;
  content_hash: string | null;
  updated_at: string;
}

export async function fetchConstitution(
  apiUrl: string,
  slug: string
): Promise<ConstitutionData> {
  const url = `${apiUrl}/api/constitution/${slug}`;
  const res = await fetch(url);

  if (!res.ok) {
    if (res.status === 404) {
      throw new Error(`Community "${slug}" not found. Check the slug and try again.`);
    }
    throw new Error(`Failed to fetch constitution: ${res.status} ${res.statusText}`);
  }

  return await res.json();
}
