import { z } from 'zod';

export const updateLanguageSchema = z.object({
  language: z.enum(['en', 'ar']),
});

export const updateProfileSchema = z.object({
  full_name:  z.string().min(2).max(100).optional(),
  avatar_url: z.string().url().optional(),
});

export type UpdateLanguageInput = z.infer<typeof updateLanguageSchema>;
export type UpdateProfileInput  = z.infer<typeof updateProfileSchema>;