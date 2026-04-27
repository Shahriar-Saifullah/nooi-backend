import { z } from 'zod';

export const createProjectSchema = z.object({
  name: z.string()
    .min(1, 'Project name is required')
    .max(100, 'Project name must be less than 100 characters'),
  floor_plan_data: z.record(z.string(), z.unknown()).optional().default({}),
  room_data:       z.record(z.string(), z.unknown()).optional().default({}),
  thumbnail_url:   z.string().url().optional(),
});

export const updateProjectSchema = z.object({
  name:            z.string().min(1).max(100).optional(),
  floor_plan_data: z.record(z.string(), z.unknown()).optional(),
  room_data:       z.record(z.string(), z.unknown()).optional(),
  thumbnail_url:   z.string().url().optional(),
  status:          z.enum(['draft', 'published']).optional(),
});

export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;