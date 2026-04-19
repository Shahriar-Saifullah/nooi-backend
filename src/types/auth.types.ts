import { z } from 'zod';

export const loginSchema = z.object({
  email: z.string().email('Invalid email format'),
  password: z.string().min(6, 'Password must be at least 6 characters'),
});

export type LoginDto = z.infer<typeof loginSchema>;

export interface UserResponse {
  id: string;
  email: string;
  full_name: string;
}

export interface AuthResponse {
  user: UserResponse;
}
