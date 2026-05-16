import { z } from 'zod';

// ─── Room ─────────────────────────────────────────────────────────────────────

export const roomSchema = z.object({
  id:         z.string(),
  name:       z.string().min(1),
  color:      z.string().optional(),
  confidence: z.number().min(0).max(100).optional(),
  length:     z.number().positive().optional(),
  width:      z.number().positive().optional(),
  height:     z.number().positive().optional(),
});

export type Room = z.infer<typeof roomSchema>;

// Create project 

export const createProjectSchema = z.object({
  name: z.string()
    .min(1, 'Project name is required')
    .max(100, 'Project name must be less than 100 characters'),
  project_type: z.enum(
    ['residential', 'commercial', 'hospitality', 'healthcare', 'education', 'industrial'] as const,
    { message: 'Project type is required' }
  ),
  address: z.string().max(300).optional(),
});

export type CreateProjectInput = z.infer<typeof createProjectSchema>;

// Save reviewed rooms 

export const saveRoomsSchema = z.object({
  project_id: z.string().uuid('Invalid project ID'),
  rooms: z.array(roomSchema).min(1, 'At least one room is required'),
});

export type SaveRoomsInput = z.infer<typeof saveRoomsSchema>;

// Save room dimensions 

export const roomDimensionSchema = z.object({
  id:     z.string(),
  length: z.number().positive('Length must be positive'),
  width:  z.number().positive('Width must be positive'),
  height: z.number().positive('Height must be positive'),
});

export const saveDimensionsSchema = z.object({
  project_id: z.string().uuid('Invalid project ID'),
  rooms: z.array(roomDimensionSchema).min(1),
});

export type SaveDimensionsInput = z.infer<typeof saveDimensionsSchema>;

// Update project 

export const updateProjectSchema = z.object({
  name:            z.string().min(1).max(100).optional(),
  project_type:    z.enum(['residential','commercial','hospitality','healthcare','education','industrial'] as const).optional(),
  address:         z.string().max(300).optional(),
  floor_plan_url:  z.string().url().optional(),
  floor_plan_data: z.record(z.string(), z.unknown()).optional(),
  room_data:       z.record(z.string(), z.unknown()).optional(),
  thumbnail_url:   z.string().url().optional(),
  status:          z.enum(['draft', 'active', 'published'] as const).optional(),
});

export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;