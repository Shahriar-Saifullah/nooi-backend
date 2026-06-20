import { Response } from 'express';
import { supabase } from '../services/supabase';
import { AuthRequest } from '../types';
import { GoogleGenerativeAI } from '@google/generative-ai';
import {
  CreateProjectInput,
  SaveRoomsInput,
  SaveDimensionsInput,
  UpdateProjectInput,
  Room,
} from '../schemas/project.schema';

// ─── Multer file type ─────────────────────────────────────────────────────────

interface UploadedFile {
  fieldname: string;
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function computeTotalArea(rooms: Room[]): number {
  return parseFloat(
    rooms.reduce((sum, r) => {
      if (r.length && r.width) return sum + r.length * r.width;
      return sum;
    }, 0).toFixed(1)
  );
}

async function verifyOwnership(projectId: string, userId: string) {
  const { data } = await supabase
    .from('projects')
    .select('id, room_data, floor_plan_url, status')
    .eq('id', projectId)
    .eq('user_id', userId)
    .single();
  return data;
}

// ─── Gemini Vision — Real room detection ─────────────────────────────────────

async function detectRooms(floorPlanUrl: string, projectId: string): Promise<Room[]> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set');

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite' });

  const prompt = `
    You are an expert architect analyzing a floor plan image or drawing.
    Detect all distinct rooms/spaces visible in this floor plan.

    Return ONLY a valid JSON array. No markdown, no explanation, no code blocks.

    Each room object must have exactly these fields:
    - "name": string — a clear, human-readable room name.
      If there are multiple rooms of the same type (e.g. two bedrooms), 
      number them distinctly: "Bedroom 1", "Bedroom 2", "Bathroom 1", "Bathroom 2", etc.
      Use "Master Bedroom" only for the largest/primary bedroom (max once).
      Common types: Living Room, Kitchen, Bedroom, Master Bedroom, Bathroom, 
      Hallway, Storage, Dining Room, Study/Office, Balcony, Closet, Stairs, Garage, Entry.
    - "confidence": number between 0 and 100 (how confident you are in this detection)
    - "color": string (a soft, distinct hex color for this room type — use pastel tones)

    Color guide (use these as reference, vary slightly for repeated room types):
    - Living Room: #c3f4f0
    - Kitchen: #b9eac5
    - Bedroom: #87ddd7
    - Master Bedroom: #6dd0c4
    - Bathroom: #f7dfad
    - Hallway/Corridor: #d5dbda
    - Storage/Utility/Closet: #ffc9c0
    - Dining Room: #c7d2fe
    - Study/Office: #fde68a
    - Balcony/Terrace: #a7f3d0
    - Stairs: #e0c3fc
    - Other: #e5e7eb

    IMPORTANT: Every room name in the output array must be unique. 
    Never output the same name twice — always number duplicates (Bedroom 1, Bedroom 2...).

    Example output format:
    [{"name":"Living Room","confidence":95,"color":"#c3f4f0"},{"name":"Bedroom 1","confidence":90,"color":"#87ddd7"},{"name":"Bedroom 2","confidence":88,"color":"#87ddd7"}]

    Only return the JSON array. Nothing else at all.
  `;

  // Fetch image and convert to base64
  const imageResponse = await fetch(floorPlanUrl);
  if (!imageResponse.ok) {
    throw new Error(`Failed to fetch floor plan image: ${imageResponse.statusText}`);
  }

  const imageBuffer = await imageResponse.arrayBuffer();
  const base64Image = Buffer.from(imageBuffer).toString('base64');
  const mimeType = (imageResponse.headers.get('content-type') || 'image/png').split(';')[0];

  const result = await model.generateContent([
    { text: prompt },
    {
      inlineData: {
        data: base64Image,
        mimeType,
      },
    },
  ]);

  const rawText = result.response.text().trim();

  // Strip any accidental markdown code blocks
  const cleaned = rawText
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  const parsed: Array<{ name: string; confidence: number; color: string }> = JSON.parse(cleaned);

  // Safety net: auto-number any duplicate names Gemini might still produce
  const nameCounts = new Map<string, number>();
  const totalCounts = new Map<string, number>();
  for (const room of parsed) {
    totalCounts.set(room.name, (totalCounts.get(room.name) || 0) + 1);
  }

  return parsed.map((room, index) => {
    let displayName = room.name;
    const total = totalCounts.get(room.name) || 1;
    if (total > 1) {
      const seen = (nameCounts.get(room.name) || 0) + 1;
      nameCounts.set(room.name, seen);
      // Don't double-number names that already end in a digit (e.g. "Bedroom 2")
      if (!/\d+$/.test(room.name.trim())) {
        displayName = `${room.name} ${seen}`;
      }
    }

    return {
      id:         `${projectId}-r${index + 1}`,
      name:       displayName,
      confidence: Math.min(100, Math.max(0, Math.round(room.confidence))),
      color:      room.color || '#e5e7eb',
    };
  });
}

// ─── Step 1: Create project ───────────────────────────────────────────────────
// POST /projects

export async function createProject(req: AuthRequest, res: Response) {
  try {
    const userId = req.user!.id;
    const { name, project_type, address } = req.body as CreateProjectInput;

    // Enforce plan project limits
    const { data: profile } = await supabase
      .from('profiles')
      .select('plan')
      .eq('id', userId)
      .single();

    const plan = profile?.plan ?? 'free';
    const limits: Record<string, number> = { free: 50, starter: 10, pro: Infinity };
    const limit = limits[plan] ?? 50;

    if (limit !== Infinity) {
      const { count } = await supabase
        .from('projects')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId);

      if ((count ?? 0) >= limit) {
        return res.status(403).json({
          success: false,
          error: `Your ${plan} plan allows up to ${limit} projects. Upgrade to create more.`,
          code: 'PROJECT_LIMIT_REACHED',
        });
      }
    }

    const { data, error } = await supabase
      .from('projects')
      .insert({
        user_id:         userId,
        name,
        project_type,
        address:         address ?? null,
        status:          'draft',
        floor_plan_data: {},
        room_data:       {},
      })
      .select()
      .single();

    if (error) {
      return res.status(400).json({ success: false, error: error.message });
    }

    return res.status(201).json({
      success: true,
      data: { project: data },
    });

  } catch (err) {
    console.error('Create project error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

// ─── Step 2: Upload floor plan ────────────────────────────────────────────────
// POST /projects/:id/floor-plan  (multipart/form-data, field: floor_plan)

export async function uploadFloorPlan(req: AuthRequest, res: Response) {
  try {
    const userId    = req.user!.id;
    const projectId = String(req.params.id);

    const project = await verifyOwnership(projectId, userId);
    if (!project) {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }

    const file = (req as any).file as UploadedFile | undefined;
    if (!file) {
      return res.status(400).json({ success: false, error: 'No file uploaded' });
    }

    // Validate file type
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
    if (!allowed.includes(file.mimetype)) {
      return res.status(400).json({
        success: false,
        error: 'Unsupported file type. Please use JPG, PNG, WebP or PDF.',
        code: 'INVALID_FILE_TYPE',
      });
    }

    // Validate size (20 MB)
    if (file.size > 20 * 1024 * 1024) {
      return res.status(400).json({
        success: false,
        error: 'File too large. Maximum size is 20 MB.',
        code: 'FILE_TOO_LARGE',
      });
    }

    // Upload to Supabase Storage
    const ext         = file.originalname.split('.').pop();
    const storagePath = `floor-plans/${userId}/${projectId}.${ext}`;

    const { error: uploadError } = await supabase.storage
      .from('nooi-projects')
      .upload(storagePath, file.buffer, {
        contentType: file.mimetype,
        upsert: true,
      });

    if (uploadError) {
      return res.status(500).json({ success: false, error: uploadError.message });
    }

    const { data: { publicUrl } } = supabase.storage
      .from('nooi-projects')
      .getPublicUrl(storagePath);

    // Save floor plan URL on project
    const { data: updated, error: updateError } = await supabase
      .from('projects')
      .update({
        floor_plan_url:  publicUrl,
        floor_plan_data: {
          storage_path:  storagePath,
          original_name: file.originalname,
          size:          file.size,
          mime:          file.mimetype,
        },
        updated_at: new Date().toISOString(),
      })
      .eq('id', projectId)
      .select()
      .single();

    if (updateError) {
      return res.status(400).json({ success: false, error: updateError.message });
    }

    // Detect rooms using Gemini Vision
    let detectedRooms: Room[] = [];
    try {
      detectedRooms = await detectRooms(publicUrl, projectId);
    } catch (aiErr) {
      // AI detection failed — return empty rooms, user can add manually
      console.error('Gemini room detection failed:', aiErr);
      detectedRooms = [];
    }

    return res.status(200).json({
      success: true,
      data: {
        project:        updated,
        floor_plan_url: publicUrl,
        detected_rooms: detectedRooms,
        ai_detected:    detectedRooms.length > 0,
      },
    });

  } catch (err) {
    console.error('Upload floor plan error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

// ─── Step 3: Save reviewed rooms ──────────────────────────────────────────────
// PUT /projects/:id/rooms

export async function saveRooms(req: AuthRequest, res: Response) {
  try {
    const userId    = req.user!.id;
    const projectId = String(req.params.id);
    const { rooms } = req.body as SaveRoomsInput;

    const project = await verifyOwnership(projectId, userId);
    if (!project) {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }

    const { data, error } = await supabase
      .from('projects')
      .update({
        room_data:  { rooms },
        updated_at: new Date().toISOString(),
      })
      .eq('id', projectId)
      .select()
      .single();

    if (error) {
      return res.status(400).json({ success: false, error: error.message });
    }

    return res.status(200).json({
      success: true,
      data: { project: data, rooms },
    });

  } catch (err) {
    console.error('Save rooms error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

// ─── Step 4: Save room dimensions ─────────────────────────────────────────────
// PUT /projects/:id/dimensions

export async function saveDimensions(req: AuthRequest, res: Response) {
  try {
    const userId    = req.user!.id;
    const projectId = String(req.params.id);
    const { rooms } = req.body as SaveDimensionsInput;

    const project = await verifyOwnership(projectId, userId);
    if (!project) {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }

    const existingRooms: Room[] = (project.room_data as any)?.rooms ?? [];
    const dimensionMap = new Map(rooms.map(r => [r.id, r]));

    const mergedRooms = existingRooms.map(room => {
      const dims = dimensionMap.get(room.id);
      return dims ? { ...room, ...dims } : room;
    });

    const totalArea = computeTotalArea(mergedRooms);

    const { data, error } = await supabase
      .from('projects')
      .update({
        room_data:  { rooms: mergedRooms, total_area_m2: totalArea },
        updated_at: new Date().toISOString(),
      })
      .eq('id', projectId)
      .select()
      .single();

    if (error) {
      return res.status(400).json({ success: false, error: error.message });
    }

    return res.status(200).json({
      success: true,
      data: { project: data, rooms: mergedRooms, total_area_m2: totalArea },
    });

  } catch (err) {
    console.error('Save dimensions error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

// ─── Step 5: Confirm project ──────────────────────────────────────────────────
// POST /projects/:id/confirm

export async function confirmProject(req: AuthRequest, res: Response) {
  try {
    const userId    = req.user!.id;
    const projectId = String(req.params.id);

    const project = await verifyOwnership(projectId, userId);
    if (!project) {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }

    if (!project.floor_plan_url) {
      return res.status(400).json({
        success: false,
        error: 'Floor plan is required before confirming.',
        code:  'MISSING_FLOOR_PLAN',
      });
    }

    const rooms: Room[] = (project.room_data as any)?.rooms ?? [];
    if (rooms.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Rooms are required before confirming.',
        code:  'MISSING_ROOMS',
      });
    }

    const { data: confirmed, error } = await supabase
      .from('projects')
      .update({
        status:     'active',
        updated_at: new Date().toISOString(),
      })
      .eq('id', projectId)
      .select()
      .single();

    if (error) {
      return res.status(400).json({ success: false, error: error.message });
    }

    const roomsSummary = rooms.map(r => ({
      name:       r.name,
      dimensions: `${r.length ?? '-'} × ${r.width ?? '-'} × ${r.height ?? '-'} m`,
      area_m2:    r.length && r.width ? parseFloat((r.length * r.width).toFixed(1)) : null,
    }));

    return res.status(200).json({
      success: true,
      data: {
        project:       confirmed,
        rooms_summary: roomsSummary,
        total_area_m2: (project.room_data as any)?.total_area_m2 ?? 0,
      },
    });

  } catch (err) {
    console.error('Confirm project error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

// ─── Standard CRUD ────────────────────────────────────────────────────────────

export async function getProjects(req: AuthRequest, res: Response) {
  try {
    const userId = req.user!.id;
    const limit  = req.query.limit ? parseInt(req.query.limit as string) : undefined;

    const query = supabase
      .from('projects')
      .select('id, name, project_type, address, thumbnail_url, floor_plan_url, status, room_data, created_at, updated_at')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false });

    if (limit) query.limit(limit);

    const { data, error } = await query;
    if (error) return res.status(400).json({ success: false, error: error.message });

    return res.status(200).json({ success: true, data: { projects: data } });

  } catch (err) {
    console.error('Get projects error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

export async function getProject(req: AuthRequest, res: Response) {
  try {
    const userId    = req.user!.id;
    const projectId = String(req.params.id);

    const { data, error } = await supabase
      .from('projects')
      .select('*')
      .eq('id', projectId)
      .eq('user_id', userId)
      .single();

    if (error || !data) {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }

    return res.status(200).json({ success: true, data: { project: data } });

  } catch (err) {
    console.error('Get project error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

export async function updateProject(req: AuthRequest, res: Response) {
  try {
    const userId    = req.user!.id;
    const projectId = String(req.params.id);
    const updates   = req.body as UpdateProjectInput;

    const project = await verifyOwnership(projectId, userId);
    if (!project) {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }

    const { data, error } = await supabase
      .from('projects')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', projectId)
      .select()
      .single();

    if (error) return res.status(400).json({ success: false, error: error.message });

    return res.status(200).json({ success: true, data: { project: data } });

  } catch (err) {
    console.error('Update project error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

export async function deleteProject(req: AuthRequest, res: Response) {
  try {
    const userId    = req.user!.id;
    const projectId = String(req.params.id);

    const project = await verifyOwnership(projectId, userId);
    if (!project) {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }

    const { error } = await supabase
      .from('projects')
      .delete()
      .eq('id', projectId)
      .eq('user_id', userId);

    if (error) return res.status(400).json({ success: false, error: error.message });

    return res.status(200).json({ success: true, message: 'Project deleted successfully' });

  } catch (err) {
    console.error('Delete project error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}