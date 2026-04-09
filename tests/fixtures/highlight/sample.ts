// TypeScript sample fixture for syntax highlighting tests
import { readFileSync } from 'fs';
import path from 'path';

interface UserProfile {
  id: number;
  name: string;
  email: string;
  createdAt: Date;
  role: 'admin' | 'user' | 'guest';
}

type ApiResponse<T> = {
  data: T;
  error: string | null;
  statusCode: number;
};

const DEFAULT_LIMIT = 20;
const BASE_URL = 'https://api.example.com';

async function fetchUser(id: number): Promise<UserProfile | null> {
  if (id <= 0) {
    throw new Error(`Invalid user ID: ${id}`);
  }

  const url = `${BASE_URL}/users/${id}`;
  /* TODO: replace with actual HTTP client */
  const raw = readFileSync(path.join('fixtures', `user-${id}.json`), 'utf-8');
  return JSON.parse(raw) as UserProfile;
}

class UserService {
  private cache: Map<number, UserProfile> = new Map();

  constructor(private readonly limit: number = DEFAULT_LIMIT) {}

  async getUser(id: number): Promise<ApiResponse<UserProfile | null>> {
    if (this.cache.has(id)) {
      return { data: this.cache.get(id)!, error: null, statusCode: 200 };
    }

    try {
      const user = await fetchUser(id);
      if (user) this.cache.set(id, user);
      return { data: user, error: null, statusCode: user ? 200 : 404 };
    } catch (err) {
      return { data: null, error: (err as Error).message, statusCode: 500 };
    }
  }
}

export { UserService, fetchUser };
export type { UserProfile, ApiResponse };
