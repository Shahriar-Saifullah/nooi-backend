import { z } from 'zod';

// ─── Room ─────────────────────────────────────────────────────────────────────

export const roomBoxSchema = z.object({
  top:    z.number().min(0).max(100),
  left:   z.number().min(0).max(100),
  width:  z.number().min(0).max(100),
  height: z.number().min(0).max(100),
});

export const roomSchema = z.object({
  id:         z.string(),
  name:       z.string().min(1),
  color:      z.string().optional(),
  confidence: z.number().min(0).max(100).optional(),
  length:     z.number().positive().optional(),
  width:      z.number().positive().optional(),
  height:     z.number().positive().optional(),
  box:        roomBoxSchema.optional(), // position on the floor plan image, as % (top/left/width/height)
  polygon:    z.array(z.tuple([z.number(), z.number()])).optional(),
  gridRow:    z.number().int().min(0).optional(),
  gridCol:    z.number().int().min(0).optional(),
  rowWeight:  z.number().positive().optional(),
  colWeight:  z.number().positive().optional(),
});

export type Room = z.infer<typeof roomSchema>;

// ─── Step 1 — Create project ──────────────────────────────────────────────────

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

// ─── Step 3 — Save reviewed rooms ────────────────────────────────────────────

export const saveRoomsSchema = z.object({
  project_id: z.string().uuid('Invalid project ID'),
  rooms: z.array(roomSchema).min(1, 'At least one room is required'),
});

export type SaveRoomsInput = z.infer<typeof saveRoomsSchema>;

// ─── Step 4 — Save room dimensions ───────────────────────────────────────────

export const roomDimensionSchema = z.object({
  id:         z.string(),
  length:     z.number().positive('Length must be positive'),
  width:      z.number().positive('Width must be positive'),
  height:     z.number().positive('Height must be positive'),
  // Layout fields are optional here (older clients may omit them), but when
  // present they let the canvas page render the same interactive grid the
  // user arranged during project creation, instead of falling back to a
  // static, non-interactive image.
  name:       z.string().optional(),
  color:      z.string().optional(),
  confidence: z.number().min(0).max(100).optional(),
  box:        roomBoxSchema.optional(),
  gridRow:    z.number().int().min(0).optional(),
  gridCol:    z.number().int().min(0).optional(),
  rowWeight:  z.number().positive().optional(),
  colWeight:  z.number().positive().optional(),
});

export const saveDimensionsSchema = z.object({
  project_id: z.string().uuid('Invalid project ID'),
  rooms: z.array(roomDimensionSchema).min(1),
});

export type SaveDimensionsInput = z.infer<typeof saveDimensionsSchema>;

// ─── Update project ───────────────────────────────────────────────────────────

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

// ─── Generate AI render (image) from a text prompt + current room layout ─────

export const generateRenderSchema = z.object({
  prompt: z.string().min(1, 'Prompt is required').max(2000),
  model:  z.enum(['gemini', 'dalle', 'midjourney', 'flux', 'stable-diffusion'] as const).optional().default('gemini'),
});

export type GenerateRenderInput = z.infer<typeof generateRenderSchema>;

// ── ADD to src/schemas/project.schema.ts (backend) ───────────────────────────

export const furnitureItemSchema = z.object({
  id:             z.string(),
  name:           z.string(),
  position:       z.tuple([z.number(), z.number(), z.number()]),
  rotation:       z.number(),
  modelId:        z.string().optional(),
  sizeScale:      z.number().min(0.2).max(4).optional(),
  color:          z.string().nullable().optional(),
  materialPreset: z.string().nullable().optional(),
  scale:          z.tuple([z.number(), z.number(), z.number()]).optional(),
  width:          z.number().optional(),
  depth:          z.number().optional(),
  height:         z.number().optional(),
});

export const saveFurnitureSchema = z.object({
  furniture: z.array(furnitureItemSchema).max(300),
  // per-side wall paint: "wallKey:A" | "wallKey:B" → css color
  wall_colors: z.record(z.string(), z.string().max(24)).optional(),
  // per-side wall surface: "wallKey:A" | "wallKey:B" → surface id
  wall_surfaces: z.record(z.string(), z.string().max(64)).optional(),
  // per-door finish: door key → finish id
  door_finishes: z.record(z.string(), z.string().max(64)).optional(),
});

// ── Sharing ──────────────────────────────────────────────────────────────────
export const toggleShareSchema = z.object({
  enabled: z.boolean(),
});

// ── AI furnish (natural-language furniture placement) ────────────────────────
export const aiFurnishSchema = z.object({
  command: z.string().min(3).max(500),
  rooms: z.array(z.object({
    id: z.string(),
    name: z.string(),
    rect: z.object({ x: z.number(), z: z.number(), w: z.number(), d: z.number() }),
    polygon: z.array(z.tuple([z.number(), z.number()])).min(3).max(200).optional(),
  })).min(1).max(40),
  catalog: z.array(z.object({
    id: z.string(),
    name: z.string(),
    category: z.string(),
    w: z.number(),   // footprint cm
    d: z.number(),
    h: z.number().optional(),   // height cm — flat items (rugs) skip collision
  })).min(1).max(80),
  existing: z.array(z.object({
    name: z.string(),
    x: z.number(),
    z: z.number(),
  })).max(100).optional(),
});
export type AiFurnishInput = z.infer<typeof aiFurnishSchema>;

// ── Render engine: live 3D scene → photorealistic image ──────────────────────
export const renderSceneSchema = z.object({
  prompt: z.string().max(500).optional(),
  scene_image: z.string().min(100).max(12_000_000), // data URL of the capture
  // grayscale depth map of the same view; used when RENDER_MODE=depth
  depth_image: z.string().min(100).max(12_000_000).optional(),
});