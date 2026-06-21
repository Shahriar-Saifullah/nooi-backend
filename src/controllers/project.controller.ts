import { Response } from 'express';
import { supabase } from '../services/supabase';
import { AuthRequest } from '../types';
import { GoogleGenerativeAI } from '@google/generative-ai';
import {
  CreateProjectInput,
  SaveRoomsInput,
  SaveDimensionsInput,
  UpdateProjectInput,
  GenerateRenderInput,
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

// ─── Gemini Vision — Real room detection (two-pass) ──────────────────────────

interface RawRoom {
  name: string;
  confidence: number;
  color: string;
  box_2d?: [number, number, number, number];
  dimensions?: { length: number; width: number; unit: 'ft' | 'm' } | null;
}

function stripJsonFences(text: string): string {
  return text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

// Pass 1 — detect all rooms with names, colors, dimensions, and a first-guess box
async function detectRoomsPass1(
  model: ReturnType<GoogleGenerativeAI['getGenerativeModel']>,
  base64Image: string,
  mimeType: string
): Promise<RawRoom[]> {
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
      Hallway, Storage, Dining Room, Study/Office, Balcony, Closet, Stairs, Garage, Entry, Porch, Patio.

    - "confidence": number between 0 and 100 (how confident you are in this detection)

    - "color": string (a soft, distinct hex color for this room type — use pastel tones)

    - "box_2d": [ymin, xmin, ymax, xmax] — your BEST FIRST ESTIMATE of this room's full
      floor area bounding box, normalized to a 0-1000 scale where [0,0] is the top-left
      corner of the entire image and [1000,1000] is the bottom-right corner.
      The box should extend to the room's actual wall lines, not just its text label.
      This will be refined in a second pass, so a reasonable estimate is fine here.

    - "dimensions": object or null — if the floor plan image has printed text showing this
      room's measurements (e.g. "14'-7\\" X 16'", "20'8\\" X 17'", "12' X 24'", or metric
      equivalents like "4.5m x 3.5m"), extract them here as:
      { "length": number, "width": number, "unit": "ft" | "m" }
      Convert feet-inches notation (e.g. 14'-7") to decimal feet (14.58).
      If no dimension text is visible for a room, set "dimensions" to null — do not guess or invent numbers.

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
    - Balcony/Terrace/Porch/Patio: #a7f3d0
    - Stairs: #e0c3fc
    - Other: #e5e7eb

    IMPORTANT: Every room name in the output array must be unique.
    Never output the same name twice — always number duplicates (Bedroom 1, Bedroom 2...).

    Example output format:
    [{"name":"Living Room","confidence":95,"color":"#c3f4f0","box_2d":[120,80,420,360],"dimensions":{"length":20.67,"width":17,"unit":"ft"}},{"name":"Porch","confidence":90,"color":"#a7f3d0","box_2d":[700,50,950,500],"dimensions":{"length":24,"width":12,"unit":"ft"}}]

    Only return the JSON array. Nothing else at all.
  `;

  const result = await model.generateContent([
    { text: prompt },
    { inlineData: { data: base64Image, mimeType } },
  ]);

  return JSON.parse(stripJsonFences(result.response.text().trim()));
}

// Pass 2 — re-examine the same full image, but ask Gemini to tighten ONE room's box
// against the real wall boundaries, now that it already knows the floor plan layout.
async function refineRoomBox(
  model: ReturnType<GoogleGenerativeAI['getGenerativeModel']>,
  base64Image: string,
  mimeType: string,
  room: RawRoom
): Promise<[number, number, number, number] | null> {
  if (!room.box_2d) return null;

  const prompt = `
    Here is a floor plan image. A room called "${room.name}" was previously detected
    with this approximate bounding box (0-1000 scale, [ymin, xmin, ymax, xmax]):
    ${JSON.stringify(room.box_2d)}

    Look very closely at the "${room.name}" area of this floor plan and give a CORRECTED,
    tightly-fitted bounding box that extends exactly to that room's wall lines on all sides —
    covering its entire floor footprint, not just the area near its text label.

    Return ONLY a JSON object with this exact shape, nothing else:
    {"box_2d":[ymin,xmin,ymax,xmax]}
  `;

  try {
    const result = await model.generateContent([
      { text: prompt },
      { inlineData: { data: base64Image, mimeType } },
    ]);
    const parsed = JSON.parse(stripJsonFences(result.response.text().trim()));
    if (Array.isArray(parsed.box_2d) && parsed.box_2d.length === 4) {
      return parsed.box_2d as [number, number, number, number];
    }
    return null;
  } catch {
    // If refinement fails for this room, fall back to the pass-1 box silently
    return null;
  }
}

async function detectRooms(floorPlanUrl: string, projectId: string): Promise<Room[]> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set');

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    generationConfig: {
      responseMimeType: 'application/json',
    },
  });

  // Fetch image and convert to base64 (shared across both passes)
  const imageResponse = await fetch(floorPlanUrl);
  if (!imageResponse.ok) {
    throw new Error(`Failed to fetch floor plan image: ${imageResponse.statusText}`);
  }
  const imageBuffer = await imageResponse.arrayBuffer();
  const base64Image = Buffer.from(imageBuffer).toString('base64');
  const mimeType = (imageResponse.headers.get('content-type') || 'image/png').split(';')[0];

  // ── Pass 1: detect all rooms ──
  const parsed = await detectRoomsPass1(model, base64Image, mimeType);

  // ── Pass 2: refine each room's box in parallel ──
  const refinedBoxes = await Promise.all(
    parsed.map(room => refineRoomBox(model, base64Image, mimeType, room))
  );

  const FT_TO_M = 0.3048;

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

    // Use the refined box from pass 2 if available, otherwise fall back to pass 1's box
    const finalBox2d = refinedBoxes[index] || room.box_2d;

    let box: Room['box'] = undefined;
    if (Array.isArray(finalBox2d) && finalBox2d.length === 4) {
      const [ymin, xmin, ymax, xmax] = finalBox2d;
      box = {
        top:    Math.max(0, Math.min(100, ymin / 10)),
        left:   Math.max(0, Math.min(100, xmin / 10)),
        width:  Math.max(0, Math.min(100, (xmax - xmin) / 10)),
        height: Math.max(0, Math.min(100, (ymax - ymin) / 10)),
      };
    }

    // Convert extracted dimensions to metres (Room schema stores length/width in metres)
    let length: number | undefined;
    let width: number | undefined;
    if (room.dimensions && room.dimensions.length > 0 && room.dimensions.width > 0) {
      const factor = room.dimensions.unit === 'ft' ? FT_TO_M : 1;
      length = parseFloat((room.dimensions.length * factor).toFixed(2));
      width  = parseFloat((room.dimensions.width * factor).toFixed(2));
    }

    return {
      id:         `${projectId}-r${index + 1}`,
      name:       displayName,
      confidence: Math.min(100, Math.max(0, Math.round(room.confidence))),
      color:      room.color || '#e5e7eb',
      box,
      length,
      width,
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

// ─── Generate an AI render image from the user's prompt + current room layout ─
// Every `model` value currently routes to the same Gemini image model
// (gemini-2.5-flash-image, aka "Nano Banana") — see GenerateRenderInput schema
// comment. Swapping in real per-provider routing later only touches this
// function; the request/response contract for the frontend stays the same.

function buildRoomContextSummary(rooms: Room[]): string {
  if (!rooms || rooms.length === 0) return '';

  const lines = rooms.map(r => {
    const dims = (r.length && r.width) ? ` (${r.length}m x ${r.width}m)` : '';
    return `- ${r.name}${dims}`;
  });

  return `The floor plan contains the following rooms:\n${lines.join('\n')}`;
}

interface GeminiImageResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
        inlineData?: { data: string; mimeType: string };
      }>;
    };
  }>;
}

export async function callGeminiImageModel(
  prompt: string,
  referenceImage?: { data: string; mimeType: string } | null
): Promise<{ base64: string; mimeType: string }> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set');

  const requestParts: Array<{ text: string } | { inlineData: { data: string; mimeType: string } }> = [
    { text: prompt },
  ];
  if (referenceImage) {
    requestParts.push({ inlineData: { data: referenceImage.data, mimeType: referenceImage.mimeType } });
  }

  // Using the raw REST endpoint here (rather than the @google/generative-ai
  // SDK used elsewhere in this file) since image generation via
  // responseModalities is a newer capability and the REST contract is the
  // most stable reference for it — see ai.google.dev/gemini-api/docs/image-generation
  const response = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent',
    {
      method:  'POST',
      headers: {
        'x-goog-api-key': apiKey,
        'Content-Type':   'application/json',
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: requestParts }],
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
      }),
    }
  );

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini image generation failed (${response.status}): ${errText}`);
  }

  const json = await response.json() as GeminiImageResponse;
  const responseParts = json.candidates?.[0]?.content?.parts ?? [];
  const imagePart = responseParts.find(
    (p): p is { inlineData: { data: string; mimeType: string } } => !!p.inlineData?.data
  );

  if (!imagePart) {
    throw new Error('Gemini did not return an image. It may have refused the prompt.');
  }

  return {
    base64:   imagePart.inlineData.data,
    mimeType: imagePart.inlineData.mimeType || 'image/png',
  };
}

export async function generateRender(req: AuthRequest, res: Response) {
  try {
    const userId    = req.user!.id;
    const projectId = String(req.params.id);
    const { prompt, model } = req.body as GenerateRenderInput;

    const project = await verifyOwnership(projectId, userId);
    if (!project) {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }

    const rooms = (project.room_data as any)?.rooms ?? [];
    const roomContext = buildRoomContextSummary(rooms);

    const fullPrompt = [
      'Generate a photorealistic interior design render based on this floor plan and the following request.',
      roomContext,
      `Design request: ${prompt}`,
    ].filter(Boolean).join('\n\n');

    let image: { base64: string; mimeType: string };
    try {
      image = await callGeminiImageModel(fullPrompt);
    } catch (genErr: any) {
      console.error('Image generation error:', genErr);
      return res.status(502).json({
        success: false,
        error: genErr.message || 'Image generation failed. Please try again.',
      });
    }

    // Upload the generated image to Supabase Storage, same bucket/convention
    // used for uploaded floor plans, so renders persist and have a stable URL.
    const ext = image.mimeType.split('/')[1] || 'png';
    const storagePath = `renders/${userId}/${projectId}-${Date.now()}.${ext}`;
    const buffer = Buffer.from(image.base64, 'base64');

    const { error: uploadError } = await supabase.storage
      .from('nooi-projects')
      .upload(storagePath, buffer, {
        contentType: image.mimeType,
        upsert: true,
      });

    if (uploadError) {
      return res.status(500).json({ success: false, error: uploadError.message });
    }

    const { data: { publicUrl } } = supabase.storage
      .from('nooi-projects')
      .getPublicUrl(storagePath);

    return res.status(200).json({
      success: true,
      data: {
        image_url: publicUrl,
        model_requested: model, // echoed back; not yet used to pick a provider
      },
    });

  } catch (err) {
    console.error('Generate render error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}